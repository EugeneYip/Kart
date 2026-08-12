/**
 * ============================================================================
 *  FOXY KART — POST-RACE RESULTS
 * ============================================================================
 *  A staggered results table (one row every 90 ms), a podium for the top three,
 *  Grand Prix standings, and Next / Retry / Quit. The player's row gets a gold
 *  plate with a repeating specular sweep.
 *
 *  Confetti is delegated to VFX when it exposes a hook, otherwise it falls back
 *  to the CSS particle rain in `ui.css`.
 * ============================================================================
 */

import { confetti, el, punch, setClass, tryCall } from './Widgets';
import type { AudioLike } from './Widgets';
import { formatTime, numeral, setNumeralText, setNumeralTone } from './Fonts';

export interface ResultRow {
  kartId: number;
  position: number;
  name: string;
  /** Total race time, seconds. */
  time: number;
  bestLap?: number;
  /** Points awarded for this race. */
  points?: number;
  isPlayer?: boolean;
  color?: string;
  /** Data URL / object URL for a portrait. */
  portrait?: string;
}

export interface StandingRow {
  kartId: number;
  name: string;
  points: number;
  isPlayer?: boolean;
  color?: string;
}

export interface ResultsOptions {
  title?: string;
  standings?: readonly StandingRow[];
  nextLabel?: string;
  onNext?: () => void;
  onRetry?: () => void;
  onQuit?: () => void;
  /** VFX service, if it can throw confetti for us. */
  vfx?: unknown;
}

const ROW_STAGGER_MS = 95;

export class Results {
  readonly el: HTMLDivElement;
  private audio: AudioLike | null = null;

  private confettiBox: HTMLDivElement;
  private inner: HTMLDivElement;
  private title: HTMLElement;
  private podium: HTMLDivElement;
  private table: HTMLDivElement;
  private standBox: HTMLDivElement;
  private standTitle: HTMLDivElement;
  private stand: HTMLDivElement;
  private buttons: HTMLDivElement;

  private btns: HTMLDivElement[] = [];
  private actions: Array<(() => void) | undefined> = [];
  private focus = 0;
  private shown = false;
  private timers: number[] = [];

  constructor(container: HTMLElement, audio?: AudioLike | null) {
    this.audio = audio ?? null;
    this.el = el('div', 'ak-results');
    this.confettiBox = el('div', 'ak-confetti', this.el);
    // Everything measurable lives in ONE inner column, so `ui.css` can centre it
    // with `margin: auto 0` instead of `justify-content: center`. Auto margins
    // collapse to zero when there is no free space, whereas centring an
    // over-tall column pushes half the overflow off the TOP of the frame — which
    // is exactly how the title, the whole podium and the first table row left
    // the screen on the Grand Prix board.
    this.inner = el('div', 'ak-results__inner', this.el);
    this.title = numeral('RESULTS', { tone: 'gold', className: 'ak-results__title' });
    this.inner.appendChild(this.title);
    this.podium = el('div', 'ak-podium', this.inner);
    this.table = el('div', 'ak-results__table', this.inner);
    this.standBox = el('div', 'ak-stand-wrap', this.inner);
    this.standTitle = el('div', 'ak-stand__head', this.standBox, 'GRAND PRIX STANDINGS');
    this.stand = el('div', 'ak-stand', this.standBox);
    this.buttons = el('div', 'ak-buttons', this.inner);
    container.appendChild(this.el);
  }

  setAudio(audio: AudioLike): void { this.audio = audio; }

  get visible(): boolean { return this.shown; }

  // -----------------------------------------------------------------------

  show(rows: readonly ResultRow[], opts: ResultsOptions = {}): void {
    this.clearTimers();
    const sorted = [...rows].sort((a, b) => a.position - b.position);
    const player = sorted.find((r) => r.isPlayer);

    // Through `setNumeralText`, never by writing the two layers here: the stroke
    // layer is a `data-text` attribute now (it carries no text node, so a heading
    // is not in the document twice) and hand-writing `textContent` into it would
    // give it BOTH a text node and the generated copy — i.e. the title painted
    // twice, side by side, out of its own box.
    setNumeralText(this.title, opts.title ?? 'RESULTS');
    setNumeralTone(this.title, player && player.position === 1 ? 'gold' : 'blue');

    // --- podium ---------------------------------------------------------
    this.podium.replaceChildren();
    const order = [1, 0, 2]; // 2nd, 1st, 3rd — the classic silhouette
    const heights = ['62%', '100%', '48%'];
    for (let i = 0; i < order.length; i++) {
      const r = sorted[order[i]];
      if (!r) continue;
      const col = el('div', `ak-podium__col ak-podium__col--${r.position}`, this.podium);
      col.style.height = heights[i];
      col.style.animationDelay = `${260 + i * 110}ms`;
      const art = el('div', 'ak-podium__art', col);
      if (r.portrait) {
        art.style.backgroundImage = `url("${r.portrait}")`;
        art.style.backgroundSize = 'cover';
      } else {
        art.style.background = `linear-gradient(180deg, #ffffff, ${r.color ?? '#6f8fc0'})`;
      }
      const posNum = numeral(String(r.position), {
        tone: r.position === 1 ? 'gold' : 'white', className: 'ak-podium__pos',
      });
      col.appendChild(posNum);
      el('div', 'ak-podium__name', col, r.name.toUpperCase());
    }

    // --- table ----------------------------------------------------------
    this.table.replaceChildren();
    const head = el('div', 'ak-rrow ak-rrow--head', this.table);
    el('span', undefined, head, 'POS');
    el('span', undefined, head, '');
    el('span', undefined, head, 'RACER');
    el('span', undefined, head, 'TOTAL');
    // 'BEST LAP' at the legibility floor is wider than its `--u`-sized column on
    // a short viewport, and wrapping it doubled the header row's height.
    el('span', undefined, head, 'BEST');
    el('span', undefined, head, 'PTS');

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const row = el('div', `ak-rrow${r.isPlayer ? ' ak-rrow--player' : ''}`, this.table);
      const posNum = numeral(String(r.position), {
        tone: r.position === 1 ? 'gold' : r.position <= 3 ? 'blue' : 'white',
        className: 'ak-rrow__pos',
      });
      row.appendChild(posNum);
      const art = el('div', 'ak-rrow__art', row);
      if (r.portrait) {
        art.style.backgroundImage = `url("${r.portrait}")`;
        art.style.backgroundSize = 'cover';
      } else {
        art.style.background = `linear-gradient(180deg, #ffffff, ${r.color ?? '#6f8fc0'})`;
      }
      el('div', 'ak-rrow__name', row, r.name.toUpperCase());
      el('div', 'ak-rrow__time', row, r.time > 0 ? formatTime(r.time) : '—');
      el('div', 'ak-rrow__best', row, r.bestLap && r.bestLap > 0 ? formatTime(r.bestLap) : '—');
      el('div', 'ak-rrow__pts', row, r.points !== undefined ? `+${r.points}` : '');

      const t = window.setTimeout(() => {
        row.classList.add('ak-rrow--in');
        this.audio?.play?.(r.isPlayer ? 'ui_result_player' : 'ui_result_row');
      }, 420 + i * ROW_STAGGER_MS);
      this.timers.push(t);
    }

    // --- standings ------------------------------------------------------
    const standings = opts.standings ?? [];
    this.standBox.style.display = standings.length ? 'flex' : 'none';
    this.stand.replaceChildren();
    if (standings.length) {
      const ranked = [...standings].sort((a, b) => b.points - a.points);
      for (let i = 0; i < ranked.length; i++) {
        const s = ranked[i];
        const chip = el('div', `ak-stand__chip${s.isPlayer ? ' ak-stand__chip--player' : ''}`, this.stand);
        el('span', 'ak-stand__pos', chip, `${i + 1}`);
        const dot = el('span', 'ak-stand__dot', chip);
        dot.style.background = s.color ?? '#8fb4e6';
        el('span', 'ak-stand__name', chip, s.name.toUpperCase());
        el('span', 'ak-stand__pts', chip, String(s.points));
        chip.classList.add('ak-stagger');
        chip.style.setProperty('--d', `${900 + i * 55}ms`);
      }
      void this.stand.offsetWidth;
      this.stand.classList.add('ak-in');
    }

    // --- buttons --------------------------------------------------------
    this.buttons.replaceChildren();
    this.btns.length = 0;
    this.actions.length = 0;
    const defs: Array<[string, (() => void) | undefined]> = [
      [opts.nextLabel ?? 'NEXT RACE', opts.onNext],
      ['RETRY', opts.onRetry],
      ['QUIT', opts.onQuit],
    ];
    for (const [label, fn] of defs) {
      if (!fn) continue;
      const b = el('div', 'ak-btn', this.buttons, label);
      b.addEventListener('click', () => this.activate(this.btns.indexOf(b)));
      b.addEventListener('pointerenter', () => this.setFocus(this.btns.indexOf(b)));
      this.btns.push(b);
      this.actions.push(fn);
    }
    this.focus = 0;
    this.paintFocus();

    // --- confetti for a win ---------------------------------------------
    if (player && player.position === 1) {
      const delegated = tryCall<unknown>(opts.vfx, 'confetti')
        ?? tryCall<unknown>(opts.vfx, 'burst', 'confetti');
      if (delegated === undefined) confetti(this.confettiBox, 110);
      this.audio?.play?.('ui_win');
    } else {
      this.confettiBox.replaceChildren();
      this.audio?.play?.('ui_results');
    }

    this.shown = true;
    setClass(this.el, 'ak-results--on', true);
    window.addEventListener('keydown', this.onKey);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.clearTimers();
    setClass(this.el, 'ak-results--on', false);
    window.removeEventListener('keydown', this.onKey);
    this.confettiBox.replaceChildren();
  }

  // -----------------------------------------------------------------------

  private clearTimers(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.length = 0;
  }

  private setFocus(i: number): void {
    if (i < 0 || i >= this.btns.length || i === this.focus) return;
    this.focus = i;
    this.paintFocus();
    this.audio?.play?.('ui_move');
  }

  private paintFocus(): void {
    for (let i = 0; i < this.btns.length; i++) {
      setClass(this.btns[i], 'ak-btn--focus', i === this.focus);
    }
  }

  private activate(i: number): void {
    if (i < 0 || i >= this.actions.length) return;
    const fn = this.actions[i];
    punch(this.btns[i], 0.8, 300);
    this.audio?.play?.('ui_select');
    fn?.();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.shown) return;
    switch (e.code) {
      case 'ArrowRight': case 'KeyD':
        this.setFocus(Math.min(this.btns.length - 1, this.focus + 1)); e.preventDefault(); break;
      case 'ArrowLeft': case 'KeyA':
        this.setFocus(Math.max(0, this.focus - 1)); e.preventDefault(); break;
      case 'Enter': case 'Space': case 'KeyE':
        this.activate(this.focus); e.preventDefault(); break;
      case 'Escape':
        this.activate(this.btns.length - 1); e.preventDefault(); break;
      default: break;
    }
  };

  /** Gamepad-driven navigation, forwarded by MenuSystem. */
  navigate(dx: number, confirm: boolean, back: boolean): void {
    if (!this.shown) return;
    if (dx > 0) this.setFocus(Math.min(this.btns.length - 1, this.focus + 1));
    else if (dx < 0) this.setFocus(Math.max(0, this.focus - 1));
    if (confirm) this.activate(this.focus);
    else if (back) this.activate(this.btns.length - 1);
  }

  dispose(): void {
    this.hide();
    this.el.remove();
  }
}
