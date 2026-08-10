/**
 * ============================================================================
 *  APEX KART — WEATHER
 * ============================================================================
 *  Rain, snow, volcanic ash and embers, drifting leaves, and heat shimmer.
 *
 *  Every particle system is the same shape: one InstancedMesh of quads that
 *  lives in a box locked to the camera, with the *entire* simulation in the
 *  vertex shader — position is `hash(seed)` scrolled by time and wrapped with
 *  `mod`, so a thousand snowflakes cost one draw call, one uniform write per
 *  frame and zero allocations, forever. Particles that need ground contact
 *  (rain splashes) read the terrain field height texture directly.
 *
 *  Rain additionally:
 *    · overrides the road's roughness so wet asphalt goes mirror-dark, storing
 *      and restoring the original values (never mutates anything permanently)
 *    · runs screen droplets on a quad pinned in front of the camera
 *    · spawns ground splash rings at the terrain surface
 *
 *  Every group is flagged `userData.noReflect`, so Water's planar pass skips it.
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings } from '@/core/Types';
import { LAYERS, RENDER_ORDER } from '@/core/Config';
import { clamp, clamp01, damp } from '@/core/MathUtils';
import { SHADOW_LAYER } from './Lighting';
import {
  GLSL_FIELD, GLSL_NOISE,
  fieldUniforms,
  type TerrainField, type WorldContext, type WorldTheme,
  worldFogUniforms, worldSunUniforms,
} from './WorldTextures';

export type WeatherName = 'clear' | 'rain' | 'storm' | 'snow' | 'ash' | 'leaves' | 'shimmer';

const BUDGET_FOR_TIER: Record<string, number> = {
  low: 0.3, medium: 0.55, high: 0.8, ultra: 1.0,
};

// ---------------------------------------------------------------------------
// Shared particle GLSL
// ---------------------------------------------------------------------------

/**
 * The whole simulation. `aSeed` gives a particle its slot in the box; time
 * scrolls it and `mod` wraps it, so nothing is ever respawned on the CPU.
 *
 * `uMode`: 0 rain streak, 1 flake (snow), 2 ash, 3 ember, 4 leaf.
 */
const GLSL_PARTICLE = /* glsl */ `
attribute vec3 aSeed;
attribute vec2 aCorner;
uniform float uTime;
uniform vec3 uBox;          // half-extents of the follow box
uniform vec3 uCamPos;
uniform vec2 uWindDir;
uniform float uWind;
uniform float uFall;        // metres/second
uniform float uSize;
uniform float uMode;
uniform float uAmount;      // 0..1 fraction of particles alive
uniform mat4 uCamMatrix;    // camera world matrix, for billboarding

varying float vFade;
varying vec2 vUv;
varying float vFlicker;

float ph1(float n){ return fract(sin(n * 78.233) * 43758.5453); }

void main(){
  vUv = aCorner + 0.5;

  // Cull the tail of the buffer when the storm eases off.
  float alive = step(aSeed.z, uAmount);

  float span = uBox.y * 2.0;
  float speed = uFall * (0.7 + aSeed.z * 0.6);
  float drift = uWind * 6.0;

  // Base slot in the box, scrolled and wrapped.
  vec3 p;
  p.x = (aSeed.x - 0.5) * uBox.x * 2.0;
  p.z = (aSeed.y - 0.5) * uBox.z * 2.0;
  float t = uTime;

  // Embers rise; everything else falls. Both wrap through the same box, so the
  // edge fades below stay correct either way.
  bool rising = uMode > 2.5 && uMode < 3.5;
  float y = rising
    ? mod(aSeed.z * span + t * speed * 0.55, span)
    : mod(aSeed.z * span + span - t * speed, span);
  p.y = y - uBox.y;

  // Lateral motion: rain is nearly straight, snow and leaves swirl.
  float swirlAmp = uMode < 0.5 ? 0.0 : (uMode < 2.5 ? 1.4 : 2.6);
  float sp = aSeed.x * 31.4 + aSeed.y * 17.7;
  p.x += uWindDir.x * (drift * (span - y) / max(speed, 0.5)) + sin(t * 0.9 + sp) * swirlAmp;
  p.z += uWindDir.y * (drift * (span - y) / max(speed, 0.5)) + cos(t * 0.7 + sp * 1.3) * swirlAmp;

  // Wrap into the box that follows the camera.
  vec3 origin = uCamPos;
  p.x = mod(p.x - origin.x + uBox.x, uBox.x * 2.0) + origin.x - uBox.x;
  p.z = mod(p.z - origin.z + uBox.z, uBox.z * 2.0) + origin.z - uBox.z;
  p.y += origin.y;

  // --- billboard ------------------------------------------------------------
  vec3 right = normalize(vec3(uCamMatrix[0][0], uCamMatrix[0][1], uCamMatrix[0][2]));
  vec3 up    = normalize(vec3(uCamMatrix[1][0], uCamMatrix[1][1], uCamMatrix[1][2]));

  float size = uSize * (0.6 + aSeed.z * 0.8);
  vec3 offset;
  if (uMode < 0.5) {
    // Rain: a ~1.5 m streak along gravity + wind, a couple of centimetres wide.
    vec3 dir = normalize(vec3(uWindDir.x * drift * 0.12, -1.0, uWindDir.y * drift * 0.12));
    vec3 toCam = uCamPos - p;
    vec3 across = cross(dir, normalize(toCam + vec3(1e-4)));
    across = length(across) > 1e-4 ? normalize(across) : right;
    offset = across * (aCorner.x * size * 0.05) + dir * (aCorner.y * size * 1.7);
  } else if (uMode > 3.5) {
    // Leaves tumble: spin the quad about its own axis.
    float a = t * (1.1 + aSeed.x * 2.2) + sp;
    vec2 r = vec2(cos(a), sin(a));
    vec2 c = vec2(aCorner.x * r.x - aCorner.y * r.y, aCorner.x * r.y + aCorner.y * r.x);
    offset = right * (c.x * size) + up * (c.y * size);
  } else {
    offset = right * (aCorner.x * size) + up * (aCorner.y * size);
  }

  vec3 world = p + offset;

  // Fade at the box edges so nothing pops, and out at grazing distance.
  float dist = length(p.xz - origin.xz);
  vFade = alive * (1.0 - smoothstep(uBox.x * 0.55, uBox.x * 0.98, dist));
  vFade *= smoothstep(0.0, uBox.y * 0.12, y) * (1.0 - smoothstep(span * 0.86, span, y));
  vFlicker = ph1(aSeed.x * 13.1 + aSeed.y * 7.7);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

interface ParticleSpec {
  count: number;
  box: THREE.Vector3;
  fall: number;
  size: number;
  mode: number;
  color: number;
  /** HDR multiplier — embers need to bloom. */
  intensity: number;
  additive: boolean;
  /** 0 = hard dot, 1 = soft blob, 2 = leaf shape. */
  shape: number;
  opacity: number;
}

// ---------------------------------------------------------------------------

interface System {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
  spec: ParticleSpec;
}

interface RoadOverride {
  material: THREE.MeshStandardMaterial;
  roughness: number;
  metalness: number;
  envMapIntensity: number;
}

export class Weather implements ISubsystem {
  readonly group = new THREE.Group();
  preset: WeatherName = 'clear';
  camera: THREE.PerspectiveCamera | null = null;

  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private ctx: WorldContext;
  private quality: QualitySettings;
  private field: TerrainField;

  private systems = new Map<string, System>();
  private splash: System | null = null;
  private droplets: THREE.Mesh | null = null;
  private dropletMat: THREE.ShaderMaterial | null = null;
  private shimmer: THREE.Mesh | null = null;
  private shimmerMat: THREE.ShaderMaterial | null = null;

  private roadGroup: THREE.Object3D | null = null;
  private roadOverrides: RoadOverride[] = [];
  private roadWet = false;

  private uTime = { value: 0 };
  private uCamPos = { value: new THREE.Vector3() };
  private uCamMatrix = { value: new THREE.Matrix4() };
  private uWindDir = { value: new THREE.Vector2(0.86, 0.51) };
  private uWind = { value: 0.24 };

  /** 0..1 — how wet the world currently looks. Ramps, never snaps. */
  wetness = 0;
  private wetTarget = 0;
  private budget: number;
  private time = 0;

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
    this.budget = BUDGET_FOR_TIER[quality.tier] ?? 0.8;
  }

  async init(): Promise<void> {
    this.group.name = 'Weather';
    // Weather must not appear in the water's planar reflection.
    this.group.userData.noReflect = true;
    this.group.renderOrder = RENDER_ORDER.PARTICLE_ADDITIVE;
    // Nothing in here casts, but tag the root anyway: Lighting hides tagged
    // subtrees when it renders the mid and far cascades, so this guarantees
    // weather can never leak into a shadow map if a spec ever flips castShadow.
    this.group.layers.enable(SHADOW_LAYER.NEAR_ONLY);
    this.scene.add(this.group);
  }

  setRoadGroup(group: THREE.Object3D | null): void {
    this.roadGroup = group;
    if (this.roadWet && group) this.applyWetRoad(true);
  }

  setCamera(camera: THREE.PerspectiveCamera): void {
    if (camera && camera.isPerspectiveCamera) this.camera = camera;
  }

  setWind(strength: number, dirRadians: number): void {
    this.uWind.value = strength;
    this.uWindDir.value.set(Math.cos(dirRadians), Math.sin(dirRadians)).normalize();
  }

  // =========================================================================
  // PRESETS
  // =========================================================================

  setPreset(name: WeatherName | WorldTheme): void {
    const preset = normalise(name);
    if (preset === this.preset) return;
    this.preset = preset;

    this.clearSystems();
    const b = this.budget;
    const budget = Math.max(120, Math.round(this.quality.particleBudget * 0.22));

    switch (preset) {
      case 'rain':
      case 'storm': {
        const heavy = preset === 'storm';
        this.addSystem('rain', {
          count: Math.round(Math.min(budget, 2600) * b * (heavy ? 1.25 : 1)),
          box: new THREE.Vector3(46, 26, 46),
          fall: heavy ? 26 : 20, size: 0.9, mode: 0,
          color: 0xc8d8e8, intensity: 1.1, additive: true, shape: 0,
          opacity: heavy ? 0.42 : 0.3,
        });
        this.addSplashes(Math.round(Math.min(420, budget * 0.3) * b));
        this.addDroplets();
        this.wetTarget = heavy ? 1 : 0.82;
        this.applyWetRoad(true);
        break;
      }
      case 'snow':
        this.addSystem('snow', {
          count: Math.round(Math.min(budget, 2200) * b),
          box: new THREE.Vector3(52, 30, 52),
          fall: 2.4, size: 0.095, mode: 1,
          color: 0xf4f8ff, intensity: 1.35, additive: false, shape: 1,
          opacity: 0.92,
        });
        this.wetTarget = 0.18;
        break;
      case 'ash':
        this.addSystem('ash', {
          count: Math.round(Math.min(budget, 1800) * b),
          box: new THREE.Vector3(56, 34, 56),
          fall: 1.9, size: 0.13, mode: 2,
          color: 0x6a6058, intensity: 0.55, additive: false, shape: 1,
          opacity: 0.6,
        });
        this.addSystem('ember', {
          count: Math.round(Math.min(700, budget * 0.45) * b),
          box: new THREE.Vector3(44, 22, 44),
          fall: 5.5, size: 0.075, mode: 3,
          color: 0xff7a26, intensity: 5.5, additive: true, shape: 1,
          opacity: 1,
        });
        this.addShimmer();
        this.wetTarget = 0;
        break;
      case 'leaves':
        this.addSystem('leaves', {
          count: Math.round(Math.min(620, budget * 0.4) * b),
          box: new THREE.Vector3(40, 22, 40),
          fall: 1.5, size: 0.2, mode: 4,
          color: 0xc8a03c, intensity: 1.0, additive: false, shape: 2,
          opacity: 0.95,
        });
        this.wetTarget = 0;
        break;
      case 'shimmer':
        this.addShimmer();
        this.wetTarget = 0;
        break;
      default:
        this.wetTarget = 0;
        break;
    }

    if (preset !== 'rain' && preset !== 'storm') this.applyWetRoad(false);
  }

  // =========================================================================
  // SYSTEM CONSTRUCTION
  // =========================================================================

  private particleGeometry(count: number): THREE.BufferGeometry {
    // One quad each, expanded in the shader. An InstancedBufferGeometry with a
    // 4-vertex base would halve the buffer, but a plain interleaved quad soup
    // avoids a second attribute divisor path in the same shader as the terrain
    // field lookups — simpler, and the vertex count is trivial either way.
    const g = new THREE.BufferGeometry();
    const seeds = new Float32Array(count * 4 * 3);
    const corners = new Float32Array(count * 4 * 2);
    const index = new Uint32Array(count * 6);
    const CO = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
    for (let i = 0; i < count; i++) {
      const sx = Math.random(), sy = Math.random(), sz = Math.random();
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        seeds[v * 3] = sx; seeds[v * 3 + 1] = sy; seeds[v * 3 + 2] = sz;
        corners[v * 2] = CO[k * 2]; corners[v * 2 + 1] = CO[k * 2 + 1];
      }
      const b = i * 4;
      const o = i * 6;
      index[o] = b; index[o + 1] = b + 1; index[o + 2] = b + 2;
      index[o + 3] = b; index[o + 4] = b + 2; index[o + 5] = b + 3;
    }
    // `position` is required by three's bookkeeping even though we ignore it.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }

  private addSystem(key: string, spec: ParticleSpec): void {
    if (spec.count <= 0) return;
    const geometry = this.particleGeometry(spec.count);

    const material = new THREE.ShaderMaterial({
      name: `weather-${key}`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: spec.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uTime: this.uTime,
        uCamPos: this.uCamPos,
        uCamMatrix: this.uCamMatrix,
        uWindDir: this.uWindDir,
        uWind: this.uWind,
        uBox: { value: spec.box },
        uFall: { value: spec.fall },
        uSize: { value: spec.size },
        uMode: { value: spec.mode },
        uAmount: { value: 1 },
        uColor: { value: new THREE.Color(spec.color) },
        uIntensity: { value: spec.intensity },
        uOpacity: { value: spec.opacity },
        uShape: { value: spec.shape },
        uSunColor: worldSunUniforms.uSunColor,
        uFogColor: worldFogUniforms.uFogColor,
      },
      vertexShader: GLSL_PARTICLE,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uOpacity;
        uniform float uShape;
        uniform float uMode;
        uniform float uTime;
        uniform vec3 uSunColor;
        uniform vec3 uFogColor;
        varying float vFade;
        varying vec2 vUv;
        varying float vFlicker;

        void main(){
          if (vFade <= 0.001) discard;
          vec2 p = vUv * 2.0 - 1.0;
          float a = 1.0;
          if (uShape < 0.5) {
            // Rain streak: bright core, soft shoulders.
            a = 1.0 - abs(p.x);
            a *= smoothstep(1.0, 0.25, abs(p.y));
          } else if (uShape < 1.5) {
            float r = length(p);
            a = 1.0 - smoothstep(0.15, 1.0, r);
          } else {
            // Leaf: a rounded lozenge.
            float r = length(vec2(p.x * 1.9, p.y));
            a = 1.0 - smoothstep(0.55, 1.0, r);
          }
          if (a <= 0.003) discard;

          vec3 col = uColor * uIntensity;
          if (uMode > 2.5 && uMode < 3.5) {
            // Embers pulse and cool as they rise.
            float pulse = 0.55 + 0.45 * sin(uTime * (6.0 + vFlicker * 9.0) + vFlicker * 30.0);
            col *= pulse;
            col = mix(col, col * vec3(1.0, 0.45, 0.18), 1.0 - vUv.y);
          } else if (uShape > 0.5 && uMode < 2.5) {
            // Snow catches the key light on one side.
            col = mix(col, uSunColor * uIntensity, 0.28) * (0.75 + vFlicker * 0.45);
          } else if (uMode > 1.5 && uMode < 2.5) {
            col = mix(col, uFogColor, 0.35);
          } else if (uMode > 3.5) {
            // Leaves come in autumn variations.
            col *= mix(vec3(1.0, 0.72, 0.3), vec3(0.85, 1.0, 0.55), vFlicker);
          }

          gl_FragColor = vec4(col, a * vFade * uOpacity);
        }
      `,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Weather:${key}`;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = spec.additive
      ? RENDER_ORDER.PARTICLE_ADDITIVE : RENDER_ORDER.PARTICLE_OPAQUE;
    if (spec.intensity > 1.5) mesh.layers.enable(LAYERS.BLOOM);
    this.group.add(mesh);
    this.systems.set(key, { mesh, material, geometry, spec });
  }

  /** Ground splash rings — they sit on the terrain via the height texture. */
  private addSplashes(count: number): void {
    if (count <= 0) return;
    const geometry = this.particleGeometry(count);
    const material = new THREE.ShaderMaterial({
      name: 'weather-splash',
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: {
        ...fieldUniforms(this.field),
        uTime: this.uTime,
        uCamPos: this.uCamPos,
        uBox: { value: new THREE.Vector3(24, 1, 24) },
        uWaterLevel: { value: this.ctx.waterLevel },
      },
      vertexShader: /* glsl */ `
        ${GLSL_FIELD}
        attribute vec3 aSeed;
        attribute vec2 aCorner;
        uniform float uTime;
        uniform vec3 uBox;
        uniform vec3 uCamPos;
        varying float vLife;
        varying vec2 vUv;
        void main(){
          vUv = aCorner + 0.5;
          // Each splash lives 0.42 s then restarts somewhere new.
          float period = 0.42;
          float cyc = floor(uTime / period + aSeed.z * 7.0);
          vLife = fract(uTime / period + aSeed.z * 7.0);
          vec2 jitter = vec2(fract(sin(cyc * 12.9 + aSeed.x * 71.3) * 43758.5),
                             fract(sin(cyc * 45.7 + aSeed.y * 17.1) * 24634.7));
          vec2 xz = uCamPos.xz + (jitter - 0.5) * uBox.xz * 2.0;
          float h = fieldHeight(xz);
          float r = 0.06 + vLife * 0.6;
          vec3 world = vec3(xz.x + aCorner.x * r, h + 0.035, xz.y + aCorner.y * r);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying float vLife;
        varying vec2 vUv;
        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          // Expanding ring that thins as it grows.
          float ring = smoothstep(0.55, 0.92, r) * (1.0 - smoothstep(0.92, 1.0, r));
          float a = ring * (1.0 - vLife) * 0.55;
          if (a <= 0.004) discard;
          gl_FragColor = vec4(vec3(0.82, 0.88, 0.94), a);
        }
      `,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'Weather:splash';
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER.PARTICLE_OPAQUE;
    this.group.add(mesh);
    this.splash = {
      mesh, material, geometry,
      spec: {
        count, box: new THREE.Vector3(24, 1, 24), fall: 0, size: 0, mode: 5,
        color: 0xffffff, intensity: 1, additive: false, shape: 1, opacity: 0.5,
      },
    };
  }

  /**
   * Screen droplets: a quad pinned just in front of the camera. Beads sit still,
   * grow, then trickle down — the giveaway that a windscreen is being rained on.
   */
  private addDroplets(): void {
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      name: 'weather-droplets',
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTime: this.uTime,
        uAmount: { value: 0 },
        uFogColor: worldFogUniforms.uFogColor,
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GLSL_NOISE}
        uniform float uTime;
        uniform float uAmount;
        uniform vec3 uFogColor;
        varying vec2 vUv;

        float bead(vec2 uv, float scale, float speed, float seed){
          vec2 p = uv * scale;
          // Trickle: each column slides at its own rate.
          float col = floor(p.x);
          float slide = uTime * speed * (0.4 + hash12(vec2(col, seed)));
          p.y += slide;
          vec2 cell = floor(p);
          vec2 f = fract(p) - 0.5;
          float h = hash12(cell + seed);
          if (h < 0.62) return 0.0;
          float r = length(f * vec2(1.0, 0.72)) / (0.16 + h * 0.26);
          return (1.0 - smoothstep(0.55, 1.0, r)) * (0.4 + h * 0.6);
        }

        void main(){
          if (uAmount <= 0.002) discard;
          float d = bead(vUv, 14.0, 0.09, 3.1)
                  + bead(vUv, 26.0, 0.16, 11.7) * 0.7
                  + bead(vUv, 42.0, 0.05, 27.3) * 0.45;
          d = clamp(d, 0.0, 1.0);
          // Beads refract the sky, so tint them with the fog colour and
          // brighten their rims.
          float rim = pow(d, 3.0);
          vec3 col = mix(uFogColor * 1.15, vec3(1.0), rim * 0.5);
          // Thicker near the screen edges where airflow can't clear them.
          float edge = 0.55 + 0.45 * length(vUv - 0.5) * 1.6;
          gl_FragColor = vec4(col, d * uAmount * 0.42 * edge);
        }
      `,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'Weather:droplets';
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER.UI3D;
    this.group.add(mesh);
    this.droplets = mesh;
    this.dropletMat = material;
  }

  /** Heat shimmer: additive haze whose noise field warps vertically. */
  private addShimmer(): void {
    if (this.shimmer) return;
    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    const material = new THREE.ShaderMaterial({
      name: 'weather-shimmer',
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        ...fieldUniforms(this.field),
        uTime: this.uTime,
        uCamPos: this.uCamPos,
        uCamMatrix: this.uCamMatrix,
        uWaterLevel: { value: this.ctx.waterLevel },
        uTint: { value: new THREE.Color(0xff7a3a) },
      },
      vertexShader: /* glsl */ `
        ${GLSL_FIELD}
        uniform vec3 uCamPos;
        uniform mat4 uCamMatrix;
        uniform float uWaterLevel;
        varying vec3 vWorld;
        varying vec2 vUv;
        void main(){
          vUv = uv;
          // A big billboard hugging the camera; it only shows where the ground
          // beneath it is at or below the lava surface.
          vec3 right = normalize(vec3(uCamMatrix[0][0], uCamMatrix[0][1], uCamMatrix[0][2]));
          vec3 fwd = -normalize(vec3(uCamMatrix[2][0], uCamMatrix[2][1], uCamMatrix[2][2]));
          vec3 flat = normalize(vec3(fwd.x, 0.0, fwd.z) + vec3(1e-5));
          vec3 centre = uCamPos + flat * 44.0;
          vec3 world = centre + right * (position.x * 150.0) + vec3(0.0, position.y * 26.0 + 6.0, 0.0);
          vWorld = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GLSL_FIELD}
        ${GLSL_NOISE}
        uniform float uTime;
        uniform float uWaterLevel;
        uniform vec3 uTint;
        varying vec3 vWorld;
        varying vec2 vUv;
        void main(){
          float ground = fieldHeight(vWorld.xz);
          // Only over molten ground.
          float over = 1.0 - smoothstep(0.0, 2.5, ground - uWaterLevel);
          if (over <= 0.01) discard;
          vec2 p = vec2(vWorld.x * 0.06, vWorld.y * 0.10 - uTime * 0.55);
          float n = fbm2(p, 4);
          float n2 = fbm2(p * 2.3 + 7.1 - vec2(0.0, uTime * 0.9), 3);
          float haze = pow(clamp(n * 0.7 + n2 * 0.5, 0.0, 1.0), 2.2);
          // Strongest just above the surface, gone by 20 m.
          float rise = 1.0 - smoothstep(0.0, 1.0, vUv.y);
          float a = haze * rise * over * 0.34;
          if (a <= 0.003) discard;
          gl_FragColor = vec4(uTint * (0.6 + haze * 0.8), a);
        }
      `,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'Weather:shimmer';
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER.PARTICLE_ADDITIVE;
    mesh.layers.enable(LAYERS.BLOOM);
    this.group.add(mesh);
    this.shimmer = mesh;
    this.shimmerMat = material;
  }

  // =========================================================================
  // WET ROAD
  // =========================================================================

  /**
   * Rain makes asphalt specular. We only ever *store and restore* — Track owns
   * those materials and must get them back exactly as they were.
   */
  private applyWetRoad(wet: boolean): void {
    if (wet === this.roadWet && this.roadOverrides.length > 0) return;
    if (!wet) {
      for (const o of this.roadOverrides) {
        o.material.roughness = o.roughness;
        o.material.metalness = o.metalness;
        o.material.envMapIntensity = o.envMapIntensity;
        o.material.needsUpdate = true;
      }
      this.roadOverrides.length = 0;
      this.roadWet = false;
      return;
    }
    this.roadWet = true;
    if (!this.roadGroup) return;
    const seen = new Set<THREE.Material>();
    this.roadGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mats = mesh.material;
      if (!mats) return;
      const list = Array.isArray(mats) ? mats : [mats];
      for (const m of list) {
        if (seen.has(m)) continue;
        seen.add(m);
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm.isMeshStandardMaterial) continue;
        this.roadOverrides.push({
          material: sm,
          roughness: sm.roughness,
          metalness: sm.metalness,
          envMapIntensity: sm.envMapIntensity,
        });
        sm.roughness = clamp(sm.roughness * 0.28, 0.045, 1);
        sm.metalness = clamp(sm.metalness + 0.12, 0, 1);
        sm.envMapIntensity = (sm.envMapIntensity || 1) * 1.6;
        sm.needsUpdate = true;
      }
    });
  }

  // =========================================================================
  // FRAME
  // =========================================================================

  update(ctx: FrameContext): void {
    this.time += ctx.dt;
    this.uTime.value = this.time;

    const cam = this.camera;
    if (cam) {
      this.uCamPos.value.copy(cam.position);
      this.uCamMatrix.value.copy(cam.matrixWorld);
    }

    this.wetness = damp(this.wetness, this.wetTarget, 1.4, ctx.dt);
    if (this.dropletMat) {
      this.dropletMat.uniforms.uAmount.value = clamp01(this.wetness);
      if (this.droplets) this.droplets.visible = this.wetness > 0.01;
    }

    // Storms breathe: the intensity swells and eases rather than sitting flat.
    const swell = 0.72 + 0.28 * Math.sin(this.time * 0.19) + 0.1 * Math.sin(this.time * 0.53);
    for (const s of this.systems.values()) {
      s.material.uniforms.uAmount.value = clamp01(swell);
    }
  }

  get drawCalls(): number {
    return this.systems.size + (this.splash ? 1 : 0)
      + (this.droplets && this.droplets.visible ? 1 : 0) + (this.shimmer ? 1 : 0);
  }

  get particleCount(): number {
    let n = 0;
    for (const s of this.systems.values()) n += s.spec.count;
    if (this.splash) n += this.splash.spec.count;
    return n;
  }

  private clearSystems(): void {
    for (const s of this.systems.values()) {
      this.group.remove(s.mesh);
      s.geometry.dispose();
      s.material.dispose();
    }
    this.systems.clear();
    if (this.splash) {
      this.group.remove(this.splash.mesh);
      this.splash.geometry.dispose();
      this.splash.material.dispose();
      this.splash = null;
    }
    if (this.droplets) {
      this.group.remove(this.droplets);
      this.droplets.geometry.dispose();
      this.dropletMat?.dispose();
      this.droplets = null;
      this.dropletMat = null;
    }
    if (this.shimmer) {
      this.group.remove(this.shimmer);
      this.shimmer.geometry.dispose();
      this.shimmerMat?.dispose();
      this.shimmer = null;
      this.shimmerMat = null;
    }
  }

  dispose(): void {
    this.applyWetRoad(false);
    this.clearSystems();
    this.scene.remove(this.group);
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------

function normalise(name: WeatherName | WorldTheme): WeatherName {
  switch (name) {
    case 'rain': case 'storm': case 'snow': case 'ash':
    case 'leaves': case 'shimmer': case 'clear':
      return name;
    case 'coastal': return 'leaves';
    case 'meadow': return 'leaves';
    case 'city': return 'rain';
    case 'volcano': return 'ash';
    case 'desert': return 'clear';
    default: return 'clear';
  }
}
