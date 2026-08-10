/**
 * ============================================================================
 *  APEX KART — ROSTER
 * ============================================================================
 *  Eight characters, eight genuinely different stat spreads. The `id` values
 *  match `CHARACTER_STATS` in `src/physics/Tuning.ts` so `makeTuning(id)`
 *  returns the chassis these stats describe — there is exactly one place where
 *  balance is decided, and this is the presentation-side mirror of it.
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

export const DEFAULT_CHARACTER_ID = 'nova';

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
