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
 */
export const ALL_ITEM_TYPES: readonly ItemType[] = Object.keys(MODEL_FOR_ITEM)
  .map((k) => Number(k) as ItemType)
  .sort((a, b) => (a as number) - (b as number));

const ATLAS_CELL = 256;
const ATLAS_COLS = 4;
/** Rows follow the item count, so the grid can never be too small. */
const ATLAS_ROWS = Math.max(1, Math.ceil(ALL_ITEM_TYPES.length / ATLAS_COLS));
const ATLAS_W = ATLAS_COLS * ATLAS_CELL;
const ATLAS_H = ATLAS_ROWS * ATLAS_CELL;

/**
 * Which cell of the atlas belongs to an item. **The only place the index -> grid
 * mapping is written.**
 *
 * `getIconPixelRect`, `getIconUV` and the bake loop all route through this, so
 * the cell the artwork is drawn into and the cell the HUD samples are the same
 * expression by construction, not by two authors agreeing.
 */
export function iconAtlasCell(item: ItemType): { col: number; row: number } {
  const i = (item as number) | 0;
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

    await this.bakeIconAtlas();
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

  getIconAtlas(): THREE.Texture {
    if (!this.atlas) {
      // Degrade rather than crash if the bake failed (headless / lost context).
      const ctx = make2d(4);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 4, 4);
      this.atlas = canvasTexture(ctx);
      this.atlas.flipY = false; // same convention as the baked atlas
      this.texs.push(this.atlas);
    }
    return this.atlas;
  }

  /**
   * Normalised rect of an item's cell, **origin TOP-LEFT — image space**, i.e.
   * the same corner `getIconPixelRect` and the atlas canvas itself use.
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
  getIconUV(item: ItemType): IconRect {
    return this.uvRects.get(item) ?? { x: 0, y: 0, w: 1, h: 1 };
  }

  /** Raw canvas — handy for a 2D/DOM HUD that wants drawImage instead of UVs. */
  getIconCanvas(): HTMLCanvasElement | null { return this.atlasCanvas; }

  /** Pixel rect within the atlas canvas, origin top-left. */
  getIconPixelRect(item: ItemType): IconRect {
    const { col, row } = iconAtlasCell(item);
    return { x: col * ATLAS_CELL, y: row * ATLAS_CELL, w: ATLAS_CELL, h: ATLAS_CELL };
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
   * Render every item into a 4x4 / 256 px atlas from a fixed 3/4 studio angle.
   * A throwaway WebGL context is used so we never disturb the game renderer,
   * then the result is read back into a 2D canvas -> CanvasTexture, which is
   * portable across contexts.
   *
   * Cell placement — both the draw and the lookup — comes from
   * `iconAtlasCell()`. Do not re-derive `col`/`row` from an index here: the
   * previous revision had the same expression written out in three places and
   * one of them disagreed about which corner the origin was.
   */
  private async bakeIconAtlas(): Promise<void> {
    const W = ATLAS_W;
    const H = ATLAS_H;

    // UV rects first — they're valid even if the GL bake fails. Normalised
    // straight off the pixel rect, so there is exactly one layout expression and
    // exactly one origin corner (top-left; see `getIconUV`).
    for (const item of ALL_ITEM_TYPES) {
      const px = this.getIconPixelRect(item);
      this.uvRects.set(item, { x: px.x / W, y: px.y / H, w: px.w / W, h: px.h / H });
    }

    const out = make2d(1);
    out.canvas.width = W;
    out.canvas.height = H;

    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
      renderer.setSize(ATLAS_CELL, ATLAS_CELL, false);
      renderer.setPixelRatio(2);
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.AgXToneMapping;
      renderer.toneMappingExposure = 1.35;

      const scene = new THREE.Scene();
      const cam = new THREE.PerspectiveCamera(26, 1, 0.1, 40);
      cam.position.set(1.55, 1.25, 2.55);
      cam.lookAt(0, 0, 0);

      // Studio rig: warm key, cool fill, white rim + hemi bounce.
      const key = new THREE.DirectionalLight(0xfff2e0, 3.4);
      key.position.set(2.2, 3.0, 2.4);
      const fill = new THREE.DirectionalLight(0x9fc4ff, 1.5);
      fill.position.set(-2.6, 0.6, 1.6);
      const rim = new THREE.DirectionalLight(0xffffff, 3.0);
      rim.position.set(-0.8, 1.6, -3.0);
      const hemi = new THREE.HemisphereLight(0xdfeaff, 0x3a3f52, 1.5);
      scene.add(key, fill, rim, hemi);

      // A tiny PMREM environment so metals (bullet, bomb, battery can) read right.
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = this.makeStudioEnvScene();
      const envRT = pmrem.fromScene(envScene, 0.04);
      scene.environment = envRT.texture;
      for (const m of this.metalMats) m.mat.metalness = m.full;

      const holder = new THREE.Group();
      scene.add(holder);

      for (const item of ALL_ITEM_TYPES) {
        holder.clear();
        const node = this.buildIconSubject(item);
        holder.add(node);
        holder.updateMatrixWorld(true);

        // Frame the subject: fit its bounding sphere to the camera.
        const box = new THREE.Box3().setFromObject(node);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        if (sphere.radius > 0 && Number.isFinite(sphere.radius)) {
          node.position.sub(sphere.center);
          const dist = (sphere.radius * 1.06) / Math.sin((cam.fov * Math.PI) / 360);
          cam.position.set(0.52, 0.42, 0.86).normalize().multiplyScalar(dist);
          cam.lookAt(0, 0, 0);
          cam.updateProjectionMatrix();
        }

        renderer.render(scene, cam);
        const px = this.getIconPixelRect(item);
        out.drawImage(renderer.domElement, px.x, px.y, px.w, px.h);
      }

      envRT.dispose();
      pmrem.dispose();
      envScene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose());
        }
      });
      // Restore the no-IBL fallback until the real scene reports an environment.
      for (const m of this.metalMats) m.mat.metalness = m.fallback;
    } catch (err) {
      console.warn('[ItemModels] icon atlas bake failed, using flat fallback', err);
      // Fall back to readable coloured chips so the HUD still has something.
      // Keyed by MODEL id, not by index — a chip is now guaranteed to be the
      // right colour for whatever prototype the item actually resolves to.
      const chip: Record<ItemModelId, string> = {
        battery: '#2a3358', rocket: '#e33a26', bottle: '#0f9d8c', ninja: '#2b3358',
        star: '#ffe14a', greenShell: '#2fbf3f', blueShell: '#2b6fe8', bomb: '#1b1f28',
        bullet: '#8b93a5',
      };
      for (const item of ALL_ITEM_TYPES) {
        const px = this.getIconPixelRect(item);
        out.fillStyle = chip[MODEL_FOR_ITEM[item]] ?? '#888';
        out.beginPath();
        out.arc(px.x + px.w * 0.5, px.y + px.h * 0.5, px.w * 0.375, 0, Math.PI * 2);
        out.fill();
      }
    } finally {
      if (renderer) {
        renderer.dispose();
        renderer.forceContextLoss();
      }
    }

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

  /** Emissive box rig that PMREM turns into a plausible studio reflection. */
  private makeStudioEnvScene(): THREE.Scene {
    const s = new THREE.Scene();
    const room = new THREE.Mesh(
      new THREE.BoxGeometry(12, 8, 12),
      new THREE.MeshBasicMaterial({ color: 0x30384a, side: THREE.BackSide }),
    );
    s.add(room);
    const panel = (w: number, h: number, c: number, i: number) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i) }),
      );
      return m;
    };
    const top = panel(9, 9, 0xffffff, 5.5);
    top.position.y = 3.9; top.rotation.x = Math.PI / 2; s.add(top);
    const left = panel(6, 5, 0xbfd8ff, 2.4);
    left.position.set(-5.9, 0.6, 0); left.rotation.y = Math.PI / 2; s.add(left);
    const right = panel(6, 5, 0xffd9b0, 2.0);
    right.position.set(5.9, 0.6, 0); right.rotation.y = -Math.PI / 2; s.add(right);
    const back = panel(9, 5, 0xffffff, 1.4);
    back.position.set(0, 0.4, -5.9); s.add(back);
    const floor = panel(10, 10, 0x8a93a8, 0.7);
    floor.position.y = -3.9; floor.rotation.x = -Math.PI / 2; s.add(floor);
    return s;
  }

  /**
   * Icon subject, posed for the 3/4 studio camera at `(0.52, 0.42, 0.86)`.
   *
   * The atlas cell is 256 px and the HUD draws it far smaller, so each of the
   * P0d-D5 re-skins is turned to the angle where its silhouette is widest:
   *
   *  - ROCKET: stood on end and leaned back, so nose, body band and all three
   *    fins are visible. Left lying along -Z it presents as a circle.
   *  - BOTTLE: stood upright for the icon (it lies down only on the road), with
   *    a quarter turn so the label's droplet mark faces the key light.
   *  - BATTERY: leaned toward the camera so the +nub breaks the top edge and the
   *    bolt sits square on.
   *  - NINJA: turned a few degrees off axis so the shuriken clears the hood.
   *
   * `TRIPLE_ITEMS` is empty now, so the fan-out branch is dead in a race; it
   * stays for a triple forced through `grantItem()`.
   */
  private buildIconSubject(item: ItemType): THREE.Object3D {
    const g = new THREE.Group();
    const id = MODEL_FOR_ITEM[item];
    if (TRIPLE_ITEMS.has(item)) {
      for (let k = 0; k < 3; k++) {
        const m = this.create(id);
        const a = (k - 1) * 0.62;
        m.position.set(Math.sin(a) * 0.60, -Math.abs(k - 1) * 0.06, Math.cos(a) * 0.34 - 0.34);
        m.scale.setScalar(0.80);
        m.rotation.y += a * 0.5;
        g.add(m);
      }
    } else {
      const m = this.create(id);
      if (item === ItemType.Bullet) m.rotation.y = Math.PI * 0.86;
      if (id === 'rocket') {
        // Nose is down -Z: rotate +X by -80 deg to stand it up, then yaw so a fin
        // faces the camera rather than hiding edge-on.
        m.rotation.set(-Math.PI * 0.44, Math.PI * 0.18, 0.10);
      }
      if (id === 'bottle') {
        // Undo the lie-down so the icon shows a standing bottle.
        m.rotation.set(0, Math.PI * 0.12, -Math.PI / 2);
      }
      if (id === 'battery') m.rotation.set(-0.16, Math.PI * 0.02, 0.10);
      if (id === 'ninja') m.rotation.set(0.05, -Math.PI * 0.10, 0);
      if (item === ItemType.Lightning) m.rotation.set(0, 0.25, 0.12);
      if (item === ItemType.Star) m.rotation.set(0, 0.15, 0);
      g.add(m);
    }
    return g;
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
    this.atlasCanvas = null;
    this.ready = false;
  }
}
