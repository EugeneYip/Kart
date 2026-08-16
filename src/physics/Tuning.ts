/**
 * ============================================================================
 *  APEX KART — CHASSIS TUNING
 * ============================================================================
 *  Every character/kart combo is described by six 0..1 stats (the MK8 model)
 *  and expanded into a full `KartTuning` by `buildTuning()`. Keeping the
 *  authored surface at six numbers means the whole roster stays in balance:
 *  there is exactly one place where "what does Weight actually do" is decided.
 *
 *  Stat philosophy (what each dial buys you):
 *    speed         top speed. The dominant stat on long straights only.
 *    acceleration  how fast you recover from a hit / a bad corner exit.
 *    weight        collision authority + a little top speed, costs turn-in.
 *    handling      raw yaw authority, i.e. how tight you can take a corner.
 *    traction      lateral relaxation rate — off-road and ice punish low values.
 *    miniTurbo     drift charge tiers arrive sooner and boosts last longer.
 *
 *  NOTE ON UNITS — these are physical, not arbitrary:
 *    maxSpeed             m/s
 *    acceleration         m/s^2 at zero speed & full throttle
 *    brakeForce           m/s^2
 *    turnRate             rad/s of chassis yaw at full lock, low speed
 *    grip / driftGrip     1/s — exponential relaxation rate of the slip angle
 *    suspensionStiffness  N/m per corner
 *    suspensionDamping    damping RATIO (0 = none, 1 = critical)
 * ============================================================================
 */

import * as THREE from 'three';
import type { KartTuning } from '@/core/Types';
import { WORLD } from '@/core/Config';
import { clamp01 } from '@/core/MathUtils';

// ---------------------------------------------------------------------------

export interface KartStats {
  /** 0..1 */
  speed: number;
  acceleration: number;
  weight: number;
  handling: number;
  traction: number;
  miniTurbo: number;
}

export type CCClass = 50 | 100 | 150 | 200;

export interface CCMultiplier {
  speed: number;
  accel: number;
  turn: number;
  brake: number;
  boost: number;
}

/**
 * Engine classes. 200cc is deliberately nasty: much faster, noticeably lazier
 * steering, and it leans on the (stronger) brakes to make corners at all.
 */
export const CC_MULTIPLIERS: Record<CCClass, CCMultiplier> = {
  50: { speed: 0.74, accel: 0.88, turn: 1.10, brake: 0.95, boost: 0.92 },
  100: { speed: 0.87, accel: 0.94, turn: 1.04, brake: 1.0, boost: 0.96 },
  150: { speed: 1.0, accel: 1.0, turn: 1.0, brake: 1.0, boost: 1.0 },
  200: { speed: 1.22, accel: 1.08, turn: 0.88, brake: 1.35, boost: 1.05 },
};

/** Static suspension sag, metres. Constant across the roster on purpose —
 *  every kart should sit at the same ride height so cameras & VFX line up. */
const STATIC_SAG = 0.088;

// ---------------------------------------------------------------------------

export function buildTuning(stats: Partial<KartStats>): KartTuning {
  const speed = clamp01(stats.speed ?? 0.5);
  const accel = clamp01(stats.acceleration ?? 0.5);
  const weight = clamp01(stats.weight ?? 0.5);
  const handling = clamp01(stats.handling ?? 0.5);
  const traction = clamp01(stats.traction ?? 0.5);
  const mt = clamp01(stats.miniTurbo ?? 0.5);

  const mass = 148 + weight * 132; // 148..280 kg

  // Top speed band: 24.6 .. 31.8 m/s, mid-roster ≈ 28 m/s as per the brief.
  const maxSpeed = 24.6 + speed * 7.2 + weight * 0.35;

  // Acceleration at v=0. Heavier karts pay a small tax.
  const acceleration = 18.0 + accel * 13.0 - weight * 1.6;

  // Yaw authority at full lock, low speed. 2.10 .. 3.05 rad/s.
  const turnRate = 2.1 + handling * 1.0 - weight * 0.14;

  // Slip-angle relaxation rate. Higher = the kart bites and refuses to slide.
  const grip = 9.6 + traction * 9.2;
  const driftGrip = 5.0 + traction * 3.4;

  // How much extra yaw a fully-committed drift buys over a gripping corner.
  const driftTurnBonus = 0.28 + handling * 0.34;

  // MiniTurbo shortens the charge windows and lengthens the payoff.
  const tierScale = 1.16 - 0.26 * mt;
  const boostScale = 0.86 + 0.3 * mt;

  const halfExtents = new THREE.Vector3(
    0.68 + weight * 0.09,
    0.42 + weight * 0.05,
    0.92 + weight * 0.1,
  );

  const trackHalf = 0.60 + weight * 0.05;
  const frontZ = -(0.66 + weight * 0.06);
  const rearZ = 0.70 + weight * 0.06;
  const hubY = -0.06;

  return {
    mass,
    maxSpeed,
    maxReverseSpeed: 8.5 + accel * 2.0,
    acceleration,
    brakeForce: 24 + weight * 8 + traction * 5,
    turnRate,
    grip,
    driftGrip,
    driftTurnBonus,
    driftTiers: [0.68 * tierScale, 1.56 * tierScale, 2.82 * tierScale],
    driftBoosts: [0.52 * boostScale, 0.9 * boostScale, 1.36 * boostScale],
    weight,
    handling,
    suspensionRest: 0.4,
    suspensionTravel: 0.3,
    // Derived so that every kart sags exactly STATIC_SAG under its own weight.
    suspensionStiffness: (mass * WORLD.gravity) / (4 * STATIC_SAG),
    // Damping RATIO, not a coefficient. 0.55 => reads as suspension, never rings.
    suspensionDamping: 0.55,
    halfExtents,
    wheelOffsets: [
      new THREE.Vector3(-trackHalf, hubY, frontZ), // FL
      new THREE.Vector3(trackHalf, hubY, frontZ), // FR
      new THREE.Vector3(-trackHalf - 0.02, hubY, rearZ), // RL
      new THREE.Vector3(trackHalf + 0.02, hubY, rearZ), // RR
    ],
    wheelRadius: 0.32 + weight * 0.04,
  };
}

// ---------------------------------------------------------------------------
//  The roster. Ten genuinely different chassis.
// ---------------------------------------------------------------------------

export const CHARACTER_STATS: Record<string, KartStats> = {
  /**
   * The mascot. A light, sure-footed corner-exit specialist: high mini-turbo and
   * high traction, average acceleration, modest top speed.
   *
   * Distinct from the two spreads it could have collided with. `vex` is the pure
   * drift god — 1.0 handling but 0.48 traction, so it slides everywhere and has
   * to be caught. `pip` is the comeback machine — 0.96 acceleration but a 0.24
   * top speed, so it is only ever recovering. `foxy` is neither: 0.78 traction
   * means it simply does not lose the back end, 0.84 miniTurbo means every
   * corner pays, and 0.58 acceleration means a mistake actually costs.
   */
  foxy: { speed: 0.52, acceleration: 0.58, weight: 0.2, handling: 0.72, traction: 0.78, miniTurbo: 0.84 },
  /**
   * The heavyweight. Maximum traction, near-maximum weight, and the worst
   * acceleration on the roster.
   *
   * Distinct from the other two heavies, both of which are *fast*: `torque` runs
   * 0.78 speed and `strata` 0.86, so both are straight-line threats that pay for
   * it in the corners. `capy` inverts that — 0.4 speed is the lowest of any kart
   * over 0.7 weight — and buys 1.0 traction and 0.5 miniTurbo with the change.
   * It is the only heavy that is genuinely happier off-road than on the straight.
   */
  capy: { speed: 0.4, acceleration: 0.18, weight: 0.92, handling: 0.3, traction: 1.0, miniTurbo: 0.5 },
  /** The default. Nothing to complain about, nothing to exploit. */
  nova: { speed: 0.55, acceleration: 0.55, weight: 0.5, handling: 0.55, traction: 0.55, miniTurbo: 0.55 },
  /** Straight-line missile. Corners like a fridge. */
  blitz: { speed: 0.95, acceleration: 0.25, weight: 0.8, handling: 0.28, traction: 0.4, miniTurbo: 0.3 },
  /** Featherweight. Recovers from anything, tops out early. */
  pip: { speed: 0.24, acceleration: 0.96, weight: 0.1, handling: 0.86, traction: 0.55, miniTurbo: 0.92 },
  /** Heavyweight bruiser — wins every collision it enters. */
  torque: { speed: 0.78, acceleration: 0.3, weight: 1.0, handling: 0.34, traction: 0.72, miniTurbo: 0.24 },
  /** Drift specialist. Purple sparks arrive absurdly early. */
  vex: { speed: 0.45, acceleration: 0.7, weight: 0.3, handling: 1.0, traction: 0.48, miniTurbo: 0.88 },
  /** Grip monster. Ignores off-road, hates being slow. */
  ember: { speed: 0.48, acceleration: 0.8, weight: 0.4, handling: 0.6, traction: 0.96, miniTurbo: 0.6 },
  /** Cruiser: fast and planted, but you must plan your corners. */
  strata: { speed: 0.86, acceleration: 0.4, weight: 0.7, handling: 0.4, traction: 0.86, miniTurbo: 0.4 },
  /** Light all-rounder — the "good at everything, master of none" pick. */
  zephyr: { speed: 0.6, acceleration: 0.76, weight: 0.25, handling: 0.8, traction: 0.45, miniTurbo: 0.76 },
  /**
   * The heavyweight drifter. Heavy and agile at once, paying in grip.
   *
   * Distinct from every other kart over 0.7 weight, all of which are
   * straight-line cars: `blitz` 0.28 handling, `capy` 0.30, `torque` 0.34,
   * `strata` 0.40. `skid` runs 0.82 handling at 0.84 weight and buys it with
   * 0.22 traction — the roster floor, against a previous worst of 0.40 — then
   * spends the slide through a 0.98 miniTurbo, the roster ceiling.
   */
  skid: { speed: 0.52, acceleration: 0.44, weight: 0.84, handling: 0.82, traction: 0.22, miniTurbo: 0.98 },
  /**
   * The line racer. The only kart with handling and traction both above 0.86,
   * and the only one with high handling and NO drift payoff.
   *
   * Every other high-handling kart is also a drift kart — `vex` 1.0/0.88,
   * `pip` 0.86/0.92, `zephyr` 0.80/0.76, `foxy` 0.72/0.84 — so cornering and
   * mini-turbo have never been separable on this grid. `quill` separates them:
   * 0.12 miniTurbo is half the previous floor (`torque` 0.24), so the reward
   * for a slide is nil and the reward for the geometric line is everything.
   */
  quill: { speed: 0.34, acceleration: 0.62, weight: 0.58, handling: 0.92, traction: 0.9, miniTurbo: 0.12 },
};

export const TUNINGS: Record<string, KartTuning> = Object.fromEntries(
  Object.entries(CHARACTER_STATS).map(([k, v]) => [k, buildTuning(v)]),
);

export const DEFAULT_TUNING_ID = 'nova';

/** Returns a NEW tuning with the CC class multipliers folded in. */
export function tuningForCC(base: KartTuning, cc: CCClass): KartTuning {
  const m = CC_MULTIPLIERS[cc] ?? CC_MULTIPLIERS[150];
  return {
    ...base,
    maxSpeed: base.maxSpeed * m.speed,
    maxReverseSpeed: base.maxReverseSpeed * m.speed,
    acceleration: base.acceleration * m.accel,
    brakeForce: base.brakeForce * m.brake,
    turnRate: base.turnRate * m.turn,
    driftBoosts: [
      base.driftBoosts[0] * m.boost,
      base.driftBoosts[1] * m.boost,
      base.driftBoosts[2] * m.boost,
    ],
    // Vectors are shared read-only; clone so callers can never alias-mutate.
    halfExtents: base.halfExtents.clone(),
    wheelOffsets: base.wheelOffsets.map((v) => v.clone()),
  };
}

/** Convenience: character id + cc in one call. Falls back to `nova`. */
export function makeTuning(characterId: string, cc: CCClass = 150): KartTuning {
  const base = TUNINGS[characterId] ?? TUNINGS[DEFAULT_TUNING_ID];
  return tuningForCC(base, cc);
}
