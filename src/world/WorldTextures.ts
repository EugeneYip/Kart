/**
 * ============================================================================
 *  APEX KART — WORLD TEXTURE / NOISE LIBRARY
 * ============================================================================
 *  Local, dependency-free procedural asset generation for the world modules.
 *  Everything here is generated in code — zero network requests, ever.
 *
 *  NOTE: `src/render/TextureFactory.ts` is the shared library owned by the
 *  render agent. It did not exist when this module was written, so these are
 *  local fallbacks with the same spirit. De-duplicate at integration time.
 * ============================================================================
 */

import * as THREE from 'three';
import { clamp01, smootherstep } from '@/core/MathUtils';

// ---------------------------------------------------------------------------
// World themes + the track decoration contract
// ---------------------------------------------------------------------------

export type WorldTheme = 'coastal' | 'city' | 'volcano' | 'meadow' | 'desert' | 'snow';

/**
 * How `Track` arrived at an authored prop's world Y — enough of it that a
 * consumer which owns the real ground can redo the answer.
 *
 * `Track` has no heightfield (the heightfield is baked *from* the track, so the
 * dependency cannot run the other way) and can only offer the road surface
 * plane. For a prop authored beyond the shoulder it therefore extrapolates that
 * plane outward: `position` is at the true lateral offset but at a height taken
 * from the corridor edge. Where the terrain falls away from the road those props
 * sink and where it rises they float. Publishing the pieces of the calculation —
 * rather than only its result — is what lets the world dresser re-seat them on
 * the heightfield *without losing the author's `up`*, which is otherwise
 * unrecoverable once it has been folded into `position`.
 */
export interface PropSurfaceHint {
  /**
   * Authored offset along the road normal, metres, ALREADY included in
   * `position`. Subtract it to recover the surface height that was used, or add
   * it back on top of a different surface.
   */
  up: number;
  /** Authored lateral offset from the centreline, metres. + = driver's right. */
  lat: number;
  /**
   * Half-width of the *drawn* road surface at this station: asphalt + kerb +
   * shoulder. `|lat| > corridor` means `position.y` is an extrapolation, not the
   * surface the prop actually stands on.
   */
  corridor: number;
  /**
   * The road here is a bridge deck or a tunnel bore, i.e. `position.y` is a
   * structure height that may be tens of metres off natural ground. A consumer
   * re-seating props must leave these alone.
   */
  elevated: boolean;
}

/** One authored prop placement coming out of `track.getDecorationHints()`. */
export interface DecorationProp {
  type: string;
  position: THREE.Vector3;
  /** Y rotation in radians, or a full euler. */
  rotation?: number | THREE.Euler;
  scale?: number | THREE.Vector3;
  /**
   * Optional. Absent for any track that does not publish it, in which case
   * `position` is taken exactly as given — see `PropSurfaceHint`.
   */
  surface?: PropSurfaceHint;
}

export interface DecorationHints {
  theme: WorldTheme;
  /** Mirrors `SkyPresetName` — declared inline to keep this module dependency-free. */
  skyPreset: 'day' | 'sunset' | 'night' | 'storm' | 'volcanic';
  props: DecorationProp[];
  terrainSeed: number;
  waterLevel: number;
}

/**
 * Everything the decoration modules (Foliage, Water, Props, Crowd, Weather)
 * need. Environment builds exactly one of these and hands it to each of them,
 * so nobody has to know whether a real Track exists.
 */
export interface WorldContext {
  field: TerrainField;
  stations: PathStation[];
  hints: DecorationHints;
  lapLength: number;
  theme: WorldTheme;
  waterLevel: number;
  /** Metres of half-width of the widest part of the road. */
  maxHalfWidth: number;
}

/** A resampled centreline station — the only thing the world needs from a track. */
export interface PathStation {
  px: number; py: number; pz: number;
  /** unit tangent in XZ */
  tx: number; tz: number;
  /** unit binormal (driver's right) in XZ */
  bx: number; bz: number;
  halfWidth: number;
  /** tan(bank): cross-slope of the road surface. */
  tanBank: number;
  /** arc length from the start line, metres */
  s: number;
  /**
   * Off-road shoulder width outside the kerb, left / right, metres. OPTIONAL:
   * absent for any producer that does not publish it, in which case the bake
   * assumes `SH_FALLBACK`.
   *
   * The bake needs these because the terrain has to sit under the whole DRAWN
   * road — asphalt + kerb + shoulder — and the shoulder is the widest and most
   * variable part of it (0-9 m authored, with four 24 m nodes). Without them the
   * seam is right to within about 0.2 m instead of exactly right; see
   * `roadSurfaceOffset`. `Track` already has the numbers: they are
   * `SplineAttribs.shoulderL / shoulderR`, which `Environment.stationFrom()`
   * receives on its sample and currently drops on the floor.
   */
  shoulderL?: number;
  shoulderR?: number;
}

/** What `roadVerge` measured at a point. */
export interface RoadVerge {
  /**
   * Metres of clear ground between the point and the nearest asphalt EDGE.
   * Negative means the point is on the drivable road.
   */
  verge: number;
  /** Road half-width at the nearest centreline point. */
  halfWidth: number;
  /** Unit direction, in XZ, that points AWAY from the road from here. */
  outX: number;
  outZ: number;
}

/**
 * Perpendicular distance from an XZ point to the nearest asphalt edge.
 *
 * WHY THIS EXISTS, AND WHY NOT `TerrainField.roadDistanceAt`. Two independent
 * errors made the baked field unusable for deciding whether a decoration is on
 * the road, and Foliage was using it for exactly that:
 *
 *  1. It measures to the CENTRELINE, not to the edge — its own doc comment says
 *     so — and every Foliage caller compared it against a bare constant with no
 *     `halfWidth` term. On a 12.5 m half-width station the flower scatter
 *     admitted anything past 10.2 m, i.e. 2.3 m INSIDE the drivable road.
 *  2. It is a NEAREST-TEXEL lookup on a 2.4 m (ultra) to 5.0 m (low) grid, so it
 *     over-reports clearance by up to a texel half-diagonal — another 1.7–3.5 m
 *     of leak, and a different amount per quality tier.
 *
 * This walks the resampled stations instead (~7 m spacing) and projects onto the
 * two adjoining chords, which is accurate to a few centimetres and tier-
 * independent. Same approach as `Props.roadClearance`, shared so the two cannot
 * drift apart again.
 */
export function roadVerge(
  stations: readonly PathStation[], x: number, z: number, out?: RoadVerge,
): RoadVerge {
  const r: RoadVerge = out ?? { verge: 0, halfWidth: 11, outX: 1, outZ: 0 };
  const n = stations.length;
  if (n === 0) {
    r.verge = 1e9; r.halfWidth = 11; r.outX = 1; r.outZ = 0;
    return r;
  }
  let bi = 0, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = stations[i].px - x, dz = stations[i].pz - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) { bd = d2; bi = i; }
  }
  let best = Math.sqrt(bd);
  let hw = stations[bi].halfWidth;
  let cx = stations[bi].px, cz = stations[bi].pz;
  for (const j of [(bi - 1 + n) % n, bi]) {
    const a = stations[j], b = stations[(j + 1) % n];
    const ex = b.px - a.px, ez = b.pz - a.pz;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-6) continue;
    let t = ((x - a.px) * ex + (z - a.pz) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.px + ex * t, pz = a.pz + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      hw = a.halfWidth + (b.halfWidth - a.halfWidth) * t;
      cx = px; cz = pz;
    }
  }
  let ox = x - cx, oz = z - cz;
  const ol = Math.hypot(ox, oz);
  if (ol > 1e-6) { ox /= ol; oz /= ol; } else { ox = 1; oz = 0; }
  r.verge = best - hw;
  r.halfWidth = hw;
  r.outX = ox;
  r.outZ = oz;
  return r;
}

// ---------------------------------------------------------------------------
// Hashing + noise
// ---------------------------------------------------------------------------

/** Integer hash → [0,1). Deterministic across runs. */
export function ihash(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** Non-tiling 2D value noise. */
export function vnoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const a = ihash(xi, yi, seed);
  const b = ihash(xi + 1, yi, seed);
  const c = ihash(xi, yi + 1, seed);
  const d = ihash(xi + 1, yi + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Tiling 2D value noise with integer lattice period (px, py). */
export function tnoise(x: number, y: number, px: number, py: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const x0 = ((xi % px) + px) % px;
  const y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = ihash(x0, y0, seed);
  const b = ihash(x1, y0, seed);
  const c = ihash(x0, y1, seed);
  const d = ihash(x1, y1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Tiling fBm over the unit square. `base` must be an integer frequency. */
export function fbmTile(
  x: number, y: number, base: number, octaves: number, seed = 0,
  gain = 0.5, lacunarity = 2,
): number {
  let f = base;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const fi = Math.max(1, Math.round(f));
    sum += amp * tnoise(x * fi, y * fi, fi, fi, seed + o * 977);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Non-tiling fBm — for world-space terrain height. */
export function fbm2D(x: number, y: number, octaves: number, seed = 0, gain = 0.5, lac = 2.0): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/** Ridged multifractal — mountain crests. */
export function ridged(x: number, y: number, octaves: number, seed = 0): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(vnoise(x * freq, y * freq, seed + o * 5171) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Texture helpers
// ---------------------------------------------------------------------------

const _srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export { _srgbToLinear as srgbToLinear };

/** Draw into a 2D canvas and wrap the result as a texture. */
export function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  opts: { srgb?: boolean; height?: number; wrap?: THREE.Wrapping } = {},
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = opts.height ?? size;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = opts.wrap ?? THREE.RepeatWrapping;
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * Sobel a height field into a tangent-space normal map (RGB DataTexture).
 * `height` is w*h floats in [0,1]. Wraps, so the result tiles.
 */
export function heightToNormal(
  height: Float32Array, w: number, h: number, strength = 2.0,
): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  const at = (x: number, y: number) => height[(((y % h) + h) % h) * w + (((x % w) + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv;
      const i = (y * w + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Sky cloud noise — RGBA packed multi-frequency tiling fBm
// ---------------------------------------------------------------------------

/**
 * R: 4-octave base (cumulus body)   G: 3-octave mid (billows)
 * B: 3-octave fine (erosion detail) A: 2-octave low (domain warp / coverage)
 */
export function makeCloudNoise(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const v = y * inv;
      const i = (y * size + x) * 4;
      data[i] = (fbmTile(u, v, 3, 4, 11) * 255) | 0;
      data[i + 1] = (fbmTile(u, v, 7, 3, 733) * 255) | 0;
      data[i + 2] = (fbmTile(u, v, 17, 3, 1571) * 255) | 0;
      data[i + 3] = (fbmTile(u, v, 2, 2, 2213) * 255) | 0;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Terrain layer array (albedo + normal) — 4 layers, tri/bi-planar ready
// ---------------------------------------------------------------------------

export interface TerrainLayerSet {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  dispose(): void;
}

type LayerFn = (u: number, v: number) => { r: number; g: number; b: number; h: number };

/** Per-theme multiplicative tint applied to every layer at bake time. */
const THEME_TINT: Record<WorldTheme, [number, number, number]> = {
  meadow: [1.0, 1.0, 1.0],
  coastal: [1.02, 1.03, 0.95],
  city: [0.92, 0.94, 0.96],
  volcano: [0.72, 0.55, 0.5],
  desert: [1.12, 1.0, 0.78],
  snow: [0.95, 0.98, 1.06],
};

/** Snow replaces the grass slot; basalt replaces rock on volcanic maps. */
function snowLayer(): LayerFn {
  return (u, v) => {
    const drift = fbmTile(u, v, 5, 4, 55);
    const grain = fbmTile(u, v, 46, 3, 6101);
    const crust = Math.pow(fbmTile(u, v, 18, 2, 3011), 3) * 2;
    const l = 0.88 + drift * 0.10 + grain * 0.08;
    return { r: Math.min(1, 0.94 * l + crust * 0.04), g: Math.min(1, 0.96 * l + crust * 0.04), b: Math.min(1, 1.0 * l), h: drift * 0.6 + grain * 0.4 };
  };
}

function basaltLayer(): LayerFn {
  return (u, v) => {
    const plate = fbmTile(u, v, 7, 4, 421);
    const crack = 1 - Math.min(1, Math.abs(fbmTile(u, v, 11, 3, 5501) - 0.5) * 8);
    const grain = fbmTile(u, v, 38, 2, 9109);
    const glow = Math.max(0, crack - 0.55) * 2.2;
    const l = 0.16 + plate * 0.14 + grain * 0.08;
    return {
      r: l + glow * 0.55, g: l * 0.92 + glow * 0.16, b: l * 0.95 + glow * 0.03,
      h: plate * 0.5 + grain * 0.2 - crack * 0.6 + 0.5,
    };
  };
}

function ashLayer(): LayerFn {
  return (u, v) => {
    const macro = fbmTile(u, v, 4, 4, 811);
    const grain = fbmTile(u, v, 44, 3, 2207);
    const l = 0.26 + macro * 0.2 + grain * 0.16;
    return { r: 0.42 * l + 0.03, g: 0.36 * l + 0.026, b: 0.35 * l + 0.028, h: grain * 0.55 + macro * 0.45 };
  };
}

/** grass / dirt / rock / sand, in that layer order. */
function terrainLayerFns(): LayerFn[] {
  return [
    // 0 — grass: mottled green with dry patches and clover-ish speckle
    (u, v) => {
      const macro = fbmTile(u, v, 3, 4, 91);
      const fine = fbmTile(u, v, 24, 3, 4501);
      const blades = fbmTile(u * 1.0, v * 1.0, 48, 2, 811);
      const dry = Math.max(0, macro - 0.55) * 2.2;
      const l = 0.42 + fine * 0.34 + blades * 0.16;
      const r = (0.20 + dry * 0.42) * l + 0.03;
      const g = (0.52 + dry * 0.16) * l + 0.045;
      const b = (0.14 + dry * 0.10) * l + 0.02;
      return { r, g, b, h: fine * 0.55 + blades * 0.45 };
    },
    // 1 — dirt: warm brown, scattered aggregate, dry patches.
    // The pebble term used to be pow(n,5)*3 contributing 0.6 of the height
    // field: flat-topped clipped blobs whose edges Sobel'd into hard walls, which
    // is most of why the shoulder read as ridged plastic. Now it is a gentle
    // aggregate speckle that shows in the albedo more than in the relief.
    (u, v) => {
      const macro = fbmTile(u, v, 4, 4, 177);
      const grain = fbmTile(u, v, 32, 3, 6607);
      const peb = Math.pow(fbmTile(u, v, 14, 2, 3313), 4) * 1.7;
      const l = 0.5 + macro * 0.3 + grain * 0.25;
      const r = 0.46 * l + peb * 0.13 + 0.04;
      const g = 0.32 * l + peb * 0.12 + 0.028;
      const b = 0.20 * l + peb * 0.10 + 0.018;
      return { r, g, b, h: grain * 0.46 + macro * 0.40 + peb * 0.22 };
    },
    // 2 — rock: grey stratified stone with cracks
    (u, v) => {
      const strat = fbmTile(u, v * 0.35, 5, 4, 331);
      const crack = 1 - Math.min(1, Math.abs(fbmTile(u, v, 9, 3, 8191) - 0.5) * 7);
      const grain = fbmTile(u, v, 40, 2, 9931);
      const l = 0.44 + strat * 0.32 + grain * 0.18 - crack * 0.28;
      const r = 0.60 * l + 0.05;
      const g = 0.59 * l + 0.052;
      const b = 0.575 * l + 0.058;
      return { r, g, b, h: strat * 0.5 + grain * 0.2 - crack * 0.55 + 0.5 };
    },
    // 3 — sand: pale gold, wind-curved ripples, shell grit.
    // The old form was `sin(v * 34 + n * 6)`: 34 straight ripples per tile, all
    // parallel to world Z, carrying 0.55 of the height field. Sobel'd at strength
    // 2 that is literal corduroy, and at sunset it strobes orange. The crests now
    // bend through a two-scale domain warp, are 4x coarser, and carry a third of
    // the relief — the grain and the patchiness do the texturing instead.
    (u, v) => {
      const warp = fbmTile(u, v, 3, 3, 401);
      const warp2 = fbmTile(u, v, 7, 2, 4093);
      const ripple = 0.5 + 0.5 * Math.sin((v * 8 + u * 2.6 + warp * 5.5 + warp2 * 1.7) * Math.PI * 2);
      const grain = fbmTile(u, v, 56, 2, 7717);
      const patch = fbmTile(u, v, 5, 3, 1223);
      const l = 0.70 + ripple * 0.06 + grain * 0.12 + patch * 0.11;
      const r = 0.86 * l;
      const g = 0.74 * l;
      const b = 0.52 * l;
      return { r, g, b, h: ripple * 0.26 + grain * 0.40 + patch * 0.34 };
    },
  ];
}

/**
 * Per-layer Sobel strength for the baked normal slices: grass, dirt, rock, sand.
 *
 * These were a flat 2.0 (3.0 for rock). At that strength the off-road layers read
 * as ridged plastic — a review measured the shoulder as roughly 5x too strong —
 * and the per-layer figure matters because grass and rock genuinely want relief
 * while dirt and sand want almost none. Terrain scales these again per layer at
 * runtime (`uNormalScale`) so the balance can be tuned without a re-bake.
 */
const LAYER_SOBEL: readonly number[] = [1.3, 1.1, 2.2, 0.85];

export function makeTerrainLayers(size = 256, theme: WorldTheme = 'meadow'): TerrainLayerSet {
  const fns = terrainLayerFns();
  if (theme === 'snow') fns[0] = snowLayer();
  if (theme === 'volcano') { fns[0] = ashLayer(); fns[2] = basaltLayer(); }
  const tint = THEME_TINT[theme] ?? THEME_TINT.meadow;
  const depth = fns.length;
  const alb = new Uint8Array(size * size * 4 * depth);
  const nrm = new Uint8Array(size * size * 4 * depth);
  const height = new Float32Array(size * size);
  const inv = 1 / size;

  for (let L = 0; L < depth; L++) {
    const fn = fns[L];
    const off = L * size * size * 4;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = fn(x * inv, y * inv);
        const i = (y * size + x) * 4;
        alb[off + i] = Math.max(0, Math.min(255, o.r * tint[0] * 255)) | 0;
        alb[off + i + 1] = Math.max(0, Math.min(255, o.g * tint[1] * 255)) | 0;
        alb[off + i + 2] = Math.max(0, Math.min(255, o.b * tint[2] * 255)) | 0;
        // alpha carries the layer height for height-blended transitions
        const hh = Math.max(0, Math.min(1, o.h));
        alb[off + i + 3] = (hh * 255) | 0;
        height[y * size + x] = hh;
      }
    }
    // Sobel this layer's height into the normal array slice.
    const n = heightToNormal(height, size, size, LAYER_SOBEL[L] ?? 1.2);
    const src = n.image.data as Uint8Array;
    nrm.set(src, off);
    n.dispose();
  }

  const albedo = new THREE.DataArrayTexture(alb, size, size, depth);
  albedo.format = THREE.RGBAFormat;
  albedo.type = THREE.UnsignedByteType;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.minFilter = THREE.LinearMipmapLinearFilter;
  albedo.magFilter = THREE.LinearFilter;
  albedo.generateMipmaps = true;
  albedo.colorSpace = THREE.NoColorSpace; // decoded manually in the shader
  albedo.needsUpdate = true;

  const normal = new THREE.DataArrayTexture(nrm, size, size, depth);
  normal.format = THREE.RGBAFormat;
  normal.type = THREE.UnsignedByteType;
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.magFilter = THREE.LinearFilter;
  normal.generateMipmaps = true;
  normal.colorSpace = THREE.NoColorSpace;
  normal.needsUpdate = true;

  return {
    albedo,
    normal,
    dispose() { albedo.dispose(); normal.dispose(); },
  };
}

/**
 * High-frequency detail normal that kills the "plastic" look when overlaid.
 *
 * The old form was `fbmTile(base 16, 4 octaves)` on a 256 texture, i.e. octaves
 * at 16/32/64/128 cycles — the top octave sits exactly at Nyquist, so it aliased
 * into a shimmering weave rather than reading as grain, and it mipped straight to
 * grey. Base 5 puts the finest octave at 40 cycles (≈5 cm at Terrain's 2.2 m
 * detail tile), which survives mipping and does not strobe.
 */
export function makeDetailNormal(size = 256): THREE.DataTexture {
  const h = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = fbmTile(x * inv, y * inv, 5, 4, 5077);
    }
  }
  return heightToNormal(h, size, size, 0.8);
}

// ---------------------------------------------------------------------------
// Bark / wood / stone / metal — prop materials
// ---------------------------------------------------------------------------

export function makeBark(size = 256): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv, v = y * inv;
      // Vertical fibres: stretch the noise hard in v.
      const fib = fbmTile(u * 1.0, v * 1.0, 20, 3, 617);
      const stretch = fbmTile(u, v * 0.12, 12, 4, 2029);
      const groove = Math.pow(Math.abs(stretch - 0.5) * 2, 0.6);
      const l = 0.35 + fib * 0.3 + groove * 0.35;
      const i = (y * size + x) * 4;
      data[i] = (Math.min(1, 0.40 * l + 0.06) * 255) | 0;
      data[i + 1] = (Math.min(1, 0.30 * l + 0.045) * 255) | 0;
      data[i + 2] = (Math.min(1, 0.21 * l + 0.033) * 255) | 0;
      data[i + 3] = 255;
      h[y * size + x] = groove * 0.75 + fib * 0.25;
    }
  }
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.needsUpdate = true;
  return { map, normalMap: heightToNormal(h, size, size, 3.0) };
}

/** Soft radial alpha blob used for leaf clusters / crowd sprites. */
export function makeLeafAlpha(size = 128, seed = 3): THREE.CanvasTexture {
  return canvasTexture(size, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const r = new Rand(seed);
    for (let i = 0; i < 46; i++) {
      const a = r.f() * Math.PI * 2;
      const rad = Math.pow(r.f(), 0.6) * w * 0.36;
      const cx = w * 0.5 + Math.cos(a) * rad;
      const cy = h * 0.5 + Math.sin(a) * rad * 0.82;
      const s = w * (0.06 + r.f() * 0.10);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s);
      const tone = 120 + r.f() * 110;
      g.addColorStop(0, `rgba(${(tone * 0.55) | 0},${tone | 0},${(tone * 0.4) | 0},1)`);
      g.addColorStop(0.65, `rgba(${(tone * 0.42) | 0},${(tone * 0.8) | 0},${(tone * 0.3) | 0},0.95)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, s, s * 0.85, a, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** Small deterministic PRNG for canvas drawing. */
export class Rand {
  private s: number;
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  f(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  r(a: number, b: number): number { return a + this.f() * (b - a); }
  i(a: number, b: number): number { return Math.floor(this.r(a, b + 0.999)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.min(arr.length - 1, Math.floor(this.f() * arr.length))]; }
}

// ---------------------------------------------------------------------------
// Shared GLSL snippets
// ---------------------------------------------------------------------------

/** Cheap sRGB→linear, accurate enough for albedo and 4× faster than pow(). */
export const GLSL_SRGB = /* glsl */ `
vec3 srgbToLin(vec3 c){ return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
`;

/** 2D/3D hash + value noise for shaders. */
export const GLSL_NOISE = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float fbm2(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i=0;i<6;i++){ if(i>=oct) break; s += a*vnoise2(p); n += a; a *= 0.5; p *= 2.03; }
  return s/max(n,1e-4);
}
`;

/**
 * Height fog matching Lighting's model, for custom ShaderMaterials.
 * Requires uniforms: uFogColor, uFogSunColor, uFogDensity, uFogHeight,
 * uFogFalloff, uSunDirection and the `cameraPosition` built-in.
 */
export const GLSL_HEIGHT_FOG = /* glsl */ `
uniform vec3 uFogColor;
uniform vec3 uFogSunColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFogFalloff;
uniform vec3 uSunDirection;
vec3 applyHeightFog(vec3 col, vec3 worldPos, vec3 camPos){
  vec3 ray = worldPos - camPos;
  float dist = length(ray);
  if(dist < 1e-4) return col;
  vec3 rd = ray / dist;
  float b = max(uFogFalloff, 1e-4);
  float ry = rd.y;
  float base = uFogDensity * exp(-(camPos.y - uFogHeight) * b);
  float amt;
  if(abs(ry) < 1e-4) amt = base * dist;
  else amt = base * (1.0 - exp(-dist * ry * b)) / (ry * b);
  amt = 1.0 - exp(-max(amt, 0.0));
  float sunAmt = max(dot(rd, uSunDirection), 0.0);
  vec3 fc = mix(uFogColor, uFogSunColor, pow(sunAmt, 5.0) * 0.85);
  return mix(col, fc, clamp(amt, 0.0, 1.0));
}
`;

/**
 * Tiny late-binding registry.
 *
 * Sky and Lighting are constructed by Game *before* Environment and are not
 * handed to it, but Environment still needs to push the track's sky preset.
 * Rather than depend on Game growing a wiring line, both register themselves
 * here in `init()` and Environment duck-types whatever it finds. An explicitly
 * wired `setSky()` / `setLighting()` always wins over these.
 */
export const worldRegistry: {
  sky: { presetName: string; setPreset(name: string): void } | null;
  lighting: { presetName: string; setPreset(name: string): void } | null;
} = { sky: null, lighting: null };

/** Uniform block factory so every custom material shares the fog values. */
export interface FogUniforms {
  uFogColor: { value: THREE.Color };
  uFogSunColor: { value: THREE.Color };
  uFogDensity: { value: number };
  uFogHeight: { value: number };
  uFogFalloff: { value: number };
  uSunDirection: { value: THREE.Vector3 };
}

/**
 * Global, shared fog/sun uniform block. Lighting writes it; Terrain, Water,
 * Foliage and Props read it — one source of truth, zero per-frame allocation.
 */
export const worldFogUniforms: FogUniforms = {
  uFogColor: { value: new THREE.Color(0x9fc4e8) },
  uFogSunColor: { value: new THREE.Color(0xffe6c0) },
  uFogDensity: { value: 0.0032 },
  uFogHeight: { value: 6 },
  uFogFalloff: { value: 0.018 },
  uSunDirection: { value: new THREE.Vector3(0.4, 0.6, 0.6).normalize() },
};

/** Shared sun colour/intensity so custom shaders can do their own lighting. */
export const worldSunUniforms = {
  uSunColor: { value: new THREE.Color(0xfff3dd) },
  uSunIntensity: { value: 3.2 },
  uAmbientSky: { value: new THREE.Color(0x87b6ea) },
  uAmbientGround: { value: new THREE.Color(0x4a4033) },
  uAmbientIntensity: { value: 0.6 },
};

/** Simple hemisphere + wrapped-lambert used by the cheap custom materials. */
export const GLSL_WORLD_LIGHT = /* glsl */ `
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform float uAmbientIntensity;
vec3 worldLight(vec3 n, vec3 albedo, float wrapAmt, float shadowAtt){
  float ndl = dot(n, uSunDirection);
  float diff = clamp((ndl + wrapAmt) / (1.0 + wrapAmt), 0.0, 1.0);
  vec3 hemi = mix(uAmbientGround, uAmbientSky, n.y * 0.5 + 0.5) * uAmbientIntensity;
  return albedo * (uSunColor * uSunIntensity * diff * shadowAtt + hemi);
}
`;

// ---------------------------------------------------------------------------
// TERRAIN FIELD — the single source of truth for ground height
// ---------------------------------------------------------------------------
//  Baked once at load into two textures that every world module samples:
//    heightTex : R float   — final terrain height in metres (road already
//                            blended in, so terrain can never gap the road)
//    dataTex   : RGBA8     — R road mask, G ambient occlusion,
//                            B moisture, A rockiness
//  The CPU-side arrays are kept so prop/foliage scattering can query the same
//  values the GPU sees. Sampling is bilinear on both sides — identical results.
// ---------------------------------------------------------------------------

export interface TerrainFieldOptions {
  seed: number;
  /** Side length of the baked square, metres. */
  extent: number;
  /** Texels per side. extent/res = metres per texel. */
  res: number;
  centreX: number;
  centreZ: number;
  stations: PathStation[];
  theme: WorldTheme;
  waterLevel: number;
  /** Rolling-hill amplitude, metres. */
  amplitude: number;
}

const INF = 1e9;

/**
 * Metres of road-edge signed distance stored in `TerrainField.edge.r`, each way.
 * ±24 m at ~2.4 m per texel is ten texels of gradient, so the reconstructed
 * boundary is smooth at any width the shader asks for. Exported because the
 * shader has to undo the mapping.
 */
export const EDGE_RANGE = 24;

/**
 * THE DRAWN ROAD CROSS-SECTION, restated from `CROSS` / `surfaceHeight()` in
 * TrackBuilder rather than imported so the terrain bake does not pull the whole
 * track-mesh builder (and MeshBVH) into the world-texture module graph. If any
 * of these change, `.probe-tmp/terrecon.ts` reports the seam stepping again and
 * `.probe-tmp/edgeview.ts` reports grass on the asphalt.
 *
 * `KERB_W` was already restated here. The other three were not, and their
 * absence was a defect in its own right — see `roadSurfaceOffset` below.
 */
const KERB_W = 1.55;
/** Crown: metres of drop from the centreline plane to the asphalt edge. */
const CROWN = 0.16;
/** Further drop from the asphalt edge to the OUTER edge of the shoulder. */
const SHOULDER_DROP = 0.34;
/**
 * Shoulder width assumed when a station does not publish one.
 *
 * Authored shoulders run 0-9 m (a handful of 24 m), median ~3. The error this
 * constant can cause is deliberately asymmetric: guessing too WIDE leaves the
 * terrain slightly high and puts a visible lip along the road, guessing too
 * NARROW leaves it slightly low, which is under the shoulder mesh and therefore
 * invisible. 3 m is the median, and at that value no authored width produces a
 * lip except the twelve `sh: 0` nodes (0.18 m, down from 0.34 m).
 */
const SH_FALLBACK = 3;
/** Width of the grass-mask ramp back to full density, metres. */
const GRASS_RAMP = 3.4;

/**
 * Height of the DRAWN road surface relative to the banked centreline plane, at
 * a lateral offset `u` metres from the centreline. Always <= 0.
 *
 * WHY THE BAKE NEEDS THIS AT ALL. The stamp used to pull the terrain to the bare
 * banked plane, `st.py + cross * tanBank`, and hold it dead flat out to 2.2 m
 * past the ASPHALT edge. But the road that gets drawn is not a plane and does
 * not end at the asphalt: it crowns down `CROWN` to the asphalt edge, carries a
 * kerb, and then falls a further `SHOULDER_DROP` across a shoulder up to 9 m
 * wide. So the terrain sat `CROWN + SHOULDER_DROP - SINK = 0.34 m` ABOVE the
 * outer edge of the drawn shoulder — a lip of ground standing proud of the road
 * along both sides of every metre of every circuit, emerging from under the
 * shoulder mesh about a third of the way across it and burying the rest of the
 * authored verge. Measured (`.probe-tmp/terrecon.ts`, `seam`): p50 -0.2 m
 * against the centreline plane on five of six circuits, which is +0.30 m against
 * the surface actually drawn there, on 3812 of 3812 station-sides.
 *
 * The kerb is deliberately NOT followed up: it is a raised strip the terrain
 * must stay under, not a shape the ground takes. Across the kerb this returns
 * the asphalt-edge height, so the terrain passes `SINK + kerbH` below the kerb
 * top.
 */
function roadSurfaceOffset(u: number, hw: number, sh: number): number {
  if (u <= hw) {
    const t = hw > 1e-3 ? u / hw : 0;
    return -CROWN * t * t;
  }
  const s = clamp01(sh > 1e-3 ? (u - hw - KERB_W) / sh : 1);
  return -CROWN - SHOULDER_DROP * (s * s * (3 - 2 * s));
}

export class TerrainField {
  readonly extent: number;
  readonly res: number;
  readonly originX: number;
  readonly originZ: number;
  readonly metresPerTexel: number;
  readonly theme: WorldTheme;
  readonly waterLevel: number;
  readonly seed: number;
  readonly amplitude: number;
  readonly centreX: number;
  readonly centreZ: number;

  /** res*res final heights, metres. */
  readonly height: Float32Array;
  /**
   * res*res PERPENDICULAR distance to the centreline polyline, metres (CPU only),
   * counting only carriageways the stack guard accepted as ground here — so under
   * a flyover this is the distance to the road below, not to the deck.
   *
   * It used to be the distance to the nearest centreline *station*, which
   * over-read by up to a chord half-length (~3.5 m at the 7 m resample) and was
   * one of the two reasons grass was licensed inside the asphalt. The stamp now
   * projects onto the chords, exactly as `roadVerge()` above does and for the same
   * reason. Still the distance to the CENTRELINE, not the edge: subtract a
   * half-width, or use `roadVerge()`, which is what that function is for.
   */
  readonly roadDistance: Float32Array;
  /** res*res packed RGBA8 data. */
  readonly data: Uint8Array;
  /**
   * res*res packed RGBA8 surfacing field. Deliberately separate from `data`
   * because it means something different:
   *   R — signed distance to the road *edge*, remapped over ±EDGE_RANGE metres
   *   G — wide-scale concavity (0.5 flat, >0.5 valley floor, <0.5 ridge)
   *
   * `data.r` is a near-binary road mask with a 3.4 m ramp, and at 2.4 m per texel
   * that ramp is 1.4 texels wide — bilinear reconstruction of it is a staircase of
   * 2.4 m blocks, which is exactly the "hard sawtooth material boundary" defect.
   * A signed distance spread over ±24 m is ~10 texels per unit of ramp, so the
   * shader can put the transition anywhere, at any width, and break it with noise.
   * `data.r` is kept unchanged because Foliage keys grass density off it.
   */
  readonly edge: Uint8Array;

  readonly heightTex: THREE.DataTexture;
  readonly dataTex: THREE.DataTexture;
  readonly edgeTex: THREE.DataTexture;

  minHeight = 0;
  maxHeight = 0;

  private readonly stations: PathStation[];
  private readonly hillFreq: number;
  private readonly ridgeAmp: number;
  private readonly coastDir: number;

  constructor(opts: TerrainFieldOptions, renderer: THREE.WebGLRenderer | null) {
    this.extent = opts.extent;
    this.res = opts.res;
    this.centreX = opts.centreX;
    this.centreZ = opts.centreZ;
    this.originX = opts.centreX - opts.extent * 0.5;
    this.originZ = opts.centreZ - opts.extent * 0.5;
    this.metresPerTexel = opts.extent / opts.res;
    this.theme = opts.theme;
    this.waterLevel = opts.waterLevel;
    this.seed = opts.seed;
    this.amplitude = opts.amplitude;
    this.stations = opts.stations;

    // Per-theme macro shape.
    switch (opts.theme) {
      case 'city':    this.hillFreq = 0.0011; this.ridgeAmp = 210; break;
      case 'volcano': this.hillFreq = 0.0026; this.ridgeAmp = 320; break;
      case 'desert':  this.hillFreq = 0.0020; this.ridgeAmp = 250; break;
      case 'snow':    this.hillFreq = 0.0016; this.ridgeAmp = 380; break;
      case 'coastal': this.hillFreq = 0.0019; this.ridgeAmp = 230; break;
      default:        this.hillFreq = 0.0021; this.ridgeAmp = 260; break;
    }
    this.coastDir = (opts.seed % 4) * (Math.PI * 0.5) + 0.6;

    const n = opts.res * opts.res;
    this.height = new Float32Array(n);
    this.roadDistance = new Float32Array(n);
    this.data = new Uint8Array(n * 4);
    this.edge = new Uint8Array(n * 4);

    this.bake();

    // --- upload ---------------------------------------------------------------
    const linearFloat = renderer ? renderer.extensions.has('OES_texture_float_linear') : false;
    let tex: THREE.DataTexture;
    if (linearFloat) {
      tex = new THREE.DataTexture(this.height, opts.res, opts.res, THREE.RedFormat, THREE.FloatType);
    } else {
      // Half float is filterable everywhere in WebGL2; ~3 cm precision at 100 m.
      const half = new Uint16Array(n);
      const dv = new DataView(new ArrayBuffer(4));
      for (let i = 0; i < n; i++) half[i] = floatToHalf(this.height[i], dv);
      tex = new THREE.DataTexture(half, opts.res, opts.res, THREE.RedFormat, THREE.HalfFloatType);
    }
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.heightTex = tex;

    const d = new THREE.DataTexture(this.data, opts.res, opts.res, THREE.RGBAFormat);
    d.wrapS = d.wrapT = THREE.ClampToEdgeWrapping;
    d.minFilter = THREE.LinearMipmapLinearFilter;
    d.magFilter = THREE.LinearFilter;
    d.generateMipmaps = true;
    d.colorSpace = THREE.NoColorSpace;
    d.needsUpdate = true;
    this.dataTex = d;

    // No mipmaps: this one is a signed distance sampled at ~2.4 m per texel and
    // read at metre scale near the camera. Mip-averaging a distance field pulls
    // the zero crossing around, which would put a wobble in the boundary that
    // moves with camera distance.
    const e = new THREE.DataTexture(this.edge, opts.res, opts.res, THREE.RGBAFormat);
    e.wrapS = e.wrapT = THREE.ClampToEdgeWrapping;
    e.minFilter = THREE.LinearFilter;
    e.magFilter = THREE.LinearFilter;
    e.generateMipmaps = false;
    e.colorSpace = THREE.NoColorSpace;
    e.needsUpdate = true;
    this.edgeTex = e;
  }

  // --- natural (pre-road) height ---------------------------------------------

  /** Terrain height ignoring the track corridor. Valid outside the bake too. */
  naturalHeightAt(x: number, z: number): number {
    const f = this.hillFreq;
    const s = this.seed;
    const hills = fbm2D(x * f, z * f, 5, s) - 0.5;
    const detail = fbm2D(x * f * 7.3, z * f * 7.3, 4, s + 61) - 0.5;
    const micro = fbm2D(x * 0.055, z * 0.055, 2, s + 191) - 0.5;

    const dx = (x - this.centreX) / (this.extent * 0.5);
    const dz = (z - this.centreZ) / (this.extent * 0.5);
    const rad = Math.sqrt(dx * dx + dz * dz);
    // Push the big relief out to the rim so the racing area stays readable.
    const rim = smootherstep((rad - 0.34) / 0.62);
    const ridge = ridged(x * f * 0.62, z * f * 0.62, 5, s + 977);

    let h = hills * this.amplitude * 2.0 + detail * this.amplitude * 0.55 + micro * 0.5;
    h += ridge * ridge * this.ridgeAmp * rim;

    switch (this.theme) {
      case 'coastal': {
        // One flank of the map drops into the sea, with a wandering coastline.
        const cd = Math.cos(this.coastDir) * dx + Math.sin(this.coastDir) * dz;
        const wobble = (fbm2D(x * 0.0026, z * 0.0026, 3, s + 313) - 0.5) * 0.55;
        const shore = smootherstep((cd + wobble + 0.12) / 0.42);
        const seabed = this.waterLevel - 16 - ridge * 12;
        const beach = this.waterLevel + 0.6;
        h = shore < 0.5
          ? seabed + (beach - seabed) * smootherstep(shore * 2)
          : beach + (h - beach) * smootherstep((shore - 0.5) * 2.0);
        break;
      }
      case 'volcano': {
        // Basin floor with fissures; the rim ridges do the silhouette work.
        const fis = 1 - Math.abs(fbm2D(x * 0.0042, z * 0.0042, 3, s + 71) * 2 - 1);
        h -= Math.pow(fis, 3) * 9;
        h = Math.max(h, this.waterLevel - 3.5);
        break;
      }
      case 'desert': {
        const dune = Math.sin(x * 0.013 + (fbm2D(x * 0.002, z * 0.002, 3, s + 5) - 0.5) * 9) * 0.5 + 0.5;
        h += Math.pow(dune, 1.7) * this.amplitude * 0.9;
        break;
      }
      case 'city': {
        h = h * 0.42;
        break;
      }
      default: break;
    }
    return h;
  }

  // --- bake ------------------------------------------------------------------

  private bake(): void {
    const { res, extent } = this;
    const mpt = this.metresPerTexel;
    const n = res * res;
    const dist = this.roadDistance;
    const roadH = new Float32Array(n);
    const halfW = new Float32Array(n);
    /**
     * Radius, from the centreline, of the band that stays dead flat under the
     * road: asphalt + kerb + shoulder + `FLAT_PAD`. Kept separately from
     * `halfW` because the two answer different questions — `halfW` is the
     * asphalt edge, which is what the surfacing SDF and the grass mask key off,
     * and moving that would drag the dirt/grass boundary 5 m outboard.
     */
    const flatW = new Float32Array(n);
    /**
     * PLAN-SPACE distance to the nearest carriageway, and its half-width, with the
     * stack guard NOT applied — the only two arrays the grass kill mask uses.
     *
     * `dist` cannot do this job. It is the distance to the nearest carriageway
     * that the guard accepted, i.e. the one that shaped the ground, and under a
     * flyover that is the road 38 m BELOW the deck. So the deck's own corridor
     * appeared nowhere in the mask and grass grew through the surface the player
     * was driving on: 16 of 616 station-sides on volcano before this revision, and
     * 60 once the embankment cone started rejecting the helix over a wider area.
     * 58 of those 60 were 10-52 m under the deck and invisible, which is how the
     * residual was justified last round — but one was in the tarmac, and "mostly
     * invisible" is not a property worth preserving.
     *
     * Whether a blade belongs is a question about where a road is DRAWN, in plan,
     * at any height. That is this field. The cost is that the ground directly
     * under a flyover is bald in the deck's plan footprint, which is the road's
     * own shadow and reads as such.
     */
    const maskDist = new Float32Array(n).fill(INF);
    const maskHalfW = new Float32Array(n);
    dist.fill(INF);

    // ---- stamp the road corridor -------------------------------------------
    const R = 74; // metres of influence
    /** Metres past the outer edge of the DRAWN road that stay dead flat. */
    const FLAT_PAD = 1.2;

    /**
     * WHICH carriageway owns the ground under a texel.
     *
     * The stamp below picks the station nearest in **XZ only**, which is right
     * for a flat circuit and badly wrong for one that stacks roads vertically.
     * Volcano's helix passes directly over the lava-tube straight: at the
     * t=0.805 tunnel portal the nearest station >60 m away along the lap is
     * **3.5 m away in plan and 38 m overhead** (y 44.12 against the tube's
     * 5.96), so the ground under the tube was stamped to the *helix's* height.
     * Measured, that put terrain up to +38.8 m above the road on the racing
     * line, and a patchwork of +1 / +4 / +14 / +32 m spikes across the portal
     * mouth — which is the "portal buried in a hillside" report. The natural
     * terrain there is 11.5 m BELOW the road: there is no hill at all.
     *
     * So: first pass records the LOWEST plausible GROUND height at each texel;
     * the stamp then ignores any station riding more than `STACK_V` above it. A
     * flyover stops paving the ground it flies over, while ordinary cut-and-fill
     * embankments are unchanged.
     *
     * "LOWEST PLAUSIBLE GROUND", NOT "LOWEST ROAD", AND THAT DISTINCTION IS THE
     * WHOLE OF THIS PASS. The first version of it recorded `min(st.py)` over a
     * hard disc of radius `halfWidth + 12`, and a flat minimum over a hard disc
     * is wrong at both ends:
     *
     *  · INSIDE, it rejects roads that are not flyovers at all. Coastal spirals
     *    over itself at t=0.71 with only **8.67 m** between the two decks. The
     *    lower one set `groundPy`, 8.67 > `STACK_V`, so the guard threw out the
     *    deck the player was actually driving on: `roadH` came from a station
     *    11.96 m away instead of 5.23 m, the ground under the upper deck was
     *    stamped 5.7 m BELOW it, and the corridor mask was 12 m off-centre —
     *    which is exactly the 3-of-646 grass leak left over on coastal.
     *  · OUTSIDE, the disc edge is a cliff. Volcano's helix is rejected within
     *    21.5 m of the lava tube and accepted at 21.6 m, so the +38.8 m mesa was
     *    not removed, it was slotted: measured (`.probe-tmp/terrecon.ts`) a
     *    **39.7 m wall with a 17-18 m/m gradient, 13-14 m outside the asphalt
     *    edge**, on 33 of 616 station-sides.
     *
     * Both go away if `groundPy` is the lower envelope of an EMBANKMENT CONE
     * instead: a road may have climbed `STACK_RAMP` metres per metre outside its
     * own asphalt edge, so ground `d` metres from a station could plausibly be as
     * low as `st.py + STACK_RAMP * (d - halfWidth)`. Two decks 8.67 m apart and
     * 20 m apart in plan are then one hillside (allowance 3.9 m + `STACK_V`);
     * a deck 38 m over a tube 3.5 m away in plan cannot be (allowance 0), and is
     * still rejected at every distance out to the full 74 m of influence — so
     * there is no disc edge left to make a cliff at.
     *
     * `STACK_RAMP = 0.45` is a 24° hillside. `STACK_V = 7` on top of it covers
     * what a single carriageway varies by within its own reach (about 3.6 m at
     * volcano's steepest ~15 % grade).
     *
     * WHAT THIS STILL CANNOT DO, measured, so nobody has to rediscover it. A
     * heightfield holds one surface per column, and where a graded, turning road
     * passes over its OWN plan footprint at a height gap SMALLER than `STACK_V`,
     * both passes are legitimately ground and the stamp has to choose. It chooses
     * the plan-nearest, which on the outside of a descending corner is the higher,
     * earlier pass. Volcano t=0.283 is the one place on six circuits where that
     * shows: the texel under the chase eye is 11.50 m from arc 415 (py 45.86) and
     * 13.13 m from arc 427 (py 42.02), so the nearer, 3.8 m higher pass wins and
     * the ground ends up 0.95 m over the drawn shoulder — one pose of 5688 with the
     * eye 0.32 m under the surface (`.probe-tmp/eyedig.ts` prints exactly this).
     * Lowering `STACK_V` to catch it would re-break coastal's 8.67 m spiral, and a
     * "prefer the lower pass within N metres of a tie" rule reintroduces the very
     * class of discontinuity the embankment cone exists to remove. The honest
     * remedies are outside this file: a denser station table
     * (`STATION_SPACING` in Environment, currently ~7 m) shrinks the ambiguous
     * window, and the grade itself is a track-authoring choice.
     */
    const STACK_V = 7;
    const STACK_RAMP = 0.45;
    const groundPy = new Float32Array(n).fill(INF);
    for (let si = 0; si < this.stations.length; si++) {
      const st = this.stations[si];
      // The full influence radius, so the cone has decided the whole region the
      // stamp below can reach and no boundary between the two survives.
      const reach = R;
      const reachTex = Math.ceil(reach / mpt);
      const cx = (st.px - this.originX) / mpt;
      const cz = (st.pz - this.originZ) / mpt;
      const x0 = Math.max(0, Math.floor(cx - reachTex));
      const x1 = Math.min(res - 1, Math.ceil(cx + reachTex));
      const z0 = Math.max(0, Math.floor(cz - reachTex));
      const z1 = Math.min(res - 1, Math.ceil(cz + reachTex));
      for (let ty = z0; ty <= z1; ty++) {
        const ddz = this.originZ + (ty + 0.5) * mpt - st.pz;
        for (let tx = x0; tx <= x1; tx++) {
          const ddx = this.originX + (tx + 0.5) * mpt - st.px;
          const dd2 = ddx * ddx + ddz * ddz;
          if (dd2 > reach * reach) continue;
          const i = ty * res + tx;
          // The embankment cone: inside its own asphalt the road IS the ground,
          // and outside it the ground may have climbed at STACK_RAMP.
          const cand = st.py + STACK_RAMP * Math.max(0, Math.sqrt(dd2) - st.halfWidth);
          if (cand < groundPy[i]) groundPy[i] = cand;
        }
      }
    }

    /**
     * WHERE A BANKED CARRIAGEWAY STOPS BEING A HILLSIDE.
     *
     * `tanBank` arrives clamped to ±0.9 by `Environment.stationFrom()` "so a
     * near-vertical binormal cannot produce a stamped cliff". It stops the cliff
     * and replaces it with a cone. Neon's anti-gravity wall ride is authored
     * `bank: 84` and measures 87-89° over t=0.550-0.587, i.e. a true cross-slope
     * of about 9.5 — so the terrain was stamped at the clamp, 0.9, a 42° slope,
     * and held there dead flat out to 2.2 m past the asphalt edge before blending
     * over 30 m more. That mounds roughly 12 m of dirt up the tower face on the
     * high side and cuts the same depth out of the low side. Measured
     * (`.probe-tmp/terrview.ts`): the lower third of the frame is 100 % ground at
     * the worst right-edge poses, 92 % at p90 over the 58 banked-past-40° poses,
     * up to 96 % of the road-ahead sightlines are hidden by it, and **the chase
     * camera is inside the terrain at 27 of 620 edge poses**. That last one is
     * not a matter of interpretation.
     *
     * A heightfield cannot express a 88° carriageway, and pretending otherwise is
     * worse than declining: there is exactly one height it can honestly put
     * beside a wall, and that is the height of the wall's BASE. So past `WALL_LO`
     * the stamp stops following the bank outward and holds the whole corridor at
     * the carriageway's low edge, `-|halfWidth * tanBank|`, fading in over the
     * remaining range so the bank transition (46° in, 34° out on neon) stays
     * continuous. Below `WALL_LO` — tan 38°, steeper than every genuinely
     * ground-borne bank on the six circuits, the steepest being neon's 25° — this
     * is a no-op and the bowl still follows the road exactly.
     */
    const WALL_LO = 0.78, WALL_HI = 0.90;

    /**
     * THE STAMP WALKS SEGMENTS, NOT STATIONS.
     *
     * Stations are resampled at ~7 m. A nearest-STATION stamp therefore lays down
     * a plane that is piecewise CONSTANT along the road: every texel inside a
     * station's Voronoi cell gets that station's `py`, `tanBank` and `halfWidth`
     * verbatim. On a flat straight that is invisible. Where the road is doing
     * something it is not:
     *
     *  · neon's approach to the wall ride banks 24° -> 31° between two
     *    consecutive stations, and 0.16 of extra cross-slope over 10 m of lateral
     *    offset is 1.6 m of height;
     *  · volcano's t=0.28 corner descends at 14° while turning, and on the INSIDE
     *    of the turn the nearest station in plan is 10 m of arc behind, so its
     *    plane arrives 2.5 m too high.
     *
     * Both were measured as ground standing 1.9-2.5 m proud of the drawn road,
     * and one of them was the last place on any circuit where the chase camera
     * still ended up inside a hill.
     *
     * So each iteration owns the SEGMENT from station `si` to `si+1`, projects the
     * texel onto that chord, and interpolates `py`, `tanBank`, `halfWidth` and the
     * shoulders at the projection parameter. `dist` becomes the true perpendicular
     * distance to the centreline polyline rather than the distance to the nearest
     * sample — which is the same correction `roadVerge()` above exists to make,
     * and for the same reason: the station-point distance OVER-reads by up to a
     * chord half-length, and over-reading `dist` is precisely what licensed grass
     * inside the asphalt. Adjacent segments agree at their shared endpoint, so the
     * field is continuous; the min-distance competition resolves the overlap at
     * corners exactly as `roadVerge` does.
     *
     * Cost is unchanged: one box of texels per segment instead of one per station,
     * and there are as many segments as stations.
     */
    const nSt = this.stations.length;
    for (let si = 0; si < nSt; si++) {
      const a = this.stations[si];
      const b = this.stations[(si + 1) % nSt];
      /**
       * The vertical profile is interpolated with a CUBIC, not the chord.
       *
       * Linear interpolation along the chord is exact for `halfWidth` and good
       * enough for `tanBank`, but the road's HEIGHT is a curve, and a chord cuts
       * across it: in a compression the chord runs above the real surface, and the
       * terrain follows the chord. Volcano's t=0.28 is the steepest thing on any
       * circuit — a 44° grade — where 7 m of station spacing is 4.9 m of vertical
       * travel, and the chord error there was measured at 1.98 m of ground standing
       * on the drawn shoulder, which was also the last place the chase camera still
       * ended up under the surface.
       *
       * Catmull-Rom through the two neighbouring stations restores the curvature
       * for four extra loads. It is clamped to the four control heights: a cubic
       * through unevenly-spaced samples can overshoot, and an overshoot here would
       * be a spike of terrain, which is the defect this whole pass exists to remove.
       */
      const a0 = this.stations[(si - 1 + nSt) % nSt];
      const b1 = this.stations[(si + 2) % nSt];
      const pyLo = Math.min(a0.py, a.py, b.py, b1.py);
      const pyHi = Math.max(a0.py, a.py, b.py, b1.py);
      const c0 = a.py;
      const c1 = 0.5 * (b.py - a0.py);
      const c2 = 0.5 * (2 * a0.py - 5 * a.py + 4 * b.py - b1.py);
      const c3 = 0.5 * (-a0.py + 3 * a.py - 3 * b.py + b1.py);
      const ex = b.px - a.px, ez = b.pz - a.pz;
      const segLen2 = ex * ex + ez * ez;
      if (segLen2 < 1e-9) continue;
      const invSeg = 1 / segLen2;
      const aShL = a.shoulderL ?? SH_FALLBACK, aShR = a.shoulderR ?? SH_FALLBACK;
      const bShL = b.shoulderL ?? SH_FALLBACK, bShR = b.shoulderR ?? SH_FALLBACK;
      // Texel box: the whole segment, plus the influence radius.
      const loX = Math.min(a.px, b.px) - R, hiX = Math.max(a.px, b.px) + R;
      const loZ = Math.min(a.pz, b.pz) - R, hiZ = Math.max(a.pz, b.pz) + R;
      const x0 = Math.max(0, Math.floor((loX - this.originX) / mpt));
      const x1 = Math.min(res - 1, Math.ceil((hiX - this.originX) / mpt));
      const z0 = Math.max(0, Math.floor((loZ - this.originZ) / mpt));
      const z1 = Math.min(res - 1, Math.ceil((hiZ - this.originZ) / mpt));
      for (let ty = z0; ty <= z1; ty++) {
        const wz = this.originZ + (ty + 0.5) * mpt;
        for (let tx = x0; tx <= x1; tx++) {
          const wx = this.originX + (tx + 0.5) * mpt;
          // Nearest point on the chord.
          let u = ((wx - a.px) * ex + (wz - a.pz) * ez) * invSeg;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const qx = a.px + ex * u, qz = a.pz + ez * u;
          const ddx = wx - qx, ddz = wz - qz;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > R * R) continue;
          const i = ty * res + tx;
          const d = Math.sqrt(d2);
          const hwI = a.halfWidth + (b.halfWidth - a.halfWidth) * u;
          // Plan-space corridor first, and deliberately BEFORE both rejections:
          // the grass mask asks where a road is DRAWN, not which road made the
          // ground. See `maskDist`.
          if (d < maskDist[i]) { maskDist[i] = d; maskHalfW[i] = hwI; }
          if (d >= dist[i]) continue;
          let pyI = c0 + u * (c1 + u * (c2 + u * c3));
          pyI = pyI < pyLo ? pyLo : pyI > pyHi ? pyHi : pyI;
          // A carriageway flying over a lower one does not pave the ground.
          if (pyI > groundPy[i] + STACK_V) continue;
          dist[i] = d;
          // Interpolated frame. The binormal is renormalised because lerping two
          // unit vectors shortens the result, and `cross` is a distance.
          let bxI = a.bx + (b.bx - a.bx) * u;
          let bzI = a.bz + (b.bz - a.bz) * u;
          const bl = Math.hypot(bxI, bzI);
          if (bl > 1e-6) { bxI /= bl; bzI /= bl; } else { bxI = a.bx; bzI = a.bz; }
          const cross = ddx * bxI + ddz * bzI;
          const sh = cross < 0
            ? aShL + (bShL - aShL) * u
            : aShR + (bShR - aShR) * u;
          const tbI = a.tanBank + (b.tanBank - a.tanBank) * u;
          const atb = Math.abs(tbI);
          const wall = atb <= WALL_LO ? 0 : smootherstep((atb - WALL_LO) / (WALL_HI - WALL_LO));
          // Depth of the carriageway's LOW edge below the centreline. Past the
          // clamp the true cross-slope is unknown but at least 42°, and neon's
          // wall ride measures 84-89°, so at full gate the low edge is essentially
          // the whole drawn half-width straight down — 12.75 m there. Taking the
          // shallower `halfWidth * tanBank` instead left the shelf 3.4 m up the
          // wall, standing on the bottom of the carriageway
          // (`.probe-tmp/terrecon.ts` reported on-road +3.56 m).
          const corridorW = hwI + KERB_W + Math.max(aShL, aShR, bShL, bShR);
          const shallow = atb * hwI;
          const lowEdge = -(shallow + wall * (corridorW - shallow));
          const lift = cross * tbI;
          // Terrain target: the DRAWN surface, not the bare banked plane.
          roadH[i] = pyI + lift + (lowEdge - lift) * wall
            + roadSurfaceOffset(Math.abs(cross), hwI, sh);
          halfW[i] = hwI;
          flatW[i] = hwI + KERB_W + sh + FLAT_PAD;
        }
      }
    }

    // ---- height + road blend ------------------------------------------------
    const SINK = 0.16;   // terrain sits this far under the road surface
    /**
     * Metres past the ASPHALT edge that the surfacing SDF calls "the road edge".
     * This is a material boundary, not a height one: the dirt/wear bands in
     * Terrain's fragment shader are measured from it. Deliberately unchanged at
     * 2.2 m while the HEIGHT blend moved out to the drawn shoulder — they used to
     * share one number, and widening the shared one would have dragged the whole
     * dirt transition 5 m outboard on every circuit.
     */
    const SDF_INNER = 2.2;
    const BAND = 30.0;   // blend distance back to natural terrain
    const edgeSdf = new Float32Array(n);
    let lo = INF, hi = -INF;
    for (let ty = 0; ty < res; ty++) {
      const wz = this.originZ + (ty + 0.5) * mpt;
      for (let tx = 0; tx < res; tx++) {
        const wx = this.originX + (tx + 0.5) * mpt;
        const i = ty * res + tx;
        let h = this.naturalHeightAt(wx, wz);
        const d = dist[i];
        let sdf = -EDGE_RANGE;
        if (d < INF) {
          // Wander the corridor edge at two scales. Without this the edge is an
          // exact constant offset of the centreline, so both the flat-shoulder
          // boundary *and* the surfacing transition that follows it are perfectly
          // parallel to the road — the straight chain of vertices the review
          // flagged. ±3 m of wander over ~12 m and ~48 m features breaks the
          // silhouette while changing off-road height by at most a few cm (the
          // blend runs over 30 m, so the weight barely moves).
          const wander =
            (fbm2D(wx * 0.085, wz * 0.085, 2, this.seed + 404) - 0.5) * 2.6 +
            (fbm2D(wx * 0.021, wz * 0.021, 2, this.seed + 811) - 0.5) * 3.4;
          sdf = halfW[i] + SDF_INNER + wander - d;
          // The flat band now ends past the drawn SHOULDER, not 2.2 m past the
          // asphalt. It used to end 4.4-7.5 m inside the road that gets drawn, so
          // the terrain started climbing away from the road surface while still
          // underneath the shoulder mesh: measured on coastal the ground was up to
          // 1.9 m BELOW the road plane at the shoulder's outer edge (a mesh
          // overhanging a void) and on neon up to 3.9 m ABOVE it (a bank of dirt
          // standing where the verge should be). Same wander, so the boundary is
          // still irregular rather than an exact offset of the centreline.
          const w = 1 - smootherstep((d - (flatW[i] + wander)) / BAND);
          if (w > 0) h = h + (roadH[i] - SINK - h) * w;
        }
        this.height[i] = h;
        edgeSdf[i] = sdf;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    this.minHeight = lo;
    this.maxHeight = hi;

    // ---- surfacing field ----------------------------------------------------
    // R is the signed distance above; G is concavity at ~29 m, which is what
    // makes dirt collect in hollows and dry aggregate sit on ridges. That kind of
    // macro variation reads at any distance, unlike a tiled texture, and it is
    // far too wide a kernel to evaluate per fragment.
    const wide = boxBlur(this.height, res, Math.max(3, Math.round(29 / mpt)));
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      this.edge[o] = (clamp01(0.5 + edgeSdf[i] / (2 * EDGE_RANGE)) * 255) | 0;
      this.edge[o + 1] = (clamp01(0.5 + (wide[i] - this.height[i]) * 0.055) * 255) | 0;
      this.edge[o + 2] = 0;
      this.edge[o + 3] = 255;
    }

    // ---- data channels ------------------------------------------------------
    // AO from a wide box blur of the height field: concavity darkens.
    const blur = boxBlur(this.height, res, Math.max(2, Math.round(11 / mpt)));
    for (let ty = 0; ty < res; ty++) {
      const wz = this.originZ + (ty + 0.5) * mpt;
      for (let tx = 0; tx < res; tx++) {
        const wx = this.originX + (tx + 0.5) * mpt;
        const i = ty * res + tx;
        const h = this.height[i];
        const d = dist[i];
        // The grass mask reads the PLAN-space corridor, guard-free; everything
        // else here reads the grounded one. See `maskDist`.
        const mDist = maskDist[i];
        const mHw = maskHalfW[i] || 11;

        // GRASS KILL MASK. `data.r` has exactly one consumer — the blade shader
        // in Foliage.ts, which keeps a blade when `rnd·0.92 < (1 − mask)·…`. So
        // wherever this is below 1, *some* blades live, and the innermost lateral
        // offset at which that happens is where grass grows through the tarmac.
        //
        // It used to be `clamp01((hw + 2.6 − d) / 3.4)`, saturated only out to
        // `d <= hw − 0.8`: blades were licensed from 0.8 m INSIDE the asphalt
        // edge outward. Worse, `d` is the distance to the nearest centreline
        // *station* (~7 m spacing), which over-reads the perpendicular distance,
        // and a 3.4 m ramp baked at 2.4–5.0 m per texel is under two texels wide,
        // so bilinear reconstruction smears it several metres further in.
        // Measured (`.probe-tmp/edgeview.ts`): blades could live up to 10.5 m
        // inside the asphalt edge, on 646 of 646 station-sides on coastal and on
        // every station-side of four other circuits. That is the owner's
        // "ground-level decorations interfere with the track visuals", present on
        // every metre of every lap.
        //
        // So the plateau now runs past the KERB, plus one texel of guard band —
        // the leak is a bake-resolution artefact, so the margin is sized by the
        // bake resolution rather than by a constant that silently stops working
        // when the tier changes `metresPerTexel` from 2.4 to 5.0.
        const grassPlateau = mHw + KERB_W + mpt;
        const roadMask = mDist < INF
          ? clamp01((grassPlateau + GRASS_RAMP - mDist) / GRASS_RAMP) : 0;
        const ao = clamp01(1 - (blur[i] - h) * 0.085);
        const moist = clamp01(
          fbm2D(wx * 0.0034, wz * 0.0034, 4, this.seed + 1201) * 1.25 - 0.12,
        );
        // Rock shows where it is steep or high.
        const gx = this.height[ty * res + Math.min(res - 1, tx + 1)] - this.height[ty * res + Math.max(0, tx - 1)];
        const gz = this.height[Math.min(res - 1, ty + 1) * res + tx] - this.height[Math.max(0, ty - 1) * res + tx];
        const slope = Math.hypot(gx, gz) / (2 * mpt);
        const rock = clamp01(
          smootherstep((slope - 0.34) / 0.5) * 0.85 +
          fbm2D(wx * 0.006, wz * 0.006, 3, this.seed + 77) * 0.3 - 0.1,
        );

        const o = i * 4;
        this.data[o] = (roadMask * 255) | 0;
        this.data[o + 1] = (ao * 255) | 0;
        this.data[o + 2] = (moist * 255) | 0;
        this.data[o + 3] = (rock * 255) | 0;
      }
    }
    void extent;
  }

  // --- CPU sampling ----------------------------------------------------------

  /** Bilinear height, metres. Falls back to the analytic field outside the bake. */
  heightAt(x: number, z: number): number {
    const fx = (x - this.originX) / this.metresPerTexel - 0.5;
    const fz = (z - this.originZ) / this.metresPerTexel - 0.5;
    if (fx < 0 || fz < 0 || fx >= this.res - 1 || fz >= this.res - 1) {
      return this.naturalHeightAt(x, z);
    }
    const x0 = fx | 0, z0 = fz | 0;
    const tx = fx - x0, tz = fz - z0;
    const r = this.res;
    const h00 = this.height[z0 * r + x0];
    const h10 = this.height[z0 * r + x0 + 1];
    const h01 = this.height[(z0 + 1) * r + x0];
    const h11 = this.height[(z0 + 1) * r + x0 + 1];
    return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = this.metresPerTexel;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  /** Slope in radians from vertical (0 = flat). */
  slopeAt(x: number, z: number): number {
    const e = this.metresPerTexel;
    const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.atan(Math.hypot(gx, gz));
  }

  private nearestTexel(x: number, z: number): number {
    const tx = Math.round((x - this.originX) / this.metresPerTexel - 0.5);
    const tz = Math.round((z - this.originZ) / this.metresPerTexel - 0.5);
    if (tx < 0 || tz < 0 || tx >= this.res || tz >= this.res) return -1;
    return tz * this.res + tx;
  }

  /**
   * Metres to the CENTRELINE, perpendicular to the nearest chord. Large when off
   * the map. NEAREST-TEXEL, so it quantises to `metresPerTexel`; and it is the
   * centreline, not the road edge — `roadVerge()` is the function for that.
   */
  roadDistanceAt(x: number, z: number): number {
    const i = this.nearestTexel(x, z);
    return i < 0 ? INF : this.roadDistance[i];
  }

  aoAt(x: number, z: number): number {
    const i = this.nearestTexel(x, z);
    return i < 0 ? 1 : this.data[i * 4 + 1] / 255;
  }

  moistureAt(x: number, z: number): number {
    const i = this.nearestTexel(x, z);
    return i < 0 ? 0.5 : this.data[i * 4 + 2] / 255;
  }

  rockAt(x: number, z: number): number {
    const i = this.nearestTexel(x, z);
    return i < 0 ? 0 : this.data[i * 4 + 3] / 255;
  }

  dispose(): void {
    this.heightTex.dispose();
    this.dataTex.dispose();
    this.edgeTex.dispose();
  }
}

function boxBlur(src: Float32Array, res: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const inv = 1 / (r * 2 + 1);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k < 0 ? 0 : x + k >= res ? res - 1 : x + k;
        s += src[y * res + xx];
      }
      tmp[y * res + x] = s * inv;
    }
  }
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k < 0 ? 0 : y + k >= res ? res - 1 : y + k;
        s += tmp[yy * res + x];
      }
      out[y * res + x] = s * inv;
    }
  }
  return out;
}

/** IEEE754 float32 → float16 bits. */
function floatToHalf(v: number, dv: DataView): number {
  dv.setFloat32(0, v);
  const x = dv.getUint32(0);
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let man = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (man ? 0x200 : 0);
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    man = man | 0x800000;
    const shift = 14 - exp;
    return sign | (man >> shift);
  }
  return sign | (exp << 10) | (man >> 13);
}

// ---------------------------------------------------------------------------
// GLSL: sampling the terrain field from any shader
// ---------------------------------------------------------------------------

/**
 * Requires uniforms `uFieldHeight`, `uFieldData`, `uFieldXform`
 * (= vec4(originX, originZ, 1/extent, metresPerTexel)).
 */
export const GLSL_FIELD = /* glsl */ `
uniform sampler2D uFieldHeight;
uniform sampler2D uFieldData;
uniform vec4 uFieldXform;
vec2 fieldUv(vec2 wxz){ return (wxz - uFieldXform.xy) * uFieldXform.z; }
float fieldHeight(vec2 wxz){ return texture2D(uFieldHeight, fieldUv(wxz)).r; }
vec4  fieldData(vec2 wxz){ return texture2D(uFieldData, fieldUv(wxz)); }
vec3 fieldNormal(vec2 wxz, float e){
  float hl = fieldHeight(wxz - vec2(e, 0.0));
  float hr = fieldHeight(wxz + vec2(e, 0.0));
  float hd = fieldHeight(wxz - vec2(0.0, e));
  float hu = fieldHeight(wxz + vec2(0.0, e));
  return normalize(vec3(hl - hr, 2.0 * e, hd - hu));
}
`;

/**
 * Soft heightfield self-shadowing: march the terrain toward the sun and widen
 * the penumbra with distance. Eight taps buys long, believable hill shadows at
 * sunset without spending a shadow cascade on the ground.
 * Requires GLSL_FIELD and a `uSunDirection` uniform.
 */
export const GLSL_FIELD_SHADOW = /* glsl */ `
float fieldShadow(vec3 wp, vec3 sd){
  if (sd.y <= 0.012) return 0.18;
  float occ = 0.0;
  float s = 2.5;
  for (int i = 0; i < 8; i++) {
    vec3 q = wp + sd * s;
    float h = fieldHeight(q.xz);
    occ = max(occ, (h - q.y) / (2.2 + s * 0.34));
    s *= 1.82;
  }
  occ = clamp(occ, 0.0, 1.0);
  return 1.0 - occ * occ * (3.0 - 2.0 * occ);
}
`;

/**
 * Distance-adaptive `fieldShadow`. Identical to the eight-tap version inside
 * `near` metres; beyond that it covers the same distance toward the sun in four
 * taps with a wider step, which is indistinguishable once a pixel is a hundred
 * metres away and halves the fetch count over most of a 900 m ground plane.
 *
 * Requires GLSL_FIELD and a `uSunDirection` uniform. Declares `fieldShadow` too,
 * so it is a drop-in replacement for GLSL_FIELD_SHADOW.
 */
export const GLSL_FIELD_SHADOW_LOD = /* glsl */ `
float fieldShadowLod(vec3 wp, vec3 sd, float dist, float near){
  if (sd.y <= 0.012) return 0.18;
  bool hi = dist < near;
  int n = hi ? 8 : 4;
  float mul = hi ? 1.82 : 3.31;
  float occ = 0.0;
  float s = 2.5;
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    vec3 q = wp + sd * s;
    float h = fieldHeight(q.xz);
    occ = max(occ, (h - q.y) / (2.2 + s * 0.34));
    s *= mul;
  }
  occ = clamp(occ, 0.0, 1.0);
  return 1.0 - occ * occ * (3.0 - 2.0 * occ);
}
float fieldShadow(vec3 wp, vec3 sd){ return fieldShadowLod(wp, sd, 0.0, 1.0); }
`;

/**
 * Four-tap variant of `fieldShadow`, for surfaces that cover a lot of screen but
 * whose shadow term is a broad wash rather than a read: grass blades, mostly.
 * The march step is widened to cover the same distance in half the taps, which
 * softens the penumbra — on grass that is an improvement, not a loss.
 */
export const GLSL_FIELD_SHADOW_LOW = /* glsl */ `
float fieldShadow(vec3 wp, vec3 sd){
  if (sd.y <= 0.012) return 0.18;
  float occ = 0.0;
  float s = 3.2;
  for (int i = 0; i < 4; i++) {
    vec3 q = wp + sd * s;
    float h = fieldHeight(q.xz);
    occ = max(occ, (h - q.y) / (2.6 + s * 0.34));
    s *= 3.1;
  }
  occ = clamp(occ, 0.0, 1.0);
  return 1.0 - occ * occ * (3.0 - 2.0 * occ);
}
`;

/**
 * Road-edge signed distance + wide concavity. Separate from GLSL_FIELD so that
 * only the materials that want it (Terrain) declare the extra sampler — Foliage
 * and Water are untouched.
 *
 * `roadEdgeMetres` is positive inside the road corridor, negative outside, in
 * metres, saturating at ±EDGE_RANGE. Sample it in the *vertex* shader and
 * interpolate: it is a distance field baked at 2.4 m per texel and the terrain
 * grid is finer than that near the camera, so the interpolant is exact where it
 * matters and free in the fragment shader.
 */
export const GLSL_FIELD_EDGE = /* glsl */ `
uniform sampler2D uFieldEdge;
vec2 fieldEdgeRaw(vec2 wxz){ return texture2D(uFieldEdge, fieldUv(wxz)).rg; }
float roadEdgeMetres(vec2 wxz){ return (texture2D(uFieldEdge, fieldUv(wxz)).r - 0.5) * ${(EDGE_RANGE * 2).toFixed(1)}; }
`;

export interface FieldUniforms {
  uFieldHeight: { value: THREE.Texture | null };
  uFieldData: { value: THREE.Texture | null };
  uFieldXform: { value: THREE.Vector4 };
}

export function fieldUniforms(field: TerrainField | null): FieldUniforms {
  return {
    uFieldHeight: { value: field ? field.heightTex : null },
    uFieldData: { value: field ? field.dataTex : null },
    uFieldXform: {
      value: new THREE.Vector4(
        field ? field.originX : 0,
        field ? field.originZ : 0,
        field ? 1 / field.extent : 0,
        field ? field.metresPerTexel : 1,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Extra procedural surfaces used by water / weather / props
// ---------------------------------------------------------------------------

/** Two-scale water normal + a foam mask packed in alpha. */
export function makeWaterNormal(size = 256): THREE.DataTexture {
  const h = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv, v = y * inv;
      h[y * size + x] = fbmTile(u, v, 8, 4, 4409) * 0.7 + fbmTile(u, v, 23, 3, 8821) * 0.3;
    }
  }
  return heightToNormal(h, size, size, 1.9);
}

/** Animated-looking foam: cellular streaks that read as churn. */
export function makeFoam(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv, v = y * inv;
      const a = fbmTile(u, v, 6, 4, 151);
      const b = fbmTile(u, v, 14, 3, 907);
      const c = fbmTile(u, v, 30, 2, 3301);
      const i = (y * size + x) * 4;
      data[i] = (clamp01(Math.pow(a, 1.6) * 1.5) * 255) | 0;
      data[i + 1] = (clamp01(Math.pow(b, 1.4) * 1.4) * 255) | 0;
      data[i + 2] = (clamp01(c) * 255) | 0;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Voronoi-ish caustic web, tiling. */
export function makeCaustics(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  const cells = 9;
  const pts: number[] = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      pts.push((cx + ihash(cx, cy, 3) * 0.9) / cells, (cy + ihash(cx, cy, 7) * 0.9) / cells);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv, v = y * inv;
      let d1 = 9, d2 = 9;
      for (let p = 0; p < pts.length; p += 2) {
        let dx = Math.abs(pts[p] - u); if (dx > 0.5) dx = 1 - dx;
        let dy = Math.abs(pts[p + 1] - v); if (dy > 0.5) dy = 1 - dy;
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      const edge = Math.sqrt(d2) - Math.sqrt(d1);
      const c = clamp01(1 - edge * 14);
      const i = (y * size + x) * 4;
      const val = (Math.pow(c, 2.2) * 255) | 0;
      data[i] = val; data[i + 1] = val; data[i + 2] = val; data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Chunked instance culling
// ---------------------------------------------------------------------------

/**
 * Per-chunk culling for a static `InstancedMesh`.
 *
 * Culling *per instance* on the GPU (collapse the vertices to a point) saves
 * fragments but still pays the vertex shader and still counts every triangle.
 * Culling per *object* is useless when one InstancedMesh covers a 700 m field —
 * its bounding sphere always contains the camera.
 *
 * So: bucket the instances into a coarse XZ grid once at build time, keep a
 * pristine copy of their matrices, and each frame repack only the visible
 * buckets into the front of `instanceMatrix` and set `mesh.count`. Draw calls
 * stay at one per type, triangles drop to what is actually on screen.
 *
 * The visible bucket set is hashed, so a camera that hasn't crossed a chunk
 * boundary costs one pass over the chunk list and no buffer upload at all.
 *
 * Zero allocation after construction.
 */
export class InstanceChunks {
  readonly mesh: THREE.InstancedMesh;
  /** Distance beyond which a chunk is not drawn at all. */
  cull: number;
  /** Frustum-test as well as distance-test. Leave off for shadow casters. */
  useFrustum: boolean;

  private src: Float32Array;
  private starts: Int32Array;
  private counts: Int32Array;
  private cx: Float32Array;
  private cy: Float32Array;
  private cz: Float32Array;
  private cr: Float32Array;
  /** One pre-made view per chunk, so the per-frame repack allocates nothing. */
  private views: Float32Array[] = [];
  /** Chunk-sorted slot -> original instance index. Needed by `track()`. */
  private order: Int32Array;
  /** Companion per-instance attributes, repacked in lockstep. */
  private extras: TrackedAttribute[] = [];
  /** Visible chunk ids for this frame, reused every call. */
  private live: Int32Array;
  private liveCount = 0;
  private chunks: number;
  private signature = -1;
  private visible = 0;

  constructor(
    mesh: THREE.InstancedMesh,
    points: ArrayLike<{ x: number; y: number; z: number }>,
    cull: number,
    chunkSize = 56,
    useFrustum = true,
  ) {
    this.mesh = mesh;
    this.cull = cull;
    this.useFrustum = useFrustum;

    const n = Math.min(mesh.count, points.length);
    const raw = mesh.instanceMatrix.array as Float32Array;

    // --- bucket by grid cell ------------------------------------------------
    const key = new Map<number, number>();
    const cellOf = new Int32Array(n);
    let chunks = 0;
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(points[i].x / chunkSize);
      const gz = Math.floor(points[i].z / chunkSize);
      const k = gx * 73856093 ^ gz * 19349663;
      let c = key.get(k);
      if (c === undefined) { c = chunks++; key.set(k, c); }
      cellOf[i] = c;
    }

    this.chunks = chunks;
    this.starts = new Int32Array(chunks);
    this.counts = new Int32Array(chunks);
    this.cx = new Float32Array(chunks);
    this.cy = new Float32Array(chunks);
    this.cz = new Float32Array(chunks);
    this.cr = new Float32Array(chunks);
    for (let i = 0; i < n; i++) this.counts[cellOf[i]]++;
    let acc = 0;
    for (let c = 0; c < chunks; c++) { this.starts[c] = acc; acc += this.counts[c]; }

    // --- sort matrices into chunk order ------------------------------------
    this.src = new Float32Array(n * 16);
    this.order = new Int32Array(n);
    this.live = new Int32Array(chunks);
    const cursor = new Int32Array(chunks);
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      const slot = this.starts[c] + cursor[c];
      cursor[c]++;
      this.order[slot] = i;
      for (let k = 0; k < 16; k++) this.src[slot * 16 + k] = raw[i * 16 + k];
    }

    // --- chunk bounds -------------------------------------------------------
    for (let c = 0; c < chunks; c++) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity;
      let maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      const s = this.starts[c], e = s + this.counts[c];
      for (let i = s; i < e; i++) {
        const x = this.src[i * 16 + 12], y = this.src[i * 16 + 13], z = this.src[i * 16 + 14];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      this.cx[c] = (minX + maxX) * 0.5;
      this.cy[c] = (minY + maxY) * 0.5;
      this.cz[c] = (minZ + maxZ) * 0.5;
      // Half-diagonal plus headroom for the tallest thing an instance can be.
      this.cr[c] = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) + 18;
      this.views.push(this.src.subarray(s * 16, e * 16));
    }

    // Start with everything on, so a mesh whose camera never arrives still draws.
    raw.set(this.src);
    mesh.instanceMatrix.needsUpdate = true;
    this.visible = n;
    mesh.count = n;
  }

  get total(): number { return this.src.length / 16; }
  get drawnInstances(): number { return this.visible; }
  get visibleChunks(): number { return this.liveCount; }
  get chunkCount(): number { return this.chunks; }

  /**
   * Register a per-instance attribute so it is repacked in the same order as the
   * matrices. Without this, culling would scramble every instance's phase, arc,
   * colour or atlas cell — the wave would cheer in the wrong order and shirts
   * would swap between people as the camera moved.
   */
  track(attr: THREE.InstancedBufferAttribute | undefined | null): this {
    if (!attr) return this;
    const item = attr.itemSize;
    const raw = attr.array as Float32Array;
    const n = this.order.length;
    const src = new Float32Array(n * item);
    for (let slot = 0; slot < n; slot++) {
      const from = this.order[slot] * item;
      const to = slot * item;
      for (let k = 0; k < item; k++) src[to + k] = raw[from + k];
    }
    const views: Float32Array[] = [];
    for (let c = 0; c < this.chunks; c++) {
      const s = this.starts[c] * item;
      const e = s + this.counts[c] * item;
      views.push(src.subarray(s, e));
    }
    raw.set(src);
    attr.needsUpdate = true;
    this.extras.push({ attr, item, views });
    return this;
  }

  /**
   * Repack for `camera`. Call once per frame from `update()`, never from a draw
   * callback.
   */
  cullTo(camera: THREE.PerspectiveCamera): void {
    const px = camera.position.x, py = camera.position.y, pz = camera.position.z;
    const cull = this.cull;

    if (this.useFrustum) {
      _chunkMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _chunkFrustum.setFromProjectionMatrix(_chunkMat);
    }

    // Single pass: collect the visible chunk ids and hash them.
    let sig = 17;
    let live = 0;
    for (let c = 0; c < this.chunks; c++) {
      const r = this.cr[c];
      const dx = this.cx[c] - px, dy = this.cy[c] - py, dz = this.cz[c] - pz;
      let on = Math.sqrt(dx * dx + dy * dy + dz * dz) - r <= cull;
      if (on && this.useFrustum) {
        _chunkSphere.center.set(this.cx[c], this.cy[c], this.cz[c]);
        _chunkSphere.radius = r;
        on = _chunkFrustum.intersectsSphere(_chunkSphere);
      }
      if (!on) continue;
      this.live[live++] = c;
      sig = (sig * 31 + c + 1) | 0;
    }
    this.liveCount = live;
    // Nothing crossed a chunk boundary — no repack, no upload.
    if (sig === this.signature) return;
    this.signature = sig;

    const raw = this.mesh.instanceMatrix.array as Float32Array;
    let write = 0;
    for (let i = 0; i < live; i++) {
      const c = this.live[i];
      raw.set(this.views[c], write * 16);
      write += this.counts[c];
    }
    for (const x of this.extras) {
      const dst = x.attr.array as Float32Array;
      let w = 0;
      for (let i = 0; i < live; i++) {
        const c = this.live[i];
        dst.set(x.views[c], w * x.item);
        w += this.counts[c];
      }
      if (w > 0) x.attr.needsUpdate = true;
    }

    this.visible = write;
    this.mesh.count = write;
    if (write > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

interface TrackedAttribute {
  attr: THREE.InstancedBufferAttribute;
  item: number;
  views: Float32Array[];
}

const _chunkFrustum = new THREE.Frustum();
const _chunkMat = new THREE.Matrix4();
const _chunkSphere = new THREE.Sphere();

// ---------------------------------------------------------------------------

export function disposeMaterial(m: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(m)) { m.forEach(disposeMaterial); return; }
  m.dispose();
}

/** Recursively dispose geometries + materials under a root. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) disposeMaterial(mesh.material);
  });
  root.parent?.remove(root);
}
