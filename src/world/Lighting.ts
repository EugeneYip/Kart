/**
 * ============================================================================
 *  APEX KART — LIGHTING
 * ============================================================================
 *  - Manual cascaded shadow maps (three has none). One DirectionalLight per
 *    cascade; the built-in lighting chunk is patched so exactly one cascade
 *    contributes per fragment, cross-faded over a small band. Each cascade's
 *    ortho is fitted to the *bounding sphere* of its camera sub-frustum (so it
 *    never resizes when the camera turns) and its centre is snapped to shadow
 *    texel increments (so shadows never crawl).
 *  - Cascades are budgeted, not maximal: 3 at most, staggered so only the near
 *    one redraws every frame, with a per-cascade visibility mask so grass,
 *    crowds and small props stop being re-rasterised into 200 m ortho boxes.
 *    See `SHADOW_LAYER` for how other subsystems opt in.
 *  - Height fog installed globally by patching three's fog shader chunks:
 *    every material in the game, whoever authored it, gets mist that pools in
 *    valleys instead of a flat distance fade. Density is authored for *aerial
 *    perspective* — a tint at 300 m, not a veil at 30 m.
 *  - Lighting is one strong warm directional key against a deliberately weak
 *    cool fill (hemisphere + IBL). That ratio, ~6:1 on the diffuse term, is
 *    what makes shadows read; a fat ambient is what flattens a render.
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings } from '@/core/Types';
import { clamp, clamp01, damp } from '@/core/MathUtils';
import { SKY_PRESETS, type Sky, type SkyPresetName } from './Sky';
import { worldFogUniforms, worldRegistry, worldSunUniforms } from './WorldTextures';

// ---------------------------------------------------------------------------
// Fog constants — MUST stay preset-independent.
// three caches compiled programs by material parameters, not by chunk content,
// so anything baked into a shader chunk can never change at runtime. Presets
// therefore vary fog *colour* and *density* only (both real uniforms), while
// the height falloff geometry is a global constant.
// ---------------------------------------------------------------------------

/** Altitude in metres where fog reaches full density. */
export const FOG_HEIGHT = 6.0;
/**
 * Exponential falloff per metre above FOG_HEIGHT — 1/0.012 ≈ 83 m scale height.
 * The old 0.019 hugged the ground so tightly that hills poked out of the fog
 * entirely and read as flat pale cut-outs instead of receding planes.
 */
export const FOG_FALLOFF = 0.012;

let chunksPatched = false;

/**
 * Replace three's fog with analytic height fog for every material in the game.
 * Called once, before anything renders (so before any program is compiled).
 */
function patchFogChunks(): void {
  const C = THREE.ShaderChunk as unknown as Record<string, string>;

  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif`;

  // mvPosition exists in every stock vertex shader that includes fog_vertex
  // (mesh, points and sprite). viewMatrix's upper 3x3 is orthonormal, so its
  // inverse is its transpose — this reconstruction is exact and allocation-free.
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPos = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif`;

  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    vec3 fogRay = vFogWorldPos - cameraPosition;
    float fogDist = max( length( fogRay ), 1e-4 );
    float fogRy = fogRay.y / fogDist;
    float fogB = ${FOG_FALLOFF.toFixed(5)};
    float fogBase = fogDensity * exp( - ( cameraPosition.y - ${FOG_HEIGHT.toFixed(2)} ) * fogB );
    float fogAmt;
    if ( abs( fogRy ) < 1e-4 ) fogAmt = fogBase * fogDist;
    else fogAmt = fogBase * ( 1.0 - exp( - fogDist * fogRy * fogB ) ) / ( fogRy * fogB );
    float fogFactor = 1.0 - exp( - max( fogAmt, 0.0 ) );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp( fogFactor, 0.0, 1.0 ) );
#endif`;
}

/**
 * Patch the directional-light loop so cascade i only lights fragments inside
 * its own view-depth slice. `csmWeight` is generated with the split distances
 * baked in as literals — they depend only on camera near/far and the cascade
 * count, both fixed at init.
 */
function patchCsmChunks(cascades: number, splits: number[], bands: number[]): void {
  const C = THREE.ShaderChunk as unknown as Record<string, string>;

  let weightFn = 'float csmWeight( const in int idx, const in float d ) {\n  float w = 1.0;\n';
  for (let i = 0; i < cascades; i++) {
    const parts: string[] = [];
    if (i > 0) {
      const s = splits[i];
      const b = Math.max(0.25, bands[i]);
      parts.push(`smoothstep( ${(s - b).toFixed(3)}, ${s.toFixed(3)}, d )`);
    }
    if (i < cascades - 1) {
      const s = splits[i + 1];
      const b = Math.max(0.25, bands[i + 1]);
      parts.push(`( 1.0 - smoothstep( ${(s - b).toFixed(3)}, ${s.toFixed(3)}, d ) )`);
    }
    const expr = parts.length ? parts.join(' * ') : '1.0';
    weightFn += `  ${i === 0 ? 'if' : 'else if'} ( idx == ${i} ) w = ${expr};\n`;
  }
  weightFn += '  return w;\n}\n';

  if (!ORIGINAL_LIGHTS_PARS) ORIGINAL_LIGHTS_PARS = C.lights_pars_begin;
  if (!ORIGINAL_LIGHTS_FRAG) ORIGINAL_LIGHTS_FRAG = C.lights_fragment_begin;

  C.lights_pars_begin = `${ORIGINAL_LIGHTS_PARS}
#ifndef CSM_EXTRA_SHADOW
  #define CSM_EXTRA_SHADOW 1.0
#endif
${weightFn}`;

  const SHADOW_LOOKUP =
    'directionalLightShadow = directionalLightShadows[ i ];\n' +
    '\t\t\tdirectLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( ' +
    'directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, ' +
    'directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, ' +
    'directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';

  const dirBlock = `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	float csmViewDepth = - geometryPosition.z;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		{
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if ( UNROLLED_LOOP_INDEX < ${cascades} )
			float csmW = csmWeight( UNROLLED_LOOP_INDEX, csmViewDepth );
			if ( csmW > 0.001 ) {
				#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
				${SHADOW_LOOKUP}
				#endif
				directLight.color *= csmW * CSM_EXTRA_SHADOW;
				RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
			}
		#else
			#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
			${SHADOW_LOOKUP}
			#endif
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif
		}
	}
	#pragma unroll_loop_end
#endif`;

  // Swap the stock directional block for the cascade-aware one.
  const src = ORIGINAL_LIGHTS_FRAG;
  const start = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  if (start < 0) {
    console.warn('[Lighting] could not locate the directional light block; CSM disabled');
    return;
  }
  // Match the block end structurally rather than as one literal: three's
  // published sources and its rollup bundle differ in whether a blank line sits
  // between the pragma and the `#endif`, and a literal that misses silently
  // disables the whole cascade system.
  const pragma = src.indexOf('#pragma unroll_loop_end', start);
  const endif = pragma < 0 ? -1 : src.indexOf('#endif', pragma);
  if (endif < 0) {
    console.warn('[Lighting] could not locate the end of the directional block; CSM disabled');
    return;
  }
  C.lights_fragment_begin =
    src.slice(0, start) + dirBlock + src.slice(endif + '#endif'.length);
}

let ORIGINAL_LIGHTS_PARS = '';
let ORIGINAL_LIGHTS_FRAG = '';

// ---------------------------------------------------------------------------

/**
 * ---------------------------------------------------------------------------
 *  SHADOW LAYER CONVENTION — how to keep your geometry out of the far cascades
 * ---------------------------------------------------------------------------
 *  three's shadow pass tests `object.layers` against the *view* camera, not the
 *  shadow camera, so `light.shadow.camera.layers` is inert (verified in
 *  r0.185). Lighting therefore drives the cascades itself and applies a
 *  visibility mask per cascade. To opt a subtree in, `enable()` a bit — never
 *  `set()`, which would clear bit 0 and hide the object from the main camera:
 *
 *      mesh.layers.enable(SHADOW_LAYER.NEAR_ONLY);   // casts only 0–15 m
 *      group.layers.enable(SHADOW_LAYER.MID_ONLY);   // casts only 0–47 m
 *
 *  Tag the highest node you can — the mask hides whole subtrees. Good
 *  candidates: NEAR_ONLY for grass/foliage cards, crowd, debris, kerb detail,
 *  particles; MID_ONLY for fences, barriers, signage, mid-size props. Anything
 *  that reads as a silhouette at distance (grandstands, gantries, trees,
 *  buildings) should stay untagged.
 */
export const SHADOW_LAYER = {
  /** Casts into cascade 0 only. */
  NEAR_ONLY: 11,
  /** Casts into cascades 0 and 1 only. */
  MID_ONLY: 12,
} as const;

/**
 * ---------------------------------------------------------------------------
 *  ARTIFICIAL LIGHT AT NIGHT
 * ---------------------------------------------------------------------------
 *  Floodlight masts, streetlights, neon and traffic signals are all authored in
 *  Props.ts as InstancedMeshes with emissive materials. They *glow* — they show
 *  up in bloom — but before this they put no light onto the world: `PointLight`
 *  appeared nowhere in the project, so the only lights at night were the moon
 *  key and the hemisphere fill, and the night preset read as "the day rig with
 *  the exposure pulled down".
 *
 *  Props.ts cannot simply create a light per lamp: a circuit carries ~14 masts
 *  plus dozens of streetlights and signs, and every point light in the scene is
 *  a BRDF evaluation for every lit fragment in the frame. So Lighting keeps a
 *  small pool and re-points it at the nearest emitters each frame. The emitter
 *  positions are read straight off the instance matrices, which means no other
 *  subsystem has to publish anything and props that stream in are picked up by
 *  the periodic rescan that the shadow mask already runs.
 *
 *  `intensity` is candela: three's point lights are physical, irradiance =
 *  intensity / d². The values below are chosen so the pool of light under a
 *  source lands near 1.0 irradiance, i.e. comparable to the 1.05 moon key —
 *  visible pools of warm light, not blown-out white discs. `range` is the
 *  falloff window so one lamp cannot leak across the whole circuit.
 */
interface EmitterClass {
  /**
   * Matched against `InstancedMesh.name`. A pattern, not an exact name: the same
   * fitting is emitted under two naming conventions — the trackside pass makes
   * `Prop:streetlightLamp` while the authored-scatter pass makes
   * `Prop:authored:streetlamp:glow` — and an exact-name table matched neither on
   * the coastal circuit, whose scene actually carries 3 flood heads, 1
   * lighthouse lamp, 8 streetlamps and 26 lit shopfronts.
   */
  readonly match: RegExp;
  readonly color: number;
  readonly intensity: number;
  readonly range: number;
}

const NIGHT_EMITTERS: readonly EmitterClass[] = [
  { match: /floodhead|floodlight/i, color: 0xfff3d8, intensity: 1100, range: 90 },
  { match: /lighthouselamp/i, color: 0xfff1cf, intensity: 500, range: 80 },
  { match: /neon/i, color: 0xff62c8, intensity: 90, range: 26 },
  { match: /gantrylights|gantry:glow/i, color: 0xffe6b0, intensity: 120, range: 32 },
  { match: /streetlamp|streetlight/i, color: 0xffcf94, intensity: 70, range: 28 },
  { match: /trafficlight/i, color: 0xffd06a, intensity: 30, range: 16 },
  // Lit shopfronts and windows. Weak on purpose: there are 26 of them on one
  // circuit, and their job is to make the town read as inhabited rather than to
  // light the road.
  { match: /townhouse:glow|building:glow|window/i, color: 0xffc98a, intensity: 34, range: 20 },
] as const;

/** Beyond this the 1/d² contribution of even a mast is below a bit of output. */
const EMITTER_CULL = 150;

interface Emitter {
  x: number;
  y: number;
  z: number;
  cls: number;
}

interface Cascade {
  light: THREE.DirectionalLight;
  /** view-space near/far of this slice, metres */
  near: number;
  far: number;
  /** bounding-sphere radius of the sub-frustum — constant, hence stable */
  radius: number;
  /** distance along the view axis to the sphere centre */
  centreDist: number;
  mapSize: number;
  /** Redraw every `interval` frames. Far cascades barely move; near must be 1. */
  interval: number;
}

/** The slice of `WebGLShadowMap` the cascade driver needs to talk to. */
interface ShadowMapLike {
  enabled: boolean;
  autoUpdate: boolean;
  needsUpdate: boolean;
  render(lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera): void;
}

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _lz = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rimDir = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _tmpColor = new THREE.Color();
const _m4 = new THREE.Matrix4();
const _local = new THREE.Vector3();

export class Lighting implements ISubsystem {
  /** Cascade 0's light — the canonical "sun" for anything that needs it. */
  keyLight!: THREE.DirectionalLight;
  hemi!: THREE.HemisphereLight;
  rim!: THREE.DirectionalLight;

  presetName: SkyPresetName = 'day';

  /** How far shadows reach, metres. */
  shadowFar: number;
  readonly cascadeCount: number;

  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private quality: QualitySettings;
  private cascades: Cascade[] = [];
  private sky: Sky | null = null;
  private fog!: THREE.FogExp2;
  private group = new THREE.Group();
  private baseKeyIntensity = 3.5;
  private baseAmbient = 1;
  private flash = 0;
  private initialised = false;
  private frame = 0;

  // --- per-cascade culling ---
  private shadowMapHook: ShadowMapLike | null = null;
  private shadowRenderOriginal:
    | ((lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera) => void)
    | null = null;
  private nearOnly: THREE.Object3D[] = [];
  private midOnly: THREE.Object3D[] = [];
  private maskedWasVisible: boolean[] = [];
  private maskScanTimer = 1e9;
  private maskActive = false;
  private lastCameraShape = -1;

  // --- artificial light at night ---
  private lampPool: THREE.PointLight[] = [];
  private emitters: Emitter[] = [];
  private lampsWanted = false;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.quality = quality;
    // Hard cap at 3. A 4th cascade buys distance nobody looks at and costs a
    // whole extra rasterisation of every shadow caster in the level.
    this.cascadeCount = clamp(quality.cascadeCount | 0, 1, 3);
    // Shadow distance is the single biggest lever on shadow cost: the far
    // cascade's ortho radius is ~1.3x shadowFar, and its draw set is every
    // caster inside that box. 180 m is well past where a kart shadow reads.
    this.shadowFar = quality.tier === 'low' ? 105
      : quality.tier === 'medium' ? 140
        : quality.tier === 'high' ? 165 : 180;
  }

  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;

    if (!chunksPatched) {
      chunksPatched = true;
      patchFogChunks();
    }

    this.group.name = 'Lighting';
    this.scene.add(this.group);

    // --- cascade splits ------------------------------------------------------
    const N = this.cascadeCount;
    const near = 1.0;
    const far = this.shadowFar;
    const lambda = 0.85;
    const splits: number[] = [0];
    for (let i = 1; i <= N; i++) {
      const log = near * Math.pow(far / near, i / N);
      const uni = near + (far - near) * (i / N);
      splits.push(lambda * log + (1 - lambda) * uni);
    }
    const bands: number[] = [0];
    for (let i = 1; i <= N; i++) bands.push((splits[i] - splits[i - 1]) * 0.14);

    patchCsmChunks(N, splits, bands);

    // --- one directional light per cascade -----------------------------------
    // Resolution costs fill, not draw calls. Spend it — but never above 2048,
    // beyond which the depth pass turns bandwidth-bound for no visible gain.
    const mapSize = clamp(this.quality.shadowMapSize, 512, 2048);
    const sizeFor = (_i: number): number => mapSize;
    // Redraw cadence. Cascade 0 must be every frame (it holds the kart's own
    // shadow); the outer boxes are hundreds of metres across so a stale frame
    // or two is invisible. This is a straight 2-3x cut in shadow rasterisation.
    const intervalFor = (i: number): number => (i === 0 ? 1 : i === 1 ? 2 : 3);

    for (let i = 0; i < N; i++) {
      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.name = `KeyCascade${i}`;
      light.castShadow = true;
      light.shadow.mapSize.set(sizeFor(i), sizeFor(i));
      // bias/normalBias are recomputed from the real texel size every frame in
      // `fitCascade` — a fixed bias is either acne or peter-panning depending
      // on which cascade you are looking at.
      light.shadow.bias = 0;
      light.shadow.normalBias = 0.02;
      // PCF filter radius, in shadow texels (r185 Vogel-disk sampler).
      light.shadow.radius = i === 0 ? 1.5 : i === 1 ? 2.0 : 2.5;
      light.shadow.intensity = 1;
      light.shadow.camera.up.set(0, 1, 0);
      light.target.position.set(0, 0, 0);
      // Cascade 0 keeps three's automatic per-frame update so shadows survive
      // even if `update()` is never pumped; the rest are driven by the stagger.
      light.shadow.autoUpdate = i === 0;
      light.shadow.needsUpdate = true;
      this.group.add(light);
      this.group.add(light.target);

      const { radius, centreDist } = frustumSphere(
        this.camera,
        Math.max(0.05, splits[i]),
        splits[i + 1],
      );
      this.cascades.push({
        light,
        near: splits[i],
        far: splits[i + 1],
        radius,
        centreDist,
        mapSize: sizeFor(i),
        interval: intervalFor(i),
      });
    }
    this.keyLight = this.cascades[0].light;

    // --- fills (added AFTER the cascades: three pairs shadow maps to the first
    //     N shadow-casting directional lights, so cascades must come first) ---
    //
    // There used to be a third fill here, a separate up-facing "ground bounce"
    // DirectionalLight. It has been folded into the hemisphere's ground term,
    // which is the same integral for a fraction of the cost: every extra
    // directional light is a full BRDF evaluation for every lit fragment, and
    // this scene is fragment-bound.
    this.hemi = new THREE.HemisphereLight(0x8fbdf2, 0x5d5747, 0.36);
    this.hemi.name = 'HemiFill';
    this.group.add(this.hemi);

    this.rim = new THREE.DirectionalLight(0xbcd8ff, 0.2);
    this.rim.name = 'CameraRim';
    this.rim.castShadow = false;
    this.group.add(this.rim);
    this.group.add(this.rim.target);

    // --- fog -----------------------------------------------------------------
    this.fog = new THREE.FogExp2(0x5c80b0, 0.00085);
    this.scene.fog = this.fog;
    worldFogUniforms.uFogHeight.value = FOG_HEIGHT;
    worldFogUniforms.uFogFalloff.value = FOG_FALLOFF;

    this.renderer.shadowMap.enabled = true;
    // PCF, not VSM. Two reasons, both measured:
    //  1. Under VSM three renders every *shadow-receiving* object into the
    //     shadow map as well as every caster (WebGLShadowMap.renderObject) —
    //     that dragged the terrain, the road and 2000 crowd instances into all
    //     of the cascades, and added two full-screen blur passes per cascade.
    //  2. VSM's Chebyshev bound needs a hand-tuned bias per cascade and light
    //     bleeds through thin geometry; PCF in r185 is a 5-tap Vogel disk on a
    //     hardware sampler2DShadow, which is both cheaper and predictable.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.installCascadeCulling();

    this.setPreset('day');
    worldRegistry.lighting = this;
  }

  // -------------------------------------------------------------------------
  //  Per-cascade visibility masking
  // -------------------------------------------------------------------------

  /**
   * Drive the cascades as separate shadow passes so each can carry its own
   * visibility mask. three renders all shadow lights in one internal loop and
   * tests object layers against the *view* camera, so there is no supported
   * hook for this; wrapping `shadowMap.render` is the only place to stand.
   */
  private installCascadeCulling(): void {
    if (this.cascades.length < 2) return;
    const sm = this.renderer.shadowMap as unknown as ShadowMapLike;
    const orig = sm.render.bind(sm);
    this.shadowMapHook = sm;
    this.shadowRenderOriginal = sm.render;

    const mine = new Set<THREE.Light>();
    for (const c of this.cascades) mine.add(c.light);
    const bucket: THREE.Light[] = [];

    sm.render = (lights, scene, camera): void => {
      if (!sm.enabled || (!sm.autoUpdate && !sm.needsUpdate) || lights.length === 0) {
        orig(lights, scene, camera);
        return;
      }
      const prevAuto = sm.autoUpdate;
      // Re-fit with the *final* camera pose for this frame (CameraRig runs
      // after us in the subsystem order, so `update()` saw a stale camera).
      if (camera === this.camera) this.fitCascades();
      // The first sub-pass clears the global needsUpdate flag, so force
      // autoUpdate on for the duration and let the per-shadow flags decide.
      sm.autoUpdate = true;
      try {
        for (let i = 0; i < this.cascades.length; i++) {
          const light = this.cascades[i].light;
          const shadow = light.shadow;
          if (!shadow.autoUpdate && !shadow.needsUpdate) continue;
          if (lights.indexOf(light) < 0) continue;
          bucket.length = 0;
          bucket.push(light);
          this.applyMask(i);
          orig(bucket, scene, camera);
        }
        this.applyMask(-1);
        bucket.length = 0;
        for (const l of lights) if (!mine.has(l)) bucket.push(l);
        if (bucket.length > 0) orig(bucket, scene, camera);
      } finally {
        this.applyMask(-1);
        sm.autoUpdate = prevAuto;
        sm.needsUpdate = false;
      }
    };
  }

  /** Hide everything that must not cast into cascade `index`. -1 restores. */
  private applyMask(index: number): void {
    if (index < 0) {
      if (!this.maskActive) return;
      const n = this.nearOnly.length;
      for (let i = 0; i < n; i++) this.nearOnly[i].visible = this.maskedWasVisible[i];
      for (let i = 0; i < this.midOnly.length; i++) {
        this.midOnly[i].visible = this.maskedWasVisible[n + i];
      }
      this.maskActive = false;
      return;
    }
    const n = this.nearOnly.length;
    if (n === 0 && this.midOnly.length === 0) return;
    if (!this.maskActive) {
      for (let i = 0; i < n; i++) this.maskedWasVisible[i] = this.nearOnly[i].visible;
      for (let i = 0; i < this.midOnly.length; i++) {
        this.maskedWasVisible[n + i] = this.midOnly[i].visible;
      }
      this.maskActive = true;
    }
    for (let i = 0; i < n; i++) {
      this.nearOnly[i].visible = index === 0 && this.maskedWasVisible[i];
    }
    for (let i = 0; i < this.midOnly.length; i++) {
      this.midOnly[i].visible = index <= 1 && this.maskedWasVisible[n + i];
    }
  }

  /**
   * Collect the tagged subtrees. Cheap enough to redo a couple of times a
   * second, which keeps it correct across track loads and prop streaming
   * without every producer having to notify us.
   */
  private rescanShadowMask(): void {
    this.nearOnly.length = 0;
    this.midOnly.length = 0;
    if (this.lampsWanted) this.emitters.length = 0;
    this.scene.traverse((o) => {
      if (o.layers.isEnabled(SHADOW_LAYER.NEAR_ONLY)) this.nearOnly.push(o);
      else if (o.layers.isEnabled(SHADOW_LAYER.MID_ONLY)) this.midOnly.push(o);
      if (this.lampsWanted) this.collectEmitters(o);
    });
    const total = this.nearOnly.length + this.midOnly.length;
    if (this.maskedWasVisible.length < total) this.maskedWasVisible.length = total;
  }

  // -------------------------------------------------------------------------
  //  Artificial light at night
  // -------------------------------------------------------------------------

  /**
   * Harvest one prop mesh's instances as light-source positions. The lamp head
   * is not at the instance origin (a floodlight mast anchors at its base, 22 m
   * below its heads), so the geometry's own bounding-sphere centre is used as
   * the local offset — that is where the emissive part actually sits, because
   * these meshes contain nothing but the glowing element.
   */
  private collectEmitters(o: THREE.Object3D): void {
    const mesh = o as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh || mesh.count <= 0) return;
    let cls = -1;
    for (let i = 0; i < NIGHT_EMITTERS.length; i++) {
      if (NIGHT_EMITTERS[i].match.test(mesh.name)) { cls = i; break; }
    }
    if (cls < 0) return;
    const geo = mesh.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const centre = geo.boundingSphere ? geo.boundingSphere.center : _local.set(0, 0, 0);
    // Bounded so a pathological prop set cannot make the per-frame nearest
    // search unbounded. 240 emitters is far more than any circuit authors.
    for (let i = 0; i < mesh.count && this.emitters.length < 240; i++) {
      mesh.getMatrixAt(i, _m4);
      _local.copy(centre).applyMatrix4(_m4).applyMatrix4(mesh.matrixWorld);
      this.emitters.push({ x: _local.x, y: _local.y, z: _local.z, cls });
    }
  }

  /** Build the pool on the first night preset. Never for `low`. */
  private ensureLampPool(): void {
    if (this.lampPool.length > 0) return;
    const n = this.quality.tier === 'low' ? 0
      : this.quality.tier === 'medium' ? 3
        : this.quality.tier === 'high' ? 5 : 6;
    if (n === 0) return;
    // Adding a light changes NUM_POINT_LIGHTS, which recompiles every material
    // in the scene. So the pool is built once, on the first night preset, and
    // then *kept* — daylight presets zero its intensity rather than removing it,
    // because a second recompile mid-session is a visible hitch.
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 40, 2);
      l.name = `NightLamp${i}`;
      l.castShadow = false;
      this.group.add(l);
      this.lampPool.push(l);
    }
    this.markShadowMaskDirty();
  }

  /**
   * Point the pool at the nearest emitters. O(emitters x pool) with both small,
   * and allocation-free.
   */
  private updateLamps(): void {
    const pool = this.lampPool;
    if (pool.length === 0) return;
    if (!this.lampsWanted || this.emitters.length === 0) {
      for (const l of pool) l.intensity = 0;
      return;
    }
    const cam = this.camera.position;
    for (let k = 0; k < pool.length; k++) {
      let best = -1;
      let bestScore = 0;
      let bestD = 0;
      for (let e = 0; e < this.emitters.length; e++) {
        const em = this.emitters[e];
        if (em.cls < 0) continue;
        const dx = em.x - cam.x;
        const dy = em.y - cam.y;
        const dz = em.z - cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > EMITTER_CULL * EMITTER_CULL) continue;
        // Rank by the irradiance the source actually delivers here, not by
        // distance: a mast at 60 m matters more than a shopfront at 20 m, and a
        // nearest-first pool would spend all six slots on the shopfronts.
        const score = NIGHT_EMITTERS[em.cls].intensity / Math.max(d2, 1);
        if (score > bestScore) { bestScore = score; bestD = d2; best = e; }
      }
      const l = pool[k];
      if (best < 0) { l.intensity = 0; continue; }
      const em = this.emitters[best];
      const c = NIGHT_EMITTERS[em.cls];
      l.position.set(em.x, em.y, em.z);
      l.color.setHex(c.color);
      l.distance = c.range;
      // Fade the last 30 m of the cull radius so a lamp entering the set does
      // not pop a pool of light into existence.
      const d = Math.sqrt(bestD);
      l.intensity = c.intensity * clamp01((EMITTER_CULL - d) / 30);
      // Claim it so the next pool slot picks a different source.
      em.cls = -1 - em.cls;
    }
    // Un-claim for the next frame.
    for (const em of this.emitters) if (em.cls < 0) em.cls = -1 - em.cls;
  }

  setSky(sky: Sky): void {
    this.sky = sky;
    sky.currentCamera = this.camera;
    this.setPreset(sky.presetName);
  }

  // -------------------------------------------------------------------------

  setPreset(name: string): void {
    const key = (name in SKY_PRESETS ? name : 'day') as SkyPresetName;
    const p = SKY_PRESETS[key];
    this.presetName = key;

    this.baseKeyIntensity = p.keyIntensity;
    this.baseAmbient = p.ambientIntensity;

    for (const c of this.cascades) {
      c.light.color.setHex(p.keyColor);
      c.light.intensity = p.keyIntensity;
      c.light.shadow.intensity = p.shadowIntensity;
    }
    if (this.hemi) {
      this.hemi.color.setHex(p.skyAmbient);
      // The old separate ground-bounce light lives here now: the hemisphere's
      // lower lobe is exactly that integral, so blend the bounce hue in
      // proportional to how strong the bounce used to be.
      this.hemi.groundColor.setHex(p.groundAmbient);
      _tmpColor.setHex(p.bounceColor);
      this.hemi.groundColor.lerp(_tmpColor, clamp01(p.bounceIntensity * 0.6));
      this.hemi.intensity = p.ambientIntensity;
    }
    if (this.rim) {
      this.rim.color.setHex(p.rimColor);
      this.rim.intensity = p.rimIntensity;
    }
    if (this.fog) {
      this.fog.color.setHex(p.fogColor);
      this.fog.density = p.fogDensity;
    }

    worldFogUniforms.uFogColor.value.setHex(p.fogColor);
    worldFogUniforms.uFogSunColor.value.setHex(p.fogSunColor);
    worldFogUniforms.uFogDensity.value = p.fogDensity;
    worldSunUniforms.uSunColor.value.setHex(p.keyColor);
    worldSunUniforms.uSunIntensity.value = p.keyIntensity;
    worldSunUniforms.uAmbientSky.value.setHex(p.skyAmbient);
    worldSunUniforms.uAmbientGround.value.setHex(p.groundAmbient);
    // Custom shaders that use these get no IBL, so they read the hemisphere
    // term straight rather than the 0.62 fudge the old fat ambient needed.
    worldSunUniforms.uAmbientIntensity.value = p.ambientIntensity;

    // Night is the only preset with artificial light. Build the pool the first
    // time one is selected; other presets just zero it (see ensureLampPool).
    this.lampsWanted = p.night > 0.5 || p.cityGlow >= 0.5;
    if (this.lampsWanted) {
      this.ensureLampPool();
      this.markShadowMaskDirty();
    } else {
      for (const l of this.lampPool) l.intensity = 0;
    }

    if (this.sky && this.sky.presetName !== key) this.sky.setPreset(key);
    this.syncSunDirection();
  }

  private syncSunDirection(): void {
    const dir = this.sky ? this.sky.keyDirection : _v.set(0.4, 0.7, 0.55).normalize();
    worldFogUniforms.uSunDirection.value.copy(dir);
  }

  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    if (!this.initialised) return;
    const cam = this.camera;
    const sky = this.sky;
    this.frame++;

    // Refresh the cascade-mask lists a couple of times a second so props and
    // foliage that stream in start being excluded without notifying us.
    this.maskScanTimer += ctx.dt;
    if (this.maskScanTimer > 0.45) {
      this.maskScanTimer = 0;
      this.rescanShadowMask();
    }

    const sunDir = sky ? sky.keyDirection : _v.set(0.4, 0.7, 0.55).normalize();
    worldFogUniforms.uSunDirection.value.copy(sunDir);

    // --- lightning: pop the key + wash the fog -------------------------------
    const strike = sky ? sky.lightningFlash : 0;
    this.flash = strike > this.flash ? strike : damp(this.flash, strike, 0.05, ctx.dt);
    const f = this.flash;
    if (f > 0.001) {
      const boost = 1 + f * 5.5;
      for (const c of this.cascades) c.light.intensity = this.baseKeyIntensity * boost;
      this.hemi.intensity = this.baseAmbient * (1 + f * 2.6);
      _tmpColor.setHex(SKY_PRESETS[this.presetName].fogColor);
      this.fog.color.copy(_tmpColor).lerp(_tmpColor.clone().setRGB(0.78, 0.84, 1.0), clamp01(f * 0.75));
      worldFogUniforms.uFogColor.value.copy(this.fog.color);
    } else if (this.hemi.intensity !== this.baseAmbient) {
      for (const c of this.cascades) c.light.intensity = this.baseKeyIntensity;
      this.hemi.intensity = this.baseAmbient;
      this.fog.color.setHex(SKY_PRESETS[this.presetName].fogColor);
      worldFogUniforms.uFogColor.value.copy(this.fog.color);
    }

    this.fitCascades();
    this.updateLamps();

    // --- fills ---------------------------------------------------------------
    // Rim: perpendicular to the view, opposite the sun, slightly above.
    cam.getWorldDirection(_fwd);
    const camPos = cam.position;
    _camRight.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const side = _camRight.dot(sunDir) > 0 ? -1 : 1;
    _rimDir.copy(_camRight).multiplyScalar(side).addScaledVector(_fwd, -0.55);
    _rimDir.y += 0.45;
    _rimDir.normalize();
    this.rim.position.copy(camPos).addScaledVector(_rimDir, 60);
    this.rim.target.position.copy(camPos);
  }

  /**
   * Fit each due cascade's ortho to its frustum-slice bounding sphere.
   *
   * Called from `update()` and again from the shadow hook immediately before
   * the depth passes run. The second call is the one that matters: Game orders
   * CameraRig *after* Lighting, so at `update()` time `camera` still holds last
   * frame's pose and the cascades would trail the view by a frame.
   */
  private fitCascades(): void {
    const sky = this.sky;
    const sunDir = sky ? sky.keyDirection : _v.set(0.4, 0.7, 0.55).normalize();

    // The split distances are baked into the shader as literals, so the ortho
    // radii have to track the real frustum or fragments inside a cascade's
    // depth range fall outside its box and silently lose their shadow. Don't
    // trust `resize()` alone — recompute whenever the projection actually moves.
    const shape = this.camera.aspect * 1000 + this.camera.fov;
    if (shape !== this.lastCameraShape) {
      this.lastCameraShape = shape;
      this.refreshCascadeRadii();
    }

    // Light-space basis. Pick an up axis that is never parallel to the sun.
    _lz.copy(sunDir).normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_lz.y) > 0.985) _up.set(0, 0, -1);
    _lx.copy(_up).cross(_lz).normalize();
    _ly.copy(_lz).cross(_lx).normalize();

    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    const camPos = cam.position;

    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      // Only re-fit a cascade on the frame it will actually redraw. Moving the
      // ortho without redrawing would slide the stale depth map off the world.
      const due = i === 0 || this.frame % c.interval === 0;
      if (!due) { c.light.shadow.needsUpdate = false; continue; }
      c.light.shadow.needsUpdate = true;

      // Sphere centre on the view axis — rotation invariant, so the ortho box
      // never changes size and shadows never shimmer as you turn.
      _centre.copy(camPos).addScaledVector(_fwd, c.centreDist);

      // Snap the centre to whole shadow texels in light space.
      const texel = (c.radius * 2) / c.mapSize;
      const cx = Math.round(_centre.dot(_lx) / texel) * texel;
      const cy = Math.round(_centre.dot(_ly) / texel) * texel;
      const cz = _centre.dot(_lz);
      _centre.set(0, 0, 0)
        .addScaledVector(_lx, cx)
        .addScaledVector(_ly, cy)
        .addScaledVector(_lz, cz);

      // Keep the ortho depth range tight. The old +160 m stand-off spread the
      // depth buffer over 1.2 km for a 40 m box, which is what made the bias
      // impossible to tune. The margin only has to clear the tallest caster
      // standing above the slice — grandstands and gantries, not mountains.
      const margin = clamp(c.radius * 0.9, 55, 140);
      const back = c.radius + margin;
      c.light.target.position.copy(_centre);
      c.light.position.copy(_centre).addScaledVector(_lz, back);
      c.light.shadow.camera.up.copy(_up);
      // three reads the light's world matrix inside the shadow pass, so it has
      // to be current *now* — this method can run after the scene graph has
      // already been flushed for the frame.
      c.light.updateMatrixWorld(true);
      c.light.target.updateMatrixWorld(true);

      const sc = c.light.shadow.camera;
      if (sc.left !== -c.radius) {
        sc.left = -c.radius;
        sc.right = c.radius;
        sc.top = c.radius;
        sc.bottom = -c.radius;
      }
      sc.near = 1;
      sc.far = back + c.radius + 40;
      sc.updateProjectionMatrix();

      // Bias derived from the real texel footprint. normalBias is metres along
      // the surface normal; bias is normalised ortho depth, so a world-space
      // slop has to be divided by the depth range to mean anything.
      const sh = c.light.shadow;
      sh.normalBias = Math.min(1.2, texel * 1.6 + 0.012);
      sh.bias = -(texel * 0.8 + 0.015) / (sc.far - sc.near);
    }
  }

  /**
   * Call after adding or removing geometry tagged with a `SHADOW_LAYER` bit if
   * you need the mask to pick it up before the next periodic rescan.
   */
  markShadowMaskDirty(): void {
    this.maskScanTimer = 1e9;
  }

  /** Cascade state, for QA. */
  shadowDebug(): Array<Record<string, number | boolean>> {
    return this.cascades.map((c, i) => ({
      cascade: i,
      radius: +c.radius.toFixed(1),
      texel: +((c.radius * 2) / c.mapSize).toFixed(4),
      mapSize: c.mapSize,
      interval: c.interval,
      fitted: c.light.shadow.camera.left === -c.radius,
      hasMap: !!c.light.shadow.map,
      normalBias: +c.light.shadow.normalBias.toFixed(4),
      bias: c.light.shadow.bias,
      near: c.light.shadow.camera.near,
      far: +c.light.shadow.camera.far.toFixed(1),
      maskedNear: this.nearOnly.length,
      maskedMid: this.midOnly.length,
    }));
  }

  /** Nudge the shadow distance at runtime (e.g. an in-race quality drop). */
  setShadowFar(distance: number): void {
    this.shadowFar = distance;
    const N = this.cascadeCount;
    const near = 1;
    const lambda = 0.85;
    for (let i = 0; i < N; i++) {
      const s0 = i === 0 ? 0.05 : lambda * near * Math.pow(distance / near, i / N)
        + (1 - lambda) * (near + (distance - near) * (i / N));
      const s1 = lambda * near * Math.pow(distance / near, (i + 1) / N)
        + (1 - lambda) * (near + (distance - near) * ((i + 1) / N));
      const { radius, centreDist } = frustumSphere(this.camera, s0, s1);
      this.cascades[i].radius = radius;
      this.cascades[i].centreDist = centreDist;
      this.cascades[i].near = s0;
      this.cascades[i].far = s1;
    }
  }

  resize(): void {
    this.refreshCascadeRadii();
  }

  private refreshCascadeRadii(): void {
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      const { radius, centreDist } = frustumSphere(this.camera, Math.max(0.05, c.near), c.far);
      c.radius = radius;
      c.centreDist = centreDist;
    }
  }

  dispose(): void {
    if (this.shadowMapHook && this.shadowRenderOriginal) {
      this.shadowMapHook.render = this.shadowRenderOriginal;
      this.shadowMapHook = null;
      this.shadowRenderOriginal = null;
    }
    for (const c of this.cascades) {
      c.light.shadow.map?.dispose();
      c.light.dispose();
    }
    this.cascades.length = 0;
    this.nearOnly.length = 0;
    this.midOnly.length = 0;
    for (const l of this.lampPool) { this.group.remove(l); l.dispose(); }
    this.lampPool.length = 0;
    this.emitters.length = 0;
    this.hemi?.dispose();
    this.rim?.dispose();
    this.scene.remove(this.group);
    if (this.scene.fog === this.fog) this.scene.fog = null;
  }
}

/**
 * Bounding sphere of a symmetric perspective frustum slice.
 * Rotation invariant, so the fitted ortho box is a constant size — the single
 * most important trick for shadows that don't shimmer.
 */
function frustumSphere(
  camera: THREE.PerspectiveCamera, near: number, far: number,
): { radius: number; centreDist: number } {
  const halfV = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
  const k2 = (1 + camera.aspect * camera.aspect) * halfV * halfV;
  if (k2 >= (far - near) / (far + near)) {
    return { radius: far * Math.sqrt(k2), centreDist: far };
  }
  const centre = 0.5 * (far + near) * (1 + k2);
  const radius = 0.5 * Math.sqrt(
    (far - near) * (far - near) +
    2 * (far * far + near * near) * k2 +
    (far + near) * (far + near) * k2 * k2,
  );
  return { radius, centreDist: centre };
}
