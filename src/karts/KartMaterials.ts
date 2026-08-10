/**
 * ============================================================================
 *  APEX KART — KART MATERIAL + TEXTURE LIBRARY
 * ============================================================================
 *  Everything here is generated procedurally at runtime (canvas 2D / typed
 *  arrays). Zero network requests, zero external assets.
 *
 *  If `src/render/MaterialFactory.ts` / `TextureFactory.ts` land later, the
 *  integration pass can swap the private texture builders below for the shared
 *  ones — the public surface of this module (`KartMaterialLibrary`) is what the
 *  rest of the kart subsystem depends on.
 *
 *  Design notes that matter for the look:
 *   - Car paint is `MeshPhysicalMaterial` with clearcoat 1.0 / clearcoatRoughness
 *     0.06 and a metallic-flake normal wired to `clearcoatNormalMap`. That is
 *     the single biggest difference between "toy car" and "coloured plastic".
 *   - Every material has `vertexColors: true` so the baked-AO vertex colours
 *     from KartBodies darken crevices for free.
 *   - Emissive parts are tagged onto LAYERS.BLOOM by the caller.
 * ============================================================================
 */

import * as THREE from 'three';
import type { QualitySettings } from '@/core/Types';

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * A material "slot" is a stable name that geometry builders tag their parts
 * with. The library resolves a slot + a character colour pair into a concrete
 * material, so a whole kart is a handful of draw calls.
 */
export type MaterialSlot =
  | 'paint'        // primary car paint (character colour)
  | 'paint2'       // secondary car paint (accent colour)
  | 'chrome'       // polished chrome
  | 'metal'        // dark brushed / anodised metal
  | 'plastic'      // matte structural plastic
  | 'rubber'       // tyres, grips, mud flaps
  | 'glass'        // windscreens, visors, light lenses
  | 'lightFront'   // emissive headlight
  | 'lightRear'    // emissive tail light (brightens on brake)
  | 'glow'         // emissive accent / thruster / drift charge
  | 'seat'         // stitched upholstery
  | 'skin'         // driver skin
  | 'cloth'        // driver suit primary
  | 'clothAlt'     // driver suit secondary
  | 'face';        // driver face atlas

export const ALL_SLOTS: readonly MaterialSlot[] = [
  'paint', 'paint2', 'chrome', 'metal', 'plastic', 'rubber', 'glass',
  'lightFront', 'lightRear', 'glow', 'seat', 'skin', 'cloth', 'clothAlt', 'face',
];

/** Slots that must be registered on the bloom layer. */
export const EMISSIVE_SLOTS: readonly MaterialSlot[] = ['lightFront', 'lightRear', 'glow'];

// ---------------------------------------------------------------------------
// The material atlas
// ---------------------------------------------------------------------------

/**
 * A kart authored as one mesh per slot is ~60 draw calls. That is far too many
 * when twelve of them are on screen, so everything except the player's chassis
 * is *consolidated*: the per-slot geometries are merged into one buffer and each
 * part's `uv` is rewritten to point at its slot's column in a 16×2 atlas.
 *
 * The atlas carries albedo, roughness (`.g`), metalness (`.b`), clearcoat (`.x`),
 * clearcoat roughness (`.y`) and emissive, so a single `MeshPhysicalMaterial`
 * still gives every part its own surface response. The only thing lost versus a
 * real per-slot material is the tiling normal map — which is exactly the detail
 * you cannot see past ten metres.
 *
 * Column order is `ALL_SLOTS`; `atlasUv()` is the one place that mapping lives.
 */
export const ATLAS_COLS = 16;

const SLOT_COLUMN: Readonly<Record<MaterialSlot, number>> = Object.freeze(
  Object.fromEntries(ALL_SLOTS.map((s, i) => [s, i])) as Record<MaterialSlot, number>,
);

/** Texel-centre u for a slot's atlas column. `v` is always 0.5. */
export function atlasUv(slot: MaterialSlot): number {
  return (SLOT_COLUMN[slot] + 0.5) / ATLAS_COLS;
}

/** Surface response per slot, as it goes into the atlas. */
interface AtlasEntry {
  /** Albedo; `undefined` means "take it from the paint spec" (handled below). */
  color: number;
  roughness: number;
  metalness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  emissive?: number;
}

function atlasEntries(spec: PaintSpec): Record<MaterialSlot, AtlasEntry> {
  const glow = new THREE.Color(spec.glow ?? spec.secondary).getHex();
  const matte = spec.matte === true;
  const paintRough = matte ? 0.55 : 0.30;
  const paintCc = matte ? 0.35 : 1.0;
  const paintCcR = matte ? 0.40 : 0.13;
  const flake = spec.flake ?? 0.55;
  return {
    paint: {
      color: new THREE.Color(spec.color).getHex(),
      roughness: paintRough, metalness: matte ? 0.05 : 0.10 + flake * 0.16,
      clearcoat: paintCc, clearcoatRoughness: paintCcR,
    },
    paint2: {
      color: new THREE.Color(spec.secondary).getHex(),
      roughness: paintRough, metalness: matte ? 0.05 : 0.10 + flake * 0.11,
      clearcoat: paintCc, clearcoatRoughness: paintCcR,
    },
    chrome: { color: 0xf2f4f8, roughness: 0.075, metalness: 1.0, clearcoat: 0, clearcoatRoughness: 0 },
    metal: { color: 0x3d434c, roughness: 0.42, metalness: 0.92, clearcoat: 0, clearcoatRoughness: 0 },
    plastic: { color: 0x1c1f25, roughness: 0.44, metalness: 0.0, clearcoat: 0.25, clearcoatRoughness: 0.35 },
    // No tyre atlas here, so pick the albedo the atlas averages out to.
    rubber: { color: 0x2a2826, roughness: 0.88, metalness: 0.0, clearcoat: 0, clearcoatRoughness: 0 },
    // Opaque at distance — a merged mesh cannot sort against itself.
    glass: { color: 0x0d1219, roughness: 0.045, metalness: 0.1, clearcoat: 1.0, clearcoatRoughness: 0.02 },
    lightFront: { color: 0xfff3d8, roughness: 0.12, metalness: 0, clearcoat: 0, clearcoatRoughness: 0, emissive: 0xfff0cc },
    lightRear: { color: 0x5a0d10, roughness: 0.18, metalness: 0, clearcoat: 0, clearcoatRoughness: 0, emissive: 0xff2a1a },
    glow: { color: glow, roughness: 0.3, metalness: 0, clearcoat: 0, clearcoatRoughness: 0, emissive: glow },
    seat: { color: 0x2a2c31, roughness: 0.62, metalness: 0, clearcoat: 0, clearcoatRoughness: 0 },
    skin: { color: new THREE.Color(spec.skin ?? 0xf0c39a).getHex(), roughness: 0.68, metalness: 0, clearcoat: 0.18, clearcoatRoughness: 0.6 },
    cloth: { color: new THREE.Color(spec.cloth ?? spec.color).getHex(), roughness: 0.68, metalness: 0, clearcoat: 0, clearcoatRoughness: 0 },
    clothAlt: { color: new THREE.Color(spec.clothAlt ?? spec.secondary).getHex(), roughness: 0.68, metalness: 0, clearcoat: 0, clearcoatRoughness: 0 },
    face: { color: new THREE.Color(spec.skin ?? 0xf0c39a).getHex(), roughness: 0.7, metalness: 0, clearcoat: 0, clearcoatRoughness: 0 },
  };
}

/** 16×2 nearest-filtered lookup strip. `fill(slot, out)` writes RGBA 0..255. */
function makeAtlasTexture(
  entries: Record<MaterialSlot, AtlasEntry>,
  fill: (e: AtlasEntry, out: Uint8Array, o: number) => void,
  srgb: boolean,
): THREE.DataTexture {
  const w = ATLAS_COLS, h = 2;
  const data = new Uint8Array(w * h * 4);
  for (const slot of ALL_SLOTS) {
    const col = SLOT_COLUMN[slot];
    for (let row = 0; row < h; row++) {
      fill(entries[slot], data, (row * w + col) * 4);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const _atlasCol = new THREE.Color();

function writeRgb(hex: number, out: Uint8Array, o: number, mul = 1): void {
  _atlasCol.setHex(hex);
  out[o] = Math.round(clamp255(_atlasCol.r * mul));
  out[o + 1] = Math.round(clamp255(_atlasCol.g * mul));
  out[o + 2] = Math.round(clamp255(_atlasCol.b * mul));
  out[o + 3] = 255;
}

function clamp255(v: number): number {
  const x = v * 255;
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

/** Everything a consolidated LOD mesh needs, built once per paint key. */
export interface MergedMaterial {
  material: THREE.MeshPhysicalMaterial;
  albedo: THREE.DataTexture;
  orm: THREE.DataTexture;
  cc: THREE.DataTexture;
  emissive: THREE.DataTexture;
}

// ---------------------------------------------------------------------------
// Small canvas / typed-array helpers
// ---------------------------------------------------------------------------

function canvas2d(size: number, height = size): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  const g = c.getContext('2d', { willReadFrequently: false });
  if (!g) throw new Error('[KartMaterials] 2D context unavailable');
  return { c, g };
}

/** Deterministic value noise so every run looks identical. */
function hash2(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 13) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/**
 * Sobel a height field into a tangent-space normal map.
 * Height is a Float32Array of `size*size` in [0,1], wrapped toroidally.
 */
function normalFromHeight(height: Float32Array, size: number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function canvasTexture(
  c: HTMLCanvasElement,
  srgb: boolean,
  repeat = 1,
  anisotropy = 8,
): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Texture builders
// ---------------------------------------------------------------------------

/** Very fine random flake normal — the sparkle inside metallic car paint. */
function makeFlakeNormal(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    const x = i % size, y = (i / size) | 0;
    // Cluster the flakes so they read as metal particles, not TV static.
    const cell = hash2(Math.floor(x / 2), Math.floor(y / 2), 91);
    h[i] = cell > 0.62 ? 1 : 0.35 + hash2(x, y, 12) * 0.2;
  }
  return normalFromHeight(h, size, 1.4);
}

/** Fine machined / orange-peel detail — kills the "vinyl" look on paint. */
function makePanelNormal(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * 10, v = y / size * 10;
      let n = fbm(u, v, 4, 3) * 0.7 + fbm(u * 6, v * 6, 2, 17) * 0.3;
      // faint horizontal micro-scratches
      n += Math.sin(y * 2.1 + fbm(u * 3, v * 3, 2, 44) * 8) * 0.02;
      h[y * size + x] = n;
    }
  }
  return normalFromHeight(h, size, 0.35);
}

/** Brushed anodised metal. */
function makeBrushedNormal(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const streak = hash2(0, y, 5) * 0.55 + hash2(Math.floor(x / 24), y, 9) * 0.45;
      h[y * size + x] = streak * 0.7 + fbm(x / size * 12, y / size * 60, 2, 31) * 0.3;
    }
  }
  return normalFromHeight(h, size, 0.7);
}

/** Rubber: pebbled micro surface. */
function makeRubberNormal(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const pebble = fbm(u * 46, v * 46, 3, 7);
      const mould = Math.sin(v * Math.PI * 2 * 64) * 0.03;
      h[y * size + x] = pebble * 0.9 + mould;
    }
  }
  return normalFromHeight(h, size, 0.9);
}

/**
 * Tyre albedo + sidewall lettering. UV convention (see Wheels.ts):
 *   u = around the circumference (texture repeats 8x)
 *   v = across the profile; 0..0.18 and 0.82..1 are the sidewalls,
 *       0.18..0.82 is the tread.
 */
function makeTyreAlbedo(size: number): THREE.CanvasTexture {
  const { c, g } = canvas2d(size, size);
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0.0, '#16171a');
  grad.addColorStop(0.16, '#212327');
  grad.addColorStop(0.22, '#141517');
  grad.addColorStop(0.5, '#101113');
  grad.addColorStop(0.78, '#141517');
  grad.addColorStop(0.84, '#212327');
  grad.addColorStop(1.0, '#16171a');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  // grain
  const img = g.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const p = (i / 4) | 0;
    const n = (hash2(p % size, (p / size) | 0, 61) - 0.5) * 16;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  // sidewall lettering (both sides, mirrored)
  const drawBand = (cy: number, flip: boolean) => {
    g.save();
    g.translate(size * 0.5, cy);
    if (flip) g.scale(1, -1);
    g.fillStyle = 'rgba(196,198,204,0.5)';
    g.font = `bold ${Math.round(size * 0.055)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('APEX', 0, 0);
    g.fillStyle = 'rgba(150,152,158,0.35)';
    g.font = `bold ${Math.round(size * 0.032)}px system-ui, sans-serif`;
    g.fillText('GRIP·X  205/50 R13', 0, size * 0.05);
    g.restore();
  };
  drawBand(size * 0.085, false);
  drawBand(size * 0.915, true);

  // shoulder rings
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = Math.max(1, size * 0.006);
  for (const v of [0.185, 0.815]) {
    g.beginPath(); g.moveTo(0, size * v); g.lineTo(size, size * v); g.stroke();
  }
  return canvasTexture(c, true, 1, 8);
}

/** Stitched upholstery for the seat. */
function makeSeatTextures(size: number): { map: THREE.CanvasTexture; normal: THREE.DataTexture } {
  const { c, g } = canvas2d(size, size);
  g.fillStyle = '#221f26';
  g.fillRect(0, 0, size, size);
  // quilted diamonds
  g.strokeStyle = '#100e13';
  g.lineWidth = size * 0.012;
  const step = size / 4;
  for (let i = -4; i <= 8; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step + size, size); g.stroke();
    g.beginPath(); g.moveTo(i * step, size); g.lineTo(i * step + size, 0); g.stroke();
  }
  // stitch dashes
  g.strokeStyle = 'rgba(215,205,190,0.55)';
  g.lineWidth = size * 0.0055;
  g.setLineDash([size * 0.018, size * 0.018]);
  for (let i = -4; i <= 8; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step + size, size); g.stroke();
    g.beginPath(); g.moveTo(i * step, size); g.lineTo(i * step + size, 0); g.stroke();
  }
  g.setLineDash([]);
  const img = g.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const p = (i / 4) | 0;
    const n = (hash2(p % size, (p / size) | 0, 23) - 0.5) * 22;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = Math.abs(((x + y) % step) / step - 0.5) * 2;
      const b = Math.abs(((x - y + size * 4) % step) / step - 0.5) * 2;
      h[y * size + x] = Math.min(a, b) * 0.8 + fbm(x / size * 40, y / size * 40, 2, 5) * 0.2;
    }
  }
  return { map: canvasTexture(c, true, 1, 4), normal: normalFromHeight(h, size, 0.9) };
}

/** Fine woven cloth for the driver suits. */
function makeClothNormal(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const w = (Math.sin(x * 0.9) * 0.5 + 0.5) * (Math.sin(y * 0.9) * 0.5 + 0.5);
      h[y * size + x] = w * 0.65 + fbm(x / size * 30, y / size * 30, 3, 71) * 0.35;
    }
  }
  return normalFromHeight(h, size, 0.5);
}

/** Soft radial blob used for the ground contact shadow. */
export function makeContactShadowTexture(size = 128): THREE.CanvasTexture {
  const { c, g } = canvas2d(size, size);
  g.clearRect(0, 0, size, size);
  // Elongated, slightly kart-shaped falloff, not a plain circle.
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(0,0,0,0.92)');
  grad.addColorStop(0.35, 'rgba(0,0,0,0.72)');
  grad.addColorStop(0.62, 'rgba(0,0,0,0.30)');
  grad.addColorStop(0.85, 'rgba(0,0,0,0.06)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** Soft round sprite for the far-LOD billboard. */
function makeBillboardTexture(size = 64): THREE.CanvasTexture {
  const { c, g } = canvas2d(size, size);
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Driver faces
// ---------------------------------------------------------------------------

export type FaceStyle = 'human' | 'robot' | 'alien' | 'visor';

export interface FaceSpec {
  style: FaceStyle;
  skin: string;
  /** Iris / optic colour. */
  eye: string;
  brow: string;
  /** Optional glow (robot / alien eyes). */
  glow?: string;
  /** Cheek blush / freckles. */
  blush?: string;
  /** 0 = narrow eyes, 1 = big round eyes. */
  eyeSize?: number;
  /** Facial hair / markings. */
  mark?: 'none' | 'moustache' | 'freckles' | 'scar' | 'stubble';
}

export const FACE_EXPRESSIONS = ['neutral', 'determined', 'hit', 'happy'] as const;
export type FaceExpression = (typeof FACE_EXPRESSIONS)[number];

/**
 * 4x2 atlas: columns = expression, rows = [eyes open, eyes blinking].
 * The background is the character's skin colour so the patch blends into the
 * head mesh with no alpha sorting at all.
 */
function makeFaceAtlas(spec: FaceSpec, cell = 256): THREE.CanvasTexture {
  const W = cell * 4, H = cell * 2;
  const { c, g } = canvas2d(W, H);
  g.fillStyle = spec.style === 'robot' ? '#16181d' : spec.skin;
  g.fillRect(0, 0, W, H);

  const eyeSize = spec.eyeSize ?? 1;

  const drawCell = (col: number, row: number) => {
    const ox = col * cell, oy = row * cell;
    const blink = row === 1;
    const expr = FACE_EXPRESSIONS[col];
    g.save();
    g.translate(ox, oy);

    // --- soft shading so the face isn't flat -------------------------------
    if (spec.style !== 'robot') {
      const sh = g.createRadialGradient(cell * 0.5, cell * 0.42, cell * 0.1, cell * 0.5, cell * 0.5, cell * 0.62);
      sh.addColorStop(0, 'rgba(255,255,255,0.10)');
      sh.addColorStop(0.7, 'rgba(0,0,0,0)');
      sh.addColorStop(1, 'rgba(0,0,0,0.30)');
      g.fillStyle = sh;
      g.fillRect(0, 0, cell, cell);
    } else {
      const sh = g.createLinearGradient(0, 0, 0, cell);
      sh.addColorStop(0, '#23272f');
      sh.addColorStop(1, '#0c0e12');
      g.fillStyle = sh;
      g.fillRect(0, 0, cell, cell);
      // scan lines
      g.fillStyle = 'rgba(255,255,255,0.03)';
      for (let y = 0; y < cell; y += 6) g.fillRect(0, y, cell, 2);
    }

    const ey = cell * 0.44;
    const exL = cell * 0.33, exR = cell * 0.67;
    const rx = cell * 0.105 * eyeSize;
    const ry = cell * (blink ? 0.012 : 0.125) * eyeSize;

    const drawEye = (x: number, mirror: number) => {
      if (spec.style === 'robot') {
        g.fillStyle = spec.glow ?? spec.eye;
        g.shadowColor = spec.glow ?? spec.eye;
        g.shadowBlur = cell * 0.09;
        if (blink) {
          g.fillRect(x - rx, ey - cell * 0.012, rx * 2, cell * 0.024);
        } else if (expr === 'hit') {
          // X eyes
          g.save(); g.translate(x, ey); g.rotate(Math.PI / 4);
          g.fillRect(-rx, -cell * 0.02, rx * 2, cell * 0.04);
          g.fillRect(-cell * 0.02, -rx, cell * 0.04, rx * 2);
          g.restore();
        } else {
          const h = expr === 'determined' ? ry * 0.6 : ry;
          g.beginPath();
          g.ellipse(x, ey, rx, h, 0, 0, Math.PI * 2);
          g.fill();
        }
        g.shadowBlur = 0;
        return;
      }

      // sclera
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(x, ey, rx, Math.max(ry, cell * 0.012), 0, 0, Math.PI * 2);
      g.fill();

      if (!blink) {
        if (expr === 'hit') {
          g.strokeStyle = '#2a2029';
          g.lineWidth = cell * 0.028;
          g.lineCap = 'round';
          const s = rx * 0.85;
          g.beginPath(); g.moveTo(x - s, ey - s); g.lineTo(x + s, ey + s); g.stroke();
          g.beginPath(); g.moveTo(x + s, ey - s); g.lineTo(x - s, ey + s); g.stroke();
        } else {
          // iris + pupil + specular
          const look = expr === 'determined' ? mirror * rx * 0.22 : 0;
          g.fillStyle = spec.eye;
          g.beginPath();
          g.ellipse(x + look, ey + ry * 0.1, rx * 0.62, Math.min(ry, rx * 0.72), 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#141018';
          g.beginPath();
          g.ellipse(x + look, ey + ry * 0.1, rx * 0.3, Math.min(ry * 0.72, rx * 0.36), 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = 'rgba(255,255,255,0.95)';
          g.beginPath();
          g.ellipse(x + look - rx * 0.22, ey - ry * 0.32, rx * 0.16, rx * 0.16, 0, 0, Math.PI * 2);
          g.fill();
        }
      }

      // brows
      g.strokeStyle = spec.brow;
      g.lineWidth = cell * 0.035;
      g.lineCap = 'round';
      let by = ey - cell * 0.16;
      let tilt = 0;
      if (expr === 'determined') { by += cell * 0.035; tilt = mirror * 0.42; }
      if (expr === 'hit') { by -= cell * 0.02; tilt = -mirror * 0.5; }
      if (expr === 'happy') { by -= cell * 0.025; tilt = mirror * 0.1; }
      g.save();
      g.translate(x, by);
      g.rotate(tilt);
      g.beginPath();
      g.moveTo(-rx * 1.05, cell * 0.012);
      g.quadraticCurveTo(0, -cell * 0.028, rx * 1.05, cell * 0.005);
      g.stroke();
      g.restore();
    };

    drawEye(exL, 1);
    drawEye(exR, -1);

    // --- nose --------------------------------------------------------------
    if (spec.style === 'human') {
      g.strokeStyle = 'rgba(0,0,0,0.20)';
      g.lineWidth = cell * 0.02;
      g.beginPath();
      g.moveTo(cell * 0.5, ey + cell * 0.05);
      g.quadraticCurveTo(cell * 0.47, ey + cell * 0.14, cell * 0.52, ey + cell * 0.155);
      g.stroke();
    }

    // --- mouth -------------------------------------------------------------
    const my = cell * 0.72;
    if (spec.style === 'robot') {
      g.strokeStyle = spec.glow ?? spec.eye;
      g.lineWidth = cell * 0.022;
      g.beginPath();
      const n = 7;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const amp = expr === 'hit' ? 0.05 : expr === 'happy' ? 0.035 : 0.018;
        const x = cell * (0.33 + t * 0.34);
        const y = my + Math.sin(t * Math.PI * 3 + (expr === 'determined' ? 0 : 1.2)) * cell * amp;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    } else {
      g.lineCap = 'round';
      g.strokeStyle = '#5a2f34';
      g.lineWidth = cell * 0.028;
      g.beginPath();
      if (expr === 'happy') {
        g.moveTo(cell * 0.38, my - cell * 0.02);
        g.quadraticCurveTo(cell * 0.5, my + cell * 0.11, cell * 0.62, my - cell * 0.02);
        g.stroke();
        g.fillStyle = '#7a3239';
        g.beginPath();
        g.moveTo(cell * 0.38, my - cell * 0.02);
        g.quadraticCurveTo(cell * 0.5, my + cell * 0.11, cell * 0.62, my - cell * 0.02);
        g.quadraticCurveTo(cell * 0.5, my + cell * 0.02, cell * 0.38, my - cell * 0.02);
        g.fill();
      } else if (expr === 'determined') {
        g.moveTo(cell * 0.4, my);
        g.quadraticCurveTo(cell * 0.5, my - cell * 0.035, cell * 0.6, my);
        g.stroke();
      } else if (expr === 'hit') {
        g.fillStyle = '#5a2f34';
        g.beginPath();
        g.ellipse(cell * 0.5, my + cell * 0.01, cell * 0.075, cell * 0.055, 0, 0, Math.PI * 2);
        g.fill();
      } else {
        g.moveTo(cell * 0.42, my);
        g.quadraticCurveTo(cell * 0.5, my + cell * 0.04, cell * 0.58, my);
        g.stroke();
      }
    }

    // --- markings ----------------------------------------------------------
    if (spec.mark === 'moustache') {
      g.fillStyle = spec.brow;
      g.beginPath();
      g.ellipse(cell * 0.42, my - cell * 0.07, cell * 0.09, cell * 0.045, 0.25, 0, Math.PI * 2);
      g.ellipse(cell * 0.58, my - cell * 0.07, cell * 0.09, cell * 0.045, -0.25, 0, Math.PI * 2);
      g.fill();
    } else if (spec.mark === 'freckles') {
      g.fillStyle = 'rgba(150,90,60,0.5)';
      for (let i = 0; i < 12; i++) {
        const side = i < 6 ? 0.31 : 0.62;
        const fx = cell * (side + hash2(i, 1, 3) * 0.08);
        const fy = cell * (0.58 + hash2(i, 2, 4) * 0.08);
        g.beginPath(); g.arc(fx, fy, cell * 0.011, 0, Math.PI * 2); g.fill();
      }
    } else if (spec.mark === 'scar') {
      g.strokeStyle = 'rgba(160,90,90,0.55)';
      g.lineWidth = cell * 0.012;
      g.beginPath();
      g.moveTo(cell * 0.7, ey - cell * 0.18);
      g.lineTo(cell * 0.66, ey + cell * 0.08);
      g.stroke();
    } else if (spec.mark === 'stubble') {
      g.fillStyle = 'rgba(40,32,38,0.30)';
      for (let i = 0; i < 260; i++) {
        const a = hash2(i, 7, 9) * Math.PI * 2;
        const r = 0.16 + hash2(i, 8, 11) * 0.16;
        const fx = cell * (0.5 + Math.cos(a) * r);
        const fy = cell * (0.78 + Math.sin(a) * r * 0.55);
        if (fy < cell * 0.6) continue;
        g.beginPath(); g.arc(fx, fy, cell * 0.006, 0, Math.PI * 2); g.fill();
      }
    }

    if (spec.blush) {
      g.fillStyle = spec.blush;
      for (const bx of [0.24, 0.76]) {
        g.beginPath();
        g.ellipse(cell * bx, cell * 0.6, cell * 0.075, cell * 0.045, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
  };

  for (let r = 0; r < 2; r++) for (let col = 0; col < 4; col++) drawCell(col, r);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(0.25, 0.5);
  t.offset.set(0, 0.5);
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Emissive companion for glowing (robot / alien) faces. */
function makeFaceEmissive(spec: FaceSpec, base: THREE.CanvasTexture): THREE.CanvasTexture | null {
  if (!spec.glow) return null;
  const src = base.image as HTMLCanvasElement;
  const { c, g } = canvas2d(src.width, src.height);
  g.drawImage(src, 0, 0);
  // Keep only the bright glow-coloured pixels.
  const glowCol = new THREE.Color(spec.glow);
  const img = g.getImageData(0, 0, c.width, c.height);
  const gr = glowCol.r * 255, gg = glowCol.g * 255, gb = glowCol.b * 255;
  for (let i = 0; i < img.data.length; i += 4) {
    const d = Math.abs(img.data[i] - gr) + Math.abs(img.data[i + 1] - gg) + Math.abs(img.data[i + 2] - gb);
    const keep = d < 150 ? 1 : 0;
    img.data[i] = img.data[i] * keep;
    img.data[i + 1] = img.data[i + 1] * keep;
    img.data[i + 2] = img.data[i + 2] * keep;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.copy(base.repeat);
  t.offset.copy(base.offset);
  t.needsUpdate = true;
  return t;
}

/**
 * A face material plus the tiny state machine that drives its expression and
 * blinking. One instance per kart (the UV offset is per-material state).
 */
export class FaceMaterial {
  readonly material: THREE.MeshStandardMaterial;
  private readonly map: THREE.CanvasTexture;
  private readonly emissiveMap: THREE.CanvasTexture | null;
  private expr = 0;
  private blink = false;
  private blinkTimer = 1 + Math.random() * 3;

  constructor(spec: FaceSpec, quality: QualitySettings) {
    const cell = quality.tier === 'low' ? 128 : quality.tier === 'medium' ? 192 : 256;
    this.map = makeFaceAtlas(spec, cell);
    this.emissiveMap = makeFaceEmissive(spec, this.map);
    this.material = new THREE.MeshStandardMaterial({
      map: this.map,
      roughness: spec.style === 'robot' ? 0.28 : 0.72,
      metalness: spec.style === 'robot' ? 0.55 : 0.0,
      vertexColors: true,
      emissive: this.emissiveMap ? new THREE.Color(spec.glow ?? '#ffffff') : new THREE.Color(0x000000),
      emissiveIntensity: this.emissiveMap ? 2.2 : 0,
    });
    // Assigned after construction: passing `undefined` for an absent map makes
    // three.js warn about an unknown parameter value.
    if (this.emissiveMap) this.material.emissiveMap = this.emissiveMap;
    this.material.name = 'kart-face';
  }

  setExpression(e: FaceExpression | number): void {
    const i = typeof e === 'number' ? e : FACE_EXPRESSIONS.indexOf(e);
    this.expr = Math.max(0, Math.min(3, i));
    this.applyUv();
  }

  /** Advance the blink timer. `dt` in seconds. */
  tick(dt: number): void {
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      if (this.blink) { this.blink = false; this.blinkTimer = 1.6 + Math.random() * 3.4; }
      else { this.blink = true; this.blinkTimer = 0.085; }
      this.applyUv();
    }
  }

  private applyUv(): void {
    const ox = this.expr * 0.25;
    const oy = this.blink ? 0.0 : 0.5;
    this.map.offset.set(ox, oy);
    if (this.emissiveMap) this.emissiveMap.offset.set(ox, oy);
  }

  dispose(): void {
    this.map.dispose();
    this.emissiveMap?.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

export interface PaintSpec {
  /** Primary body colour. */
  color: THREE.ColorRepresentation;
  /** Accent / stripe colour. */
  secondary: THREE.ColorRepresentation;
  /** Suit primary (usually derived from `color`). */
  cloth?: THREE.ColorRepresentation;
  clothAlt?: THREE.ColorRepresentation;
  skin?: THREE.ColorRepresentation;
  /** Emissive accent for thrusters / underglow. */
  glow?: THREE.ColorRepresentation;
  /** Metal-flake amount 0..1 (0 = solid toy paint, 1 = heavy metallic). */
  flake?: number;
  /** Slightly matte body (buggy / offroad). */
  matte?: boolean;
}

export type KartMaterialSet = Record<MaterialSlot, THREE.Material>;

/**
 * Owns every texture used by karts (shared) and builds per-character material
 * sets (cached by key). Call `dispose()` once at teardown.
 */
export class KartMaterialLibrary {
  readonly quality: QualitySettings;

  // shared textures
  readonly flakeNormal: THREE.DataTexture;
  readonly panelNormal: THREE.DataTexture;
  readonly brushedNormal: THREE.DataTexture;
  readonly rubberNormal: THREE.DataTexture;
  readonly tyreMap: THREE.CanvasTexture;
  readonly seatMap: THREE.CanvasTexture;
  readonly seatNormal: THREE.DataTexture;
  readonly clothNormal: THREE.DataTexture;
  readonly contactShadow: THREE.CanvasTexture;
  readonly billboard: THREE.CanvasTexture;

  private sets = new Map<string, KartMaterialSet>();
  private merged = new Map<string, MergedMaterial>();
  private extra: THREE.Material[] = [];
  private faces: FaceMaterial[] = [];

  constructor(quality: QualitySettings) {
    this.quality = quality;
    const big = quality.tier === 'low' ? 128 : quality.tier === 'medium' ? 256 : 512;
    const small = quality.tier === 'low' ? 128 : 256;

    this.flakeNormal = makeFlakeNormal(small);
    this.panelNormal = makePanelNormal(big);
    this.brushedNormal = makeBrushedNormal(small);
    this.rubberNormal = makeRubberNormal(small);
    this.tyreMap = makeTyreAlbedo(big);
    const seat = makeSeatTextures(small);
    this.seatMap = seat.map;
    this.seatNormal = seat.normal;
    this.clothNormal = makeClothNormal(small);
    this.contactShadow = makeContactShadowTexture(quality.tier === 'low' ? 64 : 128);
    this.billboard = makeBillboardTexture(64);

    const aniso = Math.max(1, quality.anisotropy);
    for (const t of [this.panelNormal, this.tyreMap, this.seatMap, this.brushedNormal, this.rubberNormal]) {
      t.anisotropy = aniso;
    }
    this.flakeNormal.repeat.set(28, 28);
    this.panelNormal.repeat.set(3.5, 3.5);
    this.brushedNormal.repeat.set(4, 4);
    this.rubberNormal.repeat.set(6, 3);
    this.clothNormal.repeat.set(5, 5);
  }

  // -------------------------------------------------------------------------

  /** Get (or build) the material set for a paint spec. `key` must be stable. */
  getSet(key: string, spec: PaintSpec): KartMaterialSet {
    const existing = this.sets.get(key);
    if (existing) return existing;
    const set = this.buildSet(key, spec);
    this.sets.set(key, set);
    return set;
  }

  private buildSet(key: string, spec: PaintSpec): KartMaterialSet {
    const flake = spec.flake ?? 0.55;
    const matte = spec.matte === true;

    const paint = this.carPaint(spec.color, flake, matte);
    paint.name = `paint:${key}`;
    const paint2 = this.carPaint(spec.secondary, flake * 0.7, matte);
    paint2.name = `paint2:${key}`;

    const chrome = new THREE.MeshPhysicalMaterial({
      color: 0xf2f4f8,
      metalness: 1.0,
      roughness: 0.075,
      envMapIntensity: 1.7,
      normalMap: this.brushedNormal,
      normalScale: new THREE.Vector2(0.08, 0.08),
      vertexColors: true,
    });
    chrome.name = 'chrome';

    const metal = new THREE.MeshPhysicalMaterial({
      color: 0x3d434c,
      metalness: 0.92,
      roughness: 0.42,
      envMapIntensity: 1.1,
      normalMap: this.brushedNormal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      vertexColors: true,
    });
    metal.name = 'metal';

    const plastic = new THREE.MeshPhysicalMaterial({
      color: 0x1c1f25,
      metalness: 0.0,
      roughness: 0.44,
      clearcoat: 0.25,
      clearcoatRoughness: 0.35,
      envMapIntensity: 0.9,
      normalMap: this.panelNormal,
      normalScale: new THREE.Vector2(0.9, 0.9),
      vertexColors: true,
    });
    plastic.name = 'plastic';

    // Tyres must read black. A sheen layer plus a bright sky turns rubber navy,
    // so the environment contribution is deliberately small and the sheen is a
    // warm grey rather than a blue-grey.
    const rubber = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: this.tyreMap,
      metalness: 0.0,
      roughness: 0.88,
      sheen: 0.22,
      sheenRoughness: 0.7,
      sheenColor: new THREE.Color(0x33302e),
      envMapIntensity: 0.3,
      normalMap: this.rubberNormal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      vertexColors: true,
    });
    rubber.name = 'rubber';

    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x11161f,
      metalness: 0.1,
      roughness: 0.045,
      transparent: true,
      opacity: 0.55,
      envMapIntensity: 2.4,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      side: THREE.FrontSide,
      depthWrite: false,
      vertexColors: true,
    });
    glass.name = 'glass';

    const lightFront = new THREE.MeshStandardMaterial({
      color: 0xfff3d8,
      emissive: new THREE.Color(0xfff0cc),
      emissiveIntensity: 2.6,
      roughness: 0.12,
      metalness: 0.0,
      vertexColors: true,
    });
    lightFront.name = 'lightFront';

    const lightRear = new THREE.MeshStandardMaterial({
      color: 0x5a0d10,
      emissive: new THREE.Color(0xff2a1a),
      emissiveIntensity: 1.3,
      roughness: 0.18,
      metalness: 0.0,
      vertexColors: true,
    });
    lightRear.name = 'lightRear';

    const glow = new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.glow ?? spec.secondary),
      emissive: new THREE.Color(spec.glow ?? spec.secondary),
      emissiveIntensity: 2.2,
      roughness: 0.3,
      metalness: 0.0,
      vertexColors: true,
    });
    glow.name = 'glow';

    const seat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: this.seatMap,
      normalMap: this.seatNormal,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.62,
      metalness: 0.0,
      sheen: 0.5,
      sheenRoughness: 0.55,
      sheenColor: new THREE.Color(0x555055),
      envMapIntensity: 0.8,
      vertexColors: true,
    });
    seat.name = 'seat';

    const skin = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(spec.skin ?? 0xf0c39a),
      roughness: 0.68,
      metalness: 0.0,
      clearcoat: 0.18,
      clearcoatRoughness: 0.6,
      sheen: 0.25,
      sheenColor: new THREE.Color(0xffd9c0),
      envMapIntensity: 0.85,
      vertexColors: true,
    });
    skin.name = 'skin';

    const cloth = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(spec.cloth ?? spec.color),
      roughness: 0.68,
      metalness: 0.0,
      normalMap: this.clothNormal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      sheen: 0.45,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0xffffff),
      envMapIntensity: 0.8,
      vertexColors: true,
    });
    cloth.name = 'cloth';

    const clothAlt = cloth.clone();
    clothAlt.color = new THREE.Color(spec.clothAlt ?? spec.secondary);
    clothAlt.name = 'clothAlt';

    // 'face' is replaced per-kart by a FaceMaterial; this is the fallback.
    const face = new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.skin ?? 0xf0c39a),
      roughness: 0.7,
      vertexColors: true,
    });
    face.name = 'face-fallback';

    return {
      paint, paint2, chrome, metal, plastic, rubber, glass,
      lightFront, lightRear, glow, seat, skin, cloth, clothAlt, face,
    };
  }

  /**
   * The single material every consolidated (merged-geometry) part of this racer
   * draws with. See the atlas notes at the top of the file. One per paint key.
   */
  mergedFor(key: string, spec: PaintSpec): THREE.MeshPhysicalMaterial {
    const hit = this.merged.get(key);
    if (hit) return hit.material;

    const entries = atlasEntries(spec);
    const albedo = makeAtlasTexture(entries, (e, o, i) => writeRgb(e.color, o, i), true);
    const orm = makeAtlasTexture(entries, (e, o, i) => {
      o[i] = 255;                                    // r: unused (AO comes from vertex colour)
      o[i + 1] = Math.round(clamp255(e.roughness));  // g: roughness
      o[i + 2] = Math.round(clamp255(e.metalness));  // b: metalness
      o[i + 3] = 255;
    }, false);
    const cc = makeAtlasTexture(entries, (e, o, i) => {
      o[i] = Math.round(clamp255(e.clearcoat));            // x: clearcoat
      o[i + 1] = Math.round(clamp255(e.clearcoatRoughness)); // y: clearcoat roughness
      o[i + 2] = 0;
      o[i + 3] = 255;
    }, false);
    const emissive = makeAtlasTexture(entries, (e, o, i) => {
      if (e.emissive === undefined) { o[i] = o[i + 1] = o[i + 2] = 0; o[i + 3] = 255; return; }
      writeRgb(e.emissive, o, i);
    }, true);

    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: albedo,
      roughness: 1, roughnessMap: orm,
      metalness: 1, metalnessMap: orm,
      clearcoat: 1, clearcoatMap: cc,
      clearcoatRoughness: 1, clearcoatRoughnessMap: cc,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: emissive,
      emissiveIntensity: 1.8,
      envMapIntensity: 0.85,
      vertexColors: true,
    });
    material.name = `merged:${key}`;
    this.merged.set(key, { material, albedo, orm, cc, emissive });
    return material;
  }

  /**
   * Clear-coated metallic car paint — the signature MK8 look.
   *
   * Metalness is deliberately kept low: a metalness of 0.5 hands half the albedo
   * to the specular lobe, and under a bright sky that turns a saturated red into
   * a pale pink mirror. The hue has to survive the environment, so the *flake*
   * (a clearcoat normal map) carries the metallic read instead of the base layer,
   * and the clearcoat roughness is broad enough to be a highlight rather than a
   * mirror of the whole sky.
   */
  carPaint(color: THREE.ColorRepresentation, flake = 0.55, matte = false): THREE.MeshPhysicalMaterial {
    const m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      metalness: matte ? 0.05 : 0.10 + flake * 0.16,
      roughness: matte ? 0.55 : 0.30,
      clearcoat: matte ? 0.35 : 1.0,
      clearcoatRoughness: matte ? 0.4 : 0.13,
      clearcoatNormalMap: this.flakeNormal,
      clearcoatNormalScale: new THREE.Vector2(0.10 + flake * 0.16, 0.10 + flake * 0.16),
      normalMap: this.panelNormal,
      normalScale: new THREE.Vector2(0.32, 0.32),
      envMapIntensity: matte ? 0.65 : 0.7,
      vertexColors: true,
    });
    return m;
  }

  /** Build a per-kart face material (tracked for disposal). */
  createFace(spec: FaceSpec): FaceMaterial {
    const f = new FaceMaterial(spec, this.quality);
    this.faces.push(f);
    return f;
  }

  /** Register a material the library should dispose (per-kart clones). */
  track<T extends THREE.Material>(m: T): T {
    this.extra.push(m);
    return m;
  }

  /** Soft blob shadow material (shared; one mesh per kart). */
  createContactShadowMaterial(): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({
      map: this.contactShadow,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      color: 0x000000,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });
    m.name = 'contact-shadow';
    return this.track(m);
  }

  createBillboardMaterial(color: THREE.ColorRepresentation): THREE.SpriteMaterial {
    const m = new THREE.SpriteMaterial({
      map: this.billboard,
      color: new THREE.Color(color),
      transparent: true,
      depthWrite: false,
      toneMapped: true,
    });
    return this.track(m);
  }

  dispose(): void {
    for (const set of this.sets.values()) {
      for (const slot of ALL_SLOTS) set[slot].dispose();
    }
    this.sets.clear();
    for (const m of this.merged.values()) {
      m.material.dispose();
      m.albedo.dispose(); m.orm.dispose(); m.cc.dispose(); m.emissive.dispose();
    }
    this.merged.clear();
    for (const m of this.extra) m.dispose();
    this.extra.length = 0;
    for (const f of this.faces) f.dispose();
    this.faces.length = 0;
    this.flakeNormal.dispose();
    this.panelNormal.dispose();
    this.brushedNormal.dispose();
    this.rubberNormal.dispose();
    this.tyreMap.dispose();
    this.seatMap.dispose();
    this.seatNormal.dispose();
    this.clothNormal.dispose();
    this.contactShadow.dispose();
    this.billboard.dispose();
  }
}
