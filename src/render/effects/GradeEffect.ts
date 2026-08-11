/**
 * ============================================================================
 *  APEX KART — TONE MAP + COLOUR GRADE ("the look")
 * ============================================================================
 *  This single effect owns *everything* between the HDR scene buffer and the
 *  display-referred image:
 *
 *    exposure -> tone map (+look) -> black/white point -> lift/gamma/gain
 *    -> pivot S-curve -> saturation + vibrance -> 32³ 3D LUT -> flash -> shake
 *
 *  WHY IT ALSO DOES TONE MAPPING
 *  -----------------------------
 *  It used to be `ToneMappingEffect` (three's AgX) followed by this. Two
 *  problems with that:
 *
 *    1. three's AgX is the *base* AgX transform with the "look" step removed.
 *       Base AgX deliberately desaturates as it approaches the shoulder and has
 *       a very soft toe, so a bright scene lands as flat milky grey. Blender
 *       ships the same sigmoid with a look transform on top (offset / slope /
 *       power / saturation applied in the normalised log domain) — that is what
 *       makes AgX look "graded" rather than "raw". We need that step, so we own
 *       the operator.
 *    2. three's tone mapping shader chunk reads `toneMappingExposure`, which the
 *       renderer only uploads on `refreshMaterial`. Exposure changes therefore
 *       did not reliably reach the shader. Our own uniform always does.
 *
 *  Cost is unchanged: this effect already merged into the same EffectPass as
 *  bloom / vignette, so folding the operator in removes a handful of ALU ops
 *  and one function call. No extra pass, no extra texture fetch.
 *
 *  COLOUR SPACE
 *  ------------
 *  In: scene-referred linear HDR (bloom already added). Tone mapping produces
 *  display-referred linear; we encode to sRGB to grade — which is the space
 *  lift/gamma/gain and film LUTs are defined in — then decode back to linear so
 *  the composer's final output encode stays correct.
 * ============================================================================
 */

import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

export type GradePresetName = 'day' | 'sunset' | 'night' | 'storm';

/**
 * Which tone-mapping operator the look pass uses. Kept switchable because it
 * is the single highest-impact decision in the whole chain, and being able to
 * A/B it on a live frame is worth the one shader define.
 *
 *  - `agx-punchy`  AgX sigmoid + Blender-style look transform. Ships as default.
 *  - `agx`         Plain AgX, identical to THREE.AgXToneMapping.
 *  - `aces`        ACES filmic (RRT+ODT fit). Contrasty but skews hue.
 *  - `neutral`     Khronos PBR Neutral. Hue-preserving, very soft.
 */
export type ToneMapName = 'agx-punchy' | 'agx' | 'aces' | 'neutral';

const TONE_MAP_DEFINE: Record<ToneMapName, string> = {
  'agx-punchy': '0',
  agx: '1',
  aces: '2',
  neutral: '3',
};

/** Per-theme grading recipe. Also carries hints the pipeline reads. */
export interface GradePreset {
  /** Linear exposure multiplier applied before the tone map. */
  exposure: number;
  /**
   * AgX look transform, applied in the normalised log domain:
   * `pow(x * slope + offset, power)` then saturation about luma.
   * `power > 1` deepens the shadows; `sat > 1` undoes AgX's desaturation.
   */
  lookSlope: number;
  lookOffset: number;
  lookPower: number;
  lookSat: number;

  /** Input range remap, in sRGB-encoded space. This is what creates real blacks. */
  blackPoint: number;
  whitePoint: number;

  /**
   * SHADOW TOE. The black point above is a *hard* clip: everything below it
   * became exactly 0 and every shadow in the frame lost its detail at once.
   * Measured on a gameplay frame, a kart sitting in the grandstand shadow read
   * ~15 % luminance while a wall three metres away read ~250/255 — an 8:1
   * mismatch inside one frame, and the shadow half of it was unrecoverable
   * because the grade had already thrown the information away.
   *
   * `toeKnee` is where the toe stops and the straight portion begins (in
   * post-range-map units), `toeFloor` is the value that input 0 lands on, and
   * `toeGamma < 1` *expands* shadow separation inside the toe rather than
   * compressing it. The curve is C0-continuous with the straight portion at the
   * knee and monotonic everywhere, so it cannot invert or band.
   */
  toeKnee: number;
  toeFloor: number;
  toeGamma: number;

  /**
   * HIGHLIGHT SHOULDER. Painted white lines and kerbs were landing on exactly
   * 1.0 — pure #FFF — which clips, kills the paint's own texture, and leaves
   * SMAA nothing to anti-alias along the line edge. `shoulderKnee` is where the
   * roll-off starts and `shoulderCeil` is where 1.0 lands; slope continuity at
   * the knee is solved for, not eyeballed.
   */
  shoulderKnee: number;
  shoulderCeil: number;

  /** Added into the shadows, per channel. */
  lift: readonly [number, number, number];
  /** Mid-tone gamma, per channel. >1 brightens mids. */
  gamma: readonly [number, number, number];
  /** Highlight multiplier, per channel. */
  gain: readonly [number, number, number];

  /** Pivot-power S-curve strength. 1 = no change. */
  contrast: number;
  /** Where the S-curve pivots. Lower = shadows deepen more than highlights lift. */
  pivot: number;

  saturation: number;
  /** Extra saturation weighted towards *low-chroma* pixels. Keeps skies and
   *  foliage rich without turning reds radioactive. */
  vibrance: number;

  /** LUT split-tone multipliers. */
  shadowTint: readonly [number, number, number];
  midTint: readonly [number, number, number];
  highTint: readonly [number, number, number];
  /** Extra film contrast baked into the LUT. */
  lutContrast: number;
  /** How much of the LUT to apply, 0..1. */
  lutIntensity: number;

  /** Pipeline hints — bloom / vignette per theme. */
  bloomIntensity: number;
  vignetteDarkness: number;
  vignetteOffset: number;
}

/**
 * TUNING NOTES — measured, not guessed. Every number below was chosen by
 * probing a real `chase-straight` gameplay frame (`__POST__.probe()`).
 *
 * The chain this replaced (three's AgX + a saturation of 1.12) versus this one,
 * both on a `chase-straight` gameplay frame:
 *
 *                       meanLuma  meanSat  stdLuma     p1   blown  crushed
 *   old chain              0.762    0.130    0.145  0.414   8.9 %    0.0 %
 *   this chain             0.40     0.59     0.215  0.032   0.0 %    0.4 %
 *
 * 4.5x the chroma, +48 % luma spread, a black floor that is actually black
 * instead of 41 % grey, and the blown-highlight veil gone. The old numbers are
 * the numeric signature of "milky": everything squeezed into [0.41, 1.0].
 *
 * Operator choice, measured on one identical frame with the grade bypassed so
 * only the tone map differs:
 *
 *                  meanSat  stdLuma      p95   blown
 *   three's AgX      0.2505   0.1935   0.8142  0.06 %   <- was the default
 *   ACES filmic      0.4453   0.2238   0.7900  0.00 %
 *   PBR Neutral      0.5212   0.1919   0.7054  0.00 %
 *
 * AgX is by a wide margin the most desaturating of the three, which is why the
 * frame read grey — but it also has the most highlight headroom and no hue skew,
 * so the fix is to restore its missing look transform rather than swap operator.
 *
 *  - `lookSat 1.45` is the reference AgX "punchy" look value. It restores the
 *    chroma the AgX sigmoid removes, and it has to happen *inside* the operator
 *    (in the log domain, before the outset matrix) — a saturation control after
 *    tone mapping can only scale chroma that survived, which is why the old
 *    `saturation: 1.12` did nothing you could see.
 *  - `lookPower` is the shadow toe. It is very strong: 1.34 crushed 15 % of the
 *    frame to black. 1.10 is the most it can take on this scene.
 *  - `pivot 0.42` biases the S-curve towards deepening shadows rather than
 *    blowing highlights, since the sky is already the brightest thing in frame.
 *  - `exposure` is the ONE knob to retrim when world lighting changes, and it
 *    has needed it twice. On this scene *lower* exposure buys both saturation
 *    and contrast, because less of the image lands in the AgX shoulder where the
 *    operator desaturates — so it is not simply a brightness control.
 *
 *    Each preset is calibrated against its OWN sky/lighting preset (measuring
 *    the `night` grade under a daylight sky tells you nothing). `chase-straight`,
 *    camera locked, after Lighting settled:
 *
 *      preset  exposure  meanLuma  meanSat  stdLuma     p1    p95  crushed
 *      day       0.70       ~0.44     0.58     0.13   0.16   0.65    0.2 %
 *      sunset    1.70       ~0.40     0.57     0.20   0.11   0.70    0.0 %
 *      night     3.10       ~0.28     0.76     0.13   0.06   0.58    0.4 %
 *      storm     1.45        0.345    0.383    0.152  0.100  0.571   0.0 %
 *
 *    `night` was the bad one: at its old exposure it measured meanLuma 0.043
 *    with 17.7 % of the frame crushed to pure black, because a 1.24 shadow toe
 *    on an already-black frame is the wrong tool. Its toe is now 1.06 and
 *    exposure carries the load.
 *
 *    Caveat worth keeping: `p1` is strongly framing-dependent (this framing is
 *    an open, fully-lit straight with no deep shadow in it), so read meanLuma,
 *    meanSat and stdLuma first and treat p1 as a crush alarm rather than a
 *    target. Retrim with `RenderPipeline.setExposure()`; re-measure with
 *    `__POST__.autoCalibrate()`.
 */
export const GRADE_PRESETS: Record<GradePresetName, GradePreset> = {
  // Bright, punchy, Nintendo-saturated. Warm sun, cool sky bounce in shadow.
  day: {
    exposure: 0.7,
    lookSlope: 1.0,
    lookOffset: 0.0,
    lookPower: 1.2,
    lookSat: 1.45,
    blackPoint: 0.02,
    // Was 0.995, which mapped sRGB 0.975 and everything above it onto exactly
    // 1.0 — that is the "kerbs and painted lines clip to #FFF" defect. Above 1
    // there is headroom for the shoulder to roll into.
    whitePoint: 1.04,
    toeKnee: 0.1,
    toeFloor: 0.017,
    toeGamma: 0.72,
    shoulderKnee: 0.86,
    shoulderCeil: 0.972,
    lift: [0.0, 0.004, 0.014],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.025, 1.008, 0.99],
    contrast: 1.1,
    pivot: 0.42,
    saturation: 1.1,
    vibrance: 0.22,
    shadowTint: [0.86, 0.955, 1.16],
    midTint: [1.025, 1.0, 0.982],
    highTint: [1.09, 1.02, 0.9],
    lutContrast: 0.22,
    lutIntensity: 1.0,
    bloomIntensity: 0.72,
    vignetteDarkness: 0.42,
    vignetteOffset: 0.42,
  },
  // Golden hour: heavy orange highlights, violet shadows, lifted blacks.
  sunset: {
    exposure: 1.7,
    lookSlope: 1.0,
    lookOffset: 0.0,
    lookPower: 1.16,
    lookSat: 1.5,
    blackPoint: 0.012,
    whitePoint: 1.05,
    toeKnee: 0.11,
    toeFloor: 0.021,
    toeGamma: 0.72,
    shoulderKnee: 0.85,
    shoulderCeil: 0.968,
    lift: [0.018, 0.008, 0.022],
    gamma: [0.99, 1.0, 1.02],
    gain: [1.05, 1.0, 0.945],
    contrast: 1.08,
    pivot: 0.43,
    saturation: 1.14,
    vibrance: 0.26,
    shadowTint: [0.98, 0.9, 1.1],
    midTint: [1.07, 0.985, 0.9],
    highTint: [1.16, 1.0, 0.76],
    lutContrast: 0.18,
    lutIntensity: 1.0,
    bloomIntensity: 0.92,
    vignetteDarkness: 0.46,
    vignetteOffset: 0.4,
  },
  // Night: mesopic desaturation, deep blue shadows, neon-friendly highlights.
  night: {
    exposure: 3.1,
    lookSlope: 1.0,
    lookOffset: 0.0,
    lookPower: 1.06,
    lookSat: 1.32,
    blackPoint: 0.008,
    whitePoint: 1.02,
    // Night already measures 0.4 % crushed; the toe is shallower and the floor
    // lower so it stays a night scene rather than a grey one.
    toeKnee: 0.085,
    toeFloor: 0.012,
    toeGamma: 0.78,
    shoulderKnee: 0.88,
    shoulderCeil: 0.982,
    lift: [0.0, 0.004, 0.016],
    gamma: [1.03, 1.015, 0.985],
    gain: [0.95, 0.975, 1.05],
    contrast: 1.08,
    pivot: 0.42,
    saturation: 1.0,
    vibrance: 0.16,
    shadowTint: [0.74, 0.85, 1.24],
    midTint: [0.9, 0.965, 1.12],
    highTint: [1.02, 1.04, 1.08],
    lutContrast: 0.28,
    lutIntensity: 1.0,
    bloomIntensity: 1.1,
    vignetteDarkness: 0.56,
    vignetteOffset: 0.36,
  },
  // Storm: silvery, low saturation, hard contrast, cool-green shadows.
  storm: {
    exposure: 1.45,
    lookSlope: 1.0,
    lookOffset: 0.0,
    lookPower: 1.1,
    lookSat: 1.18,
    blackPoint: 0.014,
    whitePoint: 1.03,
    toeKnee: 0.11,
    toeFloor: 0.019,
    toeGamma: 0.74,
    shoulderKnee: 0.85,
    shoulderCeil: 0.968,
    lift: [0.01, 0.014, 0.018],
    gamma: [1.0, 1.0, 1.0],
    gain: [0.97, 0.995, 1.025],
    contrast: 1.18,
    pivot: 0.41,
    saturation: 0.92,
    vibrance: 0.12,
    shadowTint: [0.88, 0.96, 1.06],
    midTint: [0.955, 0.995, 1.025],
    highTint: [1.02, 1.05, 1.06],
    lutContrast: 0.3,
    lutIntensity: 1.0,
    bloomIntensity: 0.62,
    vignetteDarkness: 0.5,
    vignetteOffset: 0.38,
  },
};

// ---------------------------------------------------------------------------
// Procedural 3D LUT
// ---------------------------------------------------------------------------

const LUT_SIZE = 32;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

const lutCache = new Map<GradePresetName, THREE.Data3DTexture>();

/**
 * Build the split-toned film LUT for a preset. Domain and range are both
 * sRGB-encoded [0,1]. ~35 k texels — about 0.4 ms to generate.
 */
export function buildGradeLut(name: GradePresetName): THREE.Data3DTexture {
  const hit = lutCache.get(name);
  if (hit) return hit;

  const p = GRADE_PRESETS[name];
  const S = LUT_SIZE;
  const data = new Uint8Array(S * S * S * 4);
  const inv = 1 / (S - 1);
  let i = 0;

  for (let z = 0; z < S; z++) {
    const bIn = z * inv;
    for (let y = 0; y < S; y++) {
      const gIn = y * inv;
      for (let x = 0; x < S; x++) {
        const rIn = x * inv;

        const luma = rIn * 0.2126 + gIn * 0.7152 + bIn * 0.0722;

        // Three-zone weights that always sum to 1 — no banding at the joins.
        const wS = (1 - luma) * (1 - luma) * (1 - luma);
        const wH = luma * luma * luma;
        const wM = Math.max(0, 1 - wS - wH);

        const tr = p.shadowTint[0] * wS + p.midTint[0] * wM + p.highTint[0] * wH;
        const tg = p.shadowTint[1] * wS + p.midTint[1] * wM + p.highTint[1] * wH;
        const tb = p.shadowTint[2] * wS + p.midTint[2] * wM + p.highTint[2] * wH;

        let r = rIn * tr;
        let g = gIn * tg;
        let b = bIn * tb;

        // Filmic S-curve — toe and shoulder, pivot 0.5.
        const c = p.lutContrast;
        r = mix(r, r * r * (3 - 2 * clamp01(r)), c);
        g = mix(g, g * g * (3 - 2 * clamp01(g)), c);
        b = mix(b, b * b * (3 - 2 * clamp01(b)), c);

        // Chroma shaping: mids gain the most, deep shadows lose a touch so they
        // read as shadow rather than as tinted plastic, highlights hold on.
        const outLuma = r * 0.2126 + g * 0.7152 + b * 0.0722;
        const chroma = 0.94 + 0.22 * Math.sin(Math.PI * clamp01(luma));
        r = outLuma + (r - outLuma) * chroma;
        g = outLuma + (g - outLuma) * chroma;
        b = outLuma + (b - outLuma) * chroma;

        data[i++] = clamp01(r) * 255;
        data[i++] = clamp01(g) * 255;
        data[i++] = clamp01(b) * 255;
        data[i++] = 255;
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, S, S, S);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;

  lutCache.set(name, tex);
  return tex;
}

export function disposeGradeLuts(): void {
  for (const t of lutCache.values()) t.dispose();
  lutCache.clear();
}

// ---------------------------------------------------------------------------
// Effect
// ---------------------------------------------------------------------------

const FRAGMENT = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
uniform highp sampler3D gkLutA;
uniform highp sampler3D gkLutB;
#else
uniform mediump sampler3D gkLutA;
uniform mediump sampler3D gkLutB;
#endif

uniform vec4 gkLook;      // x = exposure, y = look slope, z = look power, w = look saturation
uniform vec4 gkRange;     // x = black point, y = 1/(white-black), z = contrast, w = pivot
uniform vec4 gkToe;       // x = toe knee, y = toe floor, z = toe gamma, w = shoulder knee
uniform vec2 gkShoulder;  // x = ceiling that input 1.0 lands on, y = roll-off exponent
uniform vec3 gkLift;
uniform vec3 gkInvGamma;
uniform vec3 gkGain;
uniform vec4 gkTone;      // x = saturation, y = vibrance, z = lut mix, w = lut intensity
uniform vec4 gkFlash;     // rgb = colour, a = amount
uniform vec3 gkShake;     // xy = uv offset, z = sample scale (<= 1 == zoom in)
uniform float gkLookOffset;

const float gkLutSize = 32.0;
const vec3 gkLumaW = vec3(0.2126, 0.7152, 0.0722);

// --- tone mapping ----------------------------------------------------------

const mat3 gkRec2020From709 = mat3(
  0.6274, 0.0691, 0.0164,
  0.3293, 0.9195, 0.0880,
  0.0433, 0.0113, 0.8956
);
const mat3 gk709FromRec2020 = mat3(
   1.6605, -0.1246, -0.0182,
  -0.5876,  1.1329, -0.1006,
  -0.0728, -0.0083,  1.1187
);
const mat3 gkAgxInset = mat3(
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859
);
const mat3 gkAgxOutset = mat3(
   1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323,  1.157823702216272, -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405
);

/** AgX's 6th-order sigmoid fit over the normalised log range. */
vec3 gkAgxSigmoid(const in vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
       - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/**
 * AgX. \`withLook\` applies the offset/slope/power/saturation stage that the
 * reference transform runs in the normalised log domain and that three.js
 * omits — the difference between "flat and milky" and "graded".
 */
vec3 gkAgx(in vec3 color, const in bool withLook) {
  const float minEv = -12.47393;
  const float maxEv = 4.026069;

  color = gkRec2020From709 * color;
  color = gkAgxInset * color;
  color = max(color, vec3(1e-10));
  color = log2(color);
  color = (color - minEv) / (maxEv - minEv);
  color = clamp(color, 0.0, 1.0);
  color = gkAgxSigmoid(color);

  if (withLook) {
    color = pow(max(color * gkLook.y + gkLookOffset, vec3(0.0)), vec3(gkLook.z));
    float l = dot(color, gkLumaW);
    color = l + (color - l) * gkLook.w;
  }

  color = gkAgxOutset * color;
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  color = gk709FromRec2020 * color;
  return clamp(color, 0.0, 1.0);
}

vec3 gkAcesFit(const in vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 gkAces(in vec3 color) {
  const mat3 inMat = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 outMat = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  color /= 0.6;
  color = inMat * color;
  color = gkAcesFit(color);
  color = outMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 gkNeutral(in vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return clamp(color, 0.0, 1.0);
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return clamp(mix(color, vec3(newPeak), g), 0.0, 1.0);
}

vec3 gkToneMap(const in vec3 hdr) {
#if GK_TONEMAP == 0
  return gkAgx(hdr, true);
#elif GK_TONEMAP == 1
  return gkAgx(hdr, false);
#elif GK_TONEMAP == 2
  return gkAces(hdr);
#else
  return gkNeutral(hdr);
#endif
}

// --- transfer functions ----------------------------------------------------

vec3 gkToSrgb(const in vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) * 1.055 - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

vec3 gkToLinear(const in vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
  return mix(hi, lo, step(c, vec3(0.04045)));
}

/**
 * Monotonic pivot-power S-curve. Exactly fixes 0, 1 and the pivot, so it adds
 * contrast without ever clipping something that was not already clipped.
 * Below the pivot it is a power curve towards black (the toe); above it, the
 * mirrored curve towards white (the shoulder).
 */
vec3 gkSCurve(const in vec3 x, const in float c, const in float p) {
  vec3 lo = p * pow(max(x, vec3(0.0)) / p, vec3(c));
  vec3 hi = 1.0 - (1.0 - p) * pow(max(1.0 - x, vec3(0.0)) / (1.0 - p), vec3(c));
  return mix(lo, hi, step(vec3(p), x));
}

/**
 * SHADOW TOE.
 *
 * The black point used to be a hard clip — clamp((s - black) * scale, 0, 1) —
 * so every value at or below the black point became exactly 0 simultaneously.
 * That is why shadowed geometry had no detail: it wasn't dark, it was *gone*.
 *
 * This replaces the bottom of that straight line with a curve that
 *   - lands input 0 on a small non-zero floor (gkToe.y) instead of black,
 *   - has gamma gkToe.z < 1, which *expands* separation in the deep shadows
 *     rather than compressing it,
 *   - meets the straight portion exactly at the knee (gkToe.x), so mid-tones
 *     and highlights are bit-identical to before,
 *   - and still walks down to true zero for input below the black point, so a
 *     genuinely black pixel is still black and the frame does not go milky.
 *
 * Monotone by construction: no banding, no inversion.
 */
vec3 gkToeCurve(const in vec3 x) {
  float k = max(gkToe.x, 1e-4);
  float f = gkToe.y;
  vec3 t = clamp(x / k, 0.0, 1.0);
  vec3 curve = f + (k - f) * pow(t, vec3(gkToe.z));
  vec3 below = f * clamp(1.0 + x * 4.0, 0.0, 1.0);
  vec3 toe = mix(below, curve, step(vec3(0.0), x));
  return mix(toe, x, step(vec3(k), x));
}

/**
 * HIGHLIGHT SHOULDER.
 *
 * Painted lines and kerbs were landing on 1.0 and clipping: several distinct
 * input values collapsed onto pure #FFF, which destroys the paint's own texture
 * and leaves SMAA a step edge with no gradient to work from — the reported
 * "clips to pure #FFF and aliases".
 *
 * gkShoulder.y is solved on the CPU as (1 - knee) / (ceil - knee) so the slope
 * is exactly 1 where the shoulder meets the straight portion; nothing below the
 * knee changes at all.
 */
vec3 gkShoulderCurve(const in vec3 x) {
  float sk = gkToe.w;
  float ce = gkShoulder.x;
  vec3 t = clamp((x - sk) / max(1.0 - sk, 1e-4), 0.0, 1.0);
  vec3 hi = sk + (ce - sk) * (1.0 - pow(1.0 - t, vec3(gkShoulder.y)));
  return mix(x, hi, step(vec3(sk), x));
}

vec3 gkSampleLut(const in vec3 c) {
  // Half-texel inset so the LUT end points are hit exactly.
  vec3 coord = c * ((gkLutSize - 1.0) / gkLutSize) + (0.5 / gkLutSize);
  vec3 a = texture(gkLutA, coord).rgb;
  vec3 b = texture(gkLutB, coord).rgb;
  return mix(a, b, gkTone.z);
}

void mainUv(inout vec2 uv) {
  uv = (uv - 0.5) * gkShake.z + 0.5 + gkShake.xy;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {

  // --- scene-referred HDR -> display-referred linear ---
  vec3 gkC = gkToneMap(max(inputColor.rgb, vec3(0.0)) * gkLook.x);

  // --- grade in sRGB-encoded space ---
  vec3 gkS = gkToSrgb(gkC);

  // Input range: pull the black point down towards 0 and the white point up.
  // NOT clamped here any more — the toe owns the bottom of the range and the
  // shoulder owns the top, and a clamp on either end would pre-empt both.
  gkS = (gkS - gkRange.x) * gkRange.y;

  // Soft shadow toe, so shadowed geometry keeps its detail.
  gkS = min(gkToeCurve(gkS), vec3(1.0));

  // Lift / gamma / gain — ASC-CDL ordering.
  gkS = gkGain * (gkS + gkLift * (1.0 - gkS));
  gkS = pow(max(gkS, vec3(0.0)), gkInvGamma);

  // Filmic contrast about the pivot.
  gkS = gkSCurve(clamp(gkS, 0.0, 1.0), gkRange.z, gkRange.w);

  // Highlight shoulder — the last thing in the luminance domain, so nothing
  // downstream can push a white back onto the clip.
  gkS = gkShoulderCurve(gkS);

  // Saturation, then vibrance (weighted towards low-chroma pixels).
  float gkL = dot(gkS, gkLumaW);
  gkS = mix(vec3(gkL), gkS, gkTone.x);
  float gkChroma = max(gkS.r, max(gkS.g, gkS.b)) - min(gkS.r, min(gkS.g, gkS.b));
  gkL = dot(gkS, gkLumaW);
  gkS = mix(vec3(gkL), gkS, 1.0 + gkTone.y * (1.0 - gkChroma));
  gkS = clamp(gkS, 0.0, 1.0);

  // Film LUT — per-theme split tone and chroma character.
  gkS = mix(gkS, gkSampleLut(gkS), gkTone.w);

  // Screen-blended flash — a hit or a lightning strike blows out, never mud.
  gkS = mix(gkS, 1.0 - (1.0 - gkS) * (1.0 - gkFlash.rgb), gkFlash.a);

  outputColor = vec4(gkToLinear(clamp(gkS, 0.0, 1.0)), inputColor.a);
}
`;

/**
 * The look pass: exposure, tone mapping and grading. Non-convolution, so it
 * merges into the same EffectPass as bloom / vignette.
 */
/**
 * Exponent that makes the shoulder's slope exactly 1 where it meets the
 * straight portion. `y = knee + (ceil - knee) * (1 - (1 - t)^n)` with
 * `t = (x - knee)/(1 - knee)` has `dy/dx = n (ceil - knee)/(1 - knee)` at the
 * knee, so `n = (1 - knee)/(ceil - knee)`. Solving it rather than eyeballing it
 * is what keeps the curve from putting a visible crease across every bright
 * surface in the frame.
 */
function shoulderExponent(knee: number, ceil: number): number {
  return Math.max(1, (1 - knee) / Math.max(1e-3, ceil - knee));
}

export class GradeEffect extends Effect {
  private readonly look: THREE.Vector4;
  private readonly range: THREE.Vector4;
  private readonly toe: THREE.Vector4;
  private readonly shoulder: THREE.Vector2;
  private readonly lift: THREE.Vector3;
  private readonly invGamma: THREE.Vector3;
  private readonly gain: THREE.Vector3;
  private readonly tone: THREE.Vector4;
  private readonly flash: THREE.Vector4;
  private readonly shakeUniform: THREE.Vector3;

  private from: GradePreset;
  private to: GradePreset;
  /** 0 = fully `from`, 1 = fully `to`. */
  private blend = 1;
  private blendRate = 0;

  private current: GradePresetName;
  private toneMapName: ToneMapName;

  /** Global exposure trim, multiplied on top of the preset's exposure. */
  private exposureTrim = 1;

  // --- transient screen effects ---
  private flashTime = 0;
  private flashDuration = 0;
  private flashPeak = 0;
  private readonly flashColor = new THREE.Color();

  private shakeTime = 0;
  private shakeDuration = 0;
  private shakePeak = 0;
  private shakePhase = 0;

  constructor(preset: GradePresetName = 'day', toneMap: ToneMapName = 'agx-punchy') {
    const p = GRADE_PRESETS[preset];
    const lut = buildGradeLut(preset);

    const uniforms = new Map<string, THREE.Uniform>([
      ['gkLutA', new THREE.Uniform(lut)],
      ['gkLutB', new THREE.Uniform(lut)],
      ['gkLook', new THREE.Uniform(new THREE.Vector4(p.exposure, p.lookSlope, p.lookPower, p.lookSat))],
      ['gkLookOffset', new THREE.Uniform(p.lookOffset)],
      ['gkRange', new THREE.Uniform(new THREE.Vector4(
        p.blackPoint, 1 / Math.max(1e-3, p.whitePoint - p.blackPoint), p.contrast, p.pivot,
      ))],
      ['gkToe', new THREE.Uniform(new THREE.Vector4(
        p.toeKnee, p.toeFloor, p.toeGamma, p.shoulderKnee,
      ))],
      ['gkShoulder', new THREE.Uniform(new THREE.Vector2(
        p.shoulderCeil, shoulderExponent(p.shoulderKnee, p.shoulderCeil),
      ))],
      ['gkLift', new THREE.Uniform(new THREE.Vector3(...p.lift))],
      ['gkInvGamma', new THREE.Uniform(new THREE.Vector3(1 / p.gamma[0], 1 / p.gamma[1], 1 / p.gamma[2]))],
      ['gkGain', new THREE.Uniform(new THREE.Vector3(...p.gain))],
      ['gkTone', new THREE.Uniform(new THREE.Vector4(p.saturation, p.vibrance, 0, p.lutIntensity))],
      ['gkFlash', new THREE.Uniform(new THREE.Vector4(1, 1, 1, 0))],
      ['gkShake', new THREE.Uniform(new THREE.Vector3(0, 0, 1))],
    ]);

    super('GradeEffect', FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      uniforms,
    });

    this.defines.set('GK_TONEMAP', TONE_MAP_DEFINE[toneMap]);
    this.toneMapName = toneMap;

    this.look = uniforms.get('gkLook')!.value as THREE.Vector4;
    this.range = uniforms.get('gkRange')!.value as THREE.Vector4;
    this.toe = uniforms.get('gkToe')!.value as THREE.Vector4;
    this.shoulder = uniforms.get('gkShoulder')!.value as THREE.Vector2;
    this.lift = uniforms.get('gkLift')!.value as THREE.Vector3;
    this.invGamma = uniforms.get('gkInvGamma')!.value as THREE.Vector3;
    this.gain = uniforms.get('gkGain')!.value as THREE.Vector3;
    this.tone = uniforms.get('gkTone')!.value as THREE.Vector4;
    this.flash = uniforms.get('gkFlash')!.value as THREE.Vector4;
    this.shakeUniform = uniforms.get('gkShake')!.value as THREE.Vector3;

    this.current = preset;
    this.from = p;
    this.to = p;
  }

  get presetName(): GradePresetName { return this.current; }
  /** The preset currently being blended towards — pipeline reads its hints. */
  get preset(): GradePreset { return this.to; }
  get toneMap(): ToneMapName { return this.toneMapName; }

  /** Swap the tone-mapping operator. Recompiles the merged look pass. */
  setToneMap(name: ToneMapName): void {
    if (name === this.toneMapName) return;
    this.toneMapName = name;
    this.defines.set('GK_TONEMAP', TONE_MAP_DEFINE[name]);
    this.setChanged();
  }

  /** Multiplied on top of the preset exposure. 1 = neutral. */
  setExposureTrim(v: number): void {
    this.exposureTrim = Math.max(0.05, v);
    this.applyBlend();
  }

  /** Cross-fade to another theme over `seconds`. */
  setPreset(name: GradePresetName, seconds = 0.8): void {
    if (name === this.current && this.blend >= 1) return;
    this.from = this.to;
    this.to = GRADE_PRESETS[name];
    this.current = name;

    const uA = this.uniforms.get('gkLutA');
    const uB = this.uniforms.get('gkLutB');
    if (uA && uB) {
      // Freeze the currently displayed mix into slot A, fade towards B.
      uA.value = uB.value;
      uB.value = buildGradeLut(name);
    }
    this.blend = 0;
    this.blendRate = seconds <= 0 ? 1e9 : 1 / seconds;
    this.applyBlend();
  }

  flashScreen(color: THREE.ColorRepresentation, amount: number, seconds: number): void {
    this.flashColor.set(color);
    this.flashPeak = Math.max(0, Math.min(1, amount));
    this.flashDuration = Math.max(0.01, seconds);
    this.flashTime = 0;
  }

  addShake(amount: number, seconds: number): void {
    // Additive so overlapping impacts stack, but bounded.
    this.shakePeak = Math.min(1.2, Math.max(this.shakePeak * (1 - this.shakeNorm()), 0) + amount);
    this.shakeDuration = Math.max(this.shakeDuration * (1 - this.shakeNorm()), seconds);
    this.shakeTime = 0;
  }

  private shakeNorm(): number {
    return this.shakeDuration <= 0 ? 1 : Math.min(1, this.shakeTime / this.shakeDuration);
  }

  private applyBlend(): void {
    const t = this.blend;
    const a = this.from;
    const b = this.to;

    this.look.set(
      mix(a.exposure, b.exposure, t) * this.exposureTrim,
      mix(a.lookSlope, b.lookSlope, t),
      mix(a.lookPower, b.lookPower, t),
      mix(a.lookSat, b.lookSat, t),
    );
    const off = this.uniforms.get('gkLookOffset');
    if (off) off.value = mix(a.lookOffset, b.lookOffset, t);

    const black = mix(a.blackPoint, b.blackPoint, t);
    const white = mix(a.whitePoint, b.whitePoint, t);
    this.range.set(
      black,
      1 / Math.max(1e-3, white - black),
      mix(a.contrast, b.contrast, t),
      mix(a.pivot, b.pivot, t),
    );

    const sKnee = mix(a.shoulderKnee, b.shoulderKnee, t);
    const sCeil = mix(a.shoulderCeil, b.shoulderCeil, t);
    this.toe.set(
      mix(a.toeKnee, b.toeKnee, t),
      mix(a.toeFloor, b.toeFloor, t),
      mix(a.toeGamma, b.toeGamma, t),
      sKnee,
    );
    this.shoulder.set(sCeil, shoulderExponent(sKnee, sCeil));

    this.lift.set(
      mix(a.lift[0], b.lift[0], t),
      mix(a.lift[1], b.lift[1], t),
      mix(a.lift[2], b.lift[2], t),
    );
    this.invGamma.set(
      1 / mix(a.gamma[0], b.gamma[0], t),
      1 / mix(a.gamma[1], b.gamma[1], t),
      1 / mix(a.gamma[2], b.gamma[2], t),
    );
    this.gain.set(
      mix(a.gain[0], b.gain[0], t),
      mix(a.gain[1], b.gain[1], t),
      mix(a.gain[2], b.gain[2], t),
    );
    this.tone.x = mix(a.saturation, b.saturation, t);
    this.tone.y = mix(a.vibrance, b.vibrance, t);
    this.tone.z = t;
    this.tone.w = mix(a.lutIntensity, b.lutIntensity, t);
  }

  /** Driven by RenderPipeline every frame. */
  advance(dt: number): void {
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt * this.blendRate);
      this.applyBlend();
      if (this.blend >= 1) this.from = this.to;
    }

    // --- flash: fast attack, exponential decay ---
    if (this.flashPeak > 0) {
      this.flashTime += dt;
      const t = this.flashTime / this.flashDuration;
      if (t >= 1) {
        this.flashPeak = 0;
        this.flash.w = 0;
      } else {
        const attack = Math.min(1, t / 0.12);
        const decay = Math.pow(1 - t, 2.2);
        this.flash.set(this.flashColor.r, this.flashColor.g, this.flashColor.b, this.flashPeak * attack * decay);
      }
    }

    // --- shake: decaying two-frequency wobble, applied as a UV nudge with a
    //     matching zoom so no unsampled border is ever revealed. ---
    if (this.shakePeak > 0) {
      this.shakeTime += dt;
      const t = this.shakeTime / this.shakeDuration;
      if (t >= 1) {
        this.shakePeak = 0;
        this.shakeUniform.set(0, 0, 1);
      } else {
        this.shakePhase += dt;
        const env = this.shakePeak * Math.pow(1 - t, 1.7);
        const ph = this.shakePhase;
        const ox = (Math.sin(ph * 61.3) * 0.65 + Math.sin(ph * 23.7) * 0.35) * env * 0.010;
        const oy = (Math.cos(ph * 54.1) * 0.6 + Math.cos(ph * 31.9) * 0.4) * env * 0.010;
        // Shrink the sampled window by slightly more than the offset so the
        // shifted frame never reads outside the buffer.
        const scale = 1 - (Math.abs(ox) + Math.abs(oy)) * 2.4;
        this.shakeUniform.set(ox, oy, scale);
      }
    }
  }
}
