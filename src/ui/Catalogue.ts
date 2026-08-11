/**
 * ============================================================================
 *  FOXY KART — MENU CATALOGUE  (derived, never authored twice)
 * ============================================================================
 *  The front end used to keep its own hardcoded roster, kart list and track
 *  list. Their ids did not match the game's, and because every lookup on the
 *  game side falls back silently — `makeTuning()` to `DEFAULT_TUNING_ID`,
 *  `getTrackDef()` to `DEFAULT_TRACK` — nothing ever threw:
 *
 *    - 6 of 8 selectable racers resolved to nothing and all drove as Nova;
 *    - the track screen had ZERO ids in common with `TrackDefs`, so every race
 *      loaded Sunset Coastline no matter which card you picked;
 *    - 3 of 6 kart bodies did not exist, and `bike` / `cruiser` were unreachable.
 *
 *  So this module owns exactly one job: turn the *real* tables into the rows the
 *  menu draws. Ids are never retyped here — they are read from
 *  `@/karts/Characters`, `@/karts/KartBodies` and `@/track/TrackDefs`. Anything
 *  that genuinely is editorial (a chassis' stat-delta pitch, a course's
 *  difficulty pips) is keyed BY REAL ID and falls back to something derived, so
 *  a roster or circuit added by another agent still shows up on screen.
 *
 *  `.probe-tmp/menu-ids.ts` is the permanent guard: it asserts every id this
 *  module can emit resolves in `CHARACTERS`, `CHARACTER_STATS`, `KART_BODY_IDS`
 *  and — the one that matters — that `getTrackDef(id).id === id`, because a
 *  fallback that returns *something* is precisely how the track screen died.
 *
 *      node src/dev/node-run.mjs .probe-tmp/menu-ids.ts
 * ============================================================================
 */

import { CHARACTERS as ROSTER, DEFAULT_CHARACTER_ID } from '@/karts/Characters';
import type { CharacterDef as RosterEntry, CharacterStats } from '@/karts/Characters';
import { BODY_NAMES, BODY_TYRE, KART_BODY_IDS } from '@/karts/KartBodies';
import type { KartBodyId } from '@/karts/KartBodies';
import { TRACKS as CIRCUITS, TRACK_ORDER } from '@/track/TrackDefs';
import type { SkyPresetName, TrackDef as CircuitDef, TrackTheme } from '@/track/TrackDefs';

// ===========================================================================
// Presentation types — deliberately NOT the game's types
// ===========================================================================

/**
 * Menu stats are on MK8's 0..5 scale (the bars divide by 5 and `formatStat`
 * rounds to halves). The game's `CharacterStats` are 0..1. `toMenuStats` is the
 * only place that conversion happens.
 */
export interface StatBlock {
  speed: number; accel: number; weight: number;
  handling: number; traction: number; turbo: number;
}

export interface CharacterDef {
  id: string;
  name: string;
  /** Blurb from the roster — shown under the stat panel's name. */
  tagline: string;
  /** CSS paint colours: `colorA` is the body, `colorB` its shade. */
  colorA: string;
  colorB: string;
  /** CSS emissive accent (drift charge / underglow). */
  glow: string;
  /** Chassis this racer ships with — real `KartBodyId`. */
  bodyId: KartBodyId;
  stats: StatBlock;
  /** The game is named after her: Foxy gets a badge on her card. */
  mascot: boolean;
}

export interface KartBodyDef {
  id: KartBodyId;
  name: string;
  colorA: string;
  colorB: string;
  /** Default tyre family for this chassis, from `BODY_TYRE`. */
  tyre: string;
  /** Editorial stat pitch, menu 0..5 units, applied on top of the racer's. */
  deltas: Partial<StatBlock>;
  tag: string;
}

export interface TrackDef {
  id: string;
  name: string;
  subtitle: string;
  /** Preview sky: `themeA` at the top, `themeB` at the horizon. */
  themeA: string;
  themeB: string;
  /** Road ribbon colour of the preview card. */
  road: string;
  /** 1..3 pips. Editorial. */
  difficulty: number;
  /** Derived from the authored centreline, not invented. */
  lengthKm: number;
  /** Real lap count from the circuit. */
  laps: number;
  /** Real `terrainSeed` — also the fallback preview-loop seed. */
  seed: number;
  tag: string;
  /** The circuit's own centreline in XZ, for the preview card. */
  outline: readonly { x: number; y: number }[];
}

// ===========================================================================
// Conversions (written once — every row goes through these)
// ===========================================================================

/** `0xrrggbb` -> `'#rrggbb'`. */
export function cssColor(hex: number): string {
  return `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Rec. 709 relative luminance of a packed hex colour, 0..1. */
function luminance(hex: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Multiply a packed colour toward black. */
function darken(hex: number, k: number): number {
  const r = Math.round(((hex >> 16) & 0xff) * k);
  const g = Math.round(((hex >> 8) & 0xff) * k);
  const b = Math.round((hex & 0xff) * k);
  return (r << 16) | (g << 8) | b;
}

/**
 * The portrait and kart-thumb widgets ramp `colorA -> colorB` expecting a
 * light-to-dark shade pair (helmet highlight to shadow, body to underside).
 * The roster's `secondaryColor` is an *accent*, not a shade, and on half the
 * grid it is lighter than the paint — Foxy's cream, Nova's off-white, Strata's
 * pale blue. Handing those straight to the widget flattens the portrait, so an
 * accent that is not clearly darker is replaced by a shade of the paint itself.
 */
function shadePair(paint: number, accent: number): { colorA: string; colorB: string } {
  const dark = luminance(accent) < luminance(paint) * 0.7 ? accent : darken(paint, 0.4);
  return { colorA: cssColor(paint), colorB: cssColor(dark) };
}

/** Game stats (0..1, `miniTurbo`) -> menu stats (0..5, `turbo`). */
export function toMenuStats(s: CharacterStats): StatBlock {
  return {
    speed: s.speed * 5,
    accel: s.accel * 5,
    weight: s.weight * 5,
    handling: s.handling * 5,
    traction: s.traction * 5,
    turbo: s.miniTurbo * 5,
  };
}

// ===========================================================================
// Characters — order and ids come straight from the roster
// ===========================================================================

function toMenuCharacter(c: RosterEntry): CharacterDef {
  return {
    id: c.id,
    name: c.name,
    tagline: c.tagline,
    ...shadePair(c.color, c.secondaryColor),
    glow: cssColor(c.glowColor),
    bodyId: c.bodyId,
    stats: toMenuStats(c.stats),
    mascot: c.id === DEFAULT_CHARACTER_ID,
  };
}

/** Every racer in `@/karts/Characters`, in roster order (Foxy leads). */
export const CHARACTERS: readonly CharacterDef[] = ROSTER.map(toMenuCharacter);

/**
 * Columns for the character grid, chosen so the grid stays two rows deep.
 * The screen is a centred flex column with no scrolling: a third row of cards
 * costs 164 design units of a 1080-unit budget, which is what pushes the stat
 * panel off the bottom. Ten racers therefore lay out 5 x 2, not 4 x 3.
 * MenuSystem writes this into `grid-template-columns` so the CSS and the
 * keyboard focus model can never disagree about the row width.
 */
export function characterColumns(count: number): number {
  if (count <= 8) return 4;
  return Math.min(6, Math.ceil(count / 2));
}

// ===========================================================================
// Kart bodies — names/tyres from the real maps, pitch is editorial
// ===========================================================================

/**
 * Editorial: what each chassis is *for*, and how the stat bars should move when
 * you hover it. Keyed by real `KartBodyId`; `Partial` on purpose so a seventh
 * chassis added in `KartBodies.ts` still appears (with a derived tag) instead of
 * breaking this file's build. The probe asserts every real id is covered, so an
 * omission is loud without being fatal.
 */
const BODY_TAGS: Partial<Record<KartBodyId, string>> = {
  standard: 'BALANCED',
  bike: 'LEAN & AGILE',
  cruiser: 'HEAVYWEIGHT',
  speedster: 'TOP SPEED',
  buggy: 'OFF-ROAD',
  hover: 'ANTI-GRAV',
};

const BODY_DELTAS: Partial<Record<KartBodyId, Partial<StatBlock>>> = {
  standard: {},
  bike: { handling: 0.5, turbo: 0.5, weight: -0.75, traction: -0.25 },
  cruiser: { weight: 1.0, speed: 0.25, accel: -0.5, handling: -0.5 },
  speedster: { speed: 0.75, accel: -0.5, handling: -0.25, turbo: -0.25 },
  buggy: { traction: 0.75, accel: 0.25, speed: -0.5 },
  hover: { turbo: 1.0, handling: 0.5, speed: -0.25, traction: -0.25 },
};

/** Used only for a chassis no character currently rides. */
const BODY_FALLBACK_PAINT: Partial<Record<KartBodyId, number>> = {
  standard: 0xe9f1ff,
  bike: 0x19c6a4,
  cruiser: 0x8fa5c4,
  speedster: 0xff5252,
  buggy: 0xffd447,
  hover: 0xb46bff,
};

/**
 * A chassis' thumbnail wears the paint of the first racer who ships with it —
 * derived, so it can never disagree with the roster.
 */
function paintForBody(id: KartBodyId): { colorA: string; colorB: string } {
  for (const c of ROSTER) {
    if (c.bodyId === id) return shadePair(c.color, c.secondaryColor);
  }
  const fallback = BODY_FALLBACK_PAINT[id] ?? 0x9fb4d0;
  return shadePair(fallback, darken(fallback, 0.35));
}

/** Every chassis in `KART_BODY_IDS`, in that order. */
export const KART_BODIES: readonly KartBodyDef[] = KART_BODY_IDS.map((id) => ({
  id,
  name: BODY_NAMES[id],
  ...paintForBody(id),
  tyre: BODY_TYRE[id],
  deltas: BODY_DELTAS[id] ?? {},
  tag: BODY_TAGS[id] ?? 'CHASSIS',
}));

// ===========================================================================
// Tracks — everything that exists in the circuit is read from the circuit
// ===========================================================================

/** Top-of-sky colour per real `SkyPresetName`. Exhaustive by construction. */
const SKY_TOP: Record<SkyPresetName, string> = {
  day: '#7cc6ff',
  sunset: '#ff9a4d',
  night: '#2b3fa8',
  storm: '#6d7c93',
  volcanic: '#ff7a35',
};

/** Fallback tag when a circuit has no editorial entry. */
const THEME_TAG: Record<TrackTheme, string> = {
  coastal: 'COASTAL',
  city: 'NIGHT CITY',
  volcano: 'VOLCANO',
};

/** Editorial: difficulty pips and the corner-of-card label, by real id. */
const TRACK_EDITORIAL: Partial<Record<string, { difficulty: number; tag: string }>> = {
  sunsetCoastline: { difficulty: 1, tag: 'RESORT' },
  neonMetropolis: { difficulty: 2, tag: 'NIGHT CITY' },
  volcanoRush: { difficulty: 3, tag: 'VOLCANO' },
};

/**
 * Lap length from the authored centreline: the closed polyline through the
 * control points. Measured against a dense Catmull-Rom sample of the same nodes
 * it is short by 0.2-0.3 %, and it reproduces the km figures in the
 * `TrackDefs.ts` section headers (1.61 / 1.55 / 1.53) — the menu used to claim
 * 1.9 / 2.3 / 2.6 for the same three circuits.
 */
function lapLengthKm(def: CircuitDef): number {
  const n = def.nodes.length;
  if (n < 2) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = def.nodes[i].p;
    const b = def.nodes[(i + 1) % n].p;
    m += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return m / 1000;
}

/** The centreline flattened to XZ — the preview card's true circuit shape. */
function outlineOf(def: CircuitDef): readonly { x: number; y: number }[] {
  return def.nodes.map((nd) => ({ x: nd.p[0], y: nd.p[2] }));
}

function toMenuTrack(def: CircuitDef): TrackDef {
  const ed = TRACK_EDITORIAL[def.id];
  return {
    id: def.id,
    name: def.name,
    subtitle: def.subtitle,
    themeA: SKY_TOP[def.skyPreset],
    themeB: cssColor(def.fogColor),
    road: cssColor(def.road.line),
    difficulty: ed?.difficulty ?? 2,
    lengthKm: lapLengthKm(def),
    laps: def.laps,
    seed: def.terrainSeed,
    tag: ed?.tag ?? THEME_TAG[def.theme],
    outline: outlineOf(def),
  };
}

/**
 * `TRACK_ORDER` first (that is the cup order), then anything else in `TRACKS`,
 * so a circuit added without touching the order array cannot be invisible.
 */
function circuitIds(): string[] {
  const out: string[] = [];
  for (const id of TRACK_ORDER) if (CIRCUITS[id]) out.push(id);
  for (const id of Object.keys(CIRCUITS)) if (!out.includes(id)) out.push(id);
  return out;
}

export const TRACKS: readonly TrackDef[] = circuitIds().map((id) => toMenuTrack(CIRCUITS[id]));
