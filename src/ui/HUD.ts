/**
 * ============================================================================
 *  FOXY KART — HEADS-UP DISPLAY
 * ============================================================================
 *  DOM + CSS above the WebGL canvas (crisp text at any resolution, trivially
 *  animatable, no font atlas). Canvas-2D only where it belongs: the minimap and
 *  the radial speedometer.
 *
 *  PERFORMANCE CONTRACT
 *   - every value is cached; the DOM is touched only when something changed
 *   - only `transform`, `opacity` and `filter` animate — never layout
 *   - one-shot punches go through the Web Animations API so they composite
 *     off the main thread and self-clean
 *   - two small canvases redraw per frame (map + gauge), both with cached
 *     static layers
 *   - `hud.costMs` reports the measured cost; budget is 0.4 ms/frame
 *
 *  RESILIENCE
 *  Every sibling subsystem is optional. Missing race director, missing track
 *  path, missing item atlas, missing camera — the HUD degrades and keeps
 *  running. It must never throw into the frame loop.
 * ============================================================================
 */

import * as THREE from 'three';
import { bus } from '@/core/EventBus';
import { RACE } from '@/core/Config';
import { DriftStage, ItemType } from '@/core/Types';
import type { FrameContext, ISubsystem, KartState } from '@/core/Types';
import { clamp, clamp01, damp, smoothstep } from '@/core/MathUtils';
import {
  formatDelta, formatGap, formatOrdinal, formatTime, numeral, ordinalSuffix,
  setNumeralText, setNumeralTone,
} from './Fonts';
import { Minimap } from './Minimap';
import {
  ItemIcons, applyUiScale, el, kartColor, probe, punch,
  restartAnim, setClass, setText, svgEl, tryCall,
} from './Widgets';
import type {
  AudioLike, EngineLike, ItemsLike, KartsLike, RaceLike, TrackLike,
} from './Widgets';

/** Boost duration that reads as a full meter. */
const BOOST_FULL_SECONDS = 1.8;
const MAX_PLATES = 12;
/** How many opponent nameplates may be on screen at once. */
const MAX_VISIBLE_PLATES = 5;
/** Centreline samples used to build the minimap ribbon. */
const MINIMAP_SAMPLES = 220;
/**
 * Keep in step with `.ak-map`'s width in ui.css — this sizes the canvas backing
 * store, that sizes the element, and if they disagree the ribbon is rasterised
 * at one scale and displayed at another. `.probe-tmp/hudscale.ts` asserts the
 * two numbers are equal by reading both files.
 */
const MINIMAP_DESIGN_PX = 216;

type ThreatKind = 'red' | 'blue' | 'none';

interface Roulette {
  active: boolean;
  /** Seconds since the spin began. */
  t: number;
  /** Seconds until the next icon swap. */
  next: number;
  index: number;
  /** Locked-in result, once the item system has decided. */
  target: ItemType | null;
  /** Time at which we must stop, seconds since spin start. */
  stopAt: number;
}

const tmpV = new THREE.Vector3();

/** Module-level so the nameplate sort allocates no closure per frame. */
function byDistance(a: { d: number }, b: { d: number }): number { return a.d - b.d; }

// ===========================================================================
// Minimap feed
//
// Split out of `HUD` so the world→marker chain can be driven — and asserted
// on — headlessly, without standing up the whole DOM. `.probe-tmp/minimap-
// arcwalk.ts` walks every circuit through exactly these functions and the
// real `Minimap`.
// ===========================================================================

export interface CoursePath {
  /** Closed loop, `y` carrying world Z. */
  pts: { x: number; y: number }[];
  space: 'world' | 'unit';
}

/**
 * Which circuit is loaded, as a string that changes whenever the geometry
 * does.
 *
 * This exists because `Track.loadTrack()` swaps the spline **in place on the
 * same `Track` instance**. Nothing downstream can notice a course change by
 * object identity, and `RaceDirector.beginRace()` does not await the load, so
 * the new circuit can arrive several frames after `race:start`. Polling a
 * signature is the only reliable way to see it.
 *
 * Empty when the track cannot identify itself at all; callers fall back to the
 * geometry in that case.
 */
export function trackSignature(track: unknown): string {
  const parts: string[] = [];
  const id = probe<string>(track, 'trackId');
  if (typeof id === 'string' && id) parts.push(id);
  const len = probe<number>(track, 'lapLength');
  if (typeof len === 'number' && Number.isFinite(len) && len > 1) parts.push(len.toFixed(3));
  return parts.join('#');
}

/** Order-sensitive digest of a loop, for tracks that report no identity. */
function courseKey(pts: readonly { x: number; y: number }[]): string {
  let a = 0;
  let b = 0;
  for (let i = 0; i < pts.length; i++) {
    a = (a + pts[i].x * (i + 1)) % 1e9;
    b = (b + pts[i].y * (i + 3)) % 1e9;
  }
  return `~${pts.length}:${a.toFixed(2)}:${b.toFixed(2)}`;
}

/** Largest bounding-box dimension of a 2-D loop. Distinguishes metres from 0..1. */
export function courseSpread(pts: readonly { x: number; y: number }[]): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

/**
 * The minimap ribbon for whatever circuit `track` currently holds, or `null`
 * if it cannot supply one yet.
 *
 * The ribbon must live in the same coordinate space as `kart.position`, or the
 * racer dots plot thousands of pixels off-canvas — which is exactly why the
 * map once showed no dots at all. `Track.getMinimapPath()` returns a
 * bounding-box *normalised* 0..1 loop, so prefer the world-space centreline
 * sampler and treat the normalised path as a fallback that only draws the
 * ribbon.
 */
export function sampleCourse(track: unknown, samples = MINIMAP_SAMPLES): CoursePath | null {
  const sample = probe<(d: number) => { position: THREE.Vector3 }>(track, 'sampleAtDistance');
  const lapLength = probe<number>(track, 'lapLength') ?? 0;
  if (typeof sample === 'function' && lapLength > 1) {
    const pts: { x: number; y: number }[] = [];
    try {
      for (let i = 0; i < samples; i++) {
        const s = sample.call(track, (i / samples) * lapLength);
        const q = s?.position;
        if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.z)) { pts.length = 0; break; }
        pts.push({ x: q.x, y: q.z });
      }
    } catch { pts.length = 0; }
    // A track that isn't built yet samples to a degenerate point; reject it.
    if (pts.length > 2 && courseSpread(pts) > 1) return { pts, space: 'world' };
  }

  const path = tryCall<readonly { x: number; y: number }[]>(track, 'getMinimapPath');
  if (path && path.length > 2) {
    // Auto-detect the space so a track that later returns world metres just
    // works. Normalised paths can draw the ribbon but not place karts.
    const space = courseSpread(path) > 4 ? 'world' : 'unit';
    return { pts: path.map((p) => ({ x: p.x, y: p.y })), space };
  }
  return null;
}

export class HUD implements ISubsystem {
  // --- injected ------------------------------------------------------------
  private container: HTMLElement;
  private karts: KartsLike;
  private race: RaceLike;
  private track: TrackLike;
  private engine: EngineLike;
  private audio: AudioLike | null = null;
  private items: ItemsLike | null = null;

  // --- roots ---------------------------------------------------------------
  private root!: HTMLDivElement;
  private built = false;
  /** What the last `setVisible()` asked for. */
  private wantVisible = true;
  /** True while a menu screen covers the frame. */
  private menuActive = false;
  /** False while the race phase is one the HUD has no business appearing in. */
  private phaseAllows = false;
  /** What is actually on screen right now. */
  private visible = false;

  // lap
  private lapPlate!: HTMLDivElement;
  private lapCur!: HTMLElement;
  private lapTot!: HTMLElement;

  // (No coin plate. Coins are removed from the game — see `setCoins` below.)

  // drift
  private driftBox!: HTMLDivElement;
  private driftSegs: HTMLDivElement[] = [];
  private driftFills: HTMLElement[] = [];

  // item
  private itemBox!: HTMLDivElement;
  private itemIconEls: HTMLDivElement[] = [];
  private itemCount!: HTMLDivElement;
  private icons = new ItemIcons(128);
  private roulette: Roulette = { active: false, t: 0, next: 0, index: 0, target: null, stopAt: 0.75 };

  // timer
  private timeTotal!: HTMLElement;
  private timeLap!: HTMLElement;
  private timeBest!: HTMLElement;
  private timeDelta!: HTMLDivElement;
  private deltaHideAt = -1;

  // minimap + rivals
  private minimap = new Minimap();
  /**
   * Identity of the circuit the ribbon was built for; `''` until there is one.
   * This used to be a plain `pathReady` boolean, which latched on the FIRST
   * course the HUD ever saw and never let go — see `refreshTrackPath`.
   */
  private pathKey = '';
  private pathRetryAt = 0;
  private warnedUnitPath = false;
  private rivalsBox!: HTMLDivElement;
  private rivalEls: { row: HTMLDivElement; pos: HTMLDivElement; name: HTMLDivElement; gap: HTMLDivElement; swatch: HTMLDivElement }[] = [];

  // position
  private posBox!: HTMLDivElement;
  private posPlate!: HTMLDivElement;
  private posReel!: HTMLDivElement;
  private posCells: { cell: HTMLDivElement; digits: HTMLElement; suffix: HTMLElement }[] = [];
  private posActive = 0;
  private posFlash!: HTMLDivElement;
  private posToast!: HTMLDivElement;

  // speed
  private speedBox!: HTMLDivElement;
  private speedNum!: HTMLElement;
  private boostBar!: HTMLElement;
  private boostFill = 0;
  private lastBoostStr = '';

  // centre stack
  private countdownBox!: HTMLDivElement;
  private countdownNum!: HTMLElement;
  private lights: HTMLElement[] = [];
  private banner!: HTMLDivElement;
  private bannerBg!: HTMLDivElement;
  private bannerText!: HTMLElement;
  private message!: HTMLDivElement;
  private messageHideAt = -1;
  private countdownHideAt = -1;

  // warnings
  private warnBox!: HTMLDivElement;
  private warnArrow!: HTMLDivElement;
  private warnBlue!: HTMLDivElement;
  private hitFlash!: HTMLDivElement;
  private threat: ThreatKind = 'none';
  private threatAngle = Math.PI;
  private threatUntil = -1;
  private blueUntil = -1;

  // nameplates
  private platesBox!: HTMLDivElement;
  private plates: { el: HTMLDivElement; pos: HTMLDivElement; name: HTMLDivElement; shown: boolean }[] = [];
  /** Scratch for nameplate de-collision — sized once, never reallocated. */
  private plateSlots: Array<{ i: number; x: number; y: number; d: number; s: number; fade: number }> = [];
  /** Nameplate footprint in CSS px, refreshed on resize (never per frame). */
  private plateH = 30;
  private plateW = 120;

  // debug
  private debugBox!: HTMLDivElement;
  private debugOn = false;
  private debugAcc = 0;

  // --- cached last-rendered values ----------------------------------------
  private lastPos = -1;
  private lastLap = -1;
  private lastTotalLaps = -1;
  private lastKmh = -1;
  private lastItem: ItemType | null | undefined = undefined;
  private lastItemCount = -1;
  private lastTotalStr = '';
  private lastLapStr = '';
  private lastBestStr = '';
  private lastFinalLap = false;
  private lastBoosting = false;
  private lastDriftStage = -1;
  private lastScale = -1;
  private lastW = 0;
  private lastH = 0;

  // --- race bookkeeping ---------------------------------------------------
  private raceTime = 0;
  private lapStart = 0;
  private bestLap = Infinity;
  private finalLapShown = false;
  private offs: Array<() => void> = [];

  /** Measured cost of the last `update()` in milliseconds. */
  costMs = 0;

  constructor(
    container: HTMLElement,
    karts: KartsLike,
    race: RaceLike,
    track: TrackLike,
    engine: EngineLike,
  ) {
    this.container = container;
    this.karts = karts;
    this.race = race;
    this.track = track;
    this.engine = engine;
  }

  // =======================================================================
  // Build
  // =======================================================================

  async init(): Promise<void> {
    if (this.built) return;          // Game calls init() directly *and* via Engine.
    this.built = true;

    const root = el('div', 'ak-hud');
    // The title screen is the first thing on screen, so start hidden and let
    // the race phase bring us in.
    root.classList.add('ak-hud--hidden');
    this.root = root;

    // --- top-left: lap / drift --------------------------------------------
    const tl = el('div', 'ak-hud__corner ak-hud__tl', root);

    const lap = el('div', 'ak-plate ak-lap', tl);
    this.lapPlate = lap;
    el('span', 'ak-lap__label', lap, 'LAP');
    this.lapCur = numeral('1', { tone: 'white', className: 'ak-lap__cur' });
    lap.appendChild(this.lapCur);
    el('span', 'ak-lap__sep', lap, '/');
    this.lapTot = el('span', 'ak-lap__tot', lap, '3');

    // The gold coin plate that used to sit between the lap counter and the
    // mini-turbo bar is GONE, not hidden: owner, P0d follow-up — *"the coin
    // collection bar on the left can also be removed."* `.ak-coins*` rules
    // survive in `ui.css` (another agent's file) with nothing to style.

    const drift = el('div', 'ak-drift', tl);
    this.driftBox = drift;
    el('div', 'ak-drift__label', drift, 'MINI-TURBO');
    for (let i = 1; i <= 3; i++) {
      const seg = el('div', 'ak-drift__seg', drift);
      seg.dataset.tier = String(i);
      const fill = el('i', undefined, seg);
      this.driftSegs.push(seg);
      this.driftFills.push(fill);
    }

    // --- top-centre: item slot -------------------------------------------
    const tc = el('div', 'ak-hud__corner ak-hud__tc', root);
    const item = el('div', 'ak-item ak-item--empty', tc);
    this.itemBox = item;
    el('div', 'ak-item__glow', item);
    el('div', 'ak-item__frame', item);
    const iconWrap = el('div', 'ak-item__icons', item);
    for (let i = 0; i < 3; i++) {
      const ic = el('div', 'ak-item__icon', iconWrap);
      if (i > 0) { ic.style.display = 'none'; ic.classList.add('ak-item__icon--ghost'); }
      ic.style.animationDelay = `${-i * 0.867}s`;
      this.itemIconEls.push(ic);
    }
    el('div', 'ak-item__ring', item);
    this.itemCount = el('div', 'ak-item__count', item, '3');

    // --- top-right: timer / map / rivals ---------------------------------
    const tr = el('div', 'ak-hud__corner ak-hud__tr', root);

    const timer = el('div', 'ak-plate ak-timer', tr);
    const rowT = el('div', 'ak-timer__row', timer);
    el('span', 'ak-timer__k', rowT, 'TIME');
    this.timeTotal = el('span', 'ak-timer__v', rowT, `0'00"000`);
    const rowL = el('div', 'ak-timer__row ak-timer__row--sub', timer);
    el('span', 'ak-timer__k', rowL, 'LAP');
    this.timeLap = el('span', 'ak-timer__v', rowL, `0'00"000`);
    const rowB = el('div', 'ak-timer__row ak-timer__row--sub', timer);
    el('span', 'ak-timer__k', rowB, 'BEST');
    this.timeBest = el('span', 'ak-timer__v', rowB, `--'--"---`);
    this.timeDelta = el('div', 'ak-timer__delta', timer, '+0"000');

    tr.appendChild(this.minimap.el);

    this.rivalsBox = el('div', 'ak-rivals', tr);
    for (let i = 0; i < 2; i++) {
      const row = el('div', `ak-plate ak-rival ${i === 0 ? 'ak-rival--ahead' : 'ak-rival--behind'}`, this.rivalsBox);
      const pos = el('div', 'ak-rival__pos', row, '-');
      const swatch = el('div', 'ak-rival__swatch', row);
      const name = el('div', 'ak-rival__name', row, '—');
      const gap = el('div', 'ak-rival__gap', row, '--');
      this.rivalEls.push({ row, pos, name, gap, swatch });
    }

    // --- bottom-left: position -------------------------------------------
    const bl = el('div', 'ak-hud__corner ak-hud__bl', root);
    const pos = el('div', 'ak-pos', bl);
    this.posBox = pos;
    const plate = el('div', 'ak-pos__plate', pos);
    this.posPlate = plate;
    this.posReel = el('div', 'ak-pos__reel', plate);
    for (let i = 0; i < 2; i++) {
      const cell = el('div', 'ak-pos__cell', this.posReel);
      const digits = numeral('1', { tone: 'gold', className: 'ak-pos__digits' });
      const suffix = numeral('ST', { tone: 'gold', className: 'ak-pos__suffix' });
      cell.append(digits, suffix);
      if (i > 0) cell.style.transform = 'translateY(100%)';
      this.posCells.push({ cell, digits, suffix });
    }
    this.posFlash = el('div', 'ak-pos__flash', plate);
    this.posToast = el('div', 'ak-pos__toast', pos, '▲ 2ND');

    // --- bottom-right: speed readout -------------------------------------
    const br = el('div', 'ak-hud__corner ak-hud__br', root);
    const speed = el('div', 'ak-speed', br);
    this.speedBox = speed;
    const readout = el('div', 'ak-speed__readout', speed);
    this.speedNum = numeral('0', { tone: 'white', className: 'ak-speed__num' });
    readout.appendChild(this.speedNum);
    el('div', 'ak-speed__unit', readout, 'KM/H');
    this.boostBar = el('i', undefined, el('div', 'ak-speed__boost', speed));

    // --- world-space nameplates ------------------------------------------
    this.platesBox = el('div', 'ak-plates', root);
    for (let i = 0; i < MAX_PLATES; i++) {
      const p = el('div', 'ak-plate3d', this.platesBox);
      const posEl = el('div', 'ak-plate3d__pos', p, '1');
      // Seeded with a representative name so `resize()` can measure the plate
      // footprint before the first tick fills it in.
      const nameEl = el('div', 'ak-plate3d__name', p, 'RACER');
      this.plates.push({ el: p, pos: posEl, name: nameEl, shown: false });
    }

    // --- warnings ---------------------------------------------------------
    const warn = el('div', 'ak-warn', root);
    this.warnBox = warn;
    el('div', 'ak-warn__vignette', warn);
    const arrow = el('div', 'ak-warn__arrow', warn);
    this.warnArrow = arrow;
    const svg = svgEl('svg', { viewBox: '0 0 100 100' }, arrow);
    svgEl('path', {
      d: 'M50 4 L92 76 L58 62 L58 96 L42 96 L42 62 L8 76 Z',
      fill: '#ff3b3b',
      stroke: '#ffffff',
      'stroke-width': '6',
      'stroke-linejoin': 'round',
    }, svg);
    const blue = el('div', 'ak-warn__blue', warn);
    this.warnBlue = blue;
    el('div', 'ak-warn__blue-text', blue, 'BLUE SHELL');
    el('div', 'ak-warn__blue-sub', blue, 'INCOMING — GET OFF THE LINE');

    // --- centre stack -----------------------------------------------------
    const centre = el('div', 'ak-center', root);

    const cd = el('div', 'ak-countdown', centre);
    this.countdownBox = cd;
    const lights = el('div', 'ak-lights', cd);
    for (let i = 0; i < 5; i++) this.lights.push(el('i', undefined, lights));
    this.countdownNum = numeral('3', { tone: 'red', className: 'ak-countdown__num' });
    cd.appendChild(this.countdownNum);

    const banner = el('div', 'ak-banner', centre);
    this.banner = banner;
    this.bannerBg = el('div', 'ak-banner__bg', banner);
    this.bannerText = numeral('FINAL LAP!', { tone: 'white', className: 'ak-banner__text' });
    banner.appendChild(this.bannerText);

    this.message = el('div', 'ak-message', centre, '');

    this.hitFlash = el('div', 'ak-hitflash', root);
    this.debugBox = el('div', 'ak-debug', root);

    this.container.appendChild(root);

    // --- data + wiring ----------------------------------------------------
    this.icons.useAtlas(this.items ?? undefined);
    this.refreshTrackPath();
    this.subscribe();
    window.addEventListener('keydown', this.onKeyDown);

    const size = this.engine?.getSize?.() ?? { width: window.innerWidth, height: window.innerHeight };
    this.resize(size.width, size.height);
    this.applyItem(null, 0, true);
  }

  /** Late wiring for the items subsystem so we can adopt its icon atlas. */
  setItems(items: ItemsLike): void {
    this.items = items;
    if (this.built) {
      this.icons.useAtlas(items);
      this.lastItem = undefined;   // force an icon refresh
    }
  }

  setAudio(audio: AudioLike): void { this.audio = audio; }

  /** Menus call this through `game.hud`. */
  setMinimapRotate(on: boolean): void { this.minimap.setRotate(on); }
  get minimapRotate(): boolean { return this.minimap.rotating; }

  /**
   * False when the track only offered a normalised centreline, so racer dots
   * cannot be placed. Worth surfacing: it is the difference between a live
   * minimap and a decorative one.
   */
  get minimapCanPlaceDots(): boolean { return this.minimap.canPlaceDots; }

  /**
   * Request the HUD. This is what `MenuSystem` and the QA harness call, and it
   * is only ever *permission* to appear: the race phase and the menu state can
   * still keep it off screen. See `applyVisibility`.
   */
  setVisible(v: boolean): void {
    this.wantVisible = v;
    this.applyVisibility();
  }

  /** MenuSystem tells us whenever a menu screen owns the frame. */
  setMenuActive(active: boolean): void {
    this.menuActive = active;
    this.applyVisibility();
  }

  /** True when the HUD is actually on screen. */
  get shown(): boolean { return this.visible; }

  /**
   * Race phases the HUD may appear in. There is nothing to report before the
   * lights (`idle` / `intro`) and the results board owns the screen afterwards,
   * so a lap counter and a speedometer behind the logo is just noise.
   */
  private phaseVisible(phase: string | undefined): boolean {
    if (phase === undefined) return true;          // no director wired — assume gameplay
    return phase === 'countdown' || phase === 'racing'
      || phase === 'finished' || phase === 'paused';
  }

  private applyVisibility(): void {
    const v = this.wantVisible && this.phaseAllows && !this.menuActive;
    if (this.visible === v) return;
    this.visible = v;
    if (this.built) setClass(this.root, 'ak-hud--hidden', !v);
  }

  /**
   * Adopt the minimap geometry for the circuit the track currently holds.
   *
   * Called on `init()`, on `race:start`, and twice a second from `tick()`. It
   * must be called repeatedly and it must be able to change its mind, for two
   * separate reasons:
   *
   *  1. `Game` awaits `hud.init()` *before* `engine.initAll()` runs
   *     `Track.init()`, so the first attempt always comes back empty.
   *  2. Picking a different course calls `Track.loadTrack()`, which swaps the
   *     spline **in place on the same `Track` object** and is deliberately not
   *     awaited by `RaceDirector.beginRace()`.
   *
   * This used to guard on a `pathReady` boolean that latched the first time it
   * saw a usable centreline. That first time is `Track.init()`'s default
   * circuit, sampled while the player is still sitting in the main menu — so
   * the ribbon, and with it `Minimap.fit()`'s world→pixel transform, was
   * frozen on Sunset Coastline for the whole session. Every other circuit then
   * drew its racers through a transform fitted to a course they were not on:
   * the markers wandered off the drawn ribbon, moved at the wrong scale, and
   * on the larger circuits left the canvas entirely.
   *
   * Keying on the circuit instead of on "have we ever succeeded" is the fix.
   */
  refreshTrackPath(): void {
    const sig = trackSignature(this.track);
    if (sig !== '' && sig === this.pathKey) return;   // same circuit as the ribbon

    const course = sampleCourse(this.track, MINIMAP_SAMPLES);
    if (!course) return;                              // keep the ribbon we have

    // A track that reports no identity at all still must not be resampled into
    // `setPath` twice a second — that would clear the racer dots every tick.
    const key = sig !== '' ? sig : courseKey(course.pts);
    if (key === this.pathKey) return;
    this.pathKey = key;

    this.minimap.setPath(course.pts, course.space);
    if (course.space === 'unit' && !this.warnedUnitPath) {
      this.warnedUnitPath = true;
      console.warn(
        '[HUD] track.getMinimapPath() is bounding-box normalised, not world '
        + 'metres, and track.sampleAtDistance() was unavailable — the minimap '
        + 'ribbon will draw but racer dots cannot be placed.',
      );
    }

    // Item boxes: `getItemBoxPositions` never existed on Track (it is
    // `getItemBoxSpawns`, and it returns Vector3s in world space).
    // `setPath` drops the old markers with the old coordinate space, so these
    // have to be re-supplied for every circuit, not just the first.
    const flat = tryCall<readonly { x: number; y: number }[]>(this.track, 'getItemBoxPositions')
      ?? tryCall<readonly { x: number; y: number }[]>(this.items, 'getBoxPositions');
    if (flat && flat.length) { this.minimap.setItemBoxes(flat); return; }
    const spawns = tryCall<readonly { position: THREE.Vector3 }[]>(this.track, 'getItemBoxSpawns');
    if (spawns && spawns.length) {
      const out: { x: number; y: number }[] = [];
      for (const s of spawns) if (s?.position) out.push({ x: s.position.x, y: s.position.z });
      if (out.length) this.minimap.setItemBoxes(out);
    }
  }

  // =======================================================================
  // Events
  // =======================================================================

  private playerId(): number {
    const p = this.player();
    return p ? p.id : -1;
  }

  private player(): KartState | null {
    const direct = this.karts?.player;
    if (direct) return direct;
    const list = this.karts?.karts;
    if (!list) return null;
    for (const k of list) if (k.isPlayer) return k;
    return null;
  }

  private subscribe(): void {
    const own = (fn: () => void) => this.offs.push(fn);

    own(bus.on('race:countdown', ({ count }) => this.showCountdown(count)));

    own(bus.on('race:start', () => {
      this.showCountdown(0);
      this.refreshTrackPath();
      this.raceTime = 0;
      this.lapStart = 0;
      this.bestLap = Infinity;
      this.finalLapShown = false;
      this.setVisible(true);
    }));

    own(bus.on('race:lap', ({ kartId, lap, lapTime, isBest }) => {
      if (kartId !== this.playerId()) return;
      this.lapStart = this.raceTime;
      if (lapTime > 0) {
        const prevBest = this.bestLap;
        if (isBest || lapTime < this.bestLap) this.bestLap = lapTime;
        if (Number.isFinite(prevBest)) this.showDelta(lapTime - prevBest);
      }
      punch(this.lapPlate, 1.15, 460);
      this.audio?.play?.('ui_lap');
      const total = this.totalLaps();
      if (lap >= total && !this.finalLapShown) {
        this.finalLapShown = true;
        this.showBanner('FINAL LAP!', 'gold');
      }
    }));

    own(bus.on('race:positionChange', ({ kartId, from, to }) => {
      if (kartId !== this.playerId()) return;
      this.onPositionChange(from, to);
    }));

    own(bus.on('race:finish', ({ kartId, position }) => {
      if (kartId !== this.playerId()) return;
      this.showBanner(`FINISH · ${formatOrdinal(position)}`, position === 1 ? 'gold' : 'red');
    }));

    own(bus.on('race:complete', () => {
      window.setTimeout(() => this.setVisible(false), 900);
    }));

    own(bus.on('item:box', ({ kartId }) => {
      if (kartId !== this.playerId()) return;
      this.startRoulette();
    }));

    own(bus.on('item:granted', ({ kartId, item }) => {
      if (kartId !== this.playerId()) return;
      if (!this.roulette.active) this.startRoulette(0.42);
      this.roulette.target = item;
      this.roulette.stopAt = Math.min(this.roulette.stopAt, this.roulette.t + 0.5);
    }));

    own(bus.on('item:used', ({ kartId, item }) => {
      const pid = this.playerId();
      if (kartId === pid) {
        punch(this.itemBox, 0.9, 320);
        return;
      }
      if (item === ItemType.BlueShell && this.lastPos === 1) {
        this.blueUntil = this.raceTime + 5.5;
        this.threat = 'blue';
      } else if (item === ItemType.RedShell) {
        const src = this.findKart(kartId);
        const me = this.player();
        if (src && me && src.progress < me.progress) {
          this.warn('red', Math.PI, 3.2);
        }
      }
    }));

    own(bus.on('item:hit', ({ targetId, item }) => {
      if (targetId !== this.playerId()) return;
      restartAnim(this.hitFlash, 'ak-hitflash--on');
      this.threat = 'none';
      this.threatUntil = -1;
      this.blueUntil = -1;
      // `Banana` is the Plastic Bottle — you skid on it rather than spin out.
      // The old chain also had `Lightning` -> 'ZAPPED!' and `Squid` ->
      // 'BLINDED!'; both items have been REMOVED, so those were two branches
      // that could never be reached again.
      this.showMessage(item === ItemType.Banana ? 'SKIDDED!' : 'SPUN OUT!', 1.2);
    }));

    own(bus.on('kart:driftTier', ({ kartId, tier }) => {
      if (kartId !== this.playerId()) return;
      const seg = this.driftSegs[clamp(tier - 1, 0, 2)];
      if (seg) restartAnim(seg, 'ak-drift__seg--pop');
    }));

    own(bus.on('kart:boost', ({ kartId, duration }) => {
      if (kartId !== this.playerId()) return;
      this.boostFill = clamp01(duration / BOOST_FULL_SECONDS);
      punch(this.speedBox, 0.5, 380);
    }));

    own(bus.on('ui:message', ({ text, seconds }) => this.showMessage(text, seconds)));
  }

  private findKart(id: number): KartState | null {
    const list = this.karts?.karts;
    if (!list) return null;
    for (const k of list) if (k.id === id) return k;
    return null;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'F3') {
      e.preventDefault();
      this.debugOn = !this.debugOn;
      setClass(this.debugBox, 'ak-debug--on', this.debugOn);
    }
  };

  // =======================================================================
  // Public presentation hooks (also used by the dev harness)
  // =======================================================================

  /** Incoming-item warning. `angle` = 0 ahead, PI behind, in player space. */
  warn(kind: ThreatKind, angle = Math.PI, seconds = 3): void {
    if (kind === 'none') { this.threat = 'none'; this.threatUntil = -1; return; }
    this.threat = kind;
    this.threatAngle = angle;
    if (kind === 'blue') this.blueUntil = this.raceTime + seconds;
    else this.threatUntil = this.raceTime + seconds;
  }

  showMessage(text: string, seconds = 1.6): void {
    setText(this.message, text);
    restartAnim(this.message, 'ak-message--on');
    this.messageHideAt = this.raceTime + seconds;
  }

  showBanner(text: string, tone: 'gold' | 'red' = 'red'): void {
    setNumeralText(this.bannerText, text);
    setClass(this.bannerBg, 'ak-banner__bg--gold', tone === 'gold');
    setNumeralTone(this.bannerText, tone === 'gold' ? 'gold' : 'white');
    setClass(this.banner, 'ak-banner--on', true);
    restartAnim(this.banner, 'ak-banner--sweep');
    this.audio?.play?.(tone === 'gold' ? 'ui_final_lap' : 'ui_banner');
    window.setTimeout(() => setClass(this.banner, 'ak-banner--on', false), 2400);
  }

  /** `3`, `2`, `1`, then `0` for GO. */
  showCountdown(count: number): void {
    const go = count <= 0;
    setClass(this.countdownBox, 'ak-countdown--on', true);
    setNumeralText(this.countdownNum, go ? 'GO!' : String(count));
    setNumeralTone(this.countdownNum, go ? 'green' : count === 1 ? 'gold' : 'red');
    const lit = go ? 5 : clamp(6 - count * 2, 1, 5);
    for (let i = 0; i < this.lights.length; i++) {
      setClass(this.lights[i], 'on', !go && i < lit);
      setClass(this.lights[i], 'go', go);
    }
    punch(this.countdownNum, go ? 1.6 : 1.15, go ? 620 : 520);
    this.countdownHideAt = go ? this.raceTime + 0.85 : -1;
    this.audio?.play?.(go ? 'ui_go' : 'ui_beep');
  }

  /**
   * @deprecated Coins are removed from the game. Accepted and ignored.
   *
   * `RaceDirector`/`Game` may still call this — the HUD's public surface is
   * feature-detected all over the codebase, and a *missing* method there is a
   * `TypeError` at 60 Hz, not a graceful degrade. Keeping the no-op is one line;
   * chasing every caller is another agent's file.
   */
  setCoins(_n: number): void { /* coins removed */ }

  // =======================================================================
  // Per-frame
  // =======================================================================

  private totalLaps(): number {
    const rl = probe<number>(this.race, 'totalLaps');
    if (typeof rl === 'number' && rl > 0) return rl;
    const tl = probe<number>(this.track, 'lapCount');
    if (typeof tl === 'number' && tl > 0) return tl;
    return RACE.laps;
  }

  update(ctx: FrameContext): void {
    if (!this.built) return;
    const t0 = performance.now();
    try {
      this.tick(ctx);
    } catch (err) {
      // A HUD bug must never take the frame loop down.
      console.error('[HUD] update failed', err);
    }
    this.costMs = damp(this.costMs, performance.now() - t0, 0.25, ctx.dt);
  }

  private tick(ctx: FrameContext): void {
    const dt = ctx.dt;
    const p = this.player();

    // The track finishes building after the HUD does, AND swaps circuits under
    // us without warning, so keep asking — twice a second, for the whole
    // session. Once the ribbon matches the loaded circuit this costs two
    // property reads and a string compare; it is not worth latching off, and
    // latching it off is precisely what froze the map on one course.
    this.pathRetryAt -= dt;
    if (this.pathRetryAt <= 0) {
      this.pathRetryAt = 0.5;
      this.refreshTrackPath();
    }

    // --- visibility gate --------------------------------------------------
    // Driven from the race phase every frame rather than from events alone, so
    // it is correct however the race was started (menu flow, `game.startRace`,
    // dev harness) and however it ended.
    const phase = probe<string>(this.race, 'state');
    const allows = this.phaseVisible(phase);
    if (allows !== this.phaseAllows) {
      this.phaseAllows = allows;
      this.applyVisibility();
    }

    // --- clock ------------------------------------------------------------
    const rt = probe<number>(this.race, 'raceTime');
    if (typeof rt === 'number' && rt >= 0) this.raceTime = rt;
    else this.raceTime += dt;

    // --- countdown fallback (no events wired yet) -------------------------
    const cd = probe<number>(this.race, 'countdown');
    if (typeof cd === 'number' && cd > 0) {
      const count = Math.max(1, Math.ceil(cd - 0.6));
      if (count !== this.lastCountdown) { this.lastCountdown = count; this.showCountdown(count); }
    } else if (this.lastCountdown > 0) {
      this.lastCountdown = 0;
      this.showCountdown(0);
    }
    if (this.countdownHideAt > 0 && this.raceTime >= this.countdownHideAt) {
      this.countdownHideAt = -1;
      setClass(this.countdownBox, 'ak-countdown--on', false);
    }
    if (this.messageHideAt > 0 && this.raceTime >= this.messageHideAt) {
      this.messageHideAt = -1;
      this.message.classList.remove('ak-message--on');
    }
    if (this.deltaHideAt > 0 && this.raceTime >= this.deltaHideAt) {
      this.deltaHideAt = -1;
      setClass(this.timeDelta, 'ak-timer__delta--show', false);
    }

    if (!p) {
      this.minimap.update(this.karts?.karts ?? [], null, dt);
      this.updateDebug(dt);
      return;
    }

    // --- position ---------------------------------------------------------
    const posFn = probe<(id: number) => number>(this.race, 'getPosition');
    let pos = typeof posFn === 'function' ? Number(posFn.call(this.race, p.id)) : p.racePosition;
    if (!Number.isFinite(pos) || pos <= 0) pos = p.racePosition > 0 ? p.racePosition : 1;
    if (pos !== this.lastPos) {
      const prev = this.lastPos;
      this.applyPosition(pos, prev);
      this.lastPos = pos;
    }

    // --- lap --------------------------------------------------------------
    const lapFn = probe<(id: number) => number>(this.race, 'getLap');
    const rawLap = typeof lapFn === 'function' ? Number(lapFn.call(this.race, p.id)) : p.lap;
    const total = this.totalLaps();
    const lap = clamp(Number.isFinite(rawLap) ? Math.max(1, Math.round(rawLap)) : 1, 1, total);
    if (lap !== this.lastLap) {
      this.lastLap = lap;
      setNumeralText(this.lapCur, String(lap));
      punch(this.lapCur, 1.2, 420);
    }
    if (total !== this.lastTotalLaps) {
      this.lastTotalLaps = total;
      setText(this.lapTot, String(total));
    }
    const finalLap = lap >= total && total > 0;
    if (finalLap !== this.lastFinalLap) {
      this.lastFinalLap = finalLap;
      setClass(this.lapPlate, 'ak-lap--final', finalLap);
      setNumeralTone(this.lapCur, finalLap ? 'gold' : 'white');
      if (finalLap && !this.finalLapShown) {
        this.finalLapShown = true;
        this.showBanner('FINAL LAP!', 'gold');
      }
    }

    // --- timer ------------------------------------------------------------
    const totalStr = formatTime(this.raceTime);
    if (totalStr !== this.lastTotalStr) { this.lastTotalStr = totalStr; setText(this.timeTotal, totalStr); }
    const lapStr = formatTime(Math.max(0, this.raceTime - this.lapStart));
    if (lapStr !== this.lastLapStr) { this.lastLapStr = lapStr; setText(this.timeLap, lapStr); }
    if (this.bestLap === Infinity && p.lapTimes.length) {
      for (const t of p.lapTimes) if (t > 0 && t < this.bestLap) this.bestLap = t;
    }
    const bestStr = Number.isFinite(this.bestLap) ? formatTime(this.bestLap) : `--'--"---`;
    if (bestStr !== this.lastBestStr) { this.lastBestStr = bestStr; setText(this.timeBest, bestStr); }

    // (No coin block. The per-frame `probe(p, 'coins')` /
    //  `tryCall(this.race, 'getCoins')` pair went with the plate.)

    // --- item slot --------------------------------------------------------
    this.updateItem(p, dt);

    // --- speed ------------------------------------------------------------
    const kmh = Math.abs(p.speed) * 3.6;
    const boosting = p.boostTime > 0;
    this.boostFill = boosting
      ? Math.max(this.boostFill, clamp01(p.boostTime / BOOST_FULL_SECONDS))
      : damp(this.boostFill, 0, 0.18, dt);
    const shownKmh = Math.round(kmh);
    if (shownKmh !== this.lastKmh) {
      this.lastKmh = shownKmh;
      setNumeralText(this.speedNum, String(shownKmh));
    }
    if (boosting !== this.lastBoosting) {
      this.lastBoosting = boosting;
      setClass(this.speedBox, 'ak-speed--boost', boosting);
    }
    // Quantised so a decaying meter doesn't write a new transform every frame.
    const boostStr = this.boostFill.toFixed(2);
    if (boostStr !== this.lastBoostStr) {
      this.lastBoostStr = boostStr;
      this.boostBar.style.transform = `scaleX(${boostStr})`;
    }

    // --- drift charge -----------------------------------------------------
    const stage = p.driftStage;
    const charging = p.drifting || stage > DriftStage.None;
    setClass(this.driftBox, 'ak-drift--on', charging);
    if (charging) {
      // Segment i fills as the tier is reached; the active tier shows partial.
      const reached = stage >= DriftStage.Blue ? stage - 1 : 0;
      for (let i = 0; i < 3; i++) {
        const v = i < reached ? 1 : i === reached ? clamp01(p.driftCharge) : 0;
        const s = v.toFixed(3);
        if (this.driftFills[i].dataset.v !== s) {
          this.driftFills[i].dataset.v = s;
          this.driftFills[i].style.transform = `scaleX(${s})`;
        }
      }
    } else if (this.lastDriftStage !== 0) {
      for (let i = 0; i < 3; i++) {
        this.driftFills[i].dataset.v = '0';
        this.driftFills[i].style.transform = 'scaleX(0)';
      }
    }
    this.lastDriftStage = charging ? stage : 0;

    // --- minimap ----------------------------------------------------------
    this.minimap.update(this.karts.karts, p, dt);

    // --- rivals -----------------------------------------------------------
    this.updateRivals(p);

    // --- warnings ---------------------------------------------------------
    this.updateWarnings(p);

    // --- nameplates -------------------------------------------------------
    this.updatePlates(p);

    // --- debug ------------------------------------------------------------
    this.updateDebug(dt);
  }

  private lastCountdown = 0;

  // ---------------------------------------------------------------------
  // Position plate
  // ---------------------------------------------------------------------

  private applyPosition(pos: number, prev: number): void {
    const cur = this.posCells[this.posActive];
    const nxt = this.posCells[1 - this.posActive];
    const digits = String(pos);
    const suffix = ordinalSuffix(pos);
    const tone = pos === 1 ? 'gold' : pos <= 3 ? 'blue' : 'white';

    setNumeralText(nxt.digits, digits);
    setNumeralText(nxt.suffix, suffix);
    setNumeralTone(nxt.digits, tone);
    setNumeralTone(nxt.suffix, tone);
    setClass(this.posBox, 'ak-pos--first', pos === 1);

    if (prev < 0) {
      // First paint — no roll.
      cur.cell.style.transform = 'translateY(100%)';
      nxt.cell.style.transform = 'translateY(0)';
      this.posActive = 1 - this.posActive;
      return;
    }

    // Improving position rolls the reel down (new number drops in from above).
    const dir = pos < prev ? -1 : 1;
    nxt.cell.style.transform = `translateY(${dir * 100}%)`;
    const ease = 'cubic-bezier(.16,1,.3,1)';
    const dur = 460;
    if (typeof cur.cell.animate === 'function') {
      cur.cell.animate(
        [
          { transform: 'translateY(0) scaleY(1)' },
          { transform: `translateY(${-dir * 42}%) scaleY(1.18)`, offset: 0.45 },
          { transform: `translateY(${-dir * 100}%) scaleY(1)` },
        ],
        { duration: dur, easing: ease, fill: 'forwards' },
      );
      const a = nxt.cell.animate(
        [
          { transform: `translateY(${dir * 100}%) scaleY(1)` },
          { transform: `translateY(${dir * 12}%) scaleY(1.14)`, offset: 0.55 },
          { transform: 'translateY(0) scaleY(1)' },
        ],
        { duration: dur, easing: ease, fill: 'forwards' },
      );
      a.onfinish = () => {
        cur.cell.style.transform = 'translateY(100%)';
        nxt.cell.style.transform = 'translateY(0)';
        cur.cell.getAnimations?.().forEach((an) => an.cancel());
        nxt.cell.getAnimations?.().forEach((an) => an.cancel());
      };
    } else {
      cur.cell.style.transform = 'translateY(100%)';
      nxt.cell.style.transform = 'translateY(0)';
    }
    this.posActive = 1 - this.posActive;

    // Punch + colour flash.
    punch(this.posBox, dir < 0 ? 1.35 : 0.9, 520);
    const gain = dir < 0;
    setClass(this.posFlash, 'ak-pos__flash--gain', gain);
    setClass(this.posFlash, 'ak-pos__flash--loss', !gain);
    if (typeof this.posFlash.animate === 'function') {
      this.posFlash.animate(
        [{ opacity: 0.95 }, { opacity: 0 }],
        { duration: 620, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
    }
    this.audio?.play?.(gain ? 'ui_overtake' : 'ui_overtaken');
  }

  private onPositionChange(from: number, to: number): void {
    const gain = to < from;
    setText(this.posToast, `${gain ? '▲' : '▼'} ${formatOrdinal(to)}`);
    setClass(this.posToast, 'ak-pos__toast--gain', gain);
    setClass(this.posToast, 'ak-pos__toast--loss', !gain);
    restartAnim(this.posToast, 'ak-pos__toast--show');
  }

  private showDelta(delta: number): void {
    setText(this.timeDelta, formatDelta(delta));
    setClass(this.timeDelta, 'ak-timer__delta--up', delta > 0);
    setClass(this.timeDelta, 'ak-timer__delta--down', delta <= 0);
    setClass(this.timeDelta, 'ak-timer__delta--show', true);
    restartAnim(this.timeDelta, 'ak-timer__delta--flash');
    this.deltaHideAt = this.raceTime + 3.4;
  }

  // ---------------------------------------------------------------------
  // Item slot + roulette
  // ---------------------------------------------------------------------

  private startRoulette(stopAt = 0.9): void {
    const r = this.roulette;
    r.active = true;
    r.t = 0;
    r.next = 0;
    r.target = null;
    r.stopAt = stopAt;
    setClass(this.itemBox, 'ak-item--empty', false);
    setClass(this.itemBox, 'ak-item--triple', false);
    setClass(this.itemCount, 'ak-item__count--show', false);
    this.audio?.play?.('item_roulette');
  }

  private updateItem(p: KartState, dt: number): void {
    const r = this.roulette;
    if (r.active) {
      r.t += dt;
      r.next -= dt;
      // Decelerating swap interval: fast at first, crawling as it locks.
      const k = clamp01(r.t / Math.max(0.001, r.stopAt));
      const interval = 0.035 + 0.2 * (k * k);
      if (r.next <= 0) {
        r.next = interval;
        // `ROULETTE` is the items module's live set now, so its length is data.
        // Guard the modulo: an empty set would make this NaN and hand `apply()`
        // an undefined item for the rest of the race.
        const reel = ItemIcons.ROULETTE;
        r.index = reel.length > 0 ? (r.index + 1) % reel.length : 0;
        const it = (r.target !== null && k > 0.82
          ? r.target
          : reel[r.index]) ?? ItemType.Boost;
        this.icons.apply(this.itemIconEls[0], it);
        if (typeof this.itemIconEls[0].animate === 'function') {
          this.itemIconEls[0].animate(
            [{ transform: 'scale(0.82) rotate(-8deg)' }, { transform: 'scale(1) rotate(0deg)' }],
            { duration: Math.min(240, interval * 1000), easing: 'cubic-bezier(.16,1,.3,1)' },
          );
        }
      }
      if (r.t >= r.stopAt) {
        r.active = false;
        const final = r.target ?? p.heldItem ?? ItemType.Boost;
        this.applyItem(final, Math.max(1, p.itemCount || 1), true);
        restartAnim(this.itemBox, 'ak-item--lock');
        punch(this.itemBox, 1.3, 560);
        this.audio?.play?.('item_get');
      }
      return;
    }

    const held = p.heldItem ?? null;
    const count = p.itemCount ?? 0;
    if (held !== this.lastItem || count !== this.lastItemCount) {
      this.applyItem(held, count, false);
    }
  }

  private applyItem(item: ItemType | null, count: number, fromRoulette: boolean): void {
    this.lastItem = item;
    this.lastItemCount = count;
    setClass(this.itemBox, 'ak-item--empty', item === null);
    const triple = item !== null && (ItemIcons.isTriple(item) || count > 1);
    setClass(this.itemBox, 'ak-item--triple', triple);
    const base = item === null ? null : ItemIcons.base(item);
    for (let i = 0; i < 3; i++) {
      const showIcon = item !== null && (i === 0 || triple);
      this.itemIconEls[i].style.display = showIcon ? 'block' : 'none';
      if (showIcon) this.icons.apply(this.itemIconEls[i], base);
    }
    const n = ItemIcons.isTriple(item ?? ItemType.Boost) ? Math.max(3, count) : count;
    setClass(this.itemCount, 'ak-item__count--show', item !== null && n > 1);
    setText(this.itemCount, String(Math.max(0, n)));
    if (item !== null && !fromRoulette) punch(this.itemBox, 0.6, 300);
  }

  // ---------------------------------------------------------------------
  // Rivals
  // ---------------------------------------------------------------------

  private updateRivals(p: KartState): void {
    const list = this.karts.karts;
    if (!list || list.length < 2) {
      for (const r of this.rivalEls) setClass(r.row, 'ak-rival--show', false);
      return;
    }
    const lapLength = probe<number>(this.track, 'lapLength') ?? 1200;
    let ahead: KartState | null = null;
    let behind: KartState | null = null;
    for (const k of list) {
      if (k === p) continue;
      if (k.progress > p.progress) {
        if (!ahead || k.progress < ahead.progress) ahead = k;
      } else if (!behind || k.progress > behind.progress) behind = k;
    }
    const refSpeed = Math.max(10, Math.abs(p.speed));
    const rows: Array<[KartState | null, number]> = [[ahead, 1], [behind, -1]];
    for (let i = 0; i < 2; i++) {
      const el2 = this.rivalEls[i];
      const k = rows[i][0];
      if (!k) { setClass(el2.row, 'ak-rival--show', false); continue; }
      setClass(el2.row, 'ak-rival--show', true);
      const gapSec = Math.abs(k.progress - p.progress) * lapLength / refSpeed;
      const gapStr = `${rows[i][1] > 0 ? '-' : '+'}${formatGap(gapSec)}`;
      setText(el2.gap, gapStr);
      const posStr = String(k.racePosition > 0 ? k.racePosition : '-');
      setText(el2.pos, posStr);
      setText(el2.name, this.kartName(k));
      const col = this.kartColorOf(k);
      if (el2.swatch.dataset.c !== col) {
        el2.swatch.dataset.c = col;
        el2.swatch.style.background = col;
      }
    }
  }

  private kartName(k: KartState): string {
    const n = tryCall<string>(this.karts, 'getName', k.id)
      ?? probe<string>(k, 'characterName')
      ?? probe<string>(k, 'name');
    if (typeof n === 'string' && n.length) return n.toUpperCase();
    return k.isPlayer ? 'YOU' : `RACER ${k.id + 1}`;
  }

  private kartColorOf(k: KartState): string {
    const c = tryCall<string>(this.karts, 'getColorHex', k.id) ?? probe<string>(k, 'colorHex');
    if (typeof c === 'string' && c.length) return c;
    return k.isPlayer ? '#ffffff' : kartColor(k.id);
  }

  // ---------------------------------------------------------------------
  // Warnings
  // ---------------------------------------------------------------------

  private updateWarnings(p: KartState): void {
    if (this.threatUntil > 0 && this.raceTime > this.threatUntil && this.threat === 'red') {
      this.threat = 'none';
      this.threatUntil = -1;
    }
    if (this.blueUntil > 0 && this.raceTime > this.blueUntil) {
      this.blueUntil = -1;
      if (this.threat === 'blue') this.threat = 'none';
    }
    const red = this.threat === 'red';
    const blue = this.threat === 'blue' || this.blueUntil > 0;
    setClass(this.warnBox, 'ak-warn--red', red && !blue);
    setClass(this.warnBox, 'ak-warn--blue', blue);
    setClass(this.warnBlue, 'ak-warn__blue--on', blue);
    setClass(this.warnArrow, 'ak-warn__arrow--on', red);
    if (red) {
      const a = this.threatAngle;
      const rx = this.lastW * 0.34;
      const ry = this.lastH * 0.34;
      const x = Math.sin(a) * rx;
      const y = -Math.cos(a) * ry;
      const tf = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${a.toFixed(3)}rad)`;
      if (this.warnArrow.dataset.tf !== tf) {
        this.warnArrow.dataset.tf = tf;
        this.warnArrow.style.transform = tf;
      }
    }
    void p;
  }

  // ---------------------------------------------------------------------
  // World-space nameplates
  // ---------------------------------------------------------------------

  /**
   * Opponent nameplates.
   *
   * Two things were wrong: every visible rival got a plate (a 12-kart pack in one
   * frame is a wall of labels straight across the racing line), and nothing
   * stopped two plates landing on the same pixels. So: keep only the nearest
   * `MAX_VISIBLE_PLATES`, then push overlapping plates apart vertically —
   * nearest kart wins its position, the ones behind stack upward, away from the
   * road surface rather than across it.
   */
  private updatePlates(player: KartState): void {
    const cam = this.engine?.camera;
    const list = this.karts.karts;
    if (!cam || !list) return;
    const W = this.lastW;
    const H = this.lastH;

    const slots = this.plateSlots;
    slots.length = 0;
    for (const k of list) {
      if (k === player) continue;
      tmpV.set(k.position.x, k.position.y + 2.15, k.position.z);
      const dist = cam.position.distanceTo(tmpV);
      tmpV.project(cam);
      const onScreen = tmpV.z > -1 && tmpV.z < 1
        && tmpV.x > -1.15 && tmpV.x < 1.15 && tmpV.y > -1.15 && tmpV.y < 1.15;
      const fade = 1 - smoothstep((dist - 40) / 45);
      if (!onScreen || fade <= 0.02) continue;
      slots.push({
        i: k.id,
        x: (tmpV.x * 0.5 + 0.5) * W,
        y: (-tmpV.y * 0.5 + 0.5) * H,
        d: dist,
        s: clamp(1.2 - dist / 120, 0.62, 1.1),
        fade,
      });
    }

    // Nearest first — they are the ones that matter and they keep their anchor.
    slots.sort(byDistance);
    if (slots.length > MAX_VISIBLE_PLATES) slots.length = MAX_VISIBLE_PLATES;

    // De-collide on Y. Plates are anchored bottom-centre, so one occupies
    // [y - plateH, y]; two clash when their columns overlap as well.
    //
    // Nearest-first greedy with relaxation: each plate keeps its anchor unless a
    // *closer* plate already owns that space, in which case it steps up above it
    // and re-checks. Only ever upward, so every step strictly increases the
    // separation and the loop terminates; one pass is not enough because
    // stepping clear of one neighbour can move you into another.
    // `transform-origin` is bottom-centre and the scale is applied last, so a
    // plate occupies exactly [y - h*s, y] vertically and [x - w*s/2, x + w*s/2]
    // horizontally — the gap must therefore be scaled too, or a near (large)
    // plate is spaced as if it were a far (small) one.
    for (let a = 1; a < slots.length; a++) {
      for (let pass = 0; pass <= slots.length; pass++) {
        let moved = false;
        for (let b = 0; b < a; b++) {
          const s = Math.max(slots[a].s, slots[b].s);
          if (Math.abs(slots[a].x - slots[b].x) > this.plateW * s) continue;
          const gap = this.plateH * s * 1.1;
          const dy = slots[a].y - slots[b].y;
          if (dy > -gap && dy < gap) {
            slots[a].y = slots[b].y - gap;
            moved = true;
          }
        }
        if (!moved) break;
      }
    }

    let slot = 0;
    for (const s of slots) {
      if (slot >= this.plates.length) break;
      const k = this.findKart(s.i);
      if (!k) continue;
      const plate = this.plates[slot];
      plate.el.style.transform =
        `translate3d(${s.x.toFixed(1)}px, ${Math.max(this.plateH * s.s, s.y).toFixed(1)}px, 0) `
        + `translate(-50%, -100%) scale(${s.s.toFixed(3)})`;
      plate.el.style.opacity = s.fade.toFixed(2);
      if (!plate.shown) { plate.shown = true; plate.el.style.visibility = 'visible'; }
      setText(plate.pos, String(k.racePosition > 0 ? k.racePosition : '-'));
      setText(plate.name, this.kartName(k));
      const col = this.kartColorOf(k);
      if (plate.pos.dataset.c !== col) {
        plate.pos.dataset.c = col;
        plate.pos.style.background = `linear-gradient(180deg, #ffffff, ${col})`;
      }
      slot++;
    }
    for (; slot < this.plates.length; slot++) {
      const plate = this.plates[slot];
      if (plate.shown) { plate.shown = false; plate.el.style.visibility = 'hidden'; }
    }
  }

  // ---------------------------------------------------------------------
  // Debug overlay
  // ---------------------------------------------------------------------

  private updateDebug(dt: number): void {
    if (!this.debugOn) return;
    this.debugAcc += dt;
    if (this.debugAcc < 0.2) return;
    this.debugAcc = 0;
    const info = this.engine?.renderer?.info;
    const q = this.engine?.quality;
    const fps = this.engine?.fpsAverage ?? 0;
    const p = this.player();
    const particles = probe<number>(probe<unknown>(this.engine, 'vfx'), 'activeParticles')
      ?? probe<number>(probe<unknown>(this.engine, 'vfx'), 'liveParticles');
    const lines = [
      `fps        ${fps.toFixed(1)}   (${(1000 / Math.max(1e-3, fps)).toFixed(2)} ms)`,
      `draw calls ${info?.render.calls ?? '-'}`,
      `triangles  ${(info?.render.triangles ?? 0).toLocaleString()}`,
      `geometries ${info?.memory.geometries ?? '-'}  textures ${info?.memory.textures ?? '-'}`,
      `particles  ${particles ?? '-'}`,
      `quality    ${q?.tier ?? '-'}  scale ${q?.renderScale.toFixed(2) ?? '-'}`,
      `hud cost   ${this.costMs.toFixed(3)} ms`,
      p
        ? `player     ${(Math.abs(p.speed) * 3.6).toFixed(0)} km/h  drift ${p.driftStage} ${(p.driftCharge * 100).toFixed(0)}%  surf ${p.surface}  air ${p.grounded ? 'no' : 'yes'}`
        : 'player     —',
      p ? `boost      ${p.boostTime.toFixed(2)}s  rpm ${(p.rpm * 100).toFixed(0)}%  pos ${this.lastPos}  lap ${this.lastLap}/${this.lastTotalLaps}` : '',
    ];
    setText(this.debugBox, lines.join('\n'));
  }

  // ---------------------------------------------------------------------

  resize(width: number, height: number): void {
    if (!this.built) return;
    this.lastW = width;
    this.lastH = height;
    const scale = applyUiScale(width, height);
    if (scale !== this.lastScale) this.lastScale = scale;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Must track `.ak-map`'s width in ui.css — both derive from the same scale.
    this.minimap.resize(MINIMAP_DESIGN_PX * scale, dpr);

    // One layout read per resize so nameplate de-collision needs none per frame.
    // Plate 0 is always in the DOM even while hidden, so this is measurable.
    //
    // `offsetWidth/Height`, NOT `getBoundingClientRect()`: the plates carry a
    // per-frame `scale()`, and a rect measured through it reports whatever scale
    // the previous frame happened to leave behind — which silently under- or
    // over-sized the de-collision gap.
    const probeEl = this.plates[0]?.el;
    if (probeEl) {
      if (probeEl.offsetHeight > 1) this.plateH = probeEl.offsetHeight;
      if (probeEl.offsetWidth > 1) this.plateW = probeEl.offsetWidth;
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    window.removeEventListener('keydown', this.onKeyDown);
    this.minimap.dispose();
    this.root?.remove();
    this.built = false;
  }
}
