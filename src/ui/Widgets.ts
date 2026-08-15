/**
 * ============================================================================
 *  FOXY KART — UI WIDGET LIBRARY
 * ============================================================================
 *  Shared, allocation-conscious building blocks for the HUD, the menus and the
 *  results screen:
 *
 *   - tiny DOM helpers (`el`, `svgEl`, `restartAnim`, `punch`)
 *   - `Spring`: critically-tunable numeric spring for smoothed readouts
 *   - `ItemIcons`: the HUD's item artwork. It samples the items subsystem's baked
 *     atlas, and for an item with no cell calls `paintItemIcon()` — the SAME
 *     painter the atlas was baked from. This file no longer owns any item art of
 *     its own; see the note on `paint()`.
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
// `paintItemIcon` is the item ARTWORK, imported for the same reason: this file
// used to hold a second, older copy of every item drawing (see `ItemIcons.paint`).
import { ITEM_NAMES, TRIPLE_ITEMS, paintItemIcon } from '@/items/ItemModels';
// Portrait data, derived there from `DRIVERS` — this module draws, it never
// authors a palette or a hat shape of its own. The chassis silhouettes are there
// for the same reason and one more: `Catalogue` is DOM-free, so a probe can
// import the six shapes and measure that they are actually six shapes.
import { KART_SILHOUETTES } from './Catalogue';
import type { BustSpec } from './Catalogue';
import type { KartBodyId } from '@/karts/KartBodies';

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

/**
 * The HUD's item artwork.
 *
 * It samples the atlas `ItemModels` bakes, and for an item with no cell in that
 * atlas it calls `paintItemIcon()` — the same painter the atlas was baked from.
 * This class owns no artwork of its own; see `paint()`.
 */
export class ItemIcons {
  private cache = new Map<string, string>();
  private atlasUrl: string | null = null;
  private atlasSize = { w: 0, h: 0 };
  private uv: ((item: ItemType) => { x: number; y: number; w: number; h: number } | null) | null = null;
  private size: number;
  /** True once `useAtlas` has been called with a real items module. */
  private wired = false;

  constructor(size = 128) {
    this.size = size;
  }

  /**
   * Adopt the items subsystem's atlas if it exposes one. Supports a raw canvas,
   * an ImageBitmap-ish object, or a THREE.Texture wrapper, and UV rectangles
   * given as {x,y,w,h}, {u0,v0,u1,v1} or a Vector4.
   *
   * ⚠️ `items === undefined` IS NOT A FAILURE and must not be logged as one.
   * `HUD.build()` calls `useAtlas(this.items ?? undefined)` while `HUD.items` is
   * still null — it has to, because the HUD constructor never receives the items
   * module and `Game.ts` only wires it twenty lines after `await hud.init()`. That
   * pre-wire call is the one every boot used to report, and it is the reason the
   * console has been shouting `[ItemIcons] no item icon atlas (no items subsystem
   * was handed to the HUD)` on a build where the atlas is adopted correctly a
   * moment later. It is a state, not a fault; the fault is only real if no atlas
   * has arrived by the time an icon is actually drawn, which is what `apply()`
   * now checks.
   */
  useAtlas(items: ItemsLike | undefined): void {
    // Not wired yet — silent, and deliberately does NOT clear an atlas we already
    // hold, so a late `setItems(undefined)` cannot blank the slot.
    if (!items) return;
    this.wired = true;
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
   * Say so, once per distinct cause, when the atlas cannot be adopted.
   *
   * ⚠️ THE LATCH USED TO BE THE BUG. This was one `static` boolean shared by
   * every instance and every reason, set by the FIRST call in the process — which
   * is always `HUD.build()`'s pre-wire call, twenty lines before `Game.ts` hands
   * the items module over. So the console reliably printed a reason that had
   * already stopped being true, and a genuine later failure — `getIconAtlas()`
   * returning nothing, a canvas that cannot be read — could never be printed at
   * all. Proven in `.probe-tmp/iconwire.ts`: an `ItemIcons` with truly no atlas,
   * silently drawing fallbacks, emitted ZERO warnings because a harmless earlier
   * call had spent the flag. A broken alarm is worse than a loud one.
   *
   * Keyed by reason and per-instance now, so each distinct cause is reported once
   * and none can mask another.
   */
  private warnNoAtlas(why: string): void {
    if (this.warned.has(why)) return;
    this.warned.add(why);
    console.warn(
      `[ItemIcons] no item icon atlas (${why}) — drawing icons one at a time `
      + 'instead. Same artwork (ItemModels.paintItemIcon), but the HUD is '
      + 'rasterising per item instead of sampling the baked sheet.',
    );
  }

  /**
   * The real failure, reported at the moment it becomes one: an icon is wanted,
   * and no items module ever arrived. Distinct from `warnNoAtlas` — that means
   * "the module is here and its atlas is unusable", this means "nobody wired it",
   * i.e. `Game.ts` is missing `wire(this.hud, 'setItems', this.items)`.
   */
  private warnNeverWired(): void {
    if (this.warned.has('unwired')) return;
    this.warned.add('unwired');
    console.warn(
      '[ItemIcons] the HUD is drawing item icons but was never handed the items '
      + 'subsystem, so there is no atlas to sample. Game.ts needs '
      + 'wire(this.hud, \'setItems\', this.items) — see HUD.setItems().',
    );
  }

  /** Per-instance, per-reason. Never static: see `warnNoAtlas`. */
  private warned = new Set<string>();

  /**
   * Point a DOM node's background at the icon for `item`.
   *
   * Two live paths, ONE artwork. An item with a cell is sampled out of the baked
   * sheet with a `background-position`; an item without one (everything outside
   * `ICON_ITEMS` — the forced-grant bob-omb, shells and bullet) is rasterised on
   * demand by `paint()`. Both end at `paintItemIcon`, so the two can differ in
   * sharpness but never in *what they depict*, which is the failure the owner
   * originally reported ("the battery icon shows the bottle item").
   */
  apply(node: HTMLElement, item: ItemType | null): void {
    if (item === null) {
      node.style.backgroundImage = 'none';
      return;
    }
    // An icon is genuinely wanted and nobody ever wired the items module: this is
    // the moment the silent fallback becomes a real defect, so say so here rather
    // than during boot when it is still just an ordering artefact.
    if (!this.wired) this.warnNeverWired();
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

  /**
   * Rasterise one icon at `this.size`, using the items module's own painter.
   *
   * ⚠️ THIS FILE NO LONGER DRAWS ITEMS, AND MUST NOT AGAIN. It used to carry a
   * complete parallel set — `shell`, `blueShell`, `mushroom`, `banana`, `bomb`,
   * `starItem`, `bolt`, `ghost`, `bullet`, `coin`, `squid`: some 370 lines, all of
   * it the art from BEFORE the P0d-D5 re-skin. So the "fallback" drew a BANANA for
   * the Plastic Bottle, a MUSHROOM for the Battery, a GHOST for the Ninja and a
   * RED SHELL for the Rocket, and kept a coin and a squid for items that no longer
   * exist at all. That is not a degraded copy of an icon, it is a different
   * object; and because it only surfaced when the atlas was missing, whichever of
   * the two paths you audited, the other one was wrong. It is exactly the
   * parallel-list defect this file's own header warns about for `ITEM_NAMES` and
   * `LIVE_ITEMS`, and it is why the owner's "the battery icon shows the bottle
   * item" survived a round of fixes.
   *
   * `paintItemIcon()` is now the only item artwork in the project outside the 3-D
   * models, and the atlas is baked from it too.
   */
  private paint(item: ItemType): HTMLCanvasElement {
    const S = this.size;
    const canvas = makeCanvas(S, S);
    const c = ctx2d(canvas);
    if (!c) return canvas;
    c.save();
    c.translate(S * 0.5, S * 0.5);
    paintItemIcon(c, ItemIcons.base(item), S);
    c.restore();
    return canvas;
  }
}

// ===========================================================================
// Character / kart / track art
// ===========================================================================

/**
 * Placeholder character portrait: a helmeted racer bust over a themed
 * background. Used until KartManager can render real portraits to a texture.
 */
// ===========================================================================
// Character bust — canvas 2-D, one silhouette per racer
// ===========================================================================
//
//  WHY THIS EXISTS, AND WHY IT IS NOT A GENERIC HELMET
//  The racer-select cards want `KartManager.renderPortrait()`: a real offscreen
//  render of the real 3-D rig. This is what runs when that cannot. It has been
//  needed twice already, for two different reasons:
//
//    1. The 3-D path did not exist at all for most of the build, and the
//       fallback then was `characterPortrait()` below — one grey visor ellipse
//       with the racer's initial in the corner, identical for all ten. The
//       visual critic failed it on exactly that.
//    2. When the 3-D path did arrive it shipped broken (a degenerate
//       environment probe killed every fragment shader in the portrait scene,
//       see the header of `@/karts/Portrait`) and produced ten *blank* cards.
//
//  So the requirement is not "something to show" — it is "ten recognisably
//  different characters, from the same data the rig is built from". Every colour
//  and every shape below is driven by `BustSpec`, which `./Catalogue` derives
//  from `DRIVERS`. The load-bearing field is `head`: `Driver.ts` states outright
//  that at small size the headwear shape *is* the character, and all ten racers
//  have a different `HeadKind`, so switching on it is what makes ten cards read
//  as ten racers. A racer added with a new `HeadKind` is a compile error here,
//  not a silently generic head.
// ===========================================================================

function bustRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Multiply toward black (`k` < 1) or toward white (`k` > 1, clamped). */
function bustShade(hex: string, k: number): string {
  const [r, g, b] = bustRgb(hex);
  return `rgb(${Math.round(clamp(r * k, 0, 255))},${Math.round(clamp(g * k, 0, 255))},`
    + `${Math.round(clamp(b * k, 0, 255))})`;
}

function bustMix(a: string, b: string, t: number): string {
  const A = bustRgb(a);
  const B = bustRgb(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},`
    + `${Math.round(A[2] + (B[2] - A[2]) * t)})`;
}

function bustFade(hex: string, a: number): string {
  const [r, g, b] = bustRgb(hex);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function ell(
  c: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0,
): void {
  c.beginPath();
  c.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, Math.PI * 2);
}

/**
 * The card behind the bust. Deliberately the same visual language as
 * `paintCard()` in `@/karts/Portrait` — base wash in the racer's paint,
 * radiating bars struck from behind the head, halo in their emissive accent,
 * vignette, stipple — so the 3-D portrait and this one look like one system and
 * a card that fell back is not obviously the odd one out.
 */
function bustCard(
  c: CanvasRenderingContext2D, S: number,
  colorA: string, colorB: string, glow: string, hx: number, hy: number,
): void {
  const wash = c.createLinearGradient(0, 0, S * 0.35, S);
  wash.addColorStop(0, bustMix(colorA, '#ffffff', 0.30));
  wash.addColorStop(0.52, colorA);
  wash.addColorStop(0.86, bustMix(colorB, '#101725', 0.45));
  wash.addColorStop(1, '#0d1220');
  c.fillStyle = wash;
  c.fillRect(0, 0, S, S);

  c.save();
  c.translate(hx, hy);
  for (let i = 0; i < 11; i++) {
    const th = (i / 11) * Math.PI * 2 + 0.35;
    const w = 0.055 + (i % 3) * 0.028;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(Math.cos(th - w) * S * 1.7, Math.sin(th - w) * S * 1.7);
    c.lineTo(Math.cos(th + w) * S * 1.7, Math.sin(th + w) * S * 1.7);
    c.closePath();
    c.fillStyle = `rgba(255,255,255,${i % 2 === 0 ? 0.040 : 0.020})`;
    c.fill();
  }
  c.restore();

  const halo = c.createRadialGradient(hx, hy, S * 0.04, hx, hy, S * 0.46);
  halo.addColorStop(0, bustFade(glow, 0.42));
  halo.addColorStop(0.45, bustFade(glow, 0.14));
  halo.addColorStop(1, bustFade(glow, 0));
  c.fillStyle = halo;
  c.fillRect(0, 0, S, S);

  const vig = c.createRadialGradient(S * 0.5, S * 0.42, S * 0.18, S * 0.5, S * 0.5, S * 0.80);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(4,7,14,0.60)');
  c.fillStyle = vig;
  c.fillRect(0, 0, S, S);
}

/**
 * Does this bitmap contain a subject, or only a smooth background?
 *
 * The point of this function is the defect it was written for: `renderPortrait`
 * returned a perfectly valid 220×220 canvas containing nothing but the card
 * gradient, and every caller read "a canvas came back" as "it worked". Ten cards
 * shipped with no character on them.
 *
 * The discriminator is local contrast, not colour or coverage. The blank card is
 * a smooth wash plus 1-px stipple; downsampling to 32×32 averages the stipple
 * away and leaves adjacent-sample deltas of a handful of levels. Any real
 * subject has a silhouette edge against that wash — a hat brim, a muzzle, an eye
 * — worth tens of levels. Anything unreadable (no 2-D context, a tainted
 * canvas) reports *not* blank, so a measurement failure can never throw away a
 * portrait that was actually fine.
 */
export function probablyBlank(src: HTMLCanvasElement, minStep = 30): boolean {
  const N = 32;
  try {
    const small = makeCanvas(N, N);
    const g = ctx2d(small);
    if (!g || src.width < 2 || src.height < 2) return false;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, src.width, src.height, 0, 0, N, N);
    const d = g.getImageData(0, 0, N, N).data;
    const lum = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      // Weight by alpha: a transparent readback must not read as "dark ink".
      const a = d[o + 3] / 255;
      lum[i] = (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) * a;
    }
    let worst = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        if (x + 1 < N) worst = Math.max(worst, Math.abs(lum[i] - lum[i + 1]));
        if (y + 1 < N) worst = Math.max(worst, Math.abs(lum[i] - lum[i + N]));
      }
    }
    return worst < minStep;
  } catch {
    return false;
  }
}

/** A thin curved highlight along the top-left of a circle — the rim light. */
function bustRim(
  c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number,
): void {
  c.save();
  c.beginPath();
  c.arc(x, y, r * 0.97, Math.PI * 0.72, Math.PI * 1.62);
  c.strokeStyle = bustFade(color, a);
  c.lineWidth = r * 0.13;
  c.lineCap = 'round';
  c.stroke();
  c.restore();
}

/**
 * A head-and-shoulders bust for one racer, drawn entirely in canvas 2-D.
 *
 * Framed like the 3-D studio: three-quarter view facing the viewer's right, the
 * head owning the upper two thirds and the shoulder line cropped by a fade at
 * the bottom rather than a hard cut.
 */
export function characterBust(
  spec: BustSpec, colorA: string, colorB: string, glow: string, size = 220,
): HTMLCanvasElement {
  const canvas = makeCanvas(size, size);
  const c = ctx2d(canvas);
  if (!c) return canvas;
  const S = size;

  // --- layout ------------------------------------------------------------
  const r = S * 0.200 * clamp(spec.headScale, 0.86, 1.18);
  const hx = S * 0.480;
  const hy = S * 0.420;
  const shoulderY = S * 0.740;
  const halfW = S * (0.295 + 0.115 * clamp01(spec.bulk));
  const animal = spec.species !== null;
  const fox = spec.species === 'fox';

  const pelt = animal ? spec.fur : spec.skin;
  const peltLo = animal ? spec.furDark : bustShade(spec.skin, 0.70);
  const peltHi = animal ? spec.furAlt : bustMix(spec.skin, '#fff3e2', 0.42);
  /** Feature offset for the three-quarter turn — everything on the face shifts. */
  const fx = r * 0.13;

  bustCard(c, S, colorA, colorB, glow, hx, hy);

  /**
   * Every solid mass of the bust is filled with a canvas drop shadow on. This is
   * the cheap general answer to "the hat is the same colour as the card": Capy's
   * bucket hat IS her card's rust, and no palette juggling fixes that, but a
   * shadow separates any shape from any background. It doubles as the depth
   * between a hat, a skull and a shoulder line.
   */
  const massOn = (): void => {
    c.shadowColor = 'rgba(3,6,13,0.62)';
    c.shadowBlur = r * 0.34;
    c.shadowOffsetY = r * 0.10;
  };
  const massOff = (): void => {
    c.shadowColor = 'transparent';
    c.shadowBlur = 0;
    c.shadowOffsetY = 0;
  };
  massOn();

  // --- neck (behind the collar, dark at the top so the chin casts) -------
  const neckW = r * (0.42 + 0.16 * clamp01(spec.bulk));
  const ng = c.createLinearGradient(0, hy + r * 0.5, 0, shoulderY + S * 0.02);
  ng.addColorStop(0, bustShade(peltLo, 0.62));
  ng.addColorStop(1, peltLo);
  c.fillStyle = ng;
  roundRect(c, hx - neckW + fx * 0.5, hy + r * 0.42, neckW * 2, shoulderY - hy - r * 0.30, r * 0.22);
  c.fill();

  // --- shoulders ---------------------------------------------------------
  c.beginPath();
  c.moveTo(hx - halfW, S * 1.04);
  c.bezierCurveTo(
    hx - halfW, shoulderY + S * 0.03,
    hx - r * 0.78, shoulderY - S * 0.035,
    hx - r * 0.30, shoulderY - S * 0.055,
  );
  c.lineTo(hx + r * 0.30, shoulderY - S * 0.055);
  c.bezierCurveTo(
    hx + r * 0.78, shoulderY - S * 0.035,
    hx + halfW, shoulderY + S * 0.03,
    hx + halfW, S * 1.04,
  );
  c.closePath();
  const sg = c.createLinearGradient(hx - halfW, shoulderY - S * 0.05, hx + halfW * 0.6, S);
  sg.addColorStop(0, bustShade(spec.suit, 0.52));
  sg.addColorStop(0.40, spec.suit);
  sg.addColorStop(1, bustShade(spec.suit, 0.46));
  c.fillStyle = sg;
  c.fill();
  // Shoulder trim: knitwear gets ribbing, everyone else a piped seam.
  c.save();
  c.clip();
  c.strokeStyle = bustFade(spec.suitAlt, animal ? 0.30 : 0.55);
  c.lineWidth = S * 0.012;
  for (let i = 0; i < (animal ? 3 : 1); i++) {
    const y = shoulderY + S * (0.035 + i * 0.055);
    c.beginPath();
    c.moveTo(hx - halfW, y + S * 0.02);
    c.quadraticCurveTo(hx, y - S * 0.03, hx + halfW, y + S * 0.02);
    c.stroke();
  }
  c.restore();

  // --- collar / roll-neck / scarf ---------------------------------------
  const collarY = shoulderY - S * 0.052;
  ell(c, hx + fx * 0.4, collarY, halfW * 0.62, S * (animal ? 0.062 : 0.046));
  c.fillStyle = bustMix(spec.suitAlt, spec.suit, animal ? 0.25 : 0.55);
  c.fill();
  ell(c, hx + fx * 0.4, collarY + S * 0.012, halfW * 0.46, S * 0.034);
  c.fillStyle = bustShade(spec.suit, 0.66);
  c.fill();
  if (spec.scarf) {
    // A trailing end over the near shoulder — the pilot's and the speedster's tell.
    c.save();
    c.strokeStyle = spec.suitAlt;
    c.lineWidth = S * 0.070;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(hx - halfW * 0.44, collarY + S * 0.03);
    c.quadraticCurveTo(hx - halfW * 0.86, S * 0.90, hx - halfW * 0.62, S * 1.02);
    c.stroke();
    c.strokeStyle = bustFade('#000000', 0.18);
    c.lineWidth = S * 0.020;
    c.stroke();
    c.restore();
  }
  if (fox) {
    // Cream chest tuft rising out of the roll-neck.
    c.beginPath();
    c.moveTo(hx - r * 0.40, collarY + S * 0.02);
    c.quadraticCurveTo(hx, collarY - S * 0.05, hx + r * 0.40, collarY + S * 0.02);
    c.quadraticCurveTo(hx, collarY + S * 0.055, hx - r * 0.40, collarY + S * 0.02);
    c.closePath();
    c.fillStyle = peltHi;
    c.fill();
  }

  // --- ears, behind the skull so headwear sits over their bases ---------
  if (fox) {
    // Big triangular dark-tipped ears. They are set WIDE and tall on purpose:
    // the beret sits over their bases, and the first pass had it swallow them
    // whole — which threw away half of what makes a fox read as a fox.
    for (const s of [-1, 1] as const) {
      const ex = hx + fx + s * r * 0.78;
      const ey = hy - r * 0.66;
      c.beginPath();
      c.moveTo(ex - r * 0.34 * s, ey + r * 0.40);
      c.lineTo(ex + r * 0.16 * s, ey - r * 0.86);
      c.lineTo(ex + r * 0.42 * s, ey + r * 0.28);
      c.closePath();
      c.fillStyle = s > 0 ? pelt : bustShade(pelt, 0.80);
      c.fill();
      c.beginPath();
      c.moveTo(ex - r * 0.04 * s, ey - r * 0.24);
      c.lineTo(ex + r * 0.16 * s, ey - r * 0.80);
      c.lineTo(ex + r * 0.28 * s, ey - r * 0.18);
      c.closePath();
      c.fillStyle = spec.furDark;
      c.fill();
    }
  } else if (animal) {
    // Capybara: small, high-set, almost nothing. The anti-fox.
    for (const s of [-1, 1] as const) {
      ell(c, hx + fx + s * r * 0.82, hy - r * 0.60, r * 0.21, r * 0.20);
      c.fillStyle = s > 0 ? pelt : bustShade(pelt, 0.84);
      c.fill();
      ell(c, hx + fx + s * r * 0.84, hy - r * 0.58, r * 0.10, r * 0.09);
      c.fillStyle = spec.furDark;
      c.fill();
    }
  }

  // --- skull -------------------------------------------------------------
  const skullRx = fox ? r * 0.92 : animal ? r * 1.12 : r * 0.94;
  const skullRy = fox ? r * 1.00 : animal ? r * 0.90 : r * 1.04;
  const headGrad = c.createRadialGradient(
    hx - r * 0.34, hy - r * 0.44, r * 0.10, hx + fx, hy, r * 1.30,
  );
  headGrad.addColorStop(0, bustMix(pelt, '#ffffff', 0.28));
  headGrad.addColorStop(0.58, pelt);
  headGrad.addColorStop(1, bustShade(pelt, 0.60));
  if (spec.head === 'bubble') {
    // Elongated cranium: taller, and it tapers to a narrow jaw.
    c.beginPath();
    c.moveTo(hx + fx, hy - r * 1.24);
    c.bezierCurveTo(hx + fx + r * 1.10, hy - r * 1.10, hx + fx + r * 0.74, hy + r * 0.62,
      hx + fx, hy + r * 0.98);
    c.bezierCurveTo(hx + fx - r * 0.74, hy + r * 0.62, hx + fx - r * 1.10, hy - r * 1.10,
      hx + fx, hy - r * 1.24);
    c.closePath();
  } else if (spec.head === 'robot') {
    roundRect(c, hx + fx - r * 0.92, hy - r * 1.00, r * 1.84, r * 1.94, r * 0.62);
  } else {
    ell(c, hx + fx, hy, skullRx, skullRy);
  }
  c.fillStyle = headGrad;
  c.fill();

  // --- muzzle / snout ---------------------------------------------------
  // `spec.muzzle` is the rig's length along the driver's own -Z. At a 34° three
  // quarter view that projects to well under half of it, and taking the raw
  // value put a cream wedge across the whole of Foxy's face.
  let snoutX = hx + fx;
  let snoutY = hy + r * 0.30;
  if (spec.muzzle > 0) {
    const mz = r * spec.muzzle * 0.56;
    const my = hy + r * (fox ? 0.36 : 0.46);
    if (fox) {
      // A tapered snout: a tilted ellipse for the mass, a soft point for the tip.
      // It was a straight-edged wedge struck from the middle of the face, which
      // drew a hard cream diagonal across Foxy's cheek instead of a nose.
      ell(c, hx + fx + mz * 0.34, my, mz * 0.92, r * 0.32, -0.16);
      c.fillStyle = peltHi;
      c.fill();
      c.beginPath();
      c.moveTo(hx + fx + mz * 0.20, my - r * 0.26);
      c.quadraticCurveTo(hx + fx + mz * 1.10, my - r * 0.16, hx + fx + mz * 1.12, my + r * 0.06);
      c.quadraticCurveTo(hx + fx + mz * 0.72, my + r * 0.28, hx + fx + mz * 0.20, my + r * 0.24);
      c.closePath();
    } else {
      ell(c, hx + fx + mz * 0.50, my, mz * 0.82, r * 0.37, -0.06);
    }
    c.fillStyle = peltHi;
    c.fill();
    // Nose, and the shadow under it — that shadow is what makes a snout read.
    snoutX = hx + fx + mz * (fox ? 1.02 : 1.14);
    snoutY = my + (fox ? -r * 0.02 : -r * 0.06);
    ell(c, snoutX, snoutY, r * (fox ? 0.15 : 0.18), r * (fox ? 0.11 : 0.13), -0.2);
    c.fillStyle = spec.furDark;
    c.fill();
    c.beginPath();
    c.moveTo(snoutX - r * 0.24, snoutY + r * 0.24);
    c.quadraticCurveTo(snoutX - r * 0.02, snoutY + r * 0.38, snoutX + r * 0.14, snoutY + r * 0.24);
    c.strokeStyle = bustFade(spec.furDark, 0.7);
    c.lineWidth = r * 0.055;
    c.lineCap = 'round';
    c.stroke();
  }

  massOff();
  bustRim(c, hx + fx, hy, Math.max(skullRx, skullRy), '#ffe9c8', 0.32);

  // --- eyes + brows -----------------------------------------------------
  const covered = spec.head === 'fullHelmet' || spec.head === 'greatHelm'
    || spec.head === 'robot' || spec.head === 'flightCap';
  if (!covered) {
    const eyeR = r * 0.155 * clamp(spec.eyeSize, 0.7, 1.5);
    const eyeY = hy - r * 0.18;
    const alien = spec.head === 'bubble';
    for (const s of [-1, 1] as const) {
      const ex = hx + fx + s * r * 0.40;
      if (alien) {
        // Big black almonds, tilted outward.
        c.save();
        c.translate(ex, eyeY);
        c.rotate(s * 0.42);
        ell(c, 0, 0, eyeR * 1.35, eyeR * 0.80);
        c.fillStyle = spec.eye;
        c.fill();
        c.restore();
      } else {
        ell(c, ex, eyeY, eyeR * 0.92, eyeR);
        c.fillStyle = '#f7f3ea';
        c.fill();
        ell(c, ex + eyeR * 0.16, eyeY + eyeR * 0.06, eyeR * 0.60, eyeR * 0.74);
        c.fillStyle = spec.eye;
        c.fill();
      }
      ell(c, ex + eyeR * (alien ? 0.5 : 0.42), eyeY - eyeR * 0.42, eyeR * 0.24, eyeR * 0.20);
      c.fillStyle = 'rgba(255,255,255,0.92)';
      c.fill();
      // Brow.
      c.beginPath();
      c.moveTo(ex - eyeR * 1.15, eyeY - eyeR * 1.30);
      c.quadraticCurveTo(ex, eyeY - eyeR * 1.95, ex + eyeR * 1.15, eyeY - eyeR * 1.20);
      c.strokeStyle = spec.brow;
      c.lineWidth = r * 0.085;
      c.lineCap = 'round';
      c.stroke();
    }
    if (spec.mark === 'whiskers') {
      // Anchored to the snout the muzzle actually ended at, not to a guess —
      // they floated in mid air the moment the snout was foreshortened.
      c.strokeStyle = 'rgba(255,255,255,0.42)';
      c.lineWidth = r * 0.035;
      c.lineCap = 'round';
      for (let i = -1; i <= 1; i++) {
        c.beginPath();
        c.moveTo(snoutX - r * 0.12, snoutY + r * 0.10 + i * r * 0.09);
        c.lineTo(snoutX + r * 0.44, snoutY + r * 0.02 + i * r * 0.24);
        c.stroke();
      }
    } else if (spec.mark === 'moustache') {
      c.beginPath();
      c.moveTo(hx + fx - r * 0.34, hy + r * 0.40);
      c.quadraticCurveTo(hx + fx, hy + r * 0.58, hx + fx + r * 0.34, hy + r * 0.40);
      c.strokeStyle = spec.brow;
      c.lineWidth = r * 0.13;
      c.lineCap = 'round';
      c.stroke();
    } else if (spec.mark === 'freckles') {
      c.fillStyle = bustFade(spec.brow, 0.42);
      for (let i = 0; i < 6; i++) {
        const s = i < 3 ? -1 : 1;
        ell(c, hx + fx + s * r * (0.52 + (i % 3) * 0.10), hy + r * (0.16 + (i % 3) * 0.08),
          r * 0.035, r * 0.035);
        c.fill();
      }
    }
    if (!animal) {
      // Mouth: a short confident curve. Animals already have one on the snout.
      c.beginPath();
      c.moveTo(hx + fx - r * 0.22, hy + r * 0.46);
      c.quadraticCurveTo(hx + fx, hy + r * 0.62, hx + fx + r * 0.24, hy + r * 0.44);
      c.strokeStyle = bustShade(spec.skin, 0.52);
      c.lineWidth = r * 0.06;
      c.lineCap = 'round';
      c.stroke();
    }
  }

  massOn();
  drawHeadwear(c, spec, hx + fx, hy, r, glow);
  massOff();

  // --- crop fade, so the chest is a fade and not a cut ------------------
  const fadeG = c.createLinearGradient(0, S * 0.84, 0, S);
  fadeG.addColorStop(0, 'rgba(10,14,26,0)');
  fadeG.addColorStop(1, 'rgba(7,10,19,0.94)');
  c.fillStyle = fadeG;
  c.fillRect(0, S * 0.84, S, S * 0.16);

  // Stipple last: a clean gradient is the loudest "made in a browser" tell.
  const n = Math.round(S * S * 0.045);
  for (let i = 0; i < n; i++) {
    c.fillStyle = `rgba(255,255,255,${(0.010 + Math.random() * 0.026).toFixed(3)})`;
    c.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  return canvas;
}

/**
 * The headwear, switched on the driver's real `HeadKind`. This is the function
 * that makes ten cards look like ten racers, so every arm draws a shape nobody
 * else has. The switch is exhaustive over `HeadKind` by construction — a new hat
 * in `Driver.ts` fails to compile here rather than falling through to nothing.
 */
function drawHeadwear(
  c: CanvasRenderingContext2D, spec: BustSpec,
  hx: number, hy: number, r: number, glow: string,
): void {
  // The shell is the DRIVER's colour, never the kart paint. `Driver.ts` picks
  // `suit` explicitly so "the driver reads as a separate mass against their own
  // machine", and the card wash is that machine's paint — the first pass of this
  // function used the paint and five of ten helmets vanished into their own
  // background. `clothAlt` headwear (beret, bucket hat, flight cap) takes
  // `suitAlt`, exactly as the rig does.
  const shell = spec.head === 'beret' || spec.head === 'bucketHat' || spec.head === 'flightCap'
    ? spec.suitAlt : spec.suit;
  const lit = bustMix(shell, '#ffffff', 0.34);
  const dim = bustShade(shell, 0.58);
  const grad = (x0: number, y0: number, x1: number, y1: number): CanvasGradient => {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, lit);
    g.addColorStop(0.55, shell);
    g.addColorStop(1, dim);
    return g;
  };
  const visor = (rx: number, ry: number, y: number, tint: string): void => {
    ell(c, hx, y, rx, ry, 0);
    const g = c.createLinearGradient(hx, y - ry, hx, y + ry);
    g.addColorStop(0, bustMix(tint, '#ffffff', 0.55));
    g.addColorStop(0.42, tint);
    g.addColorStop(1, bustShade(tint, 0.32));
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = 'rgba(6,10,18,0.85)';
    c.lineWidth = r * 0.075;
    c.stroke();
    // Specular streak.
    c.save();
    c.globalAlpha = 0.5;
    ell(c, hx - rx * 0.34, y - ry * 0.24, rx * 0.34, ry * 0.20, -0.42);
    c.fillStyle = '#ffffff';
    c.fill();
    c.restore();
  };

  switch (spec.head) {
    case 'cap': {
      // Backwards baseball cap: crown over the skull, brim pointing away.
      c.beginPath();
      c.arc(hx, hy - r * 0.16, r * 0.99, Math.PI * 1.02, Math.PI * 1.98);
      c.closePath();
      c.fillStyle = grad(hx - r, hy - r, hx + r * 0.6, hy);
      c.fill();
      // Brim, pointing away from the lens because the cap is on backwards.
      c.beginPath();
      c.moveTo(hx - r * 0.94, hy - r * 0.40);
      c.quadraticCurveTo(hx - r * 1.78, hy - r * 0.42, hx - r * 1.74, hy - r * 0.02);
      c.quadraticCurveTo(hx - r * 1.36, hy + r * 0.12, hx - r * 0.90, hy + r * 0.02);
      c.closePath();
      c.fillStyle = dim;
      c.fill();
      // Goggles pushed up on the forehead.
      c.strokeStyle = 'rgba(20,24,32,0.9)';
      c.lineWidth = r * 0.12;
      c.beginPath();
      c.arc(hx, hy - r * 0.10, r * 0.92, Math.PI * 1.14, Math.PI * 1.86);
      c.stroke();
      ell(c, hx + r * 0.30, hy - r * 0.68, r * 0.26, r * 0.19);
      c.fillStyle = bustFade('#bfe6ff', 0.75);
      c.fill();
      break;
    }
    case 'fullHelmet': {
      // Full-face shell + chin bar + tinted visor + winglets.
      ell(c, hx, hy - r * 0.06, r * 1.10, r * 1.14);
      c.fillStyle = grad(hx - r, hy - r, hx + r * 0.7, hy + r);
      c.fill();
      c.fillStyle = dim;
      roundRect(c, hx - r * 0.86, hy + r * 0.44, r * 1.72, r * 0.52, r * 0.24);
      c.fill();
      visor(r * 0.86, r * 0.40, hy - r * 0.06, '#12406f');
      for (const s of [-1, 1] as const) {
        c.beginPath();
        c.moveTo(hx + s * r * 1.02, hy - r * 0.10);
        c.lineTo(hx + s * r * 1.42, hy + r * 0.10);
        c.lineTo(hx + s * r * 1.00, hy + r * 0.26);
        c.closePath();
        c.fillStyle = spec.suitAlt;
        c.fill();
      }
      break;
    }
    case 'robot': {
      // Chromed dome cap, single optic band, antenna.
      c.beginPath();
      c.moveTo(hx - r * 0.92, hy - r * 0.42);
      c.quadraticCurveTo(hx, hy - r * 1.46, hx + r * 0.92, hy - r * 0.42);
      c.closePath();
      const cg = c.createLinearGradient(hx - r, hy - r * 1.3, hx + r, hy - r * 0.3);
      cg.addColorStop(0, '#eef3f8');
      cg.addColorStop(0.45, '#9fadbb');
      cg.addColorStop(0.62, '#e6edf4');
      cg.addColorStop(1, '#5d6a78');
      c.fillStyle = cg;
      c.fill();
      const band = glow;
      roundRect(c, hx - r * 0.78, hy - r * 0.30, r * 1.56, r * 0.42, r * 0.20);
      c.fillStyle = '#10141b';
      c.fill();
      roundRect(c, hx - r * 0.60, hy - r * 0.22, r * 1.20, r * 0.24, r * 0.12);
      const og = c.createLinearGradient(hx - r * 0.6, 0, hx + r * 0.6, 0);
      og.addColorStop(0, bustFade(band, 0.55));
      og.addColorStop(0.5, band);
      og.addColorStop(1, bustFade(band, 0.55));
      c.fillStyle = og;
      c.fill();
      c.strokeStyle = '#c9d4de';
      c.lineWidth = r * 0.07;
      c.beginPath();
      c.moveTo(hx + r * 0.28, hy - r * 1.14);
      c.lineTo(hx + r * 0.44, hy - r * 1.62);
      c.stroke();
      ell(c, hx + r * 0.46, hy - r * 1.70, r * 0.13, r * 0.13);
      c.fillStyle = band;
      c.fill();
      break;
    }
    case 'trucker': {
      // Tiny crown, very wide flat brim — the welder's cap on a huge frame.
      // Sat 0.26r higher than the first pass, which cut Torque's eyes in half.
      c.beginPath();
      c.arc(hx, hy - r * 0.60, r * 0.78, Math.PI, Math.PI * 2);
      c.closePath();
      c.fillStyle = grad(hx - r * 0.8, hy - r * 1.3, hx + r * 0.5, hy - r * 0.5);
      c.fill();
      c.fillStyle = dim;
      ell(c, hx, hy - r * 0.56, r * 1.42, r * 0.19);
      c.fill();
      c.fillStyle = bustFade('#000000', 0.28);
      ell(c, hx, hy - r * 0.50, r * 1.36, r * 0.13);
      c.fill();
      c.strokeStyle = bustFade(spec.suitAlt, 0.8);
      c.lineWidth = r * 0.09;
      c.beginPath();
      c.moveTo(hx - r * 0.74, hy - r * 0.66);
      c.quadraticCurveTo(hx, hy - r * 0.82, hx + r * 0.74, hy - r * 0.66);
      c.stroke();
      break;
    }
    case 'aero': {
      // Oversized teardrop shell with the tail sweeping back.
      c.beginPath();
      c.moveTo(hx - r * 1.06, hy - r * 0.02);
      c.bezierCurveTo(hx - r * 1.04, hy - r * 1.36, hx + r * 1.04, hy - r * 1.36,
        hx + r * 1.08, hy - r * 0.04);
      c.lineTo(hx + r * 1.02, hy + r * 0.10);
      c.bezierCurveTo(hx + r * 0.6, hy - r * 0.16, hx - r * 0.6, hy - r * 0.16,
        hx - r * 1.02, hy + r * 0.10);
      c.closePath();
      c.fillStyle = grad(hx - r, hy - r * 1.2, hx + r * 0.8, hy);
      c.fill();
      c.beginPath();
      c.moveTo(hx - r * 0.96, hy - r * 0.40);
      c.quadraticCurveTo(hx - r * 1.74, hy - r * 0.20, hx - r * 1.40, hy + r * 0.24);
      c.quadraticCurveTo(hx - r * 1.10, hy + r * 0.06, hx - r * 0.94, hy - r * 0.14);
      c.closePath();
      c.fillStyle = dim;
      c.fill();
      c.strokeStyle = bustFade(spec.suitAlt, 0.9);
      c.lineWidth = r * 0.10;
      c.beginPath();
      c.moveTo(hx - r * 0.10, hy - r * 1.24);
      c.quadraticCurveTo(hx + r * 0.06, hy - r * 0.70, hx + r * 0.02, hy - r * 0.14);
      c.stroke();
      break;
    }
    case 'bubble': {
      // Glass dome over the elongated cranium, with a collar ring at its base.
      ell(c, hx, hy - r * 0.16, r * 1.22, r * 1.32);
      const gg = c.createRadialGradient(
        hx - r * 0.5, hy - r * 0.9, r * 0.1, hx, hy - r * 0.2, r * 1.5,
      );
      gg.addColorStop(0, 'rgba(255,255,255,0.42)');
      gg.addColorStop(0.45, bustFade(glow, 0.10));
      gg.addColorStop(1, 'rgba(150,220,255,0.05)');
      c.fillStyle = gg;
      c.fill();
      c.strokeStyle = bustFade(glow, 0.55);
      c.lineWidth = r * 0.055;
      c.stroke();
      c.save();
      c.globalAlpha = 0.45;
      c.beginPath();
      c.arc(hx, hy - r * 0.16, r * 1.10, Math.PI * 1.06, Math.PI * 1.44);
      c.strokeStyle = '#ffffff';
      c.lineWidth = r * 0.10;
      c.lineCap = 'round';
      c.stroke();
      c.restore();
      ell(c, hx, hy + r * 1.02, r * 0.92, r * 0.20);
      c.fillStyle = spec.suitAlt;
      c.fill();
      break;
    }
    case 'greatHelm': {
      // Flat-topped great-helm, tall crest, T-slit.
      c.beginPath();
      c.moveTo(hx - r * 1.02, hy - r * 0.72);
      c.lineTo(hx + r * 1.02, hy - r * 0.72);
      c.lineTo(hx + r * 0.94, hy + r * 0.86);
      c.quadraticCurveTo(hx, hy + r * 1.16, hx - r * 0.94, hy + r * 0.86);
      c.closePath();
      c.fillStyle = grad(hx - r, hy - r * 0.8, hx + r * 0.8, hy + r);
      c.fill();
      c.fillStyle = spec.suitAlt;
      c.beginPath();
      c.moveTo(hx - r * 0.16, hy - r * 0.76);
      c.quadraticCurveTo(hx, hy - r * 1.52, hx + r * 0.16, hy - r * 0.76);
      c.closePath();
      c.fill();
      c.fillStyle = '#0b0f18';
      c.fillRect(hx - r * 0.92, hy - r * 0.24, r * 1.84, r * 0.24);
      c.fillRect(hx - r * 0.14, hy - r * 0.24, r * 0.28, r * 0.92);
      c.strokeStyle = bustFade(spec.suitAlt, 0.85);
      c.lineWidth = r * 0.07;
      c.beginPath();
      c.moveTo(hx - r * 1.00, hy - r * 0.66);
      c.lineTo(hx + r * 1.00, hy - r * 0.66);
      c.stroke();
      break;
    }
    case 'flightCap': {
      // Leather cap, earflaps, goggles worn over the eyes.
      c.beginPath();
      c.arc(hx, hy - r * 0.06, r * 1.06, Math.PI * 0.96, Math.PI * 2.04);
      c.closePath();
      c.fillStyle = grad(hx - r, hy - r, hx + r * 0.7, hy);
      c.fill();
      for (const s of [-1, 1] as const) {
        ell(c, hx + s * r * 0.98, hy + r * 0.24, r * 0.26, r * 0.40);
        c.fillStyle = s > 0 ? shell : dim;
        c.fill();
      }
      c.strokeStyle = 'rgba(26,20,14,0.92)';
      c.lineWidth = r * 0.16;
      c.beginPath();
      c.moveTo(hx - r * 1.04, hy - r * 0.14);
      c.quadraticCurveTo(hx, hy - r * 0.02, hx + r * 1.04, hy - r * 0.14);
      c.stroke();
      for (const s of [-1, 1] as const) {
        ell(c, hx + s * r * 0.46, hy - r * 0.14, r * 0.34, r * 0.30);
        c.fillStyle = bustFade('#cfeaff', 0.82);
        c.fill();
        c.strokeStyle = '#8b7a5e';
        c.lineWidth = r * 0.09;
        c.stroke();
      }
      break;
    }
    case 'beret': {
      // Tilted felted beret + gripped band + stalk, then the spectacles.
      c.save();
      // High enough that the band clears the spectacles — the beret is tilted,
      // and a tilted disc at eye height sat on top of Foxy's own glasses.
      c.translate(hx - r * 0.08, hy - r * 0.94);
      c.rotate(-0.30);
      ell(c, 0, 0, r * 1.10, r * 0.52);
      c.fillStyle = grad(-r, -r * 0.5, r * 0.7, r * 0.5);
      c.fill();
      ell(c, 0, r * 0.26, r * 0.94, r * 0.28);
      c.fillStyle = bustShade(shell, 0.72);
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.20)';
      c.lineWidth = r * 0.06;
      c.beginPath();
      c.moveTo(-r * 0.86, 0);
      c.quadraticCurveTo(0, -r * 0.24, r * 0.86, 0);
      c.stroke();
      c.strokeStyle = lit;
      c.lineWidth = r * 0.16;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(-r * 0.06, -r * 0.42);
      c.quadraticCurveTo(r * 0.06, -r * 0.72, -r * 0.02, -r * 0.82);
      c.stroke();
      c.restore();
      // Round dark-rimmed spectacles: two rims, a bridge, a temple.
      c.strokeStyle = '#2b1d15';
      c.lineWidth = r * 0.075;
      for (const s of [-1, 1] as const) {
        const ex = hx + s * r * 0.40;
        ell(c, ex, hy - r * 0.18, r * 0.34, r * 0.34);
        c.fillStyle = 'rgba(210,236,255,0.20)';
        c.fill();
        c.stroke();
      }
      c.beginPath();
      c.moveTo(hx - r * 0.08, hy - r * 0.22);
      c.lineTo(hx + r * 0.08, hy - r * 0.22);
      c.stroke();
      c.lineWidth = r * 0.055;
      c.beginPath();
      c.moveTo(hx - r * 0.74, hy - r * 0.20);
      c.quadraticCurveTo(hx - r * 0.96, hy - r * 0.16, hx - r * 1.02, hy - r * 0.02);
      c.stroke();
      break;
    }
    case 'bucketHat': {
      // Crown, grosgrain band, floppy brim all the way round. `by` is the brim
      // plane, and it is deliberately HIGH: the first pass drooped the brim to
      // eye level and hid Capy's whole face. A hat perched above the brows is
      // worth more than an anatomically perfect one you cannot see under.
      const by = hy - r * 0.88;
      c.beginPath();
      c.moveTo(hx - r * 0.84, by + r * 0.08);
      c.quadraticCurveTo(hx - r * 0.78, by - r * 0.72, hx, by - r * 0.74);
      c.quadraticCurveTo(hx + r * 0.80, by - r * 0.72, hx + r * 0.86, by + r * 0.08);
      c.closePath();
      c.fillStyle = grad(hx - r, by - r * 0.7, hx + r * 0.8, by);
      c.fill();
      c.beginPath();
      c.moveTo(hx - r * 1.44, by - r * 0.04);
      c.quadraticCurveTo(hx, by - r * 0.40, hx + r * 1.46, by - r * 0.04);
      c.quadraticCurveTo(hx + r * 1.16, by + r * 0.28, hx, by + r * 0.34);
      c.quadraticCurveTo(hx - r * 1.14, by + r * 0.28, hx - r * 1.44, by - r * 0.04);
      c.closePath();
      c.fillStyle = grad(hx - r * 1.4, by - r * 0.4, hx + r * 1.1, by + r * 0.3);
      c.fill();
      // The brim's underside, which is what makes it read as floppy and not flat.
      c.fillStyle = bustFade('#000000', 0.34);
      c.beginPath();
      c.moveTo(hx - r * 1.38, by + r * 0.02);
      c.quadraticCurveTo(hx, by - r * 0.18, hx + r * 1.40, by + r * 0.02);
      c.quadraticCurveTo(hx + r * 1.14, by + r * 0.30, hx, by + r * 0.36);
      c.quadraticCurveTo(hx - r * 1.12, by + r * 0.30, hx - r * 1.38, by + r * 0.02);
      c.closePath();
      c.fill();
      c.strokeStyle = bustShade(shell, 0.52);
      c.lineWidth = r * 0.14;
      c.beginPath();
      c.moveTo(hx - r * 0.84, by);
      c.quadraticCurveTo(hx, by - r * 0.20, hx + r * 0.86, by);
      c.stroke();
      break;
    }
  }
}

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

/**
 * Chassis thumbnail for the kart-select grid.
 *
 * This used to be one shape for all six bodies — an oval with a dark cockpit
 * ellipse in it — so the grid was six coloured doughnuts and the only thing
 * telling Sport Bike from Heavy Cruiser was the caption. The shape now comes
 * from `KART_SILHOUETTES[bodyId]` in `./Catalogue`: a hull polygon, a parts list
 * and a wheel list, authored per real `KartBodyId`. This function owns the
 * lighting, the tyres and the staging; it authors no shape of its own, which is
 * what lets `.probe-tmp/kartshape.ts` measure the silhouettes directly.
 */
export function kartThumb(
  bodyId: KartBodyId, colorA: string, colorB: string, w = 240, h = 180,
): HTMLCanvasElement {
  const canvas = makeCanvas(w, h);
  const c = ctx2d(canvas);
  if (!c) return canvas;

  const spec = KART_SILHOUETTES[bodyId];
  const X = (u: number): number => u * w;
  const Y = (v: number): number => v * h;
  const trace = (poly: readonly (readonly [number, number])[]): void => {
    c.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      if (i === 0) c.moveTo(X(p[0]), Y(p[1])); else c.lineTo(X(p[0]), Y(p[1]));
    }
    c.closePath();
  };

  // --- studio backdrop ----------------------------------------------------
  const bg = c.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, 'rgba(38,58,104,0.95)');
  bg.addColorStop(0.62, 'rgba(17,26,54,0.97)');
  bg.addColorStop(1, 'rgba(8,12,28,0.98)');
  c.fillStyle = bg;
  c.fillRect(0, 0, w, h);

  const gy = Y(spec.ground);
  const fg = c.createRadialGradient(w * 0.5, gy, w * 0.02, w * 0.5, gy, w * 0.5);
  fg.addColorStop(0, 'rgba(120,190,255,0.42)');
  fg.addColorStop(1, 'rgba(120,190,255,0)');
  c.fillStyle = fg;
  c.fillRect(0, Y(0.42), w, h - Y(0.42));

  // --- contact shadow -----------------------------------------------------
  // Anti-grav floats, so its shadow is detached and soft; everything else has
  // tyres on the floor and a tight one.
  c.save();
  const shadowY = spec.antigrav ? gy + h * 0.045 : gy;
  const sh = c.createRadialGradient(w * 0.5, shadowY, 1, w * 0.5, shadowY, w * 0.42);
  sh.addColorStop(0, spec.antigrav ? 'rgba(90,200,255,0.42)' : 'rgba(0,0,0,0.62)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = sh;
  c.beginPath();
  c.ellipse(w * 0.5, shadowY, w * 0.42, h * (spec.antigrav ? 0.055 : 0.035), 0, 0, Math.PI * 2);
  c.fill();
  c.restore();

  // --- far-side wheels, dimmed so the near pair reads in front ------------
  const paintWheel = (cx: number, cy: number, r: number, knobbly: boolean, far: boolean): void => {
    c.save();
    if (far) c.globalAlpha = 0.45;
    if (knobbly) {
      // Tread blocks around the rim — an off-road tyre must not be a smooth disc.
      c.fillStyle = '#0d1119';
      const blocks = 12;
      for (let i = 0; i < blocks; i++) {
        const a = (i / blocks) * Math.PI * 2;
        c.beginPath();
        c.ellipse(cx + Math.cos(a) * r * 0.94, cy + Math.sin(a) * r * 0.94, r * 0.26, r * 0.20, a, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    const tyre = c.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r);
    tyre.addColorStop(0, '#2b333f');
    tyre.addColorStop(1, '#0b0e15');
    c.fillStyle = tyre;
    c.fill();
    c.lineWidth = Math.max(1, w * 0.010);
    c.strokeStyle = '#05070d';
    c.stroke();
    // Hub.
    c.beginPath();
    c.arc(cx, cy, r * 0.40, 0, Math.PI * 2);
    const hub = c.createLinearGradient(cx, cy - r * 0.4, cx, cy + r * 0.4);
    hub.addColorStop(0, '#e8f1ff');
    hub.addColorStop(1, '#8ba2bd');
    c.fillStyle = hub;
    c.fill();
    c.restore();
  };

  for (const wl of spec.wheels) {
    if (wl.far) paintWheel(X(wl.cx), Y(wl.cy), X(wl.r), wl.knobbly, true);
  }

  // --- hull ---------------------------------------------------------------
  trace(spec.hull);
  const body = c.createLinearGradient(0, Y(0.18), 0, Y(0.80));
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.24, colorA);
  body.addColorStop(1, colorB);
  c.fillStyle = body;
  c.fill();
  c.lineWidth = Math.max(1.2, w * 0.013);
  c.strokeStyle = '#060a14';
  c.stroke();

  // --- parts --------------------------------------------------------------
  for (const part of spec.parts) {
    trace(part.poly);
    switch (part.fill) {
      case 'body': c.fillStyle = colorA; break;
      case 'shade': c.fillStyle = colorB; break;
      case 'dark': c.fillStyle = 'rgba(9,14,26,0.88)'; break;
      case 'glass': {
        const g = c.createLinearGradient(0, Y(0.22), 0, Y(0.55));
        g.addColorStop(0, 'rgba(190,230,255,0.85)');
        g.addColorStop(1, 'rgba(30,60,110,0.75)');
        c.fillStyle = g;
        break;
      }
      case 'chrome': {
        const g = c.createLinearGradient(0, Y(0.18), 0, Y(0.62));
        g.addColorStop(0, '#f4f9ff');
        g.addColorStop(0.5, '#b9c9dd');
        g.addColorStop(1, '#6d7f96');
        c.fillStyle = g;
        break;
      }
      case 'glow': c.fillStyle = 'rgba(120,225,255,0.95)'; break;
    }
    c.fill();
    c.lineWidth = Math.max(1, w * 0.008);
    c.strokeStyle = 'rgba(6,10,20,0.9)';
    c.stroke();
    if (part.fill === 'glow') {
      c.save();
      c.globalAlpha = 0.55;
      c.shadowColor = '#7ae1ff';
      c.shadowBlur = w * 0.06;
      c.fill();
      c.restore();
    }
  }

  // --- near wheels --------------------------------------------------------
  for (const wl of spec.wheels) {
    if (!wl.far) paintWheel(X(wl.cx), Y(wl.cy), X(wl.r), wl.knobbly, false);
  }

  // --- specular sweep along the hull top ----------------------------------
  c.save();
  c.globalAlpha = 0.3;
  c.beginPath();
  let started = false;
  for (const p of spec.hull) {
    if (p[1] > 0.58) continue;
    if (!started) { c.moveTo(X(p[0]), Y(p[1]) + h * 0.012); started = true; }
    else c.lineTo(X(p[0]), Y(p[1]) + h * 0.012);
  }
  if (started) {
    c.lineWidth = h * 0.022;
    c.lineCap = 'round';
    c.strokeStyle = '#ffffff';
    c.stroke();
  }
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
    // THE LOOP IS FITTED TO A SAFE BOX, NOT TO THE WHOLE CARD.
    // The course name used to be set over this art, and the spline ran straight
    // through the words BOSTON and TAIPEI. The name has since moved to its own
    // band under the card, but two things still sit on the art — the tag chip
    // top-left and the difficulty pips top-right — so the top strip is reserved
    // and the ribbon is centred in what is left. `pad` was a flat 16 % of the
    // short side, which on a 16:10 card put the loop's top edge right under the
    // chip.
    const topReserve = h * 0.24;
    const pad = Math.min(w, h) * 0.13;
    const boxX = pad;
    const boxY = topReserve;
    const boxW = w - pad * 2;
    const boxH = h - topReserve - pad;
    const sx = boxW / Math.max(1e-3, maxX - minX);
    const sy = boxH / Math.max(1e-3, maxY - minY);
    const s = Math.min(sx, sy);
    const ox = boxX + (boxW - (maxX - minX) * s) * 0.5 - minX * s;
    const oy = boxY + (boxH - (maxY - minY) * s) * 0.5 - minY * s;

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

  // Top scrim only. The bottom fade existed to keep an overlaid course name
  // legible; the name is a band under the card now, so darkening the bottom of
  // the art just hides the half of the circuit drawn there. What is still on the
  // art is the tag chip and the difficulty pips, both along the top.
  const scrim = c.createLinearGradient(0, 0, 0, h * 0.34);
  scrim.addColorStop(0, 'rgba(4,7,16,0.62)');
  scrim.addColorStop(1, 'rgba(4,7,16,0)');
  c.fillStyle = scrim;
  c.fillRect(0, 0, w, h * 0.34);

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
