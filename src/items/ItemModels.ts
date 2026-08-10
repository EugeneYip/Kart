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

/** Classic jagged lightning bolt outline. */
export function boltShape(scale = 1): THREE.Shape {
  const p: Array<[number, number]> = [
    [0.30, 1.00], [-0.34, 0.10], [-0.02, 0.10], [-0.26, -1.00],
    [0.40, -0.06], [0.05, -0.06], [0.42, 0.62],
  ];
  const s = new THREE.Shape();
  s.moveTo(p[0][0] * scale, p[0][1] * scale);
  for (let i = 1; i < p.length; i++) s.lineTo(p[i][0] * scale, p[i][1] * scale);
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

export type ItemModelId =
  | 'greenShell' | 'redShell' | 'blueShell' | 'banana' | 'bomb' | 'mushroom'
  | 'star' | 'lightning' | 'bullet' | 'coin' | 'ghost' | 'squid';

export const MODEL_FOR_ITEM: Record<ItemType, ItemModelId> = {
  [ItemType.Boost]: 'mushroom',
  [ItemType.TripleBoost]: 'mushroom',
  [ItemType.GreenShell]: 'greenShell',
  [ItemType.TripleGreenShell]: 'greenShell',
  [ItemType.RedShell]: 'redShell',
  [ItemType.TripleRedShell]: 'redShell',
  [ItemType.Banana]: 'banana',
  [ItemType.TripleBanana]: 'banana',
  [ItemType.Bomb]: 'bomb',
  [ItemType.Star]: 'star',
  [ItemType.Lightning]: 'lightning',
  [ItemType.Ghost]: 'ghost',
  [ItemType.Bullet]: 'bullet',
  [ItemType.BlueShell]: 'blueShell',
  [ItemType.Coin]: 'coin',
  [ItemType.Squid]: 'squid',
};

/** Items that come as a set of three. */
export const TRIPLE_ITEMS: ReadonlySet<ItemType> = new Set([
  ItemType.TripleBoost, ItemType.TripleGreenShell,
  ItemType.TripleRedShell, ItemType.TripleBanana,
]);

export const ITEM_NAMES: Record<ItemType, string> = {
  [ItemType.Boost]: 'Mushroom',
  [ItemType.TripleBoost]: 'Triple Mushroom',
  [ItemType.GreenShell]: 'Green Shell',
  [ItemType.TripleGreenShell]: 'Triple Green Shell',
  [ItemType.RedShell]: 'Red Shell',
  [ItemType.TripleRedShell]: 'Triple Red Shell',
  [ItemType.Banana]: 'Banana',
  [ItemType.TripleBanana]: 'Triple Banana',
  [ItemType.Bomb]: 'Bob-omb',
  [ItemType.Star]: 'Star',
  [ItemType.Lightning]: 'Lightning',
  [ItemType.Ghost]: 'Boo',
  [ItemType.Bullet]: 'Bullet',
  [ItemType.BlueShell]: 'Blue Shell',
  [ItemType.Coin]: 'Coin',
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
} as const;

// ---------------------------------------------------------------------------

const ATLAS_COLS = 4;
const ATLAS_ROWS = 4;
const ATLAS_CELL = 256;

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
    this.protos.set('redShell', this.buildShell(0xe8302a, 0x8c0f0c, false));
    this.protos.set('blueShell', this.buildShell(0x2b6fe8, 0x0d2f80, true));
    this.protos.set('banana', this.buildBanana());
    this.protos.set('bomb', this.buildBomb());
    this.protos.set('mushroom', this.buildMushroom());
    this.protos.set('star', this.buildStar());
    this.protos.set('lightning', this.buildLightning());
    this.protos.set('bullet', this.buildBullet());
    this.protos.set('coin', this.buildCoin());
    this.protos.set('ghost', this.buildGhost());
    this.protos.set('squid', this.buildSquid());

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
      this.texs.push(this.atlas);
    }
    return this.atlas;
  }

  /** UV rect (origin bottom-left, matching THREE's texture space). */
  getIconUV(item: ItemType): IconRect {
    return this.uvRects.get(item) ?? { x: 0, y: 0, w: 1, h: 1 };
  }

  /** Raw canvas — handy for a 2D/DOM HUD that wants drawImage instead of UVs. */
  getIconCanvas(): HTMLCanvasElement | null { return this.atlasCanvas; }

  /** Pixel rect within the atlas canvas, origin top-left. */
  getIconPixelRect(item: ItemType): IconRect {
    const i = item as number;
    const col = i % ATLAS_COLS;
    const row = Math.floor(i / ATLAS_COLS);
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
  // BANANA
  // -------------------------------------------------------------------------

  private buildBanana(): THREE.Group {
    const g = new THREE.Group();
    const pts: THREE.Vector3[] = [];
    const SEG = 9;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const a = lerp(-1.22, 1.22, t);
      pts.push(new THREE.Vector3(Math.sin(a) * 0.60, -Math.cos(a) * 0.40 + 0.40, 0));
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const geo = this.reg(sweep(curve, 48, 18, (t) => {
      const belly = Math.pow(Math.sin(Math.PI * clamp01(t)), 0.62);
      const taper = 0.10 + 0.90 * belly;
      // Slightly fatter at the stem end, pointed at the tip.
      return 0.152 * taper * (1 + (1 - t) * 0.13);
    }, 0.86));

    const cSkin = new THREE.Color(0xf7d23a);
    const cDeep = new THREE.Color(0xc9902a);
    const cTip = new THREE.Color(0x5d4321);
    const albedo = this.regT(pixelTexture(512, (u, v, o) => {
      // u = along the banana, v = around it
      const tipA = smoothstep((0.055 - u) / 0.055);
      const tipB = smoothstep((u - 0.955) / 0.045);
      const facet = Math.abs(Math.sin(v * Math.PI * 3)) * 0.5 + 0.5;
      const c = cDeep.clone().lerp(cSkin, 0.35 + facet * 0.65);
      // Longitudinal ridges darken slightly in the valleys.
      c.multiplyScalar(0.9 + facet * 0.14);
      const n = fbm(u * 26, v * 9, 4);
      if (n > 0.71) c.lerp(cTip, (n - 0.71) * 2.4);
      c.offsetHSL((n - 0.5) * 0.012, 0.02, (n - 0.5) * 0.05);
      c.lerp(cTip, clamp01(tipA + tipB));
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const normal = this.regT(normalFromHeight(256, (u, v) =>
      0.5 + Math.sin(v * Math.PI * 3) * 0.08 + fbm(u * 30, v * 12, 3) * 0.09, 1.7));

    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      map: albedo,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.42,
      metalness: 0.0,
      clearcoat: 0.75,
      clearcoatRoughness: 0.28,
      sheen: 0.5,
      sheenColor: new THREE.Color(0xfff0a8),
      envMapIntensity: 1.0,
    }));
    const body = new THREE.Mesh(geo, mat);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // Stem
    const stemMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0x6b4f22, roughness: 0.72, metalness: 0.0,
    }));
    const stem = new THREE.Mesh(this.reg(new THREE.CylinderGeometry(0.035, 0.055, 0.14, 10, 1)), stemMat);
    const p0 = curve.getPointAt(0, new THREE.Vector3());
    const t0 = curve.getTangentAt(0, new THREE.Vector3());
    stem.position.copy(p0).addScaledVector(t0, -0.05);
    stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), t0.clone().negate());
    g.add(stem);

    g.rotation.y = Math.PI * 0.12;
    return g;
  }

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
  // MUSHROOM
  // -------------------------------------------------------------------------

  private buildMushroom(): THREE.Group {
    const g = new THREE.Group();

    // Cap profile: dome with an under-lip so the silhouette has a real edge.
    const capPts: THREE.Vector2[] = [];
    const N = 22;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 0.5;
      capPts.push(new THREE.Vector2(
        Math.max(0.0006, 0.50 * Math.pow(Math.sin(a), 0.70)),
        0.20 + 0.34 * Math.pow(Math.cos(a), 1.15),
      ));
    }
    capPts.push(new THREE.Vector2(0.505, 0.17));
    capPts.push(new THREE.Vector2(0.478, 0.135));
    capPts.push(new THREE.Vector2(0.40, 0.125));
    capPts.push(new THREE.Vector2(0.30, 0.135));

    // Spot layout in lathe UV space (u = around, v = apex -> rim)
    const spots: Array<[number, number, number]> = [
      [0.12, 0.30, 0.115], [0.44, 0.22, 0.088], [0.72, 0.34, 0.105],
      [0.28, 0.60, 0.095], [0.60, 0.62, 0.085], [0.90, 0.58, 0.100],
      [0.02, 0.78, 0.070], [0.50, 0.82, 0.062],
    ];
    const spotAt = (u: number, v: number): number => {
      let m = 0;
      for (const [su, sv, sr] of spots) {
        const du = wrapDist(u, su);
        const dv = (v - sv) * 0.72;
        const d = Math.hypot(du, dv);
        m = Math.max(m, 1 - smoothstep((d - sr * 0.72) / (sr * 0.42)));
      }
      return m;
    };

    const cRed = new THREE.Color(0xe8402f);
    const cDark = new THREE.Color(0x8f1a14);
    const capTex = this.regT(pixelTexture(512, (u, v, o) => {
      const s = spotAt(u, v);
      const shade = clamp01(0.32 + (1 - v) * 0.85);
      const c = cDark.clone().lerp(cRed, shade);
      c.lerp(new THREE.Color(0xff9a70), Math.pow(1 - v, 4) * 0.5);
      const n = ringNoise(u, v, 8, 3);
      c.offsetHSL(0, 0, (n - 0.5) * 0.05);
      const spotC = new THREE.Color(0xfff6ea).lerp(new THREE.Color(0xe8d8c4), v * 0.5);
      c.lerp(spotC, s);
      c.multiplyScalar(1 - smoothstep((v - 0.88) / 0.12) * 0.30);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const capNrm = this.regT(normalFromHeight(256, (u, v) =>
      0.5 + spotAt(u, v) * 0.10 + ringNoise(u, v, 14, 3) * 0.05, 1.5));

    const capMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: capTex,
      normalMap: capNrm,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.40,
      metalness: 0.0,
      clearcoat: 0.85,
      clearcoatRoughness: 0.22,
      sheen: 0.75,
      sheenColor: new THREE.Color(0xff9e86),
      sheenRoughness: 0.55,
      // Cheap stand-in for subsurface: a touch of forward scattering.
      transmission: 0.10,
      thickness: 0.35,
      ior: 1.4,
      attenuationColor: new THREE.Color(0xff5a3c),
      attenuationDistance: 0.6,
      envMapIntensity: 1.1,
    }));
    const cap = new THREE.Mesh(this.reg(lathe(capPts, 64)), capMat);
    cap.castShadow = true;
    cap.receiveShadow = true;
    g.add(cap);

    // Stem
    const stemPts: THREE.Vector2[] = [
      new THREE.Vector2(0.0006, -0.34),
      new THREE.Vector2(0.20, -0.345),
      new THREE.Vector2(0.29, -0.30),
      new THREE.Vector2(0.245, -0.15),
      new THREE.Vector2(0.245, 0.0),
      new THREE.Vector2(0.285, 0.10),
      new THREE.Vector2(0.30, 0.145),
      new THREE.Vector2(0.0006, 0.15),
    ];
    const stemTex = this.regT(pixelTexture(256, (u, v, o) => {
      const c = new THREE.Color(0xf6ead2).lerp(new THREE.Color(0xd3bd9c), smoothstep(v * 1.1) * 0.45);
      const n = ringNoise(u, v, 9, 3);
      c.offsetHSL(0, 0, (n - 0.5) * 0.045);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const stemMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: stemTex,
      roughness: 0.55,
      metalness: 0.0,
      sheen: 0.6,
      sheenColor: new THREE.Color(0xfff4e2),
      transmission: 0.06,
      thickness: 0.3,
      envMapIntensity: 1.0,
    }));
    const stem = new THREE.Mesh(this.reg(lathe(stemPts, 48)), stemMat);
    stem.castShadow = true;
    g.add(stem);

    this.addEyes(g, 0.052, new THREE.Vector3(0, -0.10, 0.245), 0.10, false);
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
  // LIGHTNING
  // -------------------------------------------------------------------------

  private buildLightning(): THREE.Group {
    const g = new THREE.Group();
    const geo = this.reg(new THREE.ExtrudeGeometry(boltShape(0.62), {
      depth: 0.14,
      bevelEnabled: true,
      bevelThickness: 0.055,
      bevelSize: 0.045,
      bevelSegments: 3,
      curveSegments: 2,
    }));
    geo.center();
    geo.computeVertexNormals();
    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xfff05a,
      emissive: new THREE.Color(0xffd400),
      emissiveIntensity: 2.6,
      roughness: 0.22,
      metalness: 0.15,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.3,
    }));
    const bolt = new THREE.Mesh(geo, mat);
    bolt.castShadow = true;
    g.add(bolt);

    const halo = new THREE.Sprite(this.regM(new THREE.SpriteMaterial({
      map: this.glowTexture!, color: 0xffe066,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5,
    })));
    halo.scale.setScalar(1.8);
    g.add(halo);
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
  // COIN
  // -------------------------------------------------------------------------

  private buildCoin(): THREE.Group {
    const g = new THREE.Group();
    const R = 0.36;

    // Rim: beveled lathe ring
    const rimPts: THREE.Vector2[] = [
      new THREE.Vector2(R * 0.92, 0.055),
      new THREE.Vector2(R * 0.99, 0.040),
      new THREE.Vector2(R, 0.0),
      new THREE.Vector2(R * 0.99, -0.040),
      new THREE.Vector2(R * 0.92, -0.055),
    ];
    const goldTex = this.regT(pixelTexture(256, (u, v, o) => {
      const c = new THREE.Color(0xffc422).lerp(new THREE.Color(0xa06a06), Math.abs(v - 0.5) * 1.4);
      const n = ringNoise(u, v, 22, 3);
      c.offsetHSL((n - 0.5) * 0.02, 0, (n - 0.5) * 0.06);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const rimNrm = this.regT(normalFromHeight(256, (u) =>
      0.5 + Math.sin(u * Math.PI * 2 * 48) * 0.13, 1.6)); // milled edge
    const goldMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: goldTex,
      normalMap: rimNrm,
      roughness: 0.17,
      metalness: 1.0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.5,
    }));
    this.trackMetal(goldMat, 1.0, 0.45);
    const rim = new THREE.Mesh(this.reg(lathe(rimPts, 56)), goldMat);
    rim.castShadow = true;
    g.add(rim);

    // Faces: embossed star inside a raised ring
    const embossH = (u: number, v: number): number => {
      const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
      const r = Math.hypot(x, y);
      if (r > 1) return 0;
      let h = 0.45;
      // Raised inner ring
      h += (1 - smoothstep((Math.abs(r - 0.80) - 0.02) / 0.06)) * 0.22;
      // 5-point star emboss
      const a = Math.atan2(y, x);
      const k = Math.cos(a * 5) * 0.5 + 0.5;
      const starR = lerp(0.24, 0.56, Math.pow(k, 0.7));
      h += (1 - smoothstep((r - starR) / 0.05)) * 0.30;
      h -= (1 - smoothstep((Math.abs(r - 0.93) - 0.01) / 0.04)) * 0.12;
      return h;
    };
    const faceTex = this.regT(pixelTexture(512, (u, v, o) => {
      const h = embossH(u, v);
      const c = new THREE.Color(0xffc422).lerp(new THREE.Color(0xfff0b0), clamp01((h - 0.45) * 1.9));
      c.lerp(new THREE.Color(0x9c6404), clamp01((0.45 - h) * 2.4));
      const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
      const r = Math.hypot(x, y);
      c.multiplyScalar(1 - smoothstep((r - 0.86) / 0.12) * 0.25);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const faceNrm = this.regT(normalFromHeight(256, embossH, 3.4));
    const faceMat = this.regM(new THREE.MeshPhysicalMaterial({
      map: faceTex,
      normalMap: faceNrm,
      normalScale: new THREE.Vector2(1.5, 1.5),
      roughness: 0.15,
      metalness: 1.0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.6,
    }));
    this.trackMetal(faceMat, 1.0, 0.45);
    const faceGeo = this.reg(new THREE.CircleGeometry(R * 0.945, 56));
    for (const s of [1, -1]) {
      const f = new THREE.Mesh(faceGeo, faceMat);
      f.position.y = s * 0.0545;
      f.rotation.x = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      f.castShadow = true;
      g.add(f);
    }
    g.rotation.x = Math.PI / 2; // face the camera by default
    return g;
  }

  // -------------------------------------------------------------------------
  // BOO
  // -------------------------------------------------------------------------

  private buildGhost(): THREE.Group {
    const g = new THREE.Group();
    const pts: THREE.Vector2[] = [];
    const N = 20;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 0.62;
      pts.push(new THREE.Vector2(Math.max(0.0006, 0.46 * Math.sin(a) * (1 + a * 0.10)), 0.44 * Math.cos(a)));
    }
    pts.push(new THREE.Vector2(0.50, -0.20));
    pts.push(new THREE.Vector2(0.47, -0.33));
    pts.push(new THREE.Vector2(0.40, -0.40));
    pts.push(new THREE.Vector2(0.20, -0.42));
    pts.push(new THREE.Vector2(0.0006, -0.42));
    const geo = this.reg(lathe(pts, 56));
    wavySkirt(geo, pts.length, 0.085, 7);

    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xf4f8ff,
      roughness: 0.32,
      metalness: 0.0,
      transmission: 0.55,
      thickness: 0.7,
      ior: 1.15,
      transparent: true,
      opacity: 0.92,
      clearcoat: 0.6,
      sheen: 0.9,
      sheenColor: new THREE.Color(0xbfd8ff),
      sheenRoughness: 0.4,
      side: THREE.DoubleSide,
      envMapIntensity: 1.1,
      depthWrite: false,
    }));
    const body = new THREE.Mesh(geo, mat);
    g.add(body);

    this.addEyes(g, 0.075, new THREE.Vector3(0, 0.06, 0.40), 0.135, false);
    const mouthMat = this.regM(new THREE.MeshStandardMaterial({ color: 0x1b1f2c, roughness: 0.7 }));
    const mouthGeo = this.reg(new THREE.SphereGeometry(0.11, 16, 12));
    mouthGeo.scale(1.0, 0.62, 0.4);
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, -0.11, 0.40);
    g.add(mouth);

    // Tongue
    const tongue = new THREE.Mesh(this.reg(new THREE.SphereGeometry(0.055, 12, 8)), this.regM(
      new THREE.MeshStandardMaterial({ color: 0xff6a8a, roughness: 0.5 })));
    tongue.scale.set(1, 0.6, 0.5);
    tongue.position.set(0, -0.14, 0.44);
    g.add(tongue);
    return g;
  }

  // -------------------------------------------------------------------------
  // SQUID (Blooper)
  // -------------------------------------------------------------------------

  private buildSquid(): THREE.Group {
    const g = new THREE.Group();
    const pts: THREE.Vector2[] = [];
    const N = 18;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 0.55;
      pts.push(new THREE.Vector2(Math.max(0.0006, 0.34 * Math.sin(a)), 0.20 + 0.46 * Math.cos(a)));
    }
    pts.push(new THREE.Vector2(0.345, 0.10));
    pts.push(new THREE.Vector2(0.32, -0.02));
    pts.push(new THREE.Vector2(0.26, -0.08));
    pts.push(new THREE.Vector2(0.0006, -0.10));

    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xf2f5fb,
      roughness: 0.34,
      metalness: 0.0,
      clearcoat: 0.85,
      clearcoatRoughness: 0.2,
      sheen: 0.8,
      sheenColor: new THREE.Color(0xa8c4ff),
      transmission: 0.18,
      thickness: 0.5,
      envMapIntensity: 1.1,
    }));
    const mantle = new THREE.Mesh(this.reg(lathe(pts, 48)), mat);
    mantle.castShadow = true;
    g.add(mantle);

    // Fins
    const finGeo = this.reg(new THREE.SphereGeometry(0.14, 14, 10));
    finGeo.scale(1.0, 0.42, 0.55);
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(finGeo, mat);
      f.position.set(s * 0.30, 0.40, 0);
      f.rotation.z = s * 0.5;
      g.add(f);
    }

    // Tentacles
    const inkMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0x1a1e2b, roughness: 0.55, metalness: 0.0,
    }));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const r = 0.20;
      const c = new THREE.CatmullRomCurve3([
        new THREE.Vector3(Math.cos(a) * r, -0.06, Math.sin(a) * r),
        new THREE.Vector3(Math.cos(a) * r * 1.45, -0.24, Math.sin(a) * r * 1.45),
        new THREE.Vector3(Math.cos(a) * r * 1.15, -0.40, Math.sin(a) * r * 1.15),
      ]);
      const t = new THREE.Mesh(this.reg(sweep(c, 14, 8, (k) => 0.052 * (1 - k * 0.72))), mat);
      g.add(t);
    }

    this.addEyes(g, 0.085, new THREE.Vector3(0, 0.30, 0.28), 0.135, false);
    // Ink blob under it, for the icon read
    const blob = new THREE.Mesh(this.reg(new THREE.SphereGeometry(0.13, 14, 10)), inkMat);
    blob.scale.set(1.3, 0.7, 1.0);
    blob.position.set(0.0, -0.38, 0.12);
    g.add(blob);
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
   */
  private async bakeIconAtlas(): Promise<void> {
    const W = ATLAS_COLS * ATLAS_CELL;
    const H = ATLAS_ROWS * ATLAS_CELL;

    // UV rects first — they're valid even if the GL bake fails.
    for (let i = 0; i < 16; i++) {
      const col = i % ATLAS_COLS;
      const row = Math.floor(i / ATLAS_COLS);
      this.uvRects.set(i as ItemType, {
        x: col / ATLAS_COLS,
        y: 1 - (row + 1) / ATLAS_ROWS,
        w: 1 / ATLAS_COLS,
        h: 1 / ATLAS_ROWS,
      });
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

      // A tiny PMREM environment so metals (coin, bullet, bomb) read as metal.
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = this.makeStudioEnvScene();
      const envRT = pmrem.fromScene(envScene, 0.04);
      scene.environment = envRT.texture;
      for (const m of this.metalMats) m.mat.metalness = m.full;

      const holder = new THREE.Group();
      scene.add(holder);

      for (let i = 0; i < 16; i++) {
        const item = i as ItemType;
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
        const col = i % ATLAS_COLS;
        const row = Math.floor(i / ATLAS_COLS);
        out.drawImage(renderer.domElement, col * ATLAS_CELL, row * ATLAS_CELL, ATLAS_CELL, ATLAS_CELL);
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
      const fallback: Record<number, string> = {
        0: '#ff5a3c', 1: '#ff5a3c', 2: '#2fbf3f', 3: '#2fbf3f', 4: '#e8302a', 5: '#e8302a',
        6: '#f7d23a', 7: '#f7d23a', 8: '#1b1f28', 9: '#ffe14a', 10: '#fff05a', 11: '#e8eeff',
        12: '#8b93a5', 13: '#2b6fe8', 14: '#ffc422', 15: '#5b6ee8',
      };
      for (let i = 0; i < 16; i++) {
        const col = i % ATLAS_COLS, row = Math.floor(i / ATLAS_COLS);
        out.fillStyle = fallback[i] ?? '#888';
        out.beginPath();
        out.arc(col * ATLAS_CELL + 128, row * ATLAS_CELL + 128, 96, 0, Math.PI * 2);
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

  /** Icon subject: triples show three copies fanned out, like MK8's HUD. */
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
      if (item === ItemType.Coin) m.rotation.set(Math.PI / 2, 0, 0.35);
      if (item === ItemType.Bullet) m.rotation.y = Math.PI * 0.86;
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
