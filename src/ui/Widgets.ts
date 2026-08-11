/**
 * ============================================================================
 *  FOXY KART — UI WIDGET LIBRARY
 * ============================================================================
 *  Shared, allocation-conscious building blocks for the HUD, the menus and the
 *  results screen:
 *
 *   - tiny DOM helpers (`el`, `svgEl`, `restartAnim`, `punch`)
 *   - `Spring`: critically-tunable numeric spring for smoothed readouts
 *   - `ItemIcons`: procedural, chunky item artwork (uses the items subsystem's
 *     atlas when one exists, otherwise paints its own — both must look good)
 *   - procedural `characterPortrait`, `kartThumb`, `trackPreview` art
 *   - `confetti`
 *   - the *structural* host interfaces every UI class takes in its constructor
 *
 *  HOST INTERFACES — WHY THEY ARE STRUCTURAL
 *  The UI is built in parallel with KartManager / RaceDirector / Track /
 *  ItemSystem, so those classes may not exist yet. Rather than import them (and
 *  hard-fail the build), the UI declares the *minimum shape* it reads and
 *  probes anything optional at runtime. Real subsystems satisfy these shapes
 *  structurally, so `new HUD(container, karts, race, track, engine)` in Game.ts
 *  type-checks unchanged. Payload types themselves still come from
 *  `@/core/Types` — no parallel contracts are invented.
 * ============================================================================
 */

import type * as THREE from 'three';
import type {
  IAudioService, InputState, KartState, QualitySettings, QualityTier,
} from '@/core/Types';
import { ItemType } from '@/core/Types';
import { clamp, clamp01 } from '@/core/MathUtils';
// The item set is DERIVED, never retyped here. `LIVE_ITEMS` is the roulette's
// own reading order, `ITEM_NAMES` its own display names (post re-skin: Battery,
// Rocket, Plastic Bottle, Ninja) and `TRIPLE_ITEMS` its own stacking set — which
// is now empty, every tier having collapsed to one. This file used to carry a
// parallel copy of all three, including `Lightning` and `Squid`, both since
// removed: the reel would have spun through icons for items no roll can produce
// and the HUD would have called the Battery a "MUSHROOM". A parallel list is the
// exact defect that made the character-select screen a placebo — see the note at
// the top of `./Catalogue`.
import { LIVE_ITEMS } from '@/items/ItemRoulette';
import { ITEM_NAMES, TRIPLE_ITEMS } from '@/items/ItemModels';

// ===========================================================================
// Host shapes
// ===========================================================================

export interface KartsLike {
  /** Every racer, in stable id order. */
  readonly karts: readonly KartState[];
  /** The local player, if a race is live. */
  readonly player?: KartState | null;
}

export interface RaceLike {
  /** `'countdown' | 'racing' | 'finished'` or an enum — normalised at runtime. */
  readonly state?: unknown;
  /** Seconds remaining on the start countdown, counting down to 0. */
  readonly countdown?: number;
  /** Seconds since the lights went out. */
  readonly raceTime?: number;
  readonly totalLaps?: number;
  readonly results?: readonly unknown[];
  getPosition?(kartId: number): number;
  getLap?(kartId: number): number;
}

export interface TrackLike {
  readonly lapLength?: number;
  readonly lapCount?: number;
  /** Closed 2-D loop of the centreline in world XZ. */
  getMinimapPath?(): readonly { x: number; y: number }[];
}

export interface ItemsLike {
  getIconAtlas?(): unknown;
  getIconUV?(item: ItemType): unknown;
}

export interface RendererInfoLike {
  readonly render: { readonly calls: number; readonly triangles: number };
  readonly memory: { readonly geometries: number; readonly textures: number };
}

export interface EngineLike {
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: { readonly info: RendererInfoLike };
  readonly quality: QualitySettings;
  readonly fpsAverage: number;
  getSize(): { width: number; height: number };
  setQuality?(tier: QualityTier): void;
}

export type AudioLike = Partial<IAudioService> & {
  setMasterVolume?(v: number): void;
  setMusicVolume?(v: number): void;
  setSfxVolume?(v: number): void;
  resume?(): void;
};

export interface GameLike {
  readonly engine?: EngineLike;
  readonly karts?: KartsLike;
  readonly race?: RaceLike;
  readonly track?: TrackLike;
  readonly items?: ItemsLike;
  readonly audio?: AudioLike;
  readonly camera?: unknown;
  readonly hud?: unknown;
  readonly input?: { readonly state?: InputState };
  startRace?(opts: { trackId?: string; characterId?: string; cc?: number }): void;
}

/**
 * Read a possibly-absent member off a foreign subsystem.
 * The whole UI degrades instead of throwing when a sibling isn't finished.
 */
export function probe<T>(obj: unknown, key: string): T | undefined {
  if (obj === null || obj === undefined) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return v === undefined || v === null ? undefined : (v as T);
}

/** Call an optional method on a foreign object, swallowing any failure. */
export function tryCall<R>(obj: unknown, key: string, ...args: unknown[]): R | undefined {
  const fn = probe<(...a: unknown[]) => R>(obj, key);
  if (typeof fn !== 'function') return undefined;
  try {
    return fn.apply(obj, args);
  } catch {
    return undefined;
  }
}

// ===========================================================================
// DOM helpers
// ===========================================================================

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, parent?: Node, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs?: Record<string, string>, parent?: Node,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

/** Re-trigger a CSS animation class that may already be applied. */
export function restartAnim(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  // Forcing style recalculation is the only way to restart a CSS animation.
  // It is event-driven (never per-frame), so the reflow cost is irrelevant.
  void node.offsetWidth;
  node.classList.add(cls);
}

/** Set a class only when it actually changes — avoids pointless style invalidation. */
export function setClass(node: Element, cls: string, on: boolean): void {
  if (node.classList.contains(cls) === on) return;
  node.classList.toggle(cls, on);
}

/** Write textContent only on change. */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

const HAS_WAAPI = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

/**
 * Anticipation → overshoot → settle scale punch, via the Web Animations API so
 * it composites off the main thread and cleans itself up.
 */
export function punch(node: HTMLElement, strength = 1, ms = 420, extra = ''): void {
  if (!HAS_WAAPI) return;
  const s = 1 + 0.28 * strength;
  const dip = 1 - 0.06 * strength;
  node.animate(
    [
      { transform: `${extra} scale(${dip})`, offset: 0 },
      { transform: `${extra} scale(${s})`, offset: 0.28 },
      { transform: `${extra} scale(${1 - 0.03 * strength})`, offset: 0.62 },
      { transform: `${extra} scale(1)`, offset: 1 },
    ],
    { duration: ms, easing: 'cubic-bezier(.16,1,.3,1)', composite: 'replace' },
  );
}

/** One-shot colour flash on a plate (green gain / red loss). */
export function flashColor(node: HTMLElement, color: string, ms = 520): void {
  if (!HAS_WAAPI) return;
  node.animate(
    [
      { opacity: 0.95, transform: 'scale(1.04)' },
      { opacity: 0, transform: 'scale(1)' },
    ],
    { duration: ms, easing: 'cubic-bezier(.16,1,.3,1)' },
  );
  node.style.background = color;
}

// ===========================================================================
// Spring — needle inertia with a touch of overshoot
// ===========================================================================

export class Spring {
  value: number;
  velocity = 0;
  target: number;
  stiffness: number;
  damping: number;

  constructor(value = 0, stiffness = 150, damping = 14) {
    this.value = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  /** Semi-implicit Euler, substepped so it can never explode on a long frame. */
  step(dt: number): number {
    const steps = dt > 1 / 45 ? Math.min(6, Math.ceil(dt * 240)) : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  snap(v: number): void {
    this.value = v; this.target = v; this.velocity = 0;
  }
}

// ===========================================================================
// Canvas helpers
// ===========================================================================

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', { alpha: true });
}

/** Rounded rect path (Path2D.roundRect isn't universal enough to rely on). */
export function roundRect(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.quadraticCurveTo(x + w, y, x + w, y + rr);
  c.lineTo(x + w, y + h - rr);
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  c.lineTo(x + rr, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - rr);
  c.lineTo(x, y + rr);
  c.quadraticCurveTo(x, y, x + rr, y);
  c.closePath();
}

function star(
  c: CanvasRenderingContext2D, cx: number, cy: number, outer: number, inner: number, points = 5,
): void {
  c.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
}

// ===========================================================================
// (The 232u analogue speedometer that used to live here — dished plate, tick
//  scale with numbered majors, red zone, needle and hub — was removed. It read
//  as a flight-sim instrument rather than a kart HUD, and MK8 ships no
//  speedometer at all. `.ak-speed` is now a compact digital readout plus a
//  transform-driven boost bar: pure DOM, ~1/4 the footprint, and one fewer
//  canvas redrawn every frame.)
// ===========================================================================

/** Canvas needs a literal stack — it can't read the CSS custom property. */
const FONT_STACK_CANVAS =
  'system-ui, -apple-system, "SF Pro Display", "Segoe UI", Inter, Roboto, sans-serif';

// ===========================================================================
// Item icons
// ===========================================================================

interface ItemStyle { a: string; b: string; c: string }

const SHELL_GREEN: ItemStyle = { a: '#d9ffb0', b: '#4fd139', c: '#137a1c' };
const SHELL_RED: ItemStyle = { a: '#ffd9d0', b: '#ff4a3a', c: '#a80f0f' };
const SHELL_BLUE: ItemStyle = { a: '#dff3ff', b: '#3f8dff', c: '#0f2fa8' };

/**
 * Procedural item artwork. Every icon is a chunky, high-contrast silhouette
 * with a fat dark outline so it reads at 40 px on a bright track.
 */
export class ItemIcons {
  private cache = new Map<string, string>();
  private atlasUrl: string | null = null;
  private atlasSize = { w: 0, h: 0 };
  private uv: ((item: ItemType) => { x: number; y: number; w: number; h: number } | null) | null = null;
  private size: number;

  constructor(size = 128) {
    this.size = size;
  }

  /**
   * Adopt the items subsystem's atlas if it exposes one. Supports a raw canvas,
   * an ImageBitmap-ish object, or a THREE.Texture wrapper, and UV rectangles
   * given as {x,y,w,h}, {u0,v0,u1,v1} or a Vector4.
   */
  useAtlas(items: ItemsLike | undefined): void {
    if (!items) { this.warnNoAtlas('no items subsystem was handed to the HUD'); return; }
    const atlas = tryCall<unknown>(items, 'getIconAtlas');
    if (!atlas) { this.warnNoAtlas('getIconAtlas() returned nothing'); return; }
    const src = this.resolveImage(atlas);
    if (!src) { this.warnNoAtlas('the atlas is not a readable canvas'); return; }
    this.atlasUrl = src.url;
    this.atlasSize = { w: src.w, h: src.h };
    const uvFn = probe<(i: ItemType) => unknown>(items, 'getIconUV');
    if (typeof uvFn !== 'function') { this.atlasUrl = null; return; }
    this.uv = (item: ItemType) => {
      try {
        const raw = uvFn.call(items, item) as Record<string, number> | undefined;
        if (!raw) return null;
        const n = (k: string) => (typeof raw[k] === 'number' ? raw[k] : undefined);
        const x = n('x') ?? n('u0') ?? n('u');
        const y = n('y') ?? n('v0') ?? n('v');
        if (x === undefined || y === undefined) return null;
        let w = n('w') ?? n('width');
        let h = n('h') ?? n('height');
        if (w === undefined) {
          const u1 = n('u1') ?? n('z');
          w = u1 !== undefined ? u1 - x : undefined;
        }
        if (h === undefined) {
          const v1 = n('v1') ?? n('w');
          h = v1 !== undefined ? v1 - y : undefined;
        }
        if (w === undefined || h === undefined || w <= 0 || h <= 0) return null;
        return { x, y, w, h };
      } catch {
        return null;
      }
    };
  }

  private resolveImage(atlas: unknown): { url: string; w: number; h: number } | null {
    const asCanvas = (o: unknown): HTMLCanvasElement | null => {
      if (typeof HTMLCanvasElement !== 'undefined' && o instanceof HTMLCanvasElement) return o;
      return null;
    };
    let canvas = asCanvas(atlas);
    if (!canvas) canvas = asCanvas(probe<unknown>(atlas, 'image'));
    if (!canvas) canvas = asCanvas(probe<unknown>(atlas, 'source'));
    if (!canvas) return null;
    try {
      return { url: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
    } catch {
      return null;
    }
  }

  /**
   * Say so, once, when the item slot falls back to the procedural drawings.
   *
   * This is not cosmetic any more. `ItemModels` owns the real icon art and is
   * being RE-SKINNED (Rocket / Plastic Bottle / Battery / Ninja); the drawings in
   * this file are the old MK8 shapes, so without the atlas the HUD shows a
   * banana for the Plastic Bottle and a mushroom for the Battery. A silent
   * fallback is how a whole subsystem hides — same shape as the minimap's
   * normalised-path warning.
   *
   * As of this writing `Game.ts` never calls `hud.setItems(this.items)`, so this
   * fires on every boot. One line next to `wire(this.hud, 'setAudio', …)` fixes
   * it: `wire(this.hud, 'setItems', this.items);`
   */
  private warnNoAtlas(why: string): void {
    if (ItemIcons.warnedNoAtlas) return;
    ItemIcons.warnedNoAtlas = true;
    console.warn(
      `[ItemIcons] no item icon atlas (${why}) — falling back to the built-in `
      + 'drawings, which are NOT the re-skinned art. Game.ts needs '
      + 'wire(this.hud, \'setItems\', this.items).',
    );
  }

  private static warnedNoAtlas = false;

  /** Point a DOM node's background at the icon for `item`. */
  apply(node: HTMLElement, item: ItemType | null): void {
    if (item === null) {
      node.style.backgroundImage = 'none';
      return;
    }
    if (this.atlasUrl && this.uv) {
      const r = this.uv(item);
      if (r) {
        // UVs may be normalised (0..1) or pixel rects — detect and normalise.
        const norm = r.w <= 1.0001 && r.h <= 1.0001;
        const aw = this.atlasSize.w || 1;
        const ah = this.atlasSize.h || 1;
        const fx = norm ? r.x : r.x / aw;
        const fy = norm ? r.y : r.y / ah;
        const fw = norm ? r.w : r.w / aw;
        const fh = norm ? r.h : r.h / ah;
        node.style.backgroundImage = `url("${this.atlasUrl}")`;
        node.style.backgroundSize = `${(100 / fw).toFixed(3)}% ${(100 / fh).toFixed(3)}%`;
        node.style.backgroundPosition =
          `${((fx / (1 - fw || 1)) * 100).toFixed(3)}% ${((fy / (1 - fh || 1)) * 100).toFixed(3)}%`;
        node.style.backgroundRepeat = 'no-repeat';
        return;
      }
    }
    node.style.backgroundSize = 'contain';
    node.style.backgroundPosition = 'center';
    node.style.backgroundImage = `url("${this.url(item)}")`;
  }

  /** Cached data URL of the procedural icon. */
  url(item: ItemType): string {
    const key = `${item}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const canvas = this.paint(item);
    let url = '';
    try { url = canvas.toDataURL('image/png'); } catch { url = ''; }
    this.cache.set(key, url);
    return url;
  }

  /** Base item behind a triple / count variant. */
  static base(item: ItemType): ItemType {
    switch (item) {
      case ItemType.TripleBoost: return ItemType.Boost;
      case ItemType.TripleGreenShell: return ItemType.GreenShell;
      case ItemType.TripleRedShell: return ItemType.RedShell;
      case ItemType.TripleBanana: return ItemType.Banana;
      default: return item;
    }
  }

  /**
   * Triples are the items module's business, not ours — the set is currently
   * EMPTY (every tier collapsed to one), and a hardcoded copy of the old four
   * would have kept drawing a "x3" badge for items that no longer stack.
   */
  static isTriple(item: ItemType): boolean {
    return TRIPLE_ITEMS.has(item);
  }

  /**
   * Display name, from the items module's own `ITEM_NAMES`.
   *
   * This used to be a hardcoded switch of MK8 names, which after the re-skin
   * would have shown "MUSHROOM" for the Battery, "RED SHELL" for the Rocket,
   * "BANANA" for the Plastic Bottle and "BOO" for the Ninja — a parallel list
   * drifting from the game, which is the exact failure that made the whole
   * character-select screen a placebo. Derived now.
   */
  static label(item: ItemType): string {
    return (ITEM_NAMES[item] ?? 'ITEM').toUpperCase();
  }

  /**
   * Roulette spin order — the items module's live set, in its own reading order.
   *
   * The old hardcoded array listed twelve kinds including `Lightning` and
   * `Squid`, both now REMOVED, and `TripleBanana`, now unreachable. The reel
   * would have spun through icons for items no roll can ever produce.
   */
  static get ROULETTE(): readonly ItemType[] { return LIVE_ITEMS; }

  private paint(item: ItemType): HTMLCanvasElement {
    const S = this.size;
    const canvas = makeCanvas(S, S);
    const c = ctx2d(canvas);
    if (!c) return canvas;
    const base = ItemIcons.base(item);
    c.save();
    c.translate(S * 0.5, S * 0.5);
    const R = S * 0.40;
    switch (base) {
      case ItemType.GreenShell: this.shell(c, R, SHELL_GREEN); break;
      case ItemType.RedShell: this.shell(c, R, SHELL_RED); break;
      case ItemType.BlueShell: this.blueShell(c, R); break;
      case ItemType.Banana: this.banana(c, R); break;
      case ItemType.Bomb: this.bomb(c, R); break;
      case ItemType.Star: this.starItem(c, R); break;
      case ItemType.Lightning: this.bolt(c, R); break;
      case ItemType.Ghost: this.ghost(c, R); break;
      case ItemType.Bullet: this.bullet(c, R); break;
      case ItemType.Coin: this.coin(c, R); break;
      case ItemType.Squid: this.squid(c, R); break;
      case ItemType.Boost:
      default: this.mushroom(c, R); break;
    }
    c.restore();
    return canvas;
  }

  // -- painters ------------------------------------------------------------

  private outline(c: CanvasRenderingContext2D, w = 0.13): void {
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.lineWidth = this.size * w * 0.5;
    c.strokeStyle = '#0a1020';
    c.stroke();
  }

  private gloss(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(x, y, r, r * 0.7, -0.4, 0, Math.PI * 2);
    c.fill();
  }

  private shell(c: CanvasRenderingContext2D, R: number, s: ItemStyle): void {
    // White under-rim.
    c.beginPath();
    c.ellipse(0, R * 0.34, R * 0.98, R * 0.44, 0, 0, Math.PI * 2);
    c.fillStyle = '#fdfdfa';
    c.fill();
    this.outline(c, 0.1);

    // Dome.
    c.beginPath();
    c.arc(0, R * 0.1, R * 0.94, Math.PI, 0);
    c.closePath();
    const g = c.createRadialGradient(-R * 0.3, -R * 0.5, R * 0.06, 0, R * 0.1, R * 1.12);
    g.addColorStop(0, s.a);
    g.addColorStop(0.45, s.b);
    g.addColorStop(1, s.c);
    c.fillStyle = g;
    c.fill();
    this.outline(c, 0.11);

    // Segment lines.
    c.save();
    c.beginPath();
    c.arc(0, R * 0.1, R * 0.9, Math.PI, 0);
    c.closePath();
    c.clip();
    c.strokeStyle = 'rgba(10,20,32,0.35)';
    c.lineWidth = this.size * 0.018;
    for (let i = -2; i <= 2; i++) {
      c.beginPath();
      c.moveTo(i * R * 0.36, R * 0.12);
      c.quadraticCurveTo(i * R * 0.42, -R * 0.4, i * R * 0.2, -R * 0.85);
      c.stroke();
    }
    c.restore();

    this.gloss(c, -R * 0.34, -R * 0.42, R * 0.42);
  }

  private blueShell(c: CanvasRenderingContext2D, R: number): void {
    // Spikes.
    c.save();
    c.fillStyle = '#eaf4ff';
    for (let i = 0; i < 5; i++) {
      const a = Math.PI + (i / 4) * Math.PI;
      const x = Math.cos(a) * R * 0.82;
      const y = R * 0.08 + Math.sin(a) * R * 0.82;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + Math.cos(a - 0.28) * R * 0.36, y + Math.sin(a - 0.28) * R * 0.36);
      c.lineTo(x + Math.cos(a + 0.28) * R * 0.36, y + Math.sin(a + 0.28) * R * 0.36);
      c.closePath();
      c.fill();
      this.outline(c, 0.07);
    }
    c.restore();
    this.shell(c, R * 0.94, SHELL_BLUE);
    // Wings.
    c.fillStyle = 'rgba(240,250,255,0.95)';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(s * R * 0.7, -R * 0.1);
      c.quadraticCurveTo(s * R * 1.45, -R * 0.62, s * R * 1.2, R * 0.16);
      c.quadraticCurveTo(s * R * 1.0, R * 0.02, s * R * 0.7, R * 0.1);
      c.closePath();
      c.fill();
      this.outline(c, 0.07);
    }
  }

  private mushroom(c: CanvasRenderingContext2D, R: number): void {
    // Stem.
    c.beginPath();
    c.moveTo(-R * 0.44, R * 0.16);
    c.quadraticCurveTo(-R * 0.5, R * 0.9, -R * 0.2, R * 0.92);
    c.lineTo(R * 0.2, R * 0.92);
    c.quadraticCurveTo(R * 0.5, R * 0.9, R * 0.44, R * 0.16);
    c.closePath();
    const sg = c.createLinearGradient(-R * 0.4, 0, R * 0.4, 0);
    sg.addColorStop(0, '#fff8e2');
    sg.addColorStop(0.6, '#f6e6c2');
    sg.addColorStop(1, '#d8bf95');
    c.fillStyle = sg;
    c.fill();
    this.outline(c, 0.11);

    // Cap.
    c.beginPath();
    c.moveTo(-R, R * 0.2);
    c.bezierCurveTo(-R * 1.05, -R * 0.85, R * 1.05, -R * 0.85, R, R * 0.2);
    c.quadraticCurveTo(0, R * 0.46, -R, R * 0.2);
    c.closePath();
    const cg = c.createRadialGradient(-R * 0.3, -R * 0.5, R * 0.05, 0, 0, R * 1.3);
    cg.addColorStop(0, '#ff8f8f');
    cg.addColorStop(0.4, '#f5352c');
    cg.addColorStop(1, '#96060c');
    c.fillStyle = cg;
    c.fill();
    this.outline(c, 0.12);

    // Spots.
    c.fillStyle = '#fffdf4';
    const spots: [number, number, number][] = [
      [-R * 0.52, -R * 0.18, R * 0.22], [R * 0.5, -R * 0.14, R * 0.19],
      [0, -R * 0.5, R * 0.24], [-R * 0.05, R * 0.06, R * 0.13],
    ];
    for (const [x, y, r] of spots) {
      c.beginPath();
      c.ellipse(x, y, r, r * 0.92, 0, 0, Math.PI * 2);
      c.fill();
    }
    this.gloss(c, -R * 0.4, -R * 0.48, R * 0.34);
  }

  private banana(c: CanvasRenderingContext2D, R: number): void {
    c.save();
    c.rotate(-0.25);
    c.beginPath();
    c.moveTo(-R * 0.86, -R * 0.42);
    c.bezierCurveTo(-R * 0.3, R * 0.98, R * 0.72, R * 0.72, R * 0.9, -R * 0.1);
    c.bezierCurveTo(R * 0.5, R * 0.42, -R * 0.2, R * 0.4, -R * 0.52, -R * 0.5);
    c.closePath();
    const g = c.createLinearGradient(-R, -R * 0.4, R * 0.6, R * 0.7);
    g.addColorStop(0, '#fff6b8');
    g.addColorStop(0.45, '#ffd42a');
    g.addColorStop(1, '#c98c05');
    c.fillStyle = g;
    c.fill();
    this.outline(c, 0.12);
    // Tips.
    c.fillStyle = '#5e3d0d';
    c.beginPath();
    c.ellipse(-R * 0.84, -R * 0.44, R * 0.12, R * 0.09, -0.6, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.ellipse(R * 0.9, -R * 0.12, R * 0.11, R * 0.08, 0.5, 0, Math.PI * 2);
    c.fill();
    c.restore();
    this.gloss(c, -R * 0.3, -R * 0.18, R * 0.3);
  }

  private bomb(c: CanvasRenderingContext2D, R: number): void {
    // Body.
    c.beginPath();
    c.arc(0, R * 0.16, R * 0.8, 0, Math.PI * 2);
    const g = c.createRadialGradient(-R * 0.3, -R * 0.2, R * 0.05, 0, R * 0.16, R * 1.0);
    g.addColorStop(0, '#5c6c8c');
    g.addColorStop(0.4, '#222b40');
    g.addColorStop(1, '#070a14');
    c.fillStyle = g;
    c.fill();
    this.outline(c, 0.1);
    // Feet + wind-up key.
    c.fillStyle = '#f4c02a';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(s * R * 0.42, R * 0.9, R * 0.24, R * 0.12, 0, 0, Math.PI * 2);
      c.fill();
      this.outline(c, 0.06);
    }
    // Fuse.
    c.strokeStyle = '#d8dce6';
    c.lineWidth = this.size * 0.045;
    c.beginPath();
    c.moveTo(R * 0.18, -R * 0.6);
    c.quadraticCurveTo(R * 0.62, -R * 0.9, R * 0.5, -R * 1.02);
    c.stroke();
    // Spark.
    star(c, R * 0.52, -R * 1.05, R * 0.3, R * 0.11, 6);
    const sg = c.createRadialGradient(R * 0.52, -R * 1.05, 0, R * 0.52, -R * 1.05, R * 0.32);
    sg.addColorStop(0, '#fffbe0');
    sg.addColorStop(0.5, '#ffcf3a');
    sg.addColorStop(1, '#ff6a00');
    c.fillStyle = sg;
    c.fill();
    // Eyes.
    c.fillStyle = '#fdfdfd';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(s * R * 0.26, R * 0.04, R * 0.15, R * 0.19, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = '#0a0d18';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.arc(s * R * 0.27, R * 0.07, R * 0.08, 0, Math.PI * 2);
      c.fill();
    }
    this.gloss(c, -R * 0.34, -R * 0.28, R * 0.3);
  }

  private starItem(c: CanvasRenderingContext2D, R: number): void {
    // Glow.
    const glow = c.createRadialGradient(0, 0, R * 0.1, 0, 0, R * 1.25);
    glow.addColorStop(0, 'rgba(255,240,150,0.85)');
    glow.addColorStop(1, 'rgba(255,200,40,0)');
    c.fillStyle = glow;
    c.beginPath();
    c.arc(0, 0, R * 1.25, 0, Math.PI * 2);
    c.fill();

    star(c, 0, 0, R * 1.0, R * 0.42, 5);
    const g = c.createLinearGradient(0, -R, 0, R);
    g.addColorStop(0, '#fffde8');
    g.addColorStop(0.45, '#ffd82a');
    g.addColorStop(1, '#f08f00');
    c.fillStyle = g;
    c.fill();
    this.outline(c, 0.11);
    // Eyes.
    c.fillStyle = '#12162a';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(s * R * 0.22, -R * 0.02, R * 0.09, R * 0.16, 0, 0, Math.PI * 2);
      c.fill();
    }
  }

  private bolt(c: CanvasRenderingContext2D, R: number): void {
    c.beginPath();
    c.moveTo(R * 0.34, -R);
    c.lineTo(-R * 0.6, R * 0.12);
    c.lineTo(-R * 0.05, R * 0.16);
    c.lineTo(-R * 0.36, R);
    c.lineTo(R * 0.66, -R * 0.2);
    c.lineTo(R * 0.06, -R * 0.24);
    c.closePath();
    const g = c.createLinearGradient(-R * 0.5, -R, R * 0.5, R);
    g.addColorStop(0, '#fffbd0');
    g.addColorStop(0.5, '#ffd21f');
    g.addColorStop(1, '#ff8a00');
    c.fillStyle = g;
    c.shadowColor = 'rgba(255,210,60,0.9)';
    c.shadowBlur = this.size * 0.16;
    c.fill();
    c.shadowBlur = 0;
    this.outline(c, 0.11);
  }

  private ghost(c: CanvasRenderingContext2D, R: number): void {
    c.beginPath();
    c.arc(0, -R * 0.12, R * 0.82, Math.PI, 0);
    c.lineTo(R * 0.82, R * 0.5);
    for (let i = 0; i < 4; i++) {
      const x0 = R * 0.82 - (i * R * 1.64) / 4;
      const x1 = x0 - (R * 1.64) / 8;
      const x2 = x0 - (R * 1.64) / 4;
      c.quadraticCurveTo(x1, R * (i % 2 === 0 ? 0.95 : 0.68), x2, R * 0.5);
    }
    c.closePath();
    const g = c.createRadialGradient(-R * 0.24, -R * 0.36, R * 0.06, 0, 0, R * 1.15);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.6, '#e2ecff');
    g.addColorStop(1, '#a7bcd8');
    c.fillStyle = g;
    c.fill();
    this.outline(c, 0.1);
    // Face.
    c.fillStyle = '#0d1222';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(s * R * 0.26, -R * 0.22, R * 0.11, R * 0.15, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.beginPath();
    c.moveTo(-R * 0.3, R * 0.14);
    c.quadraticCurveTo(0, R * 0.5, R * 0.3, R * 0.14);
    c.quadraticCurveTo(0, R * 0.28, -R * 0.3, R * 0.14);
    c.closePath();
    c.fill();
  }

  private bullet(c: CanvasRenderingContext2D, R: number): void {
    c.save();
    c.rotate(-0.18);
    c.beginPath();
    c.moveTo(-R * 0.9, -R * 0.5);
    c.lineTo(R * 0.28, -R * 0.5);
    c.quadraticCurveTo(R * 0.95, -R * 0.5, R * 0.95, 0);
    c.quadraticCurveTo(R * 0.95, R * 0.5, R * 0.28, R * 0.5);
    c.lineTo(-R * 0.9, R * 0.5);
    c.closePath();
    const g = c.createLinearGradient(0, -R * 0.5, 0, R * 0.5);
    g.addColorStop(0, '#69789a');
    g.addColorStop(0.4, '#242c40');
    g.addColorStop(1, '#0a0e1a');
    c.fillStyle = g;
    c.fill();
    this.outline(c, 0.1);
    // Arms.
    c.fillStyle = '#182034';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(-R * 0.1, s * R * 0.62, R * 0.34, R * 0.15, 0, 0, Math.PI * 2);
      c.fill();
      this.outline(c, 0.06);
    }
    // Eyes.
    c.fillStyle = '#fff';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(R * 0.34, s * R * 0.16, R * 0.13, R * 0.14, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
    this.gloss(c, -R * 0.3, -R * 0.3, R * 0.36);
  }

  private coin(c: CanvasRenderingContext2D, R: number): void {
    c.beginPath();
    c.ellipse(0, 0, R * 0.72, R * 0.92, 0, 0, Math.PI * 2);
    const g = c.createRadialGradient(-R * 0.24, -R * 0.3, R * 0.05, 0, 0, R);
    g.addColorStop(0, '#fff8cd');
    g.addColorStop(0.42, '#ffd447');
    g.addColorStop(1, '#b06a04');
    c.fillStyle = g;
    c.fill();
    this.outline(c, 0.1);
    c.beginPath();
    c.ellipse(0, 0, R * 0.44, R * 0.64, 0, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(120,70,4,0.6)';
    c.lineWidth = this.size * 0.03;
    c.stroke();
    this.gloss(c, -R * 0.24, -R * 0.34, R * 0.3);
  }

  private squid(c: CanvasRenderingContext2D, R: number): void {
    c.beginPath();
    c.moveTo(-R * 0.7, R * 0.1);
    c.quadraticCurveTo(-R * 0.9, -R * 0.95, 0, -R * 0.95);
    c.quadraticCurveTo(R * 0.9, -R * 0.95, R * 0.7, R * 0.1);
    c.closePath();
    const g = c.createRadialGradient(-R * 0.2, -R * 0.5, R * 0.06, 0, -R * 0.2, R * 1.1);
    g.addColorStop(0, '#f2f8ff');
    g.addColorStop(0.55, '#bcd4ee');
    g.addColorStop(1, '#5b7ba6');
    c.fillStyle = g;
    c.fill();
    this.outline(c, 0.1);
    // Tentacles.
    c.strokeStyle = '#cfe0f4';
    c.lineWidth = this.size * 0.075;
    c.lineCap = 'round';
    for (let i = -2; i <= 2; i++) {
      c.beginPath();
      c.moveTo(i * R * 0.3, R * 0.05);
      c.quadraticCurveTo(i * R * 0.42, R * 0.62, i * R * 0.24, R * 0.95);
      c.stroke();
    }
    // Eyes.
    c.fillStyle = '#10182c';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(s * R * 0.26, -R * 0.3, R * 0.1, R * 0.14, 0, 0, Math.PI * 2);
      c.fill();
    }
  }
}

// ===========================================================================
// Character / kart / track art
// ===========================================================================

/**
 * Placeholder character portrait: a helmeted racer bust over a themed
 * background. Used until KartManager can render real portraits to a texture.
 */
export function characterPortrait(
  name: string, colorA: string, colorB: string, size = 220,
): HTMLCanvasElement {
  const canvas = makeCanvas(size, size);
  const c = ctx2d(canvas);
  if (!c) return canvas;
  const S = size;

  // Background: themed radial + speed stripes + vignette.
  const bg = c.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, colorA);
  bg.addColorStop(1, colorB);
  c.fillStyle = bg;
  c.fillRect(0, 0, S, S);

  c.save();
  c.globalAlpha = 0.16;
  c.strokeStyle = '#ffffff';
  c.lineWidth = S * 0.045;
  for (let i = -3; i < 10; i++) {
    c.beginPath();
    c.moveTo(i * S * 0.16, S);
    c.lineTo(i * S * 0.16 + S * 0.4, 0);
    c.stroke();
  }
  c.restore();

  const vign = c.createRadialGradient(S * 0.5, S * 0.42, S * 0.1, S * 0.5, S * 0.55, S * 0.78);
  vign.addColorStop(0, 'rgba(255,255,255,0.14)');
  vign.addColorStop(1, 'rgba(3,6,16,0.72)');
  c.fillStyle = vign;
  c.fillRect(0, 0, S, S);

  // Shoulders.
  c.beginPath();
  c.moveTo(S * 0.08, S * 1.02);
  c.quadraticCurveTo(S * 0.5, S * 0.62, S * 0.92, S * 1.02);
  c.closePath();
  const sg = c.createLinearGradient(0, S * 0.7, 0, S);
  sg.addColorStop(0, '#28324c');
  sg.addColorStop(1, '#0d1424');
  c.fillStyle = sg;
  c.fill();
  c.lineWidth = S * 0.022;
  c.strokeStyle = '#070b16';
  c.stroke();

  // Helmet.
  const hx = S * 0.5, hy = S * 0.47, hr = S * 0.29;
  c.beginPath();
  c.arc(hx, hy, hr, 0, Math.PI * 2);
  const hg = c.createRadialGradient(hx - hr * 0.4, hy - hr * 0.5, hr * 0.1, hx, hy, hr * 1.25);
  hg.addColorStop(0, '#ffffff');
  hg.addColorStop(0.3, colorA);
  hg.addColorStop(1, colorB);
  c.fillStyle = hg;
  c.fill();
  c.lineWidth = S * 0.026;
  c.strokeStyle = '#080c18';
  c.stroke();

  // Crest stripe.
  c.save();
  c.beginPath();
  c.arc(hx, hy, hr, 0, Math.PI * 2);
  c.clip();
  c.fillStyle = 'rgba(255,255,255,0.85)';
  c.fillRect(hx - hr * 0.11, hy - hr * 1.1, hr * 0.22, hr * 1.1);
  c.restore();

  // Visor.
  c.beginPath();
  c.ellipse(hx, hy + hr * 0.18, hr * 0.78, hr * 0.44, 0, Math.PI * 0.06, Math.PI * 0.94, true);
  c.closePath();
  const vg = c.createLinearGradient(hx, hy - hr * 0.2, hx, hy + hr * 0.6);
  vg.addColorStop(0, '#9fe8ff');
  vg.addColorStop(0.4, '#1d4c86');
  vg.addColorStop(1, '#06101f');
  c.fillStyle = vg;
  c.fill();
  c.lineWidth = S * 0.022;
  c.strokeStyle = '#070b16';
  c.stroke();

  // Visor specular.
  c.save();
  c.globalAlpha = 0.5;
  c.beginPath();
  c.ellipse(hx - hr * 0.3, hy + hr * 0.18, hr * 0.26, hr * 0.1, -0.5, 0, Math.PI * 2);
  c.fillStyle = '#ffffff';
  c.fill();
  c.restore();

  // Initial badge.
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  c.font = `900 ${Math.round(S * 0.15)}px ${FONT_STACK_CANVAS}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineWidth = S * 0.03;
  c.strokeStyle = '#070b16';
  c.strokeText(initial, S * 0.845, S * 0.16);
  c.fillStyle = '#ffffff';
  c.fillText(initial, S * 0.845, S * 0.16);

  return canvas;
}

/** Placeholder kart body thumbnail — 3/4 view silhouette. */
export function kartThumb(colorA: string, colorB: string, w = 240, h = 180): HTMLCanvasElement {
  const canvas = makeCanvas(w, h);
  const c = ctx2d(canvas);
  if (!c) return canvas;

  const bg = c.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, 'rgba(38,58,104,0.95)');
  bg.addColorStop(1, 'rgba(8,12,28,0.98)');
  c.fillStyle = bg;
  c.fillRect(0, 0, w, h);

  // Floor glow.
  const fg = c.createRadialGradient(w * 0.5, h * 0.84, w * 0.02, w * 0.5, h * 0.84, w * 0.46);
  fg.addColorStop(0, 'rgba(120,190,255,0.4)');
  fg.addColorStop(1, 'rgba(120,190,255,0)');
  c.fillStyle = fg;
  c.fillRect(0, h * 0.5, w, h * 0.5);

  const cx = w * 0.5;
  const by = h * 0.66;
  const bw = w * 0.34;

  // Rear wheels.
  c.fillStyle = '#12161f';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(cx + s * bw * 0.92, by + h * 0.09, w * 0.075, w * 0.075, 0, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = w * 0.014;
    c.strokeStyle = '#05070d';
    c.stroke();
    c.beginPath();
    c.arc(cx + s * bw * 0.92, by + h * 0.09, w * 0.032, 0, Math.PI * 2);
    c.fillStyle = '#c9d6e8';
    c.fill();
    c.fillStyle = '#12161f';
  }

  // Body.
  c.beginPath();
  c.moveTo(cx - bw, by + h * 0.12);
  c.quadraticCurveTo(cx - bw * 1.12, by - h * 0.08, cx - bw * 0.6, by - h * 0.14);
  c.quadraticCurveTo(cx, by - h * 0.3, cx + bw * 0.6, by - h * 0.14);
  c.quadraticCurveTo(cx + bw * 1.12, by - h * 0.08, cx + bw, by + h * 0.12);
  c.quadraticCurveTo(cx, by + h * 0.24, cx - bw, by + h * 0.12);
  c.closePath();
  const g = c.createLinearGradient(cx, by - h * 0.3, cx, by + h * 0.2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.22, colorA);
  g.addColorStop(1, colorB);
  c.fillStyle = g;
  c.fill();
  c.lineWidth = w * 0.016;
  c.strokeStyle = '#060a14';
  c.stroke();

  // Cockpit.
  c.beginPath();
  c.ellipse(cx, by - h * 0.08, bw * 0.42, h * 0.07, 0, 0, Math.PI * 2);
  c.fillStyle = 'rgba(8,14,28,0.85)';
  c.fill();
  c.strokeStyle = '#0a1020';
  c.lineWidth = w * 0.012;
  c.stroke();

  // Spoiler.
  c.fillStyle = '#e9f2ff';
  roundRect(c, cx - bw * 0.62, by - h * 0.3, bw * 1.24, h * 0.045, w * 0.012);
  c.fill();
  c.strokeStyle = '#060a14';
  c.lineWidth = w * 0.012;
  c.stroke();

  // Front wheels (smaller, in front).
  c.fillStyle = '#12161f';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(cx + s * bw * 0.66, by + h * 0.17, w * 0.058, w * 0.058, 0, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = w * 0.013;
    c.strokeStyle = '#05070d';
    c.stroke();
  }

  // Specular sweep.
  c.save();
  c.globalAlpha = 0.35;
  c.beginPath();
  c.moveTo(cx - bw * 0.8, by - h * 0.14);
  c.quadraticCurveTo(cx, by - h * 0.26, cx + bw * 0.8, by - h * 0.14);
  c.lineWidth = h * 0.03;
  c.strokeStyle = '#ffffff';
  c.stroke();
  c.restore();

  return canvas;
}

/** Track preview card: themed sky + the minimap loop as a ribbon. */
export function trackPreview(
  path: readonly { x: number; y: number }[],
  themeA: string, themeB: string, roadColor = '#e9f0ff',
  w = 320, h = 200,
): HTMLCanvasElement {
  const canvas = makeCanvas(w, h);
  const c = ctx2d(canvas);
  if (!c) return canvas;

  const sky = c.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, themeA);
  sky.addColorStop(0.62, themeB);
  sky.addColorStop(1, '#05070f');
  c.fillStyle = sky;
  c.fillRect(0, 0, w, h);

  // Sun / horizon bloom.
  const sun = c.createRadialGradient(w * 0.72, h * 0.26, 1, w * 0.72, h * 0.26, w * 0.42);
  sun.addColorStop(0, 'rgba(255,240,190,0.85)');
  sun.addColorStop(1, 'rgba(255,200,120,0)');
  c.fillStyle = sun;
  c.fillRect(0, 0, w, h);

  if (path.length > 2) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of path) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const pad = Math.min(w, h) * 0.16;
    const sx = (w - pad * 2) / Math.max(1e-3, maxX - minX);
    const sy = (h - pad * 2) / Math.max(1e-3, maxY - minY);
    const s = Math.min(sx, sy);
    const ox = (w - (maxX - minX) * s) * 0.5 - minX * s;
    const oy = (h - (maxY - minY) * s) * 0.5 - minY * s;

    c.beginPath();
    for (let i = 0; i < path.length; i++) {
      const x = path[i].x * s + ox;
      const y = path[i].y * s + oy;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(3,6,14,0.9)';
    c.lineWidth = Math.min(w, h) * 0.085;
    c.stroke();
    c.strokeStyle = roadColor;
    c.lineWidth = Math.min(w, h) * 0.052;
    c.stroke();
    c.setLineDash([Math.min(w, h) * 0.03, Math.min(w, h) * 0.04]);
    c.strokeStyle = 'rgba(20,30,52,0.55)';
    c.lineWidth = Math.min(w, h) * 0.009;
    c.stroke();
    c.setLineDash([]);

    // Start line.
    const p0 = path[0];
    const p1 = path[Math.min(2, path.length - 1)];
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) + Math.PI / 2;
    const lx = p0.x * s + ox;
    const ly = p0.y * s + oy;
    const half = Math.min(w, h) * 0.033;
    c.save();
    c.translate(lx, ly);
    c.rotate(ang);
    for (let i = -2; i < 2; i++) {
      c.fillStyle = i % 2 === 0 ? '#ffffff' : '#111726';
      c.fillRect(-half, i * half * 0.5, half * 2, half * 0.5);
    }
    c.restore();
  }

  // Bottom fade so the caption stays legible.
  const fade = c.createLinearGradient(0, h * 0.55, 0, h);
  fade.addColorStop(0, 'rgba(4,7,16,0)');
  fade.addColorStop(1, 'rgba(4,7,16,0.9)');
  c.fillStyle = fade;
  c.fillRect(0, h * 0.55, w, h * 0.45);

  return canvas;
}

/** Generate a distinct closed racing loop — used for preview cards. */
export function proceduralLoop(seed: number, points = 96): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const h1 = 0.16 + ((seed * 7919) % 13) / 100;
  const h2 = 0.1 + ((seed * 104729) % 11) / 110;
  const p1 = (seed % 7) * 0.9;
  const p2 = (seed % 5) * 1.3;
  const k1 = 2 + (seed % 3);
  const k2 = 3 + ((seed >> 1) % 3);
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const r = 1 + h1 * Math.sin(a * k1 + p1) + h2 * Math.cos(a * k2 + p2);
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.78 });
  }
  return out;
}

// ===========================================================================
// Confetti (CSS-driven; VFX takes over when it exposes a burst)
// ===========================================================================

const CONFETTI_COLORS = ['#ffd447', '#ff6a6a', '#57e389', '#4ec8ff', '#b46bff', '#ffffff'];

export function confetti(host: HTMLElement, count = 90): void {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    const dx = (Math.random() - 0.5) * 60;
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0];
    p.style.setProperty('--dx', `${dx}vw`);
    p.style.setProperty('--rot', `${(Math.random() * 1600 - 800).toFixed(0)}deg`);
    p.style.animationDuration = `${(1.9 + Math.random() * 2.1).toFixed(2)}s`;
    p.style.animationDelay = `${(Math.random() * 1.4).toFixed(2)}s`;
    p.style.opacity = `${0.7 + Math.random() * 0.3}`;
    p.style.transform = `scale(${(0.7 + Math.random() * 0.9).toFixed(2)})`;
    frag.appendChild(p);
  }
  host.replaceChildren(frag);
}

// ===========================================================================
// Misc
// ===========================================================================

/**
 * Reference-resolution UI scale so the whole interface moves as one piece.
 * 1.0 == the 1920x1080 design size. Must stay numerically identical to the CSS
 * fallback in `ui.css` (`clamp(0.34px, min(0.0926vh, 0.0651vw), 1.55px)`), which
 * is what applies before this ever runs.
 */
export function uiScale(width: number, height: number): number {
  const byH = height / 1080;
  const byW = (width / 1920) * 1.25;
  return clamp(Math.min(byH, byW), 0.34, 1.55);
}

let appliedScale = -1;

/**
 * Publish the UI scale on the document root, from the size of the box we
 * actually render into. `ui.css` derives its design unit (`--u`) from `--ak-u`,
 * so one write rescales the HUD, menus and results together — there is exactly
 * one scale factor for ~14 HUD elements and it lives here.
 *
 * `--ak-u` is written as a *length* so `ui.css` can express its no-JS default as
 * `var(--ak-u, clamp(...))`. Before this fix the stylesheet read
 * `calc(1px * var(--ak-scale, 1))`, so any frame in which nothing had called
 * `resize()` yet rendered the HUD at full 1080p size regardless of the viewport.
 * `--ak-scale` is still published, purely so the value is inspectable.
 */
export function applyUiScale(width: number, height: number): number {
  const s = uiScale(width, height);
  if (Math.abs(s - appliedScale) > 0.0005) {
    appliedScale = s;
    const root = document.documentElement.style;
    root.setProperty('--ak-u', `${s.toFixed(4)}px`);
    root.setProperty('--ak-scale', s.toFixed(4));
  }
  return s;
}

/** Kart colour palette used when the karts subsystem doesn't expose one. */
export const KART_COLORS: readonly string[] = [
  '#ff4d4d', '#4ec8ff', '#57e389', '#ffd447', '#b46bff', '#ff8a2b',
  '#45f0ff', '#ff6ec7', '#9bff5c', '#7f8cff', '#ffffff', '#8b98b5',
];

export function kartColor(id: number): string {
  return KART_COLORS[((id % KART_COLORS.length) + KART_COLORS.length) % KART_COLORS.length];
}

export { clamp, clamp01 };
