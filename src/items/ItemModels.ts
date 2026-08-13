/**
 * ============================================================================
 *  APEX KART — ITEM MODELS
 * ============================================================================
 *  Every item is authored procedurally: lathed / swept geometry plus
 *  per-pixel generated albedo, roughness and normal maps. Nothing is loaded
 *  from the network.
 *
 *  Also bakes a 2D icon atlas at init (offscreen render-to-canvas from a fixed
 *  studio setup) so the HUD can draw crisp item icons without needing the
 *  3D models.
 *
 *  Owned by the ITEMS agent. Exports its texture/geometry helpers so
 *  ItemBox.ts and Hazards.ts can share them. If `src/render/TextureFactory.ts`
 *  later lands, these are the duplicates to delete.
 * ============================================================================
 */

import * as THREE from 'three';
import { ItemType } from '@/core/Types';
import { clamp01, hash21, lerp, smoothstep } from '@/core/MathUtils';
// The shipping item set, owned by the roulette. Imported so the icon atlas is
// DERIVED from it — see `ICON_ITEMS`. `ItemRoulette` imports only `@/core`, so
// this edge adds no cycle.
import { LIVE_ITEMS } from './ItemRoulette';

// ---------------------------------------------------------------------------
// Procedural texture helpers
// ---------------------------------------------------------------------------

/** RGBA written by a per-pixel generator. Reused to avoid per-pixel garbage. */
export interface Px { r: number; g: number; b: number; a: number }

export function make2d(size: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('[ItemModels] 2D canvas unavailable');
  return ctx;
}

/**
 * Build a texture by evaluating `fn(u, v, out)` for every texel.
 * `u` wraps horizontally, `v` runs top(0) -> bottom(1) in image space, which
 * for LatheGeometry means profile-start -> profile-end.
 */
export function pixelTexture(
  size: number,
  fn: (u: number, v: number, out: Px) => void,
  srgb = true,
): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const out: Px = { r: 0, g: 0, b: 0, a: 255 };
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      out.r = 0; out.g = 0; out.b = 0; out.a = 255;
      fn(u, v, out);
      const i = (y * size + x) * 4;
      data[i] = out.r; data[i + 1] = out.g; data[i + 2] = out.b; data[i + 3] = out.a;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Sobel a height field into a tangent-space normal map. */
export function normalFromHeight(
  size: number,
  height: (u: number, v: number) => number,
  strength = 2.0,
): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = height((x + 0.5) / size, (y + 0.5) / size);
  }
  const at = (x: number, y: number) => {
    const xx = ((x % size) + size) % size;
    const yy = y < 0 ? 0 : y >= size ? size - 1 : y;
    return h[yy * size + xx];
  };
  const data = new Uint8Array(size * size * 4);
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
      data[i] = Math.round((nx + 1) * 127.5);
      data[i + 1] = Math.round((ny + 1) * 127.5);
      data[i + 2] = Math.round((nz + 1) * 127.5);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function canvasTexture(ctx: CanvasRenderingContext2D, srgb = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** 2D value noise, smooth-interpolated. */
export function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash21(xi, yi), b = hash21(xi + 1, yi);
  const c = hash21(xi, yi + 1), d = hash21(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

export function fbm(x: number, y: number, octaves = 4): number {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += amp * vnoise(x * f, y * f);
    norm += amp;
    f *= 2.03; amp *= 0.5;
  }
  return s / norm;
}

/** Noise that tiles perfectly across `u` by sampling around a circle. */
export function ringNoise(u: number, v: number, scale = 4, octaves = 3): number {
  const a = u * Math.PI * 2;
  return fbm(Math.cos(a) * scale + 31.7, Math.sin(a) * scale + v * scale * 2.0, octaves);
}

/** Shortest wrapped distance between two values in [0,1). */
export const wrapDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 1;
  return d > 0.5 ? 1 - d : d;
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Lathe from a profile, with normals recomputed smooth. */
export function lathe(points: THREE.Vector2[], segments = 56): THREE.LatheGeometry {
  const g = new THREE.LatheGeometry(points, segments);
  g.computeVertexNormals();
  return g;
}

/**
 * Sweep a variable-radius, slightly elliptical tube along a curve.
 * Used for bananas, fuses and tentacles — TubeGeometry can't taper.
 */
export function sweep(
  curve: THREE.Curve<THREE.Vector3>,
  tubular: number,
  radial: number,
  radiusAt: (t: number) => number,
  squash = 1,
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(tubular, false);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const vtx = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    curve.getPointAt(t, P);
    N.copy(frames.normals[i]);
    B.copy(frames.binormals[i]);
    const r = radiusAt(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cx = Math.cos(a) * r;
      const cy = Math.sin(a) * r * squash;
      vtx.copy(P).addScaledVector(N, cx).addScaledVector(B, cy);
      nrm.set(0, 0, 0).addScaledVector(N, Math.cos(a)).addScaledVector(B, Math.sin(a) / squash).normalize();
      pos.push(vtx.x, vtx.y, vtx.z);
      nor.push(nrm.x, nrm.y, nrm.z);
      uv.push(t, j / radial);
    }
  }
  const stride = radial + 1;
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * stride + j, b = a + stride, c = b + 1, d = a + 1;
      idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** A rounded N-point star outline. */
export function starShape(points: number, outer: number, inner: number, round = 0.16): THREE.Shape {
  const s = new THREE.Shape();
  const n = points * 2;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  // Quadratic fillets at every vertex — a hard star silhouette reads as low-poly.
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const inP = new THREE.Vector2().lerpVectors(p, prev, round);
    const outP = new THREE.Vector2().lerpVectors(p, next, round);
    if (i === 0) s.moveTo(inP.x, inP.y);
    else s.lineTo(inP.x, inP.y);
    s.quadraticCurveTo(p.x, p.y, outP.x, outP.y);
  }
  s.closePath();
  return s;
}

/**
 * Classic jagged lightning bolt outline, as a closed polygon in [-1,1] space.
 *
 * The Lightning item is gone (P0d-D5) so nothing extrudes this any more, but the
 * BATTERY's printed bolt is the same outline — `buildBattery` point-in-polygons
 * these vertices to drive its albedo, emissive mask and normal map from one
 * definition. Kept here so the shape has exactly one home.
 */
export const BOLT_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [0.30, 1.00], [-0.34, 0.10], [-0.02, 0.10], [-0.26, -1.00],
  [0.40, -0.06], [0.05, -0.06], [0.42, 0.62],
];

export function boltShape(scale = 1): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(BOLT_OUTLINE[0][0] * scale, BOLT_OUTLINE[0][1] * scale);
  for (let i = 1; i < BOLT_OUTLINE.length; i++) {
    s.lineTo(BOLT_OUTLINE[i][0] * scale, BOLT_OUTLINE[i][1] * scale);
  }
  s.closePath();
  return s;
}

/** Displace a lathe's bottom ring into a wavy skirt (Boo). */
function wavySkirt(geo: THREE.BufferGeometry, profileLen: number, amp: number, lobes: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const withinProfile = i % profileLen;
    const k = withinProfile / (profileLen - 1);
    if (k < 0.72) continue;
    const x = pos.getX(i), z = pos.getZ(i);
    const theta = Math.atan2(z, x);
    const w = Math.sin(theta * lobes) * amp * smoothstep((k - 0.72) / 0.28);
    pos.setY(i, pos.getY(i) + w);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

/**
 * P0d-D5 re-skin. Four prototypes replace six:
 *
 *     'rocket'   replaces 'redShell'   — ItemType.RedShell / TripleRedShell
 *     'bottle'   replaces 'banana'     — ItemType.Banana   / TripleBanana
 *     'battery'  replaces 'mushroom'   — ItemType.Boost    / TripleBoost
 *     'ninja'    replaces 'ghost'      — ItemType.Ghost
 *
 * `'lightning'`, `'squid'` and `'coin'` are deleted outright: their items are
 * gone from the set, so building them would cost boot time and an atlas cell for
 * something no player can ever be handed. `'greenShell'`, `'blueShell'`,
 * `'bomb'` and `'bullet'` survive because `Projectiles` still pools those kinds
 * and `grantItem()` can still force them — the roulette cannot.
 *
 * The coin went in the P0d follow-up: *"You can remove the coin item — it
 * doesn't do much."* It didn't: see the note on `ItemType.Coin` in
 * `ItemSystem.use()`.
 */
export type ItemModelId =
  | 'greenShell' | 'blueShell' | 'bomb'
  | 'rocket' | 'bottle' | 'battery' | 'ninja'
  | 'star' | 'bullet';

/**
 * `Record<ItemType, …>` must stay total — `ItemType` is in `src/core/Types.ts`
 * and off limits to this agent — so the three removed items point at the nearest
 * surviving prototype. None is reachable: `ItemRoulette` gives them weight 0 in
 * every row, and `ItemSystem.use()` treats them as no-ops.
 */
export const MODEL_FOR_ITEM: Record<ItemType, ItemModelId> = {
  [ItemType.Boost]: 'battery',
  [ItemType.TripleBoost]: 'battery',
  [ItemType.GreenShell]: 'greenShell',
  [ItemType.TripleGreenShell]: 'greenShell',
  [ItemType.RedShell]: 'rocket',
  [ItemType.TripleRedShell]: 'rocket',
  [ItemType.Banana]: 'bottle',
  [ItemType.TripleBanana]: 'bottle',
  [ItemType.Bomb]: 'bomb',
  [ItemType.Star]: 'star',
  [ItemType.Lightning]: 'battery', // unreachable
  [ItemType.Ghost]: 'ninja',
  [ItemType.Bullet]: 'bullet',
  [ItemType.BlueShell]: 'blueShell',
  [ItemType.Coin]: 'star', // unreachable — coins are removed
  [ItemType.Squid]: 'bottle', // unreachable
};

/**
 * Items that come as a set of three.
 *
 * EMPTY as of P0d-D5 — every item is single-tier now, so nothing auto-orbits on
 * pickup. The set (and `itemUses`) survive so a triple forced through
 * `grantItem()` still behaves like a triple, and so the hold-to-shield path in
 * `ItemSystem.updateOrbits` keeps working for a single Rocket or Bottle.
 */
export const TRIPLE_ITEMS: ReadonlySet<ItemType> = new Set<ItemType>();

export const ITEM_NAMES: Record<ItemType, string> = {
  [ItemType.Boost]: 'Battery',
  [ItemType.TripleBoost]: 'Battery',
  [ItemType.GreenShell]: 'Green Shell',
  [ItemType.TripleGreenShell]: 'Green Shell',
  [ItemType.RedShell]: 'Rocket',
  [ItemType.TripleRedShell]: 'Rocket',
  [ItemType.Banana]: 'Plastic Bottle',
  [ItemType.TripleBanana]: 'Plastic Bottle',
  [ItemType.Bomb]: 'Bob-omb',
  [ItemType.Star]: 'Star',
  [ItemType.Lightning]: 'Lightning',
  [ItemType.Ghost]: 'Ninja',
  [ItemType.Bullet]: 'Bullet',
  [ItemType.BlueShell]: 'Blue Shell',
  [ItemType.Coin]: 'Coin', // unreachable — kept only to keep the record total
  [ItemType.Squid]: 'Squid Ink',
};

export interface IconRect { x: number; y: number; w: number; h: number }

/**
 * Names of the animatable sub-parts inside a prototype. Look them up with
 * `Object3D.getObjectByName` once, right after `create()` — never per frame,
 * and never via userData (see the note in buildBomb).
 */
export const PART = {
  fuseSpark: 'fuseSpark',
  starFlare: 'starFlare',
  thrusterFlame: 'thrusterFlame',
  /** The rocket's exhaust plume — scaled by Projectiles while it flies. */
  rocketFlame: 'rocketFlame',
} as const;

// ---------------------------------------------------------------------------
// ICON ATLAS LAYOUT — ONE SOURCE OF TRUTH
// ---------------------------------------------------------------------------

/**
 * Every `ItemType`, ascending.
 *
 * DERIVED from `MODEL_FOR_ITEM`, which TypeScript forces to stay total over the
 * enum, so this list cannot go out of step with `src/core/Types.ts` — add or
 * remove an enum member and the record fails to compile until it is handled,
 * and this array follows for free. Three separate places used to hardcode
 * `for (let i = 0; i < 16; i++)`.
 *
 * NOTE this is the ENUM, not the shipping item set: ten of its sixteen members
 * are unreachable (see `MODEL_FOR_ITEM`). The atlas is built from `ICON_ITEMS`
 * below, never from this.
 */
export const ALL_ITEM_TYPES: readonly ItemType[] = Object.keys(MODEL_FOR_ITEM)
  .map((k) => Number(k) as ItemType)
  .sort((a, b) => (a as number) - (b as number));

/**
 * The items that get an atlas cell: exactly the live set, in the roulette's own
 * reading order.
 *
 * ⚠️ THIS IS THE RECONCILIATION. The atlas used to be a 4x4 grid indexed by raw
 * enum ordinal — sixteen cells, nine distinct artworks, five shipping items.
 * ELEVEN cells held art for something no roll can produce (the bob-omb, the
 * spiked blue shell, both green shells, the bullet, and the triples), and because
 * the three deleted items had to keep pointing at a surviving prototype to hold
 * `MODEL_FOR_ITEM` total, SEVEN cells were byte-for-byte duplicates of another
 * cell: Lightning re-baked the battery, Coin the star, Squid the bottle, and each
 * triple its own base. A dead or duplicated cell is not inert — it is what makes
 * an off-by-one in the row/column maths (the P0d bug recorded on `getIconUV`)
 * display another item's artwork instead of nothing at all, so the failure is
 * invisible in review and obvious in a race.
 *
 * Deriving the cell list from `LIVE_ITEMS` makes both halves structural rather
 * than promised: there is exactly one cell per live item, and no cell exists for
 * an item that no longer exists. `getIconUV()` returns `null` outside this set,
 * which the HUD already handles by drawing the same artwork on demand instead —
 * so a `grantItem()` cheat still shows a bob-omb without the atlas carrying one.
 */
export const ICON_ITEMS: readonly ItemType[] = LIVE_ITEMS;

/**
 * Cell size, and a single row. 256 px is the authored size; the divisor keeps a
 * grown item set inside the 2048 px texture every GPU we target guarantees.
 */
const ATLAS_CELL = Math.min(256, Math.max(64, Math.floor(2048 / Math.max(1, ICON_ITEMS.length))));
const ATLAS_COLS = Math.max(1, ICON_ITEMS.length);
const ATLAS_ROWS = 1;
const ATLAS_W = ATLAS_COLS * ATLAS_CELL;
const ATLAS_H = ATLAS_ROWS * ATLAS_CELL;

/** Position of an item in `ICON_ITEMS`, or -1. Linear: the set has five members. */
function iconIndex(item: ItemType): number {
  for (let i = 0; i < ICON_ITEMS.length; i++) if (ICON_ITEMS[i] === item) return i;
  return -1;
}

/**
 * Which cell of the atlas belongs to an item, or `null` for an item that has no
 * cell. **The only place the index -> grid mapping is written.**
 *
 * `getIconPixelRect`, `getIconUV` and the bake loop all route through this, so
 * the cell the artwork is drawn into and the cell the HUD samples are the same
 * expression by construction, not by two authors agreeing.
 *
 * It takes the enum value, not a name: `iconAtlasCell('rocket' as never)` finds
 * nothing, which is a correct answer and not evidence of a collapsed mapping.
 */
export function iconAtlasCell(item: ItemType): { col: number; row: number } | null {
  const i = iconIndex(item);
  if (i < 0) return null;
  return { col: i % ATLAS_COLS, row: Math.floor(i / ATLAS_COLS) };
}

/**
 * Owns every item prototype, its materials, and the HUD icon atlas.
 * Prototypes are cloned (sharing geometry + materials) whenever the game needs
 * another instance, so the pools cost nothing but Object3D bookkeeping.
 */
export class ItemModels {
  private protos = new Map<ItemModelId, THREE.Object3D>();
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private texs: THREE.Texture[] = [];

  /** Materials whose metalness needs an environment map to read correctly. */
  private metalMats: Array<{ mat: THREE.MeshStandardMaterial; full: number; fallback: number }> = [];
  private envApplied = false;

  private atlas: THREE.Texture | null = null;
  /** Answer for `getIconAtlas()` before `init()` — never mistaken for the bake. */
  private stubAtlas: THREE.Texture | null = null;
  private atlasCanvas: HTMLCanvasElement | null = null;
  private uvRects = new Map<ItemType, IconRect>();

  /** Additive flare sprite shared by star / bullet / boost trails. */
  flareTexture: THREE.Texture | null = null;
  /** Soft radial glow used by explosions and item-box cores. */
  glowTexture: THREE.Texture | null = null;
  /** Small 4-point spark, additive. */
  sparkTexture: THREE.Texture | null = null;

  private ready = false;

  async init(): Promise<void> {
    if (this.ready) return;
    this.buildSharedTextures();

    this.protos.set('greenShell', this.buildShell(0x2fbf3f, 0x0d6b1c, false));
    this.protos.set('blueShell', this.buildShell(0x2b6fe8, 0x0d2f80, true));
    this.protos.set('bomb', this.buildBomb());
    // --- P0d-D5 re-skins ---
    this.protos.set('rocket', this.buildRocket());
    this.protos.set('bottle', this.buildBottle());
    this.protos.set('battery', this.buildBattery());
    this.protos.set('ninja', this.buildNinja());
    // --- retained ---
    this.protos.set('star', this.buildStar());
    this.protos.set('bullet', this.buildBullet());

    // Canvas 2D, no GL, no await — the icon sheet is ready the moment `init()`
    // returns, so no consumer can race it and get a placeholder.
    this.bakeIconAtlas();
    this.ready = true;
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  /** Fresh instance of a model. Geometry + materials are shared. */
  create(id: ItemModelId): THREE.Object3D {
    const proto = this.protos.get(id);
    if (!proto) {
      // Never throw during a race — hand back an invisible placeholder.
      return new THREE.Group();
    }
    const o = proto.clone(true);
    o.visible = true;
    return o;
  }

  createForItem(item: ItemType): THREE.Object3D {
    return this.create(MODEL_FOR_ITEM[item]);
  }

  /**
   * The baked icon sheet.
   *
   * ⚠️ The stub for "asked before `init()`" is deliberately NOT cached into
   * `this.atlas`. It used to be, and that is a trap with teeth: the HUD copies
   * the atlas once, with `toDataURL()`, the first time it is handed the items
   * module. One early call — a HUD built before `items.init()` resolves — would
   * have permanently pinned every item slot to a 4x4 white square, with no
   * warning anywhere, because `getIconAtlas()` had quietly answered its own
   * question and the real bake then replaced a field nobody would read again.
   */
  getIconAtlas(): THREE.Texture {
    if (this.atlas) return this.atlas;
    if (!this.stubAtlas) {
      const ctx = make2d(ATLAS_CELL);
      ctx.canvas.width = ATLAS_W;
      ctx.canvas.height = ATLAS_H;
      drawIconAtlas(ctx, ATLAS_CELL);
      this.stubAtlas = canvasTexture(ctx);
      this.stubAtlas.flipY = false; // same convention as the baked atlas
      this.texs.push(this.stubAtlas);
    }
    return this.stubAtlas;
  }

  /**
   * Normalised rect of an item's cell, **origin TOP-LEFT — image space**, i.e.
   * the same corner `getIconPixelRect` and the atlas canvas itself use.
   *
   * `null` for an item with no cell — everything outside `ICON_ITEMS`. The HUD
   * (`ItemIcons.apply`) already treats a missing rect as "draw the artwork
   * yourself", and it draws it with the same painters this atlas was baked from,
   * so a forced `grantItem(Bomb)` still shows a bob-omb.
   *
   * ⚠️ THIS CONVENTION IS LOAD-BEARING AND WAS THE P0d ICON BUG. The only
   * consumer is the HUD (`ItemIcons.useAtlas` -> `apply`), which turns the rect
   * into a CSS `background-position`, and CSS has no other origin: 0 % is the
   * TOP of the image. This used to return `y = 1 - (row+1)/rows` — correct for a
   * THREE texture with the default `flipY = true`, and therefore mirrored
   * vertically once the DOM read it. Displayed row was `rows-1-row`, so all five
   * live items showed another item's artwork: the Plastic Bottle drew the
   * BATTERY (cell 10), the Battery drew the Bullet, the Rocket drew the Bob-omb,
   * the Star drew the Rocket and the Ninja drew the Bottle. Nobody noticed for
   * as long as `Game.ts` forgot `hud.setItems(this.items)`, because the HUD was
   * silently painting its own fallback drawings instead.
   *
   * The texture returned by `getIconAtlas()` carries `flipY = false` so that
   * these same rects are correct as THREE UVs too — one convention, both
   * consumers. Asserted in both directions by `.probe-tmp/icons.ts`.
   */
  getIconUV(item: ItemType): IconRect | null {
    return this.uvRects.get(item) ?? null;
  }

  /** Raw canvas — handy for a 2D/DOM HUD that wants drawImage instead of UVs. */
  getIconCanvas(): HTMLCanvasElement | null { return this.atlasCanvas; }

  /** Pixel rect within the atlas canvas, origin top-left. `null` if it has no cell. */
  getIconPixelRect(item: ItemType): IconRect | null {
    const cell = iconAtlasCell(item);
    if (!cell) return null;
    return { x: cell.col * ATLAS_CELL, y: cell.row * ATLAS_CELL, w: ATLAS_CELL, h: ATLAS_CELL };
  }

  /**
   * Metals need image-based lighting. If the scene has no `environment` yet
   * (the Lighting agent may still be booting) we temporarily flatten metalness
   * so nothing renders as a black blob, then restore it once IBL appears.
   */
  syncEnvironment(scene: THREE.Scene): void {
    const has = scene.environment !== null && scene.environment !== undefined;
    if (has === this.envApplied) return;
    this.envApplied = has;
    for (const m of this.metalMats) {
      m.mat.metalness = has ? m.full : m.fallback;
      m.mat.envMapIntensity = has ? 1.15 : 1.0;
      m.mat.needsUpdate = false;
    }
  }

  // -------------------------------------------------------------------------
  // Shared sprite textures
  // -------------------------------------------------------------------------

  private buildSharedTextures(): void {
    // Soft glow
    {
      const ctx = make2d(128);
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0.0, 'rgba(255,255,255,1)');
      g.addColorStop(0.25, 'rgba(255,255,255,0.62)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.16)');
      g.addColorStop(1.0, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      this.glowTexture = canvasTexture(ctx);
      this.texs.push(this.glowTexture);
    }
    // Anamorphic-ish flare: core + horizontal streak + 6 spikes
    {
      const ctx = make2d(256);
      const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 60);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(255,244,190,0.45)');
      g.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        ctx.save();
        ctx.translate(128, 128);
        ctx.rotate((i / 6) * Math.PI * 2);
        const lg = ctx.createLinearGradient(0, 0, 124, 0);
        lg.addColorStop(0, 'rgba(255,255,255,0.85)');
        lg.addColorStop(1, 'rgba(255,230,150,0)');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.moveTo(0, -7);
        ctx.lineTo(124, 0);
        ctx.lineTo(0, 7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      this.flareTexture = canvasTexture(ctx);
      this.texs.push(this.flareTexture);
    }
    // 4-point spark
    {
      const ctx = make2d(64);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        ctx.save();
        ctx.translate(32, 32);
        ctx.rotate((i / 4) * Math.PI * 2);
        const lg = ctx.createLinearGradient(0, 0, 30, 0);
        lg.addColorStop(0, 'rgba(255,255,255,1)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.moveTo(0, -2.4);
        ctx.lineTo(30, 0);
        ctx.lineTo(0, 2.4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      this.sparkTexture = canvasTexture(ctx);
      this.texs.push(this.sparkTexture);
    }
  }

  // -------------------------------------------------------------------------
  // Registration helpers
  // -------------------------------------------------------------------------

  private reg<T extends THREE.BufferGeometry>(g: T): T { this.geoms.push(g); return g; }
  private regM<T extends THREE.Material>(m: T): T { this.mats.push(m); return m; }
  private regT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t; }

  private trackMetal(mat: THREE.MeshStandardMaterial, full: number, fallback: number): void {
    this.metalMats.push({ mat, full, fallback });
    mat.metalness = fallback;
  }

  // -------------------------------------------------------------------------
  // SHELLS — a real spiral carapace, not a coloured sphere
  // -------------------------------------------------------------------------

  private shellSwirl(u: number, v: number): number {
    // Bands are straight diagonals in (angle, radius) space, which becomes a
    // true Archimedean swirl once the lathe wraps it round the dome.
    const turns = 1.35;
    const s = (u - v * turns) % 1;
    const w = s < 0 ? s + 1 : s;
    let d = 1;
    for (let k = 0; k < 3; k++) d = Math.min(d, wrapDist(w, k / 3));
    const edge = 0.5 - Math.abs(v - 0.5);
    const band = 1 - smoothstep((d - 0.035) / 0.075);
    return band * smoothstep(edge / 0.16);
  }

  private buildShell(top: number, deep: number, spiky: boolean): THREE.Group {
    const g = new THREE.Group();
    const R = 0.52;
    const H = 0.40;

    // --- carapace textures ---------------------------------------------------
    const cTop = new THREE.Color(top);
    const cDeep = new THREE.Color(deep);
    const cHi = cTop.clone().lerp(new THREE.Color(0xffffff), 0.42);
    const albedo = this.regT(pixelTexture(512, (u, v, o) => {
      const swirl = this.shellSwirl(u, v);
      const grain = ringNoise(u, v, 7, 4);
      // Vertical shading ramp: brighter at the apex, richer toward the rim.
      const ramp = clamp01(0.24 + (1 - v) * 0.9);
      const c = cDeep.clone().lerp(cTop, ramp).lerp(cHi, Math.pow(1 - v, 3) * 0.55);
      c.lerp(cDeep, swirl * 0.85);
      // Iridescent hue drift + fine speckle, keeps large areas from going flat.
      const drift = (ringNoise(u * 0.5, v * 0.5, 2, 2) - 0.5) * 0.09;
      c.offsetHSL(drift, 0.04, (grain - 0.5) * 0.07);
      // Dark contact line where the carapace meets the rim.
      c.multiplyScalar(1 - smoothstep((v - 0.86) / 0.14) * 0.35);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const normal = this.regT(normalFromHeight(256, (u, v) => {
      const swirl = this.shellSwirl(u, v);
      // Raised ridges either side of each swirl band + orange-peel grain.
      return 0.5 - swirl * 0.34 + ringNoise(u, v, 16, 3) * 0.055;
    }, 2.4));
    const rough = this.regT(pixelTexture(256, (u, v, o) => {
      const swirl = this.shellSwirl(u, v);
      const r = 0.16 + swirl * 0.22 + ringNoise(u, v, 12, 3) * 0.12 + v * 0.08;
      const q = Math.round(clamp01(r) * 255);
      o.r = q; o.g = q; o.b = q;
    }, false));

    const carapace = this.regM(new THREE.MeshPhysicalMaterial({
      map: albedo,
      normalMap: normal,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughnessMap: rough,
      roughness: 1.0,
      metalness: 0.02,
      clearcoat: 1.0,
      clearcoatRoughness: 0.075,
      iridescence: 0.42,
      iridescenceIOR: 1.35,
      iridescenceThicknessRange: [120, 480],
      sheen: 0.35,
      sheenColor: cHi,
      sheenRoughness: 0.5,
      envMapIntensity: 1.15,
    }));

    // --- dome ----------------------------------------------------------------
    const domePts: THREE.Vector2[] = [];
    const N = 26;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 0.5;
      const r = R * Math.pow(Math.sin(a), 0.76);
      const y = H * Math.pow(Math.cos(a), 1.08);
      domePts.push(new THREE.Vector2(Math.max(0.0006, r), y));
    }
    const dome = new THREE.Mesh(this.reg(lathe(domePts, 64)), carapace);
    dome.castShadow = true;
    dome.receiveShadow = true;
    g.add(dome);

    // --- rim + belly (cream underside) --------------------------------------
    const cream = new THREE.Color(0xfaf0d8);
    const creamTex = this.regT(pixelTexture(256, (u, v, o) => {
      const c = cream.clone();
      c.lerp(new THREE.Color(0xd6c39a), smoothstep((v - 0.15) / 0.85) * 0.55);
      const n = ringNoise(u, v, 9, 3);
      c.offsetHSL(0, 0, (n - 0.5) * 0.06);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const creamMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: creamTex,
      roughness: 0.42,
      metalness: 0.0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.3,
      sheen: 0.5,
      sheenColor: new THREE.Color(0xfff6e2),
      envMapIntensity: 1.0,
    }));

    const rimPts: THREE.Vector2[] = [
      new THREE.Vector2(R * 0.995, 0.012),
      new THREE.Vector2(R * 1.055, -0.012),
      new THREE.Vector2(R * 1.062, -0.052),
      new THREE.Vector2(R * 1.01, -0.086),
      new THREE.Vector2(R * 0.90, -0.108),
      new THREE.Vector2(R * 0.66, -0.135),
      new THREE.Vector2(R * 0.34, -0.152),
      new THREE.Vector2(0.0006, -0.158),
    ];
    const rim = new THREE.Mesh(this.reg(lathe(rimPts, 64)), creamMat);
    rim.castShadow = true;
    g.add(rim);

    // --- blue shell extras: crown of spikes + stubby wings --------------------
    if (spiky) {
      const spikeMat = this.regM(new THREE.MeshPhysicalMaterial({
        color: 0xf2f6ff,
        roughness: 0.24,
        metalness: 0.1,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
        sheen: 0.4,
        sheenColor: new THREE.Color(0xbcd4ff),
        envMapIntensity: 1.2,
      }));
      const spikeGeo = this.reg(new THREE.ConeGeometry(0.075, 0.30, 12, 3));
      spikeGeo.translate(0, 0.15, 0);
      const ring = 8;
      for (let i = 0; i < ring; i++) {
        const a = (i / ring) * Math.PI * 2;
        const s = new THREE.Mesh(spikeGeo, spikeMat);
        const rr = R * 0.70;
        s.position.set(Math.cos(a) * rr, H * 0.30, Math.sin(a) * rr);
        s.lookAt(Math.cos(a) * rr * 2.2, H * 0.30 + 0.55, Math.sin(a) * rr * 2.2);
        s.rotateX(Math.PI / 2);
        s.castShadow = true;
        g.add(s);
      }
      const crown = new THREE.Mesh(this.reg(new THREE.ConeGeometry(0.09, 0.34, 14, 3)), spikeMat);
      crown.position.y = H + 0.14;
      crown.castShadow = true;
      g.add(crown);

      // Little wings — the spiny shell flies.
      const wingShape = new THREE.Shape();
      wingShape.moveTo(0, 0);
      wingShape.quadraticCurveTo(0.26, 0.14, 0.42, 0.02);
      wingShape.quadraticCurveTo(0.30, -0.02, 0.34, -0.13);
      wingShape.quadraticCurveTo(0.18, -0.12, 0.12, -0.16);
      wingShape.quadraticCurveTo(0.05, -0.10, 0, 0);
      const wingGeo = this.reg(new THREE.ExtrudeGeometry(wingShape, {
        depth: 0.028, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2, curveSegments: 8,
      }));
      const wingMat = this.regM(new THREE.MeshPhysicalMaterial({
        color: 0xffffff, roughness: 0.3, metalness: 0.0, clearcoat: 0.8,
        sheen: 0.6, sheenColor: new THREE.Color(0xcfe2ff), envMapIntensity: 1.1,
      }));
      for (const s of [1, -1]) {
        const w = new THREE.Mesh(wingGeo, wingMat);
        w.position.set(s * R * 0.72, H * 0.42, 0);
        w.rotation.set(0, s > 0 ? -Math.PI / 2 : Math.PI / 2, s > 0 ? 0.4 : 0.4);
        w.scale.x = s;
        g.add(w);
      }
    }

    g.userData.spinAxis = 'y';
    return g;
  }

  // -------------------------------------------------------------------------
  // ROCKET  (replaces the red shell — homes on the kart ahead)
  // -------------------------------------------------------------------------

  /**
   * A stubby model rocket: ogive nose, banded body, three swept fins, a flared
   * nozzle and a live exhaust plume.
   *
   * ORIENTATION MATTERS HERE. The profile is lathed about +Y and then rotated
   * `-π/2` about X, which maps +Y -> -Z, so the nose points down the project's
   * forward axis (AGENTS §2). `Projectiles.update` can then aim -Z along the
   * velocity and the rocket flies nose-first. The red shell it replaces was
   * spun about Y instead, which for a rocket would read as a helicopter blade —
   * that visual branch is changed in Projectiles alongside this.
   *
   * Readability at HUD size comes from three things, in order: the red-on-white
   * two-tone split at the nose, the fin triangle breaking the cylinder's
   * silhouette, and the emissive plume.
   */
  private buildRocket(): THREE.Group {
    const g = new THREE.Group();
    const R = 0.195;
    const NOSE_Y = 0.62;
    const BODY_TOP = 0.24;
    const BODY_BOT = -0.24;

    // --- profile: nose tip -> nozzle lip -----------------------------------
    const pts: THREE.Vector2[] = [];
    const NN = 14;
    for (let i = 0; i <= NN; i++) {
      // Ogive: r = R * sin^0.62(a) gives a fuller, less needle-like nose.
      const a = (i / NN) * Math.PI * 0.5;
      pts.push(new THREE.Vector2(
        Math.max(0.0006, R * Math.pow(Math.sin(a), 0.62)),
        BODY_TOP + (NOSE_Y - BODY_TOP) * Math.cos(a),
      ));
    }
    pts.push(new THREE.Vector2(R, BODY_BOT + 0.10));
    // Boat-tail into the throat, then flare out to the nozzle lip.
    pts.push(new THREE.Vector2(R * 0.86, BODY_BOT - 0.02));
    pts.push(new THREE.Vector2(R * 0.62, BODY_BOT - 0.09));
    pts.push(new THREE.Vector2(R * 0.90, BODY_BOT - 0.20));
    pts.push(new THREE.Vector2(R * 1.02, BODY_BOT - 0.24));
    pts.push(new THREE.Vector2(R * 0.74, BODY_BOT - 0.245));
    pts.push(new THREE.Vector2(0.0006, BODY_BOT - 0.20));

    // v runs nose(0) -> nozzle(1) along the profile.
    const NOSE_END = NN / (pts.length - 1);
    const TAIL_START = (NN + 2) / (pts.length - 1);

    const cRed = new THREE.Color(0xe33a26);
    const cRedDeep = new THREE.Color(0x8e1a10);
    const cShell = new THREE.Color(0xeef1f6);
    const cShellShade = new THREE.Color(0xa8b0bd);
    const cGraphite = new THREE.Color(0x2a2f3a);

    /** Ring grooves + rivets + the raised chevron band, as a height field. */
    const relief = (u: number, v: number): number => {
      let h = 0.5;
      // Two panel joint rings.
      for (const rv of [0.42, 0.66]) h -= (1 - smoothstep((Math.abs(v - rv) - 0.004) / 0.012)) * 0.16;
      // Rivet line around the shoulder.
      const rivet = Math.abs(Math.sin(u * Math.PI * 22));
      h += (1 - smoothstep((Math.abs(v - 0.36) - 0.004) / 0.010)) * Math.pow(rivet, 8) * 0.20;
      // Chevron band: a saw wave in (u,v) so it reads as painted-on relief.
      const saw = Math.abs(((u * 8 + v * 3) % 1) - 0.5) * 2;
      if (v > 0.48 && v < 0.62) h += (1 - smoothstep((saw - 0.55) / 0.25)) * 0.08;
      return h + ringNoise(u, v, 24, 3) * 0.05;
    };

    const albedo = this.regT(pixelTexture(512, (u, v, o) => {
      const noseK = 1 - smoothstep((v - NOSE_END * 0.86) / 0.10);
      const tailK = smoothstep((v - TAIL_START * 0.97) / 0.06);
      const shade = clamp01(0.30 + Math.pow(Math.sin(u * Math.PI), 0.7) * 0.85);
      // Body: cool white with a lit side, so the cylinder never reads flat.
      const c = cShellShade.clone().lerp(cShell, shade);
      // Nose cone: red, hottest at the tip.
      c.lerp(cRedDeep.clone().lerp(cRed, shade), noseK);
      // Warning chevrons around the waist.
      const saw = Math.abs(((u * 8 + v * 3) % 1) - 0.5) * 2;
      if (v > 0.48 && v < 0.62) {
        c.lerp(saw < 0.5 ? cRed : cGraphite, (1 - smoothstep((Math.abs(v - 0.55) - 0.045) / 0.02)) * 0.9);
      }
      // A single crisp red band under the nose reads as "rocket" instantly.
      c.lerp(cRed, (1 - smoothstep((Math.abs(v - 0.40) - 0.012) / 0.010)) * 0.95);
      // Nozzle: scorched graphite.
      c.lerp(cGraphite, tailK);
      // Grain + a touch of AO in the ring grooves.
      const h = relief(u, v);
      c.multiplyScalar(0.78 + clamp01(h) * 0.44);
      const n = ringNoise(u, v, 11, 4);
      c.offsetHSL(0, 0, (n - 0.5) * 0.05);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const normal = this.regT(normalFromHeight(256, relief, 2.6));
    const rough = this.regT(pixelTexture(256, (u, v, o) => {
      // Painted shell is glossy; the nozzle end is burnt and matte.
      const r = 0.18 + smoothstep((v - TAIL_START * 0.9) / 0.12) * 0.55
        + ringNoise(u, v, 14, 3) * 0.10;
      const q = Math.round(clamp01(r) * 255);
      o.r = q; o.g = q; o.b = q;
    }, false));

    const shellMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: albedo,
      normalMap: normal,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughnessMap: rough,
      roughness: 1.0,
      metalness: 0.22,
      clearcoat: 1.0,
      clearcoatRoughness: 0.07,
      sheen: 0.3,
      sheenColor: new THREE.Color(0xffd9cf),
      envMapIntensity: 1.2,
    }));
    this.trackMetal(shellMat, 0.22, 0.10);

    const body = new THREE.Mesh(this.reg(lathe(pts, 48)), shellMat);
    body.rotation.x = -Math.PI / 2; // +Y -> -Z: nose forward
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // --- fins ---------------------------------------------------------------
    // Swept delta with a rounded trailing corner, extruded and bevelled so the
    // edge catches the rim light instead of aliasing into a black line.
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0.16);
    finShape.quadraticCurveTo(0.10, 0.05, 0.28, -0.14);
    finShape.quadraticCurveTo(0.20, -0.20, 0.06, -0.21);
    finShape.lineTo(0, -0.18);
    finShape.closePath();
    const finGeo = this.reg(new THREE.ExtrudeGeometry(finShape, {
      depth: 0.030, bevelEnabled: true, bevelSize: 0.012,
      bevelThickness: 0.010, bevelSegments: 2, curveSegments: 8,
    }));
    finGeo.translate(0, 0, -0.015);
    const finMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xd8352a,
      roughness: 0.26,
      metalness: 0.18,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      sheen: 0.4,
      sheenColor: new THREE.Color(0xffb0a4),
      envMapIntensity: 1.25,
    }));
    for (let i = 0; i < 3; i++) {
      // rotation.x = -PI/2 maps the shape's +Y (chord) onto -Z and its extrusion
      // axis onto +Y (thickness), so the fin plane contains the body axis.
      const fin = new THREE.Mesh(finGeo, finMat);
      fin.rotation.x = -Math.PI / 2;
      // Root buried inside the skin, chord sitting over the boat-tail.
      fin.position.set(R * 0.55, 0, 0.14);
      fin.castShadow = true;
      const holder = new THREE.Group();
      holder.rotation.z = (i / 3) * Math.PI * 2;
      holder.add(fin);
      g.add(holder);
    }

    // --- exhaust ------------------------------------------------------------
    const flameMat = this.regM(new THREE.MeshBasicMaterial({
      color: 0xffb347,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const flame = new THREE.Mesh(this.reg(new THREE.ConeGeometry(0.155, 0.62, 18, 3, true)), flameMat);
    flame.rotation.x = Math.PI / 2; // tip trailing at +Z, mouth on the nozzle
    flame.position.z = 0.76;
    flame.name = PART.rocketFlame;
    g.add(flame);

    const glow = new THREE.Sprite(this.regM(new THREE.SpriteMaterial({
      map: this.glowTexture!,
      color: 0xffcf7a,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.85,
    })));
    glow.scale.setScalar(0.78);
    glow.position.z = 0.50;
    g.add(glow);

    return g;
  }

  // -------------------------------------------------------------------------
  // PLASTIC BOTTLE  (replaces the banana — a small obstacle)
  // -------------------------------------------------------------------------

  /**
   * A PET drinks bottle: petaloid base, ribbed body, threaded neck, coloured cap
   * and a printed shrink label.
   *
   * Built lathed about +Y and then laid on its side (+Y -> -X) because that is
   * how it comes to rest on the road: `Projectiles.stepBanana` settles the
   * obstacle and hands `update()` the ground normal as the node's up axis, so
   * the model's local +Y has to be the bottle's *up when standing*, not its long
   * axis.
   *
   * The clear body would vanish at HUD-icon size, so the label is a separate
   * opaque sleeve in a saturated teal with a white cap band. That sleeve is
   * doing all the icon-scale legibility work.
   */
  private buildBottle(): THREE.Group {
    const g = new THREE.Group();
    const stand = new THREE.Group(); // upright bottle, rotated as a whole below
    const R = 0.135;

    // --- profile: base -> cap ----------------------------------------------
    const pts: THREE.Vector2[] = [
      new THREE.Vector2(0.0006, -0.345),
      new THREE.Vector2(0.055, -0.375),
      new THREE.Vector2(0.100, -0.385),
      new THREE.Vector2(0.124, -0.360),
      new THREE.Vector2(R, -0.300),
      new THREE.Vector2(R, -0.170),
      new THREE.Vector2(R * 0.93, -0.140),   // rib
      new THREE.Vector2(R, -0.110),
      new THREE.Vector2(R, -0.010),
      new THREE.Vector2(R * 0.93, 0.020),    // rib
      new THREE.Vector2(R, 0.050),
      new THREE.Vector2(R, 0.120),
      new THREE.Vector2(R * 0.86, 0.200),    // shoulder
      new THREE.Vector2(R * 0.58, 0.268),
      new THREE.Vector2(R * 0.40, 0.310),
      new THREE.Vector2(0.052, 0.340),
      new THREE.Vector2(0.052, 0.392),       // neck
      new THREE.Vector2(0.074, 0.398),       // cap lip
      new THREE.Vector2(0.074, 0.474),
      new THREE.Vector2(0.062, 0.486),
      new THREE.Vector2(0.0006, 0.492),
    ];

    // Clear PET: transmission plus a very slight green cast, and a normal map of
    // stress lines so it does not read as smooth glass.
    const petNrm = this.regT(normalFromHeight(256, (u, v) =>
      0.5
      + Math.sin(v * Math.PI * 26) * 0.012
      + ringNoise(u * 1.4, v * 2.2, 9, 4) * 0.09
      // A couple of crush creases: this bottle is litter, not shop stock.
      + (1 - smoothstep((Math.abs(v - 0.46) - 0.01) / 0.03)) * Math.sin(u * Math.PI * 5) * 0.10,
    1.9));
    const petMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xd8f2ea,
      normalMap: petNrm,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.10,
      metalness: 0.0,
      transmission: 0.88,
      thickness: 0.22,
      ior: 1.46,
      transparent: true,
      opacity: 0.62,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      attenuationColor: new THREE.Color(0x9fe8d4),
      attenuationDistance: 0.55,
      side: THREE.DoubleSide,
      envMapIntensity: 1.35,
      depthWrite: false,
    }));
    const shell = new THREE.Mesh(this.reg(lathe(pts, 44)), petMat);
    shell.castShadow = true;
    stand.add(shell);

    // --- cap ---------------------------------------------------------------
    const capTex = this.regT(pixelTexture(128, (u, v, o) => {
      // Vertical knurling round the cap, plus a moulded top.
      const knurl = Math.abs(Math.sin(u * Math.PI * 26)) > 0.45 ? 1 : 0;
      const c = new THREE.Color(0x2f6ef0).offsetHSL(0, 0, knurl * 0.06 - 0.03);
      c.lerp(new THREE.Color(0x1b3f9c), smoothstep(v) * 0.45);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const capNrm = this.regT(normalFromHeight(128, (u) =>
      0.5 + (Math.abs(Math.sin(u * Math.PI * 26)) > 0.45 ? 0.12 : 0), 2.2));
    const capMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: capTex,
      normalMap: capNrm,
      roughness: 0.34,
      metalness: 0.0,
      clearcoat: 0.9,
      clearcoatRoughness: 0.14,
      sheen: 0.4,
      sheenColor: new THREE.Color(0x9fc0ff),
      envMapIntensity: 1.1,
    }));
    const cap = new THREE.Mesh(
      this.reg(new THREE.CylinderGeometry(0.079, 0.079, 0.082, 28, 1)),
      capMat,
    );
    cap.position.y = 0.436;
    cap.castShadow = true;
    stand.add(cap);
    const capTop = new THREE.Mesh(this.reg(new THREE.CircleGeometry(0.079, 28)), capMat);
    capTop.rotation.x = -Math.PI / 2;
    capTop.position.y = 0.4775;
    stand.add(capTop);

    // --- label sleeve -------------------------------------------------------
    const labelTex = this.regT(pixelTexture(512, (u, v, o) => {
      const teal = new THREE.Color(0x0f9d8c);
      const dark = new THREE.Color(0x075a52);
      const white = new THREE.Color(0xf4fbf9);
      // Base: teal with a lit side.
      const c = dark.clone().lerp(teal, clamp01(0.35 + Math.pow(Math.sin(u * Math.PI), 0.7) * 0.8));
      // Two white bands top and bottom — this is the icon-scale read.
      c.lerp(white, 1 - smoothstep((Math.abs(v - 0.12) - 0.035) / 0.02));
      c.lerp(white, 1 - smoothstep((Math.abs(v - 0.88) - 0.030) / 0.02));
      // A big soft droplet mark in the middle third.
      const dx = (((u * 3) % 1) - 0.5) * 1.5;
      const dy = (v - 0.5) * 2.1;
      const drop = Math.hypot(dx, dy * (dy < 0 ? 0.7 : 1.35));
      c.lerp(white, (1 - smoothstep((drop - 0.30) / 0.06)) * 0.85);
      // Barcode block, bottom right of each repeat.
      if (v > 0.66 && v < 0.80 && ((u * 3) % 1) > 0.62 && ((u * 3) % 1) < 0.92) {
        const bar = Math.floor(u * 260) % 2 === 0 ? 1 : 0;
        c.lerp(bar ? new THREE.Color(0x101418) : white, 0.9);
      }
      const n = ringNoise(u, v, 16, 3);
      c.offsetHSL(0, 0, (n - 0.5) * 0.04);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const labelNrm = this.regT(normalFromHeight(256, (u, v) =>
      // Shrink-wrap wrinkles, strongest near the sleeve edges.
      0.5 + ringNoise(u * 2.0, v, 20, 3) * 0.11 * (0.35 + Math.abs(v - 0.5) * 1.3), 1.6));
    const labelMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: labelTex,
      normalMap: labelNrm,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.30,
      metalness: 0.0,
      clearcoat: 0.85,
      clearcoatRoughness: 0.22,
      sheen: 0.5,
      sheenColor: new THREE.Color(0xbff4ea),
      envMapIntensity: 1.15,
      side: THREE.DoubleSide,
    }));
    const label = new THREE.Mesh(
      this.reg(new THREE.CylinderGeometry(R * 1.012, R * 1.012, 0.255, 44, 1, true)),
      labelMat,
    );
    label.position.y = -0.075;
    label.castShadow = true;
    stand.add(label);

    // Lie it down: local +Y stays "up", the bottle's long axis runs along -X.
    // The group origin is left on the bottle's AXIS, not on the ground, because
    // `Projectiles` positions a settled obstacle by its centre and lifts it by
    // `BOTTLE_REST` (= this radius) to seat it on the tarmac.
    stand.rotation.z = Math.PI / 2;
    g.add(stand);
    return g;
  }

  /** Radius of the bottle lying on its side — its rest height above the road. */
  static readonly BOTTLE_REST = 0.145;

  // -------------------------------------------------------------------------
  // BOB-OMB
  // -------------------------------------------------------------------------

  private buildBomb(): THREE.Group {
    const g = new THREE.Group();
    const R = 0.36;

    const albedo = this.regT(pixelTexture(256, (u, v, o) => {
      const base = new THREE.Color(0x12151c);
      const n = ringNoise(u, v, 10, 3);
      base.offsetHSL(0, 0, (n - 0.5) * 0.05 + (1 - v) * 0.05);
      o.r = Math.round(clamp01(base.r) * 255);
      o.g = Math.round(clamp01(base.g) * 255);
      o.b = Math.round(clamp01(base.b) * 255);
    }));
    const bodyMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: albedo,
      roughness: 0.26,
      metalness: 0.85,
      clearcoat: 0.7,
      clearcoatRoughness: 0.16,
      envMapIntensity: 1.25,
    }));
    this.trackMetal(bodyMat, 0.85, 0.32);

    const body = new THREE.Mesh(this.reg(new THREE.SphereGeometry(R, 40, 30)), bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // Fuse — a small S-curve sweep, tapering.
    const fuseCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, R * 0.92, 0),
      new THREE.Vector3(0.05, R + 0.13, -0.03),
      new THREE.Vector3(-0.04, R + 0.24, 0.02),
      new THREE.Vector3(0.06, R + 0.33, -0.01),
    ]);
    const fuseTex = this.regT(pixelTexture(128, (u, v, o) => {
      const braid = Math.abs(Math.sin((u * 9 + v * 3) * Math.PI)) > 0.5 ? 1 : 0;
      const c = new THREE.Color(0xd8c08a).offsetHSL(0, 0, braid * 0.08 - 0.04);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const fuseMat = this.regM(new THREE.MeshStandardMaterial({
      map: fuseTex, roughness: 0.85, metalness: 0.0,
    }));
    const fuse = new THREE.Mesh(this.reg(sweep(fuseCurve, 26, 10, (t) => 0.030 * (1 - t * 0.3))), fuseMat);
    g.add(fuse);

    // Sparking tip — animated by Projectiles via userData.spark
    const sparkMat = this.regM(new THREE.SpriteMaterial({
      map: this.flareTexture!,
      color: 0xfff0b0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 1,
    }));
    const spark = new THREE.Sprite(sparkMat);
    spark.position.copy(fuseCurve.getPointAt(1, new THREE.Vector3()));
    spark.scale.setScalar(0.36);
    // NOTE: animatable sub-parts are found by NAME, never stashed in userData —
    // Object3D.clone() deep-copies userData through JSON and would throw on a
    // live Object3D reference.
    spark.name = PART.fuseSpark;
    g.add(spark);

    // Wind-up key
    const keyMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0xd8dde6, roughness: 0.22, metalness: 0.95, envMapIntensity: 1.3,
    }));
    this.trackMetal(keyMat, 0.95, 0.35);
    const keyRing = new THREE.Mesh(this.reg(new THREE.TorusGeometry(0.10, 0.026, 10, 22)), keyMat);
    keyRing.position.set(0, 0.03, -R * 0.98);
    g.add(keyRing);
    const keyStem = new THREE.Mesh(this.reg(new THREE.CylinderGeometry(0.028, 0.028, 0.13, 10)), keyMat);
    keyStem.rotation.x = Math.PI / 2;
    keyStem.position.set(0, 0.03, -R * 0.92);
    g.add(keyStem);

    // Feet
    const footMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0xf2c33a, roughness: 0.45, metalness: 0.05,
    }));
    const footGeo = this.reg(new THREE.SphereGeometry(0.085, 14, 10));
    footGeo.scale(1.25, 0.62, 1.0);
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(footGeo, footMat);
      f.position.set(s * 0.17, -R * 0.92, 0.05);
      f.castShadow = true;
      g.add(f);
    }

    // Face
    this.addEyes(g, 0.075, new THREE.Vector3(0, 0.10, R * 0.90), 0.115, true);

    return g;
  }

  // -------------------------------------------------------------------------
  // BATTERY  (replaces the mushroom — a speed boost)
  // -------------------------------------------------------------------------

  /**
   * An AA-style cell: steel can, printed wrap, nickel collar, positive nub, and
   * a live charge gauge that actually glows.
   *
   * A plain cylinder is the weakest silhouette of the four re-skins, so three
   * things break it up: the nub on top, the bright collar ring that separates
   * can from wrap, and a bold emissive bolt on the wrap. The bolt is the read at
   * icon size; the nub is the read in silhouette.
   *
   * The bolt is evaluated analytically (a signed-distance test against the same
   * jagged outline `boltShape()` extrudes) rather than drawn on a canvas, so it
   * feeds the albedo, the emissive mask AND the normal map from one function.
   * That also means it survives the headless canvas shim, which no-ops 2D draws.
   */
  private buildBattery(): THREE.Group {
    const g = new THREE.Group();
    const R = 0.225;
    const H = 0.62;

    // --- bolt / gauge field -------------------------------------------------
    // u wraps around the cell, v runs top(0) -> bottom(1) of the wrap.
    const BOLT = BOLT_OUTLINE;
    /** Even-odd point-in-polygon against the bolt outline, in [-1,1] space. */
    const inBolt = (x: number, y: number): boolean => {
      let inside = false;
      for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i++) {
        const [xi, yi] = BOLT[i];
        const [xj, yj] = BOLT[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    /**
     * 1 inside the bolt, feathered over ~1 texel of the 512 map.
     *
     * NOTE the sign of `y`. `DataTexture` defaults to `flipY = false`, so texel
     * row 0 is UV v = 0, which on a `CylinderGeometry` is the BOTTOM of the cell.
     * Bolt-space +y therefore has to increase with v, or the bolt prints upside
     * down — invisible in a code review, obvious on screen.
     */
    const boltMask = (u: number, v: number): number => {
      // One bolt centred on the front face (u = 0.5), 0.34 of the wrap wide.
      const x = (u - 0.5) / 0.17;
      const y = (v - 0.52) / 0.30;
      if (Math.abs(x) > 1.6 || Math.abs(y) > 1.6) return 0;
      let hits = 0;
      // 2x2 supersample: the outline is all diagonals, so a hard test aliases.
      for (const du of [-0.006, 0.006]) {
        for (const dv of [-0.006, 0.006]) {
          if (inBolt(x + du / 0.17, y + dv / 0.30)) hits++;
        }
      }
      return hits / 4;
    };
    /** Four charge segments down the back face (u ≈ 0). */
    const gaugeMask = (u: number, v: number): number => {
      const uu = Math.abs(wrapDist(u, 0.0));
      if (uu > 0.052) return 0;
      const band = ((v - 0.24) / 0.13);
      const i = Math.floor(band);
      if (i < 0 || i > 3) return 0;
      const f = band - i;
      if (f < 0.16 || f > 0.84) return 0;
      return 1 - smoothstep((uu - 0.030) / 0.020);
    };

    const wrapRelief = (u: number, v: number): number => {
      let h = 0.5;
      // Printed ink sits very slightly proud of the wrap.
      h += boltMask(u, v) * 0.10;
      h += gaugeMask(u, v) * 0.08;
      // Two crimp grooves top and bottom where the wrap is rolled over.
      for (const gv of [0.055, 0.945]) h -= (1 - smoothstep((Math.abs(v - gv) - 0.004) / 0.012)) * 0.22;
      return h + ringNoise(u, v, 26, 3) * 0.045;
    };

    const cInk = new THREE.Color(0x14182a);
    const cInkLit = new THREE.Color(0x39456e);
    const cGold = new THREE.Color(0xffc63a);
    const cGoldDeep = new THREE.Color(0xb8760c);

    const wrapTex = this.regT(pixelTexture(512, (u, v, o) => {
      const lit = clamp01(0.24 + Math.pow(Math.sin(u * Math.PI), 0.65) * 0.9);
      const c = cInk.clone().lerp(cInkLit, lit);
      // Gold band top and bottom of the wrap.
      const bandT = 1 - smoothstep((Math.abs(v - 0.13) - 0.030) / 0.016);
      const bandB = 1 - smoothstep((Math.abs(v - 0.87) - 0.030) / 0.016);
      c.lerp(cGoldDeep.clone().lerp(cGold, lit), clamp01(bandT + bandB) * 0.92);
      // The bolt.
      c.lerp(cGold.clone().lerp(new THREE.Color(0xfff4bc), lit * 0.5), boltMask(u, v));
      // Charge segments read as pale mint before they are lit by the emissive.
      c.lerp(new THREE.Color(0xbdffe6), gaugeMask(u, v) * 0.9);
      const n = ringNoise(u, v, 13, 4);
      c.offsetHSL(0, 0, (n - 0.5) * 0.045);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const wrapEm = this.regT(pixelTexture(256, (u, v, o) => {
      // Only the bolt and the gauge glow. Values > 1 after emissiveIntensity so
      // they bloom under AgX.
      const b = boltMask(u, v);
      const gg = gaugeMask(u, v);
      const c = new THREE.Color(0x000000)
        .lerp(new THREE.Color(0xffd24a), b)
        .lerp(new THREE.Color(0x6cffc4), gg);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const wrapNrm = this.regT(normalFromHeight(256, wrapRelief, 2.4));
    const wrapRough = this.regT(pixelTexture(256, (u, v, o) => {
      // Ink is glossier than the matte wrap; the crimps are dirty.
      const r = 0.52 - boltMask(u, v) * 0.30 - gaugeMask(u, v) * 0.28
        + ringNoise(u, v, 17, 3) * 0.12;
      const q = Math.round(clamp01(r) * 255);
      o.r = q; o.g = q; o.b = q;
    }, false));

    const wrapMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: wrapTex,
      normalMap: wrapNrm,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughnessMap: wrapRough,
      roughness: 1.0,
      metalness: 0.30,
      emissiveMap: wrapEm,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 1.9,
      clearcoat: 0.85,
      clearcoatRoughness: 0.16,
      envMapIntensity: 1.2,
    }));
    this.trackMetal(wrapMat, 0.30, 0.12);
    const wrap = new THREE.Mesh(
      this.reg(new THREE.CylinderGeometry(R, R, H, 44, 1, true)),
      wrapMat,
    );
    wrap.castShadow = true;
    wrap.receiveShadow = true;
    g.add(wrap);

    // --- steel can ends + collar -------------------------------------------
    const steelTex = this.regT(pixelTexture(128, (u, v, o) => {
      // Brushed radial anisotropy, faked with fine noise streaks.
      const c = new THREE.Color(0xcfd6e2)
        .lerp(new THREE.Color(0x7d8697), Math.abs(v - 0.5) * 1.1);
      const streak = ringNoise(u, v * 0.15, 40, 2);
      c.offsetHSL(0, 0, (streak - 0.5) * 0.10);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const steelMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: steelTex,
      roughness: 0.24,
      metalness: 0.95,
      clearcoat: 0.4,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.5,
    }));
    this.trackMetal(steelMat, 0.95, 0.35);

    // Slightly proud collars, so the wrap looks inset between them.
    const collarGeo = this.reg(new THREE.CylinderGeometry(R * 1.035, R * 1.035, 0.055, 44, 1));
    for (const s of [1, -1]) {
      const collar = new THREE.Mesh(collarGeo, steelMat);
      collar.position.y = s * (H * 0.5 - 0.026);
      collar.castShadow = true;
      g.add(collar);
    }
    // Flat negative end.
    const endGeo = this.reg(new THREE.CircleGeometry(R * 1.03, 44));
    const neg = new THREE.Mesh(endGeo, steelMat);
    neg.rotation.x = Math.PI / 2;
    neg.position.y = -H * 0.5 - 0.001;
    g.add(neg);
    // Positive end: recessed shoulder + nub.
    const pos = new THREE.Mesh(endGeo, steelMat);
    pos.rotation.x = -Math.PI / 2;
    pos.position.y = H * 0.5 + 0.001;
    g.add(pos);
    const nub = new THREE.Mesh(
      this.reg(new THREE.CylinderGeometry(0.082, 0.092, 0.072, 24, 1)),
      steelMat,
    );
    nub.position.y = H * 0.5 + 0.036;
    nub.castShadow = true;
    g.add(nub);
    const nubTop = new THREE.Mesh(this.reg(new THREE.CircleGeometry(0.082, 24)), steelMat);
    nubTop.rotation.x = -Math.PI / 2;
    nubTop.position.y = H * 0.5 + 0.0725;
    g.add(nubTop);

    // Faint charge halo, so the battery reads as "full" at a glance.
    const halo = new THREE.Sprite(this.regM(new THREE.SpriteMaterial({
      map: this.glowTexture!,
      color: 0x7fffd0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.34,
    })));
    halo.scale.setScalar(1.15);
    g.add(halo);

    return g;
  }

  // -------------------------------------------------------------------------
  // NINJA  (replaces Boo — steals an item from another racer)
  // -------------------------------------------------------------------------

  /**
   * A hooded bust dissolving into a smoke skirt, with a glowing eye slit and a
   * shuriken held at the shoulder.
   *
   * It inherits Boo's job of floating and fading (`ItemSystem` drives
   * `setKartAlpha` while the cloak is up), so the body is still a lathe with
   * `wavySkirt()` displacing the hem — smoke, now, instead of a ghost's tail.
   *
   * Icon-scale legibility is carried by the eye slit and the shuriken. A hooded
   * head alone reads as a generic blob at 32 px; a hooded head plus a four-point
   * throwing star reads as "ninja" immediately.
   */
  private buildNinja(): THREE.Group {
    const g = new THREE.Group();

    // --- hood + shoulders ---------------------------------------------------
    const pts: THREE.Vector2[] = [];
    const N = 20;
    for (let i = 0; i <= N; i++) {
      // Slightly ovoid crown that flares as it descends into the shoulders.
      const a = (i / N) * Math.PI * 0.60;
      pts.push(new THREE.Vector2(
        Math.max(0.0006, 0.40 * Math.sin(a) * (1 + a * 0.16)),
        0.46 * Math.cos(a),
      ));
    }
    pts.push(new THREE.Vector2(0.475, -0.16));
    pts.push(new THREE.Vector2(0.455, -0.30));
    pts.push(new THREE.Vector2(0.385, -0.39));
    pts.push(new THREE.Vector2(0.195, -0.425));
    pts.push(new THREE.Vector2(0.0006, -0.43));
    const geo = this.reg(lathe(pts, 52));
    wavySkirt(geo, pts.length, 0.075, 7);

    const cloth = (u: number, v: number): number =>
      // Twill weave: two crossing high-frequency waves, plus soft folds.
      0.5
      + Math.sin((u * 130 + v * 90)) * 0.020
      + Math.sin((u * 130 - v * 90)) * 0.020
      + ringNoise(u, v * 0.8, 7, 4) * 0.11;

    const cIndigo = new THREE.Color(0x1b2036);
    const cIndigoLit = new THREE.Color(0x414d7a);
    // 256, not 512: the weave is deliberately high-frequency, so a bigger map
    // buys aliasing rather than detail — and this is a boot-time cost.
    const clothTex = this.regT(pixelTexture(256, (u, v, o) => {
      const lit = clamp01(0.20 + Math.pow(Math.sin(u * Math.PI), 0.6) * 0.95);
      const c = cIndigo.clone().lerp(cIndigoLit, lit);
      // The hem fades to charcoal smoke.
      c.lerp(new THREE.Color(0x0c0e16), smoothstep((v - 0.66) / 0.34) * 0.85);
      const n = cloth(u, v);
      c.offsetHSL(0, 0.02, (n - 0.5) * 0.30);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const clothNrm = this.regT(normalFromHeight(256, cloth, 2.2));
    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      map: clothTex,
      normalMap: clothNrm,
      normalScale: new THREE.Vector2(1.0, 1.0),
      roughness: 0.62,
      metalness: 0.0,
      sheen: 1.0,
      sheenColor: new THREE.Color(0x6f86d8),
      sheenRoughness: 0.35,
      clearcoat: 0.18,
      transparent: true,
      opacity: 0.97,
      side: THREE.DoubleSide,
      envMapIntensity: 1.05,
    }));
    const body = new THREE.Mesh(geo, mat);
    body.castShadow = true;
    g.add(body);

    // --- eye band -----------------------------------------------------------
    // A shallow spherical cap in front of the hood, dark, with two lit eyes.
    const bandMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0x0a0c14, roughness: 0.42, metalness: 0.0, clearcoat: 0.5,
    }));
    const band = new THREE.Mesh(
      this.reg(new THREE.SphereGeometry(0.385, 30, 12, 0, Math.PI * 2, Math.PI * 0.34, Math.PI * 0.20)),
      bandMat,
    );
    band.position.y = 0.045;
    g.add(band);

    const eyeMat = this.regM(new THREE.MeshBasicMaterial({ color: 0xfff0c4 }));
    const eyeGeo = this.reg(new THREE.SphereGeometry(0.052, 14, 10));
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      // Almond: wide, short, and canted inward for a scowl.
      eye.scale.set(1.5, 0.62, 0.42);
      eye.position.set(s * 0.115, 0.075, 0.335);
      eye.rotation.z = s * 0.30;
      g.add(eye);
    }
    const eyeGlow = new THREE.Sprite(this.regM(new THREE.SpriteMaterial({
      map: this.glowTexture!,
      color: 0xffcf6a,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.5,
    })));
    eyeGlow.scale.set(0.62, 0.30, 1);
    eyeGlow.position.set(0, 0.075, 0.40);
    g.add(eyeGlow);

    // --- scarf tails --------------------------------------------------------
    const scarfMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xc0342a,
      roughness: 0.66,
      metalness: 0.0,
      sheen: 0.9,
      sheenColor: new THREE.Color(0xff8d7a),
      side: THREE.DoubleSide,
      envMapIntensity: 1.0,
    }));
    for (const s of [-1, 1]) {
      const c = new THREE.CatmullRomCurve3([
        new THREE.Vector3(s * 0.24, 0.02, 0.18),
        new THREE.Vector3(s * 0.36, -0.02, -0.10),
        new THREE.Vector3(s * 0.30, 0.06, -0.36),
        new THREE.Vector3(s * 0.14, 0.16, -0.54),
      ]);
      const tail = new THREE.Mesh(
        this.reg(sweep(c, 20, 8, (t) => 0.052 * (1 - t * 0.55), 0.42)),
        scarfMat,
      );
      tail.castShadow = true;
      g.add(tail);
    }
    // Knot across the throat.
    const knot = new THREE.Mesh(
      this.reg(new THREE.TorusGeometry(0.20, 0.045, 10, 26, Math.PI * 1.15)),
      scarfMat,
    );
    knot.position.set(0, -0.055, 0.10);
    knot.rotation.set(Math.PI * 0.42, 0, Math.PI * 0.92);
    g.add(knot);

    // --- shuriken -----------------------------------------------------------
    const starGeo = this.reg(new THREE.ExtrudeGeometry(starShape(4, 0.155, 0.048, 0.10), {
      depth: 0.022, bevelEnabled: true, bevelSize: 0.010,
      bevelThickness: 0.008, bevelSegments: 2, curveSegments: 6,
    }));
    starGeo.center();
    starGeo.computeVertexNormals();
    const steelTex = this.regT(pixelTexture(128, (u, v, o) => {
      const c = new THREE.Color(0xb9c2d2).lerp(new THREE.Color(0x5d6675), Math.abs(v - 0.5) * 1.3);
      const streak = ringNoise(u, v * 0.2, 34, 2);
      c.offsetHSL(0, 0, (streak - 0.5) * 0.12);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const steelMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: steelTex,
      roughness: 0.16,
      metalness: 0.98,
      clearcoat: 0.6,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.6,
    }));
    this.trackMetal(steelMat, 0.98, 0.38);
    const shuriken = new THREE.Mesh(starGeo, steelMat);
    shuriken.position.set(0.40, -0.10, 0.20);
    shuriken.rotation.set(0.35, -0.45, 0.25);
    shuriken.castShadow = true;
    g.add(shuriken);

    return g;
  }

  // -------------------------------------------------------------------------
  // STAR
  // -------------------------------------------------------------------------

  private buildStar(): THREE.Group {
    const g = new THREE.Group();
    const shape = starShape(5, 0.62, 0.265, 0.20);
    const geo = this.reg(new THREE.ExtrudeGeometry(shape, {
      depth: 0.20,
      bevelEnabled: true,
      bevelThickness: 0.10,
      bevelSize: 0.075,
      bevelSegments: 5,
      curveSegments: 10,
    }));
    geo.center();
    geo.computeVertexNormals();

    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xffe14a,
      emissive: new THREE.Color(0xffc61e),
      emissiveIntensity: 2.4,
      roughness: 0.20,
      metalness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      iridescence: 0.6,
      iridescenceIOR: 1.4,
      sheen: 0.6,
      sheenColor: new THREE.Color(0xfff4b0),
      envMapIntensity: 1.4,
    }));
    const star = new THREE.Mesh(geo, mat);
    star.castShadow = true;
    g.add(star);

    // Lens flare + soft bloom halo
    const flare = new THREE.Sprite(this.regM(new THREE.SpriteMaterial({
      map: this.flareTexture!,
      color: 0xfff0b8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.85,
    })));
    flare.scale.setScalar(2.1);
    flare.position.z = 0.02;
    flare.name = PART.starFlare;
    g.add(flare);

    const halo = new THREE.Sprite(this.regM(new THREE.SpriteMaterial({
      map: this.glowTexture!,
      color: 0xffd24a,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.55,
    })));
    halo.scale.setScalar(1.7);
    g.add(halo);

    this.addEyes(g, 0.055, new THREE.Vector3(0, 0.02, 0.185), 0.115, false);
    return g;
  }

  // -------------------------------------------------------------------------
  // BULLET
  // -------------------------------------------------------------------------

  private buildBullet(): THREE.Group {
    const g = new THREE.Group();
    const R = 0.32;
    const pts: THREE.Vector2[] = [];
    const N = 16;
    // Nose cap (+z is forward, so build along +y then rotate).
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 0.5;
      pts.push(new THREE.Vector2(Math.max(0.0006, R * Math.sin(a)), 0.62 + R * 0.62 * Math.cos(a)));
    }
    pts.push(new THREE.Vector2(R, 0.10));
    pts.push(new THREE.Vector2(R * 0.985, -0.34));
    pts.push(new THREE.Vector2(R * 0.93, -0.44));
    pts.push(new THREE.Vector2(R * 0.55, -0.47));
    pts.push(new THREE.Vector2(0.0006, -0.47));

    const albedo = this.regT(pixelTexture(256, (u, v, o) => {
      const c = new THREE.Color(0x1b1f28).lerp(new THREE.Color(0x505a6b), Math.pow(1 - v, 1.6) * 0.75);
      const n = ringNoise(u, v, 12, 3);
      c.offsetHSL(0, 0, (n - 0.5) * 0.04);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      map: albedo,
      roughness: 0.16,
      metalness: 0.95,
      clearcoat: 0.85,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.4,
    }));
    this.trackMetal(mat, 0.95, 0.35);
    const body = new THREE.Mesh(this.reg(lathe(pts, 56)), mat);
    body.rotation.x = Math.PI / 2; // nose -> -Z (forward)
    body.castShadow = true;
    g.add(body);

    // Arms
    const armGeo = this.reg(new THREE.CapsuleGeometry(0.055, 0.16, 5, 10));
    for (const s of [-1, 1]) {
      const arm = new THREE.Mesh(armGeo, mat);
      arm.position.set(s * R * 0.96, -0.02, 0.10);
      arm.rotation.z = s * 0.9;
      g.add(arm);
    }

    // Face on the nose (-Z)
    this.addEyes(g, 0.072, new THREE.Vector3(0, 0.06, -0.60), 0.135, true, Math.PI);
    const mouthMat = this.regM(new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 0.6 }));
    const mouth = new THREE.Mesh(this.reg(new THREE.TorusGeometry(0.085, 0.021, 8, 16, Math.PI)), mouthMat);
    mouth.position.set(0, -0.07, -0.615);
    mouth.rotation.set(0, Math.PI, Math.PI);
    g.add(mouth);

    // Rear thruster
    const flameMat = this.regM(new THREE.MeshBasicMaterial({
      color: 0xffb84a, blending: THREE.AdditiveBlending, transparent: true,
      opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
    }));
    const flameGeo = this.reg(new THREE.ConeGeometry(0.24, 0.72, 16, 3, true));
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.rotation.x = -Math.PI / 2;
    flame.position.z = 0.80;
    flame.name = PART.thrusterFlame;
    g.add(flame);

    const glow = new THREE.Sprite(this.regM(new THREE.SpriteMaterial({
      map: this.glowTexture!, color: 0xffc46a,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8,
    })));
    glow.scale.setScalar(0.95);
    glow.position.z = 0.52;
    g.add(glow);
    return g;
  }

  // -------------------------------------------------------------------------

  /** Cartoon eyes: white sclera + dark pupil + a specular catchlight. */
  private addEyes(
    parent: THREE.Object3D,
    radius: number,
    centre: THREE.Vector3,
    spread: number,
    angry: boolean,
    yaw = 0,
  ): void {
    const white = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.14, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.05,
    }));
    const black = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0x0a0c12, roughness: 0.12, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.04,
    }));
    const eyeGeo = this.reg(new THREE.SphereGeometry(radius, 18, 14));
    const pupilGeo = this.reg(new THREE.SphereGeometry(radius * 0.52, 14, 10));
    const glintGeo = this.reg(new THREE.SphereGeometry(radius * 0.19, 8, 6));
    const glintMat = this.regM(new THREE.MeshBasicMaterial({ color: 0xffffff }));

    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    for (const s of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.copy(centre).addScaledVector(right, s * spread);
      const sclera = new THREE.Mesh(eyeGeo, white);
      sclera.scale.set(0.85, 1.12, 0.72);
      eye.add(sclera);
      const pupil = new THREE.Mesh(pupilGeo, black);
      pupil.position.addScaledVector(fwd, radius * 0.62);
      pupil.scale.set(0.75, 1.15, 0.6);
      eye.add(pupil);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.addScaledVector(fwd, radius * 0.80).addScaledVector(right, -s * radius * 0.20);
      glint.position.y += radius * 0.32;
      eye.add(glint);
      if (angry) {
        const brow = new THREE.Mesh(this.reg(new THREE.BoxGeometry(radius * 1.9, radius * 0.42, radius * 0.34)), black);
        brow.position.copy(pupil.position);
        brow.position.y += radius * 0.85;
        brow.rotation.z = s * -0.45;
        eye.add(brow);
      }
      parent.add(eye);
    }
  }

  // -------------------------------------------------------------------------
  // ICON ATLAS BAKE
  // -------------------------------------------------------------------------

  /**
   * Paint every live item into the icon sheet with `drawIconAtlas()` — the same
   * function, and therefore the same artwork, that the HUD calls when it draws an
   * item that has no cell.
   *
   * WHY THIS IS CANVAS 2D AND NOT A 3D RENDER. It used to spin up a throwaway
   * `WebGLRenderer` plus a PMREM probe at boot and photograph the real item
   * models from a studio angle. Three things were wrong with that:
   *
   *  1. **Tone mapping ate the chroma.** The bake ran AgX at exposure 1.35, which
   *     is correct for the game's frame and ruinous for a 40 px icon: the star's
   *     `emissiveIntensity 2.4` landed far up the shoulder of the curve and came
   *     out pale cream instead of gold. Every review of these icons said so.
   *  2. **No contour.** A photograph of a model has whatever edge the lighting
   *     gives it. MK8's icons are illustrations with a fat dark keyline, which is
   *     what makes them survive being drawn over a bright track.
   *  3. **It could not be verified, and failed to a flat colour.** No GL context
   *     means no bake, so the whole thing fell back to nine flat circles — a
   *     direct §0 violation — and no headless probe could ever see a single texel
   *     of the real thing. It is now measurable: `.probe-tmp/iconatlas.ts`
   *     rasterises these very painters and asserts coverage, silhouette and hue.
   *
   * Cell placement — both the draw and the lookup — comes from `iconAtlasCell()`.
   * Do not re-derive `col`/`row` here: the previous revision had the same
   * expression written out in three places and one of them disagreed about which
   * corner the origin was.
   */
  private bakeIconAtlas(): void {
    const W = ATLAS_W;
    const H = ATLAS_H;

    // UV rects first, normalised straight off the pixel rect, so there is exactly
    // one layout expression and exactly one origin corner (top-left; see
    // `getIconUV`). Only `ICON_ITEMS` get an entry — that is what makes "no cell
    // for a dead item" structural instead of a comment.
    for (const item of ICON_ITEMS) {
      const px = this.getIconPixelRect(item);
      if (!px) continue;
      this.uvRects.set(item, { x: px.x / W, y: px.y / H, w: px.w / W, h: px.h / H });
    }

    const out = make2d(ATLAS_CELL);
    out.canvas.width = W;
    out.canvas.height = H;
    drawIconAtlas(out, ATLAS_CELL);

    this.atlasCanvas = out.canvas;
    this.atlas = canvasTexture(out);
    // Image space, origin top-left — the convention `getIconUV` publishes and the
    // only one the DOM consumer can express. Without this a THREE sampler and the
    // HUD would disagree about which cell a rect names.
    this.atlas.flipY = false;
    this.atlas.minFilter = THREE.LinearMipmapLinearFilter;
    this.atlas.generateMipmaps = true;
    this.atlas.needsUpdate = true;
    this.texs.push(this.atlas);
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    this.geoms.length = 0;
    this.mats.length = 0;
    this.texs.length = 0;
    this.metalMats.length = 0;
    this.protos.clear();
    this.uvRects.clear();
    this.atlas = null;
    this.stubAtlas = null;
    this.atlasCanvas = null;
    this.ready = false;
  }
}

// ===========================================================================
// ICON ARTWORK — CANVAS 2D, ONE COPY, TWO CONSUMERS
// ===========================================================================
//
//  These painters are the ONLY item artwork in the project outside the 3-D
//  models. `drawIconAtlas()` bakes them into the sheet the HUD samples, and
//  `ItemIcons.paint()` in `src/ui/Widgets.ts` calls the same function for an
//  item that has no cell. That is deliberate: `Widgets.ts` used to carry its own
//  parallel set — a banana, a mushroom, a ghost, a coin, a squid and three
//  shells, i.e. the art from BEFORE the P0d-D5 re-skin — as a "fallback". A
//  fallback that draws different objects from the real thing is not a fallback,
//  it is a second product, and it is what let the owner's report ("the battery
//  icon shows the bottle item") survive a round of fixes: whichever path you
//  audited, the other one was wrong.
//
//  THE BAR is MK8DX's item icons, which are illustrations, not photographs of
//  the models:
//
//   * ONE LIGHT DIRECTION for the whole set — key from the upper LEFT. Every
//     gradient below runs light->dark along (-1,-1)->(+1,+1) and every specular
//     sits upper-left. Mixed light directions are the main reason a procedural
//     icon set reads as clip art.
//   * A FAT DARK KEYLINE on every silhouette (`inked()` strokes before it fills,
//     so the line sits half outside the shape and never eats the interior). This
//     is what makes an icon survive being drawn over a bright sky or white
//     tarmac — the previous 3-D bake had no contour at all.
//   * TWO INNER RIMS: a warm bright one on the key side, a cool dim one on the
//     shade side. Cheap, and it is the difference between "flat vector" and
//     "moulded plastic".
//   * HIGH CHROMA. The bake these replace ran AgX tone mapping at exposure 1.35,
//     which pushed the star's emissive far enough up the shoulder that it came
//     out pale cream. Authoring in sRGB straight into the sheet means the gold
//     is gold.
//   * A CONTACT SHADOW under everything, so five icons sit on the same floor.
//
//  Silhouettes are also chosen to be mutually unmistakable at 40 px, because
//  that is the size the HUD actually draws: a TALL POINTED rocket, a NECKED
//  bottle, a SQUAT NUBBED can, a HOODED head, a 5-POINT star. Two of those used
//  to be confusable (`.probe-tmp/iconatlas.ts` asserts a coarse-occupancy
//  signature per cell to keep them apart).
// ===========================================================================

type IconStop = readonly [number, string];

/** Key-side / shade-side keyline inks. Cool navy for everything but the star. */
const INK = '#0a1020';
const INK_WARM = '#3d1f00';

function lin(
  c: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number, stops: readonly IconStop[],
): CanvasGradient {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  for (const [t, col] of stops) g.addColorStop(t, col);
  return g;
}

function rad(
  c: CanvasRenderingContext2D,
  x: number, y: number, r0: number, r1: number, stops: readonly IconStop[],
): CanvasGradient {
  const g = c.createRadialGradient(x, y, r0, x, y, r1);
  for (const [t, col] of stops) g.addColorStop(t, col);
  return g;
}

/**
 * Keyline + fill for the path already on `c`.
 *
 * Stroke FIRST, then fill: half the stroke width ends up outside the silhouette
 * and the other half is covered by the fill, so a 6 % keyline reads as a crisp
 * 3 % outline without shrinking the artwork. Filling first and stroking after
 * would eat 3 % of every shape — at 40 px that is the difference between a
 * bottle with a neck and a bottle without one.
 */
function inked(
  c: CanvasRenderingContext2D, S: number,
  fill: string | CanvasGradient, w = 0.055, ink = INK,
): void {
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.lineWidth = S * w;
  c.strokeStyle = ink;
  c.stroke();
  c.fillStyle = fill;
  c.fill();
}

/** Soft elliptical contact shadow, so the whole set sits on one floor. */
function ground(c: CanvasRenderingContext2D, S: number, y: number, rx: number): void {
  c.save();
  c.fillStyle = rad(c, 0, y, 0, rx, [[0, 'rgba(6,10,20,0.42)'], [0.55, 'rgba(6,10,20,0.20)'], [1, 'rgba(6,10,20,0)']]);
  c.beginPath();
  c.ellipse(0, y, rx, rx * 0.30, 0, 0, Math.PI * 2);
  c.fill();
  c.restore();
  void S;
}

/**
 * Inner rim along one side of a shape: clip to the silhouette, then stroke the
 * SAME silhouette shifted a little, so only the arc on the far side of the shift
 * survives the clip. Shift down-right for a key-side (upper-left) rim.
 */
function innerRim(
  c: CanvasRenderingContext2D, S: number,
  build: (cc: CanvasRenderingContext2D) => void,
  color: string, dx: number, dy: number, w: number,
): void {
  c.save();
  build(c);
  c.clip();
  c.translate(dx, dy);
  build(c);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.lineWidth = S * w;
  c.strokeStyle = color;
  c.stroke();
  c.restore();
}

/** Soft specular blob — the one highlight that says "this surface is glossy". */
function spec(
  c: CanvasRenderingContext2D,
  x: number, y: number, rx: number, ry: number, rot: number, a = 0.85,
): void {
  c.save();
  c.fillStyle = rad(c, x, y, 0, Math.max(rx, ry), [
    [0, `rgba(255,255,255,${a})`], [0.5, `rgba(255,255,255,${a * 0.35})`], [1, 'rgba(255,255,255,0)'],
  ]);
  c.beginPath();
  c.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/**
 * Rounded N-point star path. The fillets matter: a hard-vertex star is the
 * "visible low-poly silhouette" AGENTS.md §3 names as an instant fail, and at
 * 40 px the points alias into grey mush without them.
 */
function starPath(
  c: CanvasRenderingContext2D,
  cx: number, cy: number, outer: number, inner: number, points: number, rot = -Math.PI / 2,
  round = 0.30,
): void {
  const n = points * 2;
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rot + (i / n) * Math.PI * 2;
    px.push(cx + Math.cos(a) * r);
    py.push(cy + Math.sin(a) * r);
  }
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    const ax = px[i] + (px[prev] - px[i]) * round;
    const ay = py[i] + (py[prev] - py[i]) * round;
    const bx = px[i] + (px[next] - px[i]) * round;
    const by = py[i] + (py[next] - py[i]) * round;
    if (i === 0) c.moveTo(ax, ay); else c.lineTo(ax, ay);
    c.quadraticCurveTo(px[i], py[i], bx, by);
  }
  c.closePath();
}

/** Symmetric silhouette from a half-profile: down the right side, up the left. */
function profilePath(
  c: CanvasRenderingContext2D, half: ReadonlyArray<readonly [number, number]>,
): void {
  c.beginPath();
  c.moveTo(half[0][0], half[0][1]);
  for (let i = 1; i < half.length; i++) c.lineTo(half[i][0], half[i][1]);
  for (let i = half.length - 1; i >= 0; i--) c.lineTo(-half[i][0], half[i][1]);
  c.closePath();
}

// ---------------------------------------------------------------------------
//  STAR — invulnerability. Reads as GOLD, at any size, on any background.
// ---------------------------------------------------------------------------

function paintStar(c: CanvasRenderingContext2D, S: number): void {
  const R = S * 0.44;
  // Warm halo. Saturated amber, not white: a white halo is what made the old
  // bake read as cream.
  c.fillStyle = rad(c, 0, 0, R * 0.30, R * 1.16, [
    [0, 'rgba(255,196,40,0.55)'], [0.55, 'rgba(255,150,20,0.26)'], [1, 'rgba(255,120,0,0)'],
  ]);
  c.beginPath();
  c.arc(0, 0, R * 1.16, 0, Math.PI * 2);
  c.fill();

  ground(c, S, R * 0.98, R * 0.62);

  const body = (cc: CanvasRenderingContext2D): void =>
    starPath(cc, 0, -R * 0.02, R * 0.97, R * 0.43, 5);

  body(c);
  inked(c, S, lin(c, -R * 0.55, -R * 0.85, R * 0.60, R * 0.90, [
    [0, '#fff6c2'], [0.22, '#ffe25c'], [0.52, '#ffc21a'], [0.80, '#f08a00'], [1, '#c25c00'],
  ]), 0.058, INK_WARM);

  // Faceted core: a second, smaller star in a hotter tone gives the flat fill a
  // centre and a direction without needing a normal map.
  c.save();
  body(c);
  c.clip();
  starPath(c, -R * 0.05, -R * 0.10, R * 0.62, R * 0.26, 5);
  c.fillStyle = rad(c, -R * 0.22, -R * 0.30, 0, R * 0.95, [
    [0, 'rgba(255,252,214,0.95)'], [0.45, 'rgba(255,225,90,0.45)'], [1, 'rgba(255,190,20,0)'],
  ]);
  c.fill();
  c.restore();

  innerRim(c, S, body, 'rgba(255,253,226,0.95)', S * 0.022, S * 0.022, 0.030);
  innerRim(c, S, body, 'rgba(196,88,0,0.85)', -S * 0.018, -S * 0.018, 0.026);
  spec(c, -R * 0.20, -R * 0.44, R * 0.20, R * 0.11, -0.5, 0.9);
  // No detached sparkle. A four-point twinkle outside the star's own arm looked
  // like a second object at 128 px and like a speck of dirt at 40 px — the ASCII
  // dump in `.probe-tmp/iconatlas.ts` shows it as a stray cross. The silhouette
  // has to stay a clean five-point star.
}

// ---------------------------------------------------------------------------
//  ROCKET — was Red Shell. STANDING UP, nose at the top.
// ---------------------------------------------------------------------------
//
//  The 3-D bake posed this with `rotation.x = -Math.PI * 0.44`, which points a
//  -Z nose DOWN, not up: the icon was a dark diagonal torpedo with its graphite
//  nozzle uppermost, and every review called it exactly that. A rocket icon has
//  one readable pose — vertical, tip up, flame down — so it is authored that way
//  here and cannot be re-posed by accident.
// ---------------------------------------------------------------------------

function paintRocket(c: CanvasRenderingContext2D, S: number): void {
  const R = S * 0.44;
  c.save();
  c.rotate(-0.09);

  const BW = R * 0.335;          // body half-width
  const NOSE_Y = -R * 1.02;
  const SHOULDER = -R * 0.30;
  const TAIL = R * 0.50;

  // --- exhaust, behind everything ----------------------------------------
  for (const [k, col] of [[1.0, 'rgba(255,96,10,0.85)'], [0.62, 'rgba(255,186,60,0.95)'],
    [0.30, 'rgba(255,246,206,0.98)']] as ReadonlyArray<readonly [number, string]>) {
    c.beginPath();
    c.moveTo(-BW * 0.80 * k, TAIL + R * 0.10);
    c.quadraticCurveTo(-BW * 0.42 * k, TAIL + R * 0.62 * k, 0, TAIL + R * 0.94 * k);
    c.quadraticCurveTo(BW * 0.42 * k, TAIL + R * 0.62 * k, BW * 0.80 * k, TAIL + R * 0.10);
    c.quadraticCurveTo(0, TAIL + R * 0.30, -BW * 0.80 * k, TAIL + R * 0.10);
    c.closePath();
    c.fillStyle = col;
    c.fill();
  }

  // --- centre fin, behind the body ---------------------------------------
  c.beginPath();
  c.moveTo(0, R * 0.02);
  c.lineTo(BW * 0.16, TAIL + R * 0.16);
  c.lineTo(-BW * 0.16, TAIL + R * 0.16);
  c.closePath();
  inked(c, S, '#7d1710', 0.045);

  // --- side fins ----------------------------------------------------------
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(s * BW * 0.92, R * 0.02);
    c.quadraticCurveTo(s * BW * 2.05, R * 0.46, s * BW * 1.86, TAIL + R * 0.20);
    c.lineTo(s * BW * 0.94, TAIL - R * 0.02);
    c.closePath();
    inked(c, S, lin(c, -BW * 2, R * 0.1, BW * 2, TAIL, s < 0
      ? [[0, '#ff7358'], [0.6, '#e33a26'], [1, '#a5210f']]
      : [[0, '#e0402c'], [0.6, '#b8281a'], [1, '#7d1710']]), 0.048);
  }

  // --- body: one silhouette so the keyline is continuous -----------------
  const body = (cc: CanvasRenderingContext2D): void => {
    cc.beginPath();
    cc.moveTo(0, NOSE_Y);
    cc.bezierCurveTo(BW * 0.72, NOSE_Y + R * 0.30, BW, SHOULDER - R * 0.22, BW, SHOULDER);
    cc.lineTo(BW, TAIL - R * 0.10);
    cc.lineTo(BW * 0.86, TAIL);
    cc.lineTo(-BW * 0.86, TAIL);
    cc.lineTo(-BW, TAIL - R * 0.10);
    cc.lineTo(-BW, SHOULDER);
    cc.bezierCurveTo(-BW, SHOULDER - R * 0.22, -BW * 0.72, NOSE_Y + R * 0.30, 0, NOSE_Y);
    cc.closePath();
  };
  body(c);
  inked(c, S, lin(c, -BW, 0, BW, 0, [
    [0, '#ffffff'], [0.30, '#eef1f6'], [0.66, '#c3ccda'], [1, '#8f99aa'],
  ]), 0.055);

  // --- nose cone, its own keyline: the seam reads as a panel joint --------
  c.beginPath();
  c.moveTo(0, NOSE_Y);
  c.bezierCurveTo(BW * 0.72, NOSE_Y + R * 0.30, BW, SHOULDER - R * 0.22, BW, SHOULDER);
  c.quadraticCurveTo(0, SHOULDER + R * 0.13, -BW, SHOULDER);
  c.bezierCurveTo(-BW, SHOULDER - R * 0.22, -BW * 0.72, NOSE_Y + R * 0.30, 0, NOSE_Y);
  c.closePath();
  inked(c, S, lin(c, -BW * 0.9, NOSE_Y, BW * 0.9, SHOULDER, [
    [0, '#ff8a6e'], [0.32, '#f2503a'], [0.72, '#d02a18'], [1, '#8e1a10'],
  ]), 0.048);

  // --- hazard band: graphite with red chevrons ----------------------------
  c.save();
  body(c);
  c.clip();
  const bandTop = R * 0.06;
  const bandH = R * 0.26;
  c.fillStyle = '#2a2f3a';
  c.beginPath();
  c.rect(-BW, bandTop, BW * 2, bandH);
  c.fill();
  c.fillStyle = '#e33a26';
  for (let i = -3; i <= 3; i++) {
    const x = i * BW * 0.46;
    c.beginPath();
    c.moveTo(x, bandTop);
    c.lineTo(x + BW * 0.24, bandTop);
    c.lineTo(x + BW * 0.02, bandTop + bandH);
    c.lineTo(x - BW * 0.22, bandTop + bandH);
    c.closePath();
    c.fill();
  }
  // Panel line at the shoulder.
  c.strokeStyle = 'rgba(10,16,32,0.35)';
  c.lineWidth = S * 0.012;
  c.beginPath();
  c.moveTo(-BW, -R * 0.10);
  c.lineTo(BW, -R * 0.10);
  c.stroke();
  c.restore();

  // --- nozzle -------------------------------------------------------------
  c.beginPath();
  c.moveTo(-BW * 0.86, TAIL - R * 0.02);
  c.lineTo(BW * 0.86, TAIL - R * 0.02);
  c.lineTo(BW * 0.66, TAIL + R * 0.17);
  c.lineTo(-BW * 0.66, TAIL + R * 0.17);
  c.closePath();
  inked(c, S, lin(c, -BW, 0, BW, 0, [[0, '#5d6675'], [0.5, '#2a2f3a'], [1, '#14171f']]), 0.042);

  innerRim(c, S, body, 'rgba(255,255,255,0.92)', S * 0.020, S * 0.020, 0.026);
  innerRim(c, S, body, 'rgba(90,104,130,0.75)', -S * 0.016, -S * 0.016, 0.024);
  spec(c, -BW * 0.42, -R * 0.52, BW * 0.24, R * 0.34, -0.12, 0.8);
  c.restore();
  ground(c, S, R * 1.06, R * 0.56);
}

// ---------------------------------------------------------------------------
//  PLASTIC BOTTLE — was Banana. Upright, so the neck is part of the silhouette.
// ---------------------------------------------------------------------------

function paintBottle(c: CanvasRenderingContext2D, S: number): void {
  const R = S * 0.44;
  ground(c, S, R * 1.02, R * 0.50);

  const W = R * 0.52;
  // Half-profile, cap -> base. The two pinches are the grip ribs; the crease at
  // the waist is the crush that makes this litter rather than shop stock.
  const half: ReadonlyArray<readonly [number, number]> = [
    [R * 0.005, -R * 1.00],
    [W * 0.56, -R * 0.99],
    [W * 0.56, -R * 0.74],
    [W * 0.40, -R * 0.72],
    [W * 0.40, -R * 0.60],
    [W * 0.72, -R * 0.40],
    [W * 0.97, -R * 0.10],
    [W, R * 0.04],
    [W * 0.90, R * 0.16],
    [W, R * 0.28],
    [W, R * 0.52],
    [W * 0.90, R * 0.64],
    [W, R * 0.76],
    [W * 0.97, R * 0.90],
    [W * 0.72, R * 1.00],
    [R * 0.005, R * 1.01],
  ];
  const body = (cc: CanvasRenderingContext2D): void => profilePath(cc, half);

  body(c);
  inked(c, S, lin(c, -W, -R, W, R, [
    [0, '#f4fffc'], [0.26, '#cdf3e9'], [0.58, '#8fd9c9'], [0.86, '#4fa697'], [1, '#2f7a6e'],
  ]), 0.055);

  // --- label sleeve: the item's colour identity ---------------------------
  c.save();
  body(c);
  c.clip();
  const lt = -R * 0.06;
  const lh = R * 0.62;
  c.fillStyle = lin(c, -W, lt, W, lt + lh, [
    [0, '#5ff2d8'], [0.22, '#17d9bd'], [0.60, '#0f9d8c'], [1, '#064b45'],
  ]);
  c.beginPath();
  c.rect(-W * 1.1, lt, W * 2.2, lh);
  c.fill();
  // Two printed bars + a droplet mark, the same white-on-teal the 3-D label uses.
  c.fillStyle = 'rgba(244,251,249,0.95)';
  c.beginPath();
  c.rect(-W * 1.1, lt + lh * 0.10, W * 2.2, lh * 0.075);
  c.rect(-W * 1.1, lt + lh * 0.84, W * 2.2, lh * 0.075);
  c.fill();
  c.beginPath();
  c.moveTo(0, lt + lh * 0.28);
  c.quadraticCurveTo(W * 0.52, lt + lh * 0.54, 0, lt + lh * 0.74);
  c.quadraticCurveTo(-W * 0.52, lt + lh * 0.54, 0, lt + lh * 0.28);
  c.closePath();
  c.fill();
  c.fillStyle = 'rgba(15,157,140,0.9)';
  c.beginPath();
  c.ellipse(0, lt + lh * 0.55, W * 0.15, lh * 0.10, 0, 0, Math.PI * 2);
  c.fill();
  // Shrink-wrap shading down the shade side.
  c.fillStyle = lin(c, 0, 0, W, 0, [[0, 'rgba(4,40,36,0)'], [1, 'rgba(4,40,36,0.45)']]);
  c.beginPath();
  c.rect(0, lt, W * 1.1, lh);
  c.fill();
  c.restore();

  // --- cap ---------------------------------------------------------------
  c.beginPath();
  c.rect(-W * 0.60, -R * 1.00, W * 1.20, R * 0.27);
  inked(c, S, lin(c, -W * 0.6, -R, W * 0.6, -R * 0.73, [
    [0, '#78a6ff'], [0.35, '#2f6ef0'], [1, '#16307a'],
  ]), 0.045);
  c.save();
  c.beginPath();
  c.rect(-W * 0.60, -R * 1.00, W * 1.20, R * 0.27);
  c.clip();
  c.strokeStyle = 'rgba(10,16,40,0.45)';
  c.lineWidth = S * 0.010;
  for (let i = -3; i <= 3; i++) {
    c.beginPath();
    c.moveTo(i * W * 0.17, -R * 1.00);
    c.lineTo(i * W * 0.17, -R * 0.73);
    c.stroke();
  }
  c.restore();

  innerRim(c, S, body, 'rgba(255,255,255,0.95)', S * 0.020, S * 0.020, 0.026);
  innerRim(c, S, body, 'rgba(24,96,88,0.70)', -S * 0.016, -S * 0.016, 0.024);
  // The tall highlight streak is what makes it read as PET rather than paper.
  c.save();
  body(c);
  c.clip();
  c.fillStyle = lin(c, -W * 0.62, 0, -W * 0.22, 0, [
    [0, 'rgba(255,255,255,0)'], [0.5, 'rgba(255,255,255,0.72)'], [1, 'rgba(255,255,255,0)'],
  ]);
  c.beginPath();
  c.rect(-W * 0.62, -R * 0.68, W * 0.40, R * 1.62);
  c.fill();
  c.restore();
  spec(c, -W * 0.26, -R * 0.86, W * 0.16, R * 0.07, -0.3, 0.85);
}

// ---------------------------------------------------------------------------
//  BATTERY — was Mushroom. Squat can, steel nub, GOLD bolt.
// ---------------------------------------------------------------------------

function paintBattery(c: CanvasRenderingContext2D, S: number): void {
  const R = S * 0.44;
  ground(c, S, R * 1.00, R * 0.62);

  const W = R * 0.66;
  const TOP = -R * 0.72;
  const BOT = R * 0.94;
  const CAP = R * 0.16;      // ellipse minor radius of the can ends

  // --- positive nub -------------------------------------------------------
  // Wide enough that it is a NUB and not a keyline: at a 40 px HUD slot the
  // terminal is about 6 px across, so anything narrower than ~0.45 W is swallowed
  // whole by its own outline and the can loses the one feature that says
  // "battery" rather than "tin".
  c.beginPath();
  c.moveTo(-W * 0.46, TOP);
  c.lineTo(-W * 0.40, -R * 1.02);
  c.lineTo(W * 0.40, -R * 1.02);
  c.lineTo(W * 0.46, TOP);
  c.closePath();
  inked(c, S, lin(c, -W * 0.46, -R, W * 0.46, TOP, [
    [0, '#ffffff'], [0.35, '#e2e8f2'], [0.7, '#b6bfcd'], [1, '#798394'],
  ]), 0.040);

  // --- can body -----------------------------------------------------------
  const body = (cc: CanvasRenderingContext2D): void => {
    cc.beginPath();
    cc.moveTo(-W, TOP);
    cc.lineTo(-W, BOT - CAP * 0.6);
    cc.quadraticCurveTo(-W, BOT, 0, BOT);
    cc.quadraticCurveTo(W, BOT, W, BOT - CAP * 0.6);
    cc.lineTo(W, TOP);
    cc.quadraticCurveTo(W, TOP - CAP, 0, TOP - CAP);
    cc.quadraticCurveTo(-W, TOP - CAP, -W, TOP);
    cc.closePath();
  };
  body(c);
  // Slate-navy, deliberately LESS saturated than the bottle's teal. These two are
  // the pair the owner reported as swapped, so they are separated on three axes at
  // once: silhouette (squat nubbed can vs necked bottle), value (dark vs pale) and
  // hue — the wrap stays near-neutral so the item's chroma is carried entirely by
  // the gold bolt, which puts the battery's dominant hue ~140 deg away from the
  // bottle's cyan instead of the 38 deg it sat at when the navy dominated.
  inked(c, S, lin(c, -W, TOP, W, BOT, [
    [0, '#5b638c'], [0.20, '#3b4260'], [0.62, '#1e2136'], [1, '#0f111c'],
  ]), 0.055);

  // --- steel collars ------------------------------------------------------
  c.save();
  body(c);
  c.clip();
  for (const [y, h] of [[TOP, CAP * 0.9], [BOT - CAP * 1.05, CAP * 0.7]] as ReadonlyArray<readonly [number, number]>) {
    c.fillStyle = lin(c, -W, 0, W, 0, [[0, '#f2f5fa'], [0.35, '#cfd6e2'], [1, '#6f7889']]);
    c.beginPath();
    c.rect(-W, y, W * 2, h);
    c.fill();
  }
  // Positive end cap, seen slightly from above.
  c.fillStyle = lin(c, -W, TOP - CAP, W, TOP, [[0, '#ffffff'], [0.45, '#dbe2ee'], [1, '#8d96a7']]);
  c.beginPath();
  c.ellipse(0, TOP, W, CAP, 0, Math.PI, Math.PI * 2);
  c.fill();
  c.restore();

  // --- printed gold bolt --------------------------------------------------
  // Same polygon the 3-D wrap point-in-polygons for its albedo, emissive mask
  // and normal map. One definition, four consumers — so the icon and the item in
  // the player's hand carry the identical mark.
  // The outline is 0.76 wide by 2.0 tall in its own space, so it needs a much
  // larger x scale than y to come out as a chunky printed mark rather than a thin
  // diagonal slash — which is exactly what it read as at the first scale I tried.
  const boltPath = (cc: CanvasRenderingContext2D): void => {
    cc.beginPath();
    for (let i = 0; i < BOLT_OUTLINE.length; i++) {
      const [bx, by] = BOLT_OUTLINE[i];
      const x = bx * W * 1.22;
      const y = R * 0.14 - by * R * 0.58;
      if (i === 0) cc.moveTo(x, y); else cc.lineTo(x, y);
    }
    cc.closePath();
  };
  boltPath(c);
  inked(c, S, lin(c, -W * 0.5, -R * 0.5, W * 0.5, R * 0.7, [
    [0, '#fffbdc'], [0.26, '#ffe066'], [0.60, '#ffc42a'], [1, '#c07f0a'],
  ]), 0.032, '#241505');
  innerRim(c, S, boltPath, 'rgba(255,253,228,0.95)', S * 0.012, S * 0.012, 0.018);

  // --- charge gauge, four pips up the shade side --------------------------
  c.save();
  body(c);
  c.clip();
  for (let i = 0; i < 4; i++) {
    c.fillStyle = i === 3 ? 'rgba(108,255,196,0.55)' : '#6cffc4';
    c.beginPath();
    c.rect(W * 0.58, BOT - R * 0.34 - i * R * 0.17, W * 0.26, R * 0.10);
    c.fill();
  }
  c.restore();

  innerRim(c, S, body, 'rgba(190,208,255,0.85)', S * 0.020, S * 0.020, 0.026);
  innerRim(c, S, body, 'rgba(8,12,26,0.85)', -S * 0.016, -S * 0.016, 0.026);
  spec(c, -W * 0.52, -R * 0.30, W * 0.16, R * 0.44, -0.06, 0.55);
}

// ---------------------------------------------------------------------------
//  NINJA — was Boo. Hood, glowing eyes, scarf, shuriken.
// ---------------------------------------------------------------------------
//
//  Reviewed before as "an ambiguous white dart". It was a lathe photographed
//  head-on with the shuriken edge-on behind the hood. Four marks make it read:
//  the peaked hood, the black eye band, two lit almond eyes, and a shuriken
//  BREAKING the silhouette at the lower right so it cannot hide.
// ---------------------------------------------------------------------------

function paintNinja(c: CanvasRenderingContext2D, S: number): void {
  const R = S * 0.44;
  ground(c, S, R * 0.98, R * 0.60);

  // --- scarf tails, behind the head ---------------------------------------
  for (const [k, col] of [[1, '#8e1f1a'], [0.72, '#d8413a']] as ReadonlyArray<readonly [number, string]>) {
    c.beginPath();
    c.moveTo(R * 0.10, R * 0.34);
    c.quadraticCurveTo(R * 0.86 * k, R * 0.10, R * 1.06 * k, -R * 0.44 * k);
    c.quadraticCurveTo(R * 0.72 * k, R * 0.16, R * 0.28, R * 0.62);
    c.closePath();
    inked(c, S, col, 0.040, '#3a0b08');
  }

  // --- hood ---------------------------------------------------------------
  const body = (cc: CanvasRenderingContext2D): void => {
    cc.beginPath();
    cc.moveTo(0, -R * 1.00);
    cc.bezierCurveTo(R * 0.52, -R * 0.94, R * 0.74, -R * 0.44, R * 0.72, -R * 0.06);
    cc.bezierCurveTo(R * 0.70, R * 0.26, R * 0.86, R * 0.42, R * 0.90, R * 0.72);
    cc.lineTo(-R * 0.90, R * 0.72);
    cc.bezierCurveTo(-R * 0.86, R * 0.42, -R * 0.70, R * 0.26, -R * 0.72, -R * 0.06);
    cc.bezierCurveTo(-R * 0.74, -R * 0.44, -R * 0.52, -R * 0.94, 0, -R * 1.00);
    cc.closePath();
  };
  body(c);
  inked(c, S, lin(c, -R * 0.7, -R, R * 0.7, R * 0.7, [
    [0, '#6b7cc4'], [0.24, '#414d7a'], [0.62, '#1b2036'], [1, '#0a0c14'],
  ]), 0.055);

  // --- eye band + eyes ----------------------------------------------------
  c.save();
  body(c);
  c.clip();
  c.fillStyle = lin(c, 0, -R * 0.22, 0, R * 0.16, [[0, '#141826'], [1, '#05060c']]);
  c.beginPath();
  c.moveTo(-R * 0.78, -R * 0.20);
  c.quadraticCurveTo(0, -R * 0.30, R * 0.78, -R * 0.20);
  c.lineTo(R * 0.78, R * 0.14);
  c.quadraticCurveTo(0, R * 0.24, -R * 0.78, R * 0.14);
  c.closePath();
  c.fill();
  // Hood fold, so the cowl is not one flat field.
  c.strokeStyle = 'rgba(120,140,210,0.30)';
  c.lineWidth = S * 0.016;
  c.beginPath();
  c.moveTo(-R * 0.40, -R * 0.86);
  c.quadraticCurveTo(-R * 0.10, -R * 0.52, -R * 0.22, -R * 0.24);
  c.stroke();
  c.restore();

  for (const s of [-1, 1]) {
    // Glow first, then the almond, so the light bleeds onto the band.
    c.fillStyle = rad(c, s * R * 0.30, -R * 0.03, 0, R * 0.30, [
      [0, 'rgba(255,207,106,0.75)'], [1, 'rgba(255,180,60,0)'],
    ]);
    c.beginPath();
    c.arc(s * R * 0.30, -R * 0.03, R * 0.30, 0, Math.PI * 2);
    c.fill();
    c.save();
    c.translate(s * R * 0.30, -R * 0.03);
    c.rotate(s * 0.26);
    c.beginPath();
    c.moveTo(-R * 0.20, 0);
    c.quadraticCurveTo(0, -R * 0.15, R * 0.20, 0);
    c.quadraticCurveTo(0, R * 0.09, -R * 0.20, 0);
    c.closePath();
    c.fillStyle = lin(c, -R * 0.2, 0, R * 0.2, 0, [[0, '#fffdf0'], [0.6, '#ffe9a8'], [1, '#ffb43c']]);
    c.fill();
    c.restore();
  }

  // --- scarf knot across the throat --------------------------------------
  c.beginPath();
  c.moveTo(-R * 0.62, R * 0.34);
  c.quadraticCurveTo(0, R * 0.14, R * 0.62, R * 0.34);
  c.quadraticCurveTo(0, R * 0.54, -R * 0.62, R * 0.34);
  c.closePath();
  inked(c, S, lin(c, -R * 0.6, R * 0.2, R * 0.6, R * 0.5, [
    [0, '#ff6a58'], [0.4, '#c0342a'], [1, '#7a1712'],
  ]), 0.042, '#3a0b08');

  innerRim(c, S, body, 'rgba(150,168,235,0.85)', S * 0.020, S * 0.020, 0.026);
  innerRim(c, S, body, 'rgba(4,6,12,0.9)', -S * 0.016, -S * 0.016, 0.024);

  // --- shuriken, breaking the silhouette ---------------------------------
  const shur = (cc: CanvasRenderingContext2D): void =>
    starPath(cc, R * 0.66, R * 0.52, R * 0.40, R * 0.13, 4, -Math.PI * 0.36, 0.18);
  shur(c);
  inked(c, S, lin(c, R * 0.3, R * 0.2, R * 1.0, R * 0.9, [
    [0, '#ffffff'], [0.3, '#dfe6f2'], [0.7, '#98a2b3'], [1, '#4e5666'],
  ]), 0.046);
  c.save();
  shur(c);
  c.clip();
  c.beginPath();
  c.arc(R * 0.66, R * 0.52, R * 0.11, 0, Math.PI * 2);
  c.fillStyle = '#2a3040';
  c.fill();
  c.restore();
  innerRim(c, S, shur, 'rgba(255,255,255,0.95)', S * 0.014, S * 0.014, 0.020);
}

// ---------------------------------------------------------------------------
//  RETAINED PROTOTYPES — no atlas cell, drawn on demand only
// ---------------------------------------------------------------------------
//
//  `ItemRoulette` gives these weight 0 in every row, so a box can never produce
//  one; `grantItem()` (dev harness, cheats) still can, and `Projectiles` still
//  pools the kinds. They therefore need artwork but must NOT occupy a cell — a
//  dead cell in a live atlas is what turns an off-by-one into another item's
//  picture instead of a blank. `ItemIcons.apply()` calls these directly when
//  `getIconUV()` returns null.
// ---------------------------------------------------------------------------

function paintShell(c: CanvasRenderingContext2D, S: number, hi: string, mid: string, lo: string): void {
  const R = S * 0.44;
  ground(c, S, R * 0.90, R * 0.66);
  c.beginPath();
  c.ellipse(0, R * 0.36, R * 0.94, R * 0.42, 0, 0, Math.PI * 2);
  inked(c, S, lin(c, -R, R * 0.1, R, R * 0.7, [[0, '#ffffff'], [0.55, '#f0efe6'], [1, '#b9b6a6']]), 0.046);
  const dome = (cc: CanvasRenderingContext2D): void => {
    cc.beginPath();
    cc.arc(0, R * 0.12, R * 0.92, Math.PI, 0);
    cc.closePath();
  };
  dome(c);
  inked(c, S, rad(c, -R * 0.34, -R * 0.50, R * 0.05, R * 1.20, [[0, hi], [0.42, mid], [1, lo]]), 0.052);
  c.save();
  dome(c);
  c.clip();
  c.strokeStyle = 'rgba(10,20,32,0.32)';
  c.lineWidth = S * 0.018;
  for (let i = -2; i <= 2; i++) {
    c.beginPath();
    c.moveTo(i * R * 0.34, R * 0.12);
    c.quadraticCurveTo(i * R * 0.40, -R * 0.40, i * R * 0.18, -R * 0.82);
    c.stroke();
  }
  c.restore();
  innerRim(c, S, dome, 'rgba(255,255,255,0.85)', S * 0.020, S * 0.020, 0.024);
  spec(c, -R * 0.34, -R * 0.42, R * 0.26, R * 0.15, -0.45, 0.8);
}

function paintGreenShell(c: CanvasRenderingContext2D, S: number): void {
  paintShell(c, S, '#d9ffb0', '#3fd12c', '#0d6b1c');
}

function paintBlueShell(c: CanvasRenderingContext2D, S: number): void {
  const R = S * 0.44;
  for (let i = 0; i < 5; i++) {
    const a = Math.PI + (i / 4) * Math.PI;
    const x = Math.cos(a) * R * 0.80;
    const y = R * 0.10 + Math.sin(a) * R * 0.80;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * R * 0.34, y + Math.sin(a) * R * 0.34);
    c.lineTo(x + Math.cos(a - 0.30) * R * 0.10, y + Math.sin(a - 0.30) * R * 0.10);
    c.lineTo(x + Math.cos(a + 0.30) * R * 0.10, y + Math.sin(a + 0.30) * R * 0.10);
    c.closePath();
    inked(c, S, '#eaf4ff', 0.036);
  }
  paintShell(c, S, '#dff3ff', '#3f8dff', '#0f2fa8');
}

function paintBomb(c: CanvasRenderingContext2D, S: number): void {
  const R = S * 0.44;
  ground(c, S, R * 0.98, R * 0.60);
  const body = (cc: CanvasRenderingContext2D): void => {
    cc.beginPath();
    cc.arc(0, R * 0.16, R * 0.80, 0, Math.PI * 2);
  };
  body(c);
  inked(c, S, rad(c, -R * 0.30, -R * 0.20, R * 0.05, R * 1.05, [
    [0, '#6b7c9e'], [0.40, '#222b40'], [1, '#05070e'],
  ]), 0.050);
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(s * R * 0.42, R * 0.90, R * 0.24, R * 0.12, 0, 0, Math.PI * 2);
    inked(c, S, '#f4c02a', 0.034);
  }
  c.strokeStyle = '#d8dce6';
  c.lineWidth = S * 0.040;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(R * 0.18, -R * 0.58);
  c.quadraticCurveTo(R * 0.62, -R * 0.88, R * 0.50, -R * 1.00);
  c.stroke();
  starPath(c, R * 0.52, -R * 1.02, R * 0.30, R * 0.10, 6, -Math.PI / 2, 0.10);
  c.fillStyle = rad(c, R * 0.52, -R * 1.02, 0, R * 0.32, [
    [0, '#fffbe0'], [0.5, '#ffcf3a'], [1, 'rgba(255,106,0,0)'],
  ]);
  c.fill();
  innerRim(c, S, body, 'rgba(160,180,220,0.7)', S * 0.020, S * 0.020, 0.024);
  spec(c, -R * 0.32, -R * 0.28, R * 0.22, R * 0.13, -0.5, 0.75);
}

function paintBullet(c: CanvasRenderingContext2D, S: number): void {
  const R = S * 0.44;
  ground(c, S, R * 0.86, R * 0.62);
  c.save();
  c.rotate(-0.16);
  const body = (cc: CanvasRenderingContext2D): void => {
    cc.beginPath();
    cc.moveTo(-R * 0.86, -R * 0.48);
    cc.lineTo(R * 0.26, -R * 0.48);
    cc.quadraticCurveTo(R * 0.92, -R * 0.48, R * 0.92, 0);
    cc.quadraticCurveTo(R * 0.92, R * 0.48, R * 0.26, R * 0.48);
    cc.lineTo(-R * 0.86, R * 0.48);
    cc.closePath();
  };
  body(c);
  inked(c, S, lin(c, 0, -R * 0.5, 0, R * 0.5, [
    [0, '#7d8db0'], [0.4, '#242c40'], [1, '#080b16'],
  ]), 0.050);
  c.fillStyle = '#182034';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(-R * 0.10, s * R * 0.58, R * 0.32, R * 0.14, 0, 0, Math.PI * 2);
    inked(c, S, '#182034', 0.032);
  }
  c.fillStyle = '#ffffff';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(R * 0.32, s * R * 0.15, R * 0.12, R * 0.13, 0, 0, Math.PI * 2);
    c.fill();
  }
  innerRim(c, S, body, 'rgba(200,215,245,0.75)', S * 0.020, S * 0.020, 0.024);
  c.restore();
  spec(c, -R * 0.28, -R * 0.30, R * 0.26, R * 0.10, -0.35, 0.7);
}

/**
 * Artwork per prototype. `Record<ItemModelId, …>` keeps it TOTAL: a new item
 * model is a compile error here, not a silently blank atlas cell.
 */
const ICON_PAINTERS: Record<ItemModelId, (c: CanvasRenderingContext2D, S: number) => void> = {
  rocket: paintRocket,
  bottle: paintBottle,
  battery: paintBattery,
  ninja: paintNinja,
  star: paintStar,
  greenShell: paintGreenShell,
  blueShell: paintBlueShell,
  bomb: paintBomb,
  bullet: paintBullet,
};

/**
 * Draw one item's icon centred on the current origin, filling a `size` box.
 *
 * Routed through `MODEL_FOR_ITEM`, so the icon and the object that appears in the
 * player's hand can never disagree about which item they are: there is one
 * mapping from `ItemType` to identity and both consult it.
 */
export function paintItemIcon(c: CanvasRenderingContext2D, item: ItemType, size: number): void {
  c.save();
  ICON_PAINTERS[MODEL_FOR_ITEM[item]](c, size);
  c.restore();
}

/**
 * Paint the whole sheet: `ICON_ITEMS` in order, each centred in the cell that
 * `iconAtlasCell()` names.
 *
 * The bake and the probe both call THIS, so "the cell the art is drawn into" and
 * "the cell the HUD samples" are one expression evaluated once — the property the
 * P0d icon bug violated when the same arithmetic was written out three times.
 */
export function drawIconAtlas(c: CanvasRenderingContext2D, cell: number): void {
  for (const item of ICON_ITEMS) {
    const at = iconAtlasCell(item);
    if (!at) continue;
    c.save();
    c.translate(at.col * cell + cell * 0.5, at.row * cell + cell * 0.5);
    paintItemIcon(c, item, cell);
    c.restore();
  }
}
