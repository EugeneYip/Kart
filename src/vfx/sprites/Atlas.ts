import * as THREE from 'three';
import type { QualitySettings } from '@/core/Types';
import type { Painter } from './Painters';
import {
  paintGlow, paintSpark, paintSmoke, paintDust, paintDroplet, paintFlame,
  paintStar, paintRing, paintBolt, paintLeaf, paintEmber, paintChip,
  paintFlare, paintConfetti, paintSplat, paintMist,
} from './Painters';

/**
 * Sprite atlas cell ids. 4x4 grid — one texture, one draw call per blend mode.
 * Row/column placement is handled by the builder; effects only ever use these.
 */
export const SPRITE = {
  GLOW: 0,
  SPARK: 1,
  SMOKE: 2,
  DUST: 3,
  DROPLET: 4,
  FLAME: 5,
  STAR: 6,
  RING: 7,
  BOLT: 8,
  LEAF: 9,
  EMBER: 10,
  CHIP: 11,
  FLARE: 12,
  CONFETTI: 13,
  SPLAT: 14,
  MIST: 15,
} as const;
export type SpriteId = (typeof SPRITE)[keyof typeof SPRITE];

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;
/** Fraction of a cell kept transparent on each side, so mips don't bleed. */
export const ATLAS_INSET = 0.055;

const PAINTERS: Painter[] = [
  paintGlow, paintSpark, paintSmoke, paintDust,
  paintDroplet, paintFlame, paintStar, paintRing,
  paintBolt, paintLeaf, paintEmber, paintChip,
  paintFlare, paintConfetti, paintSplat, paintMist,
];

export function buildSpriteAtlas(quality: QualitySettings): THREE.Texture {
  const cell = quality.tier === 'low' ? 128 : quality.tier === 'medium' ? 192 : 256;
  const pad = Math.round(cell * ATLAS_INSET);
  const inner = cell - pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = cell * ATLAS_COLS;
  canvas.height = cell * ATLAS_ROWS;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('[Vfx] 2D context unavailable for sprite atlas');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Each sprite is painted into its own square then blitted into the padded
  // cell. Cell rows are laid out bottom-up so that texture-space row index
  // `floor(id / cols)` matches after the default flipY upload.
  const tmp = document.createElement('canvas');
  tmp.width = inner;
  tmp.height = inner;
  const tctx = tmp.getContext('2d');
  if (!tctx) throw new Error('[Vfx] 2D context unavailable for sprite cell');

  for (let id = 0; id < PAINTERS.length; id++) {
    const col = id % ATLAS_COLS;
    const rowV = Math.floor(id / ATLAS_COLS);
    const rowCanvas = ATLAS_ROWS - 1 - rowV;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
    tctx.globalAlpha = 1;
    tctx.clearRect(0, 0, inner, inner);
    PAINTERS[id](tctx, inner);
    ctx.drawImage(tmp, col * cell + pad, rowCanvas * cell + pad);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // pure alpha mask, RGB is white
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.min(4, quality.anisotropy);
  tex.needsUpdate = true;
  tex.name = 'vfx-sprite-atlas';
  return tex;
}

// ---------------------------------------------------------------------------
// Colour-over-life gradient LUT
// ---------------------------------------------------------------------------

/** Gradient row ids. RGB is authored in sRGB hex, alpha is linear opacity. */
export const RAMP = {
  WHITE: 0,
  WHITE_SHARP: 1,
  BLUE_SPARK: 2,
  ORANGE_SPARK: 3,
  PURPLE_SPARK: 4,
  CHARGE_WISP: 5,
  FLAME: 6,
  FLAME_BLUE: 7,
  RAINBOW: 8,
  SMOKE: 9,
  SMOKE_DARK: 10,
  DUST: 11,
  GRASS: 12,
  SAND: 13,
  WATER: 14,
  SNOW: 15,
  METAL_SPARK: 16,
  FIREBALL: 17,
  ELECTRIC: 18,
  GOLD: 19,
  INK: 20,
  DEBRIS: 21,
  STAR_YELLOW: 22,
  TRAIL_BOOST: 23,
  GHOST: 24,
  EMBER: 25,
  SPRAY: 26,
  SMOKE_LIGHT: 27,
} as const;
export type RampId = (typeof RAMP)[keyof typeof RAMP];

export const RAMP_ROWS = 28;
export const RAMP_WIDTH = 128;

interface Stop { t: number; c: number; i: number; a: number }
const S = (t: number, c: number, i: number, a: number): Stop => ({ t, c, i, a });

/**
 * `c` = sRGB hex, `i` = HDR intensity multiplier (>1 blooms), `a` = opacity.
 *
 * TUNED AGAINST THE MEASURED GRADE, NOT A GUESS. The colour grade is now
 * AgX at **exposure 0.70** (it was 1.3), meanSat 0.508, 0 % blown highlights,
 * bloom `threshold 0.85, smoothing 0.1, radius 0.62, intensity 0.72`.
 *
 * Two consequences drive every number below:
 *
 *  1. Halving the exposure halves what reaches the tone curve, so every
 *     emissive authored against 1.3 now lands roughly an octave too dim and
 *     stops crossing the 0.85 bloom threshold. Hot cores are scaled UP ~1.3x.
 *  2. Counter-intuitively the lower exposure makes colour *stronger*, because
 *     less of the frame reaches AgX's desaturating shoulder. So the coloured
 *     mid-section of each spark ramp is raised too — it no longer washes to
 *     white the way it did at 1.3 — and the pure-white lead-in stays short.
 *
 * Smoke is the other half of the story: it is drawn PREMULTIPLIED, so a dark
 * smoke colour does not "look dark", it *subtracts* — it punches a hole in
 * whatever is behind it, including the sky. Every smoke ramp is therefore
 * lifted well above mid-grey and its peak alpha cut; smoke must read as haze
 * you can see through, never as a silhouette.
 */
const RAMPS: Record<number, Stop[]> = {
  [RAMP.WHITE]: [S(0, 0xffffff, 1.6, 0), S(0.12, 0xffffff, 1.4, 1), S(1, 0xffffff, 1.0, 0)],
  [RAMP.WHITE_SHARP]: [S(0, 0xffffff, 3.2, 1), S(0.55, 0xffffff, 1.7, 0.8), S(1, 0xffffff, 0.6, 0)],

  // The white-hot lead-in is deliberately only ~5 % of life. A longer one makes
  // drift sparks read as generic white sparkles instead of "I am at BLUE tier".
  // The tier colour has to be unmistakable on the very first frame.
  [RAMP.BLUE_SPARK]: [
    S(0, 0xffffff, 5.6, 1), S(0.05, 0xcfeeff, 4.8, 1), S(0.16, 0x4fb0ff, 4.0, 0.98),
    S(0.55, 0x1560ff, 2.6, 0.70), S(1, 0x0a2470, 0.9, 0),
  ],
  [RAMP.ORANGE_SPARK]: [
    S(0, 0xffffff, 6.1, 1), S(0.05, 0xfff0b0, 5.3, 1), S(0.16, 0xffab35, 4.3, 0.98),
    S(0.55, 0xff5a08, 2.8, 0.70), S(1, 0x7a1c00, 0.8, 0),
  ],
  [RAMP.PURPLE_SPARK]: [
    S(0, 0xffffff, 6.6, 1), S(0.05, 0xffc8ff, 5.8, 1), S(0.15, 0xe055ff, 4.7, 0.98),
    S(0.52, 0x8a20ff, 2.9, 0.70), S(1, 0x280058, 0.9, 0),
  ],
  // The very first frames of a drift are now carried by real sparks, but this
  // wisp still has to be *seen* as the "charging" cue rather than guessed at,
  // so it is roughly 1.5x brighter and half again as opaque as before.
  [RAMP.CHARGE_WISP]: [
    S(0, 0xeaf6ff, 2.0, 0), S(0.18, 0xd7ecff, 1.7, 0.72), S(0.55, 0x9fc9ff, 1.2, 0.42),
    S(1, 0x6d9fe0, 0.7, 0),
  ],

  [RAMP.FLAME]: [
    S(0, 0xffffff, 9.0, 1), S(0.08, 0xfff4c4, 6.8, 1), S(0.22, 0xffc247, 4.9, 1),
    S(0.44, 0xff7a10, 2.9, 0.92), S(0.68, 0xd32b00, 1.45, 0.55), S(0.86, 0x4a1206, 0.6, 0.22),
    S(1, 0x1a1210, 0.35, 0),
  ],
  [RAMP.FLAME_BLUE]: [
    S(0, 0xffffff, 9.6, 1), S(0.08, 0xdff2ff, 7.2, 1), S(0.24, 0x74c6ff, 5.0, 1),
    S(0.48, 0x2b7bff, 2.9, 0.9), S(0.74, 0x8a2bff, 1.55, 0.5), S(1, 0x1a0640, 0.5, 0),
  ],
  [RAMP.RAINBOW]: [
    S(0, 0xff3b6b, 3.0, 1), S(0.17, 0xffb02e, 3.0, 1), S(0.34, 0xf7ff45, 3.0, 1),
    S(0.5, 0x4dff88, 3.0, 0.95), S(0.66, 0x37d5ff, 3.0, 0.85), S(0.83, 0x7a5bff, 3.0, 0.6),
    S(1, 0xff5bd6, 2.0, 0),
  ],

  // Lifted hard off the floor. The old 0x9aa1ab @ 0.85 intensity was already
  // dim at exposure 1.3; at 0.70 it landed near black, and because the particle
  // shader outputs PREMULTIPLIED colour a near-black puff at alpha 0.62 does not
  // read as "dark smoke" — it reads as a hole cut in the world, sky included.
  // Peak alpha is cut 0.62 -> 0.40 for the same reason: smoke is a veil.
  [RAMP.SMOKE]: [
    S(0, 0xe8ecf2, 1.45, 0), S(0.10, 0xd2d8e2, 1.30, 0.40), S(0.45, 0xb2bac6, 1.10, 0.26),
    S(1, 0x8e97a4, 0.90, 0),
  ],
  // "Dark" now means *darker than the light smoke*, not black. Same reasoning:
  // 0x3f424a at alpha 0.85 was a silhouette-shaped hole.
  [RAMP.SMOKE_DARK]: [
    S(0, 0x9aa0a8, 1.05, 0), S(0.08, 0x7c828c, 0.95, 0.55), S(0.42, 0x61666f, 0.80, 0.38),
    S(1, 0x44484f, 0.62, 0),
  ],
  [RAMP.SMOKE_LIGHT]: [
    S(0, 0xffffff, 1.50, 0), S(0.12, 0xf2f5fa, 1.35, 0.46), S(0.5, 0xd7dde6, 1.15, 0.28),
    S(1, 0xb4bcc8, 0.95, 0),
  ],

  [RAMP.DUST]: [
    S(0, 0xe8d3ab, 1.5, 0), S(0.09, 0xd7bd8e, 1.4, 0.62), S(0.42, 0xb99a6b, 1.2, 0.40),
    S(1, 0x8a7350, 0.85, 0),
  ],
  [RAMP.GRASS]: [
    S(0, 0xd9f79a, 1.2, 1), S(0.25, 0x86d24a, 1.0, 1), S(0.65, 0x4e9a2c, 0.8, 0.75),
    S(1, 0x2c5c1a, 0.5, 0),
  ],
  [RAMP.SAND]: [
    S(0, 0xfff0c8, 1.25, 0.9), S(0.20, 0xf2d99a, 1.05, 0.85), S(0.6, 0xd7b56d, 0.85, 0.5),
    S(1, 0xa88a4e, 0.6, 0),
  ],
  [RAMP.WATER]: [
    S(0, 0xffffff, 1.7, 0.95), S(0.22, 0xe8f6ff, 1.4, 0.85), S(0.6, 0xbfe2f7, 1.1, 0.45),
    S(1, 0x8fbcd6, 0.8, 0),
  ],
  [RAMP.SPRAY]: [
    S(0, 0xffffff, 1.9, 1), S(0.30, 0xf0fbff, 1.5, 0.7), S(0.7, 0xd2ecfa, 1.1, 0.32),
    S(1, 0xaacfe6, 0.8, 0),
  ],
  [RAMP.SNOW]: [
    S(0, 0xffffff, 1.5, 0.95), S(0.35, 0xf4faff, 1.25, 0.7), S(0.75, 0xdce9f5, 1.0, 0.3),
    S(1, 0xc2d6e6, 0.8, 0),
  ],

  [RAMP.METAL_SPARK]: [
    S(0, 0xffffff, 6.6, 1), S(0.12, 0xfff2cf, 5.3, 1), S(0.38, 0xffd071, 3.8, 0.9),
    S(0.72, 0xff8b2b, 2.2, 0.5), S(1, 0x6b2a00, 0.75, 0),
  ],
  [RAMP.FIREBALL]: [
    S(0, 0xffffff, 9.0, 1), S(0.06, 0xfff8d0, 7.0, 1), S(0.16, 0xffd257, 5.0, 1),
    S(0.34, 0xff8a1e, 3.0, 0.98), S(0.55, 0xdc3a05, 1.5, 0.85), S(0.75, 0x59200c, 0.6, 0.5),
    S(0.9, 0x26201e, 0.35, 0.24), S(1, 0x171514, 0.25, 0),
  ],
  [RAMP.ELECTRIC]: [
    S(0, 0xffffff, 7.0, 1), S(0.16, 0xd8e4ff, 5.0, 1), S(0.42, 0x9f7dff, 3.4, 0.85),
    S(0.75, 0x5a2bd6, 1.8, 0.4), S(1, 0x1b0740, 0.6, 0),
  ],
  [RAMP.GOLD]: [
    S(0, 0xfffbe0, 4.4, 1), S(0.20, 0xffdc5e, 3.4, 1), S(0.55, 0xffae1a, 2.4, 0.85),
    S(1, 0xb06a00, 1.0, 0),
  ],
  [RAMP.STAR_YELLOW]: [
    S(0, 0xffffff, 5.0, 1), S(0.18, 0xfff08a, 3.8, 1), S(0.6, 0xffc93a, 2.6, 0.8),
    S(1, 0xff8a00, 1.2, 0),
  ],
  [RAMP.INK]: [
    S(0, 0x2a2340, 1.0, 1), S(0.5, 0x141026, 0.8, 0.95), S(1, 0x0a0716, 0.6, 0),
  ],
  [RAMP.DEBRIS]: [
    S(0, 0x6b6157, 1.0, 1), S(0.6, 0x4a423a, 0.85, 1), S(1, 0x2e2924, 0.7, 0),
  ],
  // Used only by the boost ribbon. The head used to be pure 0xffffff at 4.0,
  // which is what made the ribbon read as a white slab under the current bloom
  // — a *white* head has no hue for the grade to saturate, so the whole ribbon
  // collapsed to the bloom's own colour. Tinting the head blue-white keeps the
  // "hot core" impression while leaving the ribbon unmistakably blue.
  [RAMP.TRAIL_BOOST]: [
    S(0, 0xdcefff, 3.0, 0.95), S(0.2, 0x9fd8ff, 2.4, 0.8), S(0.55, 0x3f8dff, 1.7, 0.45),
    S(1, 0x102a6b, 0.8, 0),
  ],
  [RAMP.GHOST]: [
    S(0, 0xdff6ff, 1.6, 0), S(0.2, 0xbfe6ff, 1.4, 0.5), S(0.6, 0x8fc6f0, 1.0, 0.25),
    S(1, 0x5f8fc0, 0.6, 0),
  ],
  [RAMP.EMBER]: [
    S(0, 0xfff6d0, 6.0, 1), S(0.25, 0xffb347, 4.1, 1), S(0.62, 0xff5c14, 2.4, 0.7),
    S(1, 0x501000, 0.75, 0),
  ],
};

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function sampleStops(stops: Stop[], t: number, out: { r: number; g: number; b: number; a: number }): void {
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t < t) i++;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  const span = b.t - a.t;
  const f = span <= 1e-6 ? 0 : Math.min(1, Math.max(0, (t - a.t) / span));

  const ar = srgbToLinear(((a.c >> 16) & 255) / 255) * a.i;
  const ag = srgbToLinear(((a.c >> 8) & 255) / 255) * a.i;
  const ab = srgbToLinear((a.c & 255) / 255) * a.i;
  const br = srgbToLinear(((b.c >> 16) & 255) / 255) * b.i;
  const bg = srgbToLinear(((b.c >> 8) & 255) / 255) * b.i;
  const bb = srgbToLinear((b.c & 255) / 255) * b.i;

  out.r = ar + (br - ar) * f;
  out.g = ag + (bg - ag) * f;
  out.b = ab + (bb - ab) * f;
  out.a = a.a + (b.a - a.a) * f;
}

/** RGBA half-float LUT: x = life fraction, y = ramp row. HDR-capable. */
export function buildRampTexture(): THREE.DataTexture {
  const data = new Uint16Array(RAMP_WIDTH * RAMP_ROWS * 4);
  const c = { r: 0, g: 0, b: 0, a: 0 };
  const fallback: Stop[] = [S(0, 0xffffff, 1, 1), S(1, 0xffffff, 1, 0)];
  for (let row = 0; row < RAMP_ROWS; row++) {
    const stops = RAMPS[row] ?? fallback;
    for (let x = 0; x < RAMP_WIDTH; x++) {
      sampleStops(stops, x / (RAMP_WIDTH - 1), c);
      const i = (row * RAMP_WIDTH + x) * 4;
      data[i] = THREE.DataUtils.toHalfFloat(c.r);
      data[i + 1] = THREE.DataUtils.toHalfFloat(c.g);
      data[i + 2] = THREE.DataUtils.toHalfFloat(c.b);
      data[i + 3] = THREE.DataUtils.toHalfFloat(c.a);
    }
  }
  const tex = new THREE.DataTexture(data, RAMP_WIDTH, RAMP_ROWS, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'vfx-ramp-lut';
  return tex;
}

// ---------------------------------------------------------------------------
// Size-over-life curve LUT
// ---------------------------------------------------------------------------

export const CURVE = {
  CONST: 0,
  GROW: 1,
  SHRINK: 2,
  BELL: 3,
  POP: 4,
  PUFF: 5,
  SPIKE: 6,
  SWELL: 7,
} as const;
export type CurveId = (typeof CURVE)[keyof typeof CURVE];

export const CURVE_ROWS = 8;
export const CURVE_WIDTH = 128;

const CURVE_FN: Array<(t: number) => number> = [
  () => 1,
  (t) => 0.25 + 0.75 * (1 - Math.pow(1 - t, 2.2)),
  (t) => Math.pow(1 - t, 1.4),
  (t) => Math.sin(Math.PI * Math.pow(t, 0.78)),
  (t) => (t < 0.14 ? Math.pow(t / 0.14, 0.42) * 1.28 : 1.28 - 0.62 * Math.pow((t - 0.14) / 0.86, 0.75)),
  (t) => 0.35 + 1.05 * (1 - Math.pow(1 - t, 3.0)),
  (t) => Math.pow(1 - t, 4.5),
  (t) => 0.6 + 0.75 * Math.sin(Math.PI * Math.pow(t, 0.55)),
];

export function buildCurveTexture(): THREE.DataTexture {
  const data = new Uint16Array(CURVE_WIDTH * CURVE_ROWS * 4);
  for (let row = 0; row < CURVE_ROWS; row++) {
    const fn = CURVE_FN[row] ?? CURVE_FN[0];
    for (let x = 0; x < CURVE_WIDTH; x++) {
      const v = Math.max(0, fn(x / (CURVE_WIDTH - 1)));
      const i = (row * CURVE_WIDTH + x) * 4;
      const h = THREE.DataUtils.toHalfFloat(v);
      data[i] = h; data[i + 1] = h; data[i + 2] = h; data[i + 3] = h;
    }
  }
  const tex = new THREE.DataTexture(data, CURVE_WIDTH, CURVE_ROWS, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'vfx-curve-lut';
  return tex;
}
