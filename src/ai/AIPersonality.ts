/**
 * ============================================================================
 *  FOXY KART — AI PERSONALITIES
 * ============================================================================
 *  Eight drivers who are recognisably different from the grandstand.
 *
 *  WHY THIS FILE EXISTS
 *  --------------------
 *  A single well-tuned driver model produces twelve identical robots. Real MK8
 *  CPUs feel like *characters*: one of them always dives up the inside, one
 *  always sits on your bumper hoarding a shell, one takes textbook lines and
 *  then wastes a red shell on a wall. That variety is what makes a race feel
 *  alive, and it is authored here rather than emerging by accident.
 *
 *  DELIBERATE IMPERFECTION
 *  -----------------------
 *  Perfect AI is unbeatable AND boring. Three mechanisms inject human error:
 *    1. `NoiseField` — a smooth, time-varying, multi-octave gradient noise that
 *       wanders the steering command. This reads as "hands on a wheel", not as
 *       random jitter (which reads as a bug).
 *    2. Missed apexes — a slow noise channel biases the lateral target, so a
 *       driver occasionally runs a corner two metres wide.
 *    3. Mistake events — a Poisson-ish process whose rate climbs with pressure
 *       (a kart alongside, a kart on the bumper, the player nearby). Under
 *       pressure, humans lock up. So do these.
 * ============================================================================
 */

import { clamp, clamp01, lerp, smootherstep } from '@/core/MathUtils';

// ---------------------------------------------------------------------------
//  Smooth noise — the source of all "human hands"
// ---------------------------------------------------------------------------

/**
 * 1-D multi-octave gradient (Perlin-style) noise. Deterministic per seed,
 * continuous, and zero-allocation on evaluation.
 */
export class NoiseField {
  private readonly grads: Float64Array;
  private readonly mask: number;

  constructor(seed = 1, size = 256) {
    // Power-of-two table so wrapping is a mask.
    let n = 1;
    while (n < size) n <<= 1;
    this.mask = n - 1;
    this.grads = new Float64Array(n);
    let s = (seed * 2654435761) >>> 0 || 1;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;
      s >>>= 0;
      this.grads[i] = (s / 4294967296) * 2 - 1;
    }
  }

  /** Single octave, output in roughly [-1,1]. */
  private octave(x: number): number {
    const i0 = Math.floor(x);
    const f = x - i0;
    const g0 = this.grads[i0 & this.mask];
    const g1 = this.grads[(i0 + 1) & this.mask];
    // Gradient noise: dot(gradient, distance) with a quintic fade.
    const v0 = g0 * f;
    const v1 = g1 * (f - 1);
    return lerp(v0, v1, smootherstep(f)) * 2;
  }

  /** Three octaves. `x` is typically `time * frequency`. Output ~[-1,1]. */
  at(x: number): number {
    let v = this.octave(x) * 0.6;
    v += this.octave(x * 2.13 + 31.7) * 0.28;
    v += this.octave(x * 4.41 + 91.3) * 0.12;
    return clamp(v, -1, 1);
  }
}

// ---------------------------------------------------------------------------
//  Personality definition
// ---------------------------------------------------------------------------

export type PersonalityId =
  | 'aggressive'
  | 'defensive'
  | 'clean'
  | 'chaotic'
  | 'rival'
  | 'cautious'
  | 'drifter'
  | 'blocker';

export interface Personality {
  readonly id: PersonalityId;
  readonly label: string;
  readonly description: string;

  // ---- line choice -------------------------------------------------------
  /** -1 = always the defensive inside line, +1 = always the wide overtaking line. */
  readonly lineBias: number;
  /** How readily it abandons the optimal line to attack, 0..1. */
  readonly lineSwitchiness: number;
  /** Metres of extra lateral wander it tolerates before correcting. */
  readonly laneTolerance: number;

  // ---- pace --------------------------------------------------------------
  /** Multiplier on the speed profile. ~1 = drives it exactly. */
  readonly paceFactor: number;
  /** >1 = brakes earlier than necessary. */
  readonly brakeMargin: number;

  // ---- combat ------------------------------------------------------------
  /** 0..1 — willingness to make contact and to squeeze others. */
  readonly aggression: number;
  /** Metres — how far ahead/behind it registers a rival worth reacting to. */
  readonly aggressionRadius: number;
  /** 0..1 — how hard it defends the inside line when attacked. */
  readonly blocking: number;
  /** Multiplier on the strength of kart avoidance (low = bumps through). */
  readonly avoidance: number;

  // ---- drifting ----------------------------------------------------------
  /** >1 = drifts more readily (lower corner threshold). */
  readonly driftEagerness: number;
  /** Drift tier it tries to reach before releasing: 1 blue, 2 orange, 3 purple. */
  readonly driftTierTarget: 1 | 2 | 3;
  /** 0..1 — how reliably it chains drifts through S-sections. */
  readonly chaining: number;

  // ---- imperfection ------------------------------------------------------
  /** Steering noise amplitude, in steer units (0..1 scale). */
  readonly errorAmp: number;
  /** Steering noise frequency, Hz. */
  readonly errorFreq: number;
  /** Lateral apex-miss amplitude, metres. */
  readonly apexMiss: number;
  /** Mistakes per second at full pressure. */
  readonly mistakeRate: number;
  /** Seconds of reaction delay for item decisions. */
  readonly reactionTime: number;

  // ---- items -------------------------------------------------------------
  /** 0..1 — aim tolerance, timing quality, target selection. */
  readonly itemSkill: number;
  /** 0..1 — how long it sits on a shell as a rear shield. */
  readonly shieldTendency: number;
  /** 0..1 — probability of firing something the instant it gets it. */
  readonly itemImpatience: number;

  // ---- special -----------------------------------------------------------
  /** 0..1 — deliberately matches the human player's pace. */
  readonly matchesPlayer: number;
}

const BASE: Omit<Personality, 'id' | 'label' | 'description'> = {
  lineBias: 0,
  lineSwitchiness: 0.5,
  laneTolerance: 1.0,
  paceFactor: 1.0,
  brakeMargin: 1.0,
  aggression: 0.5,
  aggressionRadius: 30,
  blocking: 0.3,
  avoidance: 1.0,
  driftEagerness: 1.0,
  driftTierTarget: 2,
  chaining: 0.7,
  errorAmp: 0.09,
  errorFreq: 0.55,
  apexMiss: 0.9,
  mistakeRate: 0.05,
  reactionTime: 0.36,
  itemSkill: 0.7,
  shieldTendency: 0.5,
  itemImpatience: 0.35,
  matchesPlayer: 0,
};

function make(
  id: PersonalityId,
  label: string,
  description: string,
  over: Partial<Personality>,
): Personality {
  return { ...BASE, id, label, description, ...over };
}

export const PERSONALITIES: Record<PersonalityId, Personality> = {
  aggressive: make(
    'aggressive',
    'Dive Bomber',
    'Sends it up the inside whether the gap exists or not. Will lean on you to make it stick, ' +
      'brakes late, and pays for it about one corner in eight.',
    {
      lineBias: -0.55,
      lineSwitchiness: 0.9,
      paceFactor: 1.02,
      brakeMargin: 0.9,
      aggression: 1.0,
      aggressionRadius: 42,
      blocking: 0.45,
      avoidance: 0.45,
      driftEagerness: 1.15,
      driftTierTarget: 2,
      errorAmp: 0.12,
      errorFreq: 0.7,
      apexMiss: 1.3,
      mistakeRate: 0.13,
      reactionTime: 0.24,
      itemSkill: 0.72,
      shieldTendency: 0.2,
      itemImpatience: 0.75,
    },
  ),

  defensive: make(
    'defensive',
    'Gatekeeper',
    'Owns the inside line and will not give it up. Hoards shells behind itself for laps, ' +
      'gives up a tenth per corner to make sure you cannot get past.',
    {
      lineBias: -0.75,
      lineSwitchiness: 0.25,
      laneTolerance: 0.7,
      paceFactor: 0.975,
      brakeMargin: 1.06,
      aggression: 0.55,
      aggressionRadius: 26,
      blocking: 1.0,
      avoidance: 0.85,
      driftEagerness: 0.95,
      driftTierTarget: 2,
      errorAmp: 0.07,
      apexMiss: 0.7,
      mistakeRate: 0.045,
      reactionTime: 0.32,
      itemSkill: 0.7,
      shieldTendency: 1.0,
      itemImpatience: 0.1,
    },
  ),

  clean: make(
    'clean',
    'Metronome',
    'Textbook out-in-out every single lap, immaculate braking, never touches anybody — and ' +
      'then throws a red shell into a wall because it fires the moment it gets one.',
    {
      lineBias: 0.05,
      lineSwitchiness: 0.2,
      laneTolerance: 0.55,
      paceFactor: 1.01,
      brakeMargin: 1.0,
      aggression: 0.2,
      aggressionRadius: 22,
      blocking: 0.1,
      avoidance: 1.35,
      driftEagerness: 1.05,
      driftTierTarget: 2,
      chaining: 0.85,
      errorAmp: 0.045,
      errorFreq: 0.4,
      apexMiss: 0.4,
      mistakeRate: 0.02,
      reactionTime: 0.3,
      itemSkill: 0.3,
      shieldTendency: 0.15,
      itemImpatience: 0.9,
    },
  ),

  chaotic: make(
    'chaotic',
    'Loose Cannon',
    'Runs wide, runs deep, occasionally runs off. Fires items at nothing in particular and ' +
      'somehow finishes fourth.',
    {
      lineBias: 0.6,
      lineSwitchiness: 1.0,
      laneTolerance: 2.4,
      paceFactor: 0.985,
      brakeMargin: 0.95,
      aggression: 0.75,
      aggressionRadius: 36,
      blocking: 0.35,
      avoidance: 0.7,
      driftEagerness: 1.2,
      driftTierTarget: 1,
      chaining: 0.4,
      errorAmp: 0.24,
      errorFreq: 1.15,
      apexMiss: 2.6,
      mistakeRate: 0.22,
      reactionTime: 0.5,
      itemSkill: 0.35,
      shieldTendency: 0.25,
      itemImpatience: 0.95,
    },
  ),

  rival: make(
    'rival',
    'The Rival',
    'Deliberately races you and nobody else. Matches your pace corner for corner, saves its ' +
      'best item for the moment you get alongside.',
    {
      lineBias: -0.2,
      lineSwitchiness: 0.7,
      paceFactor: 1.0,
      brakeMargin: 0.97,
      aggression: 0.8,
      aggressionRadius: 55,
      blocking: 0.7,
      avoidance: 0.7,
      driftEagerness: 1.12,
      driftTierTarget: 3,
      chaining: 0.9,
      errorAmp: 0.075,
      errorFreq: 0.6,
      apexMiss: 0.8,
      mistakeRate: 0.055,
      reactionTime: 0.26,
      itemSkill: 0.95,
      shieldTendency: 0.7,
      itemImpatience: 0.2,
      matchesPlayer: 1,
    },
  ),

  cautious: make(
    'cautious',
    'Sunday Driver',
    'Brakes early, leaves room, never risks the kerb. Slow but almost impossible to make a ' +
      'mistake — you will pass it, and it will still be there at the flag.',
    {
      lineBias: 0.15,
      lineSwitchiness: 0.15,
      laneTolerance: 0.8,
      paceFactor: 0.945,
      brakeMargin: 1.22,
      aggression: 0.1,
      aggressionRadius: 20,
      blocking: 0.05,
      avoidance: 1.6,
      driftEagerness: 0.7,
      driftTierTarget: 1,
      chaining: 0.4,
      errorAmp: 0.055,
      errorFreq: 0.35,
      apexMiss: 0.6,
      mistakeRate: 0.015,
      reactionTime: 0.55,
      itemSkill: 0.5,
      shieldTendency: 0.8,
      itemImpatience: 0.15,
    },
  ),

  drifter: make(
    'drifter',
    'Powerslide',
    'Obsessed with mini-turbos. Drifts things that are barely corners, chains everything, and ' +
      'is terrifying on a twisty circuit.',
    {
      lineBias: -0.35,
      lineSwitchiness: 0.6,
      laneTolerance: 1.4,
      paceFactor: 1.0,
      brakeMargin: 0.94,
      aggression: 0.6,
      aggressionRadius: 32,
      blocking: 0.3,
      avoidance: 0.9,
      driftEagerness: 1.65,
      driftTierTarget: 3,
      chaining: 1.0,
      errorAmp: 0.085,
      errorFreq: 0.65,
      apexMiss: 1.0,
      mistakeRate: 0.07,
      reactionTime: 0.34,
      itemSkill: 0.75,
      shieldTendency: 0.4,
      itemImpatience: 0.45,
    },
  ),

  blocker: make(
    'blocker',
    'Roadblock',
    'Drives at your pace, in your line, on purpose. Weaves to cover both sides and drops ' +
      'bananas exactly where you were about to turn in.',
    {
      lineBias: -0.5,
      lineSwitchiness: 0.45,
      laneTolerance: 1.1,
      paceFactor: 0.965,
      brakeMargin: 1.04,
      aggression: 0.7,
      aggressionRadius: 30,
      blocking: 0.95,
      avoidance: 0.6,
      driftEagerness: 0.9,
      driftTierTarget: 2,
      chaining: 0.6,
      errorAmp: 0.08,
      errorFreq: 0.5,
      apexMiss: 0.9,
      mistakeRate: 0.05,
      reactionTime: 0.4,
      itemSkill: 0.8,
      shieldTendency: 0.9,
      itemImpatience: 0.2,
    },
  ),
};

/** Grid assignment order. Twelve karts, one player → eleven AI, so it repeats. */
export const PERSONALITY_ORDER: readonly PersonalityId[] = [
  'rival',
  'aggressive',
  'clean',
  'drifter',
  'defensive',
  'blocker',
  'chaotic',
  'cautious',
  'aggressive',
  'clean',
  'drifter',
  'chaotic',
];

/** Stable personality for a kart id (so replays and debug labels match). */
export function personalityForKart(kartId: number): Personality {
  const id = PERSONALITY_ORDER[Math.abs(kartId) % PERSONALITY_ORDER.length];
  return PERSONALITIES[id];
}

export function personalityById(id: string): Personality | null {
  return (PERSONALITIES as Record<string, Personality | undefined>)[id] ?? null;
}

export const PERSONALITY_IDS: readonly PersonalityId[] = Object.keys(
  PERSONALITIES,
) as PersonalityId[];

// ---------------------------------------------------------------------------
//  Error model
// ---------------------------------------------------------------------------

/**
 * The per-driver imperfection generator. Holds three independent noise
 * channels plus a mistake timer.
 */
export class ErrorModel {
  private readonly steerNoise: NoiseField;
  private readonly apexNoise: NoiseField;
  private readonly paceNoise: NoiseField;
  private readonly rng: NoiseField;

  /** Seconds remaining on the current mistake, 0 = none. */
  mistakeTime = 0;
  /** Signed magnitude of the current mistake, in steer units. */
  mistakeAmount = 0;
  /** 'wide' = missed the apex, 'brake' = braked too late, 'lift' = spooked. */
  mistakeKind: 'none' | 'wide' | 'brake' | 'lift' = 'none';
  private mistakeCooldown = 1.5;
  private phase: number;

  constructor(seed: number) {
    this.steerNoise = new NoiseField(seed * 7 + 11);
    this.apexNoise = new NoiseField(seed * 13 + 29);
    this.paceNoise = new NoiseField(seed * 19 + 47);
    this.rng = new NoiseField(seed * 23 + 71);
    this.phase = (seed % 97) * 3.37;
  }

  /**
   * Advance the model.
   * @param pressure 0..1 — how contested the driver's situation is.
   * @param skill    0..1 — 1 makes mistakes rare and small.
   */
  update(dt: number, elapsed: number, pressure: number, skill: number, p: Personality): void {
    if (this.mistakeTime > 0) {
      this.mistakeTime -= dt;
      if (this.mistakeTime <= 0) {
        this.mistakeTime = 0;
        this.mistakeKind = 'none';
        this.mistakeAmount = 0;
      }
      return;
    }
    if (this.mistakeCooldown > 0) {
      this.mistakeCooldown -= dt;
      return;
    }
    // Rate climbs steeply with pressure, falls with skill.
    const rate = p.mistakeRate * (0.35 + 1.65 * clamp01(pressure)) * (1.35 - 0.9 * clamp01(skill));
    if (rate <= 0) return;
    // Sample the noise as a pseudo-uniform so the whole model stays seeded.
    const u = (this.rng.at(elapsed * 3.1 + this.phase) + 1) * 0.5;
    if (u < rate * dt * 60) {
      const pick = (this.rng.at(elapsed * 7.7 + this.phase * 1.7) + 1) * 0.5;
      if (pick < 0.5) {
        this.mistakeKind = 'wide';
        this.mistakeTime = 0.55 + pick * 1.1;
        this.mistakeAmount = (pick < 0.25 ? -1 : 1) * (0.18 + pick * 0.5);
      } else if (pick < 0.8) {
        this.mistakeKind = 'brake';
        this.mistakeTime = 0.4 + (pick - 0.5) * 0.9;
        this.mistakeAmount = 0.35 + (pick - 0.5) * 0.6;
      } else {
        this.mistakeKind = 'lift';
        this.mistakeTime = 0.3 + (pick - 0.8) * 1.2;
        this.mistakeAmount = 0.4 + (pick - 0.8) * 1.5;
      }
      this.mistakeCooldown = 2.2 + u * 3.5;
    }
  }

  /** Time-varying steering error, in steer units. */
  steerError(elapsed: number, p: Personality, amplitudeScale: number): number {
    const n = this.steerNoise.at(elapsed * p.errorFreq + this.phase);
    let e = n * p.errorAmp * amplitudeScale;
    if (this.mistakeKind === 'wide') e += this.mistakeAmount;
    return e;
  }

  /** Slow lateral wander, metres. Produces the occasional missed apex. */
  apexError(elapsed: number, p: Personality, amplitudeScale: number): number {
    const n = this.apexNoise.at(elapsed * 0.17 + this.phase * 0.4);
    return n * p.apexMiss * amplitudeScale;
  }

  /** Slow pace wobble, multiplier around 1. */
  paceError(elapsed: number, amplitudeScale: number): number {
    return 1 + this.paceNoise.at(elapsed * 0.11 + this.phase * 0.9) * 0.022 * amplitudeScale;
  }

  /** True while the driver is braking too late / lifting off. */
  get brakingLate(): boolean {
    return this.mistakeKind === 'brake';
  }
  get lifting(): boolean {
    return this.mistakeKind === 'lift';
  }
}

// ---------------------------------------------------------------------------
//  Skill blending
// ---------------------------------------------------------------------------

export interface SkillProfile {
  /** Multiplier on the speed profile's target speed. */
  pace: number;
  /** Multiplier on all error amplitudes. */
  error: number;
  /** Multiplier on drift eagerness. */
  drift: number;
  /** Multiplier on reaction time. */
  reaction: number;
  /** Multiplier on item competence. */
  item: number;
  /** 0..1 — how tightly it holds the chosen line. */
  lineAccuracy: number;
  /** Multiplier on braking earliness. */
  brakeMargin: number;
}

/**
 * Fold a personality and a CC-class profile into the numbers the driver
 * actually reads each tick.
 */
export function blendSkill(p: Personality, cc: SkillProfile): SkillProfile {
  return {
    pace: p.paceFactor * cc.pace,
    error: cc.error,
    drift: p.driftEagerness * cc.drift,
    reaction: p.reactionTime * cc.reaction,
    item: p.itemSkill * cc.item,
    lineAccuracy: clamp01(cc.lineAccuracy * lerp(0.85, 1.15, 1 - clamp01(p.errorAmp / 0.25))),
    brakeMargin: p.brakeMargin * cc.brakeMargin,
  };
}
