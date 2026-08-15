/**
 * ============================================================================
 *  APEX KART — WATER (and lava)
 * ============================================================================
 *  One camera-following radial disc, one draw call, and a shader that does the
 *  five things that actually make water read as *wet*:
 *
 *   1. Gerstner swell — five summed waves with analytically differentiated
 *      normals (no normal-map guessing), so crests catch the key light in the
 *      right places and the horizon still has motion.
 *   2. Depth from the terrain field — the height texture Terrain already uses is
 *      sampled per *fragment*, so the shoreline is pixel-exact rather than
 *      tessellation-exact, and shallow water genuinely goes turquoise while deep
 *      water absorbs to navy.
 *   3. A shoreline foam line that advances and retreats with the swell, plus
 *      two-scroll churn noise and crest foam on steep wave faces.
 *   4. Planar reflections (mirrored camera into a half-res target, obliquely
 *      clipped at the water plane) on high/ultra; an analytic sky-dome
 *      reflection everywhere, which also fills the planar target's dead edges.
 *   5. Fresnel between that reflection and a refracted seabed with projected
 *      caustics, and a very tight sun glint that runs hot enough to bloom.
 *
 *  `setPreset('lava')` swaps in a second material: domain-warped flow, a dark
 *  basalt crust broken by glowing veins, and slow convective drift.
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings } from '@/core/Types';
import { LAYERS, RENDER_ORDER } from '@/core/Config';
import { clamp } from '@/core/MathUtils';
import {
  GLSL_FIELD, GLSL_HEIGHT_FOG, GLSL_NOISE,
  fieldUniforms, makeCaustics, makeFoam, makeWaterNormal,
  type TerrainField, type WorldContext, type WorldTheme,
  worldFogUniforms, worldSunUniforms,
} from './WorldTextures';
import { splitClipmapGrid } from './Terrain';

export type WaterPresetName = 'ocean' | 'lake' | 'lava' | 'none';

interface WaterLook {
  shallow: number;
  /** the middle stop of the depth ramp — without it turquoise->navy reads as a wash */
  mid: number;
  deep: number;
  floor: number;
  /** metres of depth over which the shore foam band sits */
  foamWidth: number;
  /** absorption rate — bigger = colour saturates closer to shore */
  absorb: number;
  /** [amplitude, wavelength] of the primary swell */
  swell: [number, number];
  choppy: number;
  roughness: number;
  glint: number;
  causticStrength: number;
  /** how much whitecap breaks on a steep crest, 0..1 */
  whitecap: number;
}

const LOOKS: Record<'ocean' | 'lake', WaterLook> = {
  ocean: {
    shallow: 0x4fd6c4, mid: 0x1683a6, deep: 0x06263f, floor: 0xa89468,
    foamWidth: 1.9, absorb: 0.26, swell: [0.46, 34], choppy: 1.0,
    roughness: 0.055, glint: 1.0, causticStrength: 1.0, whitecap: 0.5,
  },
  lake: {
    shallow: 0x46b8a2, mid: 0x1c6b75, deep: 0x0d323c, floor: 0x6d6a4a,
    foamWidth: 1.1, absorb: 0.42, swell: [0.16, 18], choppy: 0.55,
    roughness: 0.035, glint: 0.8, causticStrength: 0.75, whitecap: 0.16,
  },
};

const HALF_EXTENT = 760;
const RES_FOR_TIER: Record<string, number> = { low: 97, medium: 121, high: 145, ultra: 161 };

/**
 * Radial bands / angular sectors the disc is cut into so it can be culled — see
 * `splitClipmapGrid` in Terrain.ts for why one camera-centred mesh cannot be.
 * Scaled to this disc's 760 m half-extent, and at the same measured knee as the
 * terrain's: 9 sectors, 6.4 submitted on average, 76 % of the 51 200 triangles
 * (against 14.5 calls for 67 % at 23 sectors — see `.probe-tmp/g5.ts`). Water is
 * the better candidate of the two per vertex saved: its vertex shader sums five
 * Gerstner waves and their analytic derivatives, so a vertex that ends up behind
 * the camera is among the most expensive things in the frame to compute and throw
 * away.
 */
const DISC_BANDS: readonly number[] = [0, 130, Infinity];
const DISC_SECTORS: readonly number[] = [1, 8];

const _up = new THREE.Vector3(0, 1, 0);
const _normal = new THREE.Vector3(0, 1, 0);
const _view = new THREE.Vector3();
const _target = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _reflectorPos = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _hidden: THREE.Object3D[] = [];
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

/**
 * Scene roots that are never worth a planar-reflection pass. Particle systems
 * and god rays are additive sprites authored for the main framebuffer; at the
 * reflection's resolution they contribute noise and hundreds of draw calls.
 */
const SKIP_NAMES: ReadonlySet<string> = new Set(['vfx', 'Projectiles', 'SunShafts', 'Weather']);

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

/**
 * Five Gerstner waves. Steepness is budgeted so the sum stays below the
 * self-intersection limit, and the tangent frame is the exact derivative of the
 * displacement — the crests light correctly instead of looking painted on.
 *
 * DIRECTIONAL SPREAD. The offsets used to be 0.00 / 0.62 / -0.74 / 1.55 / -2.05
 * radians, which is a 206° fan: waves 3 and 4 ran almost square across wave 0.
 * A wind sea does not do that — real directional spreading is roughly a ±30°
 * cosine lobe about the wind — and the sum of a 206° fan has no propagation
 * direction at all, it is just heaving. That is the "no coherent wave
 * direction" finding. The fan is now 55° (measured by `.probe-tmp/water-facet.ts`,
 * which parses this very table out of the compiled shader source so the number
 * in that report can never drift from the number here).
 *
 * WAVE LOD. This sum is evaluated PER VERTEX, and the disc it is evaluated on is
 * radially warped: cells run 0.48 m under the camera and 27.2 m at the rim
 * (measured). The shortest wave here is `uSwell.y * 0.13` = 4.4 m on the ocean
 * preset. Past about two samples per wavelength a Gerstner term stops being a
 * wave and becomes per-vertex white noise — and because the normal is the
 * analytic derivative of the displacement, the NORMAL becomes white noise with
 * it. Fresnel then paints each 13-49 px triangle either cyan (the refracted
 * body) or sunset-orange (the sky), which is precisely the "chaotic mottle …
 * hard-edged polygonal facets … crumpled foil" the critic saw. So every term
 * now fades out as its own wavelength approaches the local grid spacing, which
 * arrives as the baked `aCell` attribute (exact, from `buildDisc`, rather than
 * re-derived from distance by inverting the warp cubic).
 *
 * The energy removed is reported back through `lodLoss` so the fragment shader
 * can put it back as specular roughness instead of simply losing it — the
 * sub-pixel normal variance a wave carries IS roughness, so converting one into
 * the other is what keeps the far water from flattening into a mirror.
 */
const GLSL_GERSTNER = /* glsl */ `
uniform float uTime;
uniform vec2  uSwell;      // amplitude, wavelength
uniform float uChoppy;
uniform vec2  uWindDir;
attribute float aCell;     // local grid spacing at this vertex, metres

const int WAVE_COUNT = 5;
/** dir-angle offset, wavelength scale, amplitude scale, steepness.
    Written as a switch rather than a const array — GLSL ES 1.00 has no array
    initialisers and three compiles ShaderMaterial as GLSL1 by default. */
vec4 waveParams(int i){
  if (i == 0) return vec4( 0.00, 1.00, 1.00, 0.62);
  if (i == 1) return vec4( 0.31, 0.61, 0.58, 0.48);
  if (i == 2) return vec4(-0.24, 0.38, 0.34, 0.40);
  if (i == 3) return vec4( 0.52, 0.22, 0.19, 0.30);
  return vec4(-0.44, 0.13, 0.11, 0.24);
}

/** Returns displacement; accumulates the tangent-frame partials. */
vec3 gerstner(vec2 xz, float cell, out vec3 dPdx, out vec3 dPdz,
              out float fold, out float lodLoss){
  vec3 disp = vec3(0.0);
  dPdx = vec3(1.0, 0.0, 0.0);
  dPdz = vec3(0.0, 0.0, 1.0);
  fold = 0.0;
  float energy = 1e-5;
  float kept = 0.0;
  float baseAngle = atan(uWindDir.y, uWindDir.x);
  for (int i = 0; i < WAVE_COUNT; i++) {
    vec4 w = waveParams(i);
    float L = max(uSwell.y * w.y, 0.6);
    // Full strength at ~7 samples per wavelength, gone by ~2.5. Below that the
    // term is noise, not water.
    float lod = 1.0 - smoothstep(L * 0.14, L * 0.40, cell);
    // a0 is the UNFADED amplitude and q must be built from it: q carries a 1/a
    // so q*a is very nearly independent of a, and scaling a alone would have
    // faded the vertical displacement while leaving the horizontal choppiness at
    // full strength — the crests would have kept their sideways lean after their
    // height had gone.
    float a0 = uSwell.x * w.z;
    energy += a0;
    kept += a0 * lod;
    if (lod <= 0.002) continue;

    float ang = baseAngle + w.x * uChoppy;
    vec2 d = vec2(cos(ang), sin(ang));
    float k = 6.28318530718 / L;
    float c = sqrt(9.81 / k);
    float steep = min(w.w * uChoppy, 0.92);
    float q = steep / (k * a0 * float(WAVE_COUNT) + 1e-4);
    float a = a0 * lod;
    float f = k * (dot(d, xz) - c * uTime);
    float sf = sin(f), cf = cos(f);
    float qa = q * a;

    disp += vec3(d.x * qa * cf, a * sf, d.y * qa * cf);

    float wa = k * a;
    dPdx += vec3(-q * d.x * d.x * wa * sf, d.x * wa * cf, -q * d.x * d.y * wa * sf);
    dPdz += vec3(-q * d.x * d.y * wa * sf, d.y * wa * cf, -q * d.y * d.y * wa * sf);
    fold += max(0.0, sf) * w.z * lod;
  }
  lodLoss = clamp(1.0 - kept / energy, 0.0, 1.0);
  return disp;
}
`;

const GLSL_SKY_APPROX = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uSkyBoost;

/** Cheap sky dome for reflections — matches Sky's palette closely enough. */
vec3 skyApprox(vec3 rd){
  float h = rd.y;
  float t = pow(clamp(h, 0.0, 1.0), 0.52);
  vec3 col = mix(uHorizon, uZenith * uSkyBoost, t);
  float sd = max(dot(rd, uSunDirection), 0.0);
  col += uSunColor * (pow(sd, 6.0) * 0.22 + pow(sd, 260.0) * 2.2);
  // Grazing rays pick up the haze band rather than punching through it.
  col = mix(uHorizon * 0.82, col, smoothstep(-0.08, 0.07, h));
  return col;
}
`;

// ---------------------------------------------------------------------------

export class Water implements ISubsystem {
  readonly group = new THREE.Group();
  /**
   * The disc's follow pivot. Toggling THIS is how the surface is hidden (from its
   * own reflection, or by `setPreset('none')`) — the sectors under it are many.
   */
  readonly surface = new THREE.Group();
  /** Cullable disc sectors. `chunks[0]` is the always-visible centre disc. */
  readonly chunks: THREE.Mesh[] = [];

  preset: WaterPresetName = 'lake';
  camera: THREE.PerspectiveCamera | null = null;

  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private ctx: WorldContext;
  private quality: QualitySettings;
  private field: TerrainField;
  private waterLevel: number;

  private geometry: THREE.BufferGeometry | null = null;
  private waterMat: THREE.ShaderMaterial | null = null;
  private lavaMat: THREE.ShaderMaterial | null = null;

  private normalTex: THREE.DataTexture | null = null;
  private foamTex: THREE.DataTexture | null = null;
  private causticTex: THREE.DataTexture | null = null;

  // --- planar reflection ---
  private reflRT: THREE.WebGLRenderTarget | null = null;
  private reflCam = new THREE.PerspectiveCamera();
  private textureMatrix = new THREE.Matrix4();
  private clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private reflecting = false;
  private reflectionsWanted = false;
  private reflectionsOn = false;
  private time = 0;
  /**
   * Armed by the first `update()`, not at build time — see Terrain's `culling`
   * field for the full argument. Short version: three culls before any draw
   * callback runs, so the pivot has to be placed from `update()` for the bounds
   * to mean anything, and latching means "update() never ran" degrades to
   * today's uncullable-but-visible behaviour instead of an invisible ocean.
   */
  private culling = false;
  /** Sectors that passed the frustum test this frame, for the perf readout. */
  private live = 0;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    ctx: WorldContext,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.ctx = ctx;
    this.quality = quality;
    this.field = ctx.field;
    this.waterLevel = ctx.waterLevel;
    this.reflectionsWanted = quality.tier === 'high' || quality.tier === 'ultra';
  }

  get level(): number { return this.waterLevel; }

  async init(): Promise<void> {
    this.group.name = 'Water';
    this.group.renderOrder = RENDER_ORDER.WATER;
    this.scene.add(this.group);

    // A water plane far below the deepest terrain can never be seen — skip the
    // whole subsystem rather than pay for an invisible draw call.
    if (this.waterLevel < this.field.minHeight - 3) return;

    const texSize = this.quality.tier === 'low' ? 128 : 256;
    this.normalTex = makeWaterNormal(texSize);
    this.foamTex = makeFoam(texSize);
    this.causticTex = makeCaustics(texSize);

    this.geometry = buildDisc(RES_FOR_TIER[this.quality.tier] ?? 129);

    this.surface.name = 'WaterSurface';
    this.surface.position.y = this.waterLevel;
    this.group.add(this.surface);

    // Where a sector's vertices can end up in the pivot's local frame. Both this
    // material and the lava one have two branches:
    //
    //   offshore  wp.y = uWaterLevel + gerstner        -> local ±2.22·uSwell.x,
    //             and `setWind` can drive uSwell.x to 0.99 in a gale, so ±2.3.
    //   inland    wp.y = terrain - 6.0, taken only where depth < -2.5, i.e. only
    //             where terrain > waterLevel + 2.5 — so it reaches DOWN to just
    //             waterLevel − 3.5, but UP to (maxHeight − 6). That upward reach
    //             is the one that is easy to miss: the first version of this
    //             bounded the disc at +3 m and `.probe-tmp/g5.ts` caught sector
    //             vertices 2.6 m outside their own sphere, which is a sea that
    //             disappears in patches. Those vertices are all discarded by the
    //             fragment shader (`if (depth < -0.03) discard`) and buried under
    //             the terrain, but three culls on geometry, not on outcome.
    const mat = this.ensureWaterMaterial();
    const sectors = splitClipmapGrid(
      this.geometry, DISC_BANDS, DISC_SECTORS,
      -5, Math.max(4, this.field.maxHeight - 6 - this.waterLevel) + 1,
    );
    for (let i = 0; i < sectors.length; i++) {
      const mesh = new THREE.Mesh(sectors[i], mat);
      mesh.name = i === 0 ? 'WaterDisc' : `WaterDisc.s${i}`;
      mesh.frustumCulled = false;          // armed by `update()`; see `culling`
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = RENDER_ORDER.WATER;
      mesh.matrixAutoUpdate = false;
      this.chunks.push(mesh);
      this.surface.add(mesh);
    }

    // Recentre on whichever camera is drawing us, as a backstop for a pass whose
    // camera `update()` never saw. Only the centre disc carries it: it is the one
    // sector that is never culled, so it is the one that always gets the callback.
    // Deliberately cheap, and the reflection pass is NOT kicked from here (see
    // `update()`) because onBeforeRender fires once per scene pass — main pass,
    // NormalPass, and once more inside the reflection itself — which used to
    // multiply one reflection into four full-scene re-renders per frame.
    const centre = this.chunks[0];
    if (centre) {
      centre.onBeforeRender = (_renderer, _scene, camera) => {
        const pc = camera as THREE.PerspectiveCamera;
        if (!pc.isPerspectiveCamera) return;
        if (!pc.userData.apxReflectionCam) this.camera = pc;
        this.recentre(pc.position.x, pc.position.z);
      };
    }

    if (this.reflectionsWanted) this.setupReflection();
    this.setPreset(themeToPreset(this.ctx.theme));
  }

  // =========================================================================
  // MATERIALS
  // =========================================================================

  private sharedUniforms(): Record<string, THREE.IUniform> {
    return {
      ...worldFogUniforms,
      ...worldSunUniforms,
      ...fieldUniforms(this.field),
      uTime: { value: 0 },
      uWaterLevel: { value: this.waterLevel },
      uWindDir: { value: new THREE.Vector2(0.86, 0.51) },
      uZenith: { value: worldSunUniforms.uAmbientSky.value },
      uHorizon: { value: worldFogUniforms.uFogColor.value },
      uSkyBoost: { value: 1.7 },
    };
  }

  private ensureWaterMaterial(): THREE.ShaderMaterial {
    if (this.waterMat) return this.waterMat;
    const look = LOOKS.lake;

    const uniforms: Record<string, THREE.IUniform> = {
      ...this.sharedUniforms(),
      uNormalMap: { value: this.normalTex },
      uFoamMap: { value: this.foamTex },
      uCausticMap: { value: this.causticTex },
      uReflMap: { value: null },
      uReflMatrix: { value: this.textureMatrix },
      uReflAmount: { value: 0 },
      uShallow: { value: new THREE.Color(look.shallow) },
      uMid: { value: new THREE.Color(look.mid) },
      uDeep: { value: new THREE.Color(look.deep) },
      uFloor: { value: new THREE.Color(look.floor) },
      uSwell: { value: new THREE.Vector2(look.swell[0], look.swell[1]) },
      uChoppy: { value: look.choppy },
      uFoamWidth: { value: look.foamWidth },
      uAbsorb: { value: look.absorb },
      uRough: { value: look.roughness },
      uGlint: { value: look.glint },
      uCaustic: { value: look.causticStrength },
      uWhitecap: { value: look.whitecap },
    };

    const mat = new THREE.ShaderMaterial({
      name: 'apx-water',
      uniforms,
      transparent: true,
      depthWrite: true,
      side: THREE.FrontSide,
      vertexShader: /* glsl */ `
        ${GLSL_FIELD}
        ${GLSL_GERSTNER}
        uniform float uWaterLevel;
        uniform mat4 uReflMatrix;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying float vFold;
        varying float vWave;
        varying vec4 vRefl;
        varying float vFar;
        varying float vHorizon;
        varying float vLodLoss;

        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float dist = length(wp.xz - cameraPosition.xz);
          vFar = smoothstep(90.0, 520.0, dist);
          // Dissolve into the sky over the disc's last stretch. The height fog
          // alone does not do it: at this circuit's density (0.0016) a grazing
          // ray is only ~71 % fogged by the 760 m rim, so the ocean was ending on
          // a visible line instead of a horizon.
          vHorizon = smoothstep(430.0, 980.0, dist);

          // Sink anything well inland so terrain hides it; the fragment shader
          // still discards, but this stops shoreline z-fighting outright.
          float terrain = fieldHeight(wp.xz);
          float depth = uWaterLevel - terrain;

          vec3 dPdx, dPdz;
          float fold;
          float lodLoss;
          // Damp the swell in shallow water — waves shoal like real ones.
          float shoal = clamp(depth * 0.55, 0.06, 1.0);
          vec3 disp = gerstner(wp.xz, aCell, dPdx, dPdz, fold, lodLoss);
          disp *= shoal;
          vWave = disp.y;
          vFold = fold * shoal;
          vLodLoss = lodLoss;

          wp.xyz += disp;
          if (depth < -2.5) wp.y = terrain - 6.0;

          vWorld = wp.xyz;
          vNormalW = normalize(cross(dPdz, dPdx));
          vRefl = uReflMatrix * vec4(wp.xyz, 1.0);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GLSL_FIELD}
        ${GLSL_NOISE}
        ${GLSL_HEIGHT_FOG}
        uniform vec3 uSunColor;
        uniform float uSunIntensity;
        uniform vec3 uAmbientSky;
        uniform vec3 uAmbientGround;
        uniform float uAmbientIntensity;
        ${GLSL_SKY_APPROX}

        uniform float uTime;
        uniform float uWaterLevel;
        uniform sampler2D uNormalMap;
        uniform sampler2D uFoamMap;
        uniform sampler2D uCausticMap;
        uniform sampler2D uReflMap;
        uniform float uReflAmount;
        uniform vec3 uShallow;
        uniform vec3 uMid;
        uniform vec3 uDeep;
        uniform vec3 uFloor;
        uniform float uFoamWidth;
        uniform float uAbsorb;
        uniform float uRough;
        uniform float uGlint;
        uniform float uCaustic;
        uniform float uWhitecap;
        uniform vec2 uWindDir;

        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying float vFold;
        varying float vWave;
        varying vec4 vRefl;
        varying float vFar;
        varying float vHorizon;
        varying float vLodLoss;

        vec3 sampleRipples(vec2 p, float fade){
          // Two scrolling scales, blended as derivatives (UDN) so the macro
          // Gerstner normal stays dominant and nothing looks like wallpaper.
          vec2 d1 = uWindDir * uTime * 0.055;
          vec2 d2 = vec2(-uWindDir.y, uWindDir.x) * uTime * 0.031;
          vec3 n1 = texture2D(uNormalMap, p * 0.055 + d1).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(uNormalMap, p * 0.19 - d2).xyz * 2.0 - 1.0;
          vec3 n = vec3(n1.xy * 1.0 + n2.xy * 0.55, 1.0);
          n.xy *= (1.0 - fade * 0.82);
          return normalize(n);
        }

        void main(){
          float terrain = fieldHeight(vWorld.xz);
          float depth = uWaterLevel - terrain;
          if (depth < -0.03) discard;

          vec3 V = normalize(cameraPosition - vWorld);

          // --- normal ---------------------------------------------------------
          vec3 N = normalize(vNormalW);
          vec3 rip = sampleRipples(vWorld.xz, vFar);
          // Tangent frame is trivially known for a heightfield surface.
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
          vec3 B = cross(N, T);
          float ripAmt = mix(0.85, 0.25, vFar) * clamp(depth * 0.9, 0.15, 1.0);
          N = normalize(N + (T * rip.x + B * rip.y) * ripAmt);
          if (N.y < 0.02) N = normalize(vec3(N.x, 0.02, N.z));

          // --- refracted seabed ------------------------------------------------
          vec4 fd = fieldData(vWorld.xz);
          // Rocky seabed goes cool and grey; the field's AO darkens gullies.
          vec3 bedTint = mix(uFloor, uFloor * vec3(0.70, 0.73, 0.80), fd.a);
          bedTint *= mix(0.72, 1.0, fd.g);
          bedTint *= 0.86 + 0.28 * vnoise2(vWorld.xz * 0.22);
          vec3 absorbT = exp(-max(depth, 0.0) * vec3(0.42, 0.24, 0.16) * (uAbsorb * 2.6));
          vec3 bed = bedTint * absorbT;

          // Caustics: two counter-scrolling cells, only where light reaches.
          // Gated, because past ~9 m of depth the exponential has already killed
          // them and past vFar they are sub-pixel — that is two texture fetches
          // saved over most of an ocean, which pays for the specular below.
          float causticAmt = uCaustic * max(uSunDirection.y, 0.0) * (1.0 - vFar * 0.7);
          if (causticAmt > 0.015 && depth < 10.0) {
            vec2 cuv = vWorld.xz * 0.075;
            float ca = texture2D(uCausticMap, cuv + vec2(uTime * 0.021, uTime * -0.013)).r;
            float cb = texture2D(uCausticMap, cuv * 1.47 - vec2(uTime * 0.017, uTime * 0.024)).r;
            float caustic = pow(ca * cb, 1.4) * exp(-max(depth, 0.0) * 0.42) * causticAmt;
            bed += uSunColor * caustic * 1.5;
          }

          // Three-stop depth ramp. Two stops put the whole turquoise->navy
          // transition inside the first couple of metres and then held one flat
          // navy for the entire body of water; a mid stop is what gives an ocean
          // its readable shelf -> channel -> deep banding.
          float dn = 1.0 - exp(-max(depth, 0.0) * uAbsorb);
          vec3 body = mix(
            mix(uShallow, uMid, clamp(dn * 2.0, 0.0, 1.0)),
            uDeep, clamp(dn * 2.0 - 1.0, 0.0, 1.0));
          // Backscatter: shallow water over pale sand glows from below.
          body += uShallow * (1.0 - dn) * (1.0 - dn) * 0.22 * max(uSunDirection.y, 0.05);
          // Sun scattering through the swell — crests glow slightly green-gold.
          body += uShallow * max(vWave, 0.0) * 0.30 * max(uSunDirection.y, 0.0);
          vec3 refracted = mix(bed, body, dn);

          // --- reflection ------------------------------------------------------
          vec3 R = reflect(-V, N);
          R.y = max(R.y, 0.008);
          vec3 reflCol = skyApprox(R);
          if (uReflAmount > 0.001) {
            vec2 ruv = vRefl.xy / max(vRefl.w, 1e-4);
            vec2 distort = vec2(N.x, N.z) * mix(0.045, 0.008, vFar);
            vec2 suv = clamp(ruv + distort, vec2(0.002), vec2(0.998));
            vec3 planar = texture2D(uReflMap, suv).rgb;
            // Fade the planar term out where it has no information.
            float edge = smoothstep(0.0, 0.09, min(min(suv.x, 1.0 - suv.x), min(suv.y, 1.0 - suv.y)));
            float valid = edge * (1.0 - vFar * 0.55) * step(0.0, vRefl.w);
            reflCol = mix(reflCol, planar, uReflAmount * valid);
          }

          // --- fresnel ---------------------------------------------------------
          float ndv = clamp(dot(N, V), 0.0, 1.0);
          float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          F = mix(F, 1.0, 0.06);   // a touch of extra sheen reads better in AgX

          vec3 col = mix(refracted, reflCol, F);

          // --- sun specular: a path, not a spark --------------------------------
          // Was pow(NdotH, 240..1400) against a normal interpolated from a coarse
          // disc. A lobe that tight is far narrower than a pixel at range, so it
          // either misses entirely or latches onto whole triangles — which is why
          // a sunset over this ocean had no sun path at all. Sub-pixel normal
          // variance *is* roughness, so widening the lobe with distance (and in
          // choppy shallows) converts that aliasing into the broad glitter road
          // that actually appears on water.
          // vLodLoss is the share of wave amplitude the vertex LOD had to drop
          // because the disc could no longer sample it. Those waves did not stop
          // existing, they stopped being representable — so they come back here
          // as roughness, which is what sub-pixel normal variance physically IS.
          // Without this the far water flattens to a mirror as the LOD bites and
          // the glitter road disappears with it.
          float wRough = clamp(uRough + vFar * 0.19 + vLodLoss * 0.20
                               + (1.0 - min(depth, 6.0) / 6.0) * 0.03, 0.02, 0.60);
          float wA = wRough * wRough;
          vec3 H = normalize(uSunDirection + V);
          float ndh = max(dot(N, H), 0.0);
          float dd = ndh * ndh * (wA * wA - 1.0) + 1.0;
          float ggx = min((wA * wA) / (3.14159265 * dd * dd), 42.0);
          float sunUp = smoothstep(-0.05, 0.14, uSunDirection.y);
          float ndl = max(dot(N, uSunDirection), 0.0);
          col += uSunColor * ggx * ndl * sunUp * uSunIntensity * uGlint * 0.030;
          // Broad sheet sheen under the sun, which is what carries the glitter
          // road out to the horizon once the tight lobe has faded. Two lobes: the
          // tight one is the road itself, the wide one is the haze around it that
          // makes the road read as attached to the sun rather than as a stripe.
          float sheet = pow(ndh, 18.0) * 0.26 + pow(ndh, 3.5) * 0.055;
          col += uSunColor * sheet * uGlint * sunUp;

          // --- foam ------------------------------------------------------------
          // Deep open water away from a crest needs neither churn tap.
          float shoreDepth = depth - vWave * 0.9;

          // The band below is authored in metres of DEPTH, but what the eye reads
          // is its width ON THE GROUND, which is band / |grad(depth)|. Measured
          // over 1917 waterline crossings of this circuit
          // (.probe-tmp/water-shore.ts): the coast gradient runs 0.09 at the
          // beaches to 3.88 at the cliffs, so a fixed depth band gives a ground
          // width of 1.4 m at p10 against 30 m at p90 — and over 31 % of the
          // coastline it lands under ONE height-map texel (2.40 m). A band
          // narrower than the texel it is reconstructed from cannot draw anything
          // but the bilinear diamond grid underneath it, which is the "jagged
          // aliased white band". Scaling the band by the local gradient holds its
          // ground width roughly constant instead.
          float slopeWiden = 1.0;
          float nearShore = 1.0 - smoothstep(0.0, uFoamWidth * 9.0, shoreDepth);
          if (nearShore > 0.002) {
            vec3 tn = fieldNormal(vWorld.xz, 2.4);
            float grad = sqrt(max(1.0 - tn.y * tn.y, 0.0)) / max(tn.y, 0.12);
            // 0.22 is the measured median gradient, so median coast is unchanged.
            slopeWiden = clamp(grad / 0.22, 0.55, 5.0);
            // Ragged the leading edge at a scale FINER than the 2.40 m height
            // texel, so what the eye locks onto is foam texture rather than the
            // reconstruction grid under it.
            float rag = (vnoise2(vWorld.xz * 0.85 + uTime * 0.05) - 0.5)
                      + (vnoise2(vWorld.xz * 2.30 - uTime * 0.08) - 0.5) * 0.5;
            shoreDepth += rag * uFoamWidth * 0.55 * slopeWiden * nearShore;
          }

          float foamNeed = max(
            1.0 - smoothstep(0.0, uFoamWidth * 2.4 * slopeWiden, shoreDepth),
            step(1.05, vFold) * (1.0 - vFar));
          float churn = 0.55;
          if (foamNeed > 0.004) {
            vec2 fuv = vWorld.xz * 0.09;
            float f1 = texture2D(uFoamMap, fuv + vec2(uTime * 0.026, uTime * 0.017)).r;
            float f2 = texture2D(uFoamMap, fuv * 2.3 - vec2(uTime * 0.041, uTime * 0.022)).g;
            churn = f1 * 0.62 + f2 * 0.55;
          }

          // Whitecaps. The old term was smoothstep(0.55, 1.25, vFold) * churn — a
          // white band along every crest of a five-wave sum, interpolated from a
          // vertex attribute across a disc whose cells reach 8 m. That is the
          // barcode: parallel hard-edged stripes marching across the whole sea.
          // Water only breaks on the steepest faces and only in patches, so this
          // needs a crest threshold near the top of the fold range, an
          // independent patch mask, and a hard distance fade to stop the pattern
          // ever becoming periodic on screen.
          float capPatch = smoothstep(0.42, 0.88, churn);
          float cap = smoothstep(1.20, 1.86, vFold) * capPatch * uWhitecap;
          cap *= (1.0 - vFar) * (1.0 - vFar);

          // Shoreline. The hard bright lip (smoothstep(0.16, 0.0, depth), forced
          // to full alpha) drew a cut-edged white ribbon down the entire coast.
          // Real surf is a wide ragged band whose leading edge is displaced by
          // churn rather than merely faded, and which dissolves into wet sand.
          float band = uFoamWidth * (0.75 + churn * 1.1) * slopeWiden;
          float shore = 1.0 - smoothstep(0.0, band, shoreDepth);
          float swash = smoothstep(0.10, 0.98, shore * (0.34 + churn * 0.90));
          float lip = smoothstep(0.0, 0.7, -shoreDepth + (churn - 0.62) * 0.85) * 0.7;
          // Multiplying the coverage by churn rather than adding to it is what
          // stops the inner band saturating to a flat white plateau — the old
          // max(swash, lip) reached 1.0 across the whole inner metre, which is
          // the "no foam gradient" half of the finding. Now the churn field is
          // *inside* the coverage, so the band always has structure.
          float foam = clamp(max(swash, lip) * (0.62 + 0.38 * churn) + cap * 0.9, 0.0, 1.0);

          vec3 foamCol = mix(vec3(0.86, 0.90, 0.93), uSunColor * 0.5 + 0.5, 0.25);
          foamCol *= 0.82 + 0.30 * churn;
          foamCol *= (uAmbientIntensity * 0.5 + max(uSunDirection.y, 0.05) * uSunIntensity * 0.32);
          col = mix(col, foamCol, foam);

          // --- fade in at the waterline ------------------------------------------
          // Gated on depth as well as Fresnel: at a grazing angle F goes to 1
          // everywhere, and the old form therefore snapped the last few
          // centimetres of water to fully opaque — a hard edge exactly where the
          // sea should be dissolving into the beach.
          float shallowFade = clamp(depth * 1.7, 0.0, 1.0);
          float alpha = shallowFade;
          alpha = max(alpha, min(1.0, shallowFade + 0.4) * foam);
          alpha = max(alpha, F * 0.9 * clamp(depth * 2.4, 0.0, 1.0));

          // --- horizon dissolve --------------------------------------------------
          // The last stretch of the disc becomes the sky just above the horizon,
          // so the surface has somewhere to go instead of stopping at its own rim.
          // Opaque out there too: a disc that fades to alpha 0 at the horizon
          // shows whatever is behind it, which is the inside of the sky dome at a
          // different brightness — a seam in the other direction.
          vec3 hz = normalize(vec3(-V.x, 0.03, -V.z));
          col = mix(col, skyApprox(hz), vHorizon * 0.90);
          alpha = max(alpha, vHorizon);

          col = applyHeightFog(col, vWorld, cameraPosition);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    this.waterMat = mat;
    return mat;
  }

  private ensureLavaMaterial(): THREE.ShaderMaterial {
    if (this.lavaMat) return this.lavaMat;
    const mat = new THREE.ShaderMaterial({
      name: 'apx-lava',
      uniforms: {
        ...this.sharedUniforms(),
        uNormalMap: { value: this.normalTex },
        uCrust: { value: new THREE.Color(0x14090a) },
        uCrustHot: { value: new THREE.Color(0x3a1410) },
        uVein: { value: new THREE.Color(0xff7326) },
        uCore: { value: new THREE.Color(0xffe6a6) },
        uFlow: { value: 0.035 },
        uEmissive: { value: 4.2 },
      },
      transparent: false,
      depthWrite: true,
      side: THREE.FrontSide,
      vertexShader: /* glsl */ `
        ${GLSL_FIELD}
        ${GLSL_NOISE}
        uniform float uTime;
        uniform float uWaterLevel;
        varying vec3 vWorld;
        varying float vDepth;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float terrain = fieldHeight(wp.xz);
          vDepth = uWaterLevel - terrain;
          // Slow convective heave: molten rock moves like treacle.
          float heave = fbm2(wp.xz * 0.006 + vec2(uTime * 0.012, uTime * 0.008), 3);
          wp.y += (heave - 0.5) * 0.55 * clamp(vDepth * 0.5, 0.0, 1.0);
          if (vDepth < -2.5) wp.y = terrain - 6.0;
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GLSL_FIELD}
        ${GLSL_NOISE}
        ${GLSL_HEIGHT_FOG}
        uniform float uTime;
        uniform float uWaterLevel;
        uniform vec3 uCrust;
        uniform vec3 uCrustHot;
        uniform vec3 uVein;
        uniform vec3 uCore;
        uniform float uFlow;
        uniform float uEmissive;
        varying vec3 vWorld;
        varying float vDepth;

        void main(){
          float terrain = fieldHeight(vWorld.xz);
          float depth = uWaterLevel - terrain;
          if (depth < -0.03) discard;

          // Domain-warped flow field, drifting downhill-ish.
          vec2 p = vWorld.xz * 0.028;
          vec2 drift = vec2(uTime * uFlow, uTime * uFlow * 0.62);
          vec2 warp = vec2(fbm2(p * 0.7 + drift, 4), fbm2(p * 0.7 + 5.2 - drift, 4)) - 0.5;
          vec2 q = p + warp * 1.6 - drift * 0.5;

          float plates = fbm2(q, 5);
          // Crust cracks: the ridges between convection plates glow.
          float ridge = 1.0 - abs(plates * 2.0 - 1.0);
          float crack = pow(clamp(ridge, 0.0, 1.0), 5.0);
          float fine = pow(clamp(1.0 - abs(fbm2(q * 3.7 + drift * 2.0, 3) * 2.0 - 1.0), 0.0, 1.0), 7.0);
          crack = clamp(crack * 1.15 + fine * 0.75, 0.0, 1.0);

          // Fresh lava near the shoreline where it meets rock, and in deep pools.
          float edgeHeat = smoothstep(1.6, 0.0, depth) * 0.55;
          float heat = clamp(crack + edgeHeat, 0.0, 1.0);
          // Pulsing so it never looks like a static texture.
          heat *= 0.78 + 0.22 * sin(uTime * 0.9 + plates * 9.0);

          vec3 crust = mix(uCrust, uCrustHot, pow(plates, 2.0));
          vec3 hot = mix(uVein, uCore, pow(heat, 2.6));
          vec3 col = mix(crust, hot, smoothstep(0.14, 0.72, heat));
          col += hot * pow(heat, 3.0) * uEmissive;

          // Ash skin drifting on top.
          float ash = fbm2(q * 6.1 + drift * 3.0, 3);
          col *= mix(1.0, 0.62, smoothstep(0.58, 0.86, ash) * (1.0 - heat));

          col = applyHeightFog(col, vWorld, cameraPosition);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.lavaMat = mat;
    return mat;
  }

  // =========================================================================
  // PRESETS
  // =========================================================================

  setPreset(name: WaterPresetName | WorldTheme): void {
    const preset: WaterPresetName = (name === 'ocean' || name === 'lake' || name === 'lava' || name === 'none')
      ? name : themeToPreset(name);
    this.preset = preset;
    if (!this.chunks.length) return;

    if (preset === 'none') {
      this.surface.visible = false;
      this.reflectionsOn = false;
      return;
    }
    this.surface.visible = true;

    if (preset === 'lava') {
      this.applyMaterial(this.ensureLavaMaterial());
      this.reflectionsOn = false;
      return;
    }

    const mat = this.ensureWaterMaterial();
    const look = LOOKS[preset];
    const u = mat.uniforms;
    (u.uShallow.value as THREE.Color).setHex(look.shallow);
    (u.uMid.value as THREE.Color).setHex(look.mid);
    (u.uDeep.value as THREE.Color).setHex(look.deep);
    (u.uFloor.value as THREE.Color).setHex(look.floor);
    (u.uSwell.value as THREE.Vector2).set(look.swell[0], look.swell[1]);
    u.uChoppy.value = look.choppy;
    u.uFoamWidth.value = look.foamWidth;
    u.uAbsorb.value = look.absorb;
    u.uRough.value = look.roughness;
    u.uGlint.value = look.glint;
    u.uCaustic.value = look.causticStrength;
    u.uWhitecap.value = look.whitecap;
    this.applyMaterial(mat);
    this.reflectionsOn = this.reflectionsWanted && !!this.reflRT;
    u.uReflAmount.value = this.reflectionsOn ? 0.82 : 0;
  }

  /** One material across every sector — they are one surface, cut for culling. */
  private applyMaterial(mat: THREE.ShaderMaterial): void {
    for (const c of this.chunks) {
      c.material = mat;
      c.layers.enable(LAYERS.BLOOM);
    }
  }

  /** Slide the disc pivot under a camera. Cheap and idempotent. */
  private recentre(x: number, z: number): void {
    const p = this.surface.position;
    if (p.x === x && p.z === z) return;
    p.set(x, this.waterLevel, z);
    this.surface.updateMatrix();
    this.surface.updateMatrixWorld(true);
  }

  setCamera(camera: THREE.PerspectiveCamera): void {
    if (camera && camera.isPerspectiveCamera) this.camera = camera;
  }

  setWind(strength: number, dirRadians: number): void {
    const set = (m: THREE.ShaderMaterial | null): void => {
      if (!m) return;
      (m.uniforms.uWindDir.value as THREE.Vector2)
        .set(Math.cos(dirRadians), Math.sin(dirRadians)).normalize();
    };
    set(this.waterMat);
    set(this.lavaMat);
    if (this.waterMat) {
      const look = LOOKS[this.preset === 'ocean' ? 'ocean' : 'lake'];
      const swell = this.waterMat.uniforms.uSwell.value as THREE.Vector2;
      swell.x = look.swell[0] * (0.6 + clamp(strength, 0, 1.2) * 1.3);
    }
  }

  /** Lets the render pipeline turn the reflection pass off under load. */
  setReflections(on: boolean): void {
    this.reflectionsWanted = on;
    this.reflectionsOn = on && !!this.reflRT && this.preset !== 'lava' && this.preset !== 'none';
    if (this.waterMat) this.waterMat.uniforms.uReflAmount.value = this.reflectionsOn ? 0.82 : 0;
  }

  // =========================================================================
  // PLANAR REFLECTION
  // =========================================================================

  private setupReflection(): void {
    // Half of what this used to be. The reflection is Fresnel-mixed at 0.82 into
    // a surface that is itself wave-distorted and depth-tinted, so it survives
    // being soft; 1024² was four times the pixels for no visible gain.
    const size = this.quality.tier === 'ultra' ? 512 : 384;
    this.reflRT = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.reflRT.texture.colorSpace = THREE.NoColorSpace;
    if (this.waterMat) {
      this.waterMat.uniforms.uReflMap.value = this.reflRT.texture;
      this.waterMat.uniforms.uReflAmount.value = 0.82;
    }
    this.reflCam.layers.set(LAYERS.DEFAULT);
    this.reflCam.layers.enable(LAYERS.BLOOM);
    this.reflCam.userData.apxReflectionCam = true;
    this.reflectionsOn = true;
  }

  /**
   * Is the plane y = waterLevel anywhere inside the camera frustum, within the
   * radius the disc actually covers? Conservative (it ignores terrain occlusion)
   * but it costs a handful of multiplies and it reliably kills the pass whenever
   * the camera is pitched up at the sky, which is most of a jump.
   *
   * Allocation-free: only the eight frustum corners' *Y* extent is needed, and
   * that separates into `fwd.y·d ± |right.y|·hw ± |up.y|·hh`.
   */
  private planeInFrustum(camera: THREE.PerspectiveCamera): boolean {
    const e = camera.matrixWorld.elements;
    // Basis columns of the camera's world matrix: right = e[0..2], up = e[4..6],
    // forward = -e[8..10].
    const ryAbs = Math.abs(e[1]);
    const uyAbs = Math.abs(e[5]);
    const fy = -e[9];
    const near = camera.near;
    const far = Math.min(camera.far, HALF_EXTENT * 1.35);
    const tan = Math.tan((camera.fov * Math.PI) / 360);

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 2; i++) {
      const d = i === 0 ? near : far;
      const hh = tan * d;
      const hw = hh * camera.aspect;
      const spread = ryAbs * hw + uyAbs * hh;
      const centre = fy * d;
      if (centre - spread < lo) lo = centre - spread;
      if (centre + spread > hi) hi = centre + spread;
    }
    const rel = this.waterLevel - camera.position.y;
    return rel >= lo && rel <= hi;
  }

  private renderReflection(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ): void {
    const rt = this.reflRT;
    const surface = this.surface;
    if (!rt || !this.chunks.length || !surface.visible) return;
    // Nothing above the water to mirror if we're looking from below.
    if (camera.position.y < this.waterLevel + 0.25) return;
    if (!this.planeInFrustum(camera)) return;

    this.reflecting = true;

    _reflectorPos.set(0, this.waterLevel, 0);
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    _normal.set(0, 1, 0);

    _view.subVectors(_reflectorPos, _camPos);
    _view.reflect(_normal).negate().add(_reflectorPos);

    _rot.extractRotation(camera.matrixWorld);
    _lookAt.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
    _target.subVectors(_reflectorPos, _lookAt);
    _target.reflect(_normal).negate().add(_reflectorPos);

    const rc = this.reflCam;
    rc.position.copy(_view);
    rc.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);
    rc.lookAt(_target);
    rc.near = camera.near;
    rc.far = camera.far;
    rc.fov = camera.fov;
    rc.aspect = 1;
    rc.updateProjectionMatrix();
    rc.updateMatrixWorld(true);

    // Projected UVs for the water shader.
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    );
    this.textureMatrix.multiply(rc.projectionMatrix);
    this.textureMatrix.multiply(rc.matrixWorldInverse);

    // --- hide what must not appear in a reflection ---------------------------
    // Anything flagged `userData.noReflect` opts out (grass, crowd, props,
    // weather — set by Environment), as does anything whose root name is in
    // SKIP_NAMES (particle systems and god rays, which are additive sprites that
    // cannot survive a 512px mirrored buffer anyway). What is left is terrain,
    // mountains, sky, track and karts: the silhouette, which is all a
    // Fresnel-weighted reflection ever shows.
    // Scanned two levels deep (scene roots and their groups) rather than with a
    // full traverse, because this runs every frame.
    _hidden.length = 0;
    surface.visible = false;
    for (const child of scene.children) {
      if (!child.visible) continue;
      if (child.userData.noReflect === true || SKIP_NAMES.has(child.name)) {
        child.visible = false;
        _hidden.push(child);
        continue;
      }
      for (const sub of child.children) {
        if (sub.visible && (sub.userData.noReflect === true || SKIP_NAMES.has(sub.name))) {
          sub.visible = false;
          _hidden.push(sub);
        }
      }
    }

    const prevRT = renderer.getRenderTarget();
    const prevClip = renderer.clippingPlanes;
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevXr = renderer.xr.enabled;

    // Clip everything under the surface so the seabed can't mirror upward.
    this.clipPlane.set(_up, -(this.waterLevel - 0.15));
    renderer.clippingPlanes = [this.clipPlane];
    renderer.shadowMap.autoUpdate = false;
    renderer.xr.enabled = false;

    try {
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, false);
      renderer.render(scene, rc);
    } catch (err) {
      console.error('[Water] reflection pass failed — disabling:', err);
      this.setReflections(false);
    } finally {
      renderer.setRenderTarget(prevRT);
      renderer.clippingPlanes = prevClip;
      renderer.shadowMap.autoUpdate = prevShadow;
      renderer.xr.enabled = prevXr;
      surface.visible = true;
      for (const o of _hidden) o.visible = true;
      _hidden.length = 0;
      this.reflecting = false;
    }
  }

  // =========================================================================

  update(ctx: FrameContext): void {
    this.time += ctx.dt;
    if (this.waterMat) this.waterMat.uniforms.uTime.value = this.time;
    if (this.lavaMat) this.lavaMat.uniforms.uTime.value = this.time;

    const cam = this.camera;
    if (!this.chunks.length || !cam) return;

    // Placing the pivot HERE, ahead of every pass, is what makes the sectors
    // cullable: three frustum-tests in `projectObject`, before any draw callback,
    // so a disc that only re-centres from onBeforeRender is being culled against
    // last pass's position. Note this runs for lava and for reflections-off too —
    // it used to sit below the `reflectionsOn` early-out, which would have left
    // the volcano's lava disc uncentred and therefore wrongly culled.
    this.recentre(cam.position.x, cam.position.z);
    if (!this.culling) {
      this.culling = true;
      // The centre disc stays uncullable: it owns the re-centre callback, and it
      // is in frustum from any pose that can see the surface at all.
      for (let i = 1; i < this.chunks.length; i++) this.chunks[i].frustumCulled = true;
    }
    this.live = this.countLive(cam);

    // ONE reflection pass per frame, driven from the simulation step rather than
    // from `onBeforeRender`. The pipeline renders the scene more than once a
    // frame (RenderPass, then NormalPass with an override material) and a
    // reflection kicked off from a draw callback fires in each of them — the
    // second one drawing the whole world as flat normals into a buffer nobody
    // reads. Doing it here also lets `planeInFrustum` skip the pass entirely.
    if (!this.reflectionsOn) return;
    this.renderReflection(this.renderer, this.scene, cam);
  }

  /**
   * Repeat three's own frustum test over the sectors, purely so `drawCalls`
   * reports what the frame actually submits instead of the sector total. ~23
   * sphere tests; it is also the number the G5 probe cross-checks its own walk
   * of the scene graph against.
   */
  private countLive(camera: THREE.PerspectiveCamera): number {
    if (!this.surface.visible) return 0;
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    let n = 0;
    for (const c of this.chunks) {
      const bs = c.geometry.boundingSphere;
      if (!bs) { n++; continue; }
      if (!c.frustumCulled) { n++; continue; }
      _sphere.copy(bs).applyMatrix4(c.matrixWorld);
      if (_frustum.intersectsSphere(_sphere)) n++;
    }
    return n;
  }

  get drawCalls(): number {
    if (!this.surface.visible) return 0;
    return this.live;
  }

  dispose(): void {
    for (const c of this.chunks) c.geometry.dispose();
    this.chunks.length = 0;
    // Disposed after the sectors: they share its vertex attributes, and three's
    // attribute cache drops a shared buffer on the first dispose that names it.
    this.geometry?.dispose();
    this.waterMat?.dispose();
    this.lavaMat?.dispose();
    this.normalTex?.dispose();
    this.foamTex?.dispose();
    this.causticTex?.dispose();
    this.reflRT?.dispose();
    this.geometry = null;
    this.waterMat = null;
    this.lavaMat = null;
    this.normalTex = null;
    this.foamTex = null;
    this.causticTex = null;
    this.reflRT = null;
    this.surface.clear();
    this.scene.remove(this.group);
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------

function themeToPreset(theme: WorldTheme | string): WaterPresetName {
  switch (theme) {
    case 'coastal': return 'ocean';
    case 'volcano': return 'lava';
    case 'desert': return 'none';
    default: return 'lake';
  }
}

/**
 * Radially warped square: dense near the camera where wave shape matters,
 * coarse at the horizon where it doesn't. Same trick Terrain uses, so the two
 * surfaces tessellate at comparable rates and the shoreline stays clean.
 */
function buildDisc(res: number): THREE.BufferGeometry {
  const cells = res - 1;
  const verts = res * res;
  const pos = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  /** Local grid spacing in metres — see GLSL_GERSTNER's wave LOD. */
  const cell = new Float32Array(verts);

  const warp = (t: number): number => {
    const a = Math.abs(t);
    const w = 0.05 * a + 0.95 * a * a * a;
    return Math.sign(t) * w * HALF_EXTENT;
  };
  /**
   * d|warp|/d|t| times one grid step: the metres between this vertex and its
   * neighbour along that axis. Baked rather than re-derived in the shader from
   * distance, because recovering `t` from a warped radius means inverting a
   * cubic every vertex — and this is exact, including on the diagonal where the
   * two axes disagree.
   */
  const step = 2 / cells;
  const spacing = (t: number): number => (0.05 + 2.85 * t * t) * HALF_EXTENT * step;

  let p = 0, q = 0, c = 0;
  for (let j = 0; j < res; j++) {
    const tz = (j / cells) * 2 - 1;
    const z = warp(tz);
    const sz = spacing(tz);
    for (let i = 0; i < res; i++) {
      const tx = (i / cells) * 2 - 1;
      pos[p] = warp(tx);
      pos[p + 1] = 0;
      pos[p + 2] = z;
      p += 3;
      uv[q] = i / cells; uv[q + 1] = j / cells; q += 2;
      cell[c++] = Math.max(spacing(tx), sz);
    }
  }

  const idx = new Uint32Array(cells * cells * 6);
  let k = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * res + i;
      const b = a + 1;
      const c = a + res;
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), HALF_EXTENT * 1.5);
  return geo;
}
