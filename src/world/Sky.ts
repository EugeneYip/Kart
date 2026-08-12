/**
 * ============================================================================
 *  APEX KART — SKY
 * ============================================================================
 *  Physically-based analytic atmosphere (Preetham/Rayleigh-Mie single
 *  scattering) with a layered, parallaxed, self-shadowing volumetric-looking
 *  cloud system, a star field with a Milky Way band, a normal-mapped moon,
 *  lightning and ash embers.
 *
 *  Also renders itself into a cube target once per refresh and runs it through
 *  PMREMGenerator to produce `scene.environment` — this is what makes every
 *  PBR material in the game sit correctly in its environment.
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem } from '@/core/Types';
import { RENDER_ORDER } from '@/core/Config';
import { clamp01, damp } from '@/core/MathUtils';
import { makeCloudNoise, worldRegistry } from './WorldTextures';

export type SkyPresetName = 'day' | 'sunset' | 'night' | 'storm' | 'volcanic';

/** Everything both the sky shader and Lighting need to know about a mood. */
export interface SkyPreset {
  /** degrees above the horizon */
  sunElevation: number;
  /** degrees, 0 = -Z */
  sunAzimuth: number;
  moonElevation: number;
  moonAzimuth: number;

  turbidity: number;
  rayleigh: number;
  mie: number;
  mieG: number;
  sunIntensity: number;
  /** Radiance of a luminance-1.0 sky after tone shaping. See `skyGrade()`. */
  skyScale: number;
  /** Luminance compression exponent (<1). Tames the huge zenith:horizon ratio. */
  skyGamma: number;
  /** Saturation restored after compression — AgX desaturates as it rolls off. */
  skySat: number;
  /**
   * Strength of the warm/cool crossover chroma dip, 0..1. See `crossoverAmount`
   * in the sky shader: this is the fix for the green sunset band. Presets whose
   * sky never crosses from cool to warm (day, storm) can leave it low.
   */
  chromaDip: number;

  cloudCoverage: number;
  cloudErode: number;
  cloudOpacity: number;
  cloudSpeed: number;
  cloudLit: number;
  cloudDark: number;
  cloudAmbient: number;
  /** Radiance multiplier for the cloud decks. >1 lifts lit tops above the sky. */
  cloudLum: number;

  haze: number;
  hazeStrength: number;
  /** Radiance of the horizon haze colour. Keep below the local sky luminance. */
  hazeLum: number;
  night: number;
  cityGlow: number;
  embers: number;
  lightning: number;

  // ---- consumed by Lighting -------------------------------------------------
  keyColor: number;
  keyIntensity: number;
  skyAmbient: number;
  groundAmbient: number;
  ambientIntensity: number;
  /** Folded into the hemisphere ground term — there is no separate bounce light. */
  bounceColor: number;
  bounceIntensity: number;
  rimColor: number;
  rimIntensity: number;
  fogColor: number;
  fogSunColor: number;
  fogDensity: number;
  fogHeight: number;
  fogFalloff: number;
  /** `scene.environmentIntensity` for this mood — the IBL half of the fill. */
  envIntensity: number;
  godRays: number;
  godRayColor: number;
  shadowIntensity: number;
}

const P = (o: SkyPreset): SkyPreset => o;

/**
 * ---------------------------------------------------------------------------
 *  AUTHORING NOTE — the whole game is graded for AgX at exposure 1.0.
 * ---------------------------------------------------------------------------
 *  AgX puts linear 1.0 at roughly sRGB 0.79, so anything above ~2.0 linear is
 *  visually white. The old presets shipped the raw Preetham integral (zenith
 *  ~3.7 linear, horizon ~10) which clipped the entire sky to milk and drowned
 *  the clouds. Every radiance figure below is therefore quoted in *linear
 *  scene units*:
 *
 *      0.02–0.06   deep shadow           0.35–0.45   sky zenith (day)
 *      0.10–0.20   shadowed diffuse      0.50–0.60   bright horizon
 *      0.40–0.60   sunlit diffuse        2.0–2.5     sunlit cloud top
 *      1.5–3.0     specular highlight    > 4         emissive / sun disc
 *
 *  Measured off the sky cube target with `day` at skyScale 0.40 via
 *  `readRenderTargetPixels` (linear half-float), then scaled to the shipped
 *  0.34: zenith mean rgb (0.06, 0.47, 1.40), luma p50 0.40 / p95 0.75 — the p95
 *  is cloud tops, so the decks do carry ~2:1 contrast against the sky instead of
 *  clipping into it. Horizon mean rgb (0.25, 0.55, 0.98), luma p50 0.51, i.e.
 *  only ~1.3:1 over the zenith where the raw integral was 4:1. The post chain
 *  owns the final trim: `GradeEffect` applies AgX-punchy at exposure 1.5, so if
 *  overall scene brightness is moved by k, that exposure is the knob to divide.
 *
 *  Key/fill ratio is deliberately steep (roughly 6:1 on the diffuse term for
 *  `day`): a strong warm directional against a weak cool hemisphere + IBL is
 *  what gives MK8 its saturated, grounded look. Raising `ambientIntensity` or
 *  `envIntensity` is the fastest way to flatten the image again — don't.
 */
export const SKY_PRESETS: Record<SkyPresetName, SkyPreset> = {
  day: P({
    // 42°, not 54°. A high sun hides its own shadows under the objects casting
    // them; a shadow roughly as long as the object is tall is what makes karts
    // and props read as sitting *on* the track rather than floating over it.
    sunElevation: 42, sunAzimuth: 38, moonElevation: -40, moonAzimuth: 210,
    turbidity: 2.4, rayleigh: 1.9, mie: 0.0042, mieG: 0.80, sunIntensity: 1.0,
    // chromaDip is small here on purpose: a 42 deg sun never produces the
    // warm/cool crossover, so measured over the whole sky column `day` has zero
    // samples in the green band with the dip on OR off. All 0.25 buys is
    // insurance for the near-horizon haze band (its only measurable effect:
    // chroma 0.459 -> 0.36 at 3 deg elevation, hue unchanged at 198).
    skyScale: 0.34, skyGamma: 0.42, skySat: 1.30, chromaDip: 0.25,
    // Coverage is a threshold in standard deviations of the cloud noise now, so
    // it means what it says: 0.52 measures 37.6 % of the sky between 6 deg and
    // 40 deg elevation covered by the union of the three decks (see the note on
    // `layerDensity`). It used to mean nothing at all — every deck was empty.
    cloudCoverage: 0.52, cloudErode: 0.55, cloudOpacity: 1.0, cloudSpeed: 1.0,
    cloudLit: 0xfff8ee, cloudDark: 0x53749c, cloudAmbient: 0.34, cloudLum: 2.3,
    haze: 0x9dc3ea, hazeStrength: 0.60, hazeLum: 1.00,
    night: 0, cityGlow: 0, embers: 0, lightning: 0,
    keyColor: 0xfff1d6, keyIntensity: 3.9,
    skyAmbient: 0x8fbdf2, groundAmbient: 0x6d6553, ambientIntensity: 0.40,
    bounceColor: 0x8f8a63, bounceIntensity: 0.45,
    rimColor: 0xbcd8ff, rimIntensity: 0.22,
    fogColor: 0x5c80b0, fogSunColor: 0xffe3ae, fogDensity: 0.00085, fogHeight: 3, fogFalloff: 0.020,
    envIntensity: 0.40,
    // NOT 1.0. A shadow map knows about occlusion but nothing about the bounce
    // that fills a real shadow, so a fully-opaque shadow term is the darkest
    // possible answer — the reported 8:1 split inside one frame (a kart in the
    // grandstand's shadow at 15 % luminance beside a sunlit wall at 250).
    // Leaving 10 % of the key inside shadow is the one lever that lifts *only*
    // shadowed pixels; raising ambientIntensity or envIntensity lifts the lit
    // ones too and flattens the whole image, which is the trap this file warns
    // about above. The grade's blue shadowTint keeps the residual from reading
    // as warm spill.
    godRays: 0.18, godRayColor: 0xfff0d0, shadowIntensity: 0.90,
  }),
  sunset: P({
    sunElevation: 4.5, sunAzimuth: -74, moonElevation: 22, moonAzimuth: 120,
    turbidity: 5.4, rayleigh: 3.3, mie: 0.014, mieG: 0.872, sunIntensity: 1.1,
    skyScale: 0.50, skyGamma: 0.44, skySat: 1.32, chromaDip: 1.0,
    cloudCoverage: 0.54, cloudErode: 0.42, cloudOpacity: 1.0, cloudSpeed: 0.75,
    cloudLit: 0xffc98a, cloudDark: 0x3a2b45, cloudAmbient: 0.30, cloudLum: 2.0,
    haze: 0xff9a5e, hazeStrength: 0.68, hazeLum: 0.95,
    night: 0, cityGlow: 0.1, embers: 0, lightning: 0,
    keyColor: 0xffa055, keyIntensity: 3.7,
    skyAmbient: 0x6f8fd4, groundAmbient: 0x483630, ambientIntensity: 0.42,
    bounceColor: 0xa35f38, bounceIntensity: 0.5,
    rimColor: 0x8fb4ff, rimIntensity: 0.36,
    fogColor: 0x8a5a4a, fogSunColor: 0xffbe80, fogDensity: 0.00105, fogHeight: 2, fogFalloff: 0.017,
    envIntensity: 0.45,
    // See the note on `day.shadowIntensity` — same reasoning, and a low sun
    // makes the shadows long enough that an opaque shadow term covers a large
    // fraction of the frame.
    godRays: 1.0, godRayColor: 0xffb066, shadowIntensity: 0.90,
  }),
  /**
   * ---- D4: raised. This is the only preset a shipping circuit uses at night
   *  (Neon Metropolis, which is also the only rain course), and until `f350e37`
   *  it never actually rendered — every circuit was drawn under flat noon `day`.
   *  So the playtester's "the scene on rainy courses is overall too dark" was
   *  written about a build that was accidentally 3.7x BRIGHTER than this preset.
   *
   *  Measured on a 0.055-albedo road facing up, with `Lighting`'s real applied
   *  values and three's own shading maths (`.probe-tmp/mood.ts`):
   *
   *      preset   road linear   road sRGB8 after AgX @ exposure 1.5
   *      day        0.0478          78     <- what the owner actually played
   *      night      0.0131          33     <- what shipped after f350e37
   *
   *  A road at 33/255 for 53 % of the lap (`.probe-tmp/nightlight.ts` walks the
   *  circuit; the other 47 % has a lamp in range) is close enough to black that
   *  the asphalt stops carrying any surface information. Raised toward — not to
   *  — the level the owner played, keeping it unambiguously night:
   *
   *      keyIntensity  1.05 -> 1.75   the moon. The lever that adds brightness
   *                                   AND shape; ambient/env only add flatness,
   *                                   which this file warns about above.
   *      skyAmbient    lightened      raising `ambientIntensity` against a
   *                                   near-black 0x1d2a4a bought almost nothing:
   *                                   the hemisphere was 2 % of the road's light.
   *      envIntensity  0.90 -> 1.08   the IBL half of the fill; already the
   *                                   largest single term at night, so moved least.
   *      fogDensity    0.00120 -> 0.00100  the corner ahead reads a shade further.
   *
   *  THE FINAL CALL HERE NEEDS A SCREENSHOT. This estimate does not model the
   *  emissive neon signage, bloom, the point-light pool, or the wet-road
   *  specular (`Weather.applyWetRoad` cuts road roughness to 0.28x and raises
   *  envMapIntensity 1.6x, so a wet night road reflects far more than a dry one).
   * ---- */
  night: P({
    sunElevation: -16, sunAzimuth: -74, moonElevation: 42, moonAzimuth: -30,
    turbidity: 1.8, rayleigh: 0.7, mie: 0.0035, mieG: 0.78, sunIntensity: 1.0,
    skyScale: 0.30, skyGamma: 0.50, skySat: 1.15, chromaDip: 0.35,
    cloudCoverage: 0.38, cloudErode: 0.6, cloudOpacity: 0.9, cloudSpeed: 0.6,
    cloudLit: 0x6b7c98, cloudDark: 0x0a0e1a, cloudAmbient: 0.25, cloudLum: 1.1,
    haze: 0x121b30, hazeStrength: 0.72, hazeLum: 0.55,
    night: 1, cityGlow: 1.0, embers: 0, lightning: 0,
    keyColor: 0x9ab0e8, keyIntensity: 1.75,
    skyAmbient: 0x2c3d66, groundAmbient: 0x151b28, ambientIntensity: 0.74,
    bounceColor: 0x232c48, bounceIntensity: 0.35,
    rimColor: 0x7fd0ff, rimIntensity: 0.65,
    fogColor: 0x141d33, fogSunColor: 0x2c3a5e, fogDensity: 0.00100, fogHeight: 2, fogFalloff: 0.021,
    envIntensity: 1.08,
    godRays: 0.0, godRayColor: 0x9fb6ff, shadowIntensity: 0.78,
  }),
  storm: P({
    sunElevation: 27, sunAzimuth: 150, moonElevation: -30, moonAzimuth: 20,
    turbidity: 9.5, rayleigh: 1.1, mie: 0.022, mieG: 0.70, sunIntensity: 0.55,
    skyScale: 0.34, skyGamma: 0.46, skySat: 1.06, chromaDip: 0.25,
    cloudCoverage: 0.92, cloudErode: 0.22, cloudOpacity: 1.0, cloudSpeed: 2.4,
    cloudLit: 0x9aa4b2, cloudDark: 0x1d2228, cloudAmbient: 0.55, cloudLum: 1.5,
    haze: 0x5f6a76, hazeStrength: 0.78, hazeLum: 0.80,
    night: 0, cityGlow: 0, embers: 0, lightning: 1,
    keyColor: 0xc0cbd8, keyIntensity: 1.85,
    skyAmbient: 0x53606e, groundAmbient: 0x25272b, ambientIntensity: 0.56,
    bounceColor: 0x4a4d52, bounceIntensity: 0.4,
    rimColor: 0xd6e6ff, rimIntensity: 0.34,
    fogColor: 0x4b545e, fogSunColor: 0x717b86, fogDensity: 0.0030, fogHeight: 1, fogFalloff: 0.016,
    envIntensity: 0.65,
    godRays: 0.25, godRayColor: 0xc8d4e2, shadowIntensity: 0.70,
  }),
  /**
   * ---- P0d: RAISED. "The volcano-themed track is a bit too dark" — and the
   *  cause was NOT the key intensity, which at 2.90 was already 1.66x `night`'s.
   *  Measured with `.probe-tmp/volcdark.ts`, which unlike `mood.ts` uses the
   *  circuit's OWN authored road albedo (`TrackDef.road.tint` x the asphalt
   *  variant base) instead of a flat 0.055:
   *
   *      circuit    key lin   hemi lin   IBL lin   TOTAL    key share
   *      coastal    0.0023    0.0021     0.0061    0.0105     22 %
   *      neon       0.0087    0.0006     0.0085    0.0178     49 %
   *      volcano    0.0021    0.0003     0.0044    0.0068     30 %   <- darkest
   *
   *  Three compounding causes, in order of size:
   *
   *  1. **`sunElevation: 11` — the cosine, not the intensity.** A road faces
   *     straight up, so it collects `sin(elevation)` of the key: 0.191 at 11 deg.
   *     `night`'s moon sits at 42 deg (0.669), so despite a key 1.66x weaker it
   *     put 4.1x more light on the tarmac. This is why "volcanic has a stronger
   *     key than night" was a red herring. 11 -> 19 deg is worth 1.71x on the key
   *     term, and it also cuts every shadow from 5.1x to 2.9x the caster's height,
   *     which is the other half of the "basalt columns crowd the road" complaint.
   *  2. **The authored road albedo was 41 % below the other two circuits**
   *     (`tint: 0xbdb6b2`, lum 0.0321 vs 0.0544 / 0.0524). Fixed in `TrackDefs`.
   *  3. **The IBL was already 65 % of the road's light** — the largest term by
   *     far — so `envIntensity` is the one fill knob with real leverage here.
   *     The warning at the top of this file ("raising envIntensity flattens the
   *     image") is written for a scene whose key does the shaping; at 11-19 deg
   *     against an up-facing plane the key physically cannot, and a sky dome of
   *     glowing ash genuinely IS a large area source. Raised, but the key is
   *     raised further so the key share goes UP (30 % -> 36 %), not down.
   *
   *  The fog was a separate defect with the opposite sign: `fogColor` #5e1e16 has
   *  lum 0.0337, 4.9x the road's 0.0068, and at density 0.0024 (2.4x neon's) the
   *  road was 18 % fog at 100 m and 33 % at 200 m. So the fog was not darkening
   *  the road, it was washing the far half of it into a flat brown with no
   *  road/verge edge left. Density cut to 0.00145; the colour stays ash.
   *
   *  `shadowIntensity` 0.82 -> 0.62: with a low sun the shadows are long and
   *  numerous, and an 82 %-opaque shadow term over a road this dark is a black
   *  stripe. 0.62 leaves 38 % of the key inside shadow.
   *
   *  ALSO REPORTED, NOT FIXABLE FROM THIS FILE: `GRADE_PRESETS` in
   *  `src/render/effects/GradeEffect.ts` has no `volcanic` entry, and nothing in
   *  the game ever calls `RenderPipeline.setGradePreset()` — `GradeEffect` is
   *  constructed with `'day'` and stays there. So every circuit is graded through
   *  the `day` curve: exposure 0.70 with a 1.2 shadow toe, calibrated against a
   *  road at linear 0.0478. That mis-grade costs volcano more than any preset
   *  value here does. THE FINAL CALL ON BRIGHTNESS NEEDS A SCREENSHOT.
   * ---- */
  volcanic: P({
    sunElevation: 19, sunAzimuth: 196, moonElevation: -20, moonAzimuth: 10,
    turbidity: 8.5, rayleigh: 2.6, mie: 0.032, mieG: 0.90, sunIntensity: 0.85,
    skyScale: 0.46, skyGamma: 0.45, skySat: 1.22, chromaDip: 0.90,
    cloudCoverage: 0.68, cloudErode: 0.35, cloudOpacity: 1.0, cloudSpeed: 1.4,
    cloudLit: 0xff7a3a, cloudDark: 0x1e0c10, cloudAmbient: 0.42, cloudLum: 1.8,
    haze: 0x8f3a20, hazeStrength: 0.76, hazeLum: 0.85,
    night: 0, cityGlow: 0, embers: 1, lightning: 0,
    keyColor: 0xff7a45, keyIntensity: 3.8,
    skyAmbient: 0xa85436, groundAmbient: 0x4a1a0e, ambientIntensity: 0.80,
    bounceColor: 0xd94a1e, bounceIntensity: 0.95,
    rimColor: 0xff9a5c, rimIntensity: 0.50,
    fogColor: 0x6b2a1d, fogSunColor: 0xff8a44, fogDensity: 0.00145, fogHeight: 2, fogFalloff: 0.018,
    envIntensity: 0.90,
    godRays: 0.8, godRayColor: 0xff8038, shadowIntensity: 0.62,
  }),
};

// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform float uTime;
uniform sampler2D uNoise;

uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMie;
uniform float uMieG;
uniform float uSunIntensity;
uniform float uSkyScale;
uniform float uSkyGamma;
uniform float uSkySat;
uniform float uChromaDip;
/** Camera XZ, so the cloud planes are intersected in world space and parallax. */
uniform vec2  uCamXZ;

uniform float uCloudCoverage;
uniform float uCloudErode;
uniform float uCloudOpacity;
uniform float uCloudSpeed;
uniform vec3  uCloudLit;
uniform vec3  uCloudDark;
uniform float uCloudAmbient;
uniform float uCloudLum;

uniform vec3  uHaze;
uniform float uHazeStrength;
uniform float uHazeLum;
uniform float uNight;
uniform float uCityGlow;
uniform float uEmbers;
uniform float uLightning;

#define PI 3.141592653589793

const vec3  TOTAL_RAYLEIGH = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
const vec3  MIE_CONST      = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
const float RAYLEIGH_ZENITH = 8.4e3;
const float MIE_ZENITH      = 1.25e3;
const float SUN_E           = 1000.0;
const float CUTOFF_ANGLE    = 1.6110731556870734;
const float STEEPNESS       = 1.5;

float sunIntensity(float zc){
  zc = clamp(zc, -1.0, 1.0);
  return SUN_E * max(0.0, 1.0 - exp(-((CUTOFF_ANGLE - acos(zc)) / STEEPNESS)));
}
vec3 totalMie(float T){ return 0.434 * ((0.2 * T) * 1e-17) * MIE_CONST; }
float rayleighPhase(float c){ return (3.0 / (16.0 * PI)) * (1.0 + c * c); }
float hgPhase(float c, float g){
  float g2 = g * g;
  return (1.0 / (4.0 * PI)) * ((1.0 - g2) / pow(max(1e-4, 1.0 - 2.0 * g * c + g2), 1.5));
}

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

// --- atmosphere -------------------------------------------------------------
vec3 atmosphere(vec3 rd, out float sunDisc){
  vec3 up = vec3(0.0, 1.0, 0.0);
  float sunE = sunIntensity(dot(uSunDir, up)) * uSunIntensity;
  float sunfade = 1.0 - clamp(1.0 - exp(uSunDir.y * 4.0), 0.0, 1.0);

  vec3 betaR = TOTAL_RAYLEIGH * max(0.0, uRayleigh - (1.0 - sunfade));
  vec3 betaM = totalMie(uTurbidity) * uMie;

  float zen = acos(max(0.0, dot(up, rd)));
  float denom = cos(zen) + 0.15 * pow(max(1e-3, 93.885 - (zen * 180.0) / PI), -1.253);
  float sR = RAYLEIGH_ZENITH / denom;
  float sM = MIE_ZENITH / denom;
  vec3 Fex = exp(-(betaR * sR + betaM * sM));

  float cosT = dot(rd, uSunDir);
  vec3 betaRT = betaR * rayleighPhase(cosT * 0.5 + 0.5);
  vec3 betaMT = betaM * hgPhase(cosT, uMieG);
  vec3 ratio  = (betaRT + betaMT) / (betaR + betaM);

  vec3 Lin = pow(sunE * ratio * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(sunE * ratio * Fex, vec3(0.5)),
             clamp(pow(1.0 - dot(up, uSunDir), 5.0), 0.0, 1.0));

  // Sun disc with limb darkening + a wide forward-scatter bloom core.
  float ang = acos(clamp(cosT, -1.0, 1.0));
  float discR = 0.0128;
  float r = ang / discR;
  float limb = pow(max(0.0, 1.0 - r * r), 0.42);
  sunDisc = smoothstep(1.02, 0.94, r) * limb;
  vec3 L0 = vec3(0.06) * Fex;
  L0 += (sunE * 22.0 * Fex) * sunDisc;
  L0 += (sunE * 0.048 * Fex) * pow(max(0.0, cosT), 320.0);
  L0 += (sunE * 0.009 * Fex) * pow(max(0.0, cosT), 22.0);

  return (Lin + L0) * 0.04;
}

/**
 * Land the Preetham integral in the linear range AgX@1.0 actually resolves.
 *
 * Raw output runs ~0.1 (dim sunset zenith) to ~10 (bright day horizon) to ~450
 * (sun disc) — a 4000:1 range that AgX clips to a flat white sheet. Compress
 * *luminance* with a power curve, which preserves chromaticity exactly, then
 * push saturation back out around the new luminance because both the
 * compression and AgX's own rolloff bleach the hue. This is the single change
 * that turns the sky from milk into a believable saturated blue.
 */
/**
 * WARM/COOL CROSSOVER DETECTOR — the green sunset band.
 *
 * At a low sun the analytic sky runs cool at the zenith and warm at the
 * horizon, and G is high at *both* ends: measured off a shipped frame the two
 * ends are (119,171,166) and (231,185,129). A per-channel ramp between those
 * has G as its largest channel across the middle of the transition, which is
 * the reported hue ladder 174 -> 163 -> 136 -> 85 -> 33 — four consecutive
 * heights in the green band. No colour space fixes that: the short hue path
 * from 174 to 33 runs through green in every one of them.
 *
 * So collapse chroma instead of rotating hue. This returns a 4t(1-t)-shaped
 * bump that peaks exactly where |R-B| is smallest, i.e. at the crossover,
 * gated on green actually being the dominant channel so a neutral overcast sky
 * is left alone. Multiplying skySat by (1 - this) is also the height-dependent
 * skySat the report asked for — the crossover only happens at one elevation for
 * a given sun, so it *is* a height ramp, but one that follows the sun instead
 * of being pinned to a hard-coded rd.y.
 */
float crossoverAmount(vec3 c){
  float mx = max(max(c.r, c.g), c.b);
  float xf = 1.0 - clamp(abs(c.r - c.b) / max(mx, 1e-5), 0.0, 1.0);
  float gRel = clamp((c.g - 0.5 * (c.r + c.b)) / max(mx, 1e-5), 0.0, 1.0);
  return smoothstep(0.24, 0.86, xf) * smoothstep(0.008, 0.075, gRel);
}

/** Pull a colour towards a low-chroma warm cream of its own luminance. */
vec3 creamify(vec3 c, float amt){
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, vec3(l) * vec3(1.085, 1.0, 0.90), amt);
}

vec3 skyGrade(vec3 c){
  float l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
  float lo = uSkyScale * pow(l, uSkyGamma);
  c *= lo / l;
  // Detect on the *saturated* result, not on 'c': the extrapolation below is
  // what the eye sees, and measuring pre-saturation chroma made the dip fire on
  // merely-cyan zenith pixels as well as on the green band.
  float dip = crossoverAmount(mix(vec3(lo), c, uSkySat)) * uChromaDip;
  vec3 g = mix(vec3(lo), c, mix(uSkySat, 0.32, dip));
  return max(creamify(g, dip * 0.66), vec3(0.0));
}

// --- clouds -----------------------------------------------------------------
#define NOISE_PX 256.0
vec4 nz(vec2 uv, float lod){ return textureLod(uNoise, uv, clamp(lod, 0.0, 8.0)); }

/**
 * ---------------------------------------------------------------------------
 *  WHY THIS USED TO RENDER NOTHING — read before touching the constants.
 * ---------------------------------------------------------------------------
 *  'makeCloudNoise(256)' packs four tiling fBms. Measured over all 65 536
 *  texels (and stable to within 3 % through mip 3):
 *
 *      channel            content            mean    sigma    range
 *      R  fBm f3,  4 oct  coarse body        0.496   0.098    0.20 .. 0.74
 *      G  fBm f7,  3 oct  cumulus masses     0.486   0.141    0.08 .. 0.83
 *      B  fBm f17, 3 oct  erosion detail     0.494   0.138    0.06 .. 0.90
 *      A  fBm f2,  2 oct  cloud groups       0.368   0.158    0.07 .. 0.75
 *
 *  Every channel is a sum of value-noise octaves, so it is near-Gaussian and
 *  *narrow*. The old density test was
 *
 *      base = 0.60R + 0.28G + 0.12B;             // sigma 0.049 about 0.50
 *      d    = (base - (1 - cov)) / cov;
 *      d    = clamp(d * 1.55 - B * erode * 0.85, 0, 1);
 *
 *  which for the shipped 'day' coverage of 0.46 needed base > 0.61 to survive
 *  the erosion subtraction — that is +2.2 sigma, and only reachable at mip 0.
 *  It never got mip 0: the lod was 'log2(1 + t*scale*220) - 3', a function of
 *  distance rather than of footprint, which asked for mip 4.8 at 10 deg
 *  elevation where the true screen footprint is mip 0.4. Box-filtering to mip 4
 *  drops max(base) to 0.644 and mip 6 to 0.532 — *below the threshold* — so the
 *  predicate was false for every pixel of every deck. Measured alpha was
 *  identically 0.0000 across the whole hemisphere for day, sunset and night;
 *  only 'storm' (cov 0.88, threshold 0.12) ever produced any cloud at all, and
 *  then only on the middle deck. Authored, wired, never once fired.
 *
 *  Two fixes, both necessary:
 *    1. the lod comes from the real screen-space derivative (see cloudLayer);
 *    2. the threshold is expressed in standard deviations, so "coverage" is a
 *       coverage fraction at any mip level rather than an absolute noise value.
 */
const vec4 NZ_MEAN = vec4(0.496, 0.486, 0.494, 0.368);
const vec4 NZ_ISIG = vec4(10.24, 7.072, 7.225, 6.333);

float layerDensity(vec2 p, float cov, float erode, float lod){
  // Low-frequency group mask + domain warp. This is what puts clear sky between
  // cloud masses instead of an even sheet of noise. Deliberately NOT animated:
  // shapes stay rigid in tile space and the whole field translates with the
  // deck's drift, so clouds move instead of boiling in place.
  vec4 w = nz(p * 0.31, lod + 1.7);
  float clump = (w.a - NZ_MEAN.a) * NZ_ISIG.a;
  vec2 q = p + vec2(w.a - NZ_MEAN.a, w.r - NZ_MEAN.r) * 1.15;

  vec4 n = nz(q, lod);
  // Mip flattening: sigma(G) falls 0.141 -> 0.080 by mip 6, so the last few
  // degrees above the horizon would lose their cloud to the filter rather than
  // to the art direction. Compensate on the way out.
  float body = (n.g - NZ_MEAN.g) * NZ_ISIG.g * mix(1.0, 1.85, smoothstep(3.5, 6.0, lod));
  float fine = (n.b - NZ_MEAN.b) * NZ_ISIG.b;

  float v = body * 0.90 + clump * 0.66 + fine * 0.20 - (2.30 - cov * 3.55);
  // A firm core with a short shoulder reads as a cumulus edge; a wide ramp
  // reads as smoke. Erosion bites the shoulder only, never the core.
  float d = smoothstep(0.0, 1.05, v);
  return d * (1.0 - erode * 0.50 * smoothstep(0.75, 0.0, v));
}

/**
 * One cloud deck. rgb = premultiplied radiance, a = coverage.
 *
 * 'deep' adds a second self-shadow tap, 'vert' the zenith-ward tap that gives
 * the deck lit tops and shadowed bottoms. Cirrus needs neither, so the three
 * decks together cost the same 9 density evaluations the empty version did.
 */
vec4 cloudLayer(vec3 rd, float height, vec2 scale, vec2 drift, float cov,
                float erode, float opacity, float cosT, float lightMul,
                const in bool deep, const in bool vert){
  float t = height / max(rd.y, 1e-4);
  // Intersect the plane in *world* space so the decks parallax against each
  // other as the camera drives: for the same travel the low deck shifts ~7x
  // further across the noise than the cirrus, which is the whole point of
  // having three of them.
  vec2 p = (uCamXZ + rd.xz * t) * scale + drift;
  // Real footprint from the screen-space derivative — resolution and fov
  // independent, and correct near the horizon where the plane projection
  // compresses the field by 1/rd.y^2. Computed before any early-out so the
  // derivative stays in uniform control flow.
  float lod = clamp(log2(max(max(fwidth(p.x), fwidth(p.y)), 1e-7) * NOISE_PX), 0.0, 6.0);
  if (rd.y <= 0.004 || t > 260000.0) return vec4(0.0);

  float d = layerDensity(p, cov, erode, lod);
  if (d <= 0.003) return vec4(0.0);

  // Self-shadowing: step toward the sun in plane space. The step grows as the
  // sun drops, which is what makes a low sun rake across the deck.
  vec2 so = normalize(uSunDir.xz + vec2(1e-4)) * (0.022 + 0.013 / max(0.15, abs(uSunDir.y)));
  float s1 = layerDensity(p + so, cov, erode, lod);
  float s2 = deep ? layerDensity(p + so * 2.7, cov, erode, lod + 0.5) : s1 * 0.8;
  float occ = clamp(s1 * 0.75 + s2 * 0.45, 0.0, 1.4);
  float lightE = exp(-occ * 2.35);

  // Zenith-ward tap. Where the mass thins towards the zenith we are looking at
  // its top; where it thickens we are under its base.
  float topLit = 0.62;
  if (vert) {
    float dz = layerDensity(p - normalize(rd.xz + vec2(1e-4)) * 0.030, cov, erode, lod);
    topLit = 0.5 + 0.5 * clamp((d - dz) * 2.1, -1.0, 1.0);
  }

  // Beer-powder: thin edges glow, thick cores go dark.
  float powder = 1.0 - exp(-d * 5.5);
  float phase  = hgPhase(cosT, 0.62) * 3.2 + hgPhase(cosT, -0.16) * 1.1;

  float shade = lightE * mix(0.34, 1.0, topLit) * (0.52 + 0.48 * powder);
  vec3 col = mix(uCloudDark, uCloudLit, clamp(shade, 0.0, 1.0));
  col += uCloudLit * phase * lightE * 0.26 * lightMul * (0.40 + 0.60 * powder);
  // Silver lining. (d - s1) > 0 is exactly the rim that faces the sun, so the
  // lining needs no samples of its own.
  float rim = clamp((d - s1) * 3.4, 0.0, 1.0) * (1.0 - d * 0.55);
  col += uCloudLit * rim * (0.55 + 1.9 * pow(clamp(cosT, 0.0, 1.0), 4.0)) * lightMul;
  // Sky fill on the base only, so ambient never washes the lit tops.
  col = mix(col, uCloudLit * uCloudAmbient, 0.20 * (1.0 - topLit));

  float a = clamp(d * opacity * 1.25, 0.0, 1.0);
  a *= smoothstep(0.010, 0.085, rd.y);
  // uCloudLum lifts the deck above the graded sky so tops read bright and
  // bottoms read as shadow instead of both saturating to white.
  return vec4(col * a * uCloudLum, a);
}

// --- night ------------------------------------------------------------------
float starLayer(vec3 rd, float scale, float thresh, float sharp){
  vec3 p = rd * scale;
  vec3 i = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(i);
  if (h < thresh) return 0.0;
  vec3 jit = vec3(hash13(i + 1.7), hash13(i + 3.3), hash13(i + 5.9)) - 0.5;
  float d = length(f - jit * 0.62);
  float mag = (h - thresh) / (1.0 - thresh);
  float tw = 0.72 + 0.28 * sin(uTime * (1.4 + mag * 5.0) + h * 63.0);
  return pow(smoothstep(0.20 * (0.35 + mag), 0.0, d), sharp) * mag * tw;
}

vec3 nightSky(vec3 rd){
  vec3 c = mix(vec3(0.008, 0.014, 0.032), vec3(0.020, 0.031, 0.062),
               pow(clamp(1.0 - rd.y, 0.0, 1.0), 2.0));

  // Milky Way band
  vec3 axis = normalize(vec3(0.42, 0.46, -0.78));
  float band = exp(-pow(dot(rd, axis), 2.0) * 26.0);
  vec4 mw = nz(rd.xz * 0.55 + rd.y * 0.31 + 0.5, 0.0);
  float mwv = band * (0.30 + mw.r * 0.85) * (0.55 + mw.g * 0.75);
  c += mix(vec3(0.24, 0.26, 0.40), vec3(0.42, 0.34, 0.30), mw.b) * mwv * 0.34;

  float s1 = starLayer(rd, 130.0, 0.955, 1.4);
  float s2 = starLayer(rd, 300.0, 0.982, 1.9);
  float s3 = starLayer(rd, 62.0, 0.9955, 1.1);
  vec3 warm = vec3(1.0, 0.86, 0.70);
  vec3 cool = vec3(0.74, 0.85, 1.0);
  float ct = hash13(floor(rd * 130.0));
  c += mix(cool, warm, ct) * (s1 * 1.6 + s2 * 0.9) * (0.35 + band * 0.5 + 0.65);
  c += vec3(1.0, 0.95, 0.88) * s3 * 5.5;
  c *= smoothstep(-0.06, 0.10, rd.y);

  // Moon
  float cm = dot(rd, uMoonDir);
  if (cm > 0.9) {
    vec3 mt = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.02)));
    vec3 mb = cross(mt, uMoonDir);
    float R = 0.0295;
    vec2 mc = vec2(dot(rd, mt), dot(rd, mb)) / R;
    float r2 = dot(mc, mc);
    if (r2 < 1.25) {
      float edge = smoothstep(1.0, 0.965, r2);
      vec3 n = normalize(vec3(mc, sqrt(max(1e-4, 1.0 - min(r2, 0.999)))));
      float c1 = nz(mc * 0.30 + 0.5, 0.0).r;
      float c2 = nz(mc * 0.95 + 0.21, 0.0).g;
      float c3 = nz(mc * 2.6 + 0.77, 0.0).b;
      vec3 bump = vec3((c1 - 0.5) * 1.15 + (c2 - 0.5) * 0.65 + (c3 - 0.5) * 0.3,
                       (c2 - 0.5) * 1.15 + (c3 - 0.5) * 0.55 + (c1 - 0.5) * 0.3, 0.0);
      vec3 nn = normalize(n + bump * 0.62);
      vec3 ml = normalize(vec3(-0.55, 0.30, 0.78));
      float lit = clamp(dot(nn, ml), 0.0, 1.0);
      float mare = smoothstep(0.44, 0.66, c1) * 0.42;
      vec3 mcol = mix(vec3(0.95, 0.93, 0.87), vec3(0.50, 0.53, 0.60), mare);
      c += mcol * (lit * 3.2 + 0.10) * edge;
    }
    c += vec3(0.55, 0.62, 0.85) * pow(max(cm, 0.0), 260.0) * 0.55;
    c += vec3(0.30, 0.38, 0.60) * pow(max(cm, 0.0), 24.0) * 0.09;
  }

  // Distant city glow hugging the horizon
  float glow = pow(clamp(1.0 - abs(rd.y) * 6.5, 0.0, 1.0), 2.6);
  float az = atan(rd.z, rd.x);
  float cityMask = 0.45 + 0.55 * nz(vec2(az * 0.55, 0.31), 1.0).r;
  c += vec3(0.55, 0.36, 0.20) * glow * cityMask * uCityGlow * 0.55;
  return c;
}

// --- volcanic embers --------------------------------------------------------
float embers(vec3 rd){
  if (rd.y < 0.015) return 0.0;
  vec2 p = rd.xz / rd.y * 0.55;
  p.y -= uTime * 0.09;
  p.x += sin(uTime * 0.3 + p.y * 3.0) * 0.08;
  vec2 g = p * 26.0;
  vec2 i = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash12(i);
  if (h < 0.935) return 0.0;
  float d = length(f - (hash22(i) - 0.5) * 0.7);
  float life = 0.55 + 0.45 * sin(uTime * 5.0 + h * 90.0);
  return smoothstep(0.085, 0.0, d) * life * smoothstep(0.02, 0.25, rd.y);
}

void main(){
  vec3 rd = normalize(vDir);

  float sunDisc;
  vec3 col = skyGrade(atmosphere(rd, sunDisc));

  if (uNight > 0.001) col = mix(col, nightSky(rd), uNight);

  float cosT = dot(rd, uSunDir);
  float lightMul = mix(1.0, 0.10, uNight);

  // Three parallaxed cloud decks — high cirrus, main cumulus, low scud.
  //
  // The scales set the feature size, and they matter as much as the coverage:
  // 1/scale is the tile size in metres, and the G channel (base frequency 7)
  // carries the cumulus masses. The middle deck at 1.05e-4 tiles every 9.5 km,
  // so its masses are ~1.4 km across and its erosion detail ~560 m — cumulus.
  // The old 5.6e-5 put the dominant structure at 2.5 km, which is why even a
  // working density would have read as one continuous smear.
  // The cirrus deck is anisotropic on purpose: unequal x/z scales stretch the
  // same noise into streaks.
  float t = uTime * uCloudSpeed;
  vec4 hi  = cloudLayer(rd, 7000.0, vec2(0.000030, 0.000078), vec2(0.0042, 0.0021) * t,
                        uCloudCoverage * 0.55, uCloudErode * 1.35, uCloudOpacity * 0.42,
                        cosT, lightMul, false, false);
  vec4 mid = cloudLayer(rd, 3100.0, vec2(0.000105, 0.000105), vec2(0.0069, 0.0033) * t,
                        uCloudCoverage, uCloudErode, uCloudOpacity,
                        cosT, lightMul, true, true);
  vec4 low = cloudLayer(rd, 1550.0, vec2(0.000205, 0.000205), vec2(0.0112, 0.0058) * t,
                        uCloudCoverage * 0.72, uCloudErode * 0.8, uCloudOpacity * 0.68,
                        cosT, lightMul, false, true);

  // back-to-front composite
  col = col * (1.0 - hi.a)  + hi.rgb;
  col = col * (1.0 - mid.a) + mid.rgb;
  col = col * (1.0 - low.a) + low.rgb;

  // Lightning: illuminates the cloud deck from within.
  if (uLightning > 0.001) {
    float m = max(mid.a, low.a);
    col += vec3(0.72, 0.80, 1.0) * uLightning * (0.35 + m * 3.2)
         * smoothstep(-0.05, 0.55, rd.y);
  }

  if (uEmbers > 0.001) col += vec3(1.0, 0.42, 0.10) * embers(rd) * uEmbers * 2.4;

  // Horizon haze — a narrow band that lets terrain sit *into* the sky. Wide,
  // bright haze is what read as a white veil over the whole upper hemisphere,
  // so the band is tight and its radiance is capped well under the zenith.
  float hb = smoothstep(0.14, -0.045, rd.y);
  vec3 hazeCol = uHaze * uHazeLum * (0.85 + 0.7 * pow(clamp(cosT, 0.0, 1.0), 5.0));
  col = mix(col, hazeCol, hb * uHazeStrength);

  // The haze mix is itself a per-channel warm/cool crossover, so it can create a
  // green midpoint of its own inside the band. Same collapse, applied after.
  if (uChromaDip > 0.001 && hb > 0.001) {
    col = creamify(col, crossoverAmount(col) * uChromaDip * hb * 0.80);
  }

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

const RAY_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RAY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uStrength;
uniform vec3  uColor;

void main(){
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  float ang = atan(c.y, c.x) / 6.2831853 + 0.5;

  // Two counter-drifting streak fields = believable crepuscular breakup.
  float s1 = textureLod(uNoise, vec2(ang * 3.0 + uTime * 0.006, r * 0.16 + 0.13), 1.0).r;
  float s2 = textureLod(uNoise, vec2(ang * 7.0 - uTime * 0.010, r * 0.09 + 0.61), 2.0).g;
  float streak = pow(clamp(s1 * 0.72 + s2 * 0.55, 0.0, 1.0), 2.6);

  float falloff = pow(1.0 - r, 2.2);
  float core = pow(1.0 - r, 9.0);
  float a = (streak * falloff * 0.85 + core * 0.55) * uStrength;
  gl_FragColor = vec4(uColor * a, a);
}
`;

// ---------------------------------------------------------------------------

const _tmpV = new THREE.Vector3();

export class Sky implements ISubsystem {
  readonly sunDirection = new THREE.Vector3(0.4, 0.7, 0.55).normalize();
  readonly moonDirection = new THREE.Vector3(-0.4, 0.5, -0.7).normalize();
  /** Key-light direction: the sun by day, the moon at night. */
  readonly keyDirection = new THREE.Vector3(0.4, 0.7, 0.55).normalize();

  presetName: SkyPresetName = 'day';
  preset: SkyPreset = SKY_PRESETS.day;
  /** False until `setPreset` has actually applied a preset once. */
  private presetApplied = false;
  /** 0..1 lightning flash, read by Lighting for the light-intensity pop. */
  lightningFlash = 0;

  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;

  private mesh!: THREE.Mesh;
  private captureMesh!: THREE.Mesh;
  private material!: THREE.ShaderMaterial;
  private noise!: THREE.DataTexture;

  private rayMesh!: THREE.Mesh;
  private rayMat!: THREE.ShaderMaterial;

  private captureScene = new THREE.Scene();
  private cubeRT!: THREE.WebGLCubeRenderTarget;
  private cubeCam!: THREE.CubeCamera;
  private pmrem!: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private _envTex: THREE.Texture | null = null;

  private envDirty = true;
  private envTimer = 0;
  private nextStrike = 2.5;
  private strikeEnergy = 0;
  private initialised = false;
  private time = 0;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;
  }

  /** PMREM environment for IBL. Valid after `init()`. */
  get environmentTexture(): THREE.Texture {
    return this._envTex as THREE.Texture;
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;

    this.noise = makeCloudNoise(256);

    const uniforms: Record<string, THREE.IUniform> = {
      uSunDir: { value: this.sunDirection },
      uMoonDir: { value: this.moonDirection },
      uTime: { value: 0 },
      uNoise: { value: this.noise },
      uTurbidity: { value: 2.4 },
      uRayleigh: { value: 1.9 },
      uMie: { value: 0.0042 },
      uMieG: { value: 0.8 },
      uSunIntensity: { value: 1 },
      uSkyScale: { value: 0.38 },
      uSkyGamma: { value: 0.42 },
      uSkySat: { value: 1.42 },
      uChromaDip: { value: 0.55 },
      uCamXZ: { value: new THREE.Vector2() },
      uCloudCoverage: { value: 0.42 },
      uCloudErode: { value: 0.55 },
      uCloudOpacity: { value: 1 },
      uCloudSpeed: { value: 1 },
      uCloudLit: { value: new THREE.Color(0xfff8ee) },
      uCloudDark: { value: new THREE.Color(0x53749c) },
      uCloudAmbient: { value: 0.34 },
      uCloudLum: { value: 2.3 },
      uHaze: { value: new THREE.Color(0x9dc3ea) },
      uHazeStrength: { value: 0.6 },
      uHazeLum: { value: 1.0 },
      uNight: { value: 0 },
      uCityGlow: { value: 0 },
      uEmbers: { value: 0 },
      uLightning: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
    });

    const geo = new THREE.SphereGeometry(1, 48, 32);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.scale.setScalar(900);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.SKY;
    this.mesh.matrixAutoUpdate = true;
    this.mesh.name = 'SkyDome';
    this.scene.add(this.mesh);

    // Separate instance for the cube capture (shares the material).
    this.captureMesh = new THREE.Mesh(geo, this.material);
    this.captureMesh.scale.setScalar(50);
    this.captureMesh.frustumCulled = false;
    this.captureScene.add(this.captureMesh);

    // --- god-ray billboard ---------------------------------------------------
    this.rayMat = new THREE.ShaderMaterial({
      uniforms: {
        uNoise: { value: this.noise },
        uTime: { value: 0 },
        uStrength: { value: 0 },
        uColor: { value: new THREE.Color(0xffb066) },
      },
      vertexShader: RAY_VERT,
      fragmentShader: RAY_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.rayMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.rayMat);
    this.rayMesh.scale.setScalar(1500);
    this.rayMesh.frustumCulled = false;
    this.rayMesh.renderOrder = RENDER_ORDER.PARTICLE_ADDITIVE - 5;
    this.rayMesh.name = 'SunShafts';
    this.scene.add(this.rayMesh);

    // --- PMREM ---------------------------------------------------------------
    this.cubeRT = new THREE.WebGLCubeRenderTarget(128, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeCam = new THREE.CubeCamera(0.5, 200, this.cubeRT);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileCubemapShader();

    this.setPreset('day');
    this.refreshEnvironment();
    worldRegistry.sky = this;
  }

  // -------------------------------------------------------------------------

  setPreset(name: SkyPresetName): void {
    // Cheap and idempotent, so re-pushing a preset from anywhere is free: the
    // tail of this method dirties the PMREM, and rebuilding the IBL for a
    // preset that is already applied is a cube render plus a convolution for
    // nothing. Cannot early-out on `name === this.presetName` alone — `init()`
    // calls `setPreset('day')` while `presetName` is already 'day' from the
    // field initialiser, and that first call is what fills the uniforms.
    if (this.presetApplied && name === this.presetName) return;
    this.presetApplied = true;
    const p = SKY_PRESETS[name] ?? SKY_PRESETS.day;
    this.presetName = name;
    this.preset = p;

    const el = THREE.MathUtils.degToRad(p.sunElevation);
    const az = THREE.MathUtils.degToRad(p.sunAzimuth);
    this.sunDirection.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();

    const mel = THREE.MathUtils.degToRad(p.moonElevation);
    const maz = THREE.MathUtils.degToRad(p.moonAzimuth);
    this.moonDirection.set(Math.cos(mel) * Math.sin(maz), Math.sin(mel), -Math.cos(mel) * Math.cos(maz)).normalize();

    // At night the moon is the key light.
    if (p.night > 0.5 && p.moonElevation > 0) this.keyDirection.copy(this.moonDirection);
    else this.keyDirection.copy(this.sunDirection);
    if (this.keyDirection.y < 0.05) {
      this.keyDirection.y = 0.05;
      this.keyDirection.normalize();
    }

    if (!this.material) return;
    const u = this.material.uniforms;
    u.uTurbidity.value = p.turbidity;
    u.uRayleigh.value = p.rayleigh;
    u.uMie.value = p.mie;
    u.uMieG.value = p.mieG;
    u.uSunIntensity.value = p.sunIntensity;
    u.uSkyScale.value = p.skyScale;
    u.uSkyGamma.value = p.skyGamma;
    u.uSkySat.value = p.skySat;
    u.uChromaDip.value = p.chromaDip;
    u.uCloudCoverage.value = p.cloudCoverage;
    u.uCloudErode.value = p.cloudErode;
    u.uCloudOpacity.value = p.cloudOpacity;
    u.uCloudSpeed.value = p.cloudSpeed;
    (u.uCloudLit.value as THREE.Color).setHex(p.cloudLit);
    (u.uCloudDark.value as THREE.Color).setHex(p.cloudDark);
    u.uCloudAmbient.value = p.cloudAmbient;
    u.uCloudLum.value = p.cloudLum;
    (u.uHaze.value as THREE.Color).setHex(p.haze);
    u.uHazeStrength.value = p.hazeStrength;
    u.uHazeLum.value = p.hazeLum;
    u.uNight.value = p.night;
    u.uCityGlow.value = p.cityGlow;
    u.uEmbers.value = p.embers;

    (this.rayMat.uniforms.uColor.value as THREE.Color).setHex(p.godRayColor);
    this.rayMesh.visible = p.godRays > 0.01;

    this.envDirty = true;
    this.envTimer = 0;
  }

  /** Re-render the sky to a cube map and rebuild the PMREM environment. */
  refreshEnvironment(): void {
    if (!this.cubeCam) return;
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = true;
    this.cubeCam.update(this.renderer, this.captureScene);
    this.renderer.autoClear = prevAutoClear;

    const next = this.pmrem.fromCubemap(this.cubeRT.texture);
    if (this.envRT) this.envRT.dispose();
    this.envRT = next;
    this._envTex = next.texture;
    this.scene.environment = next.texture;
    // The IBL is the second half of the fill light. It used to run at 1.0
    // against a sky that was ~20x too hot, which is most of why every surface
    // read as the same flat mid-grey. Per-preset now, and deliberately small.
    this.scene.environmentIntensity = this.preset.envIntensity;
    this.envDirty = false;
  }

  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    if (!this.initialised) return;
    this.time += ctx.dt;
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    this.rayMat.uniforms.uTime.value = this.time;

    // --- lightning -----------------------------------------------------------
    if (this.preset.lightning > 0.01) {
      this.nextStrike -= ctx.dt;
      if (this.nextStrike <= 0) {
        this.strikeEnergy = 0.85 + Math.random() * 0.9;
        this.nextStrike = 2.0 + Math.random() * 6.5;
      }
      // Sharp attack, exponential decay, with a double-flicker.
      this.strikeEnergy = damp(this.strikeEnergy, 0, 0.045, ctx.dt);
      const flicker = 0.55 + 0.45 * Math.sin(this.time * 70);
      this.lightningFlash = this.strikeEnergy * flicker;
      if (this.lightningFlash < 0.002) this.lightningFlash = 0;
    } else {
      this.lightningFlash = 0;
    }
    u.uLightning.value = this.lightningFlash;

    // --- keep the dome and shafts pinned to the camera ------------------------
    const cam = this.currentCamera;
    if (cam) {
      this.mesh.position.copy(cam.position);
      // Cloud decks are intersected in world space, so they need the camera's
      // ground position to parallax against each other.
      (u.uCamXZ.value as THREE.Vector2).set(cam.position.x, cam.position.z);
      _tmpV.copy(this.sunDirection).multiplyScalar(760).add(cam.position);
      this.rayMesh.position.copy(_tmpV);
      this.rayMesh.quaternion.copy(cam.quaternion);
    }

    // Shafts are strongest when the sun is low and near the view direction.
    const p = this.preset;
    if (p.godRays > 0.01 && cam) {
      const facing = clamp01(
        _tmpV.set(0, 0, -1).applyQuaternion(cam.quaternion).dot(this.sunDirection) * 1.35 - 0.05,
      );
      const lowSun = clamp01(1.15 - Math.abs(this.sunDirection.y) * 1.6);
      this.rayMat.uniforms.uStrength.value = p.godRays * facing * lowSun * 0.85;
      this.rayMesh.visible = this.rayMat.uniforms.uStrength.value > 0.004;
    } else if (this.rayMesh) {
      this.rayMesh.visible = false;
    }

    // --- periodic IBL refresh so drifting clouds affect the lighting ---------
    this.envTimer += ctx.dt;
    if (this.envDirty || this.envTimer > 6) {
      this.envTimer = 0;
      this.refreshEnvironment();
    }
  }

  /** Set by Lighting/Environment so the dome can follow the active camera. */
  currentCamera: THREE.Camera | null = null;

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    this.noise?.dispose();
    this.rayMesh?.geometry.dispose();
    this.rayMat?.dispose();
    this.cubeRT?.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
    this.scene.remove(this.mesh);
    this.scene.remove(this.rayMesh);
    this.captureScene.clear();
  }
}
