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
 *    3. Mistake events — a Poisson process whose rate climbs with pressure
 *       (a kart alongside, a kart on the bumper, the player nearby). Under
 *       pressure, humans lock up. So do these.
 *
 *  ⚠️ 2026-08 (D2): mechanism 3 had NEVER FIRED. `ErrorModel.update` drew its
 *  Bernoulli sample from `NoiseField.at()` — smooth multi-octave gradient noise
 *  — as if it were `uniform(0,1)`. It is not: measured over 36 000 samples the
 *  minimum value is 0.147 and it never once goes below 0.02, while the trigger
 *  threshold is `rate·dt·60` ≤ 0.099 for every authored personality. Zero
 *  mistakes in 300 s × 8 personalities × 12 seeds. `mistakeRate`, `mistakeKind`,
 *  `brakingLate` and `lifting` were all dead. Event sampling now uses `Rand`
 *  (xorshift32, genuinely uniform); the *continuous* channels still use
 *  `NoiseField`, which is what it is good at.
 *
 *  PER-RACER FORM (also D2)
 *  ------------------------
 *  Eight personalities across eleven AI karts means clones. `DriverForm` adds a
 *  per-kart, per-RACE pace/mistake/error offset drawn from a seeded shuffle, so
 *  (a) two `clean` drivers are not identical and (b) the pecking order is not
 *  the same every race. `assignForms()` lays the pace offsets out as an EVEN
 *  ladder rather than 12 independent draws — independent draws clump, and a
 *  clump is exactly the "field travels as one block" defect.
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

/**
 * Genuinely uniform deterministic RNG (xorshift32). Used for *event* sampling —
 * anything of the form "does this happen this tick?" — because smooth noise is
 * catastrophically wrong for that: see the ⚠️ note at the top of this file.
 */
export class Rand {
  private s: number;

  constructor(seed: number) {
    this.s = (Math.floor(seed) * 2654435761) >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0,1). */
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.s = s;
    return s / 4294967296;
  }

  /** Uniform in [a,b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
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
  /**
   * Multiplier on the achievable pace. **1.0 = flat out** — the kart's own
   * `tuning.maxSpeed` and the racing line's profile, whichever is lower. Values
   * above 1.0 buy nothing (the chassis is the ceiling), so the authored ladder
   * runs DOWNWARD from 1.0: this is the primary dial that decides where a racer
   * sits in the field, and 1 % here is worth roughly 0.5 s a lap.
   *
   * It only started doing that in D2. Before, the target speed was the racing
   * line's own profile (≤36 m/s) with no reference to the kart, so every AI
   * asked for 33–37 m/s while topping out at 26–32: the throttle was saturated
   * 85–95 % of the lap and the multiplier was multiplying an unreachable number.
   * `cautious` (0.945, the slowest authored pace) posted the FASTEST mean lap of
   * the twelve. The ladder was inverted and 10 of 12 karts lapped within 1 s.
   */
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
  paceFactor: 0.985,
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
      paceFactor: 1.0,
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
      paceFactor: 0.955,
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
      paceFactor: 0.995,
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
      paceFactor: 0.965,
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
      paceFactor: 0.925,
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
      paceFactor: 0.985,
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
      paceFactor: 0.945,
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
export const MISTAKE = {
  /**
   * Global calibration on the authored `mistakeRate` values. Those numbers
   * describe the *relative* fallibility of the archetypes, which is the design;
   * their absolute scale had never been calibrated because the sampler could not
   * fire (see the file header). At 1.0 the `chaotic` pair makes a mistake every
   * ~9 s — roughly one per corner, which reads as a broken AI. 0.28 gives about
   * five mistakes a race for `chaotic`, one for `clean` and none for `cautious`,
   * which is the "one corner in eight" the archetypes are written to.
   */
  rateScale: 0.28,
  /** Shortest / longest a `wide` (missed apex) lasts, seconds. */
  wideSeconds: [0.34, 0.85] as const,
  /** Extra steer units held during a `wide`. Enough to cost time, not the race. */
  wideAmount: [0.10, 0.27] as const,
  /** `brake` = braked too late: carries 14 % too much speed for this long. */
  brakeSeconds: [0.35, 0.8] as const,
  /** `lift` = spooked, backs out of the throttle. */
  liftSeconds: [0.3, 0.8] as const,
  /** Enforced quiet time after a mistake, seconds. */
  cooldown: [1.6, 4.2] as const,
} as const;

export class ErrorModel {
  private readonly steerNoise: NoiseField;
  private readonly apexNoise: NoiseField;
  private readonly paceNoise: NoiseField;
  /** Event sampling. Deliberately NOT a NoiseField — see the file header. */
  private rand: Rand;

  /** Seconds remaining on the current mistake, 0 = none. */
  mistakeTime = 0;
  /** Signed magnitude of the current mistake, in steer units. */
  mistakeAmount = 0;
  /** 'wide' = missed the apex, 'brake' = braked too late, 'lift' = spooked. */
  mistakeKind: 'none' | 'wide' | 'brake' | 'lift' = 'none';
  /** Lifetime count, for probes and the debug overlay. */
  mistakeCount = 0;
  /** Per-racer multiplier on the mistake rate (`DriverForm.mistake`). */
  rateScale = 1;
  private mistakeCooldown = 1.5;
  private phase: number;

  constructor(seed: number) {
    this.steerNoise = new NoiseField(seed * 7 + 11);
    this.apexNoise = new NoiseField(seed * 13 + 29);
    this.paceNoise = new NoiseField(seed * 19 + 47);
    this.rand = new Rand(seed * 23 + 71);
    this.phase = (seed % 97) * 3.37;
  }

  /** Re-seed the event stream (new race) without disturbing the noise phases. */
  reseed(seed: number): void {
    this.rand = new Rand(seed * 23 + 71);
    this.mistakeTime = 0;
    this.mistakeKind = 'none';
    this.mistakeAmount = 0;
    this.mistakeCooldown = 1.5;
    this.mistakeCount = 0;
  }

  /**
   * Advance the model. No longer takes `elapsed`: the event sampler is a proper
   * RNG now, not a function of the clock (which is what made it never fire).
   * @param pressure 0..1 — how contested the driver's situation is.
   * @param skill    0..1 — 1 makes mistakes rare and small.
   */
  update(dt: number, pressure: number, skill: number, p: Personality): void {
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
    // Rate climbs steeply with pressure, falls with skill. Units: per second.
    const rate =
      p.mistakeRate *
      MISTAKE.rateScale *
      this.rateScale *
      (0.35 + 1.65 * clamp01(pressure)) *
      (1.35 - 0.9 * clamp01(skill));
    if (rate <= 0) return;
    if (this.rand.next() < rate * dt) {
      const pick = this.rand.next();
      const r = this.rand.next();
      if (pick < 0.5) {
        this.mistakeKind = 'wide';
        this.mistakeTime = lerp(MISTAKE.wideSeconds[0], MISTAKE.wideSeconds[1], r);
        this.mistakeAmount =
          (this.rand.next() < 0.5 ? -1 : 1) *
          lerp(MISTAKE.wideAmount[0], MISTAKE.wideAmount[1], r);
      } else if (pick < 0.8) {
        this.mistakeKind = 'brake';
        this.mistakeTime = lerp(MISTAKE.brakeSeconds[0], MISTAKE.brakeSeconds[1], r);
        this.mistakeAmount = 0;
      } else {
        this.mistakeKind = 'lift';
        this.mistakeTime = lerp(MISTAKE.liftSeconds[0], MISTAKE.liftSeconds[1], r);
        this.mistakeAmount = 0;
      }
      this.mistakeCount++;
      this.mistakeCooldown = lerp(MISTAKE.cooldown[0], MISTAKE.cooldown[1], this.rand.next());
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

/**
 * Per-racer, per-RACE variation. Eight personalities have to cover eleven AI
 * karts, so without this the roster contains literal clones — and a field of
 * clones is a field with no gaps in it.
 *
 * `pace` is laid out as an even ladder by `assignForms()` rather than drawn
 * independently per kart: twelve independent draws clump (that is what a normal
 * distribution does), and a clump of five karts on identical pace is a train the
 * player cannot pass and cannot rejoin once knocked out of it.
 */
export interface DriverForm {
  /** Multiplier on pace. Always ≤ 1 — nobody is faster than their own chassis. */
  pace: number;
  /** Multiplier on the mistake rate. */
  mistake: number;
  /** Multiplier on steering/apex error amplitude. */
  error: number;
  /** Multiplier on drift eagerness. */
  drift: number;
}

export const NEUTRAL_FORM: DriverForm = { pace: 1, mistake: 1, error: 1, drift: 1 };

export const FORM = {
  /**
   * Fraction of pace between one rung of the field's ladder and the next.
   * `AIManager` turns this into an even ladder of *effective* cruise speeds and
   * then solves each racer's `pace` backwards from its own chassis, so the ladder
   * survives the roster's 20 % top-speed spread instead of being cancelled by it.
   *
   * Measured sensitivity on both shipping circuits: 1 % of pace ≈ 0.55 % of lap
   * time ≈ 0.32 s. So 0.011 per rung ≈ 0.35 s a lap between neighbours, which is
   * about 9 m of gap growth per lap — enough that a hit costs two or three
   * places instead of eight, and enough that the kart ahead of the player is
   * genuinely catchable.
   */
  ladderStep: 0.011,
  /** Nobody is asked to drive slower than this fraction of their own pace. */
  paceFloor: 0.86,
  /**
   * How much the rung order is allowed to disagree with the authored order.
   * The ladder is assigned by sorting on `chassis × paceFactor × (1 ± this)`, so
   * a `cautious` driver usually gets a slow rung and an `aggressive` one usually
   * gets a quick rung — but not always, and not the same way twice.
   */
  orderJitter: 0.05,
  /** Legacy even-ladder width, used when no chassis information is available. */
  paceLadder: 0.03,
  /** Random jitter added on top of the ladder rung, ± this fraction. */
  paceJitter: 0.004,
  mistakeRange: [0.55, 1.6] as const,
  errorRange: [0.82, 1.22] as const,
  driftRange: [0.88, 1.12] as const,
} as const;

/**
 * Deterministic per-kart form for a whole field.
 *
 * @param kartIds every kart in the race (the player included — they get a
 *                neutral rung, they are not driven by this)
 * @param seed    the race seed. Same seed ⇒ same field, so replays and probes
 *                are reproducible; a new seed each race is what makes the
 *                pecking order stop being identical every single time.
 */
export function assignForms(
  kartIds: readonly number[],
  seed: number,
  playerId = -1,
): Map<number, DriverForm> {
  const rand = new Rand(seed || 1);
  const ids = kartIds.filter((id) => id !== playerId);
  // Seeded Fisher-Yates: which racer gets which rung of the ladder.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand.next() * (i + 1));
    const t = ids[i];
    ids[i] = ids[j];
    ids[j] = t;
  }
  const out = new Map<number, DriverForm>();
  const n = Math.max(1, ids.length - 1);
  for (let i = 0; i < ids.length; i++) {
    const rung = i / n; // 0 = quickest rung, 1 = slowest
    out.set(ids[i], {
      pace:
        1 -
        rung * FORM.paceLadder +
        (rand.next() * 2 - 1) * FORM.paceJitter,
      mistake: lerp(FORM.mistakeRange[0], FORM.mistakeRange[1], rand.next()),
      error: lerp(FORM.errorRange[0], FORM.errorRange[1], rand.next()),
      drift: lerp(FORM.driftRange[0], FORM.driftRange[1], rand.next()),
    });
  }
  if (playerId >= 0) out.set(playerId, NEUTRAL_FORM);
  return out;
}

/**
 * Personalities for a whole field, shuffled per race. One `rival` always
 * exists (it is the one that races the human); everybody else is drawn from the
 * remaining archetypes without repeating until the pool is exhausted, so a
 * twelve-kart grid gets maximum variety rather than four duplicated pairs.
 */
export function assignPersonalities(
  kartIds: readonly number[],
  seed: number,
  playerId = -1,
): Map<number, Personality> {
  const rand = new Rand((seed || 1) * 7919 + 13);
  const ids = kartIds.filter((id) => id !== playerId);
  const out = new Map<number, Personality>();
  if (ids.length === 0) return out;

  // The rival goes to a random grid slot, not always kart 1.
  const rivalIdx = Math.floor(rand.next() * ids.length);
  out.set(ids[rivalIdx], PERSONALITIES.rival);

  const pool: PersonalityId[] = [];
  const refill = (): void => {
    const rest = PERSONALITY_IDS.filter((p) => p !== 'rival');
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(rand.next() * (i + 1));
      const t = rest[i];
      rest[i] = rest[j];
      rest[j] = t;
    }
    for (const p of rest) pool.push(p);
  };
  for (let i = 0; i < ids.length; i++) {
    if (i === rivalIdx) continue;
    if (pool.length === 0) refill();
    out.set(ids[i], PERSONALITIES[pool.shift() as PersonalityId]);
  }
  return out;
}

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
 * Fold a personality, a CC-class profile and this racer's form into the numbers
 * the driver actually reads each tick.
 */
export function blendSkill(
  p: Personality,
  cc: SkillProfile,
  form: DriverForm = NEUTRAL_FORM,
): SkillProfile {
  return {
    pace: p.paceFactor * cc.pace * form.pace,
    error: cc.error * form.error,
    drift: p.driftEagerness * cc.drift * form.drift,
    reaction: p.reactionTime * cc.reaction,
    item: p.itemSkill * cc.item,
    lineAccuracy: clamp01(cc.lineAccuracy * lerp(0.85, 1.15, 1 - clamp01(p.errorAmp / 0.25))),
    brakeMargin: p.brakeMargin * cc.brakeMargin,
  };
}
