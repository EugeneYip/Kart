/**
 * ============================================================================
 *  BOOST FLAME — twin exhaust cones, hot core, heat haze
 * ============================================================================
 *  The flame body is a real mesh, not a particle cloud: a tapered tube built in
 *  code, drawn as TWO nested shells (outer body + inner white-hot core) in a
 *  single instanced draw call for every flame on the track. The vertex shader
 *  distorts the silhouette with gradient noise and pulses its length with boost
 *  strength; the fragment shader colours it through the FLAME ramp (white →
 *  yellow → orange → red → smoke tip) and erodes the tip with more noise.
 *
 *  Particles add the detail pass: flame licks, embers, and a smoke tail.
 *  Ignition fires a hard pop — flare, ring shockwave, spark ring.
 *
 *  Heat haze: a billboard behind the kart. If the render pipeline hands us a
 *  scene-colour texture (`setSceneTexture`) it becomes a true refraction;
 *  otherwise it degrades to a subtle additive shimmer.
 * ============================================================================
 */

import * as THREE from 'three';
import type { KartState } from '@/core/Types';
import { LAYERS, RENDER_ORDER } from '@/core/Config';
import { clamp01, damp } from '@/core/MathUtils';
import { CURVE, RAMP, SPRITE } from './sprites/Atlas';
import {
  GLSL_NOISE, makeDesc, PFLAG, socketPos,
  type EmitterDesc, type KartSource, type VfxContext,
} from './ParticleSystem';

export type BoostVariant = 'mushroom' | 'mini' | 'super' | 'ultra' | 'star';

interface VariantDef {
  ramp: number;
  coreRamp: number;
  length: number;
  radius: number;
  intensity: number;
}

/**
 * Lengths and radii are METRES on a 1.9 m kart, so they have to stay small: a
 * 2 m flame off a 1.9 m chassis reads as a rocket exhaust, not a kart boost.
 * MK8's twin flames are roughly 0.6–1.3 m long and 0.4 m across.
 */
const VARIANTS: Record<BoostVariant, VariantDef> = {
  mini: { ramp: RAMP.FLAME, coreRamp: RAMP.WHITE_SHARP, length: 0.58, radius: 0.85, intensity: 0.85 },
  mushroom: { ramp: RAMP.FLAME, coreRamp: RAMP.WHITE_SHARP, length: 0.80, radius: 0.95, intensity: 0.95 },
  super: { ramp: RAMP.FLAME, coreRamp: RAMP.FLAME_BLUE, length: 1.05, radius: 1.05, intensity: 1.1 },
  ultra: { ramp: RAMP.FLAME_BLUE, coreRamp: RAMP.WHITE_SHARP, length: 1.32, radius: 1.15, intensity: 1.25 },
  star: { ramp: RAMP.RAINBOW, coreRamp: RAMP.WHITE_SHARP, length: 1.20, radius: 1.10, intensity: 1.2 },
};

const MAX_FLAMES = 26;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpScale = new THREE.Vector3();
const F_LOCAL = new THREE.Vector3(0, 0, -1);
const U_LOCAL = new THREE.Vector3(0, 1, 0);
const R_LOCAL = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------
// Flame shell geometry: two nested tapered tubes along +Z, length 1.
// ---------------------------------------------------------------------------

function buildFlameGeometry(rings: number, segs: number): THREE.InstancedBufferGeometry {
  const shells = 2;
  const vertCount = shells * (rings + 1) * (segs + 1);
  const pos = new Float32Array(vertCount * 3);
  const attr = new Float32Array(vertCount * 3); // t, angle01, shell
  const idx: number[] = [];

  let v = 0;
  for (let s = 0; s < shells; s++) {
    const rMul = s === 0 ? 1 : 0.5;
    const lMul = s === 0 ? 1 : 0.72;
    const base = v;
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      // Slim tapered tongue: peak radius ~0.18 in local units, so a radius
      // multiplier of ~1 gives a flame about 0.4 m across.
      const r = ((0.075 + 0.105 * Math.sin(Math.PI * Math.pow(t, 0.75))) * (1 - Math.pow(t, 2.2)) + 0.008) * rMul;
      for (let j = 0; j <= segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        pos[v * 3] = Math.cos(a) * r;
        pos[v * 3 + 1] = Math.sin(a) * r;
        pos[v * 3 + 2] = t * lMul;
        attr[v * 3] = t;
        attr[v * 3 + 1] = j / segs;
        attr[v * 3 + 2] = s;
        v++;
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = base + i * (segs + 1) + j;
        const b = a + segs + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aFlame', new THREE.BufferAttribute(attr, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.5), 4);
  return geo;
}

const FLAME_VERT = /* glsl */ `
precision highp float;
// position and instanceMatrix come from three's own ShaderMaterial prefix.
attribute vec3 aFlame;      // t along flame, angle 0..1, shell index
attribute vec4 iFlame;      // strength, seed, rampRow, coreRampRow
attribute vec4 iFlame2;     // intensity, lengthMul, radiusMul, flicker

uniform float uTime;

varying float vT;
varying float vAngle;
varying float vShell;
varying float vStrength;
varying float vIntensity;
varying float vRampRow;
varying float vSeed;

${GLSL_NOISE}

void main() {
  vT = aFlame.x;
  vAngle = aFlame.y;
  vShell = aFlame.z;
  vStrength = iFlame.x;
  vIntensity = iFlame2.x;
  vRampRow = aFlame.z < 0.5 ? iFlame.z : iFlame.w;
  vSeed = iFlame.y;

  float t = aFlame.x;
  float ang = aFlame.y * 6.2831853;
  float len = iFlame2.y * mix(0.55, 1.0, iFlame.x);
  float rad = iFlame2.z * mix(0.7, 1.0, iFlame.x);

  vec3 p = position;
  // Radial breakup: the silhouette must never read as a smooth cone.
  float n = gnoise(vec3(cos(ang) * 1.6, sin(ang) * 1.6, t * 5.0 - uTime * 7.0 + iFlame.y));
  float swell = 1.0 + n * (0.30 + 0.42 * t) * iFlame2.w;
  p.xy *= rad * swell;
  // Lateral flicker sway, zero at the nozzle.
  float sway = gnoise(vec3(t * 2.2, uTime * 5.5 + iFlame.y, 0.0)) * 0.16 * t * t;
  float sway2 = gnoise(vec3(uTime * 6.1 + iFlame.y, t * 2.7, 3.0)) * 0.16 * t * t;
  p.x += sway;
  p.y += sway2;
  p.z *= len;

  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}
`;

const FLAME_FRAG = /* glsl */ `
precision highp float;
#include <common>

uniform sampler2D uRamp;
uniform float uRampV;
uniform float uTime;

varying float vT;
varying float vAngle;
varying float vShell;
varying float vStrength;
varying float vIntensity;
varying float vRampRow;
varying float vSeed;

${GLSL_NOISE}

void main() {
  float t = clamp(vT, 0.0, 1.0);
  float ang = vAngle * 6.2831853;

  // Fire detail: two scrolling octaves streaming down the flame axis.
  vec3 q = vec3(cos(ang) * 2.4, sin(ang) * 2.4, t * 6.0 - uTime * 9.0 + vSeed);
  float n = fbm3(q) * 0.5 + 0.5;
  float n2 = gnoise(q * 2.7 + vec3(0.0, 0.0, -uTime * 4.0)) * 0.5 + 0.5;

  // Ramp along the flame: white core at the nozzle, smoke at the tip.
  float u = clamp(t * (0.55 + 0.45 * n), 0.0, 1.0);
  vec4 c = texture2D(uRamp, vec2(u, (vRampRow + 0.5) * uRampV));

  // Erode the tip so it dissolves into wisps instead of ending in a cone point.
  float erode = smoothstep(0.18, 0.95, (1.0 - t) + (n - 0.5) * 0.85);
  float a = c.a * erode;
  // Shells: the inner one is a small, dense, very hot core.
  if (vShell > 0.5) a *= 1.25 * smoothstep(0.02, 0.35, 1.0 - t);
  a *= mix(0.55, 1.0, n2);
  a *= vStrength;
  if (a <= 0.004) discard;

  // The ramp already carries HDR intensities up to ~7. Multiplying that again
  // clips the entire body to white and the flame loses its yellow→orange→red
  // gradient, so the body is scaled DOWN and only the inner core runs hot.
  vec3 rgb = c.rgb * vIntensity * (vShell > 0.5 ? 1.15 : 0.42);
  gl_FragColor = vec4(rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}
`;

// ---------------------------------------------------------------------------
// Heat haze billboard
// ---------------------------------------------------------------------------

const HAZE_VERT = /* glsl */ `
precision highp float;
attribute vec4 iHaze;    // strength, seed, width, height
attribute vec3 iPos;
varying vec2 vUv;
varying float vStrength;
varying float vSeed;
void main() {
  vUv = position.xy + 0.5;
  vStrength = iHaze.x;
  vSeed = iHaze.y;
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  mv.xy += position.xy * vec2(iHaze.z, iHaze.w);
  gl_Position = projectionMatrix * mv;
}
`;

const HAZE_FRAG = /* glsl */ `
precision highp float;
#include <common>
uniform sampler2D uScene;
uniform float uHasScene;
uniform vec2 uInvRes;
uniform float uTime;
varying vec2 vUv;
varying float vStrength;
varying float vSeed;

${GLSL_NOISE}

void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float mask = smoothstep(1.0, 0.15, r) * vStrength;
  if (mask <= 0.004) discard;

  float n1 = gnoise(vec3(vUv * 6.0, uTime * 2.4 + vSeed));
  float n2 = gnoise(vec3(vUv * 13.0 + 5.0, uTime * 3.7 + vSeed));
  vec2 warp = vec2(n1, n2) * 0.014 * mask;

  if (uHasScene > 0.5) {
    vec2 uv = gl_FragCoord.xy * uInvRes + warp;
    vec3 s = texture2D(uScene, uv).rgb;
    gl_FragColor = vec4(s, 1.0);
    // Straight alpha over: the refracted copy replaces the background.
    gl_FragColor = vec4(gl_FragColor.rgb * mask, mask);
  } else {
    // No scene colour available: read as a faint warm shimmer instead.
    float shimmer = (n1 * 0.5 + 0.5) * (n2 * 0.5 + 0.5);
    float a = mask * shimmer * 0.16;
    vec3 rgb = vec3(1.0, 0.62, 0.30) * 0.5;
    gl_FragColor = vec4(rgb, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * a, 0.0);
  }
}
`;

// ---------------------------------------------------------------------------

interface FlameState {
  strength: number;
  variant: BoostVariant;
  ignitionCooldown: number;
  accLick: number;
  accSmoke: number;
  accEmber: number;
}

export class BoostFlame {
  private ctx: VfxContext;
  private src: KartSource;

  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.InstancedMesh;
  private iFlame: THREE.InstancedBufferAttribute;
  private iFlame2: THREE.InstancedBufferAttribute;

  private hazeGeo: THREE.InstancedBufferGeometry;
  private hazeMat: THREE.ShaderMaterial;
  private hazeMesh: THREE.Mesh;
  private iHaze: THREE.InstancedBufferAttribute;
  private iHazePos: THREE.InstancedBufferAttribute;

  private state = new Map<number, FlameState>();

  private dLick: EmitterDesc;
  private dSmoke: EmitterDesc;
  private dEmber: EmitterDesc;
  private dPopFlare: EmitterDesc;
  private dPopRing: EmitterDesc;
  private dPopSpark: EmitterDesc;
  private dPopSmoke: EmitterDesc;

  constructor(ctx: VfxContext, src: KartSource, ramp: THREE.Texture, rampRows: number) {
    this.ctx = ctx;
    this.src = src;

    const rings = ctx.quality.tier === 'low' ? 6 : ctx.quality.tier === 'medium' ? 8 : 12;
    const segs = ctx.quality.tier === 'low' ? 8 : ctx.quality.tier === 'medium' ? 10 : 14;

    this.geo = buildFlameGeometry(rings, segs);
    this.iFlame = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLAMES * 4), 4);
    this.iFlame2 = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLAMES * 4), 4);
    this.iFlame.setUsage(THREE.DynamicDrawUsage);
    this.iFlame2.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iFlame', this.iFlame);
    this.geo.setAttribute('iFlame2', this.iFlame2);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uRamp: { value: ramp },
        uRampV: { value: 1 / rampRows },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, MAX_FLAMES);
    this.mesh.name = 'vfx-boost-flames';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = RENDER_ORDER.PARTICLE_ADDITIVE - 2;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.layers.enable(LAYERS.BLOOM);
    this.mesh.layers.enable(LAYERS.NO_REFLECT);
    ctx.root.add(this.mesh);

    // --- heat haze ----------------------------------------------------------
    this.hazeGeo = new THREE.InstancedBufferGeometry();
    this.hazeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    this.hazeGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.iHaze = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLAMES * 4), 4);
    this.iHazePos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLAMES * 3), 3);
    this.iHaze.setUsage(THREE.DynamicDrawUsage);
    this.iHazePos.setUsage(THREE.DynamicDrawUsage);
    this.hazeGeo.setAttribute('iHaze', this.iHaze);
    this.hazeGeo.setAttribute('iPos', this.iHazePos);
    this.hazeGeo.instanceCount = 0;
    this.hazeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.hazeMat = new THREE.ShaderMaterial({
      vertexShader: HAZE_VERT,
      fragmentShader: HAZE_FRAG,
      uniforms: {
        uScene: { value: null },
        uHasScene: { value: 0 },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uTime: { value: 0 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this.hazeMesh = new THREE.Mesh(this.hazeGeo, this.hazeMat);
    this.hazeMesh.name = 'vfx-heat-haze';
    this.hazeMesh.frustumCulled = false;
    this.hazeMesh.matrixAutoUpdate = false;
    this.hazeMesh.renderOrder = RENDER_ORDER.PARTICLE_ADDITIVE - 1;
    ctx.root.add(this.hazeMesh);

    // --- particle detail ----------------------------------------------------
    this.dLick = makeDesc({
      sprite: SPRITE.FLAME, ramp: RAMP.FLAME, curve: CURVE.SHRINK,
      flags: PFLAG.STRETCH,
      size: 0.42, sizeVar: 0.4, life: 0.16, lifeVar: 0.35,
      speed: 7.0, speedVar: 0.5, cone: 0.30,
      inherit: 0.9, jitter: 0.05, drag: 3.0,
      stretch: 0.012, soft: 0.25,
      additive: 1, alpha: 0.9, intensity: 1.5,
    });
    this.dSmoke = makeDesc({
      sprite: SPRITE.SMOKE, ramp: RAMP.SMOKE, curve: CURVE.PUFF,
      flags: PFLAG.TURB,
      size: 0.5, sizeVar: 0.45, life: 0.85, lifeVar: 0.4,
      speed: 3.0, speedVar: 0.6, cone: 0.55,
      drift: new THREE.Vector3(0, 1.1, 0), inherit: 0.35, jitter: 0.1,
      gravity: -0.8, drag: 1.5, turbAmp: 0.55, turbFreq: 1.2,
      spin: 1.4, soft: 0.8, additive: 0.1, alpha: 0.42, intensity: 1,
    });
    this.dEmber = makeDesc({
      sprite: SPRITE.EMBER, ramp: RAMP.EMBER, curve: CURVE.SHRINK,
      flags: PFLAG.TURB,
      size: 0.085, sizeVar: 0.5, life: 0.9, lifeVar: 0.5,
      speed: 5.5, speedVar: 0.7, cone: 0.7,
      drift: new THREE.Vector3(0, 1.2, 0), inherit: 0.5, jitter: 0.06,
      gravity: 1.4, drag: 1.4, turbAmp: 0.6, turbFreq: 1.3,
      soft: 0.2, additive: 1, alpha: 1, intensity: 1.2,
    });

    this.dPopFlare = makeDesc({
      sprite: SPRITE.FLARE, ramp: RAMP.WHITE_SHARP, curve: CURVE.SPIKE,
      flags: PFLAG.HARD,
      size: 3.4, sizeVar: 0.1, life: 0.20, lifeVar: 0.1,
      speed: 0.5, cone: 3.14, drag: 3, soft: 0,
      additive: 1, alpha: 1, intensity: 2.0,
    });
    this.dPopRing = makeDesc({
      sprite: SPRITE.RING, ramp: RAMP.WHITE_SHARP, curve: CURVE.PUFF,
      flags: PFLAG.PLANE,
      size: 3.0, life: 0.30, lifeVar: 0,
      soft: 0.4, additive: 1, alpha: 0.9, intensity: 1.5,
    });
    this.dPopSpark = makeDesc({
      sprite: SPRITE.SPARK, ramp: RAMP.ORANGE_SPARK, curve: CURVE.SHRINK,
      flags: PFLAG.STRETCH,
      size: 0.26, sizeVar: 0.5, life: 0.34, lifeVar: 0.4,
      speed: 16, speedVar: 0.6, cone: 0.9,
      inherit: 0.5, gravity: 8, drag: 2.2,
      stretch: 0.024, soft: 0.2,
      additive: 1, alpha: 1, intensity: 1.3,
    });
    this.dPopSmoke = makeDesc({
      sprite: SPRITE.SMOKE, ramp: RAMP.SMOKE_LIGHT, curve: CURVE.PUFF,
      flags: PFLAG.TURB,
      size: 0.9, sizeVar: 0.4, life: 0.7, lifeVar: 0.35,
      speed: 5.5, speedVar: 0.6, cone: 1.0,
      inherit: 0.4, jitter: 0.12,
      gravity: -1.2, drag: 2.6, turbAmp: 0.7, turbFreq: 1.1,
      spin: 2.0, soft: 0.9, additive: 0.15, alpha: 0.5,
    });
  }

  setSceneTexture(tex: THREE.Texture | null, width: number, height: number): void {
    this.hazeMat.uniforms.uScene.value = tex;
    this.hazeMat.uniforms.uHasScene.value = tex ? 1 : 0;
    (this.hazeMat.uniforms.uInvRes.value as THREE.Vector2).set(
      1 / Math.max(1, width), 1 / Math.max(1, height),
    );
  }

  private fx(id: number): FlameState {
    let s = this.state.get(id);
    if (!s) {
      s = { strength: 0, variant: 'mushroom', ignitionCooldown: 0, accLick: 0, accSmoke: 0, accEmber: 0 };
      this.state.set(id, s);
    }
    return s;
  }

  /** Called from the `kart:boost` handler. */
  onBoost(kart: KartState | null, duration: number, source: string): void {
    if (!kart) return;
    const s = this.fx(kart.id);
    s.variant = this.pickVariant(kart, duration, source);
    if (s.ignitionCooldown > 0) return;
    s.ignitionCooldown = 0.22;
    this.ignite(kart, s.variant);
  }

  private pickVariant(kart: KartState, duration: number, source: string): BoostVariant {
    if (kart.starTime > 0) return 'star';
    if (source === 'trick') return 'mini';
    if (source === 'pad') return 'super';
    if (source === 'start') return 'ultra';
    if (source === 'drift') {
      if (duration >= 1.5) return 'ultra';
      if (duration >= 0.9) return 'super';
      return 'mushroom';
    }
    return 'mushroom';
  }

  private ignite(kart: KartState, variant: BoostVariant): void {
    const p = this.ctx.particles;
    const v = VARIANTS[variant];
    tmpFwd.copy(F_LOCAL).applyQuaternion(kart.quaternion);
    socketPos(this.src, kart, 'rearCentre', 0, 0.05, 0.95, tmpA);
    const groundY = tmpA.y - 0.6;

    this.dPopFlare.ramp = variant === 'star' ? RAMP.RAINBOW : RAMP.WHITE_SHARP;
    this.dPopFlare.size = 2.6 * v.radius;
    p.emit(this.dPopFlare, 2, tmpA, tmpFwd, kart.velocity, groundY, 1);

    // Vertical ring facing along the direction of travel — the classic "pop".
    tmpB.copy(tmpFwd).multiplyScalar(-1);
    this.dPopRing.ramp = variant === 'star' ? RAMP.RAINBOW : RAMP.WHITE_SHARP;
    this.dPopRing.size = 2.6 * v.radius;
    p.spawnPlane(this.dPopRing, tmpA, tmpB, 1, 1);

    this.dPopSpark.ramp = variant === 'star' ? RAMP.RAINBOW
      : variant === 'ultra' ? RAMP.FLAME_BLUE : RAMP.ORANGE_SPARK;
    p.emit(this.dPopSpark, Math.round(26 * this.ctx.throttle), tmpA, tmpB, kart.velocity, groundY, 1);
    p.emit(this.dPopSmoke, Math.round(8 * this.ctx.throttle), tmpA, tmpB, kart.velocity, groundY, 1);

    if (kart.isPlayer) {
      const amp = variant === 'ultra' || variant === 'star' ? 0.34 : variant === 'super' ? 0.26 : 0.18;
      this.ctx.shake(amp, 0.22);
    }
  }

  // -------------------------------------------------------------------------

  update(): void {
    const { ctx } = this;
    const dt = ctx.dt;
    const karts = this.src.karts;
    this.mat.uniforms.uTime.value = ctx.time;
    this.hazeMat.uniforms.uTime.value = ctx.time;
    if (!karts) { this.mesh.count = 0; this.hazeGeo.instanceCount = 0; return; }

    let n = 0;
    let hazeN = 0;
    const im = this.mesh.instanceMatrix.array as Float32Array;
    const fa = this.iFlame.array as Float32Array;
    const fb = this.iFlame2.array as Float32Array;
    const ha = this.iHaze.array as Float32Array;
    const hp = this.iHazePos.array as Float32Array;

    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      const s = this.fx(k.id);
      if (s.ignitionCooldown > 0) s.ignitionCooldown -= dt;

      const boosting = k.boostTime > 0;
      const want = boosting ? clamp01(0.55 + 0.45 * Math.min(1.6, k.boostStrength || 1)) : 0;
      s.strength = damp(s.strength, want, boosting ? 0.02 : 0.06, dt);
      if (k.starTime > 0 && boosting) s.variant = 'star';
      if (s.strength < 0.02) continue;

      // The player's flame is never distance-culled. `boostTime`/`boostStrength`
      // being correct is not enough to see a flame: with the camera parked away
      // from the player (a QA framing, a cinematic, a spectator angle) this
      // `continue` fired and a full mini-turbo rendered zero flame instances
      // while `strength` sat at 1.0 — the state was right and only the distance
      // gate was false.
      const dist = ctx.camera.position.distanceTo(k.position);
      if (!k.isPlayer && dist > 200) continue;

      const v = VARIANTS[s.variant];
      tmpFwd.copy(F_LOCAL).applyQuaternion(k.quaternion);
      tmpUp.copy(U_LOCAL).applyQuaternion(k.quaternion);
      tmpRight.copy(R_LOCAL).applyQuaternion(k.quaternion);

      // Flame points backwards: local +Z of the flame maps to -forward.
      tmpB.copy(tmpFwd).multiplyScalar(-1);
      tmpQ.setFromUnitVectors(Z_AXIS, tmpB);
      const pulse = 0.86 + 0.14 * Math.sin(ctx.time * 34 + k.id) + 0.06 * Math.sin(ctx.time * 71);

      for (let side = 0; side < 2 && n < MAX_FLAMES; side++) {
        socketPos(
          this.src, k, side === 0 ? 'exhaustL' : 'exhaustR',
          side === 0 ? -0.42 : 0.42, -0.02, 0.86, tmpA,
        );
        tmpScale.setScalar(1);
        tmpM.compose(tmpA, tmpQ, tmpScale);
        tmpM.toArray(im, n * 16);
        fa[n * 4] = s.strength;
        fa[n * 4 + 1] = k.id * 3.77 + side * 11.3;
        fa[n * 4 + 2] = v.ramp;
        fa[n * 4 + 3] = v.coreRamp;
        fb[n * 4] = v.intensity * (0.8 + 0.4 * s.strength);
        fb[n * 4 + 1] = v.length * pulse * (0.75 + 0.35 * s.strength);
        fb[n * 4 + 2] = v.radius;
        fb[n * 4 + 3] = 1.0;
        n++;
      }

      // --- heat haze behind the kart ---------------------------------------
      if (hazeN < MAX_FLAMES && ctx.quality.tier !== 'low') {
        socketPos(this.src, k, 'rearCentre', 0, 0.05, 1.4, tmpA);
        hp[hazeN * 3] = tmpA.x; hp[hazeN * 3 + 1] = tmpA.y; hp[hazeN * 3 + 2] = tmpA.z;
        ha[hazeN * 4] = s.strength * 0.9;
        ha[hazeN * 4 + 1] = k.id * 5.13;
        ha[hazeN * 4 + 2] = 2.4 * v.radius;
        ha[hazeN * 4 + 3] = 1.9 * v.radius;
        hazeN++;
      }

      // --- particle detail --------------------------------------------------
      const lodRaw = dist < 30 ? 1 : dist < 70 ? 0.5 : 0.2;
      const lod = k.isPlayer ? (lodRaw < 0.6 ? 0.6 : lodRaw) : lodRaw;
      const rate = lod * ctx.throttle * s.strength;
      const p = ctx.particles;
      const groundY = k.position.y - 0.6;

      s.accLick += 150 * rate * dt;
      while (s.accLick >= 1) {
        s.accLick -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        socketPos(this.src, k, side < 0 ? 'exhaustL' : 'exhaustR',
          side * 0.42, -0.02, 0.86, tmpA);
        this.dLick.ramp = s.variant === 'star' ? RAMP.RAINBOW
          : s.variant === 'ultra' ? RAMP.FLAME_BLUE : RAMP.FLAME;
        this.dLick.size = 0.34 * v.radius;
        this.dLick.speed = 6 + 5 * s.strength;
        p.emit(this.dLick, 1, tmpA, tmpB, k.velocity, groundY, 1);
      }

      s.accEmber += 34 * rate * dt;
      while (s.accEmber >= 1) {
        s.accEmber -= 1;
        socketPos(this.src, k, 'rearCentre', 0, 0.0, 1.0, tmpA);
        this.dEmber.ramp = s.variant === 'star' ? RAMP.RAINBOW : RAMP.EMBER;
        p.emit(this.dEmber, 1, tmpA, tmpB, k.velocity, groundY, 1);
      }

      s.accSmoke += 26 * rate * dt;
      while (s.accSmoke >= 1) {
        s.accSmoke -= 1;
        socketPos(this.src, k, 'rearCentre', 0, 0.1, 1.5, tmpA);
        p.emit(this.dSmoke, 1, tmpA, tmpB, k.velocity, groundY, 1);
      }
    }

    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.iFlame.needsUpdate = true;
      this.iFlame2.needsUpdate = true;
    }
    this.hazeGeo.instanceCount = hazeN;
    if (hazeN > 0) {
      this.iHaze.needsUpdate = true;
      this.iHazePos.needsUpdate = true;
    }
  }

  /** Standalone ignition for `burst('boostPop')` and the dev harness. */
  popAt(pos: THREE.Vector3, forward: THREE.Vector3, variant: BoostVariant, scale: number): void {
    const p = this.ctx.particles;
    const v = VARIANTS[variant];
    tmpB.copy(forward).multiplyScalar(-1).normalize();
    const groundY = pos.y - 0.6;
    this.dPopFlare.ramp = variant === 'star' ? RAMP.RAINBOW : RAMP.WHITE_SHARP;
    this.dPopFlare.size = 2.6 * v.radius * scale;
    p.emit(this.dPopFlare, 2, pos, tmpB, null, groundY, 1);
    this.dPopRing.ramp = this.dPopFlare.ramp;
    this.dPopRing.size = 2.6 * v.radius * scale;
    p.spawnPlane(this.dPopRing, pos, tmpB, 1, 1);
    this.dPopSpark.ramp = variant === 'star' ? RAMP.RAINBOW : RAMP.ORANGE_SPARK;
    p.emit(this.dPopSpark, Math.round(26 * this.ctx.throttle), pos, tmpB, null, groundY, scale);
    p.emit(this.dPopSmoke, Math.round(8 * this.ctx.throttle), pos, tmpB, null, groundY, scale);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.hazeMesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.hazeGeo.dispose();
    this.hazeMat.dispose();
    this.mesh.dispose();
    this.state.clear();
  }
}
