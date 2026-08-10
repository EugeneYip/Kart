/**
 * ============================================================================
 *  APEX KART — MOTION BLUR
 * ============================================================================
 *  Per-pixel camera motion blur by depth reprojection, plus a radial speed
 *  streak that ramps with boost.
 *
 *  How the velocity is obtained without a velocity buffer:
 *    reproject = prevViewProjection * inverse(currViewProjection)
 *  Multiplying the current NDC position (reconstructed from the depth buffer)
 *  by that matrix lands the fragment in the previous frame's clip space; the
 *  perspective divide gives the previous UV. `uv - prevUv` is the exact
 *  screen-space velocity for *camera* motion, which is the only motion that
 *  matters at 28 m/s. Sky pixels (depth 1.0) reproject correctly too, so
 *  cornering smears the horizon just like MK8 does.
 *
 *  Cost: one dependent texture fetch per tap, 8–14 taps, no extra buffers.
 * ============================================================================
 */

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const FRAGMENT = /* glsl */ `
uniform mat4 mbReproject;
uniform vec3 mbParams;     // x = camera strength, y = radial strength, z = max radius (uv)
uniform float mbJitter;

float mbRand(const in vec2 p) {
  return fract(sin(dot(p, vec2(41.3711, 289.1237))) * 43758.5453123);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {

  vec4 mbNdc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 mbPrev = mbReproject * mbNdc;
  float mbW0 = abs(mbPrev.w) < 1e-6 ? 1e-6 : mbPrev.w;
  vec2 mbPrevUv = (mbPrev.xy / mbW0) * 0.5 + 0.5;

  vec2 mbVel = (uv - mbPrevUv) * mbParams.x;

  // Radial streak — pure showmanship, weighted towards the frame edges.
  vec2 mbToEdge = uv - 0.5;
  float mbEdge = smoothstep(0.10, 0.62, length(mbToEdge));
  mbVel += mbToEdge * (mbParams.y * mbEdge);

  float mbLen = length(mbVel);
  if (mbLen < 6e-5) {
    outputColor = inputColor;
    return;
  }
  mbVel *= min(mbLen, mbParams.z) / mbLen;

  // Dithered tap offsets kill the banding a fixed kernel produces.
  float mbJ = mbRand(uv * 613.0 + mbJitter) - 0.5;
  vec4 mbAcc = inputColor;
  float mbW = 1.0;

  for (int mbI = 1; mbI <= MB_TAPS; ++mbI) {
    float mbT = (float(mbI) + mbJ) / float(MB_TAPS + 1) - 0.5;
    vec2 mbUvA = uv + mbVel * mbT;
    // Reject taps that leave the frame instead of clamping (no edge smearing).
    float mbInside = step(0.0, mbUvA.x) * step(mbUvA.x, 1.0) * step(0.0, mbUvA.y) * step(mbUvA.y, 1.0);
    // Triangular weighting: nearby taps count more, so slow motion stays sharp.
    float mbWeight = mbInside * (1.0 - abs(mbT) * 1.2);
    mbAcc += texture2D(inputBuffer, mbUvA) * mbWeight;
    mbW += mbWeight;
  }

  outputColor = mbAcc / max(mbW, 1e-4);
}
`;

export interface MotionBlurOptions {
  /** Tap count. 8 on medium, 12 on high, 14 on ultra. */
  taps?: number;
  /** Multiplier on the reprojected camera velocity. 1 = physically exact. */
  cameraStrength?: number;
  /** Maximum blur radius, as a fraction of the screen. Keeps cost bounded. */
  maxRadius?: number;
}

/**
 * Camera-reprojection motion blur. `setMatrices()` must be called once per
 * frame *before* `composer.render()`; RenderPipeline does that.
 */
export class MotionBlurEffect extends Effect {
  private readonly reproject: THREE.Matrix4;
  private readonly params: THREE.Vector3;

  private readonly prevViewProj = new THREE.Matrix4();
  private readonly currViewProj = new THREE.Matrix4();
  private readonly tmp = new THREE.Matrix4();
  private readonly probe = new THREE.Vector4();
  private hasPrev = false;

  /**
   * Largest screen-space velocity, in UV units, that this frame will produce —
   * sampled at the frame centre and corners. RenderPipeline uses it to skip the
   * whole pass when the camera is effectively still, which is the difference
   * between "the shader early-outs" and "we don't pay for the pass".
   */
  peakMotion = 0;

  /** 0..1 — boost/speed ramp supplied by the game. */
  speedIntensity = 0;
  /** Base strength on the reprojected velocity. */
  cameraStrength: number;
  /** Extra radial streak at speedIntensity = 1. */
  radialStrength = 0.028;

  constructor(opts: MotionBlurOptions = {}) {
    const uniforms = new Map<string, THREE.Uniform>([
      ['mbReproject', new THREE.Uniform(new THREE.Matrix4())],
      ['mbParams', new THREE.Uniform(new THREE.Vector3(1, 0, 0.035))],
      ['mbJitter', new THREE.Uniform(0)],
    ]);

    super('MotionBlurEffect', FRAGMENT, {
      // Reads the depth buffer AND samples the input buffer at offsets, so it
      // must own its EffectPass (postprocessing refuses to merge convolutions).
      attributes: (EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION) as EffectAttribute,
      blendFunction: BlendFunction.SRC,
      uniforms,
    });

    this.defines.set('MB_TAPS', String(Math.max(2, Math.round(opts.taps ?? 12))));
    this.cameraStrength = opts.cameraStrength ?? 0.85;

    this.reproject = uniforms.get('mbReproject')!.value as THREE.Matrix4;
    this.params = uniforms.get('mbParams')!.value as THREE.Vector3;
    this.params.z = opts.maxRadius ?? 0.035;
  }

  setTaps(taps: number): void {
    const v = String(Math.max(2, Math.round(taps)));
    if (this.defines.get('MB_TAPS') === v) return;
    this.defines.set('MB_TAPS', v);
    this.setChanged();
  }

  /**
   * Feed the current camera matrices. Call every frame, even when the pass is
   * disabled, otherwise the first re-enabled frame smears catastrophically.
   */
  setMatrices(camera: THREE.Camera, dt: number): void {
    this.currViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    if (!this.hasPrev) {
      this.prevViewProj.copy(this.currViewProj);
      this.hasPrev = true;
    }

    // reproject = prevVP * inverse(currVP)
    this.tmp.copy(this.currViewProj).invert();
    this.reproject.multiplyMatrices(this.prevViewProj, this.tmp);
    this.prevViewProj.copy(this.currViewProj);

    // Normalise to a 60 Hz shutter so blur length doesn't depend on frame rate.
    const shutter = dt > 1e-5 ? Math.min(2.5, 1 / (60 * dt)) : 1;
    this.params.x = this.cameraStrength * shutter;
    this.params.y = this.radialStrength * this.speedIntensity * this.speedIntensity;

    const jitter = this.uniforms.get('mbJitter');
    if (jitter) jitter.value = (jitter.value as number + 0.618034) % 1;

    this.peakMotion = this.measurePeakMotion();
  }

  /**
   * Run the shader's reprojection on five NDC probes (centre + corners) at a
   * mid-scene depth and return the largest resulting UV displacement. Same
   * maths as the fragment shader, five times on the CPU.
   */
  private measurePeakMotion(): number {
    let peak = this.params.y; // the radial streak is motion too
    for (let i = 0; i < 5; i++) {
      const nx = i === 0 ? 0 : i <= 2 ? -0.8 : 0.8;
      const ny = i === 0 ? 0 : i % 2 === 1 ? -0.8 : 0.8;
      // z = 0.6 in NDC ~ a few tens of metres out, where most of the frame is.
      this.probe.set(nx, ny, 0.6, 1).applyMatrix4(this.reproject);
      const w = Math.abs(this.probe.w) < 1e-6 ? 1e-6 : this.probe.w;
      const du = ((this.probe.x / w) * 0.5 + 0.5) - (nx * 0.5 + 0.5);
      const dv = ((this.probe.y / w) * 0.5 + 0.5) - (ny * 0.5 + 0.5);
      const len = Math.hypot(du, dv) * Math.abs(this.params.x);
      if (len > peak) peak = len;
    }
    return Number.isFinite(peak) ? peak : 0;
  }

  /** Forget history — call after a camera cut so the cut frame isn't smeared. */
  resetHistory(): void {
    this.hasPrev = false;
    this.reproject.identity();
    this.params.x = 0;
    this.peakMotion = 0;
  }
}
