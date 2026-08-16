/**
 * ============================================================================
 *  FOXY KART — ROSTER
 * ============================================================================
 *  Ten characters, ten genuinely different stat spreads. The `id` values match
 *  `CHARACTER_STATS` in `src/physics/Tuning.ts` so `makeTuning(id)` returns the
 *  chassis these stats describe — there is exactly one place where balance is
 *  decided, and this is the presentation-side mirror of it.
 *
 *  Foxy leads the roster: the game is named after her.
 * ============================================================================
 */

import type { KartBodyId } from './KartBodies';
import type { TyreId } from './Wheels';
import type { DriverId } from './Driver';

export interface CharacterStats {
  /** All 0..1. */
  speed: number;
  accel: number;
  weight: number;
  handling: number;
  traction: number;
  miniTurbo: number;
}

export interface CharacterDef {
  id: string;
  name: string;
  /** Short blurb for the character-select screen. */
  tagline: string;
  bodyId: KartBodyId;
  tyreId: TyreId;
  /** Primary paint. */
  color: number;
  /** Accent paint (wings, stripes, calipers, mirrors). */
  secondaryColor: number;
  /** Emissive accent (thrusters, underglow, drift charge). */
  glowColor: number;
  stats: CharacterStats;
  driverId: DriverId;
  /** Metal-flake amount, 0 = flat toy paint, 1 = heavy metallic. */
  flake: number;
  /** Slightly matte body (off-road chassis). */
  matte?: boolean;
}

export const CHARACTERS: readonly CharacterDef[] = [
  {
    id: 'foxy',
    name: 'Foxy',
    tagline: 'Fastest on the grid, and she still never loses grip.',
    bodyId: 'standard',
    tyreId: 'slick',
    color: 0xe4761f,
    secondaryColor: 0xf3e3cb,
    glowColor: 0x4fc8f0,
    // `speed: 1.0` — the owner asked for Foxy's Speed bar to read 5, and
    // `toMenuStats` is `s.speed * 5`, so 1.0 is the value that shows 5.0. It was
    // 0.52, which displayed as 2.5.
    //
    // A deliberate owner decision, and less disruptive than it sounds: the speed
    // bars now run foxy 5.0, blitz 4.8, strata 4.3, torque 3.9, then a gap to
    // zephyr 3.0. She is top by one notch over a rival who was already at 0.96,
    // not an outlier.
    //
    // Her costs are unchanged and still real: the lowest weight on the grid (0.2),
    // so she is shoved around in every contact, and accel 0.58, which keeps her
    // ordinary off the line and after a hit. The old tagline said she "never wins a
    // drag race", which this directly contradicts, so it changed too.
    //
    // No other character's stats were touched. If the grid feels lopsided after
    // this, the fix is a deliberate balance pass, not a quiet nerf hidden here.
    stats: { speed: 1.0, accel: 0.58, weight: 0.2, handling: 0.72, traction: 0.78, miniTurbo: 0.84 },
    driverId: 'fox',
    flake: 0.45,
  },
  {
    id: 'capy',
    name: 'Capy',
    tagline: 'Arrives late. Arrives anyway.',
    bodyId: 'cruiser',
    tyreId: 'knobbly',
    color: 0xc4622d,
    secondaryColor: 0x6e90ae,
    glowColor: 0xffb44a,
    // The immovable-but-slow heavy. Torque (0.78 speed) and Strata (0.86) are
    // both *fast* heavies; Capy is the first one that is genuinely slow in a
    // straight line, with the roster's worst acceleration and maximum traction.
    stats: { speed: 0.4, accel: 0.18, weight: 0.92, handling: 0.3, traction: 1.0, miniTurbo: 0.5 },
    driverId: 'capy',
    flake: 0.3,
  },
  {
    id: 'nova',
    name: 'Nova',
    tagline: 'Nothing to complain about, nothing to exploit.',
    bodyId: 'standard',
    tyreId: 'standard',
    color: 0xe23e2c,
    secondaryColor: 0xf2efe6,
    glowColor: 0xff7a3c,
    stats: { speed: 0.55, accel: 0.55, weight: 0.5, handling: 0.55, traction: 0.55, miniTurbo: 0.55 },
    driverId: 'mechanic',
    flake: 0.5,
  },
  {
    id: 'blitz',
    name: 'Blitz',
    tagline: 'Straight-line missile. Corners like a fridge.',
    bodyId: 'speedster',
    tyreId: 'slick',
    color: 0x1e4fd9,
    secondaryColor: 0xffd23f,
    glowColor: 0x5aa8ff,
    stats: { speed: 0.95, accel: 0.25, weight: 0.8, handling: 0.28, traction: 0.4, miniTurbo: 0.3 },
    driverId: 'racer',
    flake: 0.85,
  },
  {
    id: 'pip',
    name: 'Pip',
    tagline: 'Featherweight. Recovers from anything.',
    bodyId: 'bike',
    tyreId: 'slick',
    color: 0x19c6a4,
    secondaryColor: 0xfff6e0,
    glowColor: 0x4dffd6,
    stats: { speed: 0.24, accel: 0.96, weight: 0.1, handling: 0.86, traction: 0.55, miniTurbo: 0.92 },
    driverId: 'speedy',
    flake: 0.35,
  },
  {
    id: 'torque',
    name: 'Torque',
    tagline: 'Wins every collision it enters.',
    bodyId: 'cruiser',
    tyreId: 'standard',
    color: 0x8a5a2b,
    secondaryColor: 0xe9c46a,
    glowColor: 0xffa63c,
    stats: { speed: 0.78, accel: 0.3, weight: 1.0, handling: 0.34, traction: 0.72, miniTurbo: 0.24 },
    driverId: 'heavy',
    flake: 0.7,
  },
  {
    id: 'vex',
    name: 'Vex',
    tagline: 'Purple sparks arrive absurdly early.',
    bodyId: 'hover',
    tyreId: 'hover',
    color: 0x7a2be2,
    secondaryColor: 0x2a1b45,
    glowColor: 0x3cf0c8,
    stats: { speed: 0.45, accel: 0.7, weight: 0.3, handling: 1.0, traction: 0.48, miniTurbo: 0.88 },
    driverId: 'alien',
    flake: 0.6,
  },
  {
    id: 'ember',
    name: 'Ember',
    tagline: 'Ignores off-road. Hates being slow.',
    bodyId: 'buggy',
    tyreId: 'knobbly',
    color: 0xf0641e,
    secondaryColor: 0x2a2a33,
    glowColor: 0xffc24a,
    stats: { speed: 0.48, accel: 0.8, weight: 0.4, handling: 0.6, traction: 0.96, miniTurbo: 0.6 },
    driverId: 'knight',
    flake: 0.25,
    matte: true,
  },
  {
    id: 'strata',
    name: 'Strata',
    tagline: 'Fast and planted — plan your corners.',
    bodyId: 'speedster',
    tyreId: 'standard',
    color: 0x2f5d7c,
    secondaryColor: 0xd7e3ea,
    glowColor: 0x8fd8ff,
    stats: { speed: 0.86, accel: 0.4, weight: 0.7, handling: 0.4, traction: 0.86, miniTurbo: 0.4 },
    driverId: 'aviator',
    flake: 0.8,
  },
  {
    id: 'skid',
    name: 'Skid',
    tagline: 'Heavy, sideways, and somehow first out of the corner.',
    bodyId: 'buggy',
    tyreId: 'slick',
    color: 0x1f9e8c,
    secondaryColor: 0xf2b134,
    glowColor: 0x5ef0c8,
    // THE HEAVYWEIGHT DRIFTER — the first hole in the table. Every kart above
    // 0.70 weight until now was a straight-line car that paid for it in the
    // corners: blitz 0.28 handling, capy 0.30, torque 0.34, strata 0.40. Skid is
    // heavy AND agile, and pays in GRIP instead. 0.22 traction is the roster
    // floor by a wide margin (blitz, at 0.40, was the previous worst) against
    // 0.98 miniTurbo, which is the ceiling (pip's 0.92 was). She is the only
    // kart you deliberately break traction on, and the only heavy that wants a
    // corner rather than a straight.
    stats: { speed: 0.52, accel: 0.44, weight: 0.84, handling: 0.82, traction: 0.22, miniTurbo: 0.98 },
    driverId: 'drifter',
    flake: 0.2,
    matte: true,
  },
  {
    id: 'quill',
    name: 'Quill',
    tagline: 'Perfect line, every corner. Gets nothing for drifting.',
    bodyId: 'bike',
    tyreId: 'standard',
    color: 0x6d4bd6,
    secondaryColor: 0xf5ecd8,
    glowColor: 0xffd166,
    // THE LINE RACER — the second hole, and a mechanical counter-play rather
    // than a stat interpolation. On this grid "corners well" has always meant
    // "drifts well": every kart over 0.80 handling also has a big miniTurbo
    // (vex 0.88, pip 0.92, zephyr 0.76, foxy 0.84). Quill has 0.92 handling and
    // 0.90 traction — the only kart with BOTH above 0.86 — and 0.12 miniTurbo,
    // half the previous floor (torque 0.24). She gains nothing from sliding, so
    // she is the one racer driven on the geometric line, and the only answer on
    // the board to a field of drift-boosters.
    stats: { speed: 0.34, accel: 0.62, weight: 0.58, handling: 0.92, traction: 0.90, miniTurbo: 0.12 },
    driverId: 'duellist',
    flake: 0.65,
  },
  {
    id: 'zephyr',
    name: 'Zephyr',
    tagline: 'Good at everything, master of none.',
    bodyId: 'standard',
    tyreId: 'slick',
    color: 0xc8f03c,
    secondaryColor: 0x2b2f36,
    glowColor: 0xd9ff4d,
    stats: { speed: 0.6, accel: 0.76, weight: 0.25, handling: 0.8, traction: 0.45, miniTurbo: 0.76 },
    driverId: 'robot',
    flake: 0.55,
  },
];

export const CHARACTER_BY_ID: Readonly<Record<string, CharacterDef>> = Object.freeze(
  Object.fromEntries(CHARACTERS.map((c) => [c.id, c])),
);

/**
 * The mascot. `KartManager.setPlayerCharacter()` overrides this the moment the
 * menu makes a pick, so this only decides who the player drives if nothing ever
 * asks — but it is also the one line to change back to `'nova'` if a QA framing
 * turns out to depend on the player's kart being red.
 */
export const DEFAULT_CHARACTER_ID = 'foxy';

export function characterAt(index: number): CharacterDef {
  return CHARACTERS[((index % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length];
}

/**
 * Convert to the field names `buildTuning()` in `src/physics/Tuning.ts` expects.
 * Physics is authoritative — this exists so a character can be tuned from the
 * roster if the physics table ever needs to be driven from here.
 */
export function toPhysicsStats(c: CharacterDef): {
  speed: number; acceleration: number; weight: number;
  handling: number; traction: number; miniTurbo: number;
} {
  return {
    speed: c.stats.speed,
    acceleration: c.stats.accel,
    weight: c.stats.weight,
    handling: c.stats.handling,
    traction: c.stats.traction,
    miniTurbo: c.stats.miniTurbo,
  };
}
