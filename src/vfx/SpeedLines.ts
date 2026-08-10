/**
 * ============================================================================
 *  SPEED LINES — the screen-space layer
 * ============================================================================
 *  One full-screen NDC quad, one draw call, one shader. It owns every effect
 *  that lives in screen space rather than in the world:
 *
 *    streaks   radial comet streaks that ramp in above ~70 % of top speed and
 *              go hard on boost — sharp head, long tail toward the centre,
 *              three overlapping angular bands so they never read as a fan
 *    tunnel    on boost the rim washes cool blue and a compression ring pulls
 *              inward, which reads as the world funnelling past the camera
 *    impact    a "speed impact" frame — white bloom + a dense high-frequency
 *              streak burst — fired on a big boost pickup
 *    flash     the full-screen colour flash used by lightning / star / finish
 *    ink       a squid-ink splat that sags, drips and slides off the bottom
 *
 *  The quad bypasses the view matrix entirely (`gl_Position = position.xy`), so
 *  it is correct no matter where the camera is and costs nothing to transform.
 *  It is skipped outright when every channel is idle.
 *
 *  It also publishes `fovBoost`, which the chase camera adds to its FOV — the
 *  streaks and the lens widening have to happen on the same curve or the boost
 *  feels disconnected.
 * ============================================================================
 */

import * as THREE from 'three';
import { LAYERS, RENDER_ORDER } from '@/core/Config';
import { clamp01, damp } from '@/core/MathUtils';
import type { VfxContext } from './ParticleSystem';

const OVERLAY_VERT = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const OVERLAY_FRAG = /* glsl */ `
precision highp float;
#include <common>

uniform float uTime;
uniform float uSpeed;    // 0..1 base streak intensity
uniform float uBoost;    // 0..1 boost punch
uniform float uImpact;   // 0..1 speed-impact frame
uniform vec4  uFlash;    // rgb, amount
uniform vec2  uInk;      // coverage, drip age
uniform vec2  uAspect;   // (aspect, 1)

varying vec2 vUv;

float h21(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p + 19.19);
  return fract((p.x + p.y) * p.x);
}

/**
 * One band of radial streaks: "count" angular bins, each holding a comet that
 * travels outward on its own phase and speed.
 */
float streakBand(float ang01, float r, float count, float seed, float t, float lenScale) {
  float f = ang01 * count;
  float bin = floor(f);
  float frac = fract(f) - 0.5;
  float h1 = h21(vec2(bin, seed));
  float h2 = h21(vec2(bin, seed + 31.7));
  float h3 = h21(vec2(bin, seed + 71.3));

  // Ease-out travel: slow near the centre, whipping past at the rim.
  float head = fract(h1 + t * (0.55 + h2 * 0.95));
  float pos = mix(0.05, 1.45, head * head);
  float len = (0.07 + 0.20 * h3) * lenScale;

  float d = r - pos;
  // Sharp head, tail trailing inward.
  float body = smoothstep(-len, -len * 0.04, d) * smoothstep(0.03, 0.0, d);
  // Thickness is measured as a perpendicular distance in screen units, not as a
  // fraction of the angular bin — otherwise a low-count band draws fat wedges
  // instead of lines.
  float arc = abs(frac) / count * 6.2831853 * max(r, 0.08);
  float hw = 0.0035 + 0.0075 * h2;
  float w = smoothstep(hw, hw * 0.15, arc);
  return body * w * (0.40 + 0.60 * h3);
}

void main() {
  vec2 p = (vUv - 0.5) * 2.0 * uAspect;
  float r = length(p);
  float ang01 = atan(p.y, p.x) * 0.15915494 + 0.5;

  vec3 add = vec3(0.0);
  float cover = 0.0;

  // --- speed streaks -------------------------------------------------------
  if (uSpeed > 0.002) {
    float t = uTime * (1.3 + 2.8 * uSpeed);
    float s = streakBand(ang01, r, 47.0, 3.1, t, 1.0) * 0.80
            + streakBand(ang01, r, 23.0, 17.7, t * 0.83, 1.55) * 0.40
            + streakBand(ang01, r, 89.0, 51.3, t * 1.27, 0.70) * 0.34;
    // Keep the middle of the screen clear: streaks belong in the periphery,
    // and this lands in the HDR buffer where AgX's toe amplifies every add.
    s *= smoothstep(0.28, 0.95, r) * uSpeed;
    vec3 col = mix(vec3(1.0), vec3(0.55, 0.78, 1.0), smoothstep(0.35, 1.25, r));
    add += col * s * (0.22 + 1.1 * uBoost);
  }

  // --- boost tunnel --------------------------------------------------------
  if (uBoost > 0.002) {
    // These numbers look absurdly small; they are not. Measured against AgX,
    // a linear add of 0.066 already lifts a dark sky to 38 % sRGB, so the whole
    // tunnel wash has to live under ~0.03 to stay a hint rather than a fog.
    float rim = smoothstep(0.52, 1.40, r);
    add += vec3(0.30, 0.58, 1.0) * rim * uBoost * 0.025;
    // Compression ring: the mouth of the tunnel, pulled in by boost strength.
    float rr = (r - (0.88 - 0.20 * uBoost)) * 6.5;
    add += vec3(0.72, 0.86, 1.0) * exp(-rr * rr) * uBoost * 0.035;
    // Darken the extreme corners so the centre of the screen pops forward.
    cover += smoothstep(0.95, 1.65, r) * uBoost * 0.34;
  }

  // --- speed-impact frame --------------------------------------------------
  if (uImpact > 0.002) {
    float t2 = uTime * 7.0;
    float s = streakBand(ang01, r, 137.0, 91.7, t2, 2.4)
            + streakBand(ang01, r, 61.0, 13.3, t2 * 1.35, 3.2) * 0.8;
    add += vec3(1.0) * s * uImpact * smoothstep(0.02, 0.55, r) * 2.6;
    add += vec3(1.0) * uImpact * uImpact * 0.7;
  }

  // --- colour flash --------------------------------------------------------
  // Cubed on purpose. This lands in the HDR buffer *before* AgX, and AgX has a
  // strong toe: a linear 0.06 add already lifts the whole frame by a third of a
  // stop. So a 0.2 flash has to stay tiny while a 1.0 flash (lightning, finish
  // line) still has to be a genuine whiteout.
  float fa = uFlash.a;
  add += uFlash.rgb * (fa * fa * fa * 1.7);

  // --- squid ink -----------------------------------------------------------
  vec3 inkRgb = vec3(0.0);
  float inkA = 0.0;
  if (uInk.x > 0.002) {
    float age = uInk.y;
    float acc = 0.0;
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      vec2 c = vec2(h21(vec2(fi, 3.0)) * 1.7 - 0.85, h21(vec2(fi, 9.0)) * 1.3 - 0.65);
      c.x *= uAspect.x;
      float rad = 0.30 + 0.32 * h21(vec2(fi, 21.0));
      // Sag downward, stretching as it goes — a drip, not a fade.
      vec2 d = p - c + vec2(0.0, age * (0.55 + 0.95 * h21(vec2(fi, 33.0))));
      d.y /= (1.0 + age * 2.1);
      float wob = 1.0 + 0.17 * sin(atan(d.y, d.x) * (3.0 + fi) + fi * 2.1);
      acc += smoothstep(rad * wob, rad * wob * 0.52, length(d));
    }
    inkA = clamp(acc, 0.0, 1.0) * uInk.x;
    inkA *= 0.86 + 0.14 * sin(p.x * 29.0 + p.y * 17.0);
    inkA = clamp(inkA, 0.0, 1.0);
    // Wet ink is not flat black: it has a faint violet sheen.
    inkRgb = vec3(0.035, 0.024, 0.062) + vec3(0.10, 0.06, 0.16) * (1.0 - inkA);
    cover = max(cover, inkA);
  }

  if (cover <= 0.002 && dot(add, add) <= 1.0e-6) discard;

  gl_FragColor = vec4(add + inkRgb * inkA, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb, clamp(cover, 0.0, 1.0));
}
`;

export class SpeedLines {
  private ctx: VfxContext;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;

  private speedTarget = 0;
  private speed = 0;
  private boostTarget = 0;
  private boost = 0;
  private impact = 0;

  private flashAmount = 0;
  private flashLeft = 0;
  private flashDur = 0;
  private readonly flashColor = new THREE.Color();

  private inkLeft = 0;
  private inkDur = 0;

  constructor(ctx: VfxContext) {
    this.ctx = ctx;

    // A 2×2 quad in NDC. The vertex shader ignores every matrix.
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
    ]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: 0 },
        uBoost: { value: 0 },
        uImpact: { value: 0 },
        uFlash: { value: new THREE.Vector4(1, 1, 1, 0) },
        uInk: { value: new THREE.Vector2(0, 0) },
        uAspect: { value: new THREE.Vector2(1.777, 1) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'vfx-speedlines';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = RENDER_ORDER.UI3D;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    this.mesh.layers.enable(LAYERS.BLOOM);
    this.mesh.layers.enable(LAYERS.NO_REFLECT);
    ctx.root.add(this.mesh);
  }

  // -------------------------------------------------------------------------
  // Drive
  // -------------------------------------------------------------------------

  /** `speed` and `boost` are both 0..1; the manager derives them from KartState. */
  set(speed: number, boost: number): void {
    this.speedTarget = clamp01(speed);
    this.boostTarget = clamp01(boost);
  }

  /** White-out + radial streak burst. Used for big boosts and bullet launches. */
  impactFrame(amount: number): void {
    this.impact = Math.max(this.impact, clamp01(amount));
  }

  flash(color: THREE.ColorRepresentation, amount: number, seconds: number): void {
    // A weaker flash never cuts a stronger one short.
    const amt = clamp01(amount);
    if (amt * seconds < this.flashAmount * this.flashLeft) return;
    this.flashColor.set(color);
    this.flashAmount = amt;
    this.flashDur = Math.max(0.02, seconds);
    this.flashLeft = this.flashDur;
  }

  /** Squid ink over the lens. */
  ink(seconds: number): void {
    this.inkDur = Math.max(0.4, seconds);
    this.inkLeft = this.inkDur;
  }

  clearInk(): void { this.inkLeft = 0; }

  resize(width: number, height: number): void {
    (this.mat.uniforms.uAspect.value as THREE.Vector2)
      .set(Math.max(0.2, width / Math.max(1, height)), 1);
  }

  /** 0..1 how hard the screen effects are pushing — feeds the post chain. */
  get intensity(): number {
    return clamp01(this.speed * 0.75 + this.boost * 0.55 + this.impact * 0.5);
  }

  /**
   * Degrees of extra FOV the camera should adopt. Kept modest on purpose —
   * ChaseCamera adds its own boost kick on top of this.
   */
  get fovBoost(): number {
    return this.speed * 1.8 + this.boost * 5.0 + this.impact * 3.0;
  }

  get inkAmount(): number {
    return this.inkDur <= 0 ? 0 : clamp01(this.inkLeft / this.inkDur);
  }

  update(): void {
    const dt = this.ctx.dt;
    const u = this.mat.uniforms;

    // Streaks build slowly and drop fast — the opposite feels mushy.
    this.speed = damp(this.speed, this.speedTarget,
      this.speedTarget > this.speed ? 0.10 : 0.06, dt);
    this.boost = damp(this.boost, this.boostTarget,
      this.boostTarget > this.boost ? 0.035 : 0.10, dt);
    this.impact = Math.max(0, this.impact - dt * 5.5);

    let flashOut = 0;
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      // Instant attack, linear fall — the shader's cube supplies the snap.
      const k = clamp01(this.flashLeft / this.flashDur);
      flashOut = this.flashAmount * k;
      if (this.flashLeft <= 0) { this.flashLeft = 0; this.flashAmount = 0; }
    }

    let inkCover = 0;
    let inkAge = 0;
    if (this.inkLeft > 0) {
      this.inkLeft -= dt;
      const k = clamp01(this.inkLeft / this.inkDur);
      inkAge = 1 - k;
      // Full coverage for the first third, then it drips clear.
      inkCover = k > 0.66 ? 1 : k / 0.66;
      if (this.inkLeft <= 0) this.inkLeft = 0;
    }

    u.uTime.value = this.ctx.time;
    u.uSpeed.value = this.speed;
    u.uBoost.value = this.boost;
    u.uImpact.value = this.impact;
    const f = u.uFlash.value as THREE.Vector4;
    f.set(this.flashColor.r, this.flashColor.g, this.flashColor.b, flashOut);
    (u.uInk.value as THREE.Vector2).set(inkCover, inkAge);

    this.mesh.visible =
      this.speed > 0.004 || this.boost > 0.004 || this.impact > 0.004 ||
      flashOut > 0.002 || inkCover > 0.002;
  }

  clear(): void {
    this.speed = this.speedTarget = 0;
    this.boost = this.boostTarget = 0;
    this.impact = 0;
    this.flashLeft = 0;
    this.flashAmount = 0;
    this.inkLeft = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
