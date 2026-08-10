/**
 * ============================================================================
 *  APEX KART — PROCEDURAL TEXTURE FACTORY
 * ============================================================================
 *  The shared surface library. Every material in the game comes from here.
 *
 *  Design rules:
 *   - ZERO network requests. Everything is synthesised from noise + canvas 2D.
 *   - Every field is generated with *periodic* noise so tiles are seamless.
 *     (Perlin lattices wrap modulo their period; Voronoi cells wrap; Sobel
 *      taps wrap; box blurs wrap.)
 *   - Every material has macro variation (blotches at 1/4 frequency) AND
 *     micro detail (grain at 4x frequency). One octave is never enough.
 *   - Roughness is never constant. Ever.
 *   - Results are cached by (name, size, variant); generation is lazy.
 *
 *  Channel packing: roughness/AO/metalness share ONE "ORM" RGBA texture
 *  (r = AO, g = roughness, b = metalness) exactly like glTF. `PbrSet` hands
 *  the same texture object back for `roughnessMap`, `aoMap` and
 *  `metalnessMap` — three.js samples .r/.g/.b respectively, so this is free.
 *
 *  Colour spaces: albedo/emissive = SRGBColorSpace. normal/ORM = NoColorSpace.
 * ============================================================================
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PbrSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  aoMap?: THREE.Texture;
  /** Same packed ORM texture; metalness lives in the blue channel. */
  metalnessMap?: THREE.Texture;
  /** Suggested `normalScale` for this surface. */
  normalScale?: number;
  /** Suggested world-space size of one tile, in metres. Helps callers pick repeats. */
  tileMetres?: number;
}

export interface FbmOptions {
  octaves?: number;
  /** Base period in cells across the whole texture. Rounded to an integer so it tiles. */
  frequency?: number;
  lacunarity?: number;
  gain?: number;
  seed?: number;
  /** Domain-warp strength, in normalised UV units (0.05 is a good start). */
  warp?: number;
}

export interface VoronoiOptions {
  cells?: number;
  seed?: number;
  metric?: 'euclidean' | 'manhattan';
  invert?: boolean;
}

type F32 = Float32Array;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let defaultAnisotropy = 8;
/** Hard ceiling on generated texture size — dropped on low-end tiers. */
let maxTextureSize = 2048;

const cache = new Map<string, PbrSet | THREE.Texture | THREE.Material>();
const allTextures = new Set<THREE.Texture>();
const allMaterials = new Set<THREE.Material>();

/** Total milliseconds spent generating, for the perf HUD. */
export const stats = { generatedMs: 0, count: 0 };

/**
 * Called once by RenderPipeline with the engine's quality settings.
 * `maxSize` clamps every generated texture (1024 on low, 2048 elsewhere).
 */
export function configure(opts: { anisotropy?: number; maxSize?: number }): void {
  if (opts.anisotropy !== undefined) defaultAnisotropy = Math.max(1, opts.anisotropy);
  if (opts.maxSize !== undefined) maxTextureSize = Math.max(128, opts.maxSize);
}

// ---------------------------------------------------------------------------
// Scalar helpers (module scope — never allocate inside the pixel loops)
// ---------------------------------------------------------------------------

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function sstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Deterministic 32-bit PRNG. */
function mulberry(seed: number): () => number {
  let a = (seed | 0) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

interface Ctx2D {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D;
}

const hasOffscreen = typeof OffscreenCanvas !== 'undefined';

/** Offscreen where available — used for read-back rasterisation. */
function scratchCanvas(w: number, h: number): Ctx2D {
  if (hasOffscreen) {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('TextureFactory: no 2d context');
    return { canvas: c, ctx: ctx as unknown as CanvasRenderingContext2D };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('TextureFactory: no 2d context');
  return { canvas: c, ctx };
}

/** DOM canvas — used when the canvas itself becomes the texture source. */
function domCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('TextureFactory: no 2d context');
  return { canvas, ctx };
}

/**
 * Rasterise a mask: draw white-on-black, get back a [0,1] Float32Array.
 * Use this for anything shape-based (bricks, planks, tyre tread, tiles).
 */
export function rasterField(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
): F32 {
  const { ctx } = scratchCanvas(size, size);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  draw(ctx, size);
  const img = ctx.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = img[p] / 255;
  return out;
}

/** Rasterise full colour: returns three [0,1] planes. */
function rasterRGB(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
): { r: F32; g: F32; b: F32 } {
  const { ctx } = scratchCanvas(size, size);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  draw(ctx, size);
  const img = ctx.getImageData(0, 0, size, size).data;
  const n = size * size;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    r[i] = img[p] / 255;
    g[i] = img[p + 1] / 255;
    b[i] = img[p + 2] / 255;
  }
  return { r, g, b };
}

// ---------------------------------------------------------------------------
// Periodic Perlin noise
// ---------------------------------------------------------------------------

interface GradLattice { gx: F32; gy: F32; period: number }
const gradCache = new Map<string, GradLattice>();

function gradLattice(period: number, seed: number): GradLattice {
  const key = `${period}|${seed}`;
  const hit = gradCache.get(key);
  if (hit) return hit;
  const n = period * period;
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const rng = mulberry(seed * 2654435761 + period * 40503);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const lat = { gx, gy, period };
  if (gradCache.size > 64) gradCache.clear();
  gradCache.set(key, lat);
  return lat;
}

/**
 * Accumulate one periodic Perlin octave into `out`. Wraps exactly at the
 * texture border because the lattice index is taken modulo `period`.
 */
function perlinInto(out: F32, w: number, h: number, period: number, seed: number, amp: number): void {
  const p = Math.max(1, Math.round(period));
  const { gx, gy } = gradLattice(p, seed);

  const ix0 = new Int32Array(w);
  const ix1 = new Int32Array(w);
  const dx0 = new Float32Array(w);
  const ux = new Float32Array(w);
  const sx = p / w;
  for (let x = 0; x < w; x++) {
    const t = x * sx;
    const i0 = Math.floor(t);
    const f = t - i0;
    ix0[x] = ((i0 % p) + p) % p;
    ix1[x] = (ix0[x] + 1) % p;
    dx0[x] = f;
    ux[x] = f * f * f * (f * (f * 6 - 15) + 10);
  }

  const sy = p / h;
  for (let y = 0; y < h; y++) {
    const t = y * sy;
    const j0 = Math.floor(t);
    const fy = t - j0;
    const jy0 = ((j0 % p) + p) % p;
    const jy1 = (jy0 + 1) % p;
    const dy0 = fy;
    const dy1 = fy - 1;
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const row0 = jy0 * p;
    const row1 = jy1 * p;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const a0 = ix0[x];
      const a1 = ix1[x];
      const i00 = row0 + a0;
      const i10 = row0 + a1;
      const i01 = row1 + a0;
      const i11 = row1 + a1;
      const X0 = dx0[x];
      const X1 = X0 - 1;
      const n00 = gx[i00] * X0 + gy[i00] * dy0;
      const n10 = gx[i10] * X1 + gy[i10] * dy0;
      const n01 = gx[i01] * X0 + gy[i01] * dy1;
      const n11 = gx[i11] * X1 + gy[i11] * dy1;
      const u = ux[x];
      const tp = n00 + (n10 - n00) * u;
      const bt = n01 + (n11 - n01) * u;
      out[o + x] += (tp + (bt - tp) * uy) * amp;
    }
  }
}

/** Signed fbm in roughly [-1,1]. */
function fbmSigned(
  w: number,
  h: number,
  octaves: number,
  frequency: number,
  lacunarity: number,
  gain: number,
  seed: number,
): F32 {
  const out = new Float32Array(w * h);
  let amp = 1;
  let sum = 0;
  let period = Math.max(1, Math.round(frequency));
  let lastPeriod = -1;
  for (let i = 0; i < octaves; i++) {
    if (period === lastPeriod) period += 1;
    lastPeriod = period;
    perlinInto(out, w, h, period, seed + i * 977, amp);
    sum += amp;
    amp *= gain;
    period = Math.max(period + 1, Math.round(period * lacunarity));
    if (period > Math.max(w, h)) break;
  }
  const k = 1.45 / Math.max(1e-6, sum);
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

/** Wrap-aware bilinear resample of a field with per-pixel UV offsets. */
function warpField(src: F32, w: number, h: number, ox: F32, oy: F32, strength: number): F32 {
  const out = new Float32Array(w * h);
  const sw = strength * w;
  const sh = strength * h;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const i = o + x;
      let fx = x + ox[i] * sw;
      let fy = y + oy[i] * sh;
      fx = ((fx % w) + w) % w;
      fy = ((fy % h) + h) % h;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const x1 = (x0 + 1) % w;
      const y1 = (y0 + 1) % h;
      const r0 = y0 * w;
      const r1 = y1 * w;
      const a = src[r0 + x0];
      const b = src[r0 + x1];
      const c = src[r1 + x0];
      const d = src[r1 + x1];
      out[i] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
    }
  }
  return out;
}

/**
 * Multi-octave periodic fbm, normalised to [0,1].
 * `warp` domain-distorts the result for organic, non-grid-aligned shapes.
 */
export function fbm2D(w: number, h: number, opts: FbmOptions = {}): F32 {
  const octaves = opts.octaves ?? 5;
  const frequency = opts.frequency ?? 8;
  const lacunarity = opts.lacunarity ?? 2;
  const gain = opts.gain ?? 0.5;
  const seed = opts.seed ?? 1337;
  const warp = opts.warp ?? 0;

  let field = fbmSigned(w, h, octaves, frequency, lacunarity, gain, seed);

  if (warp > 0) {
    const wx = fbmSigned(w, h, 3, Math.max(2, Math.round(frequency * 0.5)), 2, 0.5, seed + 5501);
    const wy = fbmSigned(w, h, 3, Math.max(2, Math.round(frequency * 0.5)), 2, 0.5, seed + 8803);
    field = warpField(field, w, h, wx, wy, warp);
  }

  const out = field;
  for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] * 0.5 + 0.5);
  return out;
}

/** Cheap high-frequency hash noise — grain, speckle, sparkle. */
export function hashNoise(w: number, h: number, seed = 7): F32 {
  const out = new Float32Array(w * h);
  const rng = mulberry(seed);
  for (let i = 0; i < out.length; i++) out[i] = rng();
  return out;
}

// ---------------------------------------------------------------------------
// Periodic Voronoi / Worley
// ---------------------------------------------------------------------------

interface VoronoiFields {
  /** Distance to the nearest feature point, in cell units. */
  f1: F32;
  /** Distance to the second nearest. `f2 - f1` gives crisp cell borders. */
  f2: F32;
  /** Stable random value in [0,1) for the owning cell. */
  id: F32;
}

function voronoiFields(
  w: number,
  h: number,
  cellsRaw: number,
  seed: number,
  metric: 'euclidean' | 'manhattan' = 'euclidean',
  jitter = 0.85,
): VoronoiFields {
  const cells = Math.max(2, Math.round(cellsRaw));
  const n = cells * cells;
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const rnd = new Float32Array(n);
  const rng = mulberry(seed * 6151 + cells * 97);
  const half = (1 - jitter) * 0.5;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = cy * cells + cx;
      px[i] = (cx + half + rng() * jitter) / cells;
      py[i] = (cy + half + rng() * jitter) / cells;
      rnd[i] = rng();
    }
  }

  const f1 = new Float32Array(w * h);
  const f2 = new Float32Array(w * h);
  const id = new Float32Array(w * h);
  const manhattan = metric === 'manhattan';

  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / h;
    const cy0 = Math.min(cells - 1, Math.floor(fy * cells));
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / w;
      const cx0 = Math.min(cells - 1, Math.floor(fx * cells));
      let d1 = 1e9;
      let d2 = 1e9;
      let best = 0;
      for (let oy = -1; oy <= 1; oy++) {
        let cy = cy0 + oy;
        let offY = 0;
        if (cy < 0) { cy += cells; offY = -1; } else if (cy >= cells) { cy -= cells; offY = 1; }
        const row = cy * cells;
        for (let ox = -1; ox <= 1; ox++) {
          let cx = cx0 + ox;
          let offX = 0;
          if (cx < 0) { cx += cells; offX = -1; } else if (cx >= cells) { cx -= cells; offX = 1; }
          const i = row + cx;
          const ddx = px[i] + offX - fx;
          const ddy = py[i] + offY - fy;
          const d = manhattan ? Math.abs(ddx) + Math.abs(ddy) : ddx * ddx + ddy * ddy;
          if (d < d1) { d2 = d1; d1 = d; best = i; } else if (d < d2) { d2 = d; }
        }
      }
      const k = o + x;
      if (manhattan) { f1[k] = d1 * cells; f2[k] = d2 * cells; }
      else { f1[k] = Math.sqrt(d1) * cells; f2[k] = Math.sqrt(d2) * cells; }
      id[k] = rnd[best];
    }
  }
  return { f1, f2, id };
}

export function voronoi2D(w: number, h: number, opts: VoronoiOptions = {}): F32 {
  const { f1 } = voronoiFields(w, h, opts.cells ?? 12, opts.seed ?? 11, opts.metric ?? 'euclidean');
  const out = new Float32Array(w * h);
  const inv = opts.invert === true;
  for (let i = 0; i < out.length; i++) {
    const v = clamp01(f1[i]);
    out[i] = inv ? 1 - v : v;
  }
  return out;
}

export function worley(w: number, h: number, cells: number, seed = 11): F32 {
  return voronoi2D(w, h, { cells, seed });
}

// ---------------------------------------------------------------------------
// Field operators
// ---------------------------------------------------------------------------

/** Separable box blur with wrapping — keeps blurred fields seamless. */
function blurWrap(src: F32, w: number, h: number, r: number): F32 {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[o + (((k % w) + w) % w)];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = sum * inv;
      sum += src[o + ((x + r + 1) % w)] - src[o + ((((x - r) % w) + w) % w)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[(((k % h) + h) % h) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * inv;
      sum += tmp[((y + r + 1) % h) * w + x] - tmp[((((y - r) % h) + h) % h) * w + x];
    }
  }
  return out;
}

/** Wrap-aware 2x bilinear upsample. Lets expensive fields be built at half res. */
function upsample2x(src: F32, sw: number, sh: number): F32 {
  const w = sw * 2;
  const h = sh * 2;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * 0.5 - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const r0 = (((y0 % sh) + sh) % sh) * sw;
    const r1 = ((((y0 + 1) % sh) + sh) % sh) * sw;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) * 0.5 - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const c0 = ((x0 % sw) + sw) % sw;
      const c1 = (((x0 + 1) % sw) + sw) % sw;
      const a = src[r0 + c0];
      const b = src[r0 + c1];
      const c = src[r1 + c0];
      const d = src[r1 + c1];
      const t = a + (b - a) * tx;
      const u = c + (d - c) * tx;
      out[o + x] = t + (u - t) * ty;
    }
  }
  return out;
}

/** Ridged transform — turns smooth fbm into crests. Great for rock and marble. */
function ridged(src: F32): F32 {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = 1 - Math.abs(src[i] * 2 - 1);
    out[i] = v * v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Texture construction
// ---------------------------------------------------------------------------

function finalize<T extends THREE.Texture>(tex: T, srgb: boolean, repeat = 1): T {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = defaultAnisotropy;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  allTextures.add(tex);
  return tex;
}

/** RGB planes (already sRGB-encoded, 0..1) → 8-bit albedo texture. */
function rgbToTexture(r: F32, g: F32, b: F32, w: number, h: number): THREE.DataTexture {
  const n = w * h;
  const data = new Uint8Array(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    data[p] = clamp01(r[i]) * 255;
    data[p + 1] = clamp01(g[i]) * 255;
    data[p + 2] = clamp01(b[i]) * 255;
    data[p + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  return finalize(tex, true);
}

/** ao/rough/metal → one packed glTF-style ORM texture. */
function ormToTexture(ao: F32 | null, rough: F32, metal: F32 | number, w: number, h: number): THREE.DataTexture {
  const n = w * h;
  const data = new Uint8Array(n * 4);
  const constMetal = typeof metal === 'number' ? metal : -1;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    data[p] = ao ? clamp01(ao[i]) * 255 : 255;
    data[p + 1] = clamp01(rough[i]) * 255;
    data[p + 2] = (constMetal >= 0 ? constMetal : clamp01((metal as F32)[i])) * 255;
    data[p + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  return finalize(tex, false);
}

/**
 * Sobel a height field into a tangent-space normal map.
 * Sampling wraps, so the normal map tiles as cleanly as the height did.
 * OpenGL convention (+Y up); DataTexture has flipY = false so texel row 0
 * is v = 0 and dv runs with the row index.
 */
export function heightToNormal(height: F32, w: number, h: number, strength: number): THREE.DataTexture {
  const n = w * h;
  const data = new Uint8Array(n * 4);
  const s = strength * 0.5;
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w;
    const y0 = y * w;
    const yp = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const tl = height[ym + xm];
      const tc = height[ym + x];
      const tr = height[ym + xp];
      const ml = height[y0 + xm];
      const mr = height[y0 + xp];
      const bl = height[yp + xm];
      const bc = height[yp + x];
      const br = height[yp + xp];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      let nx = -gx * s;
      let ny = -gy * s;
      const nz = 1;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= invLen;
      ny *= invLen;
      const p = (y0 + x) * 4;
      data[p] = (nx * 0.5 + 0.5) * 255;
      data[p + 1] = (ny * 0.5 + 0.5) * 255;
      data[p + 2] = (nz * invLen * 0.5 + 0.5) * 255;
      data[p + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  return finalize(tex, false);
}

/** Greyscale float field → DataTexture (RGBA, replicated). */
export function floatToTexture(
  data: F32,
  w: number,
  h: number,
  colorSpace: THREE.ColorSpace = THREE.NoColorSpace,
): THREE.DataTexture {
  const n = w * h;
  const bytes = new Uint8Array(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = clamp01(data[i]) * 255;
    bytes[p] = v;
    bytes[p + 1] = v;
    bytes[p + 2] = v;
    bytes[p + 3] = 255;
  }
  const tex = new THREE.DataTexture(bytes, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  return finalize(tex, colorSpace === THREE.SRGBColorSpace);
}

/** Draw straight into a texture. The go-to for decals, signage and UI atlases. */
export function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  opts: { srgb?: boolean; repeat?: number; aniso?: number } = {},
): THREE.CanvasTexture {
  const { canvas, ctx } = domCanvas(w, h);
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  finalize(tex, opts.srgb !== false, opts.repeat ?? 1);
  if (opts.aniso !== undefined) tex.anisotropy = opts.aniso;
  return tex;
}

/** Square sprite, clamped, for particles / flares / glows. */
export function radialSprite(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
): THREE.CanvasTexture {
  const { canvas, ctx } = domCanvas(size, size);
  ctx.clearRect(0, 0, size, size);
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
  allTextures.add(tex);
  return tex;
}

export function setAnisotropy(tex: THREE.Texture, aniso: number): void {
  tex.anisotropy = Math.max(1, aniso);
  tex.needsUpdate = true;
}

/** 1-D colour ramp. Handy for gradient skies, speed lines, item auras. */
export function gradientRamp(stops: Array<[number, string]>, size = 256): THREE.DataTexture {
  const sorted = [...stops].sort((a, b) => a[0] - b[0]);
  const col = new THREE.Color();
  const tmp = new THREE.Color();
  const cols = sorted.map(([, css]) => {
    col.setStyle(css, THREE.SRGBColorSpace);
    col.getRGB(tmp, THREE.SRGBColorSpace);
    return [tmp.r, tmp.g, tmp.b] as [number, number, number];
  });
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = size === 1 ? 0 : i / (size - 1);
    let k = 0;
    while (k < sorted.length - 2 && t > sorted[k + 1][0]) k++;
    const t0 = sorted[k][0];
    const t1 = sorted[Math.min(k + 1, sorted.length - 1)][0];
    const f = t1 === t0 ? 0 : clamp01((t - t0) / (t1 - t0));
    const a = cols[k];
    const b = cols[Math.min(k + 1, cols.length - 1)];
    const p = i * 4;
    data[p] = mix(a[0], b[0], f) * 255;
    data[p + 1] = mix(a[1], b[1], f) * 255;
    data[p + 2] = mix(a[2], b[2], f) * 255;
    data[p + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  allTextures.add(tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Build helpers shared by the material recipes
// ---------------------------------------------------------------------------

function res(size: number | undefined, fallback: number): number {
  return Math.min(maxTextureSize, Math.max(64, size ?? fallback));
}

interface Build {
  w: number;
  h: number;
  r: F32;
  g: F32;
  b: F32;
  height: F32;
  rough: F32;
  ao: F32 | null;
  metal: F32 | number;
}

function newBuild(size: number): Build {
  const n = size * size;
  return {
    w: size, h: size,
    r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n),
    height: new Float32Array(n), rough: new Float32Array(n),
    ao: null, metal: 0,
  };
}

/** Cavity AO derived from the height field — free and enormously effective. */
function cavityAO(height: F32, w: number, h: number, radius: number, strength: number): F32 {
  const blurred = blurWrap(height, w, h, radius);
  const out = new Float32Array(height.length);
  for (let i = 0; i < out.length; i++) {
    const d = blurred[i] - height[i];
    out[i] = clamp01(1 - Math.max(0, d) * strength);
  }
  return out;
}

function assemble(b: Build, normalStrength: number, tileMetres: number): PbrSet {
  const orm = ormToTexture(b.ao, b.rough, b.metal, b.w, b.h);
  return {
    map: rgbToTexture(b.r, b.g, b.b, b.w, b.h),
    normalMap: heightToNormal(b.height, b.w, b.h, normalStrength),
    roughnessMap: orm,
    aoMap: orm,
    metalnessMap: orm,
    normalScale: 1,
    tileMetres,
  };
}

function cached<T extends PbrSet | THREE.Texture | THREE.Material>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit) return hit as T;
  const t0 = performance.now();
  const made = make();
  stats.generatedMs += performance.now() - t0;
  stats.count++;
  cache.set(key, made);
  return made;
}

// ===========================================================================
//  MATERIAL RECIPES
// ===========================================================================

/**
 * ASPHALT — the most-seen surface in the game, so it gets the most work:
 * three scales of aggregate stone, tar seams (one diagonal, one lateral),
 * tyre-polished channels, fine gravel speckle, macro discolouration and
 * per-region desaturation. `wet` adds puddles with near-mirror roughness.
 */
export function makeAsphalt(size?: number, variant: 'clean' | 'worn' | 'wet' = 'clean'): PbrSet {
  const S = res(size, 2048);
  return cached(`asphalt:${S}:${variant}`, () => {
    const n = S * S;
    const b = newBuild(S);
    const half = S >> 1;

    // --- aggregate: three stone scales, built at half res then upsampled ----
    const agBig = voronoiFields(half, half, Math.max(8, Math.round(half / 46)), 91, 'euclidean', 0.95);
    const agMid = voronoiFields(half, half, Math.max(12, Math.round(half / 22)), 313, 'euclidean', 0.95);
    const agFine = voronoiFields(half, half, Math.max(16, Math.round(half / 11)), 577, 'euclidean', 0.95);

    const domeBig = new Float32Array(half * half);
    const domeMid = new Float32Array(half * half);
    const domeFine = new Float32Array(half * half);
    const stoneTint = new Float32Array(half * half);
    for (let i = 0; i < domeBig.length; i++) {
      domeBig[i] = Math.pow(clamp01(1 - agBig.f1[i] / 0.62), 1.6);
      domeMid[i] = Math.pow(clamp01(1 - agMid.f1[i] / 0.60), 1.5);
      domeFine[i] = Math.pow(clamp01(1 - agFine.f1[i] / 0.58), 1.4);
      stoneTint[i] = agMid.id[i] * 0.55 + agFine.id[i] * 0.45;
    }
    const aggBig = upsample2x(domeBig, half, half);
    const aggMid = upsample2x(domeMid, half, half);
    const aggFine = upsample2x(domeFine, half, half);
    const tint = upsample2x(stoneTint, half, half);
    // crack seeds from the large cell borders
    const crackRaw = new Float32Array(half * half);
    for (let i = 0; i < crackRaw.length; i++) {
      crackRaw[i] = 1 - sstep(0.0, 0.09, agBig.f2[i] - agBig.f1[i]);
    }
    const crack = upsample2x(blurWrap(crackRaw, half, half, 1), half, half);

    // --- noise fields --------------------------------------------------------
    const macro = fbm2D(S, S, { octaves: 4, frequency: 3, gain: 0.55, seed: 21, warp: 0.16 });
    const meso = fbm2D(S, S, { octaves: 3, frequency: 13, gain: 0.5, seed: 44, warp: 0.06 });
    const grain = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 3), gain: 0.5, seed: 88 });
    const micro = hashNoise(S, S, 1234);
    const puddleField = variant === 'wet'
      ? fbm2D(S, S, { octaves: 4, frequency: 4, gain: 0.55, seed: 909, warp: 0.2 })
      : null;

    // --- seams: one diagonal (slope 1, wraps), one lateral -------------------
    const wobble = fbm2D(S, S, { octaves: 3, frequency: 5, gain: 0.5, seed: 303 });

    const isWorn = variant === 'worn';
    const baseR = variant === 'worn' ? 0.372 : 0.286;
    const baseG = variant === 'worn' ? 0.366 : 0.288;
    const baseB = variant === 'worn' ? 0.352 : 0.302;

    for (let y = 0; y < S; y++) {
      const v = y / S;
      const o = y * S;
      for (let x = 0; x < S; x++) {
        const i = o + x;
        const u = x / S;

        const agg = clamp01(aggFine[i] * 0.46 + aggMid[i] * 0.36 + aggBig[i] * 0.24);
        const mac = macro[i];
        const mes = meso[i];
        const gr = grain[i];
        const mi = micro[i];

        // seams -------------------------------------------------------------
        const wob = (wobble[i] - 0.5) * 0.045;
        let dDiag = (u - v + 0.32 + wob) % 1;
        if (dDiag < 0) dDiag += 1;
        const seamDiag = 1 - sstep(0.0, 0.0055, Math.min(dDiag, 1 - dDiag));
        let dLat = (v - 0.61 + wob * 1.4) % 1;
        if (dLat < 0) dLat += 1;
        const seamLat = (1 - sstep(0.0, 0.0038, Math.min(dLat, 1 - dLat))) * 0.75;
        const seam = clamp01(seamDiag + seamLat);

        // tyre-polished channels: two broad, soft, noise-modulated lanes -----
        const lane = Math.exp(-Math.pow((u - 0.30) / 0.13, 2)) + Math.exp(-Math.pow((u - 0.74) / 0.12, 2));
        const polish = clamp01(lane * (0.55 + 0.45 * mac));

        // cracks --------------------------------------------------------------
        const ck = isWorn ? crack[i] * sstep(0.45, 0.85, mac) : crack[i] * 0.18 * sstep(0.6, 0.95, mac);

        // ---- albedo ---------------------------------------------------------
        const stoneLight = agg * (0.10 + 0.16 * tint[i]);
        const macroShade = 0.86 + 0.30 * mac;
        const mesoShade = 0.94 + 0.12 * mes;
        const grainShade = 0.93 + 0.15 * gr;
        let cr = (baseR + stoneLight) * macroShade * mesoShade * grainShade;
        let cg = (baseG + stoneLight * 0.99) * macroShade * mesoShade * grainShade;
        let cb = (baseB + stoneLight * 0.96) * macroShade * mesoShade * grainShade;

        // per-region desaturation / hue drift
        const hueDrift = (mac - 0.5) * 0.035;
        cr += hueDrift;
        cb -= hueDrift * 0.8;
        const desat = 0.5 + 0.5 * mes;
        const lum = cr * 0.299 + cg * 0.587 + cb * 0.114;
        const sat = mix(0.78, 1.06, desat);
        cr = lum + (cr - lum) * sat;
        cg = lum + (cg - lum) * sat;
        cb = lum + (cb - lum) * sat;

        // quartz sparkle in the aggregate
        if (mi > 0.972 && agg > 0.25) { cr += 0.16; cg += 0.16; cb += 0.15; }
        // dark bitumen flecks
        if (mi < 0.02) { cr *= 0.62; cg *= 0.62; cb *= 0.64; }

        // seams are darker + smoother tar
        const seamK = 1 - 0.30 * seam;
        cr *= seamK; cg *= seamK; cb *= seamK;
        // polished lanes are darker and slightly shinier
        const polK = 1 - 0.085 * polish;
        cr *= polK; cg *= polK; cb *= polK;
        // cracks
        const ckK = 1 - 0.55 * ck;
        cr *= ckK; cg *= ckK; cb *= ckK;

        // ---- height ---------------------------------------------------------
        let hgt = agg * 0.72 + gr * 0.16 + mi * 0.05 + mes * 0.07;
        hgt -= seam * 0.55;
        hgt -= ck * 0.45;
        hgt -= polish * 0.06;

        // ---- roughness ------------------------------------------------------
        let ro = 0.905 - agg * 0.13 + (gr - 0.5) * 0.09 - polish * 0.14 - seam * 0.30 + (mac - 0.5) * 0.07;

        if (puddleField) {
          const pud = sstep(0.52, 0.70, puddleField[i]) * sstep(0.35, 0.55, 1 - hgt * 0.5);
          const wetAll = 0.35 + 0.65 * pud;
          const k = mix(0.62, 0.30, pud);
          cr *= k; cg *= k; cb *= k;
          ro = mix(ro, 0.05, pud) - 0.16 * wetAll;
          hgt = mix(hgt, hgt * 0.25 + 0.35, pud);
        }

        b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
        b.height[i] = hgt;
        b.rough[i] = clamp(ro, 0.04, 0.98);
      }
    }

    b.ao = cavityAO(b.height, S, S, Math.max(2, S >> 8), 1.5);
    for (let i = 0; i < n; i++) b.ao[i] = mix(1, b.ao[i], 0.85);
    const set = assemble(b, variant === 'wet' ? 1.5 : 2.1, 6);
    set.normalScale = variant === 'wet' ? 0.7 : 1.0;
    return set;
  });
}

/** CONCRETE — poured slab: mottling, air pores, faint form-board lines. */
export function makeConcrete(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`concrete:${S}`, () => {
    const b = newBuild(S);
    const macro = fbm2D(S, S, { octaves: 5, frequency: 3, gain: 0.55, seed: 5, warp: 0.18 });
    const stain = fbm2D(S, S, { octaves: 4, frequency: 6, gain: 0.6, seed: 71, warp: 0.24 });
    const meso = fbm2D(S, S, { octaves: 3, frequency: 22, gain: 0.5, seed: 132 });
    const grain = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 3), seed: 411 });
    const micro = hashNoise(S, S, 6612);
    const agg = voronoiFields(S, S, Math.max(10, S / 34), 823, 'euclidean', 0.95);
    const cr2 = voronoiFields(S, S, 7, 1191, 'euclidean', 0.9);

    for (let y = 0; y < S; y++) {
      const v = y / S;
      const o = y * S;
      for (let x = 0; x < S; x++) {
        const i = o + x;
        const mac = macro[i];
        const st = stain[i];
        const gh = Math.pow(clamp01(1 - agg.f1[i] / 0.6), 2) * 0.35; // ghosted aggregate
        const pore = micro[i] > 0.988 ? 1 : 0;
        const crack = (1 - sstep(0, 0.035, cr2.f2[i] - cr2.f1[i])) * sstep(0.55, 0.9, st);
        const board = Math.pow(Math.abs(Math.sin(v * Math.PI * 4)), 24) * 0.5;

        const lightness = 0.50 + 0.13 * mac + 0.05 * (meso[i] - 0.5) + 0.05 * gh + 0.06 * (grain[i] - 0.5);
        let cr = lightness * (1.0 + 0.012);
        let cg = lightness * 1.0;
        let cb = lightness * (1.0 - 0.018);
        // rusty / organic staining
        const stainAmt = sstep(0.60, 0.92, st) * 0.5;
        cr = mix(cr, cr * 1.02 + 0.04, stainAmt);
        cg = mix(cg, cg * 0.94 + 0.02, stainAmt);
        cb = mix(cb, cb * 0.84, stainAmt);
        if (pore > 0) { cr *= 0.45; cg *= 0.45; cb *= 0.46; }
        const ck = 1 - 0.5 * crack;
        cr *= ck; cg *= ck; cb *= ck;
        cr *= 1 - board * 0.06; cg *= 1 - board * 0.06; cb *= 1 - board * 0.06;

        b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
        b.height[i] = 0.5 + 0.22 * (mac - 0.5) + 0.14 * (meso[i] - 0.5) + 0.08 * gh
          + 0.10 * (grain[i] - 0.5) - pore * 0.55 - crack * 0.4 - board * 0.12;
        b.rough[i] = clamp(0.80 + 0.11 * (grain[i] - 0.5) + 0.09 * (1 - mac) - stainAmt * 0.06, 0.6, 0.97);
      }
    }
    b.ao = cavityAO(b.height, S, S, 3, 2.2);
    return assemble(b, 1.3, 4);
  });
}

/**
 * GRASS — voronoi clumps drive hue and density; blades are drawn as tapered
 * canvas strokes (batched by colour bucket) so the surface has real structure
 * rather than green noise. Blades near an edge are duplicated across the wrap.
 */
export function makeGrass(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`grass:${S}`, () => {
    const b = newBuild(S);
    const clump = voronoiFields(S, S, 11, 404, 'euclidean', 0.95);
    const macro = fbm2D(S, S, { octaves: 4, frequency: 4, gain: 0.55, seed: 17, warp: 0.2 });
    const dry = fbm2D(S, S, { octaves: 3, frequency: 3, gain: 0.6, seed: 606, warp: 0.25 });

    // Colour palette: deep green -> yellow-green -> dry straw
    const bladeCount = Math.round(S * S * 0.0165);
    const buckets = 20;
    const rng = mulberry(9081);

    const canvasRGB = rasterRGB(S, (ctx, s) => {
      // soil / thatch base so gaps between blades read as shadowed earth
      ctx.fillStyle = '#1d2a13';
      ctx.fillRect(0, 0, s, s);
      const grad = ctx.createLinearGradient(0, 0, s, s);
      grad.addColorStop(0, 'rgba(46,64,26,0.55)');
      grad.addColorStop(1, 'rgba(24,38,16,0.55)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, s, s);

      const scale = s / 1024;
      // Bucketed batches: one fillStyle change per bucket, not per blade.
      for (let bkt = 0; bkt < buckets; bkt++) {
        const t = bkt / (buckets - 1);
        // hue ramp from deep green to yellow-green, with the last buckets dry
        const dryT = clamp01((t - 0.72) / 0.28);
        const rr = Math.round(mix(mix(38, 132, t), 152, dryT));
        const gg = Math.round(mix(mix(76, 156, t), 142, dryT));
        const bb = Math.round(mix(mix(31, 62, t), 74, dryT));
        ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
        ctx.beginPath();
        const per = Math.round(bladeCount / buckets);
        for (let k = 0; k < per; k++) {
          const x = rng() * s;
          const y = rng() * s;
          const i = (Math.min(s - 1, y | 0) * s) + Math.min(s - 1, x | 0);
          // blades only appear in this bucket if the local field matches
          const local = clamp01(clump.id[i] * 0.55 + macro[i] * 0.3 + dry[i] * 0.15);
          if (Math.abs(local - t) > 0.14) continue;
          const len = (9 + rng() * 16) * scale;
          const wdt = (1.1 + rng() * 1.7) * scale;
          const ang = -Math.PI / 2 + (rng() - 0.5) * 1.5;
          const bend = (rng() - 0.5) * 9 * scale;
          const tx = x + Math.cos(ang) * len + bend;
          const ty = y + Math.sin(ang) * len;
          const cx = (x + tx) * 0.5 + bend * 0.5;
          const cy = (y + ty) * 0.5;
          for (let rep = 0; rep < 4; rep++) {
            const ox = rep & 1 ? (x < s * 0.5 ? s : -s) : 0;
            const oy = rep & 2 ? (y < s * 0.5 ? s : -s) : 0;
            if (rep > 0 && Math.min(x, s - x) > 30 * scale && Math.min(y, s - y) > 30 * scale) continue;
            ctx.moveTo(x - wdt + ox, y + oy);
            ctx.quadraticCurveTo(cx - wdt * 0.4 + ox, cy + oy, tx + ox, ty + oy);
            ctx.quadraticCurveTo(cx + wdt * 0.4 + ox, cy + oy, x + wdt + ox, y + oy);
          }
        }
        ctx.fill();
      }
    });

    const lum = new Float32Array(S * S);
    for (let i = 0; i < lum.length; i++) {
      lum[i] = canvasRGB.r[i] * 0.3 + canvasRGB.g[i] * 0.6 + canvasRGB.b[i] * 0.1;
    }
    const soft = blurWrap(lum, S, S, 1);
    const clumpH = new Float32Array(S * S);
    for (let i = 0; i < clumpH.length; i++) {
      clumpH[i] = Math.pow(clamp01(1 - clump.f1[i] / 0.75), 1.5);
    }

    for (let i = 0; i < S * S; i++) {
      const mac = macro[i];
      const shade = 0.82 + 0.36 * mac * (0.4 + 0.6 * clumpH[i]);
      b.r[i] = canvasRGB.r[i] * shade;
      b.g[i] = canvasRGB.g[i] * shade;
      b.b[i] = canvasRGB.b[i] * shade;
      b.height[i] = soft[i] * 0.7 + clumpH[i] * 0.30;
      b.rough[i] = clamp(0.86 - lum[i] * 0.22 + (mac - 0.5) * 0.08, 0.55, 0.95);
    }
    b.ao = cavityAO(b.height, S, S, Math.max(2, S >> 7), 1.9);
    const set = assemble(b, 1.05, 3);
    set.normalScale = 0.85;
    return set;
  });
}

/** SAND — wind ripples warped by fbm, grain sparkle, scattered pebbles. */
export function makeSand(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`sand:${S}`, () => {
    const b = newBuild(S);
    const warpA = fbm2D(S, S, { octaves: 4, frequency: 3, gain: 0.55, seed: 33 });
    const macro = fbm2D(S, S, { octaves: 4, frequency: 4, gain: 0.55, seed: 77, warp: 0.2 });
    const grain = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 2), seed: 155 });
    const micro = hashNoise(S, S, 2020);
    const peb = voronoiFields(S, S, Math.max(8, S / 40), 611, 'euclidean', 0.95);

    const RIPPLE_K = 9; // integer -> tiles
    for (let y = 0; y < S; y++) {
      const v = y / S;
      const o = y * S;
      for (let x = 0; x < S; x++) {
        const i = o + x;
        const u = x / S;
        const w1 = (warpA[i] - 0.5) * 0.28;
        const w2 = (macro[i] - 0.5) * 0.10;
        const phase = (u * 0.35 + v * 0.94 + w1 + w2) * Math.PI * 2 * RIPPLE_K;
        const ripple = Math.sin(phase) * 0.5 + 0.5;
        const rippleShaped = Math.pow(ripple, 1.4);
        const pebble = Math.pow(clamp01(1 - peb.f1[i] / 0.30), 2) * sstep(0.62, 0.8, peb.id[i]);

        const light = 0.66 + 0.16 * rippleShaped + 0.10 * (macro[i] - 0.5) + 0.07 * (grain[i] - 0.5);
        let cr = light * 1.06;
        let cg = light * 0.92;
        let cb = light * 0.68;
        // damp / shadowed troughs are cooler and darker
        const trough = 1 - rippleShaped;
        cr = mix(cr, cr * 0.80, trough * 0.45);
        cg = mix(cg, cg * 0.82, trough * 0.45);
        cb = mix(cb, cb * 0.90, trough * 0.45);
        if (micro[i] > 0.9915) { cr += 0.22; cg += 0.20; cb += 0.16; }
        if (micro[i] < 0.006) { cr *= 0.7; cg *= 0.68; cb *= 0.62; }
        if (pebble > 0.1) {
          const pk = 0.55 + 0.35 * peb.id[i];
          cr = mix(cr, pk * 0.9, pebble);
          cg = mix(cg, pk * 0.88, pebble);
          cb = mix(cb, pk * 0.82, pebble);
        }
        b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
        b.height[i] = rippleShaped * 0.55 + macro[i] * 0.25 + grain[i] * 0.12 + micro[i] * 0.05 + pebble * 0.3;
        b.rough[i] = clamp(0.90 + (grain[i] - 0.5) * 0.08 - pebble * 0.18, 0.6, 0.99);
      }
    }
    b.ao = cavityAO(b.height, S, S, 3, 1.4);
    return assemble(b, 1.35, 5);
  });
}

/** DIRT — trodden earth: clods, embedded stones, dry cracks, damp patches. */
export function makeDirt(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`dirt:${S}`, () => {
    const b = newBuild(S);
    const macro = fbm2D(S, S, { octaves: 5, frequency: 3, gain: 0.58, seed: 12, warp: 0.24 });
    const clod = fbm2D(S, S, { octaves: 4, frequency: 12, gain: 0.55, seed: 91, warp: 0.12 });
    const grain = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 3), seed: 331 });
    const micro = hashNoise(S, S, 5150);
    const stones = voronoiFields(S, S, Math.max(10, S / 26), 733, 'euclidean', 0.95);
    const cracks = voronoiFields(S, S, 9, 1777, 'euclidean', 0.85);

    for (let i = 0; i < S * S; i++) {
      const mac = macro[i];
      const cl = clod[i];
      const stone = Math.pow(clamp01(1 - stones.f1[i] / 0.34), 2) * sstep(0.55, 0.78, stones.id[i]);
      const crack = (1 - sstep(0, 0.05, cracks.f2[i] - cracks.f1[i])) * sstep(0.4, 0.85, mac);
      const damp = sstep(0.62, 0.9, 1 - mac);

      const light = 0.34 + 0.20 * mac + 0.11 * (cl - 0.5) + 0.07 * (grain[i] - 0.5);
      let cr = light * 1.22;
      let cg = light * 0.96;
      let cb = light * 0.70;
      cr = mix(cr, cr * 0.55, damp * 0.8);
      cg = mix(cg, cg * 0.56, damp * 0.8);
      cb = mix(cb, cb * 0.62, damp * 0.8);
      if (stone > 0.05) {
        const sk = 0.36 + 0.30 * stones.id[i];
        cr = mix(cr, sk, stone); cg = mix(cg, sk * 0.99, stone); cb = mix(cb, sk * 0.96, stone);
      }
      if (micro[i] > 0.993) { cr += 0.10; cg += 0.09; cb += 0.07; }
      const ck = 1 - 0.55 * crack;
      cr *= ck; cg *= ck; cb *= ck;

      b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
      b.height[i] = cl * 0.42 + mac * 0.25 + stone * 0.5 + grain[i] * 0.12 + micro[i] * 0.05 - crack * 0.55;
      b.rough[i] = clamp(0.90 + (grain[i] - 0.5) * 0.08 - stone * 0.12 - damp * 0.18, 0.55, 0.99);
    }
    b.ao = cavityAO(b.height, S, S, 4, 1.8);
    return assemble(b, 1.9, 4);
  });
}

/** ROCK — fractured stone with strata, chipped faces and iron staining. */
export function makeRock(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`rock:${S}`, () => {
    const b = newBuild(S);
    const frac = voronoiFields(S, S, 6, 4242, 'euclidean', 0.9);
    const frac2 = voronoiFields(S, S, 15, 8484, 'euclidean', 0.9);
    const bumps = fbm2D(S, S, { octaves: 5, frequency: 9, gain: 0.55, seed: 61, warp: 0.14 });
    const strataN = fbm2D(S, S, { octaves: 4, frequency: 4, gain: 0.5, seed: 202 });
    const rid = ridged(fbm2D(S, S, { octaves: 4, frequency: 7, gain: 0.55, seed: 480 }));
    const grain = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 3), seed: 999 });
    const micro = hashNoise(S, S, 3131);

    for (let y = 0; y < S; y++) {
      const v = y / S;
      const o = y * S;
      for (let x = 0; x < S; x++) {
        const i = o + x;
        const e1 = 1 - sstep(0, 0.10, frac.f2[i] - frac.f1[i]);
        const e2 = (1 - sstep(0, 0.14, frac2.f2[i] - frac2.f1[i])) * 0.55;
        const edge = clamp01(e1 + e2 * 0.8);
        const face = frac.id[i];
        const strata = Math.sin((v * 7 + (strataN[i] - 0.5) * 1.1) * Math.PI * 2) * 0.5 + 0.5;

        const light = 0.36 + 0.12 * face + 0.14 * (bumps[i] - 0.5) + 0.10 * (strata - 0.5) * 0.7
          + 0.10 * rid[i] + 0.07 * (grain[i] - 0.5);
        let cr = light * 1.02;
        let cg = light * 1.00;
        let cb = light * 0.99;
        // iron / lichen staining in the low areas
        const stain = sstep(0.55, 0.95, bumps[i]) * sstep(0.4, 0.9, face);
        cr = mix(cr, cr * 1.10 + 0.03, stain * 0.5);
        cg = mix(cg, cg * 0.98, stain * 0.5);
        cb = mix(cb, cb * 0.80, stain * 0.5);
        const ek = 1 - 0.45 * edge;
        cr *= ek; cg *= ek; cb *= ek;
        if (micro[i] > 0.99) { cr += 0.12; cg += 0.12; cb += 0.12; }

        b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
        b.height[i] = 0.35 + 0.30 * bumps[i] + 0.18 * rid[i] + 0.10 * (strata - 0.5)
          + 0.20 * face * (1 - edge) + 0.10 * grain[i] - edge * 0.62;
        b.rough[i] = clamp(0.78 + 0.12 * (grain[i] - 0.5) + edge * 0.14 - rid[i] * 0.10, 0.5, 0.99);
      }
    }
    b.ao = cavityAO(b.height, S, S, 4, 2.4);
    const set = assemble(b, 2.6, 6);
    set.normalScale = 1.2;
    return set;
  });
}

/** WOOD PLANK — 6 boards, grain rings, knots, chamfered gaps, per-board tint. */
export function makeWoodPlank(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`wood:${S}`, () => {
    const b = newBuild(S);
    const PLANKS = 6;
    const warpA = fbm2D(S, S, { octaves: 4, frequency: 5, gain: 0.55, seed: 24 });
    const warpB = fbm2D(S, S, { octaves: 3, frequency: 14, gain: 0.5, seed: 68 });
    const fine = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 2), seed: 902 });
    const micro = hashNoise(S, S, 7373);
    const rng = mulberry(5150);
    const plankTint = new Float32Array(PLANKS);
    const plankShift = new Float32Array(PLANKS);
    const plankRot = new Float32Array(PLANKS);
    for (let p = 0; p < PLANKS; p++) {
      plankTint[p] = rng();
      plankShift[p] = rng() * 10;
      plankRot[p] = (rng() - 0.5) * 0.06;
    }
    // knots: a few per texture
    const knots: Array<[number, number, number]> = [];
    for (let k = 0; k < 5; k++) knots.push([rng(), rng(), 0.018 + rng() * 0.022]);

    for (let y = 0; y < S; y++) {
      const v = y / S;
      const o = y * S;
      const pf = v * PLANKS;
      const pi = Math.min(PLANKS - 1, Math.floor(pf));
      const pl = pf - pi;
      const gap = 1 - sstep(0, 0.05, Math.min(pl, 1 - pl));
      const bevel = 1 - sstep(0.03, 0.12, Math.min(pl, 1 - pl));
      for (let x = 0; x < S; x++) {
        const i = o + x;
        const u = x / S;
        // grain rings run along the board (u); warp them so they meander
        const ringCoord = (v * PLANKS + plankShift[pi] + u * plankRot[pi] * PLANKS) * 3.0
          + (warpA[i] - 0.5) * 1.6 + (warpB[i] - 0.5) * 0.45;
        let ring = Math.abs(((ringCoord * 3.4) % 1) * 2 - 1);
        ring = Math.pow(ring, 0.55);

        // knots
        let knot = 0;
        let knotRing = 0;
        for (let k = 0; k < knots.length; k++) {
          const kx = knots[k][0];
          const ky = knots[k][1];
          let dx = u - kx; if (dx > 0.5) dx -= 1; else if (dx < -0.5) dx += 1;
          let dy = v - ky; if (dy > 0.5) dy -= 1; else if (dy < -0.5) dy += 1;
          const d = Math.sqrt(dx * dx * 1.0 + dy * dy * 3.2);
          const kr = knots[k][2];
          if (d < kr * 4.5) {
            knot = Math.max(knot, 1 - sstep(kr * 0.55, kr * 1.5, d));
            knotRing = Math.max(knotRing, (1 - sstep(kr, kr * 4.2, d)) * (Math.sin(d / kr * 12) * 0.5 + 0.5));
          }
        }

        const tone = 0.42 + 0.20 * plankTint[pi];
        const grainDark = ring * 0.30 + knotRing * 0.22;
        const light = tone * (1 - grainDark) * (0.94 + 0.12 * fine[i]);
        let cr = light * 1.30;
        let cg = light * 0.92;
        let cb = light * 0.58;
        // knot core
        cr = mix(cr, 0.16, knot); cg = mix(cg, 0.10, knot); cb = mix(cb, 0.06, knot);
        // gap between planks: dark shadow
        cr = mix(cr, 0.045, gap); cg = mix(cg, 0.035, gap); cb = mix(cb, 0.028, gap);
        if (micro[i] > 0.996) { cr += 0.08; cg += 0.07; cb += 0.05; }

        b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
        b.height[i] = 0.62 - ring * 0.16 - knotRing * 0.10 - gap * 0.75 - bevel * 0.14
          + fine[i] * 0.08 - knot * 0.20 + plankTint[pi] * 0.05;
        b.rough[i] = clamp(0.66 + ring * 0.16 + gap * 0.2 - plankTint[pi] * 0.08 + (fine[i] - 0.5) * 0.07, 0.35, 0.98);
      }
    }
    b.ao = cavityAO(b.height, S, S, 3, 2.0);
    return assemble(b, 1.6, 3);
  });
}

/** METAL PANEL — riveted plates, brushed micro-grooves, scratches, edge wear. */
export function makeMetalPanel(
  size?: number,
  opts: { painted?: boolean; color?: THREE.ColorRepresentation } = {},
): PbrSet {
  const S = res(size, 1024);
  const painted = opts.painted === true;
  const colHex = new THREE.Color(opts.color ?? 0xb9c2cc).getHex();
  return cached(`metal:${S}:${painted ? 'p' : 'b'}:${colHex}`, () => {
    const b = newBuild(S);
    const paint = new THREE.Color(colHex);
    const tmp = new THREE.Color();
    paint.getRGB(tmp, THREE.SRGBColorSpace);
    const pr = tmp.r;
    const pg = tmp.g;
    const pb = tmp.b;

    const PANELS = 3;
    const macro = fbm2D(S, S, { octaves: 4, frequency: 4, gain: 0.55, seed: 39, warp: 0.16 });
    const brushed = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 1), seed: 707 });
    const dirt = fbm2D(S, S, { octaves: 4, frequency: 7, gain: 0.6, seed: 313, warp: 0.2 });
    const micro = hashNoise(S, S, 4242);

    // Rivets + panel seams via canvas mask
    const rivets = rasterField(S, (ctx, s) => {
      const step = s / PANELS;
      ctx.fillStyle = '#fff';
      for (let py = 0; py <= PANELS; py++) {
        for (let k = 0; k < 14; k++) {
          const cx = ((k + 0.5) / 14) * s;
          const cy = py * step;
          for (const oy of [cy, cy - s, cy + s]) {
            ctx.beginPath();
            ctx.arc(cx, oy, s * 0.0055, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      for (let px = 0; px <= PANELS; px++) {
        for (let k = 0; k < 14; k++) {
          const cy = ((k + 0.5) / 14) * s;
          const cx = px * step;
          for (const ox of [cx, cx - s, cx + s]) {
            ctx.beginPath();
            ctx.arc(ox, cy, s * 0.0055, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    });
    const scratches = rasterField(S, (ctx, s) => {
      const rng = mulberry(2211);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineCap = 'round';
      for (let k = 0; k < 220; k++) {
        const x = rng() * s;
        const y = rng() * s;
        const len = (8 + rng() * 70) * (s / 1024);
        const a = rng() * Math.PI * 2;
        ctx.lineWidth = (0.5 + rng() * 1.2) * (s / 1024);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
    });
    const rivetSoft = blurWrap(rivets, S, S, 1);
    const metalArr = new Float32Array(S * S);

    for (let y = 0; y < S; y++) {
      const v = y / S;
      const o = y * S;
      const gy = Math.min((v * PANELS) % 1, 1 - ((v * PANELS) % 1));
      for (let x = 0; x < S; x++) {
        const i = o + x;
        const u = x / S;
        const gx = Math.min((u * PANELS) % 1, 1 - ((u * PANELS) % 1));
        const seam = 1 - sstep(0, 0.012, Math.min(gx, gy));
        const bevel = 1 - sstep(0.010, 0.05, Math.min(gx, gy));
        const riv = rivetSoft[i];
        const scr = scratches[i];
        const wear = clamp01(sstep(0.55, 0.95, dirt[i]) * 0.9 + bevel * 0.35 + scr * 0.5);
        const grime = sstep(0.45, 0.85, 1 - dirt[i]) * 0.5 + seam * 0.4;

        let cr: number;
        let cg: number;
        let cb: number;
        let mt: number;
        let ro: number;
        if (painted) {
          const shade = 0.90 + 0.16 * macro[i] + 0.05 * (brushed[i] - 0.5);
          cr = pr * shade; cg = pg * shade; cb = pb * shade;
          // chipped paint reveals bare metal
          const chip = sstep(0.72, 0.95, wear);
          cr = mix(cr, 0.42, chip); cg = mix(cg, 0.43, chip); cb = mix(cb, 0.45, chip);
          mt = mix(0.05, 0.95, chip);
          ro = mix(0.34 + 0.10 * (brushed[i] - 0.5), 0.62, chip) + grime * 0.12;
        } else {
          const shade = 0.62 + 0.16 * macro[i] + 0.10 * (brushed[i] - 0.5);
          cr = shade * 0.94; cg = shade * 0.96; cb = shade * 1.00;
          mt = 1.0 - grime * 0.25;
          ro = 0.34 + 0.16 * (1 - brushed[i]) + grime * 0.22 - scr * 0.12;
        }
        // rivet heads catch light
        cr = mix(cr, cr * 1.18 + 0.05, riv);
        cg = mix(cg, cg * 1.18 + 0.05, riv);
        cb = mix(cb, cb * 1.18 + 0.05, riv);
        // seam shadow
        const sk = 1 - 0.45 * seam;
        cr *= sk; cg *= sk; cb *= sk;
        if (micro[i] > 0.997) { cr += 0.10; cg += 0.10; cb += 0.10; }

        b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
        b.height[i] = 0.55 + riv * 0.45 - seam * 0.6 - bevel * 0.12
          + (brushed[i] - 0.5) * 0.06 + (macro[i] - 0.5) * 0.05 - scr * 0.08;
        b.rough[i] = clamp(ro + scr * 0.10, 0.08, 0.95);
        metalArr[i] = clamp01(mt);
      }
    }
    b.metal = metalArr;
    b.ao = cavityAO(b.height, S, S, 3, 2.4);
    return assemble(b, 1.7, 2.5);
  });
}

/** BRICK — running bond, recessed mortar, per-brick colour + surface pitting. */
export function makeBrick(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`brick:${S}`, () => {
    const b = newBuild(S);
    const ROWS = 8;
    const COLS = 4;
    const rng = mulberry(3210);
    const brickTint = new Float32Array(ROWS * COLS * 2);
    for (let i = 0; i < brickTint.length; i++) brickTint[i] = rng();

    const grain = fbm2D(S, S, { octaves: 3, frequency: Math.max(8, S >> 3), gain: 0.55, seed: 812 });
    const macro = fbm2D(S, S, { octaves: 4, frequency: 4, gain: 0.55, seed: 111, warp: 0.2 });
    const micro = hashNoise(S, S, 8118);
    const pit = voronoiFields(S, S, Math.max(20, S / 12), 3344, 'euclidean', 0.95);

    const mortarW = 0.10; // fraction of a brick cell
    for (let y = 0; y < S; y++) {
      const v = y / S;
      const o = y * S;
      const ry = v * ROWS;
      const row = Math.floor(ry);
      const fy = ry - row;
      const offset = row % 2 === 0 ? 0 : 0.5;
      for (let x = 0; x < S; x++) {
        const i = o + x;
        const u = x / S;
        const rx = u * COLS + offset;
        const colI = Math.floor(rx);
        const fx = rx - colI;
        const bi = ((row % ROWS) * COLS + (((colI % COLS) + COLS) % COLS)) % brickTint.length;
        const t = brickTint[bi];

        const dEdge = Math.min(
          Math.min(fx, 1 - fx) / mortarW,
          Math.min(fy, 1 - fy) / (mortarW * COLS / ROWS * 2),
        );
        const mortar = 1 - sstep(0.35, 1.0, dEdge);
        const bevel = 1 - sstep(0.9, 1.9, dEdge);

        const pitDot = Math.pow(clamp01(1 - pit.f1[i] / 0.35), 2.5) * sstep(0.7, 0.95, pit.id[i]);

        // brick body colour: red-brown family with strong per-brick variation
        const warm = 0.30 + 0.36 * t;
        const bodyShade = (0.86 + 0.26 * macro[i]) * (0.94 + 0.13 * grain[i]);
        let cr = warm * 1.62 * bodyShade;
        let cg = warm * 0.80 * bodyShade;
        let cb = warm * 0.62 * bodyShade;
        // occasional dark / burnt bricks and pale ones
        if (t > 0.88) { cr *= 0.55; cg *= 0.58; cb *= 0.68; }
        else if (t < 0.10) { cr = mix(cr, 0.62, 0.55); cg = mix(cg, 0.55, 0.55); cb = mix(cb, 0.48, 0.55); }
        cr *= 1 - pitDot * 0.35; cg *= 1 - pitDot * 0.35; cb *= 1 - pitDot * 0.35;

        // mortar: pale, rough, gritty
        const mg = 0.56 + 0.13 * (grain[i] - 0.5) + 0.10 * (macro[i] - 0.5);
        cr = mix(cr, mg * 1.00, mortar);
        cg = mix(cg, mg * 0.99, mortar);
        cb = mix(cb, mg * 0.94, mortar);
        if (micro[i] > 0.994) { cr += 0.06; cg += 0.06; cb += 0.06; }

        b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
        b.height[i] = 0.72 - mortar * 0.62 - bevel * 0.10 + grain[i] * 0.10 - pitDot * 0.35 + t * 0.04;
        b.rough[i] = clamp(mix(0.80 + (grain[i] - 0.5) * 0.10 - t * 0.10, 0.94, mortar), 0.5, 0.99);
      }
    }
    b.ao = cavityAO(b.height, S, S, 3, 2.4);
    return assemble(b, 2.0, 3);
  });
}

/** COBBLESTONE — domed voronoi setts, deep joints, polished crowns. */
export function makeCobblestone(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`cobble:${S}`, () => {
    const b = newBuild(S);
    const cells = voronoiFields(S, S, 9, 5566, 'euclidean', 0.72);
    const grain = fbm2D(S, S, { octaves: 3, frequency: Math.max(8, S >> 3), seed: 660 });
    const macro = fbm2D(S, S, { octaves: 4, frequency: 4, gain: 0.55, seed: 220, warp: 0.2 });
    const micro = hashNoise(S, S, 1919);
    const speck = voronoiFields(S, S, Math.max(24, S / 12), 7788, 'euclidean', 0.95);

    for (let i = 0; i < S * S; i++) {
      const edge = sstep(0.0, 0.16, cells.f2[i] - cells.f1[i]); // 0 at joints
      const dome = Math.pow(clamp01(1 - cells.f1[i] / 0.66), 0.55);
      const stone = edge * dome;
      const id = cells.id[i];
      const joint = 1 - edge;
      const fleck = Math.pow(clamp01(1 - speck.f1[i] / 0.4), 2) * 0.5;

      const tone = 0.30 + 0.24 * id;
      const shade = (0.86 + 0.26 * macro[i]) * (0.93 + 0.14 * grain[i]);
      let cr = tone * shade * (1 + 0.04 * (id - 0.5));
      let cg = tone * shade;
      let cb = tone * shade * (1 - 0.05 * (id - 0.5));
      // polished crowns catch light, edges are grubbier
      const crown = sstep(0.55, 1.0, dome);
      cr *= 1 + 0.14 * crown; cg *= 1 + 0.14 * crown; cb *= 1 + 0.14 * crown;
      cr += fleck * 0.10; cg += fleck * 0.10; cb += fleck * 0.10;
      // damp dark joints with grit
      const jg = 0.13 + 0.07 * grain[i];
      cr = mix(cr, jg, joint * 0.92);
      cg = mix(cg, jg * 1.02, joint * 0.92);
      cb = mix(cb, jg * 1.05, joint * 0.92);
      if (micro[i] > 0.995) { cr += 0.09; cg += 0.09; cb += 0.09; }

      b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
      b.height[i] = stone * 0.85 + grain[i] * 0.08 + fleck * 0.06;
      b.rough[i] = clamp(0.84 - crown * 0.22 + joint * 0.12 + (grain[i] - 0.5) * 0.08, 0.4, 0.98);
    }
    b.ao = cavityAO(b.height, S, S, Math.max(3, S >> 7), 2.2);
    const set = assemble(b, 2.4, 4);
    set.normalScale = 1.1;
    return set;
  });
}

/** TILE FLOOR — glossy square tiles, grout, marble veining, chipped corners. */
export function makeTileFloor(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`tile:${S}`, () => {
    const b = newBuild(S);
    const N = 6;
    const veinBase = fbm2D(S, S, { octaves: 5, frequency: 5, gain: 0.55, seed: 480, warp: 0.3 });
    const vein = ridged(fbm2D(S, S, { octaves: 4, frequency: 3, gain: 0.6, seed: 481, warp: 0.35 }));
    const grain = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 3), seed: 484 });
    const micro = hashNoise(S, S, 2468);
    const rng = mulberry(1024);
    const tileTint = new Float32Array(N * N);
    for (let i = 0; i < tileTint.length; i++) tileTint[i] = rng();

    const grout = 0.045;
    for (let y = 0; y < S; y++) {
      const v = y / S;
      const o = y * S;
      const ty = v * N;
      const iy = Math.min(N - 1, Math.floor(ty));
      const fy = ty - iy;
      for (let x = 0; x < S; x++) {
        const i = o + x;
        const u = x / S;
        const tx = u * N;
        const ix = Math.min(N - 1, Math.floor(tx));
        const fx = tx - ix;
        const t = tileTint[iy * N + ix];

        const d = Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy));
        const groutM = 1 - sstep(grout * 0.5, grout, d);
        const bevel = 1 - sstep(grout, grout * 3.2, d);

        const veinAmt = Math.pow(vein[i], 2.2) * (0.5 + 0.5 * veinBase[i]);
        const base = 0.70 + 0.10 * t + 0.05 * (veinBase[i] - 0.5);
        let cr = base * (1 - veinAmt * 0.34) * 1.005;
        let cg = base * (1 - veinAmt * 0.36) * 1.0;
        let cb = base * (1 - veinAmt * 0.33) * 0.985;
        // faint warm/cool per-tile drift so the grid never reads as one colour
        cr *= 1 + (t - 0.5) * 0.05;
        cb *= 1 - (t - 0.5) * 0.05;
        // grout
        const gg = 0.40 + 0.10 * grain[i];
        cr = mix(cr, gg, groutM); cg = mix(cg, gg * 0.99, groutM); cb = mix(cb, gg * 0.95, groutM);
        if (micro[i] > 0.997) { cr += 0.05; cg += 0.05; cb += 0.05; }

        b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
        b.height[i] = 0.80 - groutM * 0.62 - bevel * 0.16 + veinAmt * 0.05 + grain[i] * 0.03;
        b.rough[i] = clamp(mix(0.18 + veinAmt * 0.14 + (grain[i] - 0.5) * 0.05 + t * 0.05, 0.88, groutM), 0.06, 0.95);
      }
    }
    b.ao = cavityAO(b.height, S, S, 3, 2.6);
    const set = assemble(b, 1.5, 3);
    set.normalScale = 0.9;
    return set;
  });
}

/** SNOW — wind-sculpted drifts, crust, sparkling ice crystals. */
export function makeSnow(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`snow:${S}`, () => {
    const b = newBuild(S);
    const drift = fbm2D(S, S, { octaves: 5, frequency: 3, gain: 0.55, seed: 700, warp: 0.22 });
    const meso = fbm2D(S, S, { octaves: 4, frequency: 11, gain: 0.5, seed: 701, warp: 0.1 });
    const grain = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 2), seed: 702 });
    const micro = hashNoise(S, S, 909);
    const clump = voronoiFields(S, S, Math.max(10, S / 40), 7007, 'euclidean', 0.95);

    for (let i = 0; i < S * S; i++) {
      const d = drift[i];
      const m = meso[i];
      const lump = Math.pow(clamp01(1 - clump.f1[i] / 0.55), 2) * 0.4;
      const shade = 0.88 + 0.10 * d + 0.05 * (m - 0.5) + 0.03 * lump;
      // snow in shadow goes blue; lit crests stay near-white
      let cr = shade * 0.965;
      let cg = shade * 0.985;
      let cb = shade * 1.0;
      const shadowT = clamp01(1 - d * 1.15);
      cr = mix(cr, cr * 0.86, shadowT * 0.5);
      cg = mix(cg, cg * 0.92, shadowT * 0.5);
      cb = mix(cb, cb * 1.02, shadowT * 0.5);
      if (micro[i] > 0.9955) { cr += 0.10; cg += 0.10; cb += 0.10; }

      b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
      b.height[i] = d * 0.6 + m * 0.24 + lump * 0.3 + grain[i] * 0.08;
      b.rough[i] = clamp(0.70 + 0.16 * (1 - d) + (grain[i] - 0.5) * 0.10 - lump * 0.14, 0.32, 0.95);
    }
    b.ao = cavityAO(b.height, S, S, 4, 1.2);
    for (let i = 0; i < b.ao.length; i++) b.ao[i] = mix(1, b.ao[i], 0.6);
    const set = assemble(b, 1.1, 5);
    set.normalScale = 0.8;
    return set;
  });
}

/**
 * TYRE RUBBER — real tread: 4 chevron lanes, 2 circumferential grooves,
 * sipes across each block, chunky shoulder lugs. Bevelled by a small blur
 * before the Sobel so block edges read as moulded, not cut.
 */
export function makeRubber(size?: number): PbrSet {
  const S = res(size, 1024);
  return cached(`rubber:${S}`, () => {
    const b = newBuild(S);

    const tread = rasterField(S, (ctx, s) => {
      const px = s / 1024;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, s, s);

      // 4 tread lanes across V, with grooves between them
      const laneCenters = [0.135, 0.375, 0.625, 0.865];
      const laneH = 0.185 * s;
      const BLOCKS = 14;
      ctx.fillStyle = '#fff';
      for (let li = 0; li < laneCenters.length; li++) {
        const cy = laneCenters[li] * s;
        const skew = li < 2 ? 1 : -1;
        for (let k = 0; k < BLOCKS; k++) {
          const cx = ((k + (li % 2) * 0.5) / BLOCKS) * s;
          const bw = (s / BLOCKS) * 0.72;
          for (const ox of [-s, 0, s]) {
            ctx.beginPath();
            const x0 = cx + ox - bw * 0.5;
            const x1 = cx + ox + bw * 0.5;
            const sh = skew * laneH * 0.30;
            ctx.moveTo(x0 - sh, cy - laneH * 0.5);
            ctx.lineTo(x1 - sh, cy - laneH * 0.5);
            ctx.lineTo(x1 + sh, cy + laneH * 0.5);
            ctx.lineTo(x0 + sh, cy + laneH * 0.5);
            ctx.closePath();
            ctx.fill();
          }
        }
      }
      // shoulder lugs at the very edges (wrap across v=0/1)
      ctx.fillStyle = '#fff';
      const LUGS = 18;
      for (let k = 0; k < LUGS; k++) {
        const cx = ((k + 0.25) / LUGS) * s;
        const bw = (s / LUGS) * 0.62;
        for (const cy of [0, s]) {
          ctx.fillRect(cx - bw * 0.5, cy - 0.028 * s, bw, 0.056 * s);
        }
      }
      // sipes: thin cuts across the blocks
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2.4 * px;
      for (let li = 0; li < laneCenters.length; li++) {
        const cy = laneCenters[li] * s;
        for (let k = 0; k < BLOCKS * 2; k++) {
          const cx = ((k + 0.25) / (BLOCKS * 2)) * s;
          ctx.beginPath();
          ctx.moveTo(cx, cy - laneH * 0.45);
          ctx.lineTo(cx + (li < 2 ? -1 : 1) * laneH * 0.26, cy + laneH * 0.45);
          ctx.stroke();
        }
      }
    });

    const soft = blurWrap(tread, S, S, Math.max(1, S >> 9));
    const grain = fbm2D(S, S, { octaves: 3, frequency: Math.max(8, S >> 3), gain: 0.55, seed: 1212 });
    const macro = fbm2D(S, S, { octaves: 3, frequency: 6, gain: 0.55, seed: 1213, warp: 0.12 });
    const micro = hashNoise(S, S, 3690);

    for (let i = 0; i < S * S; i++) {
      const blk = soft[i];
      const crown = sstep(0.75, 1.0, blk);
      const base = 0.052 + 0.020 * macro[i] + 0.012 * (grain[i] - 0.5);
      let cr = base;
      let cg = base * 0.99;
      let cb = base * 1.02;
      // worn block tops go slightly grey/dusty
      const wear = crown * (0.35 + 0.4 * macro[i]);
      cr = mix(cr, 0.115, wear * 0.55);
      cg = mix(cg, 0.113, wear * 0.55);
      cb = mix(cb, 0.116, wear * 0.55);
      // grooves stay pitch black
      cr *= mix(0.55, 1, blk); cg *= mix(0.55, 1, blk); cb *= mix(0.55, 1, blk);
      if (micro[i] > 0.996) { cr += 0.03; cg += 0.03; cb += 0.03; }

      b.r[i] = cr; b.g[i] = cg; b.b[i] = cb;
      b.height[i] = blk * 0.88 + grain[i] * 0.10 + macro[i] * 0.04;
      b.rough[i] = clamp(0.88 - crown * 0.22 + (grain[i] - 0.5) * 0.08 - macro[i] * 0.05, 0.45, 0.97);
    }
    b.ao = cavityAO(b.height, S, S, Math.max(2, S >> 8), 2.0);
    const set = assemble(b, 3.0, 0.8);
    set.normalScale = 1.4;
    return set;
  });
}

/**
 * TYRE SIDEWALL — bonus set for kart wheels: concentric moulding ribs,
 * raised brand lettering and the classic knurled band.
 */
export function makeTyreSidewall(size?: number, brand = 'APEX'): PbrSet {
  const S = res(size, 512);
  return cached(`sidewall:${S}:${brand}`, () => {
    const b = newBuild(S);
    const mask = rasterField(S, (ctx, s) => {
      const c = s * 0.5;
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, s, s);
      // concentric moulding ribs
      for (let r = s * 0.16; r < s * 0.5; r += s * 0.012) {
        ctx.strokeStyle = 'rgba(255,255,255,0.30)';
        ctx.lineWidth = s * 0.004;
        ctx.beginPath();
        ctx.arc(c, c, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      // knurled band
      for (let a = 0; a < 128; a++) {
        const th = (a / 128) * Math.PI * 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = s * 0.008;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(th) * s * 0.30, c + Math.sin(th) * s * 0.30);
        ctx.lineTo(c + Math.cos(th) * s * 0.365, c + Math.sin(th) * s * 0.365);
        ctx.stroke();
      }
      // raised lettering around the rim
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(s * 0.052)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const text = `${brand} · RACING · `;
      const reps = 3;
      for (let rIdx = 0; rIdx < reps; rIdx++) {
        for (let ci = 0; ci < text.length; ci++) {
          const th = ((rIdx * text.length + ci) / (text.length * reps)) * Math.PI * 2 - Math.PI / 2;
          ctx.save();
          ctx.translate(c + Math.cos(th) * s * 0.425, c + Math.sin(th) * s * 0.425);
          ctx.rotate(th + Math.PI / 2);
          ctx.fillText(text[ci], 0, 0);
          ctx.restore();
        }
      }
    });
    const soft = blurWrap(mask, S, S, 1);
    const grain = fbm2D(S, S, { octaves: 3, frequency: Math.max(8, S >> 3), seed: 1515 });
    for (let i = 0; i < S * S; i++) {
      const m = soft[i];
      const base = 0.050 + 0.014 * grain[i] + m * 0.045;
      b.r[i] = base; b.g[i] = base * 0.99; b.b[i] = base * 1.02;
      b.height[i] = m * 0.8 + grain[i] * 0.12;
      b.rough[i] = clamp(0.90 - m * 0.18 + (grain[i] - 0.5) * 0.08, 0.5, 0.97);
    }
    b.ao = cavityAO(b.height, S, S, 2, 2.0);
    return assemble(b, 2.2, 0.7);
  });
}

// ---------------------------------------------------------------------------
// Special-purpose textures
// ---------------------------------------------------------------------------

/**
 * A very fine, isotropic normal map intended to be tiled 4–8x on top of a
 * macro normal. Nothing kills the "plastic" look faster.
 */
export function detailNormal(size?: number): THREE.DataTexture {
  const S = res(size, 512);
  return cached(`detailNormal:${S}`, () => {
    const a = fbm2D(S, S, { octaves: 3, frequency: Math.max(8, S >> 4), gain: 0.55, seed: 606 });
    const c = fbm2D(S, S, { octaves: 2, frequency: Math.max(8, S >> 2), gain: 0.5, seed: 607 });
    const m = hashNoise(S, S, 608);
    const h = new Float32Array(S * S);
    for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.55 + c[i] * 0.32 + m[i] * 0.13;
    const smoothed = blurWrap(h, S, S, 1);
    return heightToNormal(smoothed, S, S, 1.6);
  }) as THREE.DataTexture;
}

/** Metallic flake normal for car paint. Extremely high frequency by design. */
function flakeNormal(size = 512): THREE.DataTexture {
  return cached(`flakeNormal:${size}`, () => {
    const cells = voronoiFields(size, size, Math.max(48, size / 5), 4711, 'euclidean', 0.98);
    const h = new Float32Array(size * size);
    for (let i = 0; i < h.length; i++) {
      h[i] = cells.id[i] * Math.pow(clamp01(1 - cells.f1[i] / 0.7), 0.6);
    }
    return heightToNormal(h, size, size, 2.2);
  }) as THREE.DataTexture;
}

/**
 * CAR PAINT — metallic base + flakes + clearcoat. Returns a
 * MeshPhysicalMaterial so it reacts properly to the environment map.
 */
export function makeCarPaint(color: THREE.ColorRepresentation): THREE.MeshPhysicalMaterial {
  const hex = new THREE.Color(color).getHex();
  return cached(`carpaint:${hex}`, () => {
    const flakes = flakeNormal(512);
    const tex = flakes.clone();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(28, 28);
    tex.anisotropy = defaultAnisotropy;
    tex.needsUpdate = true;
    allTextures.add(tex);

    const mat = new THREE.MeshPhysicalMaterial({
      color: hex,
      metalness: 0.72,
      roughness: 0.30,
      clearcoat: 1.0,
      clearcoatRoughness: 0.055,
      normalMap: tex,
      normalScale: new THREE.Vector2(0.10, 0.10),
      envMapIntensity: 1.35,
      sheen: 0.15,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0xffffff),
    });
    allMaterials.add(mat);
    return mat;
  }) as THREE.MeshPhysicalMaterial;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function disposeAll(): void {
  for (const t of allTextures) t.dispose();
  for (const m of allMaterials) m.dispose();
  allTextures.clear();
  allMaterials.clear();
  cache.clear();
  gradCache.clear();
  stats.generatedMs = 0;
  stats.count = 0;
}

/** Singleton facade — `textureFactory.makeAsphalt()` etc. */
export const textureFactory = {
  configure,
  stats,
  fbm2D,
  voronoi2D,
  worley,
  hashNoise,
  rasterField,
  heightToNormal,
  floatToTexture,
  canvasTexture,
  radialSprite,
  gradientRamp,
  setAnisotropy,
  detailNormal,
  makeAsphalt,
  makeConcrete,
  makeGrass,
  makeSand,
  makeDirt,
  makeRock,
  makeWoodPlank,
  makeMetalPanel,
  makeBrick,
  makeCobblestone,
  makeTileFloor,
  makeSnow,
  makeRubber,
  makeTyreSidewall,
  makeCarPaint,
  disposeAll,
};

export default textureFactory;
