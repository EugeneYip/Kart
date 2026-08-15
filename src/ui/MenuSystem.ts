/**
 * ============================================================================
 *  FOXY KART — MENUS
 * ============================================================================
 *  Title → Main → Character → Kart → Track → CC → race, plus Options,
 *  Controls, Pause and the post-race Results flow.
 *
 *  Navigable three ways at once: keyboard, gamepad (polled), mouse. A single
 *  focus model drives all three — every screen is a list (1 column) or a grid
 *  (n columns) of focusable items, and the highlight slides between them with
 *  spring easing.
 *
 *  Nothing here assumes the rest of the game is RUNNING — audio, camera modes,
 *  quality, portraits and pause hooks are all feature-detected, and portraits,
 *  kart thumbs and course previews fall back to procedural art at init.
 *
 *  It does, however, assume the game's DATA exists: the roster, chassis list and
 *  circuit list all come from `./Catalogue`, which derives them from
 *  `@/karts/Characters`, `@/karts/KartBodies` and `@/track/TrackDefs`. There is
 *  no parallel copy of those ids here any more — there used to be, and because
 *  every id lookup in the game falls back silently, six of eight racers drove as
 *  Nova and all three course cards loaded the same circuit.
 *  Guarded by `.probe-tmp/menu-ids.ts` and `.probe-tmp/menu-flow.ts`.
 * ============================================================================
 */

import { bus } from '@/core/EventBus';
import type { FrameContext, ISubsystem, QualityTier } from '@/core/Types';
import { clamp } from '@/core/MathUtils';
import { formatStat, numeral, setNumeralText } from './Fonts';
import { Results } from './Results';
import type { ResultRow, StandingRow } from './Results';
import {
  applyUiScale, characterBust, el, kartThumb, probablyBlank, probe, proceduralLoop, punch,
  setClass, setText, trackPreview, tryCall,
} from './Widgets';
import type { AudioLike, GameLike } from './Widgets';
import { CHARACTERS, KART_BODIES, TRACKS, characterColumns } from './Catalogue';
import type { CharacterDef, StatBlock } from './Catalogue';

// ===========================================================================
// Roster / catalogue data
// ===========================================================================
//
// These three lists are DERIVED from the real game tables in `./Catalogue`
// (`@/karts/Characters`, `@/karts/KartBodies`, `@/track/TrackDefs`) — the menu
// no longer keeps a parallel copy of the ids it emits. Re-exported here because
// this module was their previous home.
//
export { CHARACTERS, KART_BODIES, TRACKS } from './Catalogue';
export type { CharacterDef, KartBodyDef, StatBlock, TrackDef } from './Catalogue';

const STAT_KEYS: ReadonlyArray<keyof StatBlock> = [
  'speed', 'accel', 'weight', 'handling', 'traction', 'turbo',
];
const STAT_LABEL: Record<keyof StatBlock, string> = {
  speed: 'SPEED', accel: 'ACCEL', weight: 'WEIGHT',
  handling: 'HANDLING', traction: 'TRACTION', turbo: 'MINI-TURBO',
};

const CC_OPTIONS = [50, 100, 150, 200] as const;
const QUALITY_ORDER: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];
/** MK8's points table, trimmed to the grid size in play. */
const POINTS = [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/** One row of the stat panel. `ghost` is the racer-only value behind `fill`. */
interface StatRow {
  row: HTMLDivElement;
  ghost: HTMLElement;
  fill: HTMLElement;
  value: HTMLElement;
  delta: HTMLElement;
}

type ScreenId = 'title' | 'main' | 'chars' | 'karts' | 'tracks' | 'cc' | 'options' | 'controls' | 'pause';

interface FocusItem {
  el: HTMLElement;
  onSelect?: () => void;
  onAdjust?: (dir: number) => void;
  disabled?: boolean;
}

interface Screen {
  id: ScreenId;
  root: HTMLDivElement;
  items: FocusItem[];
  cols: number;
  index: number;
  ring?: HTMLDivElement;
  ringHeight?: number;
  onBack?: () => void;
  onFocus?: (i: number) => void;
  onShow?: () => void;
}

export class MenuSystem implements ISubsystem {
  private container: HTMLElement;
  private game: GameLike;
  private audio: AudioLike | null = null;

  private root!: HTMLDivElement;
  private scrim!: HTMLDivElement;
  private titleBg!: HTMLDivElement;
  private screens = new Map<ScreenId, Screen>();
  private current: Screen | null = null;
  private built = false;
  private seenTitle = false;
  private raceLive = false;
  private paused = false;

  private results!: Results;

  // --- selection state ---------------------------------------------------
  private charIndex = 0;
  private kartIndex = 0;
  private trackIndex = 0;
  private ccIndex = 2;
  private mode: 'gp' | 'tt' | 'vs' = 'gp';

  // --- options state -----------------------------------------------------
  private volMaster = 0.8;
  private volMusic = 0.7;
  private volSfx = 0.9;
  private fov = 65;
  private motionBlur = true;
  private mapRotate = false;
  private quality: QualityTier = 'high';

  // --- grand prix --------------------------------------------------------
  private gpRace = 0;
  private standings = new Map<number, number>();

  // --- art ---------------------------------------------------------------
  private portraits: string[] = [];
  /** Portrait by real character id — lets the results screen match AI racers. */
  private portraitById = new Map<string, string>();
  private kartArt: string[] = [];
  private trackArt: string[] = [];

  // --- input -------------------------------------------------------------
  private rafId = 0;
  /** Frame-loop-independent race-phase watch — see `startTicker`. */
  private watchId = 0;
  private padPrev = { x: 0, y: 0, a: false, b: false, start: false };
  private padRepeat = 0;
  private statBars: StatRow[] = [];
  private kartStatBars: StatRow[] = [];
  private optionRefresh: Array<() => void> = [];
  private charName!: HTMLElement;
  private charTagline!: HTMLElement;
  private kartName!: HTMLElement;
  private kartTyre!: HTMLElement;
  private trackName!: HTMLElement;
  private trackSub!: HTMLElement;
  private offs: Array<() => void> = [];

  constructor(container: HTMLElement, game: GameLike) {
    this.container = container;
    this.game = game;
    const q = probe<QualityTier>(game.engine?.quality, 'tier');
    if (q) this.quality = q;
    const camFov = probe<number>(game.engine?.camera, 'fov');
    if (typeof camFov === 'number') this.fov = Math.round(camFov);
    this.build();
  }

  setAudio(audio: AudioLike): void {
    this.audio = audio;
    this.results?.setAudio(audio);
    this.applyVolumes();
  }

  init(): void { /* built eagerly in the constructor; nothing async to do */ }

  // =====================================================================
  // Build
  // =====================================================================

  private build(): void {
    if (this.built) return;
    this.built = true;

    this.root = el('div', 'ak-menus');
    this.scrim = el('div', 'ak-scrim', this.root);
    this.container.appendChild(this.root);

    this.buildArt();
    this.buildTitle();
    this.buildMain();
    this.buildChars();
    this.buildKarts();
    this.buildTracks();
    this.buildCC();
    this.buildOptions();
    this.buildControls();
    this.buildPause();

    this.results = new Results(this.container, this.audio);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);
    this.onResize();

    this.offs.push(bus.on('race:complete', ({ results }) => this.onRaceComplete(results)));
    // A race can begin without going through our own start flow — `Game.startRace`,
    // the dev harness and the automated QA all call the director directly. Both of
    // these fire in that case, and the ticker below catches the `intro` phase that
    // precedes them.
    this.offs.push(bus.on('race:countdown', () => this.onRaceLive()));
    this.offs.push(bus.on('race:start', () => this.onRaceLive()));
  }

  /**
   * The race is live, so get out of the way. Safe to call every frame.
   * Never steals the screen back from the pause menu.
   */
  private onRaceLive(): void {
    this.raceLive = true;
    if (this.paused) return;
    tryCall(this.game.hud, 'setVisible', true);
    if (this.results.visible) this.results.hide();
    if (!this.current) return;
    this.hideAll();
    // Only take the camera off the menu's idle orbit. The race director owns the
    // intro fly-through and the chase framing from here on, so forcing 'chase'
    // unconditionally would cut the intro short.
    if (probe<string>(this.game.camera, 'mode') === 'cinematic') {
      tryCall(this.game.camera, 'setMode', 'chase');
      bus.emit('camera:mode', { mode: 'chase' });
    }
  }

  /** Watches the race phase while a menu is up — see `startTicker`. */
  private pollRaceState(): void {
    const phase = probe<string>(this.game.race, 'state');
    if (phase === undefined) return;
    if (phase === 'idle') { this.raceLive = false; return; }
    if (phase === 'intro' || phase === 'countdown' || phase === 'racing' || phase === 'finished') {
      this.onRaceLive();
    }
  }

  /**
   * `KartManager.renderPortrait(id)` is the intended source — a real 3-D bust of
   * the chosen racer, rendered offscreen from the real rig. It is feature-detected
   * because the menu must build whether or not `src/karts` is running.
   *
   * ⚠️ WHY THE FALLBACK IS NOW A REAL CHARACTER, AND WHY THIS COUNTS PIXELS
   * The 3-D path shipped and produced **ten blank cards**: a degenerate
   * environment probe broke every fragment shader in the portrait scene, so the
   * offscreen buffer came back empty and the studio composited its card art
   * under nothing (see the header of `@/karts/Portrait`). Two lessons are baked
   * in here:
   *
   *  - **A canvas coming back is not proof of art.** `probablyBlank()` samples
   *    the returned bitmap; a portrait with no character in it is rejected as if
   *    the call had failed. Both this and the studio's own ink check would have
   *    caught the defect on their own.
   *  - **The fallback has to be worth falling back to.** It used to be
   *    `characterPortrait()`, one grey visor ellipse with the racer's initial in
   *    the corner — identical for all ten, which the visual critic failed. It is
   *    now `characterBust()`, driven by `BustSpec` off the driver rig's own
   *    definition, so each racer keeps their species, palette and headwear
   *    silhouette.
   *
   * Whichever source wins, it is loud about it exactly once.
   */
  private buildArt(): void {
    let fellBack = 0;
    for (const c of CHARACTERS) {
      const fromKarts = tryCall<unknown>(this.game.karts, 'renderPortrait', c.id, 220);
      let url = '';
      let why = 'renderPortrait is not available';
      if (typeof fromKarts === 'string') {
        url = fromKarts;
        if (!url) why = 'renderPortrait returned an empty string';
      } else if (fromKarts instanceof HTMLCanvasElement) {
        if (probablyBlank(fromKarts)) {
          why = 'renderPortrait returned a canvas with no character in it';
        } else {
          try { url = fromKarts.toDataURL('image/png'); }
          catch { why = 'the portrait canvas could not be encoded'; }
        }
      }
      if (!url) {
        fellBack++;
        if (fellBack === 1) {
          console.warn(`[MenuSystem] no 3-D portrait for "${c.id}" — ${why}. `
            + 'Drawing the canvas-2D bust instead for any racer that needs it.');
        }
        try { url = characterBust(c.bust, c.colorA, c.colorB, c.glow, 220).toDataURL('image/png'); }
        catch { url = ''; }
      }
      this.portraits.push(url);
      this.portraitById.set(c.id, url);
    }
    if (fellBack > 0) {
      console.warn(`[MenuSystem] ${fellBack}/${CHARACTERS.length} racer portraits are the `
        + 'canvas-2D bust rather than a 3-D render.');
    }
    for (const k of KART_BODIES) {
      // `k.id` is the real `KartBodyId`, so the thumbnail is the shape of the
      // chassis you are actually picking rather than a recoloured generic.
      try { this.kartArt.push(kartThumb(k.id, k.colorA, k.colorB, 260, 195).toDataURL('image/png')); }
      catch { this.kartArt.push(''); }
    }
    // Preview loops are the circuits' own centrelines (`TrackDef.outline`), so a
    // card shows the shape you will actually drive. `proceduralLoop` is only a
    // fallback for a def with no usable node list.
    for (const t of TRACKS) {
      const path = t.outline.length > 8 ? t.outline : proceduralLoop(t.seed);
      try {
        this.trackArt.push(trackPreview(path, t.themeA, t.themeB, t.road, 320, 200).toDataURL('image/png'));
      } catch { this.trackArt.push(''); }
    }
  }

  private makeScreen(id: ScreenId, cols: number): Screen {
    const root = el('div', 'ak-screen', this.root);
    root.dataset.screen = id;
    const s: Screen = { id, root, items: [], cols, index: 0 };
    this.screens.set(id, s);
    return s;
  }

  private head(root: HTMLElement, title: string, sub: string, delay = 0): void {
    const h = el('div', 'ak-head ak-stagger', root);
    h.style.setProperty('--d', `${delay}ms`);
    const t = numeral(title, { tone: 'white', className: 'ak-head__title' });
    h.appendChild(t);
    el('div', 'ak-head__sub', h, sub);
  }

  private hints(root: HTMLElement, pairs: ReadonlyArray<[string, string]>, delay = 260): void {
    const box = el('div', 'ak-hints ak-stagger', root);
    box.style.setProperty('--d', `${delay}ms`);
    for (const [key, label] of pairs) {
      const h = el('div', 'ak-hint', box);
      el('span', 'ak-key', h, key);
      el('span', undefined, h, label);
    }
  }

  // --- title -------------------------------------------------------------

  private buildTitle(): void {
    const s = this.makeScreen('title', 1);
    this.titleBg = el('div', 'ak-title-bg', s.root);

    const logo = el('div', 'ak-logo ak-stagger', s.root);
    logo.style.setProperty('--d', '80ms');
    el('div', 'ak-logo__streak', logo);
    const main = numeral('FOXY KART', { tone: 'gold', className: 'ak-logo__main' });
    logo.appendChild(main);
    el('div', 'ak-logo__sub', logo, 'GRAND PRIX');

    const press = el('div', 'ak-press ak-stagger', s.root, 'PRESS START');
    press.style.setProperty('--d', '420ms');

    this.hints(s.root, [['ENTER', 'START'], ['↑↓←→', 'NAVIGATE'], ['ESC', 'BACK']], 620);

    // Anything at all advances from the title.
    s.items.push({ el: press, onSelect: () => this.show('main') });
    s.root.addEventListener('pointerdown', () => this.activate());
  }

  // --- main --------------------------------------------------------------

  private buildMain(): void {
    const s = this.makeScreen('main', 1);
    this.head(s.root, 'MAIN MENU', 'SELECT A MODE');
    const list = el('div', 'ak-list ak-stagger', s.root);
    list.style.setProperty('--d', '120ms');
    s.ring = el('div', 'ak-list__focus', list);

    const rows: Array<[string, string, () => void]> = [
      ['GRAND PRIX', '4 RACES · POINTS', () => { this.mode = 'gp'; this.gpRace = 0; this.standings.clear(); this.show('chars'); }],
      ['TIME TRIAL', 'SOLO · GHOST', () => { this.mode = 'tt'; this.show('chars'); }],
      ['VERSUS', 'SINGLE RACE', () => { this.mode = 'vs'; this.show('chars'); }],
      ['OPTIONS', 'DISPLAY · AUDIO', () => this.show('options')],
    ];
    for (const [label, hint, fn] of rows) this.addRow(s, list, label, hint, fn);
    this.hints(s.root, [['ENTER', 'SELECT'], ['ESC', 'BACK']], 420);
    s.onBack = () => this.show('title');
  }

  private addRow(
    s: Screen, list: HTMLElement, label: string, hint: string,
    onSelect?: () => void, onAdjust?: (d: number) => void,
  ): { row: HTMLDivElement; value: HTMLDivElement } {
    const row = el('div', 'ak-item-row', list);
    el('div', 'ak-item-row__label', row, label);
    const value = el('div', 'ak-item-row__value', row, '');
    value.style.display = 'none';
    if (hint) el('div', 'ak-item-row__hint', row, hint);
    const item: FocusItem = { el: row, onSelect, onAdjust };
    const idx = s.items.length;
    s.items.push(item);
    row.addEventListener('click', () => { this.setFocus(idx); this.activate(); });
    row.addEventListener('pointerenter', () => this.setFocus(idx));
    return { row, value };
  }

  // --- character select --------------------------------------------------

  private buildChars(): void {
    // The roster decides how wide the grid is, and the same number drives both
    // the CSS columns and the focus model — they cannot drift apart.
    const cols = characterColumns(CHARACTERS.length);
    const s = this.makeScreen('chars', cols);
    this.head(s.root, 'CHOOSE YOUR RACER', 'STATS UPDATE AS YOU BROWSE');

    const grid = el('div', 'ak-grid ak-grid--chars ak-stagger', s.root);
    grid.style.setProperty('--d', '120ms');
    // The COUNT is ours (it drives the focus model); the WIDTH belongs to
    // `ui.css`, which floors it so an 11px `MASCOT` badge still fits the card.
    grid.style.gridTemplateColumns = `repeat(${cols}, var(--ak-card-w))`;
    for (let i = 0; i < CHARACTERS.length; i++) {
      const c = CHARACTERS[i];
      const card = el('div', 'ak-card ak-card--char', grid);
      const art = el('div', 'ak-card__art', card);
      if (this.portraits[i]) art.style.backgroundImage = `url("${this.portraits[i]}")`;
      art.style.backgroundSize = 'cover';
      if (c.mascot) el('div', 'ak-card__tag ak-card__tag--gold', card, 'MASCOT');
      el('div', 'ak-card__name', card, c.name.toUpperCase());
      const idx = s.items.length;
      s.items.push({
        el: card,
        onSelect: () => { this.charIndex = i; this.show('karts'); },
      });
      card.addEventListener('click', () => { this.setFocus(idx); this.activate(); });
      card.addEventListener('pointerenter', () => this.setFocus(idx));
    }

    const panel = el('div', 'ak-stats ak-stagger', s.root);
    panel.style.setProperty('--d', '260ms');
    this.charName = el('div', 'ak-stats__name', panel, '');
    this.charTagline = el('div', 'ak-stats__sub', panel, '');
    this.statBars = this.buildStatRows(panel);
    this.hints(s.root, [['ENTER', 'CONFIRM'], ['ESC', 'BACK']], 380);

    s.onFocus = (i) => { this.charIndex = i; this.paintCharStats(); };
    s.onShow = () => { s.index = this.charIndex; this.paintCharStats(); };
    s.onBack = () => this.show('main');
  }

  private buildStatRows(panel: HTMLElement): StatRow[] {
    const out: StatRow[] = [];
    for (const k of STAT_KEYS) {
      const row = el('div', 'ak-stat', panel);
      el('div', 'ak-stat__k', row, STAT_LABEL[k]);
      const bar = el('div', 'ak-stat__bar', row);
      // Order matters: the ghost is the racer's own value and must sit UNDER the
      // combined fill, so the chassis' contribution is the part that sticks out.
      const ghost = el('i', 'ak-stat__ghost', bar);
      const fill = el('i', undefined, bar);
      const value = el('div', 'ak-stat__v', row, '0.0');
      const delta = el('div', 'ak-stat__d', row, '');
      out.push({ row, ghost, fill, value, delta });
    }
    return out;
  }

  /**
   * THE HEADER PROMISES A DELTA, SO THE PANEL HAS TO SHOW ONE.
   *
   * The kart screen is captioned "DELTAS SHOWN AGAINST YOUR RACER" and showed
   * six absolute numbers. Picking Heavy Cruiser moved 2.5/3.0/1.0 to 3.0/2.5/2.0
   * and nothing on screen said which way, by how much, or against what — the
   * player had to remember the previous screen's numbers to read the current
   * one. Three things are drawn now, all from the same `base` / `d` pair:
   *
   *   - a ghost bar at the RACER's value, so the chassis' contribution is
   *     visible as the difference between two lengths rather than inferred;
   *   - the combined value, as before;
   *   - the signed delta itself, `+0.5` / `-0.75`, which is the thing the
   *     header was advertising.
   *
   * `deltas` is undefined on the racer screen, so every `d` is 0, and the ghost
   * and the chip both stay hidden there. One code path, two screens.
   */
  private paintStats(bars: StatRow[], stats: StatBlock, deltas?: Partial<StatBlock>): void {
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const k = STAT_KEYS[i];
      const base = clamp(stats[k], 0, 5);
      const d = deltas?.[k] ?? 0;
      const v = clamp(base + d, 0, 5);
      const bar = bars[i];
      bar.fill.style.transform = `scaleX(${(v / 5).toFixed(3)})`;
      // The ghost marks where the racer alone sits. Clamping `v` means the
      // EFFECTIVE delta can be smaller than the authored one (a 5.0 racer gains
      // nothing from a +0.25 chassis), so report what actually changed.
      const shown = v - base;
      bar.ghost.style.transform = `scaleX(${(base / 5).toFixed(3)})`;
      setClass(bar.ghost, 'ak-stat__ghost--on', shown !== 0);
      setText(bar.value, formatStat(v));
      setText(bar.delta, shown === 0 ? '' : `${shown > 0 ? '+' : '−'}${Math.abs(shown).toFixed(2).replace(/0$/, '')}`);
      setClass(bar.row, 'ak-stat--delta-up', shown > 0);
      setClass(bar.row, 'ak-stat--delta-down', shown < 0);
    }
  }

  private paintCharStats(): void {
    const c = CHARACTERS[this.charIndex];
    setText(this.charName, c.name.toUpperCase());
    setText(this.charTagline, c.tagline);
    this.paintStats(this.statBars, c.stats);
  }

  // --- kart select -------------------------------------------------------

  private buildKarts(): void {
    const s = this.makeScreen('karts', 3);
    this.head(s.root, 'CHOOSE YOUR KART', 'DELTAS SHOWN AGAINST YOUR RACER');

    const grid = el('div', 'ak-grid ak-grid--karts ak-stagger', s.root);
    grid.style.setProperty('--d', '120ms');
    for (let i = 0; i < KART_BODIES.length; i++) {
      const k = KART_BODIES[i];
      const card = el('div', 'ak-card ak-card--kart', grid);
      const art = el('div', 'ak-card__art', card);
      if (this.kartArt[i]) art.style.backgroundImage = `url("${this.kartArt[i]}")`;
      art.style.backgroundSize = 'cover';
      el('div', 'ak-card__tag', card, k.tag);
      el('div', 'ak-card__name', card, k.name.toUpperCase());
      const idx = s.items.length;
      s.items.push({ el: card, onSelect: () => { this.kartIndex = i; this.show('tracks'); } });
      card.addEventListener('click', () => { this.setFocus(idx); this.activate(); });
      card.addEventListener('pointerenter', () => this.setFocus(idx));
    }

    const panel = el('div', 'ak-stats ak-stagger', s.root);
    panel.style.setProperty('--d', '240ms');
    this.kartName = el('div', 'ak-stats__name', panel, '');
    // Real data: `BODY_TYRE` says which tyre family each chassis ships with.
    this.kartTyre = el('div', 'ak-stats__sub', panel, '');
    this.kartStatBars = this.buildStatRows(panel);
    this.hints(s.root, [['ENTER', 'CONFIRM'], ['ESC', 'BACK']], 360);

    s.onFocus = (i) => { this.kartIndex = i; this.paintKartStats(); };
    s.onShow = () => { s.index = this.kartIndex; this.paintKartStats(); };
    s.onBack = () => this.show('chars');
  }

  private paintKartStats(): void {
    const k = KART_BODIES[this.kartIndex];
    const c = CHARACTERS[this.charIndex];
    setText(this.kartName, `${c.name.toUpperCase()} + ${k.name.toUpperCase()}`);
    setText(this.kartTyre, `${k.tyre.toUpperCase()} TYRES`);
    this.paintStats(this.kartStatBars, c.stats, k.deltas);
  }

  // --- track select ------------------------------------------------------

  private buildTracks(): void {
    const cols = Math.max(1, Math.min(3, TRACKS.length));
    const s = this.makeScreen('tracks', cols);
    this.head(s.root, 'SELECT A COURSE', `${TRACKS.length} CIRCUITS`);

    const grid = el('div', 'ak-grid ak-grid--tracks ak-stagger', s.root);
    grid.style.setProperty('--d', '120ms');
    grid.style.gridTemplateColumns = `repeat(${cols}, var(--ak-card-w))`;
    for (let i = 0; i < TRACKS.length; i++) {
      const t = TRACKS[i];
      const card = el('div', 'ak-card ak-card--track', grid);
      const art = el('div', 'ak-card__art', card);
      if (this.trackArt[i]) art.style.backgroundImage = `url("${this.trackArt[i]}")`;
      art.style.backgroundSize = 'cover';
      el('div', 'ak-card__tag', card, t.tag);
      const meta = el('div', 'ak-card__meta', card);
      for (let d = 0; d < 3; d++) {
        el('div', `ak-card__pip${d < t.difficulty ? ' ak-card__pip--on' : ''}`, meta);
      }
      // Course name only. It used to read `NAME  ·  1.6 KM`, which wrapped to
      // three lines on a card this wide and left "KM" alone on the last one.
      // The length now lives in the caption under the grid, where it has a full
      // line to itself.
      el('div', 'ak-card__name', card, t.name.toUpperCase());
      const idx = s.items.length;
      s.items.push({ el: card, onSelect: () => { this.trackIndex = i; this.show('cc'); } });
      card.addEventListener('click', () => { this.setFocus(idx); this.activate(); });
      card.addEventListener('pointerenter', () => this.setFocus(idx));
    }
    const caption = el('div', 'ak-track-caption ak-stagger', s.root);
    caption.style.setProperty('--d', '240ms');
    this.trackName = el('div', 'ak-stats__name', caption, '');
    this.trackSub = el('div', 'ak-stats__sub', caption, '');
    this.hints(s.root, [['ENTER', 'CONFIRM'], ['ESC', 'BACK']], 340);

    s.onFocus = (i) => { this.trackIndex = i; this.paintTrackName(); };
    s.onShow = () => { s.index = this.trackIndex; this.paintTrackName(); };
    s.onBack = () => this.show('karts');
  }

  private paintTrackName(): void {
    const t = TRACKS[this.trackIndex];
    const diff = ['EASY', 'MEDIUM', 'HARD'][clamp(t.difficulty - 1, 0, 2)];
    // Lap COUNT stays off: the owner asked for it out and it was the same three
    // on every circuit. Length is back, but here rather than on the card — it
    // does differ per circuit, and on the card it was what wrapped the name to
    // three lines. ` ` binds the unit to its number so "KM" can never be
    // widowed again.
    setText(this.trackName, `${t.name.toUpperCase()}  —  ${diff}`);
    setText(this.trackSub, `${t.subtitle}  ·  ${t.lengthKm.toFixed(1)} KM`);
  }

  // --- CC ----------------------------------------------------------------

  private buildCC(): void {
    const s = this.makeScreen('cc', 4);
    this.head(s.root, 'ENGINE CLASS', 'HOW FAST DARE YOU GO');
    const grid = el('div', 'ak-grid ak-grid--cc ak-stagger', s.root);
    grid.style.setProperty('--d', '120ms');
    const subs = ['ROOKIE', 'STANDARD', 'EXPERT', 'INSANE'];
    for (let i = 0; i < CC_OPTIONS.length; i++) {
      const card = el('div', 'ak-card ak-card--cc', grid);
      const box = el('div', 'ak-cc', card);
      const n = numeral(`${CC_OPTIONS[i]}cc`, { tone: i >= 3 ? 'red' : i === 2 ? 'gold' : 'blue', className: 'ak-cc__num' });
      box.appendChild(n);
      el('div', 'ak-cc__sub', box, subs[i]);
      const idx = s.items.length;
      s.items.push({ el: card, onSelect: () => { this.ccIndex = i; this.startRace(); } });
      card.addEventListener('click', () => { this.setFocus(idx); this.activate(); });
      card.addEventListener('pointerenter', () => this.setFocus(idx));
    }
    this.hints(s.root, [['ENTER', 'START RACE'], ['ESC', 'BACK']], 300);
    s.onShow = () => { s.index = this.ccIndex; };
    s.onBack = () => this.show('tracks');
  }

  // --- options -----------------------------------------------------------

  private buildOptions(): void {
    const s = this.makeScreen('options', 1);
    this.head(s.root, 'OPTIONS', 'DISPLAY · AUDIO · CAMERA');
    const list = el('div', 'ak-list ak-stagger', s.root);
    list.style.setProperty('--d', '120ms');
    s.ring = el('div', 'ak-list__focus', list);

    // Quality tier.
    {
      const { row, value } = this.addRow(s, list, 'GRAPHICS', '', () => this.cycleQuality(1), (d) => this.cycleQuality(d));
      value.style.display = 'block';
      this.optionRefresh.push(() => setText(value, this.quality.toUpperCase()));
      void row;
    }
    // Volumes.
    this.addSlider(s, list, 'MASTER VOLUME', () => this.volMaster, (v) => { this.volMaster = v; this.applyVolumes(); });
    this.addSlider(s, list, 'MUSIC', () => this.volMusic, (v) => { this.volMusic = v; this.applyVolumes(); });
    this.addSlider(s, list, 'SOUND FX', () => this.volSfx, (v) => { this.volSfx = v; this.applyVolumes(); });
    // FOV.
    this.addSlider(
      s, list, 'CAMERA FOV',
      () => (this.fov - 50) / 45,
      (v) => { this.fov = Math.round(50 + v * 45); this.applyFov(); },
      () => `${this.fov}°`,
    );
    // Toggles.
    {
      const { value } = this.addRow(s, list, 'MOTION BLUR', '', () => this.toggleMotionBlur(), (d) => { void d; this.toggleMotionBlur(); });
      value.style.display = 'block';
      this.optionRefresh.push(() => setText(value, this.motionBlur ? 'ON' : 'OFF'));
    }
    {
      const { value } = this.addRow(s, list, 'MINIMAP', '', () => this.toggleMapRotate(), (d) => { void d; this.toggleMapRotate(); });
      value.style.display = 'block';
      this.optionRefresh.push(() => setText(value, this.mapRotate ? 'TRACK-UP' : 'NORTH-UP'));
    }
    this.addRow(s, list, 'CONTROLS', 'REFERENCE', () => this.show('controls'));
    this.addRow(s, list, 'BACK', '', () => this.show(this.raceLive ? 'pause' : 'main'));

    this.hints(s.root, [['←→', 'ADJUST'], ['ENTER', 'TOGGLE'], ['ESC', 'BACK']], 400);
    s.onShow = () => this.refreshOptions();
    s.onBack = () => this.show(this.raceLive ? 'pause' : 'main');
  }

  private addSlider(
    s: Screen, list: HTMLElement, label: string,
    get: () => number, set: (v: number) => void, fmt?: () => string,
  ): void {
    const row = el('div', 'ak-item-row', list);
    el('div', 'ak-item-row__label', row, label);
    const slider = el('div', 'ak-slider', row);
    const fill = el('i', undefined, slider);
    const knob = el('b', undefined, slider);
    const value = el('div', 'ak-item-row__value', row, '');
    value.style.minWidth = 'calc(70 * var(--u))';

    const refresh = () => {
      const v = clamp(get(), 0, 1);
      fill.style.transform = `scaleX(${v.toFixed(3)})`;
      knob.style.left = `${(v * 100).toFixed(1)}%`;
      setText(value, fmt ? fmt() : `${Math.round(v * 100)}`);
    };
    this.optionRefresh.push(refresh);

    const idx = s.items.length;
    s.items.push({
      el: row,
      onSelect: () => { set(clamp(get() + 0.1, 0, 1)); refresh(); },
      onAdjust: (d) => { set(clamp(get() + d * 0.05, 0, 1)); refresh(); this.audio?.play?.('ui_move'); },
    });
    row.addEventListener('pointerenter', () => this.setFocus(idx));
    slider.addEventListener('pointerdown', (e: PointerEvent) => {
      const r = slider.getBoundingClientRect();
      set(clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1));
      refresh();
      this.setFocus(idx);
    });
    refresh();
  }

  private refreshOptions(): void { for (const fn of this.optionRefresh) fn(); }

  private cycleQuality(dir: number): void {
    const i = QUALITY_ORDER.indexOf(this.quality);
    const n = (i + (dir >= 0 ? 1 : QUALITY_ORDER.length - 1)) % QUALITY_ORDER.length;
    this.quality = QUALITY_ORDER[n];
    tryCall(this.game.engine, 'setQuality', this.quality);
    this.refreshOptions();
    this.audio?.play?.('ui_select');
  }

  private toggleMotionBlur(): void {
    this.motionBlur = !this.motionBlur;
    const q = this.game.engine?.quality as { motionBlur?: boolean } | undefined;
    if (q) q.motionBlur = this.motionBlur;
    tryCall(probe<unknown>(this.game, 'pipeline'), 'setMotionBlur', this.motionBlur);
    this.refreshOptions();
    this.audio?.play?.('ui_select');
  }

  private toggleMapRotate(): void {
    this.mapRotate = !this.mapRotate;
    tryCall(this.game.hud, 'setMinimapRotate', this.mapRotate);
    this.refreshOptions();
    this.audio?.play?.('ui_select');
  }

  private applyVolumes(): void {
    const a = this.audio ?? this.game.audio;
    if (!a) return;
    tryCall(a, 'setMasterVolume', this.volMaster);
    tryCall(a, 'setMusicVolume', this.volMusic);
    tryCall(a, 'setSfxVolume', this.volSfx);
    tryCall(a, 'setVolume', this.volMaster);
  }

  private applyFov(): void {
    const cam = this.game.engine?.camera;
    if (cam) {
      cam.fov = this.fov;
      tryCall(cam, 'updateProjectionMatrix');
    }
    tryCall(this.game.camera, 'setFov', this.fov);
  }

  // --- controls ----------------------------------------------------------

  private buildControls(): void {
    const s = this.makeScreen('controls', 1);
    this.head(s.root, 'CONTROLS', 'KEYBOARD  ·  GAMEPAD');
    const box = el('div', 'ak-stats ak-stagger', s.root);
    box.style.setProperty('--d', '120ms');
    const table = el('div', 'ak-controls-table', box);
    const pairs: ReadonlyArray<[string, string]> = [
      ['ACCELERATE', 'W / ↑  ·  RT or A'],
      ['BRAKE', 'S / ↓  ·  LT or B'],
      ['STEER', 'A D / ← →  ·  LEFT STICK'],
      ['DRIFT / HOP', 'SPACE or SHIFT  ·  RB or LB'],
      ['USE ITEM', 'E / F / CTRL  ·  X or Y'],
      ['LOOK BEHIND', 'Q  ·  RIGHT STICK CLICK'],
      ['PAUSE', 'ESC  ·  START'],
      ['DEBUG OVERLAY', 'F3'],
    ];
    for (const [k, v] of pairs) {
      el('span', undefined, table, k);
      el('span', undefined, table, v);
    }
    const list = el('div', 'ak-list ak-stagger', s.root);
    list.style.setProperty('--d', '240ms');
    s.ring = el('div', 'ak-list__focus', list);
    this.addRow(s, list, 'BACK', '', () => this.show('options'));
    s.onBack = () => this.show('options');
  }

  // --- pause -------------------------------------------------------------

  private buildPause(): void {
    const s = this.makeScreen('pause', 1);
    this.head(s.root, 'PAUSED', 'TAKE A BREATH');
    const list = el('div', 'ak-list ak-stagger', s.root);
    list.style.setProperty('--d', '80ms');
    s.ring = el('div', 'ak-list__focus', list);
    this.addRow(s, list, 'RESUME', '', () => this.resume());
    this.addRow(s, list, 'RESTART RACE', '', () => { this.resume(); this.startRace(); });
    this.addRow(s, list, 'CHANGE TRACK', '', () => { this.resume(true); this.show('tracks'); });
    this.addRow(s, list, 'OPTIONS', '', () => this.show('options'));
    this.addRow(s, list, 'QUIT TO MENU', '', () => { this.resume(true); this.quitToMenu(); });
    this.hints(s.root, [['ESC', 'RESUME'], ['ENTER', 'SELECT']], 300);
    s.onBack = () => this.resume();
  }

  // =====================================================================
  // Flow
  // =====================================================================

  showMainMenu(): void {
    this.show(this.seenTitle ? 'main' : 'title');
  }

  /** Public escape hatch used by the dev harness and by Game. */
  show(id: ScreenId): void {
    const next = this.screens.get(id);
    if (!next) return;
    if (this.current === next) return;
    if (id === 'title') this.seenTitle = false;
    if (id === 'main') this.seenTitle = true;

    if (this.current) {
      const prev = this.current;
      prev.root.classList.add('ak-screen--out');
      prev.root.classList.remove('ak-screen--on');
      window.setTimeout(() => prev.root.classList.remove('ak-screen--out'), 420);
    }
    this.current = next;
    next.onShow?.();
    next.root.classList.add('ak-screen--on');

    const blur = id === 'pause';
    const showcase = id === 'title' || id === 'main';
    setClass(this.scrim, 'ak-scrim--on', true);
    setClass(this.scrim, 'ak-scrim--blur', blur);
    // THE TITLE SCREEN'S ONLY ATMOSPHERE IS THE 3-D BACKDROP, SO STOP BURYING IT.
    // Two layers were stacked over it: this scrim (0.55 alpha at the centre
    // rising to 0.86 at the edges) and `.ak-title-bg` at 0.45 over an OPAQUE
    // gradient. Multiplied out, the cinematic camera's render came through at
    // ~25 % in the middle of the frame and ~8 % at the corners — measured, and
    // the critic independently put it at 45 % to 14 % from the scrim alone.
    // On the two screens that have a backdrop worth showing, the scrim drops to
    // a soft bottom-weighted vignette and the flat gradient nearly vanishes.
    setClass(this.scrim, 'ak-scrim--showcase', showcase);
    setClass(this.root, 'ak-menus--active', true);
    // A lap counter and a speedometer behind the logo reads as a bug. The HUD
    // gates itself on this plus the race phase.
    tryCall(this.game.hud, 'setMenuActive', true);
    this.titleBg.style.display = showcase ? 'block' : 'none';
    this.titleBg.style.opacity = this.hasCinematicCamera() ? '0.18' : '1';
    if (id === 'title' || id === 'main') this.requestCinematicCamera();

    // Force a reflow-free stagger restart.
    for (const node of next.root.querySelectorAll<HTMLElement>('.ak-stagger')) {
      node.style.animation = 'none';
      void node.offsetWidth;
      node.style.animation = '';
    }

    this.setFocus(next.index, true);
    this.audio?.play?.('ui_page');
    this.startTicker();
  }

  private hideAll(): void {
    if (this.current) {
      this.current.root.classList.remove('ak-screen--on');
      this.current = null;
    }
    setClass(this.scrim, 'ak-scrim--on', false);
    setClass(this.scrim, 'ak-scrim--blur', false);
    setClass(this.root, 'ak-menus--active', false);
    tryCall(this.game.hud, 'setMenuActive', false);
    this.titleBg.style.display = 'none';
    this.stopTicker();
  }

  private hasCinematicCamera(): boolean {
    return typeof probe<unknown>(this.game.camera, 'setMode') === 'function';
  }

  private requestCinematicCamera(): void {
    tryCall(this.game.camera, 'setMode', 'cinematic');
    bus.emit('camera:mode', { mode: 'cinematic' });
  }

  /**
   * Every id emitted here comes from the real tables via `./Catalogue`:
   * `trackId` resolves in `TRACKS`/`getTrackDef`, `characterId` in `CHARACTERS`
   * and `CHARACTER_STATS`, `kartId` in `KART_BODY_IDS`. `.probe-tmp/menu-ids.ts`
   * asserts all three for every selectable row.
   */
  private startRace(): void {
    const t = TRACKS[this.trackIndex];
    const c = CHARACTERS[this.charIndex];
    const cc = CC_OPTIONS[this.ccIndex];
    this.hideAll();
    this.results.hide();
    this.raceLive = true;
    tryCall(this.game.camera, 'setMode', 'chase');
    bus.emit('camera:mode', { mode: 'chase' });
    tryCall(this.game.hud, 'setVisible', true);
    tryCall(this.game, 'startRace', {
      trackId: t.id, characterId: c.id, kartId: KART_BODIES[this.kartIndex].id,
      cc, mode: this.mode, laps: t.laps,
    });
    this.audio?.play?.('ui_start');
  }

  private quitToMenu(): void {
    this.raceLive = false;
    this.results.hide();
    tryCall(this.game.hud, 'setVisible', false);
    tryCall(this.game.race, 'abortRace');
    this.show('main');
  }

  // --- pause -------------------------------------------------------------

  showPause(): void {
    if (this.paused) return;
    this.paused = true;
    this.setPaused(true);
    this.show('pause');
  }

  private resume(keepMenus = false): void {
    this.paused = false;
    this.setPaused(false);
    if (!keepMenus) {
      this.hideAll();
      tryCall(this.game.hud, 'setVisible', true);
    }
  }

  /** Best-effort pause: whichever hook the game exposes. */
  private setPaused(on: boolean): void {
    const done = tryCall<unknown>(this.game, 'setPaused', on)
      ?? tryCall<unknown>(this.game.race, 'setPaused', on)
      ?? tryCall<unknown>(this.game, 'pause', on);
    if (done === undefined) {
      // No hook yet — at least stop time advancing in the sim if it offers a scale.
      tryCall(this.game.engine, 'setTimeScale', on ? 0 : 1);
    }
    tryCall(this.game.audio, 'duck', on ? 0.6 : 0, 0.2);
  }

  // =====================================================================
  // Results
  // =====================================================================

  /**
   * Which catalogue row a finishing kart belongs to. The player is whatever the
   * menu picked; for everyone else `KartManager.characterOf(id)` knows, and only
   * if that isn't wired yet do we fall back to spreading the roster over the
   * grid by index.
   */
  private characterFor(kartId: number, isPlayer: boolean): CharacterDef {
    if (isPlayer) return CHARACTERS[this.charIndex];
    const live = tryCall<{ id?: string }>(this.game.karts, 'characterOf', kartId);
    if (live && typeof live.id === 'string') {
      const hit = CHARACTERS.find((c) => c.id === live.id);
      if (hit) return hit;
    }
    return CHARACTERS[((kartId % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length];
  }

  private onRaceComplete(results: ReadonlyArray<{ kartId: number; position: number; time: number }>): void {
    this.raceLive = false;
    const karts = this.game.karts?.karts ?? [];
    const rows: ResultRow[] = [];
    for (const r of results) {
      const k = karts.find((x) => x.id === r.kartId);
      const isPlayer = !!k?.isPlayer;
      const pts = POINTS[clamp(r.position - 1, 0, POINTS.length - 1)] ?? 0;
      let best = 0;
      if (k && k.lapTimes.length) {
        best = Infinity;
        for (const t of k.lapTimes) if (t > 0 && t < best) best = t;
        if (!Number.isFinite(best)) best = 0;
      }
      // Ask the roster who this racer actually is before falling back to the
      // menu's own index. `characterOf`/`getColorHex` are real `KartManager`
      // methods; with real ids the portrait and swatch now match the kart on
      // track instead of being `kartId % 10` of the menu list.
      const entry = this.characterFor(r.kartId, isPlayer);
      const name = isPlayer
        ? entry.name
        : (tryCall<string>(this.game.karts, 'getName', r.kartId) ?? entry.name);
      rows.push({
        kartId: r.kartId,
        position: r.position,
        name,
        time: r.time,
        bestLap: best,
        points: this.mode === 'gp' ? pts : undefined,
        isPlayer,
        color: tryCall<string>(this.game.karts, 'getColorHex', r.kartId) ?? entry.colorA,
        portrait: this.portraitById.get(entry.id) ?? '',
      });
      if (this.mode === 'gp') {
        this.standings.set(r.kartId, (this.standings.get(r.kartId) ?? 0) + pts);
      }
    }

    const standings: StandingRow[] = [];
    if (this.mode === 'gp') {
      for (const [kartId, points] of this.standings) {
        const row = rows.find((x) => x.kartId === kartId);
        standings.push({
          kartId, points,
          name: row?.name ?? `Racer ${kartId + 1}`,
          isPlayer: row?.isPlayer,
          color: row?.color,
        });
      }
    }

    const isGp = this.mode === 'gp';
    const moreRaces = isGp && this.gpRace < 3;
    tryCall(this.game.hud, 'setVisible', false);
    this.results.show(rows, {
      title: isGp ? `RACE ${this.gpRace + 1} RESULTS` : 'RESULTS',
      standings,
      nextLabel: moreRaces ? 'NEXT RACE' : 'FINISH',
      onNext: () => {
        this.results.hide();
        if (moreRaces) {
          this.gpRace++;
          this.trackIndex = (this.trackIndex + 1) % TRACKS.length;
          this.startRace();
        } else {
          this.gpRace = 0;
          this.standings.clear();
          this.show('main');
        }
      },
      onRetry: () => { this.results.hide(); this.startRace(); },
      onQuit: () => { this.results.hide(); this.quitToMenu(); },
      vfx: probe<unknown>(this.game, 'vfx'),
    });
  }

  // =====================================================================
  // Focus + input
  // =====================================================================

  private setFocus(i: number, immediate = false): void {
    const s = this.current;
    if (!s || s.items.length === 0) return;
    const n = clamp(i, 0, s.items.length - 1);
    const changed = n !== s.index;
    s.index = n;
    for (let j = 0; j < s.items.length; j++) {
      const it = s.items[j];
      const on = j === n;
      if (it.el.classList.contains('ak-card')) setClass(it.el, 'ak-card--focus', on);
      else setClass(it.el, 'ak-item-row--focus', on);
    }
    if (s.ring) {
      const target = s.items[n].el;
      // MEASURE THE ROW WE ARE MOVING TO, EVERY TIME. The height used to be
      // cached from whichever row was focused first, and the rows are not all
      // the same height — a slider row on OPTIONS is 43.7px against a plain
      // row's 27.7px at 800x450, so the travelling highlight was 16px short of
      // every slider it landed on. `offsetHeight`/`offsetTop` on purpose: they
      // are the row's LAYOUT box, so they are not disturbed by the focus
      // transform that is still mid-transition while this runs.
      const h = target.offsetHeight;
      if (h !== s.ringHeight) {
        s.ringHeight = h;
        s.ring.style.height = `${h}px`;
      }
      // Only the Y offset comes from here: `.ak-list__focus` composes it with the
      // row's own lift and pop in CSS (`--ak-row-lift` / `--ak-row-pop`), so the
      // slab cannot drift out of register with the row again.
      s.ring.style.setProperty('--ak-ring-y', `${target.offsetTop}px`);
      s.ring.style.transition = immediate ? 'none' : 'transform 320ms cubic-bezier(.16,1,.3,1)';
      setClass(s.ring, 'ak-list__focus--on', true);
    }
    s.onFocus?.(n);
    if (changed && !immediate) this.audio?.play?.('ui_move');
  }

  private move(dx: number, dy: number): void {
    const s = this.current;
    if (!s) return;
    const cols = Math.max(1, s.cols);
    if (cols === 1) {
      const d = dy !== 0 ? dy : dx;
      const n = s.index + d;
      this.setFocus((n + s.items.length) % s.items.length);
      return;
    }
    let n = s.index;
    if (dx !== 0) {
      const row = Math.floor(n / cols);
      const rowStart = row * cols;
      const rowEnd = Math.min(s.items.length, rowStart + cols) - 1;
      n = n + dx;
      if (n < rowStart) n = rowEnd;
      if (n > rowEnd) n = rowStart;
    } else if (dy !== 0) {
      n = n + dy * cols;
      if (n < 0) n = (n % cols + cols) % cols + Math.floor((s.items.length - 1) / cols) * cols;
      if (n >= s.items.length) n = n % cols;
      if (n >= s.items.length) n = s.items.length - 1;
    }
    this.setFocus(n);
  }

  private activate(): void {
    const s = this.current;
    if (!s || !s.items.length) return;
    const it = s.items[s.index];
    if (it.disabled) return;
    punch(it.el, 0.55, 300, it.el.classList.contains('ak-card') ? 'translateY(calc(-8 * var(--u)))' : '');
    this.audio?.play?.('ui_select');
    it.onSelect?.();
  }

  private back(): void {
    const s = this.current;
    if (!s) return;
    this.audio?.play?.('ui_back');
    s.onBack?.();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.results.visible) return;    // Results owns the keyboard while up.

    if (!this.current) {
      if (e.code === 'Escape' || e.code === 'KeyP') {
        e.preventDefault();
        this.showPause();
      }
      return;
    }

    switch (e.code) {
      case 'ArrowUp': case 'KeyW': this.move(0, -1); e.preventDefault(); break;
      case 'ArrowDown': case 'KeyS': this.move(0, 1); e.preventDefault(); break;
      case 'ArrowLeft': case 'KeyA': this.adjustOrMove(-1); e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD': this.adjustOrMove(1); e.preventDefault(); break;
      case 'Enter': case 'Space': case 'KeyE': this.activate(); e.preventDefault(); break;
      case 'Escape': case 'Backspace': this.back(); e.preventDefault(); break;
      default: break;
    }
  };

  private adjustOrMove(dir: number): void {
    const s = this.current;
    if (!s) return;
    const it = s.items[s.index];
    if (it?.onAdjust && s.cols === 1) { it.onAdjust(dir); return; }
    this.move(dir, 0);
  }

  // --- gamepad ------------------------------------------------------------

  private startTicker(): void {
    if (this.rafId) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.pollPad();
      this.pollRaceState();
    };
    this.rafId = requestAnimationFrame(tick);
    // `requestAnimationFrame` is throttled to ~0.5 Hz in a background tab and
    // can stall for whole seconds while shaders compile. A menu left on screen
    // over a live race is the worst failure mode here, so the race-phase watch
    // gets a timer of its own that does not depend on the frame loop.
    if (!this.watchId) {
      this.watchId = window.setInterval(() => this.pollRaceState(), 200);
    }
  }

  private stopTicker(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.watchId) {
      window.clearInterval(this.watchId);
      this.watchId = 0;
    }
  }

  private pollPad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    let pad: Gamepad | null = null;
    for (const p of pads) if (p) { pad = p; break; }
    if (!pad) return;

    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const dx = (pad.buttons[15]?.pressed ? 1 : 0) - (pad.buttons[14]?.pressed ? 1 : 0)
      + (Math.abs(ax) > 0.55 ? Math.sign(ax) : 0);
    const dy = (pad.buttons[13]?.pressed ? 1 : 0) - (pad.buttons[12]?.pressed ? 1 : 0)
      + (Math.abs(ay) > 0.55 ? Math.sign(ay) : 0);
    const a = !!pad.buttons[0]?.pressed;
    const b = !!pad.buttons[1]?.pressed;
    const start = !!pad.buttons[9]?.pressed;

    const now = performance.now();
    const moved = dx !== 0 || dy !== 0;
    const edgeMove = moved && (this.padPrev.x === 0 && this.padPrev.y === 0);
    const repeatOk = moved && now - this.padRepeat > 190;

    if (this.results.visible) {
      if (edgeMove) this.results.navigate(Math.sign(dx), false, false);
      if (a && !this.padPrev.a) this.results.navigate(0, true, false);
      if (b && !this.padPrev.b) this.results.navigate(0, false, true);
    } else if (this.current) {
      if (edgeMove || repeatOk) {
        this.padRepeat = now;
        if (dx !== 0 && this.current.cols === 1) this.adjustOrMove(Math.sign(dx));
        else this.move(Math.sign(dx), Math.sign(dy));
      }
      if (a && !this.padPrev.a) this.activate();
      if (b && !this.padPrev.b) this.back();
    } else if (start && !this.padPrev.start) {
      this.showPause();
    }

    this.padPrev.x = dx; this.padPrev.y = dy;
    this.padPrev.a = a; this.padPrev.b = b; this.padPrev.start = start;
  }

  // =====================================================================
  // Lifecycle
  // =====================================================================

  update(ctx: FrameContext): void {
    // Menus are event-driven; the internal ticker handles gamepad polling so
    // the UI stays live even when the engine loop is paused.
    void ctx;
  }

  private onResize = (): void => {
    applyUiScale(window.innerWidth, window.innerHeight);
    // Recompute the focus-ring geometry on the next focus write.
    for (const s of this.screens.values()) s.ringHeight = 0;
    if (this.current) this.setFocus(this.current.index, true);
  };

  resize(width: number, height: number): void {
    applyUiScale(width, height);
    for (const s of this.screens.values()) s.ringHeight = 0;
    if (this.current) this.setFocus(this.current.index, true);
  }

  /** Currently visible screen id, or null when the menus are hidden. */
  get screen(): ScreenId | null { return this.current?.id ?? null; }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    this.stopTicker();
    this.results?.dispose();
    this.root?.remove();
    this.built = false;
  }
}
