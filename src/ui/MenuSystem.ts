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
 *  Nothing here assumes the rest of the game exists. Portraits, kart thumbs and
 *  track previews are generated procedurally at init; if `game.karts` later
 *  exposes a real portrait renderer it is used instead. Audio, camera modes,
 *  quality and pause hooks are all feature-detected.
 * ============================================================================
 */

import { bus } from '@/core/EventBus';
import type { FrameContext, ISubsystem, QualityTier } from '@/core/Types';
import { clamp } from '@/core/MathUtils';
import { formatStat, numeral, setNumeralText } from './Fonts';
import { Results } from './Results';
import type { ResultRow, StandingRow } from './Results';
import {
  applyUiScale, characterPortrait, el, kartThumb, probe, proceduralLoop, punch,
  setClass, setText, trackPreview, tryCall,
} from './Widgets';
import type { AudioLike, GameLike } from './Widgets';

// ===========================================================================
// Roster / catalogue data (local until the karts subsystem publishes its own)
// ===========================================================================

export interface StatBlock {
  speed: number; accel: number; weight: number;
  handling: number; traction: number; turbo: number;
}

export interface CharacterDef {
  id: string; name: string; colorA: string; colorB: string; stats: StatBlock;
}

export interface KartBodyDef {
  id: string; name: string; colorA: string; colorB: string;
  deltas: Partial<StatBlock>; tag: string;
}

export interface TrackDef {
  id: string; name: string; themeA: string; themeB: string; road: string;
  difficulty: number; lengthKm: number; laps: number; seed: number; tag: string;
}

const STAT_KEYS: ReadonlyArray<keyof StatBlock> = [
  'speed', 'accel', 'weight', 'handling', 'traction', 'turbo',
];
const STAT_LABEL: Record<keyof StatBlock, string> = {
  speed: 'SPEED', accel: 'ACCEL', weight: 'WEIGHT',
  handling: 'HANDLING', traction: 'TRACTION', turbo: 'MINI-TURBO',
};

export const CHARACTERS: readonly CharacterDef[] = [
  { id: 'blaze', name: 'Blaze', colorA: '#ff6a3d', colorB: '#b81616', stats: { speed: 3.75, accel: 3.25, weight: 3.5, handling: 3.25, traction: 3.0, turbo: 3.5 } },
  { id: 'nova', name: 'Nova', colorA: '#5ad2ff', colorB: '#1b4fd6', stats: { speed: 3.25, accel: 4.0, weight: 2.75, handling: 4.0, traction: 3.5, turbo: 4.0 } },
  { id: 'pixel', name: 'Pixel', colorA: '#9bff5c', colorB: '#159b3f', stats: { speed: 2.75, accel: 4.75, weight: 2.0, handling: 4.5, traction: 4.0, turbo: 4.75 } },
  { id: 'brutus', name: 'Brutus', colorA: '#ffb03a', colorB: '#8a4a05', stats: { speed: 4.75, accel: 2.25, weight: 4.75, handling: 2.25, traction: 2.5, turbo: 2.25 } },
  { id: 'zephyr', name: 'Zephyr', colorA: '#c69bff', colorB: '#5b21b6', stats: { speed: 3.5, accel: 3.5, weight: 3.0, handling: 3.75, traction: 3.25, turbo: 3.75 } },
  { id: 'iris', name: 'Iris', colorA: '#ff8ad1', colorB: '#c01f7a', stats: { speed: 3.0, accel: 4.25, weight: 2.5, handling: 4.25, traction: 3.75, turbo: 4.25 } },
  { id: 'orion', name: 'Orion', colorA: '#e8eef8', colorB: '#5c6b86', stats: { speed: 4.25, accel: 2.75, weight: 4.25, handling: 2.75, traction: 2.75, turbo: 2.75 } },
  { id: 'mako', name: 'Mako', colorA: '#45f0ff', colorB: '#0b6f8c', stats: { speed: 4.0, accel: 3.0, weight: 3.75, handling: 3.0, traction: 3.25, turbo: 3.25 } },
];

export const KART_BODIES: readonly KartBodyDef[] = [
  { id: 'standard', name: 'Standard', colorA: '#e9f1ff', colorB: '#7f95b8', tag: 'BALANCED', deltas: {} },
  { id: 'speedster', name: 'Speedster', colorA: '#ff5252', colorB: '#8a0f0f', tag: 'TOP SPEED', deltas: { speed: 0.75, accel: -0.5, handling: -0.25, turbo: -0.25 } },
  { id: 'buggy', name: 'Dune Buggy', colorA: '#ffd447', colorB: '#a86b05', tag: 'OFF-ROAD', deltas: { traction: 0.75, accel: 0.25, speed: -0.5 } },
  { id: 'hauler', name: 'Heavy Hauler', colorA: '#8fa5c4', colorB: '#33445e', tag: 'HEAVYWEIGHT', deltas: { weight: 1.0, speed: 0.25, accel: -0.5, handling: -0.5 } },
  { id: 'glider', name: 'Glider GT', colorA: '#7ee8ff', colorB: '#1560a8', tag: 'AIR TIME', deltas: { handling: 0.5, turbo: 0.5, weight: -0.5 } },
  { id: 'drifter', name: 'Drifter', colorA: '#b46bff', colorB: '#4c1d95', tag: 'DRIFT KING', deltas: { turbo: 1.0, handling: 0.5, speed: -0.25, traction: -0.25 } },
];

export const TRACKS: readonly TrackDef[] = [
  { id: 'sunset', name: 'Sunset Circuit', themeA: '#ff9a4d', themeB: '#a33b6f', road: '#f2f6ff', difficulty: 1, lengthKm: 1.9, laps: 3, seed: 7, tag: 'RESORT' },
  { id: 'harbor', name: 'Neon Harbor', themeA: '#2b3fa8', themeB: '#0d1233', road: '#dfe9ff', difficulty: 2, lengthKm: 2.3, laps: 3, seed: 13, tag: 'NIGHT CITY' },
  { id: 'canyon', name: 'Canyon Rush', themeA: '#ffb35c', themeB: '#6b2b12', road: '#f6ead7', difficulty: 3, lengthKm: 2.6, laps: 3, seed: 23, tag: 'DESERT' },
];

const CC_OPTIONS = [50, 100, 150, 200] as const;
const QUALITY_ORDER: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];
/** MK8's points table, trimmed to the grid size in play. */
const POINTS = [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

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
  private kartArt: string[] = [];
  private trackArt: string[] = [];

  // --- input -------------------------------------------------------------
  private rafId = 0;
  /** Frame-loop-independent race-phase watch — see `startTicker`. */
  private watchId = 0;
  private padPrev = { x: 0, y: 0, a: false, b: false, start: false };
  private padRepeat = 0;
  private statBars: Array<{ row: HTMLDivElement; fill: HTMLElement; value: HTMLElement }> = [];
  private kartStatBars: Array<{ row: HTMLDivElement; fill: HTMLElement; value: HTMLElement }> = [];
  private optionRefresh: Array<() => void> = [];
  private charName!: HTMLElement;
  private kartName!: HTMLElement;
  private trackName!: HTMLElement;
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

  private buildArt(): void {
    for (const c of CHARACTERS) {
      const fromKarts = tryCall<unknown>(this.game.karts, 'renderPortrait', c.id, 220);
      let url = '';
      if (typeof fromKarts === 'string') url = fromKarts;
      else if (fromKarts instanceof HTMLCanvasElement) {
        try { url = fromKarts.toDataURL('image/png'); } catch { url = ''; }
      }
      if (!url) {
        try { url = characterPortrait(c.name, c.colorA, c.colorB, 220).toDataURL('image/png'); }
        catch { url = ''; }
      }
      this.portraits.push(url);
    }
    for (const k of KART_BODIES) {
      try { this.kartArt.push(kartThumb(k.colorA, k.colorB, 240, 180).toDataURL('image/png')); }
      catch { this.kartArt.push(''); }
    }
    const livePath = tryCall<readonly { x: number; y: number }[]>(this.game.track, 'getMinimapPath');
    for (let i = 0; i < TRACKS.length; i++) {
      const t = TRACKS[i];
      const path = i === 0 && livePath && livePath.length > 8 ? livePath : proceduralLoop(t.seed);
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
    const s = this.makeScreen('chars', 4);
    this.head(s.root, 'CHOOSE YOUR RACER', 'STATS UPDATE AS YOU BROWSE');

    const grid = el('div', 'ak-grid ak-grid--chars ak-stagger', s.root);
    grid.style.setProperty('--d', '120ms');
    for (let i = 0; i < CHARACTERS.length; i++) {
      const c = CHARACTERS[i];
      const card = el('div', 'ak-card ak-card--char', grid);
      const art = el('div', 'ak-card__art', card);
      if (this.portraits[i]) art.style.backgroundImage = `url("${this.portraits[i]}")`;
      art.style.backgroundSize = 'cover';
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
    this.statBars = this.buildStatRows(panel);
    this.hints(s.root, [['ENTER', 'CONFIRM'], ['ESC', 'BACK']], 380);

    s.onFocus = (i) => { this.charIndex = i; this.paintCharStats(); };
    s.onShow = () => { s.index = this.charIndex; this.paintCharStats(); };
    s.onBack = () => this.show('main');
  }

  private buildStatRows(panel: HTMLElement): Array<{ row: HTMLDivElement; fill: HTMLElement; value: HTMLElement }> {
    const out: Array<{ row: HTMLDivElement; fill: HTMLElement; value: HTMLElement }> = [];
    for (const k of STAT_KEYS) {
      const row = el('div', 'ak-stat', panel);
      el('div', 'ak-stat__k', row, STAT_LABEL[k]);
      const bar = el('div', 'ak-stat__bar', row);
      const fill = el('i', undefined, bar);
      const value = el('div', 'ak-stat__v', row, '0.0');
      out.push({ row, fill, value });
    }
    return out;
  }

  private paintStats(
    bars: Array<{ row: HTMLDivElement; fill: HTMLElement; value: HTMLElement }>,
    stats: StatBlock, deltas?: Partial<StatBlock>,
  ): void {
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const k = STAT_KEYS[i];
      const base = stats[k];
      const d = deltas?.[k] ?? 0;
      const v = clamp(base + d, 0, 5);
      const bar = bars[i];
      bar.fill.style.transform = `scaleX(${(v / 5).toFixed(3)})`;
      setText(bar.value, formatStat(v));
      setClass(bar.row, 'ak-stat--delta-up', d > 0);
      setClass(bar.row, 'ak-stat--delta-down', d < 0);
    }
  }

  private paintCharStats(): void {
    const c = CHARACTERS[this.charIndex];
    setText(this.charName, c.name.toUpperCase());
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
    this.paintStats(this.kartStatBars, c.stats, k.deltas);
  }

  // --- track select ------------------------------------------------------

  private buildTracks(): void {
    const s = this.makeScreen('tracks', 3);
    this.head(s.root, 'SELECT A COURSE', 'THREE CIRCUITS');

    const grid = el('div', 'ak-grid ak-grid--tracks ak-stagger', s.root);
    grid.style.setProperty('--d', '120ms');
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
      el('div', 'ak-card__name', card, `${t.name.toUpperCase()}  ·  ${t.lengthKm.toFixed(1)} KM`);
      const idx = s.items.length;
      s.items.push({ el: card, onSelect: () => { this.trackIndex = i; this.show('cc'); } });
      card.addEventListener('click', () => { this.setFocus(idx); this.activate(); });
      card.addEventListener('pointerenter', () => this.setFocus(idx));
    }
    this.trackName = el('div', 'ak-stats__name ak-stagger', s.root, '');
    (this.trackName as HTMLElement).style.setProperty('--d', '240ms');
    this.hints(s.root, [['ENTER', 'CONFIRM'], ['ESC', 'BACK']], 340);

    s.onFocus = (i) => { this.trackIndex = i; this.paintTrackName(); };
    s.onShow = () => { s.index = this.trackIndex; this.paintTrackName(); };
    s.onBack = () => this.show('karts');
  }

  private paintTrackName(): void {
    const t = TRACKS[this.trackIndex];
    const diff = ['EASY', 'MEDIUM', 'HARD'][clamp(t.difficulty - 1, 0, 2)];
    setText(this.trackName, `${t.name.toUpperCase()}  —  ${diff}  ·  ${t.laps} LAPS  ·  ${t.lengthKm.toFixed(1)} KM`);
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
    setClass(this.scrim, 'ak-scrim--on', true);
    setClass(this.scrim, 'ak-scrim--blur', blur);
    setClass(this.root, 'ak-menus--active', true);
    // A lap counter and a speedometer behind the logo reads as a bug. The HUD
    // gates itself on this plus the race phase.
    tryCall(this.game.hud, 'setMenuActive', true);
    this.titleBg.style.display = id === 'title' || id === 'main' ? 'block' : 'none';
    this.titleBg.style.opacity = this.hasCinematicCamera() ? '0.45' : '1';
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
      const name = isPlayer
        ? CHARACTERS[this.charIndex].name
        : (tryCall<string>(this.game.karts, 'getName', r.kartId) ?? `Racer ${r.kartId + 1}`);
      rows.push({
        kartId: r.kartId,
        position: r.position,
        name,
        time: r.time,
        bestLap: best,
        points: this.mode === 'gp' ? pts : undefined,
        isPlayer,
        color: CHARACTERS[r.kartId % CHARACTERS.length].colorA,
        portrait: isPlayer ? this.portraits[this.charIndex] : this.portraits[r.kartId % this.portraits.length],
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
      if (!s.ringHeight) {
        s.ringHeight = target.offsetHeight;
        s.ring.style.height = `${s.ringHeight}px`;
      }
      const top = target.offsetTop;
      s.ring.style.transform = `translateY(${top}px)`;
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
