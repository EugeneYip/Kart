/**
 * ============================================================================
 *  FOXY KART — UI TYPOGRAPHY
 * ============================================================================
 *  No downloaded fonts (AGENTS.md rule 3: zero network requests). The whole
 *  look comes from a heavy system stack plus CSS: 900 weight, negative
 *  tracking, a layered stroke behind a gradient fill.
 *
 *  The signature element is the "chunky numeral": two stacked copies of the
 *  same glyphs — the lower one carries a fat dark `-webkit-text-stroke` plus a
 *  drop shadow, the upper one a `background-clip:text` gradient. You cannot get
 *  both from one element because `text-shadow` paints over a clipped
 *  background, which is exactly why MK8-style outlined numerals are usually
 *  faked with images. This does it in two spans and stays crisp at any DPI.
 *
 *  Importing this module also pulls in `ui.css` — every UI entry point imports
 *  Fonts, so the stylesheet is guaranteed present exactly once.
 * ============================================================================
 */

import './ui.css';

/** Heavy, wide-coverage system stack. Never fetched — always already resident. */
export const FONT_STACK =
  'system-ui, -apple-system, "SF Pro Display", "Segoe UI Variable Display", ' +
  '"Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';

export const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export type NumeralTone = 'white' | 'gold' | 'blue' | 'red' | 'green' | 'orange' | 'purple';

export interface NumeralOptions {
  tone?: NumeralTone;
  /** Adds the moulded-plastic highlight across the top third. Default true. */
  bevel?: boolean;
  /** Extra classes for sizing (e.g. `ak-pos__digits`). */
  className?: string;
}

const TONE_CLASS: Record<NumeralTone, string> = {
  white: '',
  gold: 'ak-num--gold',
  blue: 'ak-num--blue',
  red: 'ak-num--red',
  green: 'ak-num--green',
  orange: 'ak-num--orange',
  purple: 'ak-num--purple',
};

/**
 * Build the game's signature chunky outlined numeral / word.
 * Use for position, lap, countdown, speed, logotype — anything that must read
 * at a glance at 200 km/h.
 */
export function numeral(text: string, opts: NumeralOptions = {}): HTMLSpanElement {
  const root = document.createElement('span');
  root.className = 'ak-num';
  if (opts.bevel !== false) root.classList.add('ak-num--bevel');
  const tone = TONE_CLASS[opts.tone ?? 'white'];
  if (tone) root.classList.add(tone);
  if (opts.className) root.className += ` ${opts.className}`;

  // ONLY THE FILL LAYER OWNS A TEXT NODE. The stroke layer paints the same
  // string from `data-text` via `.ak-num__stroke::before { content: attr(...) }`,
  // because generated content is not part of the document's text. Two real
  // copies is what made every heading read twice — `textContent` on the main
  // menu's title returned "MAIN MENUMAIN MENU" (and `innerText` "MAIN MENU\nMAIN
  // MENU") even though the two layers paint at the same rect, so a page-text
  // dump, a screen reader or any text assertion saw the doubling on all nine
  // screens. `aria-hidden` alone did not fix that; not being text does.
  const stroke = document.createElement('i');
  stroke.className = 'ak-num__stroke';
  stroke.setAttribute('aria-hidden', 'true');
  stroke.dataset.text = text;

  const fill = document.createElement('i');
  fill.className = 'ak-num__fill';
  fill.textContent = text;

  root.append(stroke, fill);
  return root;
}

/** Update both layers of a numeral. Cheap; skips the write when unchanged. */
export function setNumeralText(root: HTMLElement, text: string): void {
  const stroke = root.firstElementChild as HTMLElement | null;
  const fill = root.lastElementChild;
  if (!stroke || !fill) return;
  if (stroke.dataset.text === text) return;
  stroke.dataset.text = text;
  fill.textContent = text;
}

/** Swap the gradient tone without rebuilding the element. */
export function setNumeralTone(root: HTMLElement, tone: NumeralTone): void {
  const want = TONE_CLASS[tone];
  for (const t of Object.values(TONE_CLASS)) {
    if (t && t !== want) root.classList.remove(t);
  }
  if (want) root.classList.add(want);
}

// ---------------------------------------------------------------------------
// Number / time formatting
// ---------------------------------------------------------------------------

/** "ST" / "ND" / "RD" / "TH" — English ordinals with the 11–13 exception. */
export function ordinalSuffix(n: number): string {
  const a = Math.abs(Math.trunc(n)) % 100;
  if (a >= 11 && a <= 13) return 'TH';
  switch (a % 10) {
    case 1: return 'ST';
    case 2: return 'ND';
    case 3: return 'RD';
    default: return 'TH';
  }
}

/** `4` → `"4TH"`. */
export function formatOrdinal(n: number): string {
  return `${Math.trunc(n)}${ordinalSuffix(n)}`;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const pad3 = (n: number) => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`);

/** Race clock: `1'23"456`, the Mario Kart convention. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return `0'00"000`;
  const total = Math.floor(seconds * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000);
  return `${m}'${pad2(s)}"${pad3(ms)}`;
}

/** Compact clock without milliseconds: `1:23`. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const t = Math.floor(seconds);
  return `${Math.floor(t / 60)}:${pad2(t % 60)}`;
}

/** Signed split against a reference lap: `+0"412` / `-1"083`. */
export function formatDelta(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  const sign = seconds >= 0 ? '+' : '-';
  const a = Math.abs(seconds);
  const total = Math.floor(a * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000);
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${sign}${m}'${pad2(s % 60)}"${pad3(ms)}`;
  }
  return `${sign}${s}"${pad3(ms)}`;
}

/** Gap to a rival, in seconds: `+1.4s`. */
export function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--';
  const a = Math.min(99.9, Math.abs(seconds));
  return `${a < 10 ? a.toFixed(1) : a.toFixed(0)}s`;
}

/** Stat bars read `3.5` in MK8 — halves, never noisy decimals. */
export function formatStat(v: number): string {
  const half = Math.round(v * 2) / 2;
  return Number.isInteger(half) ? `${half}.0` : half.toFixed(1);
}
