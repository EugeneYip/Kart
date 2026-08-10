/**
 * ============================================================================
 *  APEX KART — GPU PARTICLE ENGINE
 * ============================================================================
 *  One InstancedBufferGeometry, one draw call, zero per-frame CPU simulation.
 *
 *  Every particle stores its spawn state (p0, v0, spawnTime, lifetime, seed)
 *  once, at spawn. The vertex shader then evaluates the *analytic* solution of
 *  ballistic motion with linear drag
 *
 *      p(t) = p0 + v0*(1-e^-kt)/k + a*(t - (1-e^-kt)/k)/k
 *
 *  plus an optional single ground bounce (closed-form quadratic root) and
 *  optional curl-noise turbulence. Nothing is written back to the CPU, so a
 *  20 000-particle scene costs one `bufferSubData` of the few hundred floats
 *  that were spawned this frame — and literally nothing else.
 *
 *  Blending is *premultiplied*: `src = ONE, dst = ONE_MINUS_SRC_ALPHA`. A
 *  particle declares how additive it is (`additive` 0..1) and the shader emits
 *  `a * (1 - additive)` in the alpha channel, so additive fire and alpha-blended
 *  smoke coexist in the SAME draw call and sort against each other correctly.
 *
 *  Soft particles are mandatory here: the fragment shader fades alpha out
 *  against the scene depth buffer, so nothing ever shows a hard intersection
 *  line against the road.
 *
 *  A small CPU-simulated pool (same shader, `PFLAG.CPU`) exists for the handful
 *  of effects that genuinely need collision response — tumbling debris chips
 *  that must settle on the ground rather than fly through it.
 * ============================================================================
 */

import * as THREE from 'three';
import type { KartState, QualitySettings } from '@/core/Types';
import { RENDER_ORDER } from '@/core/Config';
import { ATLAS_COLS, ATLAS_ROWS, CURVE_ROWS, RAMP_ROWS } from './sprites/Atlas';

// ---------------------------------------------------------------------------
// Per-particle behaviour flags (packed into iM.w)
// ---------------------------------------------------------------------------

export const PFLAG = {
  /** Billboard is stretched along its screen-space velocity. */
  STRETCH: 1,
  /** Bounce once off `groundY` (closed form). */
  BOUNCE: 2,
  /** Curl-noise turbulence displacement. */
  TURB: 4,
  /** Quad lies in the plane whose normal is `v0` (ground rings, wall rings). */
  PLANE: 8,
  /** CPU-simulated slot: `iP0` is the live position, rewritten every frame. */
  CPU: 16,
  /** Opt out of the soft-depth fade (for things that must stay crisp). */
  HARD: 32,
} as const;

// ---------------------------------------------------------------------------
// Emitter description
// ---------------------------------------------------------------------------

export interface EmitterDesc {
  /** Atlas cell — see `SPRITE`. */
  sprite: number;
  /** Colour-over-life LUT row — see `RAMP`. */
  ramp: number;
  /** Size-over-life LUT row — see `CURVE`. */
  curve: number;
  flags: number;

  /** Metres. */
  size: number;
  /** Multiplicative jitter, 0..1. */
  sizeVar: number;
  /** Seconds. */
  life: number;
  lifeVar: number;

  /** m/s along the emit direction. */
  speed: number;
  speedVar: number;
  /** Cone half-angle in radians (Math.PI = full sphere). */
  cone: number;
  /** Extra world-space velocity added to every particle (buoyancy, wind). */
  drift: THREE.Vector3;
  /** Fraction of the emitter's own velocity inherited, 0..1. */
  inherit: number;
  /** Random spawn-position offset radius, metres. */
  jitter: number;

  /** m/s² downward. */
  gravity: number;
  /** Linear drag coefficient, 1/s. */
  drag: number;
  /** Turbulence amplitude (metres of displacement per second of life). */
  turbAmp: number;
  /** Turbulence spatial frequency, 1/m. */
  turbFreq: number;
  /** Bounce restitution when `PFLAG.BOUNCE` is set. */
  restitution: number;

  /** rad/s. */
  spin: number;
  spinVar: number;
  /** Screen-space stretch per m/s of velocity. */
  stretch: number;
  /** Soft-depth fade distance in metres. 0 disables. */
  soft: number;

  /** 0 = alpha blended, 1 = fully additive. */
  additive: number;
  /** Master opacity multiplier. */
  alpha: number;
  /** Linear-space tint, multiplied over the ramp colour. */
  tint: THREE.Color;
  /** HDR intensity multiplier — values > 1 bloom. */
  intensity: number;
}

const DEFAULT_DESC: EmitterDesc = {
  sprite: 0, ramp: 0, curve: 0, flags: 0,
  size: 0.4, sizeVar: 0.3,
  life: 0.6, lifeVar: 0.25,
  speed: 4, speedVar: 0.4, cone: 0.35,
  drift: new THREE.Vector3(), inherit: 0, jitter: 0,
  gravity: 0, drag: 0, turbAmp: 0, turbFreq: 0.6, restitution: 0,
  spin: 0, spinVar: 1, stretch: 0, soft: 0.6,
  additive: 1, alpha: 1, tint: new THREE.Color(1, 1, 1), intensity: 1,
};

/** Build a full emitter description from a partial one. Call at init, not per frame. */
export function makeDesc(init: Partial<EmitterDesc>): EmitterDesc {
  const d: EmitterDesc = {
    ...DEFAULT_DESC,
    drift: new THREE.Vector3(),
    tint: new THREE.Color(1, 1, 1),
  };
  for (const k of Object.keys(init) as Array<keyof EmitterDesc>) {
    const v = init[k];
    if (v === undefined) continue;
    if (k === 'drift') d.drift.copy(v as THREE.Vector3);
    else if (k === 'tint') d.tint.set(v as THREE.Color);
    else (d as unknown as Record<string, number>)[k] = v as number;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Shared context handed to every effect module
// ---------------------------------------------------------------------------

export interface VfxContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly quality: QualitySettings;
  readonly particles: ParticleSystem;
  readonly root: THREE.Group;
  /** Seconds since engine start (matches the particle shader clock). */
  time: number;
  dt: number;
  /** Global spawn throttle 0..1 — drops when the particle budget is strained. */
  throttle: number;
  shake(amount: number, seconds: number): void;
  flash(color: THREE.ColorRepresentation, amount: number, seconds: number): void;
}

// ---------------------------------------------------------------------------
// Kart access — deliberately structural so VFX never depends on KartManager's
// internals and keeps working if that module lands later or changes shape.
// ---------------------------------------------------------------------------

export type SocketName =
  | 'exhaustL' | 'exhaustR'
  | 'wheelFL' | 'wheelFR' | 'wheelRL' | 'wheelRR'
  | 'itemMount' | 'driverHead' | 'rearCentre';

export interface KartSource {
  readonly karts: KartState[];
  readonly player?: KartState | null;
  /** Optional — return type is intentionally loose; see `socketPos`. */
  getSocket?(kartId: number, name: string): unknown;
}

interface WorldPositionLike { getWorldPosition(target: THREE.Vector3): THREE.Vector3 }

/**
 * World position of a named kart socket, with a hard fallback to a local-space
 * offset on the chassis. Never throws, never allocates.
 */
export function socketPos(
  src: KartSource,
  kart: KartState,
  name: SocketName,
  fx: number, fy: number, fz: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const get = src.getSocket;
  if (typeof get === 'function') {
    const node = get.call(src, kart.id, name);
    if (node && typeof node === 'object') {
      if (typeof (node as WorldPositionLike).getWorldPosition === 'function') {
        (node as WorldPositionLike).getWorldPosition(out);
        return out;
      }
      const v = node as { isVector3?: boolean; x?: number; y?: number; z?: number };
      if (v.isVector3 === true) {
        out.set(v.x ?? 0, v.y ?? 0, v.z ?? 0);
        return out;
      }
    }
  }
  out.set(fx, fy, fz).applyQuaternion(kart.quaternion).add(kart.position);
  return out;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * Cheap sin-free hash gradient noise. Shared with the flame / trail / overlay
 * shaders so there is exactly one noise implementation in the VFX layer.
 */
export const GLSL_NOISE = /* glsl */ `
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return -1.0 + 2.0 * fract((p.xxy + p.yxx) * p.zyx);
}
float gnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dot(hash33(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0)),
            dot(hash33(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0)), u.x),
        mix(dot(hash33(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0)),
            dot(hash33(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(dot(hash33(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0)),
            dot(hash33(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0)), u.x),
        mix(dot(hash33(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0)),
            dot(hash33(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}
float fbm3(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * gnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
`;

const VERT = /* glsl */ `
precision highp float;

// NOTE: position / viewMatrix / projectionMatrix are declared by three's own
// ShaderMaterial prefix. Re-declaring them is a GLSL redefinition error.

attribute vec3 iP0;   // spawn position (or live position in CPU mode)
attribute vec3 iV0;   // spawn velocity (or plane normal in PLANE mode)
attribute vec4 iT;    // spawnTime, 1/life, seed, rot0
attribute vec4 iS;    // size, spinRate, stretch, softDist
attribute vec4 iD;    // gravity, drag, turbAmp, turbFreq
attribute vec4 iM;    // spriteIndex, rampRow, curveRow, flags
attribute vec4 iC;    // tint.rgb * intensity, alphaMul
attribute vec4 iX;    // groundY, restitution, additive, unused

uniform float uTime;
uniform float uSizeScale;
uniform vec2 uCell;      // 1/cols, 1/rows
uniform vec2 uCols;      // cols, 1/cols
uniform float uRampV;    // 1/RAMP_ROWS
uniform float uCurveV;   // 1/CURVE_ROWS
uniform sampler2D uRamp;
uniform sampler2D uCurve;

varying vec2 vUv;
varying vec4 vColor;
varying float vSoft;
varying float vViewZ;
varying float vAdd;
varying float vGroundFade;

// --- cheap gradient noise + curl ------------------------------------------
${GLSL_NOISE}
vec3 potential(vec3 p) {
  return vec3(
    gnoise(p),
    gnoise(p + vec3(31.416, 7.13, 19.37)),
    gnoise(p + vec3(-8.31, 23.77, 5.91)));
}
#ifdef HQ_TURBULENCE
/** True curl of a 3-channel noise potential — divergence free, no clumping. */
vec3 curlNoise(vec3 p) {
  const float e = 0.32;
  vec3 c = potential(p);
  vec3 dx = potential(p + vec3(e, 0.0, 0.0)) - c;
  vec3 dy = potential(p + vec3(0.0, e, 0.0)) - c;
  vec3 dz = potential(p + vec3(0.0, 0.0, e)) - c;
  return vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x) / e;
}
#else
/** Sine-lattice solenoidal field — visually similar, a third of the cost. */
vec3 curlNoise(vec3 p) {
  vec3 a = vec3(sin(p.y * 1.7 + p.z * 0.9), sin(p.z * 1.6 + p.x * 1.1), sin(p.x * 1.5 + p.y * 1.3));
  vec3 b = vec3(sin(p.y * 3.7 - p.z * 2.9), sin(p.z * 3.3 - p.x * 3.1), sin(p.x * 3.9 - p.y * 2.7));
  return a + b * 0.42;
}
#endif

// --- analytic motion -------------------------------------------------------
vec3 integrate(vec3 p0, vec3 v0, float g, float k, float t) {
  vec3 acc = vec3(0.0, -g, 0.0);
  if (k > 1e-3) {
    float A = (1.0 - exp(-k * t)) / k;
    return p0 + v0 * A + acc * (t - A) / k;
  }
  return p0 + v0 * t + 0.5 * acc * t * t;
}
vec3 velocityAt(vec3 v0, float g, float k, float t) {
  vec3 acc = vec3(0.0, -g, 0.0);
  if (k > 1e-3) {
    float e = exp(-k * t);
    return v0 * e + acc * (1.0 - e) / k;
  }
  return v0 + acc * t;
}

void main() {
  float age = uTime - iT.x;
  float t = age * iT.y;
  int flags = int(iM.w + 0.5);

  if (t < 0.0 || t >= 1.0 || iS.x <= 0.0) {
    // Dead: push outside clip space. One vertex invocation, zero fragments.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0); vColor = vec4(0.0); vSoft = 0.0; vViewZ = -1.0; vAdd = 0.0;
    vGroundFade = 0.0;
    return;
  }

  bool isPlane = (flags & 8) != 0;
  bool isCpu = (flags & 16) != 0;

  vec3 wp;
  vec3 vel;
  if (isCpu || isPlane) {
    wp = iP0;
    vel = iV0;
  } else {
    float g = iD.x;
    float k = iD.y;
    wp = integrate(iP0, iV0, g, k, age);
    vel = velocityAt(iV0, g, k, age);

    if ((flags & 2) != 0 && g > 0.01) {
      float y0 = iP0.y - iX.x;
      float disc = iV0.y * iV0.y + 2.0 * g * max(y0, 0.0);
      float t1 = (iV0.y + sqrt(disc)) / g;
      if (age > t1 && t1 > 0.0) {
        vec3 p1 = integrate(iP0, iV0, g, k, t1);
        p1.y = iX.x;
        vec3 v1 = velocityAt(iV0, g, k, t1);
        // Reflect + lose energy; sideways friction on the skid.
        v1 = vec3(v1.x * 0.72, abs(v1.y) * iX.y, v1.z * 0.72);
        float tau = age - t1;
        wp = integrate(p1, v1, g, k, tau);
        vel = velocityAt(v1, g, k, tau);
        wp.y = max(wp.y, iX.x);
      }
    }

    if ((flags & 4) != 0 && iD.z > 0.0) {
      vec3 q = wp * iD.w + vec3(iT.z * 7.3, uTime * 0.28, iT.z * 3.1);
      vec3 c = curlNoise(q);
      float ramp = pow(t, 1.2);
      wp += c * iD.z * ramp;
      vel += c * iD.z * 0.9;
    }
  }

  float curveScale = texture2D(uCurve, vec2(t, (iM.z + 0.5) * uCurveV)).r;
  float sz = iS.x * uSizeScale * curveScale;

  vec4 rc = texture2D(uRamp, vec2(t, (iM.y + 0.5) * uRampV));
  vColor = vec4(rc.rgb * iC.rgb, rc.a * iC.w);
  vAdd = iX.z;
  vSoft = ((flags & 32) != 0) ? 0.0 : iS.w;

  float ang = iT.w + iS.y * age;
  vec2 corner = position.xy;

  // Analytic ground fade. The billboard's own world-space height above the
  // emitter's ground plane feathers alpha out, so a dust puff dissolves INTO
  // the tarmac instead of showing the quad's intersection line. Free — the
  // corner height is linear across the quad, so interpolation is exact — and
  // it works even when no scene depth texture is available.
  vGroundFade = 1.0;

  if (isPlane) {
    vec3 n = normalize(iV0 + vec3(0.0, 1e-5, 0.0));
    vec3 up = abs(n.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 tx = normalize(cross(up, n));
    vec3 ty = cross(n, tx);
    float ca = cos(ang), sa = sin(ang);
    vec2 rc2 = vec2(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);
    vec3 wpos = wp + (tx * rc2.x + ty * rc2.y) * sz;
    vec4 mv = viewMatrix * vec4(wpos, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  } else {
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    vec2 ey = vec2(cos(ang), sin(ang));
    float lenMul = 1.0;
    float widMul = 1.0;
    if ((flags & 1) != 0) {
      vec3 vv = (viewMatrix * vec4(vel, 0.0)).xyz;
      float l = length(vv.xy);
      if (l > 1e-3) {
        ey = vv.xy / l;
        lenMul = 1.0 + iS.z * min(length(vel), 70.0);
        widMul = 1.0 / pow(lenMul, 0.42);
      }
    }
    vec2 ex = vec2(ey.y, -ey.x);
    vec2 off = (ex * corner.x * widMul + ey * corner.y * lenMul) * sz;
    mv.xy += off;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;

    if (vSoft > 0.0) {
      // World Y of this corner: rotate the view-space offset back to world.
      // (view->world rotation is the transpose of the view rotation.)
      float dy = viewMatrix[0][1] * off.x + viewMatrix[1][1] * off.y;
      // Narrow band, biased BELOW the plane. A wide band centred on the plane
      // erases the bottom half of ground-hugging dust; this only dissolves the
      // part that would otherwise cut a hard line into the tarmac, and leaves a
      // puff sitting on the deck at ~75 % opacity where it touches. The
      // sub-ground remainder costs nothing: depthTest is on, so anything that
      // ends up under the road is discarded by the depth buffer anyway.
      float band = clamp(vSoft * 0.35, 0.06, 0.35);
      vGroundFade = clamp((wp.y + dy - (iX.x - band * 0.75)) / band, 0.0, 1.0);
    }
  }

  float col = mod(iM.x, uCols.x);
  float row = floor(iM.x * uCols.y);
  vUv = (vec2(col, row) + corner + 0.5) * uCell;
}
`;

const FRAG = /* glsl */ `
precision highp float;

#include <common>
#include <packing>

uniform sampler2D uAtlas;
uniform sampler2D uDepth;
uniform vec2 uInvRes;
uniform vec2 uNearFar;
uniform float uHasDepth;

varying vec2 vUv;
varying vec4 vColor;
varying float vSoft;
varying float vViewZ;
varying float vAdd;
varying float vGroundFade;

void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float a = tex.a * vColor.a * vGroundFade;
  if (a <= 0.0025) discard;

  float pz = -vViewZ;

  // --- soft particles: fade against scene depth ---------------------------
  // The band here is deliberately SHORT and independent of vSoft's full
  // value. vSoft is the volumetric thickness (up to 1.3 m for dust), and
  // fading over that distance destroys exactly the effect we want most:
  // ground-hugging dust sits 0.1-0.5 m above the tarmac, so along the view
  // ray the road is always well inside a 1.3 m band and the whole puff gets
  // multiplied down to nothing. The road-plane intersection is already
  // handled analytically and exactly by vGroundFade, so all this pass has to
  // do is soften genuine contacts with *vertical* geometry — walls, barriers,
  // kart bodies. Same 0.35 shape as the analytic band, capped at 30 cm.
  if (uHasDepth > 0.5 && vSoft > 0.0) {
    float d = texture2D(uDepth, gl_FragCoord.xy * uInvRes).x;
    float sceneZ = -perspectiveDepthToViewZ(d, uNearFar.x, uNearFar.y);
    float band = clamp(vSoft * 0.35, 0.06, 0.30);
    // The tiny offset keeps half-res depth quantisation from punching holes in
    // a particle that is coplanar with the surface behind it.
    a *= clamp((sceneZ - pz) / band + 0.06, 0.0, 1.0);
  }
  // Never let a particle slam into the near plane.
  a *= smoothstep(0.12, 0.9, pz);
  if (a <= 0.0025) discard;

  gl_FragColor = vec4(vColor.rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>

  // Premultiplied output: alpha carries "how much of the background survives",
  // so additive (vAdd = 1) writes alpha 0 and adds light instead of covering.
  gl_FragColor = vec4(gl_FragColor.rgb * a, a * (1.0 - vAdd));
}
`;

// ---------------------------------------------------------------------------

interface Buffers {
  p0: Float32Array; v0: Float32Array;
  tt: Float32Array; ss: Float32Array; dd: Float32Array;
  mm: Float32Array; cc: Float32Array; xx: Float32Array;
  aP0: THREE.InstancedBufferAttribute; aV0: THREE.InstancedBufferAttribute;
  aT: THREE.InstancedBufferAttribute; aS: THREE.InstancedBufferAttribute;
  aD: THREE.InstancedBufferAttribute; aM: THREE.InstancedBufferAttribute;
  aC: THREE.InstancedBufferAttribute; aX: THREE.InstancedBufferAttribute;
  geo: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh;
  capacity: number;
  head: number;
  highWater: number;
  dirtyLo: number;
  dirtyHi: number;
  death: Float32Array;
}

/** CPU-simulated slots — used only where real collision response matters. */
interface CpuState {
  px: Float32Array; py: Float32Array; pz: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  g: Float32Array; k: Float32Array; ground: Float32Array; rest: Float32Array;
  alive: Uint8Array;
}

const TAU = Math.PI * 2;

export class ParticleSystem {
  readonly material: THREE.ShaderMaterial;

  private gpu: Buffers;
  private cpu: Buffers;
  private cpuState: CpuState;

  private atlas: THREE.Texture;
  private ramp: THREE.Texture;
  private curve: THREE.Texture;
  private camera: THREE.PerspectiveCamera;

  private time = 0;
  private quadGeoSource: THREE.BufferGeometry;

  /** Exact live count, refreshed every frame (cheap: one pass of float compares). */
  aliveGpu = 0;
  aliveCpu = 0;
  spawnedThisFrame = 0;
  droppedThisFrame = 0;

  constructor(
    parent: THREE.Object3D,
    camera: THREE.PerspectiveCamera,
    quality: QualitySettings,
    atlas: THREE.Texture,
    ramp: THREE.Texture,
    curve: THREE.Texture,
  ) {
    this.camera = camera;
    this.atlas = atlas;
    this.ramp = ramp;
    this.curve = curve;

    const budget = Math.max(600, quality.particleBudget);
    const cpuCap = Math.min(640, Math.max(96, Math.floor(budget * 0.05)));
    const gpuCap = budget - cpuCap;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: (quality.tier === 'high' || quality.tier === 'ultra')
        ? { HQ_TURBULENCE: '1' }
        : {},
      uniforms: {
        uTime: { value: 0 },
        uSizeScale: { value: 1 },
        uCell: { value: new THREE.Vector2(1 / ATLAS_COLS, 1 / ATLAS_ROWS) },
        uCols: { value: new THREE.Vector2(ATLAS_COLS, 1 / ATLAS_COLS) },
        uRampV: { value: 1 / RAMP_ROWS },
        uCurveV: { value: 1 / CURVE_ROWS },
        uRamp: { value: ramp },
        uCurve: { value: curve },
        uAtlas: { value: atlas },
        uDepth: { value: null },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uNearFar: { value: new THREE.Vector2(camera.near, camera.far) },
        uHasDepth: { value: 0 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    // Shared quad source (position only; UVs are derived from the corner).
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.quadGeoSource = quad;

    this.gpu = this.makeBuffers(gpuCap, 'vfx-particles');
    this.cpu = this.makeBuffers(cpuCap, 'vfx-particles-cpu');
    parent.add(this.gpu.mesh);
    parent.add(this.cpu.mesh);

    this.cpuState = {
      px: new Float32Array(cpuCap), py: new Float32Array(cpuCap), pz: new Float32Array(cpuCap),
      vx: new Float32Array(cpuCap), vy: new Float32Array(cpuCap), vz: new Float32Array(cpuCap),
      g: new Float32Array(cpuCap), k: new Float32Array(cpuCap),
      ground: new Float32Array(cpuCap), rest: new Float32Array(cpuCap),
      alive: new Uint8Array(cpuCap),
    };
  }

  get capacity(): number { return this.gpu.capacity + this.cpu.capacity; }
  get alive(): number { return this.aliveGpu + this.aliveCpu; }

  // -------------------------------------------------------------------------

  private makeBuffers(capacity: number, name: string): Buffers {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = this.quadGeoSource.index;
    geo.setAttribute('position', this.quadGeoSource.getAttribute('position'));
    geo.instanceCount = 0;

    const mk = (items: number): [Float32Array, THREE.InstancedBufferAttribute] => {
      const arr = new Float32Array(capacity * items);
      const attr = new THREE.InstancedBufferAttribute(arr, items);
      attr.setUsage(THREE.DynamicDrawUsage);
      return [arr, attr];
    };

    const [p0, aP0] = mk(3);
    const [v0, aV0] = mk(3);
    const [tt, aT] = mk(4);
    const [ss, aS] = mk(4);
    const [dd, aD] = mk(4);
    const [mm, aM] = mk(4);
    const [cc, aC] = mk(4);
    const [xx, aX] = mk(4);

    geo.setAttribute('iP0', aP0);
    geo.setAttribute('iV0', aV0);
    geo.setAttribute('iT', aT);
    geo.setAttribute('iS', aS);
    geo.setAttribute('iD', aD);
    geo.setAttribute('iM', aM);
    geo.setAttribute('iC', aC);
    geo.setAttribute('iX', aX);
    // Everything is world-space in the shader; a bounding sphere would only
    // ever be wrong, so culling is off.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = RENDER_ORDER.PARTICLE_ADDITIVE;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    return {
      p0, v0, tt, ss, dd, mm, cc, xx,
      aP0, aV0, aT, aS, aD, aM, aC, aX,
      geo, mesh, capacity, head: 0, highWater: 0,
      dirtyLo: Number.MAX_SAFE_INTEGER, dirtyHi: -1,
      death: new Float32Array(capacity),
    };
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * Emit `count` particles from `pos` along `dir` (within `desc.cone`).
   * `baseVel` is the emitter's own velocity, inherited by `desc.inherit`.
   */
  emit(
    d: EmitterDesc,
    count: number,
    pos: THREE.Vector3,
    dir: THREE.Vector3 | null,
    baseVel: THREE.Vector3 | null,
    groundY: number,
    scale = 1,
    delay = 0,
  ): void {
    if (count <= 0) return;
    const dx = dir ? dir.x : 0, dy = dir ? dir.y : 1, dz = dir ? dir.z : 0;
    // Orthonormal basis around dir, built once for the whole burst.
    const dl = Math.hypot(dx, dy, dz) || 1;
    const nx = dx / dl, ny = dy / dl, nz = dz / dl;
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(ny) > 0.94) { ax = 1; ay = 0; az = 0; }
    let t1x = ay * nz - az * ny, t1y = az * nx - ax * nz, t1z = ax * ny - ay * nx;
    const t1l = Math.hypot(t1x, t1y, t1z) || 1;
    t1x /= t1l; t1y /= t1l; t1z /= t1l;
    const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;

    const inh = d.inherit;
    const bvx = baseVel ? baseVel.x * inh : 0;
    const bvy = baseVel ? baseVel.y * inh : 0;
    const bvz = baseVel ? baseVel.z * inh : 0;
    const cosMin = Math.cos(d.cone);

    for (let i = 0; i < count; i++) {
      const cz = 1 - Math.random() * (1 - cosMin);
      const sr = Math.sqrt(Math.max(0, 1 - cz * cz));
      const phi = Math.random() * TAU;
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const ux = nx * cz + (t1x * cp + t2x * sp) * sr;
      const uy = ny * cz + (t1y * cp + t2y * sp) * sr;
      const uz = nz * cz + (t1z * cp + t2z * sp) * sr;
      const sp2 = d.speed * (1 + (Math.random() * 2 - 1) * d.speedVar);

      let jx = 0, jy = 0, jz = 0;
      if (d.jitter > 0) {
        const j = d.jitter;
        jx = (Math.random() * 2 - 1) * j;
        jy = (Math.random() * 2 - 1) * j;
        jz = (Math.random() * 2 - 1) * j;
      }

      this.write(
        d,
        pos.x + jx, pos.y + jy, pos.z + jz,
        ux * sp2 + bvx + d.drift.x,
        uy * sp2 + bvy + d.drift.y,
        uz * sp2 + bvz + d.drift.z,
        groundY, scale, 1,
      );
    }
  }

  /** Spawn a single particle with an explicit velocity. */
  spawn(
    d: EmitterDesc,
    pos: THREE.Vector3,
    vel: THREE.Vector3 | null,
    groundY: number,
    sizeMul = 1,
    lifeMul = 1,
  ): void {
    this.write(
      d, pos.x, pos.y, pos.z,
      vel ? vel.x : 0, vel ? vel.y : 0, vel ? vel.z : 0,
      groundY, sizeMul, lifeMul,
    );
  }

  /**
   * A `PFLAG.PLANE` particle: a flat quad whose normal is `normal`. Used for
   * ground shockwave rings and wall-aligned flashes.
   */
  spawnPlane(
    d: EmitterDesc,
    pos: THREE.Vector3,
    normal: THREE.Vector3,
    sizeMul = 1,
    lifeMul = 1,
  ): void {
    this.write(
      d, pos.x, pos.y, pos.z,
      normal.x, normal.y, normal.z,
      pos.y, sizeMul, lifeMul,
    );
  }

  private write(
    d: EmitterDesc,
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    groundY: number, sizeMul: number, lifeMul: number,
  ): void {
    const isCpu = (d.flags & PFLAG.CPU) !== 0;
    const b = isCpu ? this.cpu : this.gpu;
    const cap = b.capacity;
    if (cap === 0) { this.droppedThisFrame++; return; }

    const i = b.head;
    b.head = (i + 1) % cap;
    if (i + 1 > b.highWater) b.highWater = i + 1;
    if (i < b.dirtyLo) b.dirtyLo = i;
    if (i > b.dirtyHi) b.dirtyHi = i;
    this.spawnedThisFrame++;

    const life = Math.max(0.02, d.life * (1 + (Math.random() * 2 - 1) * d.lifeVar) * lifeMul);
    const size = Math.max(0.0001, d.size * (1 + (Math.random() * 2 - 1) * d.sizeVar) * sizeMul);

    b.p0[i * 3] = px; b.p0[i * 3 + 1] = py; b.p0[i * 3 + 2] = pz;
    b.v0[i * 3] = vx; b.v0[i * 3 + 1] = vy; b.v0[i * 3 + 2] = vz;

    const i4 = i * 4;
    b.tt[i4] = this.time;
    b.tt[i4 + 1] = 1 / life;
    b.tt[i4 + 2] = Math.random() * 64;
    b.tt[i4 + 3] = Math.random() * TAU;

    b.ss[i4] = size;
    b.ss[i4 + 1] = d.spin * (1 + (Math.random() * 2 - 1) * d.spinVar);
    b.ss[i4 + 2] = d.stretch;
    b.ss[i4 + 3] = d.soft;

    b.dd[i4] = d.gravity;
    b.dd[i4 + 1] = d.drag;
    b.dd[i4 + 2] = d.turbAmp;
    b.dd[i4 + 3] = d.turbFreq;

    b.mm[i4] = d.sprite;
    b.mm[i4 + 1] = d.ramp;
    b.mm[i4 + 2] = d.curve;
    b.mm[i4 + 3] = d.flags;

    const c = d.tint;
    const k = d.intensity;
    b.cc[i4] = c.r * k; b.cc[i4 + 1] = c.g * k; b.cc[i4 + 2] = c.b * k;
    b.cc[i4 + 3] = d.alpha;

    b.xx[i4] = groundY;
    b.xx[i4 + 1] = d.restitution;
    b.xx[i4 + 2] = d.additive;
    b.xx[i4 + 3] = 0;

    b.death[i] = this.time + life;

    if (isCpu) {
      const s = this.cpuState;
      s.px[i] = px; s.py[i] = py; s.pz[i] = pz;
      s.vx[i] = vx; s.vy[i] = vy; s.vz[i] = vz;
      s.g[i] = d.gravity; s.k[i] = d.drag;
      s.ground[i] = groundY; s.rest[i] = d.restitution;
      s.alive[i] = 1;
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  setDepthTexture(tex: THREE.Texture | null, width: number, height: number): void {
    this.material.uniforms.uDepth.value = tex;
    this.material.uniforms.uHasDepth.value = tex ? 1 : 0;
    (this.material.uniforms.uInvRes.value as THREE.Vector2).set(
      1 / Math.max(1, width), 1 / Math.max(1, height),
    );
  }

  setSizeScale(v: number): void { this.material.uniforms.uSizeScale.value = v; }

  update(time: number, dt: number): void {
    this.time = time;
    this.material.uniforms.uTime.value = time;
    (this.material.uniforms.uNearFar.value as THREE.Vector2).set(this.camera.near, this.camera.far);

    this.simulateCpu(dt);

    this.aliveGpu = this.flush(this.gpu, time);
    this.aliveCpu = this.flush(this.cpu, time);
    this.spawnedThisFrame = 0;
    this.droppedThisFrame = 0;
  }

  /** Euler-integrate the collision pool and mark its whole range dirty. */
  private simulateCpu(dt: number): void {
    const b = this.cpu;
    if (b.highWater === 0) return;
    const s = this.cpuState;
    const step = Math.min(dt, 1 / 45);
    let any = false;
    for (let i = 0; i < b.highWater; i++) {
      if (!s.alive[i]) continue;
      if (b.death[i] <= this.time) { s.alive[i] = 0; continue; }
      any = true;
      const drag = Math.max(0, 1 - s.k[i] * step);
      s.vx[i] *= drag;
      s.vz[i] *= drag;
      s.vy[i] = s.vy[i] * drag - s.g[i] * step;
      s.px[i] += s.vx[i] * step;
      s.py[i] += s.vy[i] * step;
      s.pz[i] += s.vz[i] * step;
      const gy = s.ground[i];
      if (s.py[i] < gy) {
        s.py[i] = gy;
        if (s.vy[i] < 0) {
          s.vy[i] = -s.vy[i] * s.rest[i];
          s.vx[i] *= 0.62;
          s.vz[i] *= 0.62;
          if (s.vy[i] < 0.35) { s.vy[i] = 0; s.vx[i] *= 0.4; s.vz[i] *= 0.4; }
        }
      }
      const i3 = i * 3;
      b.p0[i3] = s.px[i]; b.p0[i3 + 1] = s.py[i]; b.p0[i3 + 2] = s.pz[i];
      b.v0[i3] = s.vx[i]; b.v0[i3 + 1] = s.vy[i]; b.v0[i3 + 2] = s.vz[i];
    }
    if (any) { b.dirtyLo = 0; b.dirtyHi = b.highWater - 1; }
  }

  private flush(b: Buffers, time: number): number {
    // Count live slots (a few thousand float compares — under 20 µs).
    let alive = 0;
    for (let i = 0; i < b.highWater; i++) if (b.death[i] > time) alive++;
    b.geo.instanceCount = alive > 0 ? b.highWater : 0;

    if (b.dirtyHi < b.dirtyLo) return alive;
    const lo = b.dirtyLo;
    const n = b.dirtyHi - lo + 1;
    const upload = (a: THREE.InstancedBufferAttribute, items: number) => {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * items, n * items);
      a.needsUpdate = true;
    };
    upload(b.aP0, 3); upload(b.aV0, 3);
    upload(b.aT, 4); upload(b.aS, 4); upload(b.aD, 4);
    upload(b.aM, 4); upload(b.aC, 4); upload(b.aX, 4);
    b.dirtyLo = Number.MAX_SAFE_INTEGER;
    b.dirtyHi = -1;
    return alive;
  }

  /** Kill everything immediately (race restart). */
  clear(): void {
    for (const b of [this.gpu, this.cpu]) {
      b.death.fill(-1);
      b.ss.fill(0);
      b.dirtyLo = 0;
      b.dirtyHi = Math.max(0, b.highWater - 1);
      b.geo.instanceCount = 0;
    }
    this.cpuState.alive.fill(0);
  }

  dispose(): void {
    this.gpu.mesh.removeFromParent();
    this.cpu.mesh.removeFromParent();
    this.gpu.geo.dispose();
    this.cpu.geo.dispose();
    this.quadGeoSource.dispose();
    this.material.dispose();
  }
}
