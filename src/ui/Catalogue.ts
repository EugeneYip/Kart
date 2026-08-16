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
import { DRIVERS } from '@/karts/Driver';
import type { DriverDef, HeadKind, Species } from '@/karts/Driver';
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

/**
 * Everything `characterBust()` needs to draw one racer in canvas 2-D, DERIVED
 * from `DRIVERS` in `@/karts/Driver` — the same table the 3-D rig is built from.
 *
 * This exists because the racer-select cards need art that cannot fail. The
 * primary source is `KartManager.renderPortrait()`, a real offscreen render of
 * the real rig; when that comes back empty (it did, on the owner's machine, for
 * all ten cards) the menu needs a *character*, not a gradient. Deriving the
 * palette and the headwear shape from `DRIVERS` rather than inventing them is
 * what keeps the fallback recognisably the same cast: `head` is the driver's own
 * `HeadKind`, so ten racers get ten different silhouettes — which is precisely
 * what the old generic-helmet fallback failed to do.
 */
export interface BustSpec {
  name: string;
  /** Headwear silhouette — the real `HeadKind`, so a new hat is a type error. */
  head: HeadKind;
  /**
   * Set when the rig wears a hat that has no `HeadKind` of its own.
   *
   * `Driver.ts` documents `hatVariant` as "a workaround for an ownership
   * boundary… it should not survive integration": the character agent could not
   * edit `src/ui/*`, so Skid and Quill declare the nearest existing family in
   * `head` (`trucker`, `aero`) and put the real shape here. Without this field
   * the 2-D fallback card drew a trucker cap on the racer wearing a wide straw
   * cone — two of twelve cards wrong.
   *
   * This is the narrow half of the fix. `drawHeadwear` now resolves
   * `hatVariant ?? head`, so the card is correct. The fuller fix `Driver.ts`
   * asks for — fold both variants into `HeadKind` and delete this field — also
   * means retyping the 3-D switch and the `covered` / `shell` predicates that
   * branch on `head`, and that is a change to just-landed character work for a
   * card that only appears when the offscreen portrait render comes back empty.
   * Deliberately not taken now; the field is the honest record of the debt.
   */
  hatVariant?: DriverDef['hatVariant'];
  /** `'fox' | 'capy'`, or `null` for the eight humanoids. */
  species: Species | null;
  /** Suit / trim, from the driver's own two-colour blocking. */
  suit: string;
  suitAlt: string;
  /** Skin, or pelt tones for the animals. */
  skin: string;
  fur: string;
  furAlt: string;
  furDark: string;
  eye: string;
  brow: string;
  /** Optic / visor emissive, when the driver has one. */
  faceGlow: string | null;
  /** 0..1 — drives shoulder width and neck thickness. */
  bulk: number;
  /** Head radius relative to the roster average, ~0.9..1.15. */
  headScale: number;
  /** Snout length as a multiple of the head radius. 0 for the humanoids. */
  muzzle: number;
  /** Draw whiskers / freckles / a moustache, from `FaceSpec.mark`. */
  mark: string;
  /** Eye size multiplier from the face spec. */
  eyeSize: number;
  /** A trailing scarf sits over the shoulder line. */
  scarf: boolean;
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
  /** Canvas-2-D portrait data, derived from the driver rig's own definition. */
  bust: BustSpec;
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

// ---------------------------------------------------------------------------
//  Chassis silhouettes
// ---------------------------------------------------------------------------

/**
 * WHY THE SHAPES LIVE HERE AND NOT IN THE PAINTER.
 *
 * The kart-select grid drew all six chassis with one `kartThumb(colorA, colorB)`
 * routine: an oval body with a dark cockpit ellipse in the middle of it. Six
 * cards, six colours, one shape. The visual critic's words were "the same
 * coloured oval with a dark hole in the middle — a doughnut", and that
 * Sport Bike, Heavy Cruiser, Speedster, Trail Buggy and Hover Racer were
 * indistinguishable from each other and from Standard Kart.
 *
 * A colour is not a silhouette. So the shape is now DATA, one entry per real
 * `KartBodyId`, and it lives in this module rather than in `Widgets.ts` for the
 * same reason everything else here does: this file is deliberately DOM-free and
 * CSS-free, so `.probe-tmp/kartshape.ts` can import the real geometry and
 * measure it. Grading a copy of the shapes reproduced inside a probe would prove
 * nothing, and the canvas shim returns rgb(0,0,0) for every texel so the drawn
 * pixels cannot be measured at all.
 *
 * Coordinates are a side elevation in a 0..1 box, x rearward-to-forward (the
 * nose is at high x), y downward. `ground` is where the tyres meet the floor, so
 * the painter can place the contact shadow without knowing which chassis it has.
 */
export type Vec2 = readonly [number, number];

/** How a part is painted. The painter owns the ramps; this only names them. */
export type KartPartFill = 'body' | 'shade' | 'dark' | 'glass' | 'chrome' | 'glow';

export interface KartPart {
  readonly poly: readonly Vec2[];
  readonly fill: KartPartFill;
}

export interface KartWheel {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  /** Off-road tread — drawn as blocks around the rim rather than a smooth tyre. */
  readonly knobbly: boolean;
  /**
   * The far side of the axle, drawn first and dimmed.
   *
   * These are authored rather than derived by offsetting the near pair inside
   * the painter, and the difference is not cosmetic: with the far wheels
   * implicit, `wheels.length` was 2 for a kart AND 2 for a bike, so a probe
   * asserting "the Sport Bike has two wheels" was really asserting "the array
   * has the length every array has". Spelling all four out makes the count
   * genuinely discriminating — 4 on the four-wheelers, 2 on the bike, 0 on the
   * anti-grav — and lets a chassis put its far wheels wherever its track width
   * says they go.
   */
  readonly far: boolean;
}

export interface KartSilhouette {
  /** Closed hull outline — the shape that has to read at thumbnail size. */
  readonly hull: readonly Vec2[];
  /** Wing, cage, fairing, exhausts: drawn over the hull. */
  readonly parts: readonly KartPart[];
  /** Empty for anti-grav. Two for a bike. Four for everything else. */
  readonly wheels: readonly KartWheel[];
  /** Anti-grav floats: no tyre contact, a lift gap and a ground glow instead. */
  readonly antigrav: boolean;
  /** y of the floor contact line. */
  readonly ground: number;
}

/**
 * Exhaustive by construction — `Record<KartBodyId, …>`, so a seventh chassis
 * added in `KartBodies.ts` is a compile error here rather than a seventh
 * doughnut on the grid.
 */
export const KART_SILHOUETTES: Record<KartBodyId, KartSilhouette> = {
  // Classic open kart: low tub, seat back, stubby nose, four even wheels.
  standard: {
    ground: 0.80,
    antigrav: false,
    hull: [
      [0.09, 0.70], [0.10, 0.52], [0.16, 0.47], [0.28, 0.45], [0.35, 0.53],
      [0.48, 0.52], [0.62, 0.49], [0.80, 0.51], [0.90, 0.57], [0.91, 0.68],
      [0.86, 0.73], [0.13, 0.73],
    ],
    parts: [
      // Rear spoiler.
      { fill: 'chrome', poly: [[0.04, 0.38], [0.26, 0.38], [0.26, 0.44], [0.04, 0.44]] },
      // Seat.
      { fill: 'dark', poly: [[0.17, 0.47], [0.28, 0.46], [0.33, 0.55], [0.20, 0.56]] },
      // Steering wheel / cowl.
      { fill: 'shade', poly: [[0.46, 0.44], [0.55, 0.44], [0.56, 0.52], [0.47, 0.52]] },
    ],
    wheels: [
      { cx: 0.205, cy: 0.670, r: 0.097, knobbly: false, far: true },
      { cx: 0.725, cy: 0.688, r: 0.081, knobbly: false, far: true },
      { cx: 0.240, cy: 0.690, r: 0.110, knobbly: false, far: false },
      { cx: 0.760, cy: 0.708, r: 0.092, knobbly: false, far: false },
    ],
  },

  // Two wheels IN LINE, a tall fairing and a fork. Nothing else on the grid has
  // a gap through the middle of its silhouette.
  bike: {
    ground: 0.80,
    antigrav: false,
    hull: [
      [0.24, 0.66], [0.26, 0.50], [0.34, 0.44], [0.46, 0.42], [0.58, 0.40],
      [0.68, 0.36], [0.76, 0.38], [0.78, 0.48], [0.70, 0.54], [0.56, 0.56],
      [0.44, 0.60], [0.34, 0.66],
    ],
    parts: [
      // Front fairing / screen.
      { fill: 'glass', poly: [[0.68, 0.30], [0.79, 0.34], [0.78, 0.41], [0.68, 0.37]] },
      // Fork down to the front wheel.
      { fill: 'chrome', poly: [[0.72, 0.44], [0.78, 0.45], [0.80, 0.66], [0.75, 0.66]] },
      // Seat hump over the rear wheel.
      { fill: 'dark', poly: [[0.24, 0.48], [0.38, 0.44], [0.40, 0.50], [0.26, 0.55]] },
      // Swingarm.
      { fill: 'shade', poly: [[0.26, 0.60], [0.52, 0.55], [0.53, 0.60], [0.28, 0.65]] },
    ],
    // Two, and only two. A bike seen from the side hides its far side exactly
    // behind its near side, so there is no dimmed pair to author.
    wheels: [
      { cx: 0.220, cy: 0.665, r: 0.135, knobbly: false, far: false },
      { cx: 0.800, cy: 0.665, r: 0.135, knobbly: false, far: false },
    ],
  },

  // Long, low and heavy: the hull runs nearly the full width, the rear tyres are
  // the biggest on the grid and there are stacks over the engine bay.
  cruiser: {
    ground: 0.80,
    antigrav: false,
    hull: [
      [0.03, 0.72], [0.04, 0.58], [0.12, 0.54], [0.26, 0.53], [0.34, 0.57],
      [0.52, 0.56], [0.70, 0.55], [0.86, 0.57], [0.95, 0.61], [0.97, 0.71],
      [0.93, 0.76], [0.07, 0.76],
    ],
    parts: [
      // Chrome bull-bar across the nose.
      { fill: 'chrome', poly: [[0.88, 0.60], [0.98, 0.62], [0.98, 0.74], [0.88, 0.73]] },
      // Twin exhaust stacks.
      { fill: 'chrome', poly: [[0.30, 0.36], [0.35, 0.36], [0.35, 0.55], [0.30, 0.55]] },
      { fill: 'chrome', poly: [[0.38, 0.40], [0.43, 0.40], [0.43, 0.56], [0.38, 0.56]] },
      // Deep rear fender over the big tyre.
      { fill: 'shade', poly: [[0.06, 0.56], [0.30, 0.55], [0.31, 0.63], [0.07, 0.64]] },
      // Bench seat.
      { fill: 'dark', poly: [[0.14, 0.48], [0.26, 0.47], [0.28, 0.55], [0.16, 0.55]] },
    ],
    wheels: [
      { cx: 0.185, cy: 0.645, r: 0.119, knobbly: false, far: true },
      { cx: 0.765, cy: 0.675, r: 0.092, knobbly: false, far: true },
      { cx: 0.220, cy: 0.665, r: 0.135, knobbly: false, far: false },
      { cx: 0.800, cy: 0.695, r: 0.105, knobbly: false, far: false },
    ],
  },

  // Formula car: a long pointed nose that reaches the floor, a narrow tub and a
  // rear wing standing well clear of the body.
  speedster: {
    ground: 0.80,
    antigrav: false,
    hull: [
      [0.06, 0.62], [0.08, 0.52], [0.18, 0.50], [0.28, 0.48], [0.36, 0.56],
      [0.50, 0.58], [0.66, 0.61], [0.84, 0.66], [0.98, 0.72], [0.98, 0.76],
      [0.60, 0.72], [0.34, 0.70], [0.10, 0.70],
    ],
    parts: [
      // Rear wing on its pylon — the tallest thing on the card.
      { fill: 'chrome', poly: [[0.02, 0.26], [0.24, 0.26], [0.24, 0.33], [0.02, 0.33]] },
      { fill: 'dark', poly: [[0.11, 0.33], [0.16, 0.33], [0.16, 0.51], [0.11, 0.51]] },
      // Airbox behind the driver's head.
      { fill: 'shade', poly: [[0.22, 0.40], [0.32, 0.44], [0.33, 0.50], [0.23, 0.49]] },
      // Cockpit opening.
      { fill: 'dark', poly: [[0.33, 0.49], [0.44, 0.51], [0.45, 0.57], [0.34, 0.55]] },
      // Side pod.
      { fill: 'shade', poly: [[0.36, 0.58], [0.62, 0.61], [0.62, 0.70], [0.36, 0.69]] },
    ],
    wheels: [
      { cx: 0.165, cy: 0.660, r: 0.106, knobbly: false, far: true },
      { cx: 0.705, cy: 0.675, r: 0.092, knobbly: false, far: true },
      { cx: 0.200, cy: 0.680, r: 0.120, knobbly: false, far: false },
      { cx: 0.740, cy: 0.695, r: 0.105, knobbly: false, far: false },
    ],
  },

  // Raised, caged and knobbly: the only silhouette with daylight under the hull
  // and a roll bar over the top of it.
  buggy: {
    ground: 0.80,
    antigrav: false,
    hull: [
      [0.14, 0.56], [0.16, 0.46], [0.30, 0.44], [0.42, 0.47], [0.58, 0.46],
      [0.74, 0.47], [0.86, 0.50], [0.88, 0.58], [0.80, 0.62], [0.20, 0.62],
    ],
    parts: [
      // Roll cage.
      { fill: 'chrome', poly: [[0.22, 0.44], [0.27, 0.44], [0.34, 0.26], [0.29, 0.26]] },
      { fill: 'chrome', poly: [[0.29, 0.26], [0.62, 0.24], [0.62, 0.30], [0.30, 0.32]] },
      { fill: 'chrome', poly: [[0.58, 0.25], [0.63, 0.25], [0.70, 0.46], [0.65, 0.46]] },
      // Light bar on the cage.
      { fill: 'glow', poly: [[0.36, 0.20], [0.56, 0.19], [0.56, 0.25], [0.36, 0.26]] },
      // Bucket seat.
      { fill: 'dark', poly: [[0.32, 0.34], [0.44, 0.33], [0.46, 0.46], [0.34, 0.47]] },
      // Skid plate under the raised floor.
      { fill: 'shade', poly: [[0.24, 0.60], [0.78, 0.60], [0.76, 0.65], [0.26, 0.65]] },
    ],
    wheels: [
      { cx: 0.205, cy: 0.630, r: 0.132, knobbly: true, far: true },
      { cx: 0.725, cy: 0.630, r: 0.132, knobbly: true, far: true },
      { cx: 0.240, cy: 0.650, r: 0.150, knobbly: true, far: false },
      { cx: 0.760, cy: 0.650, r: 0.150, knobbly: true, far: false },
    ],
  },

  // Anti-grav: NO wheels at all, a delta hull and two thruster pods over a lift
  // gap. `wheels` is empty and `antigrav` is true, which is what tells the
  // painter to draw a glow under it rather than tyre contact.
  hover: {
    ground: 0.80,
    antigrav: true,
    hull: [
      [0.08, 0.52], [0.20, 0.44], [0.42, 0.40], [0.66, 0.40], [0.86, 0.45],
      [0.96, 0.53], [0.90, 0.60], [0.62, 0.63], [0.30, 0.63], [0.10, 0.59],
    ],
    parts: [
      // Canopy.
      { fill: 'glass', poly: [[0.34, 0.40], [0.58, 0.38], [0.66, 0.44], [0.36, 0.47]] },
      // Thruster pods, hanging below the hull over the lift gap.
      { fill: 'dark', poly: [[0.16, 0.60], [0.36, 0.60], [0.34, 0.68], [0.18, 0.68]] },
      { fill: 'dark', poly: [[0.62, 0.60], [0.84, 0.60], [0.82, 0.68], [0.64, 0.68]] },
      // Emissive rings on the pods — the anti-grav read.
      { fill: 'glow', poly: [[0.18, 0.66], [0.34, 0.66], [0.33, 0.70], [0.19, 0.70]] },
      { fill: 'glow', poly: [[0.64, 0.66], [0.82, 0.66], [0.81, 0.70], [0.65, 0.70]] },
      // Swept tail fin.
      { fill: 'shade', poly: [[0.06, 0.34], [0.18, 0.44], [0.14, 0.53], [0.06, 0.50]] },
    ],
    wheels: [],
  },
};

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

/**
 * Mean `headR` across the roster, so `headScale` is a ratio rather than a raw
 * metre value the drawing code would have to know the units of.
 */
const MEAN_HEAD_R = (() => {
  const ids = Object.keys(DRIVERS) as Array<keyof typeof DRIVERS>;
  let sum = 0;
  for (const id of ids) sum += DRIVERS[id].headR * DRIVERS[id].scale;
  return sum / Math.max(1, ids.length);
})();

function toBust(d: DriverDef): BustSpec {
  const fur = cssColor(d.fur ?? d.skinColor);
  return {
    name: d.name,
    head: d.head,
    hatVariant: d.hatVariant,
    species: d.species ?? null,
    suit: cssColor(d.suit),
    suitAlt: cssColor(d.suitAlt),
    skin: cssColor(d.skinColor),
    fur,
    furAlt: cssColor(d.furAlt ?? d.skinColor),
    furDark: cssColor(d.furDark ?? darken(d.skinColor, 0.55)),
    eye: d.face.eye,
    brow: d.face.brow,
    faceGlow: d.face.glow ?? null,
    bulk: d.bulk,
    headScale: (d.headR * d.scale) / MEAN_HEAD_R,
    muzzle: d.muzzle ?? 0,
    mark: d.face.mark ?? 'none',
    eyeSize: d.face.eyeSize ?? 1,
    scarf: d.scarf === true,
  };
}

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
    bust: toBust(DRIVERS[c.driverId]),
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
/* These are pill badges on a card corner, so they are length-constrained, not
 * free prose: at the 11px legibility floor a chassis tag paints ~9.6px per
 * character and the widest card a 450px-tall frame can carry is 99px, i.e. about
 * nine characters including the pill's own padding. `HEAVYWEIGHT` needed 116px
 * and was severed to `HEAVYWE`; `HEAVY` is the weight class the badge is
 * actually naming and it fits at every viewport. `LEAN & AGILE` wrapped its pill
 * to two lines and collided with the chassis name underneath. The probe measures
 * every one of these against its card, so a longer tag added here fails loudly
 * instead of being quietly clipped. */
const BODY_TAGS: Partial<Record<KartBodyId, string>> = {
  standard: 'BALANCED',
  bike: 'AGILE',
  cruiser: 'HEAVY',
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
  // The theme default, which the three city-series circuits take. It used to
  // read 'NIGHT CITY', which was wrong for `bostonHarbor` (midday harbour) and
  // `taipeiCircuit` (sunset). `neonMetropolis` keeps 'NIGHT CITY' via its
  // TRACK_EDITORIAL override below, because there it is simply accurate.
  city: 'CITY SERIES',
  volcano: 'VOLCANO',
};

/**
 * Editorial: difficulty pips and the corner-of-card label, by real id.
 *
 * EVERY CIRCUIT NEEDS ITS OWN TAG. Three of the six cards read "CITY SERIES",
 * because `neonMetropolis` was the only city with an override and the other two
 * fell through to `THEME_TAG.city`. A label repeated across half the grid is not
 * a label — it stops distinguishing the thing it is attached to. These name what
 * each circuit actually is; the theme map below is now only a safety net for a
 * circuit nobody has written a line for yet.
 */
const TRACK_EDITORIAL: Partial<Record<string, { difficulty: number; tag: string }>> = {
  sunsetCoastline: { difficulty: 1, tag: 'RESORT' },
  neonMetropolis: { difficulty: 2, tag: 'NIGHT CITY' },
  volcanoRush: { difficulty: 3, tag: 'VOLCANO' },
  bostonHarbor: { difficulty: 2, tag: 'HARBOUR' },
  taipeiCircuit: { difficulty: 2, tag: 'SKYLINE' },
  tokyoNeon: { difficulty: 3, tag: 'DOWNTOWN' },
  // The two newest circuits arrived without entries and both fell through to
  // `THEME_TAG.city`, which put "CITY SERIES" back on two cards — the exact
  // repetition the note above was written about. `HARBOUR` is taken by Boston,
  // so Hong Kong is named for the thing that actually distinguishes it in frame.
  // Difficulty is set from the measured minimum corner radius rather than
  // guessed: 37.8 m and 33.3 m sit between Boston/Taipei and volcano.
  hongKongHarbour: { difficulty: 2, tag: 'BLUE HOUR' },
  newYorkCircuit: { difficulty: 3, tag: 'AVENUE' },
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
