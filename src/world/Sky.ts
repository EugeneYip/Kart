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
    skyScale: 0.34, skyGamma: 0.42, skySat: 1.30,
    cloudCoverage: 0.46, cloudErode: 0.55, cloudOpacity: 1.0, cloudSpeed: 1.0,
    cloudLit: 0xfff8ee, cloudDark: 0x53749c, cloudAmbient: 0.34, cloudLum: 2.3,
    haze: 0x9dc3ea, hazeStrength: 0.60, hazeLum: 1.00,
    night: 0, cityGlow: 0, embers: 0, lightning: 0,
    keyColor: 0xfff1d6, keyIntensity: 3.9,
    skyAmbient: 0x8fbdf2, groundAmbient: 0x5d5747, ambientIntensity: 0.36,
    bounceColor: 0x8f8a63, bounceIntensity: 0.45,
    rimColor: 0xbcd8ff, rimIntensity: 0.22,
    fogColor: 0x5c80b0, fogSunColor: 0xffe3ae, fogDensity: 0.00085, fogHeight: 3, fogFalloff: 0.020,
    envIntensity: 0.40,
    godRays: 0.18, godRayColor: 0xfff0d0, shadowIntensity: 1.0,
  }),
  sunset: P({
    sunElevation: 4.5, sunAzimuth: -74, moonElevation: 22, moonAzimuth: 120,
    turbidity: 5.4, rayleigh: 3.3, mie: 0.014, mieG: 0.872, sunIntensity: 1.1,
    skyScale: 0.50, skyGamma: 0.44, skySat: 1.32,
    cloudCoverage: 0.50, cloudErode: 0.42, cloudOpacity: 1.0, cloudSpeed: 0.75,
    cloudLit: 0xffc98a, cloudDark: 0x3a2b45, cloudAmbient: 0.30, cloudLum: 2.0,
    haze: 0xff9a5e, hazeStrength: 0.68, hazeLum: 0.95,
    night: 0, cityGlow: 0.1, embers: 0, lightning: 0,
    keyColor: 0xffa055, keyIntensity: 3.7,
    skyAmbient: 0x6f8fd4, groundAmbient: 0x3a2c26, ambientIntensity: 0.38,
    bounceColor: 0xa35f38, bounceIntensity: 0.5,
    rimColor: 0x8fb4ff, rimIntensity: 0.36,
    fogColor: 0x8a5a4a, fogSunColor: 0xffbe80, fogDensity: 0.00105, fogHeight: 2, fogFalloff: 0.017,
    envIntensity: 0.45,
    godRays: 1.0, godRayColor: 0xffb066, shadowIntensity: 1.0,
  }),
  night: P({
    sunElevation: -16, sunAzimuth: -74, moonElevation: 42, moonAzimuth: -30,
    turbidity: 1.8, rayleigh: 0.7, mie: 0.0035, mieG: 0.78, sunIntensity: 1.0,
    skyScale: 0.30, skyGamma: 0.50, skySat: 1.15,
    cloudCoverage: 0.33, cloudErode: 0.6, cloudOpacity: 0.9, cloudSpeed: 0.6,
    cloudLit: 0x6b7c98, cloudDark: 0x0a0e1a, cloudAmbient: 0.25, cloudLum: 1.1,
    haze: 0x121b30, hazeStrength: 0.72, hazeLum: 0.55,
    night: 1, cityGlow: 1.0, embers: 0, lightning: 0,
    keyColor: 0x9ab0e8, keyIntensity: 1.05,
    skyAmbient: 0x1d2a4a, groundAmbient: 0x0d1018, ambientIntensity: 0.62,
    bounceColor: 0x1a2138, bounceIntensity: 0.35,
    rimColor: 0x7fd0ff, rimIntensity: 0.65,
    fogColor: 0x141d33, fogSunColor: 0x2c3a5e, fogDensity: 0.00120, fogHeight: 2, fogFalloff: 0.021,
    envIntensity: 0.90,
    godRays: 0.0, godRayColor: 0x9fb6ff, shadowIntensity: 0.85,
  }),
  storm: P({
    sunElevation: 27, sunAzimuth: 150, moonElevation: -30, moonAzimuth: 20,
    turbidity: 9.5, rayleigh: 1.1, mie: 0.022, mieG: 0.70, sunIntensity: 0.55,
    skyScale: 0.34, skyGamma: 0.46, skySat: 1.06,
    cloudCoverage: 0.88, cloudErode: 0.22, cloudOpacity: 1.0, cloudSpeed: 2.4,
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
  volcanic: P({
    sunElevation: 11, sunAzimuth: 196, moonElevation: -20, moonAzimuth: 10,
    turbidity: 8.5, rayleigh: 2.6, mie: 0.032, mieG: 0.90, sunIntensity: 0.85,
    skyScale: 0.46, skyGamma: 0.45, skySat: 1.22,
    cloudCoverage: 0.64, cloudErode: 0.35, cloudOpacity: 1.0, cloudSpeed: 1.4,
    cloudLit: 0xff7a3a, cloudDark: 0x1e0c10, cloudAmbient: 0.42, cloudLum: 1.8,
    haze: 0x8f3a20, hazeStrength: 0.76, hazeLum: 0.85,
    night: 0, cityGlow: 0, embers: 1, lightning: 0,
    keyColor: 0xff7a45, keyIntensity: 2.9,
    skyAmbient: 0x7d2f20, groundAmbient: 0x33100a, ambientIntensity: 0.48,
    bounceColor: 0xd94a1e, bounceIntensity: 0.8,
    rimColor: 0xff9a5c, rimIntensity: 0.42,
    fogColor: 0x5e1e16, fogSunColor: 0xff8a44, fogDensity: 0.0024, fogHeight: 2, fogFalloff: 0.018,
    envIntensity: 0.60,
    godRays: 0.8, godRayColor: 0xff8038, shadowIntensity: 0.82,
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
vec3 skyGrade(vec3 c){
  float l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
  float lo = uSkyScale * pow(l, uSkyGamma);
  c *= lo / l;
  return max(mix(vec3(lo), c, uSkySat), vec3(0.0));
}

// --- clouds -----------------------------------------------------------------
vec4 nz(vec2 uv, float lod){ return textureLod(uNoise, uv, lod); }

float layerDensity(vec2 p, float cov, float erode, float lod){
  vec2 w = nz(p * 0.21 + vec2(0.011, 0.007) * uTime, lod + 1.0).ba;
  vec2 q = p + (w - 0.5) * 0.62;
  vec4 n = nz(q, lod);
  float base = n.r * 0.60 + n.g * 0.28 + n.b * 0.12;
  float d = (base - (1.0 - cov)) / max(cov, 1e-3);
  d = clamp(d * 1.55 - n.b * erode * 0.85, 0.0, 1.0);
  return d;
}

/** rgb = premultiplied colour, a = coverage */
vec4 cloudLayer(vec3 rd, float height, float scale, vec2 drift,
                float cov, float erode, float opacity, float cosT, float lightMul){
  if (rd.y <= 0.004) return vec4(0.0);
  float t = height / rd.y;
  if (t > 260000.0) return vec4(0.0);
  vec2 p = rd.xz * t * scale + drift;
  float lod = clamp(log2(1.0 + t * scale * 220.0) - 3.0, 0.0, 6.0);

  float d = layerDensity(p, cov, erode, lod);
  if (d <= 0.002) return vec4(0.0);

  // Self-shadowing: march a couple of steps toward the sun in plane space.
  vec2 so = normalize(uSunDir.xz + vec2(1e-4)) * (0.020 + 0.012 / max(0.15, abs(uSunDir.y)));
  float s1 = layerDensity(p + so,        cov, erode, lod);
  float s2 = layerDensity(p + so * 2.6,  cov, erode, lod + 0.5);
  float occ = clamp(s1 * 0.75 + s2 * 0.45, 0.0, 1.4);
  float lightE = exp(-occ * 2.4);

  // Beer-powder: thin edges glow, thick cores go dark.
  float powder = 1.0 - exp(-d * 5.5);
  float phase  = hgPhase(cosT, 0.62) * 5.0 + hgPhase(cosT, -0.15) * 1.4;

  vec3 col = mix(uCloudDark, uCloudLit, lightE * (0.55 + 0.45 * powder));
  col += uCloudLit * phase * lightE * 0.30 * lightMul;
  // Silver lining — thin, sun-facing edges.
  col += uCloudLit * pow(clamp(cosT, 0.0, 1.0), 9.0) * (1.0 - d) * lightE * 1.9 * lightMul;
  col = mix(col, uCloudLit * uCloudAmbient, 0.18);

  float a = clamp(d * opacity * 1.35, 0.0, 1.0);
  a *= smoothstep(0.006, 0.075, rd.y);
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
  float t = uTime * uCloudSpeed;
  vec4 hi  = cloudLayer(rd, 7000.0, 0.0000225, vec2(0.0042, 0.0021) * t,
                        uCloudCoverage * 0.62, uCloudErode * 1.4, uCloudOpacity * 0.5, cosT, lightMul);
  vec4 mid = cloudLayer(rd, 3100.0, 0.0000560, vec2(0.0069, 0.0033) * t,
                        uCloudCoverage, uCloudErode, uCloudOpacity, cosT, lightMul);
  vec4 low = cloudLayer(rd, 1550.0, 0.0001150, vec2(0.0112, 0.0058) * t,
                        uCloudCoverage * 0.78, uCloudErode * 0.8, uCloudOpacity * 0.72, cosT, lightMul);

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
