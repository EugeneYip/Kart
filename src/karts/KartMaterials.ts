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
import { clamp01 } from '@/core/MathUtils';

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
  | 'face'         // driver face atlas
  // --- animal drivers -------------------------------------------------------
  // Fur is not skin: it wants a strand normal, a much broader sheen lobe and no
  // clearcoat at all. Three tones because that is what a readable animal costs —
  // body, light underside/markings, and dark extremities.
  | 'fur'          // primary pelt
  | 'furAlt'       // cream / light markings (muzzle, chest, tail tip)
  | 'furDark';     // dark extremities (ear tips, paws, boots)

export const ALL_SLOTS: readonly MaterialSlot[] = [
  'paint', 'paint2', 'chrome', 'metal', 'plastic', 'rubber', 'glass',
  'lightFront', 'lightRear', 'glow', 'seat', 'skin', 'cloth', 'clothAlt', 'face',
  // Appended, never inserted: `atlasUv()` bakes the column index into every
  // consolidated buffer's UVs, so re-ordering this list would silently repaint
  // every existing kart.
  'fur', 'furAlt', 'furDark',
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
export const ATLAS_COLS = 24;

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
    // Fur reads matte at the merged LODs; the sheen that sells it up close is a
    // per-slot material feature and cannot go in a lookup strip.
    fur: { color: new THREE.Color(spec.fur ?? spec.skin ?? 0xc08040).getHex(), roughness: 0.86, metalness: 0, clearcoat: 0, clearcoatRoughness: 0 },
    furAlt: { color: new THREE.Color(spec.furAlt ?? 0xf0e2cc).getHex(), roughness: 0.88, metalness: 0, clearcoat: 0, clearcoatRoughness: 0 },
    furDark: { color: new THREE.Color(spec.furDark ?? 0x4a2e20).getHex(), roughness: 0.82, metalness: 0, clearcoat: 0, clearcoatRoughness: 0 },
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
const _mixA = new THREE.Color();
const _mixB = new THREE.Color();

/** Blend two CSS colours in linear space and return `rgb(...)`. */
function mixHex(a: string, b: string, t: number): string {
  _mixA.set(a);
  _mixB.set(b);
  _mixA.lerp(_mixB, t);
  return `rgb(${Math.round(_mixA.r * 255)},${Math.round(_mixA.g * 255)},${Math.round(_mixA.b * 255)})`;
}

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

/**
 * Fur: directional strand clumps.
 *
 * A single octave of noise gives velvet, not fur. What makes it read is *shear*
 * — the height field is sampled along a slowly-curving flow direction so the
 * strands clump into locks, and a high-frequency ridge term on top gives the
 * individual hairs. The result is deliberately anisotropic: under a rim light
 * the locks catch a broken highlight instead of an even sheen band, which is the
 * whole difference between "plush toy" and "animal".
 */
function makeFurNormal(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Flow field: locks sweep down-and-across, wandering slowly.
      const flow = (fbm(u * 3.0, v * 3.0, 3, 101) - 0.5) * 1.6;
      const su = u * 22 + flow * 2.4;
      const sv = v * 34;
      // Lock mass: broad, stretched along the flow.
      const lock = fbm(su * 0.5, sv * 0.16, 3, 113);
      // Individual strands: a sharp ridge across the lock direction.
      const strandPhase = su * Math.PI * 2 + fbm(u * 8, v * 8, 2, 127) * 5.0;
      const strand = 1 - Math.abs(Math.sin(strandPhase)) ** 0.55;
      // Tips fade so the strands taper rather than ending in a wall.
      const taper = 0.35 + 0.65 * (1 - Math.abs(Math.sin(sv * Math.PI * 0.5)));
      h[y * size + x] = lock * 0.55 + strand * taper * 0.45;
    }
  }
  return normalFromHeight(h, size, 1.15);
}

/**
 * Chunky knitwear: vertical ribs of alternating knit/purl stitches.
 *
 * Each stitch is a rounded lozenge leaning alternately left and right, so a
 * column reads as a plaited rib rather than a corrugated sheet. The rib pitch is
 * coarse on purpose — a jumper knitted at sock gauge disappears at ten metres.
 */
function makeKnitNormal(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  const ribs = 9;          // ribs across the tile
  const rows = 13;         // stitch rows down the tile
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const rib = u * ribs;
      const row = v * rows;
      const ri = Math.floor(rib), rj = Math.floor(row);
      // Local stitch coordinates, -1..1.
      const fx = (rib - ri) * 2 - 1;
      const fy = (row - rj) * 2 - 1;
      // Alternate the lean per row so the stitches interlock.
      const lean = ((ri + rj) & 1) ? 0.42 : -0.42;
      const lx = fx + fy * lean;
      // Rounded lozenge: a superellipse bump.
      const d = Math.min(1, Math.abs(lx) ** 2.4 + Math.abs(fy) ** 2.0);
      let n = (1 - d) ** 0.65;
      // The purl valley between ribs stays dark.
      n *= 0.55 + 0.45 * (1 - Math.abs(fx) ** 3);
      // Fibre fuzz over the top so the wool is not vacuum-formed plastic.
      n = n * 0.86 + fbm(u * 42, v * 42, 3, 61) * 0.14;
      h[y * size + x] = n;
    }
  }
  return normalFromHeight(h, size, 1.35);
}

/**
 * Skin: a neutral-luminance detail albedo plus a pore normal.
 *
 * The `skin` slot used to be a solid colour with no maps at all — a §0
 * violation on the *entire cranium* of seven of the ten drivers, which is most
 * of why the humans read as vinyl dolls next to MK8DX. The albedo has to be
 * neutral (mean ≈ 1.0) because it multiplies a per-driver skin colour, so the
 * variation is carried as a ±6 % mottle rather than as a tint: subdermal
 * blotching at low frequency, a warm capillary flush over it, and pores.
 */
function makeSkinTextures(size: number): { map: THREE.CanvasTexture; normal: THREE.DataTexture } {
  const { c, g } = canvas2d(size, size);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Two mottle octaves at very different scales — one reads as bone shadow
      // under the skin, the other as blood colour in it.
      const deep = fbm(u * 3.2, v * 3.2, 3, 211) - 0.5;
      const flush = fbm(u * 9.0, v * 9.0, 3, 223) - 0.5;
      const pore = hash2(x, y, 229) - 0.5;
      const lum = 1 + deep * 0.085 + flush * 0.055 + pore * 0.030;
      // Flush is warm: it lifts red and drops blue, which is what stops a
      // uniform tint reading as painted plastic.
      const i = (y * size + x) * 4;
      img.data[i] = Math.round(clamp255(lum + flush * 0.045));
      img.data[i + 1] = Math.round(clamp255(lum));
      img.data[i + 2] = Math.round(clamp255(lum - flush * 0.040));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Pores are a dense field of small dimples; the low-frequency term is the
      // soft undulation of flesh over bone.
      const cellX = Math.floor(x / 3), cellY = Math.floor(y / 3);
      const pore = hash2(cellX, cellY, 233) > 0.58 ? 0.0 : 1.0;
      const soft = fbm(u * 5.0, v * 5.0, 3, 239);
      h[y * size + x] = soft * 0.72 + pore * 0.28;
    }
  }
  return { map: canvasTexture(c, true, 1, 8), normal: normalFromHeight(h, size, 0.42) };
}

/**
 * Glass: wipe streaks and a dust rim.
 *
 * A visor is the largest single facet on three of the drivers' heads and it was
 * a mathematically perfect flat pane. `map` stays near-white so the dark tint
 * still comes from the material colour; the read comes from the streak normal
 * and the roughness variation, which is what makes a highlight travel across a
 * visor instead of sitting on it like a sticker.
 */
function makeGlassTextures(size: number): {
  map: THREE.CanvasTexture; normal: THREE.DataTexture; rough: THREE.CanvasTexture;
} {
  const { c, g } = canvas2d(size, size);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  // Faint dust and polish haze, heavier toward the edges of the tile.
  for (let i = 0; i < 90; i++) {
    const x = hash2(i, 1, 401) * size;
    const y = hash2(i, 2, 409) * size;
    const r = size * (0.004 + hash2(i, 3, 419) * 0.012);
    g.fillStyle = `rgba(214,222,232,${0.10 + hash2(i, 4, 421) * 0.16})`;
    g.beginPath();
    g.ellipse(x, y, r * (1 + hash2(i, 5, 431) * 2.4), r, hash2(i, 6, 433) * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  const { c: rc, g: rg } = canvas2d(size, size);
  const rimg = rg.createImageData(size, size);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Wipe arcs: long low-amplitude ridges swept one way, the trace a
      // squeegee leaves. Plus a very fine polish grain.
      const arc = Math.sin((u * 3.1 + v * 0.8) * Math.PI * 2 + fbm(u * 2, v * 2, 2, 443) * 3.0);
      const grain = fbm(u * 60, v * 60, 2, 449);
      h[y * size + x] = 0.5 + arc * 0.055 + grain * 0.12;
      // Roughness map: mostly mirror, rougher where the wipe streaks sit.
      const r = clamp255(0.030 + Math.abs(arc) * 0.055 + grain * 0.030);
      const i = (y * size + x) * 4;
      rimg.data[i] = 255;
      rimg.data[i + 1] = Math.round(r);   // g = roughness
      rimg.data[i + 2] = 0;
      rimg.data[i + 3] = 255;
    }
  }
  rg.putImageData(rimg, 0, 0);
  return {
    map: canvasTexture(c, true, 1, 8),
    normal: normalFromHeight(h, size, 0.30),
    rough: canvasTexture(rc, false, 1, 4),
  };
}

/**
 * Emissive accents: a hot core banded by cooler ribs.
 *
 * `glow` was a solid emissive colour, so a drift-charge disc or a robot's
 * chest core was a featureless bright blob — the one thing bloom exaggerates.
 * Banding it means the bloom picks up structure instead of a flat pool.
 */
function makeGlowTexture(size: number): THREE.CanvasTexture {
  const { c, g } = canvas2d(size, size);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Concentric ribs in the tile plus a slow pulse across it. Both are
      // scale-free enough to survive whatever UVs a small accent part carries.
      const rib = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 6 + Math.sin(u * Math.PI * 2 * 2) * 0.9);
      const core = fbm(u * 4, v * 4, 3, 457);
      const lum = clamp255(0.52 + rib * 0.34 + core * 0.20);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(lum);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // One texture serves both `map` and `emissiveMap` — three binds the same
  // sampler twice quite happily and a second upload of identical pixels is
  // 64 KB of VRAM for nothing.
  return canvasTexture(c, true, 1, 4);
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

export type FaceStyle = 'human' | 'robot' | 'alien' | 'visor' | 'fox' | 'capy';

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
  mark?: 'none' | 'moustache' | 'freckles' | 'scar' | 'stubble' | 'whiskers';
  /**
   * Animal styles only — the pale muzzle field that fills the bottom
   * `ANIMAL_MUZZLE_SPLIT` of the cell. The head geometry puts a second face
   * panel over the snout, so the mouth lands on the muzzle and not the skull.
   */
  snout?: string;
  /** Nose colour for the animal styles (also painted as the nose-bridge shade). */
  nose?: string;
  /**
   * Expression to wear when the kart is parked and the race has not started.
   * This is what gives `thoughtful` / `sleepy` something to do.
   */
  idle?: FaceExpression;
  /**
   * Expression the RACER-SELECT CARD wears. Defaults to `happy`.
   *
   * ⚠️ THIS EXISTS BECAUSE `happy` CLOSES A CAPYBARA'S EYES. The animal cell
   * draws `happy` as "eyes squeezed with joy" — `lid = 1, squint = true` — which
   * takes the `drawAnimalEye` early-out and paints one lid stroke and nothing
   * else: no sclera, no iris, no catchlight. That is a lovely gameplay reaction
   * and it is a disaster on a 100 px product shot, where Capy was the only
   * racer on the board with no eyes at all. `idle` is no help either — hers is
   * `sleepy`, which is also `lid = 1`.
   *
   * So the card's expression is now a separate, deliberate choice per character
   * rather than one constant in `Portrait.ts`, and `.probe-tmp/facecard.ts`
   * asserts that no racer's portrait expression is a shut-eye one.
   */
  portrait?: FaceExpression;
}

/**
 * Columns of the face atlas.
 *
 * The first four are the gameplay states `KartManager` selects from and their
 * cell art is unchanged — a driver authored before this list grew renders
 * identically. `thoughtful` and `sleepy` were added for the animal roster: the
 * reference sheets ask for four *personality* faces per character and only three
 * of them (curious / focused / amused for the fox, content / surprised / happy
 * for the capybara) map onto a state the race actually produces. Rather than
 * hijack `hit` — a fox that has just been shelled should not look pensive — the
 * union grew by two idle states, driven off `FaceSpec.idle` when parked.
 */
export const FACE_EXPRESSIONS = [
  'neutral', 'determined', 'hit', 'happy', 'thoughtful', 'sleepy',
] as const;
export type FaceExpression = (typeof FACE_EXPRESSIONS)[number];

/** Where the pale muzzle field starts, as a texture `v`. Shared with Driver.ts. */
export const ANIMAL_MUZZLE_SPLIT = 0.45;

/**
 * The band of the cell a `visor` face uses, as texture `v`.
 *
 * A visor panel is a wide, short strip wrapped round the front of a helmet —
 * roughly 2.8 times as long as it is tall — while the atlas cell is square. If
 * the panel took the whole cell every eye would be squashed to a 2.8:1 slot.
 * Mapping the panel onto a band **this tall** instead makes one cell pixel
 * square on the panel, so a circle drawn in the cell arrives as a circle:
 *
 *     v1 - v0  ==  panelHeight / panelArcLength
 *
 * `Driver.ts`'s `visorPatch()` sizes each helmet's panel to hold that identity
 * to within a few per cent, and `.probe-tmp/facecard.ts` checks it.
 */
export const VISOR_BAND = { v0: 0.37, v1: 0.63 } as const;

/**
 * Nx2 atlas: columns = expression, rows = [eyes open, eyes blinking].
 * The background is the character's skin colour so the patch blends into the
 * head mesh with no alpha sorting at all.
 */
function makeFaceAtlas(spec: FaceSpec, cell = 256): THREE.CanvasTexture {
  const COLS = FACE_EXPRESSIONS.length;
  const W = cell * COLS, H = cell * 2;
  const { c, g } = canvas2d(W, H);
  g.fillStyle = spec.style === 'robot' ? '#16181d' : spec.skin;
  g.fillRect(0, 0, W, H);
  const animal = spec.style === 'fox' || spec.style === 'capy';

  const eyeSize = spec.eyeSize ?? 1;

  /**
   * A real iris: limbal ring, radial fibres, a pupil, and a bright catchlight
   * plus a dim bounce light opposite it.
   *
   * Both eye paths used to fill three flat ellipses — iris, pupil, one dot. A
   * flat disc of colour is the single most doll-like thing you can put on a
   * face, and at portrait size (208 px per cell) the eye is most of what the
   * player looks at. The limbal ring is doing the heavy lifting: a dark rim
   * around the iris is what makes it read as a wet sphere set into a socket
   * rather than as a sticker.
   */
  const drawIris = (
    cx: number, cy: number, rx: number, ry: number, iris: string, pupilR: number,
  ) => {
    const grad = g.createRadialGradient(cx, cy - ry * 0.22, rx * 0.10, cx, cy, rx * 1.02);
    grad.addColorStop(0, mixHex(iris, '#ffffff', 0.38));
    grad.addColorStop(0.52, iris);
    grad.addColorStop(0.86, mixHex(iris, '#120b08', 0.34));
    grad.addColorStop(1, mixHex(iris, '#0d0806', 0.62));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
    // Radial fibres — eight strokes clipped to the iris, alternating light/dark.
    g.save();
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.clip();
    g.lineWidth = Math.max(1, rx * 0.11);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.32;
      g.strokeStyle = i % 2 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(20,12,8,0.20)';
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * rx * 0.34, cy + Math.sin(a) * ry * 0.34);
      g.lineTo(cx + Math.cos(a) * rx * 1.02, cy + Math.sin(a) * ry * 1.02);
      g.stroke();
    }
    g.restore();
    // Limbal ring.
    g.strokeStyle = 'rgba(14,9,7,0.55)';
    g.lineWidth = Math.max(1, rx * 0.14);
    g.beginPath();
    g.ellipse(cx, cy, rx * 0.95, ry * 0.95, 0, 0, Math.PI * 2);
    g.stroke();
    // Pupil.
    g.fillStyle = '#0f0a09';
    g.beginPath();
    g.ellipse(cx, cy, pupilR, Math.min(ry * 0.92, pupilR * 1.25), 0, 0, Math.PI * 2);
    g.fill();
    // Catchlight, then the weaker bounce from the opposite side.
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.ellipse(cx - rx * 0.34, cy - ry * 0.40, rx * 0.26, rx * 0.22, -0.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(198,222,255,0.45)';
    g.beginPath();
    g.ellipse(cx + rx * 0.30, cy + ry * 0.34, rx * 0.14, rx * 0.12, 0, 0, Math.PI * 2);
    g.fill();
  };

  /** Upper-lid shadow across the top of an eyeball. */
  const drawLidShadow = (cx: number, cy: number, rx: number, ry: number) => {
    g.save();
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.clip();
    const sh = g.createLinearGradient(0, cy - ry, 0, cy + ry * 0.35);
    sh.addColorStop(0, 'rgba(52,28,16,0.45)');
    sh.addColorStop(1, 'rgba(52,28,16,0)');
    g.fillStyle = sh;
    g.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
    g.restore();
  };

  // -------------------------------------------------------------------------
  //  Animal cell (fox / capybara)
  // -------------------------------------------------------------------------
  //  Split layout: the top `1 - ANIMAL_MUZZLE_SPLIT` of the cell is pelt and
  //  carries the eyes, the bottom is the pale muzzle and carries the nose bridge
  //  and mouth. Driver.ts puts a second face panel over the snout geometry
  //  covering exactly that lower band, so the mouth sits on the muzzle instead
  //  of being painted onto the forehead.
  //
  //  Storybook vs MK8: the *albedo* keeps the reference art's hand-drawn feel —
  //  stippled fur strokes, a soft pencil-shaded muzzle, muted tones — while the
  //  material underneath supplies the sheen and the strand normal. Flat colour
  //  is never written anywhere in this cell.
  // -------------------------------------------------------------------------
  const drawAnimalCell = (expr: FaceExpression, blink: boolean) => {
    const capy = spec.style === 'capy';
    const fur = spec.skin;
    const snout = spec.snout ?? '#efe0c8';
    const nose = spec.nose ?? '#3a241b';
    const splitY = cell * (1 - ANIMAL_MUZZLE_SPLIT);

    // --- pelt field --------------------------------------------------------
    g.fillStyle = fur;
    g.fillRect(0, 0, cell, cell);
    const pelt = g.createRadialGradient(
      cell * 0.5, cell * 0.30, cell * 0.06, cell * 0.5, cell * 0.46, cell * 0.66,
    );
    pelt.addColorStop(0, 'rgba(255,246,232,0.16)');
    pelt.addColorStop(0.62, 'rgba(0,0,0,0)');
    pelt.addColorStop(1, 'rgba(20,10,4,0.34)');
    g.fillStyle = pelt;
    g.fillRect(0, 0, cell, cell);

    // --- muzzle field: a rounded pad, not a horizontal seam ----------------
    g.save();
    g.beginPath();
    const mw = cell * (capy ? 0.46 : 0.34);
    g.moveTo(cell * 0.5 - mw, cell * 1.02);
    g.quadraticCurveTo(cell * 0.5 - mw, splitY - cell * 0.02, cell * 0.5, splitY - cell * 0.05);
    g.quadraticCurveTo(cell * 0.5 + mw, splitY - cell * 0.02, cell * 0.5 + mw, cell * 1.02);
    g.closePath();
    g.clip();
    g.fillStyle = snout;
    g.fillRect(0, 0, cell, cell);
    const mg = g.createLinearGradient(0, splitY - cell * 0.06, 0, cell);
    mg.addColorStop(0, 'rgba(255,255,255,0.16)');
    mg.addColorStop(0.45, 'rgba(0,0,0,0)');
    mg.addColorStop(1, 'rgba(60,36,20,0.28)');
    g.fillStyle = mg;
    g.fillRect(0, 0, cell, cell);
    g.restore();

    // --- fur stipple: the reference sheet's pencil texture, in albedo ------
    for (let i = 0; i < 420; i++) {
      const sx = hash2(i, 1, 331) * cell;
      const sy = hash2(i, 2, 337) * cell;
      const onMuzzle = sy > splitY;
      const len = cell * (0.010 + hash2(i, 3, 347) * 0.020);
      const ang = (hash2(i, 4, 353) - 0.5) * 0.9 + (sx < cell * 0.5 ? 1.9 : 1.25);
      g.strokeStyle = hash2(i, 5, 359) > 0.5
        ? (onMuzzle ? 'rgba(255,252,244,0.16)' : 'rgba(255,240,214,0.15)')
        : (onMuzzle ? 'rgba(96,62,38,0.11)' : 'rgba(52,26,10,0.14)');
      g.lineWidth = cell * 0.0055;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len);
      g.stroke();
    }

    // --- expression dials --------------------------------------------------
    // lid: 0 = wide open, 1 = shut. squint: lids close as upward arcs (joy).
    let lid = 0.10;
    let squint = false;
    let browY = 0;
    let browTilt = 0;
    let browLift = 0;
    let gazeY = 0;
    let eyeMul = 1;
    let mouth: 'smile' | 'flat' | 'open' | 'round' | 'soft' | 'purse' | 'ouch' = 'smile';
    switch (expr) {
      case 'neutral': // fox: curious | capy: content
        lid = capy ? 0.44 : 0.02;
        browLift = capy ? 0.0 : 0.030;
        eyeMul = capy ? 1 : 1.06;
        mouth = capy ? 'soft' : 'smile';
        break;
      case 'determined': // focused
        lid = capy ? 0.50 : 0.44;
        browY = 0.036; browTilt = 0.40;
        mouth = 'flat';
        break;
      case 'hit': // fox: ouch | capy: surprised
        if (capy) { lid = -0.18; eyeMul = 1.38; browLift = 0.05; mouth = 'round'; }
        else { lid = 0.94; browY = -0.022; browTilt = -0.5; mouth = 'ouch'; }
        break;
      case 'happy': // fox: amused | capy: eyes squeezed with joy
        lid = capy ? 1 : 0.18;
        squint = capy;
        browLift = 0.026;
        mouth = 'open';
        break;
      case 'thoughtful': // eyes up and away
        lid = 0.24; gazeY = -0.34; browLift = 0.040; browTilt = 0.16;
        mouth = 'purse';
        break;
      case 'sleepy': // lids down, softer smile
        lid = 1; browLift = 0.014; mouth = 'soft';
        break;
    }
    if (blink) { lid = 1; squint = false; }

    // --- eyes --------------------------------------------------------------
    const ey = cell * (capy ? 0.300 : 0.352);
    const exL = cell * (capy ? 0.250 : 0.312);
    const exR = cell - exL;
    const rx = cell * (capy ? 0.070 : 0.112) * eyeSize * eyeMul;
    const ryFull = cell * (capy ? 0.074 : 0.120) * eyeSize * eyeMul;

    const drawAnimalEye = (x: number, mirror: number) => {
      // Socket shadow: a fur-coloured well so the eye is set INTO the head.
      const sock = g.createRadialGradient(x, ey, rx * 0.4, x, ey, rx * 2.0);
      sock.addColorStop(0, 'rgba(40,20,8,0.34)');
      sock.addColorStop(1, 'rgba(40,20,8,0)');
      g.fillStyle = sock;
      g.beginPath();
      g.ellipse(x, ey, rx * 2.0, ryFull * 2.0, 0, 0, Math.PI * 2);
      g.fill();

      if (lid >= 0.9 || squint) {
        // Shut / squinting: a lid line. Curving it up is joy, down is sleep.
        const bend = squint || expr === 'happy' ? -1 : expr === 'hit' ? -1 : 1;
        g.strokeStyle = spec.brow;
        g.lineWidth = cell * 0.026;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x - rx, ey + (bend < 0 ? ryFull * 0.36 : 0));
        g.quadraticCurveTo(x, ey + bend * ryFull * 0.92, x + rx, ey + (bend < 0 ? ryFull * 0.36 : 0));
        g.stroke();
        if (expr === 'hit') {
          // Squeezed-shut crease.
          g.lineWidth = cell * 0.013;
          g.beginPath();
          g.moveTo(x - rx * 0.7, ey - ryFull * 0.6);
          g.quadraticCurveTo(x, ey - ryFull * 0.1, x + rx * 0.7, ey - ryFull * 0.6);
          g.stroke();
        }
        return;
      }

      const ry = ryFull * (1 - clamp01(lid) * 0.72);
      // Sclera. Small dark animal eyes keep only a sliver of white.
      g.fillStyle = capy ? 'rgba(248,242,232,0.55)' : '#fbf7f0';
      g.beginPath();
      g.ellipse(x, ey, rx, Math.max(ry, cell * 0.010), 0, 0, Math.PI * 2);
      g.fill();
      drawLidShadow(x, ey, rx, Math.max(ry, cell * 0.010));

      // Iris + pupil, gaze-shifted.
      const gx = mirror * rx * (expr === 'thoughtful' ? 0.20 : expr === 'determined' ? 0.18 : 0);
      const gy = ryFull * gazeY;
      drawIris(
        x + gx, ey + gy,
        rx * (capy ? 0.86 : 0.70), Math.min(ry, rx * 0.86),
        spec.eye, rx * (capy ? 0.60 : 0.36),
      );

      // Upper lid as a fur-coloured cap, so narrowing reads as a lid not a crop.
      if (lid > 0.06) {
        g.fillStyle = fur;
        g.beginPath();
        g.moveTo(x - rx * 1.12, ey - ryFull * 1.15);
        g.lineTo(x + rx * 1.12, ey - ryFull * 1.15);
        g.lineTo(x + rx * 1.12, ey - ry * 0.98);
        g.quadraticCurveTo(x, ey - ry * 0.98 + ryFull * 0.22 * lid, x - rx * 1.12, ey - ry * 0.98);
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(48,24,10,0.35)';
        g.lineWidth = cell * 0.009;
        g.beginPath();
        g.moveTo(x - rx * 1.05, ey - ry * 0.98);
        g.quadraticCurveTo(x, ey - ry * 0.98 + ryFull * 0.22 * lid, x + rx * 1.05, ey - ry * 0.98);
        g.stroke();
      }
    };
    drawAnimalEye(exL, 1);
    drawAnimalEye(exR, -1);

    // --- brows: fur tufts, not pencil lines --------------------------------
    const drawBrow = (x: number, mirror: number) => {
      g.save();
      g.translate(x, ey - cell * (0.145 + browLift) + cell * browY);
      g.rotate(mirror * browTilt);
      g.fillStyle = spec.brow;
      g.beginPath();
      g.moveTo(-rx * 1.05, cell * 0.016);
      g.quadraticCurveTo(0, -cell * 0.030, rx * 1.05, cell * 0.004);
      g.quadraticCurveTo(0, cell * 0.014, -rx * 1.05, cell * 0.016);
      g.fill();
      g.restore();
    };
    drawBrow(exL, 1);
    drawBrow(exR, -1);

    if (!capy) {
      // The red fox's TEAR STRIPE: a dark wedge running from the inner corner of
      // each eye down onto the muzzle. It is on every reference photograph and it
      // is most of what distinguishes a fox's face from a generic orange animal's.
      // `Driver.ts` also puts a shallow ridge here so the key light catches it.
      for (const sgn of [-1, 1]) {
        const x0 = cell * 0.5 + sgn * cell * 0.10;
        g.fillStyle = 'rgba(58,32,20,0.42)';
        g.beginPath();
        g.moveTo(x0 + sgn * cell * 0.055, ey + ryFull * 0.30);
        g.quadraticCurveTo(
          x0 + sgn * cell * 0.030, splitY - cell * 0.05,
          x0 - sgn * cell * 0.006, splitY + cell * 0.010,
        );
        g.quadraticCurveTo(
          x0 + sgn * cell * 0.060, splitY - cell * 0.06,
          x0 + sgn * cell * 0.098, ey + ryFull * 0.38,
        );
        g.closePath();
        g.fill();
      }
      // Pale brow spot above each eye — the small light patch a red fox has just
      // inboard of the ear, and a cheap second value in the pelt field.
      g.fillStyle = 'rgba(255,244,226,0.20)';
      for (const sgn of [-1, 1]) {
        g.beginPath();
        g.ellipse(cell * 0.5 + sgn * cell * 0.20, ey - cell * 0.20, cell * 0.060, cell * 0.034, sgn * 0.3, 0, Math.PI * 2);
        g.fill();
      }
    } else {
      // A capybara's brow is a heavy horizontal shelf and the eyes sit under it,
      // which is where the permanently-unbothered expression comes from.
      const shelf = g.createLinearGradient(0, ey - cell * 0.16, 0, ey + cell * 0.02);
      shelf.addColorStop(0, 'rgba(58,40,26,0.30)');
      shelf.addColorStop(1, 'rgba(58,40,26,0)');
      g.fillStyle = shelf;
      g.fillRect(0, ey - cell * 0.16, cell, cell * 0.18);
    }

    // --- nose bridge shade, under the geometric nose -----------------------
    const ny = splitY + cell * (capy ? 0.045 : 0.020);
    const nw = cell * (capy ? 0.115 : 0.075);
    g.fillStyle = nose;
    g.globalAlpha = 0.30;
    g.beginPath();
    g.ellipse(cell * 0.5, ny, nw, nw * (capy ? 0.42 : 0.56), 0, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;

    // --- mouth -------------------------------------------------------------
    const my = cell * (capy ? 0.845 : 0.815);
    const half = cell * (capy ? 0.105 : 0.088);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(74,40,26,0.92)';
    g.lineWidth = cell * 0.024;
    // Every animal mouth starts from the philtrum, which is what makes a muzzle
    // read as a muzzle instead of a painted-on grin.
    g.beginPath();
    g.moveTo(cell * 0.5, my - cell * 0.055);
    g.lineTo(cell * 0.5, my - cell * 0.006);
    g.stroke();

    if (mouth === 'flat') {
      g.beginPath();
      g.moveTo(cell * 0.5 - half, my + cell * 0.004);
      g.quadraticCurveTo(cell * 0.5, my - cell * 0.012, cell * 0.5 + half, my + cell * 0.004);
      g.stroke();
    } else if (mouth === 'round' || mouth === 'ouch') {
      const rr = cell * (mouth === 'round' ? 0.052 : 0.062);
      g.fillStyle = '#57262a';
      g.beginPath();
      g.ellipse(cell * 0.5, my + cell * 0.016, rr, rr * (mouth === 'round' ? 1.0 : 0.82), 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    } else if (mouth === 'open') {
      // Open smile with the tongue just visible.
      g.fillStyle = '#57262a';
      g.beginPath();
      g.moveTo(cell * 0.5 - half, my - cell * 0.006);
      g.quadraticCurveTo(cell * 0.5, my + cell * 0.098, cell * 0.5 + half, my - cell * 0.006);
      g.quadraticCurveTo(cell * 0.5, my + cell * 0.014, cell * 0.5 - half, my - cell * 0.006);
      g.fill();
      g.stroke();
      g.fillStyle = '#d3707a';
      g.beginPath();
      g.ellipse(cell * 0.5, my + cell * 0.058, half * 0.44, cell * 0.026, 0, 0, Math.PI * 2);
      g.fill();
    } else if (mouth === 'purse') {
      g.beginPath();
      g.moveTo(cell * 0.5 - half * 0.66, my + cell * 0.012);
      g.quadraticCurveTo(cell * 0.5 - half * 0.1, my - cell * 0.020, cell * 0.5 + half * 0.5, my + cell * 0.016);
      g.stroke();
    } else {
      // 'smile' | 'soft' — two mirrored lifts off the philtrum.
      const drop = mouth === 'soft' ? 0.030 : 0.046;
      for (const sgn of [-1, 1]) {
        g.beginPath();
        g.moveTo(cell * 0.5, my - cell * 0.004);
        g.quadraticCurveTo(
          cell * 0.5 + sgn * half * 0.55, my + cell * drop,
          cell * 0.5 + sgn * half, my + cell * (drop * 0.25),
        );
        g.stroke();
      }
    }

    // --- whiskers + cheek freckle dots ------------------------------------
    if (spec.mark === 'whiskers') {
      g.strokeStyle = 'rgba(60,38,24,0.32)';
      g.lineWidth = cell * 0.007;
      for (const sgn of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const y0 = my - cell * (0.062 - i * 0.030);
          g.beginPath();
          g.moveTo(cell * 0.5 + sgn * half * 0.85, y0);
          g.quadraticCurveTo(
            cell * 0.5 + sgn * (half + cell * 0.10), y0 - cell * 0.020 + i * cell * 0.014,
            cell * 0.5 + sgn * (half + cell * 0.185), y0 - cell * 0.030 + i * cell * 0.030,
          );
          g.stroke();
        }
        g.fillStyle = 'rgba(60,38,24,0.28)';
        for (let i = 0; i < 3; i++) {
          g.beginPath();
          g.arc(
            cell * 0.5 + sgn * half * (0.42 + i * 0.20),
            my - cell * (0.070 - (i % 2) * 0.024),
            cell * 0.0085, 0, Math.PI * 2,
          );
          g.fill();
        }
      }
    }

    if (spec.blush) {
      g.fillStyle = spec.blush;
      for (const bx of [0.20, 0.80]) {
        g.beginPath();
        g.ellipse(cell * bx, cell * 0.52, cell * 0.080, cell * 0.046, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
  };

  // -------------------------------------------------------------------------
  //  Visor cell — the face of a driver who is inside a helmet
  // -------------------------------------------------------------------------
  //  ⚠️ THREE OF TEN RACERS HAD NO FACE AT ALL. Measured on the real card
  //  framing (`.probe-tmp/facecard.ts`): Blitz 0 %, Pip 0 %, Ember 0 % of their
  //  card was visible face, because a `verticalLoft` helmet shell reaches
  //  1.18–1.24 R forward and the square face patch sat at 0.92 R — *inside* it.
  //  Their eyes were rendered every frame, behind an opaque shell, on the
  //  product shot the whole roster is judged on.
  //
  //  The fix is not to cut an aperture in a lofted solid. It is to accept what
  //  a helmet actually is at 100 px and make THE VISOR THE FACE: a dark glass
  //  strip carrying two luminous eyes. Two bright shapes on a dark field is the
  //  highest-contrast face a card can have, it costs no silhouette (the panel
  //  hugs a surface that is already there), and the eye SHAPE still carries the
  //  full six-expression vocabulary, so these three keep an inner life.
  //
  //  The eye colour is `spec.glow`, which `makeFaceEmissive()` then lifts into
  //  the emissive map — so the eyes bloom, which is what sells them as light
  //  coming through tint rather than as two stickers.
  // -------------------------------------------------------------------------
  const drawVisorCell = (expr: FaceExpression, blink: boolean) => {
    const glowC = spec.glow ?? '#8fd8ff';
    const glass = spec.eye;
    const y0 = cell * VISOR_BAND.v0;
    const y1 = cell * VISOR_BAND.v1;
    const midY = (y0 + y1) * 0.5;
    const bandH = y1 - y0;

    // --- the glass field ---------------------------------------------------
    // Fill the whole cell, not just the band: the panel's UVs are clamped, and
    // a driver seen from an extreme angle should never sample bare canvas.
    g.fillStyle = glass;
    g.fillRect(0, 0, cell, cell);
    const depth = g.createLinearGradient(0, y0 - bandH * 0.5, 0, y1 + bandH * 0.5);
    depth.addColorStop(0, 'rgba(0,0,0,0.62)');       // top lip, facing the sky
    depth.addColorStop(0.5, 'rgba(0,0,0,0.10)');
    depth.addColorStop(1, mixHex(glass, glowC, 0.20)); // bounce off the chest
    g.fillStyle = depth;
    g.fillRect(0, 0, cell, cell);

    // Sheen. One broad diagonal streak is the single strongest "this is glass"
    // cue there is; a clean tinted rectangle reads as painted plastic.
    g.save();
    g.beginPath();
    g.rect(0, y0, cell, bandH);
    g.clip();
    const sheen = g.createLinearGradient(cell * 0.10, y0, cell * 0.66, y1);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.42, 'rgba(226,240,255,0.20)');
    sheen.addColorStop(0.52, 'rgba(226,240,255,0.26)');
    sheen.addColorStop(0.70, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.fillRect(0, y0, cell, bandH);
    // A hard specular line just under the top edge — the lit rim of the glass.
    g.strokeStyle = 'rgba(236,246,255,0.34)';
    g.lineWidth = cell * 0.008;
    g.beginPath();
    g.moveTo(cell * 0.06, y0 + bandH * 0.16);
    g.bezierCurveTo(cell * 0.34, y0 + bandH * 0.05, cell * 0.66, y0 + bandH * 0.05,
      cell * 0.94, y0 + bandH * 0.17);
    g.stroke();
    g.restore();

    // --- the eyes ----------------------------------------------------------
    const rx = cell * 0.088 * eyeSize;
    const ry = cell * 0.070 * eyeSize;
    const shut = blink || expr === 'sleepy';

    const visorEye = (x: number, mirror: number) => {
      g.save();
      g.fillStyle = glowC;
      g.strokeStyle = glowC;
      g.shadowColor = glowC;
      g.shadowBlur = cell * 0.055;
      g.lineCap = 'round';
      g.lineJoin = 'round';

      if (shut) {
        g.lineWidth = ry * 0.44;
        g.beginPath();
        g.moveTo(x - rx * 0.86, midY);
        g.lineTo(x + rx * 0.86, midY);
        g.stroke();
      } else if (expr === 'hit') {
        g.lineWidth = ry * 0.42;
        g.beginPath(); g.moveTo(x - rx * 0.7, midY - ry * 0.7); g.lineTo(x + rx * 0.7, midY + ry * 0.7); g.stroke();
        g.beginPath(); g.moveTo(x + rx * 0.7, midY - ry * 0.7); g.lineTo(x - rx * 0.7, midY + ry * 0.7); g.stroke();
      } else if (expr === 'happy') {
        // Two upward crescents — the one expression that has to read instantly,
        // because it is what the racer-select card wears.
        g.lineWidth = ry * 0.62;
        g.beginPath();
        g.moveTo(x - rx, midY + ry * 0.34);
        g.quadraticCurveTo(x, midY - ry * 1.10, x + rx, midY + ry * 0.34);
        g.stroke();
      } else {
        // An eye with a canted inner edge: the top is a straight brow line and
        // the bottom is a curve, which is what turns a lozenge into a LOOK.
        const squash = expr === 'determined' ? 0.52 : expr === 'thoughtful' ? 0.78 : 1;
        const tilt = expr === 'determined' ? ry * 0.42 : 0;
        const gaze = expr === 'thoughtful' ? mirror * rx * 0.26 : 0;
        const h = ry * squash;
        g.beginPath();
        g.moveTo(x - rx + gaze, midY - h + mirror * tilt);
        g.lineTo(x + rx + gaze, midY - h - mirror * tilt);
        g.quadraticCurveTo(x + rx * 0.82 + gaze, midY + h * 1.25, x + gaze, midY + h * 1.32);
        g.quadraticCurveTo(x - rx * 0.82 + gaze, midY + h * 1.25, x - rx + gaze, midY - h + mirror * tilt);
        g.closePath();
        g.fill();
        // A cooler core so the eye is not one flat lozenge of light.
        g.shadowBlur = 0;
        g.fillStyle = mixHex(glowC, '#ffffff', 0.55);
        g.beginPath();
        g.ellipse(x + gaze - rx * 0.18, midY - h * 0.10, rx * 0.30, h * 0.42, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    };
    visorEye(cell * 0.31, 1);
    visorEye(cell * 0.69, -1);

    // A dim reflected horizon under the eyes, so the glass keeps reading as a
    // curved surface rather than as a black hole with two lights in it.
    g.strokeStyle = 'rgba(180,206,240,0.13)';
    g.lineWidth = cell * 0.006;
    g.beginPath();
    g.moveTo(cell * 0.10, y1 - bandH * 0.20);
    g.bezierCurveTo(cell * 0.36, y1 - bandH * 0.12, cell * 0.64, y1 - bandH * 0.12,
      cell * 0.90, y1 - bandH * 0.21);
    g.stroke();
  };

  const drawCell = (col: number, row: number) => {
    const ox = col * cell, oy = row * cell;
    const blink = row === 1;
    const expr = FACE_EXPRESSIONS[col];
    g.save();
    g.translate(ox, oy);
    if (animal) {
      drawAnimalCell(expr, blink);
      g.restore();
      return;
    }
    if (spec.style === 'visor') {
      drawVisorCell(expr, blink);
      g.restore();
      return;
    }

    // --- soft shading so the face isn't flat -------------------------------
    if (spec.style !== 'robot') {
      const sh = g.createRadialGradient(cell * 0.5, cell * 0.42, cell * 0.1, cell * 0.5, cell * 0.5, cell * 0.62);
      sh.addColorStop(0, 'rgba(255,255,255,0.10)');
      sh.addColorStop(0.7, 'rgba(0,0,0,0)');
      sh.addColorStop(1, 'rgba(0,0,0,0.30)');
      g.fillStyle = sh;
      g.fillRect(0, 0, cell, cell);
      // Painted anatomy. The animal cells have had a stippled pelt since they
      // were authored; the human cells were a flat fill plus one radial ramp,
      // so a human head was a matte plastic egg with a decal on it. These are
      // the three shadows a stylised face cannot do without: the brow, the
      // cheekbone and the underside of the jaw.
      const brow = g.createLinearGradient(0, cell * 0.20, 0, cell * 0.40);
      brow.addColorStop(0, 'rgba(96,54,34,0.20)');
      brow.addColorStop(1, 'rgba(96,54,34,0)');
      g.fillStyle = brow;
      g.fillRect(0, cell * 0.20, cell, cell * 0.20);
      for (const sgn of [-1, 1]) {
        const ck = g.createRadialGradient(
          cell * (0.5 + sgn * 0.30), cell * 0.60, cell * 0.02,
          cell * (0.5 + sgn * 0.30), cell * 0.60, cell * 0.24,
        );
        ck.addColorStop(0, 'rgba(255,236,214,0.16)');
        ck.addColorStop(1, 'rgba(255,236,214,0)');
        g.fillStyle = ck;
        g.fillRect(0, 0, cell, cell);
      }
      const jaw = g.createLinearGradient(0, cell * 0.80, 0, cell);
      jaw.addColorStop(0, 'rgba(70,38,26,0)');
      jaw.addColorStop(1, 'rgba(70,38,26,0.26)');
      g.fillStyle = jaw;
      g.fillRect(0, cell * 0.80, cell, cell * 0.20);
      // Pore stipple, matching the `skin` material's own pore normal so the
      // face patch and the skull around it read as one surface.
      for (let i = 0; i < 300; i++) {
        const px = hash2(i, 11, 613) * cell;
        const py = hash2(i, 12, 617) * cell;
        const dark = hash2(i, 13, 619) > 0.5;
        g.fillStyle = dark ? 'rgba(120,74,52,0.10)' : 'rgba(255,242,226,0.10)';
        g.beginPath();
        g.arc(px, py, cell * 0.0055, 0, Math.PI * 2);
        g.fill();
      }
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
    // `sleepy` is drawn exactly like a blink — lids down. For the original four
    // columns `shut === blink`, so nothing about them changes.
    const shut = blink || expr === 'sleepy';
    const ry = cell * (shut ? 0.012 : 0.125) * eyeSize;

    const drawEye = (x: number, mirror: number) => {
      if (spec.style === 'robot') {
        g.fillStyle = spec.glow ?? spec.eye;
        g.shadowColor = spec.glow ?? spec.eye;
        g.shadowBlur = cell * 0.09;
        if (shut) {
          g.fillRect(x - rx, ey - cell * 0.012, rx * 2, cell * 0.024);
        } else if (expr === 'hit') {
          // X eyes
          g.save(); g.translate(x, ey); g.rotate(Math.PI / 4);
          g.fillRect(-rx, -cell * 0.02, rx * 2, cell * 0.04);
          g.fillRect(-cell * 0.02, -rx, cell * 0.04, rx * 2);
          g.restore();
        } else {
          const h = expr === 'determined' ? ry * 0.6 : expr === 'thoughtful' ? ry * 0.82 : ry;
          g.beginPath();
          g.ellipse(x, ey, rx, h, 0, 0, Math.PI * 2);
          g.fill();
        }
        g.shadowBlur = 0;
        return;
      }

      // Sclera. Not #ffffff: a pure-white eyeball is the classic tell of a
      // decal, because a real sclera is in shadow under the lid and picks up
      // bounce from the cheek.
      g.fillStyle = '#f6f2ec';
      g.beginPath();
      g.ellipse(x, ey, rx, Math.max(ry, cell * 0.012), 0, 0, Math.PI * 2);
      g.fill();
      if (!shut) drawLidShadow(x, ey, rx, Math.max(ry, cell * 0.012));

      if (!shut) {
        if (expr === 'hit') {
          g.strokeStyle = '#2a2029';
          g.lineWidth = cell * 0.028;
          g.lineCap = 'round';
          const s = rx * 0.85;
          g.beginPath(); g.moveTo(x - s, ey - s); g.lineTo(x + s, ey + s); g.stroke();
          g.beginPath(); g.moveTo(x + s, ey - s); g.lineTo(x - s, ey + s); g.stroke();
        } else {
          // iris + pupil + specular
          const look = expr === 'determined' ? mirror * rx * 0.22
            : expr === 'thoughtful' ? mirror * rx * 0.30 : 0;
          // `thoughtful` is "eyes up and away" — the gaze offset IS the read.
          const lookY = expr === 'thoughtful' ? -ry * 0.44 : 0;
          drawIris(
            x + look, ey + ry * 0.1 + lookY,
            rx * 0.62, Math.min(ry, rx * 0.72), spec.eye, rx * 0.30,
          );
          // Lash line along the top lid — one dark stroke, and the difference
          // between "has eyes" and "has a face".
          g.strokeStyle = 'rgba(40,24,18,0.55)';
          g.lineWidth = cell * 0.016;
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(x - rx * 1.04, ey - ry * 0.58);
          g.quadraticCurveTo(x, ey - ry * 1.20, x + rx * 1.04, ey - ry * 0.58);
          g.stroke();
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
      if (expr === 'thoughtful') { by -= cell * 0.048; tilt = mirror * 0.20; }
      if (expr === 'sleepy') { by -= cell * 0.006; tilt = mirror * 0.06; }
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
        const amp = expr === 'hit' ? 0.05 : expr === 'happy' ? 0.035
          : expr === 'sleepy' ? 0.006 : 0.018;
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
      } else if (expr === 'thoughtful') {
        // Pursed and pulled to one side.
        g.moveTo(cell * 0.43, my + cell * 0.008);
        g.quadraticCurveTo(cell * 0.50, my - cell * 0.018, cell * 0.575, my + cell * 0.012);
        g.stroke();
      } else if (expr === 'sleepy') {
        g.moveTo(cell * 0.44, my);
        g.quadraticCurveTo(cell * 0.5, my + cell * 0.030, cell * 0.56, my);
        g.stroke();
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

  for (let r = 0; r < 2; r++) for (let col = 0; col < COLS; col++) drawCell(col, r);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1 / COLS, 0.5);
  t.offset.set(0, 0.5);
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * Which atlas pixels become emissive, given a driver's `glow`.
 *
 * ⚠️ TWO BUGS, AND THEY WERE CANCELLING EACH OTHER OUT.
 *
 *  1. WRONG COLOUR SPACE. The target was `new THREE.Color(glow).r * 255`, and
 *     three's colour management converts a CSS string sRGB -> LINEAR on `set`.
 *     So an sRGB byte from `getImageData` was being compared against a
 *     linearised value: for the robot's `#59ffd0` the filter was actually
 *     hunting for (26, 255, 161) rather than (89, 255, 208).
 *  2. A CITY-BLOCK THRESHOLD OF 150 IS ENORMOUS. Summed over three channels it
 *     admits anything within an average of 50 per channel, which for a pale
 *     mint alien on a mint glow is the WHOLE FACE. Vex's skin `#9fe3b8` sits
 *     128 from a `#3cf0c8` iris in that metric — inside the gate — so his
 *     entire head would have been lifted into an emissive map running at
 *     intensity 2.2 and blown to white. It only escaped because bug 1 moved
 *     the target far enough away by accident.
 *
 * Fixing the space alone would have shipped the blowout. Both are fixed here:
 * sRGB against sRGB, and a per-channel (Chebyshev) distance, which is what
 * "is this pixel that colour" actually means — a sum lets one wildly wrong
 * channel hide behind two close ones.
 *
 * Exported so `.probe-tmp/facecard.ts` can assert the rule that matters: a
 * driver's own face background must never be admitted by their own filter.
 */
export const EMISSIVE_CHANNEL_TOLERANCE = 80;

export function emissiveKeeps(glow: string, r: number, g: number, b: number): boolean {
  const hex = new THREE.Color(glow).getHexString(); // back to sRGB
  const gr = parseInt(hex.slice(0, 2), 16);
  const gg = parseInt(hex.slice(2, 4), 16);
  const gb = parseInt(hex.slice(4, 6), 16);
  return Math.max(Math.abs(r - gr), Math.abs(g - gg), Math.abs(b - gb))
    < EMISSIVE_CHANNEL_TOLERANCE;
}

/** Emissive companion for glowing (robot / alien / visor) faces. */
function makeFaceEmissive(spec: FaceSpec, base: THREE.CanvasTexture): THREE.CanvasTexture | null {
  if (!spec.glow) return null;
  const src = base.image as HTMLCanvasElement;
  const { c, g } = canvas2d(src.width, src.height);
  g.drawImage(src, 0, 0);
  // Keep only the pixels that really are the glow colour.
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const keep = emissiveKeeps(spec.glow, img.data[i], img.data[i + 1], img.data[i + 2]) ? 1 : 0;
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

  constructor(spec: FaceSpec, quality: QualitySettings, furNormal?: THREE.Texture) {
    // The atlas grew from four columns to six, so the cell shrinks to keep the
    // canvas the same total area — a face atlas is per-kart, not shared, so at
    // twelve racers this is ~3 MB of texture either way. 208 px is still 2x
    // oversampled against the biggest a driver's head ever gets on screen.
    const cell = quality.tier === 'low' ? 112 : quality.tier === 'medium' ? 160 : 208;
    this.map = makeFaceAtlas(spec, cell);
    this.emissiveMap = makeFaceEmissive(spec, this.map);
    const animal = spec.style === 'fox' || spec.style === 'capy';
    // A visor is glass: it wants a tight specular and a little reflectance, or
    // the panel reads as matte paint with two lights printed on it.
    this.material = new THREE.MeshStandardMaterial({
      map: this.map,
      roughness: spec.style === 'robot' ? 0.28 : spec.style === 'visor' ? 0.16
        : animal ? 0.88 : 0.72,
      metalness: spec.style === 'robot' ? 0.55 : spec.style === 'visor' ? 0.32 : 0.0,
      vertexColors: true,
      emissive: this.emissiveMap ? new THREE.Color(spec.glow ?? '#ffffff') : new THREE.Color(0x000000),
      emissiveIntensity: this.emissiveMap ? 2.2 : 0,
    });
    // Assigned after construction: passing `undefined` for an absent map makes
    // three.js warn about an unknown parameter value.
    if (this.emissiveMap) this.material.emissiveMap = this.emissiveMap;
    // A muzzle wants the same strand relief as the rest of the pelt, otherwise
    // the face panel reads as a decal stuck onto a furry head.
    if (animal && furNormal) {
      this.material.normalMap = furNormal;
      this.material.normalScale.set(0.55, 0.55);
    }
    this.material.name = 'kart-face';
  }

  setExpression(e: FaceExpression | number): void {
    const i = typeof e === 'number' ? e : FACE_EXPRESSIONS.indexOf(e);
    this.expr = Math.max(0, Math.min(FACE_EXPRESSIONS.length - 1, i));
    this.applyUv();
  }

  /**
   * The complete atlas state: which expression column and which blink row the
   * material is currently showing.
   *
   * This exists so the portrait renderer can *borrow* a live racer's face
   * material for one offscreen frame and put it back exactly as it found it. A
   * face atlas is a 1248×416 canvas, so building a second one per portrait is
   * the difference between a free portrait and a ~30 ms one — but a portrait
   * must also never leave a rival mid-blink or permanently smiling, and
   * `setExpression` alone cannot restore the blink row.
   */
  get atlasState(): { expr: number; blink: boolean } {
    return { expr: this.expr, blink: this.blink };
  }

  setAtlasState(s: { expr: number; blink: boolean }): void {
    this.expr = Math.max(0, Math.min(FACE_EXPRESSIONS.length - 1, Math.round(s.expr)));
    this.blink = s.blink;
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
    const ox = this.expr / FACE_EXPRESSIONS.length;
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
  /** Animal drivers: primary pelt, light markings, dark extremities. */
  fur?: THREE.ColorRepresentation;
  furAlt?: THREE.ColorRepresentation;
  furDark?: THREE.ColorRepresentation;
  /**
   * Swap the fine woven-cloth normal for chunky knitwear on `cloth`/`clothAlt`.
   * Opt-in so the eight racing suits keep the weave they were authored with.
   */
  knit?: boolean;
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
  readonly knitNormal: THREE.DataTexture;
  readonly furNormal: THREE.DataTexture;
  readonly skinMap: THREE.CanvasTexture;
  readonly skinNormal: THREE.DataTexture;
  readonly glassMap: THREE.CanvasTexture;
  readonly glassNormal: THREE.DataTexture;
  readonly glassRough: THREE.CanvasTexture;
  readonly glowMap: THREE.CanvasTexture;
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
    this.knitNormal = makeKnitNormal(small);
    this.furNormal = makeFurNormal(big);
    const skin = makeSkinTextures(small);
    this.skinMap = skin.map;
    this.skinNormal = skin.normal;
    const glass = makeGlassTextures(small);
    this.glassMap = glass.map;
    this.glassNormal = glass.normal;
    this.glassRough = glass.rough;
    this.glowMap = makeGlowTexture(quality.tier === 'low' ? 64 : 128);
    this.contactShadow = makeContactShadowTexture(quality.tier === 'low' ? 64 : 128);
    this.billboard = makeBillboardTexture(64);

    const aniso = Math.max(1, quality.anisotropy);
    for (const t of [
      this.panelNormal, this.tyreMap, this.seatMap, this.brushedNormal,
      this.rubberNormal, this.furNormal, this.knitNormal,
      this.skinMap, this.skinNormal, this.glassMap, this.glassNormal,
    ]) {
      t.anisotropy = aniso;
    }
    this.flakeNormal.repeat.set(28, 28);
    this.panelNormal.repeat.set(3.5, 3.5);
    this.brushedNormal.repeat.set(4, 4);
    this.rubberNormal.repeat.set(6, 3);
    this.clothNormal.repeat.set(5, 5);
    // Knit is a coarse, physically-sized stitch; fur is much finer than cloth.
    this.knitNormal.repeat.set(3, 3);
    this.furNormal.repeat.set(7, 7);
    // Pores are the finest detail on the model — a head is ~0.25 m across and a
    // pore is sub-millimetre, so the tile has to repeat hard. The albedo mottle
    // is deliberately four times coarser than the pore normal so the two do not
    // beat against each other into a visible moiré.
    this.skinMap.repeat.set(3, 3);
    this.skinNormal.repeat.set(12, 12);
    this.glassMap.repeat.set(1.6, 1.6);
    this.glassNormal.repeat.set(1.6, 1.6);
    this.glassRough.repeat.set(1.6, 1.6);
    this.glowMap.repeat.set(2, 2);
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
      map: this.glassMap,
      metalness: 0.1,
      roughness: 1.0,
      roughnessMap: this.glassRough,
      normalMap: this.glassNormal,
      normalScale: new THREE.Vector2(0.30, 0.30),
      transparent: true,
      opacity: 0.55,
      envMapIntensity: 2.4,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      clearcoatNormalMap: this.glassNormal,
      clearcoatNormalScale: new THREE.Vector2(0.22, 0.22),
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
      map: this.glowMap,
      emissive: new THREE.Color(spec.glow ?? spec.secondary),
      emissiveMap: this.glowMap,
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

    // Skin carries a pore normal and a neutral mottle albedo. Without them the
    // whole human cranium is one flat colour, which is a §0 violation and the
    // single biggest reason the eight human drivers read as vinyl next to the
    // two animals (whose pelt has had a strand normal all along).
    const skin = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(spec.skin ?? 0xf0c39a),
      map: this.skinMap,
      normalMap: this.skinNormal,
      normalScale: new THREE.Vector2(0.42, 0.42),
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

    // Knitwear is rougher, fuzzier and much more strongly sheened than a racing
    // suit: the fibre ends scatter light at grazing angles, which is the entire
    // reason a woolly jumper reads as wool and not as painted vinyl.
    const knit = spec.knit === true;
    const cloth = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(spec.cloth ?? spec.color),
      roughness: knit ? 0.86 : 0.68,
      metalness: 0.0,
      normalMap: knit ? this.knitNormal : this.clothNormal,
      normalScale: knit ? new THREE.Vector2(1.5, 1.5) : new THREE.Vector2(0.7, 0.7),
      sheen: knit ? 0.85 : 0.45,
      sheenRoughness: knit ? 0.78 : 0.5,
      sheenColor: new THREE.Color(0xffffff),
      envMapIntensity: knit ? 0.62 : 0.8,
      vertexColors: true,
    });
    cloth.name = 'cloth';

    const clothAlt = cloth.clone();
    clothAlt.color = new THREE.Color(spec.clothAlt ?? spec.secondary);
    clothAlt.name = 'clothAlt';

    // --- fur ---------------------------------------------------------------
    // Deliberately NOT a re-tinted `skin`: no clearcoat (fur has no oily
    // specular layer), a much broader sheen lobe tinted toward the pelt so the
    // rim light picks out the silhouette, and the strand normal at full strength.
    const furTone = (c: THREE.ColorRepresentation, sheenTint: number, rough: number) => {
      const m = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(c),
        roughness: rough,
        metalness: 0.0,
        normalMap: this.furNormal,
        normalScale: new THREE.Vector2(1.25, 1.25),
        sheen: 1.0,
        sheenRoughness: 0.62,
        sheenColor: new THREE.Color(sheenTint),
        // Real anisotropic shading, not just a strand normal: a pelt's specular
        // lobe is stretched ACROSS the hairs, which is why fur catches a broken
        // band of light and a sphere with a bump map does not. `anisotropy` needs
        // a tangent frame, and three derives one from the UV gradient — every
        // fur part is swept or lofted with real UVs, so that frame exists.
        anisotropy: 0.62,
        anisotropyRotation: Math.PI * 0.5,
        envMapIntensity: 0.7,
        vertexColors: true,
      });
      return m;
    };
    const fur = furTone(spec.fur ?? spec.skin ?? 0xc08040, 0xffd9a8, 0.86);
    fur.name = 'fur';
    const furAlt = furTone(spec.furAlt ?? 0xf0e2cc, 0xfff4e2, 0.88);
    furAlt.name = 'furAlt';
    // Dark extremities: a warmer, tighter sheen so paws don't turn to black holes
    // under a bright sky — they need a visible edge or the silhouette loses its
    // "gloves and boots" read entirely.
    const furDark = furTone(spec.furDark ?? 0x4a2e20, 0xc79a72, 0.80);
    furDark.name = 'furDark';

    // 'face' is replaced per-kart by a FaceMaterial; this is the fallback, and
    // it still has to be §0-compliant because the model viewer and any caller
    // that passes `null` for the face material draws with it.
    const face = new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.skin ?? 0xf0c39a),
      map: this.skinMap,
      normalMap: this.skinNormal,
      normalScale: new THREE.Vector2(0.42, 0.42),
      roughness: 0.7,
      vertexColors: true,
    });
    face.name = 'face-fallback';

    return {
      paint, paint2, chrome, metal, plastic, rubber, glass,
      lightFront, lightRear, glow, seat, skin, cloth, clothAlt, face,
      fur, furAlt, furDark,
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
    const f = new FaceMaterial(spec, this.quality, this.furNormal);
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
    this.knitNormal.dispose();
    this.furNormal.dispose();
    this.skinMap.dispose();
    this.skinNormal.dispose();
    this.glassMap.dispose();
    this.glassNormal.dispose();
    this.glassRough.dispose();
    this.glowMap.dispose();
    this.contactShadow.dispose();
    this.billboard.dispose();
  }
}
