/**
 * ============================================================================
 *  FOXY KART — MOTION BLUR
 * ============================================================================
 *  Per-pixel camera motion blur by depth reprojection, plus a radial speed
 *  streak that ramps with boost, plus a **subject mask** that keeps the player
 *  kart sharp.
 *
 *  How the velocity is obtained without a velocity buffer:
 *    reproject = prevViewProjection * inverse(currViewProjection)
 *  Multiplying the current NDC position (reconstructed from the depth buffer)
 *  by that matrix lands the fragment in the previous frame's clip space; the
 *  perspective divide gives the previous UV. `uv - prevUv` is the exact
 *  screen-space velocity for *camera* motion under the assumption that the
 *  world is static.
 *
 *  WHY THAT ASSUMPTION NEEDED A MASK
 *  ---------------------------------
 *  The player kart is the one object in frame that is *not* static in the
 *  camera's frame: the chase camera is rigidly bolted 7 m behind it, so the
 *  kart's true screen-space velocity is ~0 px. Camera reprojection cannot know
 *  that. It reads the kart's depth (5–8 m — the nearest thing in frame, so the
 *  largest parallax) and reports a large velocity, and the kart smeared harder
 *  than anything else on screen. Measured at 38 m/s, 60 Hz shutter, 1920 wide,
 *  with the old constants: 22 px of convolution on a subject with 0 px of
 *  motion. In a blind A/B against MK8DX that was *the* giveaway.
 *
 *  Three ways to fix it were on the table:
 *
 *   1. A real per-object velocity buffer. Correct for everything, including
 *      rival karts and spinning wheels — and the honest answer is it does not
 *      fit: it needs an extra full-scene pass with per-object previous world
 *      matrices, an MRT or a second render target, and a velocity variant of
 *      every material in the game (four other agents' files). The pass list
 *      currently contains exactly two full-scene renders and the whole post
 *      chain costs ~17 ms of a 16.6 ms budget already.
 *   2. Attenuate by screen-space distance from the frame centre. Cheap and
 *      wrong: it protects the road *ahead* — the one thing that must streak to
 *      sell speed — it stops protecting the kart the moment a drift swings it
 *      off-centre, and it fails outright for the `kart-hero` and `driver-eye`
 *      framings where the subject is nowhere near the centre.
 *   3. Mask the subject. What we do. `RenderPipeline` renders *only* the player
 *      kart's model subtree into a quarter-resolution RGBA8 target with a flat
 *      override material (~15 draw calls, ~25 k triangles, no lighting, no
 *      shadows, no post) and hands the result here. This shader scales the
 *      velocity by `1 - mask`, so the kart keeps a 10 % residual smear (its
 *      wheels and body genuinely do move a little) while the world behind it
 *      streaks at full strength.
 *
 *  A stencil was considered and rejected: it would force `stencilBuffer: true`
 *  on the composer, which switches every depth-sampling pass to
 *  DEPTH24_STENCIL8, and it needs `stencilWrite` set on kart materials owned by
 *  another agent.
 *
 *  Cost: one dependent texture fetch per tap, 8–14 taps, plus one bilinear
 *  mask fetch, plus the quarter-res mask render.
 * ============================================================================
 */

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const FRAGMENT = /* glsl */ `
uniform mat4 mbReproject;
uniform vec3 mbParams;     // x = camera strength, y = radial strength, z = max radius (uv)
uniform float mbJitter;

#ifdef MB_MASK
uniform sampler2D mbMask;
uniform float mbMaskKeep;  // residual blur left on the masked subject
#endif

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

#ifdef MB_MASK
  // Subject mask. The target is quarter-resolution with linear filtering, so a
  // single fetch already feathers the silhouette over ~4 full-res pixels; the
  // smoothstep biases towards *protecting* edge pixels, which dilates the
  // silhouette by about one quarter-res texel. Erring that way means the kart
  // never picks up a smeared rim; erring the other way would put a sharp halo
  // of unblurred background around it, which reads as a compositing error.
  float mbSubject = smoothstep(0.12, 0.55, texture2D(mbMask, uv).r);
  mbVel *= mix(1.0, mbMaskKeep, mbSubject);
#endif

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
#ifdef MB_MASK
    // Do not drag the subject out over the world. A tap that lands on the kart
    // while the centre pixel is *not* on the kart is rejected, so the streaks
    // behind the kart are made of road, not of red bodywork.
    mbWeight *= 1.0 - smoothstep(0.12, 0.55, texture2D(mbMask, mbUvA).r) * (1.0 - mbSubject);
#endif
    mbAcc += texture2D(inputBuffer, mbUvA) * mbWeight;
    mbW += mbWeight;
  }

  outputColor = mbAcc / max(mbW, 1e-4);
}
`;

export interface MotionBlurOptions {
  /** Tap count. 8 on medium, 12 on high, 14 on ultra. */
  taps?: number;
  /**
   * Multiplier on the reprojected camera velocity. 1 would be a 360° shutter,
   * i.e. the blur trail spans the entire distance travelled in one frame.
   * Real cameras run a 180° shutter (0.5) and games habitually go lower still,
   * because a game frame is a *sample* the player is trying to read, not a
   * frame of a film they are watching. See DEFAULT_CAMERA_STRENGTH.
   */
  cameraStrength?: number;
  /** Maximum blur radius, as a fraction of the screen. Keeps cost bounded. */
  maxRadius?: number;
}

/**
 * Blur length ceiling, as a fraction of screen width.
 *
 * This is the number that was destroying the image. It was 0.035, which on a
 * 1920-wide frame is **67 px of convolution**, and because the shader clamps
 * rather than scales, *every* pixel whose reprojected velocity exceeded the
 * ceiling got the full 67 px — so at speed the near half of the frame was a
 * uniform 67 px smear. 0.008 is 15 px at 1920 and 8 px at 1080, which is about
 * what a 180° shutter on a real 60 Hz camera would give for the near field.
 */
const DEFAULT_MAX_RADIUS = 0.008;

/**
 * Was 0.85, with a comment claiming "1 = physically exact". It is not: the
 * reprojection assumes a static world, so the number it produces for the near
 * field (road, kerb, kart) is an over-estimate of what a viewer perceives as
 * motion, and a 360° shutter is not what any camera does anyway. 0.3 keeps the
 * near-field road and kerb streaking clearly — 8 px at 21 m/s, 15 px (clamped)
 * under boost — while the mid-field stays readable at 2–3 px.
 */
const DEFAULT_CAMERA_STRENGTH = 0.3;

/**
 * Radial streak at speedIntensity = 1, in UV units at the frame corner.
 *
 * Was 0.028, which adds up to 54 px at 1920 *on top of* the camera term, is
 * completely independent of depth or actual motion, and therefore smeared the
 * legible edges of the frame — including the kart's own outline at the boost
 * FOV of 74°. 0.006 is 8 px at the extreme corner and 0 px inside a radius of
 * 0.10, which is a streak you notice without one you cannot see past.
 */
const DEFAULT_RADIAL_STRENGTH = 0.006;

/** Fraction of the blur left on the masked subject. */
const DEFAULT_MASK_KEEP = 0.1;

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
  radialStrength = DEFAULT_RADIAL_STRENGTH;

  constructor(opts: MotionBlurOptions = {}) {
    const uniforms = new Map<string, THREE.Uniform>([
      ['mbReproject', new THREE.Uniform(new THREE.Matrix4())],
      ['mbParams', new THREE.Uniform(new THREE.Vector3(1, 0, DEFAULT_MAX_RADIUS))],
      ['mbJitter', new THREE.Uniform(0)],
      ['mbMask', new THREE.Uniform(null)],
      ['mbMaskKeep', new THREE.Uniform(DEFAULT_MASK_KEEP)],
    ]);

    super('MotionBlurEffect', FRAGMENT, {
      // Reads the depth buffer AND samples the input buffer at offsets, so it
      // must own its EffectPass (postprocessing refuses to merge convolutions).
      attributes: (EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION) as EffectAttribute,
      blendFunction: BlendFunction.SRC,
      uniforms,
    });

    this.defines.set('MB_TAPS', String(Math.max(2, Math.round(opts.taps ?? 12))));
    this.cameraStrength = opts.cameraStrength ?? DEFAULT_CAMERA_STRENGTH;

    this.reproject = uniforms.get('mbReproject')!.value as THREE.Matrix4;
    this.params = uniforms.get('mbParams')!.value as THREE.Vector3;
    this.params.z = opts.maxRadius ?? DEFAULT_MAX_RADIUS;
  }

  setTaps(taps: number): void {
    const v = String(Math.max(2, Math.round(taps)));
    if (this.defines.get('MB_TAPS') === v) return;
    this.defines.set('MB_TAPS', v);
    this.setChanged();
  }

  /** Current tap count. Reported by the resolution-budget log and the perf HUD. */
  get tapCount(): number {
    return Number(this.defines.get('MB_TAPS') ?? 0);
  }

  /**
   * Supply (or clear) the subject mask. White = keep sharp. Toggling between
   * null and a texture recompiles the pass, so RenderPipeline calls this once
   * when the player's kart model becomes available and never per-frame.
   */
  setSubjectMask(texture: THREE.Texture | null): void {
    const u = this.uniforms.get('mbMask');
    if (!u) return;
    const had = this.defines.has('MB_MASK');
    u.value = texture;
    if (texture && !had) {
      this.defines.set('MB_MASK', '1');
      this.setChanged();
    } else if (!texture && had) {
      this.defines.delete('MB_MASK');
      this.setChanged();
    }
  }

  /** How much blur survives on the masked subject. 0 = perfectly sharp. */
  setMaskKeep(v: number): void {
    const u = this.uniforms.get('mbMaskKeep');
    if (u) u.value = Math.max(0, Math.min(1, v));
  }

  get hasSubjectMask(): boolean { return this.defines.has('MB_MASK'); }

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
    // The reprojected displacement is proportional to dt and this is
    // proportional to 1/dt, so the product — the blur length in pixels — is
    // frame-rate invariant. Clamped at both ends: a 5 fps hitch must not
    // produce a 12x-length streak, and a 240 Hz frame must not vanish.
    const shutter = dt > 1e-5 ? Math.min(2.5, Math.max(0.15, 1 / (60 * dt))) : 1;
    this.params.x = this.cameraStrength * shutter;
    this.params.y = this.radialStrength * this.speedIntensity * this.speedIntensity;

    const jitter = this.uniforms.get('mbJitter');
    if (jitter) jitter.value = (jitter.value as number + 0.618034) % 1;

    this.peakMotion = this.measurePeakMotion();
  }

  /**
   * Run the shader's reprojection on NDC probes (centre + corners, at two
   * depths) and return the largest resulting UV displacement. Same maths as the
   * fragment shader, on the CPU.
   *
   * The depths matter and the old code got them wrong. NDC z relates to view
   * distance as `d = 2fn / (f + n - z(f - n))`; with this game's near = 0.15 and
   * far = 4000 that makes the old probe depth of `z = 0.6` equal to **0.75 m**,
   * not the "few tens of metres" its comment claimed — i.e. it measured the
   * blur at a distance where no geometry exists, in the region of maximum
   * parallax. 0.94 is ~5 m (road under the nose) and 0.985 is ~20 m (the bulk
   * of a chase frame); the gate wants the max of those.
   */
  private measurePeakMotion(): number {
    let peak = this.params.y; // the radial streak is motion too
    for (let d = 0; d < 2; d++) {
      const z = d === 0 ? 0.94 : 0.985;
      for (let i = 0; i < 5; i++) {
        const nx = i === 0 ? 0 : i <= 2 ? -0.8 : 0.8;
        const ny = i === 0 ? 0 : i % 2 === 1 ? -0.8 : 0.8;
        this.probe.set(nx, ny, z, 1).applyMatrix4(this.reproject);
        const w = Math.abs(this.probe.w) < 1e-6 ? 1e-6 : this.probe.w;
        const du = ((this.probe.x / w) * 0.5 + 0.5) - (nx * 0.5 + 0.5);
        const dv = ((this.probe.y / w) * 0.5 + 0.5) - (ny * 0.5 + 0.5);
        const len = Math.hypot(du, dv) * Math.abs(this.params.x);
        if (len > peak) peak = len;
      }
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
