/**
 * ============================================================================
 *  FOXY KART — AI DRIVER
 * ============================================================================
 *  One instance per computer-controlled kart. Reads `KartState` (+ the racing
 *  line, the field, and the hazard list) and writes a control vector that is
 *  indistinguishable in shape from the human `InputState`.
 *
 *  THE FIVE LOOPS, in the order they run each tick
 *  -----------------------------------------------
 *  1. PERCEPTION   — where am I on the line, who is near me, what is ahead.
 *  2. TACTICS      — which line (optimal / inside / outside / shortcut), how
 *                    much lateral bias for avoidance and blocking.
 *  3. STEERING     — pure pursuit to a lookahead point (≈0.55 s of travel,
 *                    clamped 6–28 m) plus a PD correction on lateral error,
 *                    then a low-pass so the output never twitches.
 *  4. SPEED        — PI with anti-windup on (targetSpeed − speed), where
 *                    targetSpeed comes from the line's speed profile.
 *  5. DRIFT+ITEMS  — corner detection from the curvature integral, hop/hold/
 *                    release for mini-turbos, and item use behind a human
 *                    reaction delay.
 *
 *  Plus a recovery state machine that owns the kart completely when it is
 *  stuck, backwards, or off in the scenery.
 *
 *  Zero allocation per tick: every vector and sample object is created in the
 *  constructor.
 * ============================================================================
 */

import * as THREE from 'three';
import type { KartState, WallHit } from '@/core/Types';
import { DriftStage, ItemType, SurfaceType } from '@/core/Types';
import { clamp, clamp01, damp, lerp, sign, smoothstep } from '@/core/MathUtils';
import {
  RacingLine,
  createCurvatureWindow,
  createLineSample,
  createNearestResult,
  type CurvatureWindow,
  type LineSample,
  type LineVariant,
  type NearestResult,
} from './RacingLine';
import {
  ErrorModel,
  NEUTRAL_FORM,
  blendSkill,
  type DriverForm,
  type Personality,
  type PersonalityId,
  type SkillProfile,
} from './AIPersonality';
import type { BandOutput } from './Rubberband';
import { createBandOutput } from './Rubberband';

// ---------------------------------------------------------------------------
//  Tuning
// ---------------------------------------------------------------------------

export const STEER = {
  /** Lookahead time, seconds of travel. */
  lookaheadSeconds: 0.55,
  lookaheadMin: 6,
  lookaheadMax: 28,
  /** Overall pure-pursuit gain. */
  ppGain: 1.15,
  /**
   * Yaw authority estimate, rad/s at full lock, low speed. Fallback only, used
   * when `setChassis()` has never been called and we do not know the kart's own
   * `turnRate`. See `authority*` below.
   */
  yawAuthority: 2.6,
  /**
   * ⚠️ THE STEERING MODEL — this is where "the AI repeatedly crashes into walls
   * at turns" came from, and it was not a skill setting.
   *
   * Pure pursuit computes a required path curvature κ and converts it to a steer
   * command by DIVIDING by the chassis' yaw authority at the current speed. Get
   * that divisor wrong and every steer command is wrong by the same ratio — the
   * loop cannot notice, because it has no other estimate to compare against.
   *
   * The old model was `2.6 · (0.55 + 0.45/(1 + 0.04 v))`: a constant 2.6 for
   * every kart on the grid, with a gentle `1/(1+kv)` falloff that bottomed out at
   * 55 % of full authority. The physics uses a SQUARE falloff and scales by the
   * kart's own `turnRate` (2.10–3.06 rad/s across the roster). Measured
   * open-loop, full lock, on the real `PhysicsWorld`
   * (`.probe-tmp/yawcurve.ts`, and `yawlin.ts` confirms yaw is linear in steer to
   * within 0.4 %, so the full-lock value IS the gain the divisor wants):
   *
   *     v (m/s)      5     10     15     20     25     28     32     36
   *     nova      1.564  1.380  1.245  1.143  1.065  1.031  1.014  1.002
   *     blitz     1.453  1.252  1.106  0.998  0.917  0.878  0.845  0.833
   *     old est.  2.405  2.266  2.161  2.080  2.015  1.982  1.943  1.910
   *     ratio     1.5x   1.6x   1.7x   1.8x   1.9x   1.9-2.3x     1.9-2.3x
   *
   * So at racing speed the AI believed it had roughly TWICE the yaw it has, and
   * commanded roughly half the steer a corner needed. The only thing left to make
   * up the difference was the PD term on lateral error, at `kP = 0.062` per
   * metre — which closes the loop only once the kart is ~4–9 m off its line. That
   * is precisely what the field did: measured, 100 % of AI wall contacts happened
   * with |lateral error| > 4 m, mean 8.8 m, while not drifting, with no mistake in
   * flight and no avoidance bias. The authored racing line keeps 2.78–6.00 m from
   * every barrier on all three circuits (`.probe-tmp/lineclear.ts`), so a kart
   * 8.8 m off the line is in the wall by construction.
   *
   * `authority = turnRate · (floor + gain/(1 + (v/ref)²)) · safety`, fitted to the
   * table above: within 0.01 of `nova` from 5 to 36 m/s. `safety` is deliberately
   * BELOW 1 so the residual error is on the side of commanding slightly too much
   * steer — the deadband and the PD term trim an over-command harmlessly, whereas
   * an under-command is the bug above.
   */
  authorityFloor: 0.34,
  authorityGain: 0.28,
  authorityRef: 14,
  authoritySafety: 0.95,
  /**
   * A committed drift buys extra yaw (`KartTuning.driftTurnBonus`, 0.28–0.62), so
   * the divisor is larger while sliding. Modelled as a flat bonus rather than read
   * per-kart: it only has to stop the controller sawing at the drift transition.
   */
  driftAuthorityBonus: 1.3,
  /** Speed used when the kart is nearly stationary, m/s. */
  minPursuitSpeed: 6,
  /** PD on lateral error: proportional term, steer units per metre. */
  kP: 0.062,
  /** PD derivative term, steer units per (m/s). */
  kD: 0.075,
  /** Low-pass half-life on the steer output, seconds. */
  smoothHalfLife: 0.045,
  /** Extra inward bias while drifting, keeps the arc tight. */
  driftBias: 0.16,
  /** Bias forced during hop so the physics latches the right drift side. */
  hopBias: 0.42,
} as const;

export const SPEED = {
  /** Holding throttle at zero error. */
  bias: 0.36,
  /** Proportional gain, per m/s of error. */
  kP: 0.55,
  /** Integral gain. */
  kI: 0.35,
  /** Integral clamp (contribution = clamp * kI). */
  iClamp: 2.0,
  /** Brake command per unit of negative controller output. */
  brakeGain: 0.9,
  /** Seconds of travel used to look up the braking target. */
  targetLead: 0.42,
  /** Extra seconds of lead applied by `brakeMargin`. */
  targetLeadMax: 1.4,
  /**
   * Brake authority while drifting. Was 0 — "you hold the throttle through a
   * slide" — and that single line was where the pace ladder went to die: the AI
   * begins its drift ~0.8 s before the corner, i.e. across the whole braking
   * zone, so with the throttle floored at 0.85 and the brake forbidden, every
   * kart arrived at every apex at the same grip-limited speed no matter what
   * speed it had asked for. `paceFactor` could only act on the straights, and
   * seven of twelve karts lapped within 0.9 s of each other.
   *
   * Braking does not cancel a drift (`cancelDrift` only fires on stun, respawn
   * or an explicit break) and drift charge is a function of steer angle and
   * speed ratio, not throttle — so a brake-drift still earns its mini-turbo.
   */
  driftBrakeCap: 0.3,
  /** Only brake-drift when this far over the corner target, m/s. */
  driftBrakeDeadband: 1.2,
  /** Throttle floor while drifting at or under the target. */
  driftThrottleFloor: 0.85,
  /** …and while carrying too much speed for the corner we want. */
  driftThrottleEase: 0.45,
  /** Off-road: pull the target down so they don't fight the surface. */
  offRoadTargetMul: 0.82,
  /**
   * The target speed is capped at the kart's OWN `tuning.maxSpeed` × this before
   * the pace multiplier is applied, so `paceFactor` scales something the kart can
   * actually reach. A little headroom keeps the PI controller from sagging under
   * the cap on a long straight; it cannot make a kart exceed its tuning, because
   * the physics enforces that separately.
   *
   * WHY: without this the AI asked the racing line for 33–37 m/s while its
   * chassis topped out at 26–32, so the throttle was pinned at 1.0 for 85–95 %
   * of the lap and every pace/handling/traction difference in the roster was
   * quantised away. Measured: 10 of 12 karts within 1 s a lap.
   *
   * Keep this within a whisker of 1.0. At 1.02 every pace above 0.98 saturated
   * again and the top four rungs of the ladder collapsed back into one clump.
   */
  capHeadroom: 1.005,
  /**
   * Corner-speed confidence from the chassis: `base + handling·h + traction·t`,
   * clamped to `[cornerMin, 1]`. Capped at 1 because the racing line's profile
   * is already optimistic (30 m/s² of lateral budget) — nobody should be asking
   * for MORE than it, which is how Pip ended up 19 s per race in the dirt.
   * A 0.28-handling kart (Blitz) asks ~2.4 % less through a corner than a
   * 1.0-handling one (Vex), which is the whole "corners like a fridge" archetype.
   */
  cornerBase: 0.94,
  cornerHandling: 0.07,
  cornerTraction: 0.04,
  cornerMin: 0.93,
  /**
   * ⚠️ GRIP IS NOT THE LIMIT — STEERING IS.
   *
   * `RacingLine` builds its speed profile from `v = sqrt(latAccel/κ)` with
   * `latAccel = 30 m/s²`. The tyre model would allow that (`PHYS.latAccel` is 55),
   * but the chassis cannot ASK for it: yaw authority falls off with speed, so the
   * lateral acceleration actually available is `v · yaw(v)`, measured
   * (`.probe-tmp/yawcurve.ts`):
   *
   *     v (m/s)      5     10     15     20     25     28     32     36
   *     nova       7.8   13.8   18.7   22.9   26.6   28.9   32.4   36.1
   *     blitz      7.3   12.5   16.6   20.0   22.9   24.6   27.0   29.9
   *
   * So 30 m/s² is reachable only above ~28.5 m/s on `nova` and not at all below
   * 36 m/s on `blitz`. Every corner slower than that, the line asks for a speed
   * the chassis physically cannot turn at — the kart arrives at full lock and
   * runs wide, which is the residual after the steering model was fixed.
   *
   * The cap is applied PER DRIVER rather than by lowering the line's `latAccel`,
   * for two reasons: the line is shared by the whole grid, and solving it against
   * each kart's own `turnRate` makes cornering ability track the roster's handling
   * spread (2.10–3.06 rad/s, a 46 % range) instead of `cornerAbility`'s 7 %. That
   * ADDS authored differentiation — "Blitz corners like a fridge" becomes true in
   * the numbers — rather than flattening the field.
   *
   * `v ≤ yaw(v)/κ` is monotone on both sides, so three fixed-point steps converge.
   */
  yawLimitMargin: 0.97,
  yawLimitIterations: 3,
  /**
   * ⚠️ THE OVERSPEED BRAKE LICENCE — this is `volcanoRush`, and it is the whole
   * of the "3x worse than any other circuit" gap.
   *
   * `lineLimited` licenses the brake (`if (!lineLimited) c.brake = 0`) and gates
   * the boost override. It means "the racing line, not my own cruise ceiling, is
   * what is holding me back" — i.e. "a corner is binding". It is FALSE for
   * 96–98 % of the lap on EVERY circuit, because `RacingLine` builds its profile
   * from `sqrt(30/κ)` capped at 36 m/s while the roster cruises at 26.4–30.4, so
   * the cruise ceiling is what binds almost everywhere. That is normally
   * harmless: at 1–3 m/s over your own target, lifting is the right answer.
   *
   * It stops being harmless when a boost pad sits in front of a corner. Measured,
   * `volcanoRush` seed 12345 (`.probe-tmp/volctraj.ts`), the rival on the spiral:
   *
   *     arc 830  boost pad, surface=Boost      28.8 m/s   target 30.1  accel 1.00 brake 0.00
   *     arc 846                                43.9 m/s   target 30.2  accel 1.00 brake 0.00
   *     arc 858                                47.8 m/s   target 30.2  accel 1.00 brake 0.00
   *     arc 870  boost expired                 40.7 m/s   target 30.2  accel 0.00 brake 0.00  <-- !
   *     arc 880  SPIRAL entry, R 44 m          32.2 m/s   ... 11 m wide to the OUTSIDE
   *     arc 946  inside guardrail              21.5 m/s   full opposite lock, contact
   *
   * The PI controller wanted `brake = 1` from arc 846 on — 17.6 m/s of error —
   * and `if (!lineLimited) c.brake = 0` threw it away for 40 m, then the kart
   * coasted into a 360° R 44–51 m helix whose racing line is pinned to the inside
   * edge with 4.2 m of clearance, ran wide, corrected at full lock, crossed the
   * whole 19 m road and speared the inside rail. All four of volcano's boost pads
   * are inside 140 m of a corner tighter than R 120; 56 % of its wall contacts
   * happen with `boostTime > 0` against 35–47 % elsewhere.
   *
   * So: a driver may brake, whatever set the target, when it is travelling faster
   * than the corner AHEAD can physically be turned at. `v ≤ yaw(v)/κ` is the same
   * ceiling `yawLimitMargin` already solves, evaluated at the CURRENT speed rather
   * than at the target — the existing loop clamps every iterate to the target, so
   * it can only ever answer "is the target too fast", never "am I".
   *
   * This is a LICENCE, not a target. It never lowers `v`, so it cannot slow a
   * driver below its pace-ladder rung and it cannot fire at all while `speed ≤
   * target`. On a straight `κ→0`, the ceiling is unreachable and nothing happens,
   * which is what keeps "the battery gives acceleration but feels too weak" fixed:
   * a mushroom down a straight is still flat out and still pays out in full.
   *
   * The horizon is `DRIFT.farSeconds` of line — see the note at the test itself
   * for why the braking lead's 0.42 s cannot supply it and why the drift
   * detector's existing scan can, for free.
   */
  /** Fraction over the corner's yaw ceiling before the brake is licensed. */
  yawBrakeMargin: 1.04,
  /**
   * ∫κ ds over the near window above which a driver is "in a corner" and may not
   * change racing-line variant. See the note in `chooseVariant`. Its own constant
   * rather than a reuse of `DRIFT.exitIntegral` so the two can be measured apart.
   */
  variantCornerIntegral: 0.2,
  /**
   * Boost-into-a-corner. See the `st.boostTime` block in `applySpeedControl` for
   * why these exist and why lifting cannot waste a mini-turbo.
   *
   * `boostCornerDeadband` keeps the boost flat out through small overshoot;
   * `boostCornerThrottle` is the ceiling on engine drive once a corner is binding
   * (not zero, because the boost is still accelerating us and cutting the engine
   * entirely reads as a stall); `boostCornerBrakeCap` at `boostBrakeRamp` m/s of
   * excess is enough authority to actually shed a mini-turbo's 11 m/s of soft-cap
   * bonus before the apex.
   */
  boostCornerDeadband: 1.0,
  boostCornerThrottle: 0.35,
  boostCornerBrakeCap: 0.7,
  boostBrakeRamp: 6.0,
  /**
   * How much of the roster's authored top-speed spread the AI drives to.
   *
   * `CHARACTER_STATS.speed` spans 0.24–0.95, i.e. 26.4–31.8 m/s — a 20 % band,
   * which is far wider than any behavioural difference and swamps everything
   * else: measured, the three high-speed chassis (Blitz, Strata, Torque) lapped
   * 2.5–3 s clear of the other nine on BOTH circuits, in a group of their own,
   * every single race, whoever was driving them. That is not a field, it is a
   * two-tier field, and the lower tier can never rejoin the upper one after a
   * hit — which is the D2 complaint.
   *
   * So a CPU on a quick chassis is asked to cruise part-way between the field
   * reference and its own ceiling. 0.55 keeps just over half of the authored
   * spread — Blitz still has the highest top speed on the grid and still pulls
   * away down a straight — while leaving room for `paceFactor` and `DriverForm`
   * to decide the order. Slower-than-reference chassis are untouched: the blend
   * is applied with a `min()` against the kart's own ceiling, so nobody is ever
   * asked for a speed their tuning cannot produce.
   */
  chassisWeight: 0.55,
  /** Fallback field reference speed, m/s, until AIManager measures the grid. */
  fieldReference: 28.5,
} as const;

/**
 * Who counts as "pressure". Being chased makes a driver crack; chasing does not.
 */
export const PRESSURE = {
  radius: 18,
  behind: 0.62,
  alongside: 0.5,
  ahead: 0.14,
  /** The human is worth this much more than another CPU. */
  playerFactor: 1.6,
} as const;

/** How long a defensive driver may hold a chaser off before it runs out of ideas. */
export const BLOCK = {
  /** Lateral metres of cover at full commitment (was an uncapped 2.3). */
  strength: 1.55,
  /** Seconds of continuous blocking before the AI gives up the line. */
  maxSeconds: 2.4,
  /** …and then leaves the door open for this long. */
  restSeconds: 2.8,
  /** Weave amplitude for the `blocker` archetype, metres. */
  weave: 1.1,
} as const;

export const DRIFT = {
  /** Far window for "is there a sustained corner coming", seconds of travel. */
  farSeconds: 1.9,
  farMin: 18,
  farMax: 66,
  /** Near window for "am I close enough to commit". */
  nearSeconds: 0.8,
  nearMin: 8,
  nearMax: 28,
  /** ∫κ ds over the far window, radians, to trigger a drift. */
  enterIntegral: 0.62,
  /** Fraction of `enterIntegral` the near window must also show. */
  nearFraction: 0.34,
  /** ∫κ ds below which the corner is over. */
  exitIntegral: 0.2,
  /** Minimum speed to bother drifting, m/s. */
  minSpeed: 8.5,
  /** Seconds after a release before another drift may start. */
  cooldown: 0.1,
  /** Give up waiting for the physics to confirm the drift after this long. */
  hopTimeout: 0.55,
  /** Hold past the corner exit by at most this long to reach the target tier. */
  maxOvershoot: 0.5,
  /** Ticks the drift button must be released for the boost to register. */
  releaseSeconds: 0.09,
  /** Window in which an opposite-direction corner counts as a chain. */
  chainSeconds: 0.09,
  /**
   * Bail out of a drift with this much road left, metres — plus `bailLead`
   * seconds of travel, because a sliding kart cannot stop being where it is
   * going. 0.6 m flat was far too late at 27 m/s: measured, drifting was the
   * dominant cause of AI incompetence, accounting for 10.1 of the 10.3 seconds
   * per race each CPU spent off the road (a no-drift control run: 0.2 s), and
   * the excursions cost 1.6 s a lap — more than the mini-turbos paid back.
   *
   * That noise was also the single biggest term in AI lap time, which is why
   * the field looked "randomly different" rather than "authored different":
   * with drifting disabled the lap-time range collapsed from 8.0 s to 4.2 s and
   * what remained tracked the roster's top speeds cleanly.
   */
  bailMargin: 1.5,
  bailLead: 0.055,
  /** Road needed before starting a drift at all, metres + `bailLead` seconds. */
  entryMargin: 2.4,
} as const;

export const AVOID = {
  /** Forward probe length, seconds of travel. */
  probeSeconds: 1.05,
  probeMin: 7,
  probeMax: 34,
  /** Lateral half-width of the kart probe corridor, metres. */
  kartCorridor: 2.6,
  /** Strength of the lateral push away from a kart, metres. */
  kartStrength: 3.1,
  /** Hazards get a tighter corridor but a harder push. */
  hazardPad: 1.7,
  hazardStrength: 4.2,
  /** Maximum total avoidance bias, metres. */
  maxBias: 4.6,
  /** How fast the bias decays back to the line. */
  halfLife: 0.2,
  /** Rear detection range for blocking, metres. */
  rearRange: 16,
} as const;

/**
 * WALL PROXIMITY — the term that was missing entirely.
 *
 * Nothing in the AI ever asked the track where the barriers are. There was no
 * steering term that pushed away from a wall, and no term that survived the
 * bounce, so a kart that arrived at a corner wide simply kept arriving at that
 * corner wide: measured on `neonMetropolis`, one kart made 73 wall contacts in a
 * 3-lap race, 17 of them inside the same 40 m of road.
 *
 * `ITrackService.collideWalls(position, radius)` is a plane test in the road's own
 * frame — no mesh, no raycast (see `Track.collideWalls`) — so two probes per kart
 * per tick is affordable for eleven karts. Both probes are needed:
 *
 *   • the LEAD probe looks `leadSeconds` of travel up the road and steers away
 *     before the contact happens, which is what stops the corner-entry hit;
 *   • the NOW probe reports contact that is already happening, which is what
 *     survives the bounce — without it the lead probe goes quiet the instant the
 *     kart is against the barrier (the wall is no longer *ahead* of it) and the
 *     controller goes straight back to aiming at a line on the far side of it.
 */
export const WALL = {
  /** Seconds of travel to the lead probe. */
  leadSeconds: 0.42,
  leadMin: 3.5,
  leadMax: 14,
  /** Added to the chassis half-width for the probe sphere, metres. */
  leadMargin: 1.5,
  /** …and for the contact-now probe. Small: this one asks "am I touching?". */
  nowMargin: 0.22,
  /** Lateral push away from a lead-probe wall at full depth, metres. */
  leadStrength: 3.4,
  /** …and from a wall we are already against. Deliberately stronger. */
  nowStrength: 4.6,
  /** Cap on the wall term alone, metres. Outranks the avoidance cap. */
  maxBias: 5.5,
  /** Half-life of the wall bias, seconds. Short — this is a reflex. */
  halfLife: 0.1,
  /**
   * Speed the target is scaled to while a wall is dead ahead and we are pointed
   * at it. A kart that is about to understeer into a barrier should lift; this is
   * the smallest amount of "slow down" that breaks the limit cycle without
   * touching the pace ladder, and it only fires when a barrier is actually inside
   * the lead probe.
   */
  speedCut: 0.82,
  /**
   * Height above the road plane at which the lead probe is placed, metres. A kart
   * sits ~0.45 m up; `Track.collideWalls` gates on the query being inside the
   * barrier's vertical band, so this has to be a road-relative height, not the
   * kart's raw world y projected forwards.
   */
  probeHeight: 0.45,
  /** `-forward·normal` above which we count as pointed INTO the wall. */
  noseInDot: 0.12,
  /** Continuous contact longer than this counts as pinned — see RECOVER. */
  pinSeconds: 0.9,
} as const;

export const RECOVER = {
  stuckSpeed: 1.6,
  stuckSeconds: 1.5,
  wrongWaySeconds: 1.2,
  offTrackSeconds: 1.8,
  reverseSeconds: 0.85,
  realignSeconds: 2.6,
  /** Give up and ask for a respawn after this long in recovery. */
  giveUpSeconds: 5.5,
  /** Exit conditions. */
  exitAlignment: 0.55,
  exitSpeed: 4.0,
  /**
   * ARC-PROGRESS STUCK TEST — the honest one.
   *
   * `stuckSpeed` alone cannot see the failure the owner reported. A kart grinding
   * along a barrier, or shuttling in and out of the same corner, has plenty of
   * speed: measured over 260 s × 11 karts × 3 circuits, `stuckTimer` never once
   * reached `stuckSeconds` while two karts on `volcanoRush` completed ZERO laps in
   * the whole race and one on `neonMetropolis` spent 29 s off the road. Speed is
   * not progress. Progress is progress.
   *
   * So: unwrap arc length along the racing line and require real metres of it.
   * `arcWindow` seconds of travel must yield at least `arcMetres`, which at the
   * slowest authored pace (~24 m/s) is under 4 % of what a driving kart covers —
   * it can only fire on something genuinely pathological.
   */
  arcWindow: 2.0,
  arcMetres: 8.0,
  /** Seconds of clean racing needed to earn full `composure`. */
  composureSeconds: 6.0,
  /**
   * Barrier contacts, decaying at `contactDecay` per second, at which a driver is
   * treated as fully rattled and the rubber band stops pushing it. Three touches
   * inside ~12 s is "this driver cannot hold this corner", which is precisely the
   * behaviour the owner keeps reporting.
   */
  contactsForPanic: 2.0,
  /**
   * Decay per second. Deliberately slow — much slower than the first attempt,
   * which used 0.25/s and measured as a no-op (tokyoNeon 51 -> 51 contacts):
   * barrier contacts at this corner arrive about one per nine seconds, so at
   * 0.25/s the count had fully decayed before the next one landed and the gate
   * never accumulated past a single hit. At 0.06/s four touches inside ~35 s add
   * up, which is the timescale on which "this driver cannot hold this corner"
   * actually becomes true.
   */
  contactDecay: 0.06,
  /** Samples kept over `arcWindow`. Ring buffer, allocated once. */
  arcSamples: 16,
  /**
   * Shortest a recovery may last. Without it the machine flaps: measured on
   * `volcanoRush`, one kart entered `realign`, passed the exit test on the very
   * next tick (it was pointing forwards at 28 m/s, which is all the exit asks
   * for), returned to `race`, and drove off the road again — 76 times in one race.
   * Recovery has to be allowed to actually do something before it is graded.
   */
  minSeconds: 0.55,
  /**
   * Consecutive stuck entries before the driver gives up and asks to be
   * respawned. Decays at `streakDecay` per second, so three in a row means three
   * inside ~15 s, not three in a race.
   */
  streakForRespawn: 3,
  streakDecay: 0.2,
} as const;

export const ITEMS = {
  /** Red shell: fire at the kart ahead inside this range, metres. */
  redRange: 60,
  /** Green shell: forward range and alignment tolerance. */
  greenRange: 42,
  greenAlign: 0.15,
  /** Green/banana thrown backwards at a kart this close behind. */
  rearRange: 19,
  rearAlign: 0.3,
  /** Bomb throw range. */
  bombRange: 32,
  /** Boost: only on a straight (|∫κ| under this) or at a corner exit. */
  straightIntegral: 0.26,
  /** Boost: minimum speed ratio before using one on a straight. */
  boostMinRatio: 0.55,
  /** Star: use when this many karts are within `starRadius`. */
  starCrowd: 2,
  starRadius: 26,
  /** Maximum seconds a shell is held as a rear shield. */
  maxShieldSeconds: 14,
  /** Spacing between the three shots of a triple, seconds. */
  tripleSpacing: 0.34,
  /** Reaction delay clamps, seconds. */
  reactionMin: 0.2,
  reactionMax: 0.6,
} as const;

// ---------------------------------------------------------------------------
//  Shapes exchanged with AIManager
// ---------------------------------------------------------------------------

/** Exactly the shape `PhysicsWorld.setControl` expects. */
export interface AIControl {
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  driftPressed: boolean;
}

export function createControl(): AIControl {
  return { steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false };
}

/**
 * What the driver knows about the chassis it is sitting in. Supplied by
 * `AIManager` from `PhysicsWorld.tuningOf()`; defaults describe `nova`, so a
 * driver whose physics has no tuning query still behaves sanely.
 *
 * This exists because the AI used to drive every kart identically: the racing
 * line's speed profile is a property of the TRACK, and nothing told a 26.4 m/s
 * Pip that it was not a 31.7 m/s Blitz.
 */
export interface ChassisFacts {
  /** `tuning.maxSpeed`, m/s. */
  maxSpeed: number;
  /** 0..1 handling stat. */
  handling: number;
  /** 0..1 traction stat. */
  traction: number;
  /**
   * `tuning.turnRate` — chassis yaw rate at full lock, low speed, rad/s. The
   * roster spans 2.10–3.06, and the steering model divides by it, so a driver
   * that does not know its own value steers a 2.10 kart as if it were a 3.06 one.
   */
  turnRate: number;
  /** `tuning.halfExtents.x` — chassis half-width, metres. Sizes the wall probe. */
  radius: number;
}

export function defaultChassis(): ChassisFacts {
  return { maxSpeed: 28.4, handling: 0.55, traction: 0.55, turnRate: 2.6, radius: 0.72 };
}

/** A thing on the road the AI should not hit. */
export interface AIHazard {
  position: THREE.Vector3;
  radius: number;
  /** Free-form: 'banana' | 'shell' | 'bomb' | 'box' | … */
  kind: string;
  /** Who dropped it, if known. */
  ownerId: number;
  /** True for hazards that chase (shells) — worth dodging harder. */
  homing: boolean;
}

export function createHazard(): AIHazard {
  return {
    position: new THREE.Vector3(),
    radius: 1.2,
    kind: 'banana',
    ownerId: -1,
    homing: false,
  };
}

/**
 * The one thing the AI needs from the track service: a swept-sphere query against
 * the barriers. Declared structurally rather than as `ITrackService` so a harness
 * can hand in a stub, and so this file keeps compiling whatever else the track
 * service grows.
 */
export interface WallProbe {
  collideWalls(position: THREE.Vector3, radius: number): WallHit;
}

/** Everything a driver may read about the world, owned by AIManager. */
export interface DriverWorld {
  line: RacingLine;
  /**
   * Barrier queries. Optional so an existing harness still compiles; when it is
   * absent the wall-avoidance reflex is simply off, and `AIManager` always
   * supplies it in the real game.
   */
  walls?: WallProbe | null;
  karts: readonly KartState[];
  hazards: readonly AIHazard[];
  hazardCount: number;
  elapsed: number;
  raceStarted: boolean;
  /** Seconds until the lights go out; <= 0 once racing. */
  countdown: number;
  /** Progress (lap + t) of the human player, or -1 if there isn't one. */
  playerProgress: number;
  playerId: number;
  lapLength: number;
  fieldSize: number;
  /** Per-CC skill profile from Rubberband. */
  cc: SkillProfile;
}

export type DriveMode = 'grid' | 'race' | 'reverse' | 'realign';

export interface AIDebugState {
  kartId: number;
  personality: PersonalityId;
  label: string;
  enabled: boolean;
  mode: DriveMode;
  variant: LineVariant;
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  driftStage: number;
  driftPhase: string;
  speed: number;
  targetSpeed: number;
  lateralError: number;
  avoidBias: number;
  lookahead: THREE.Vector3;
  lookaheadDistance: number;
  cornerIntegral: number;
  miniTurbos: number;
  driftAttempts: number;
  risk: number;
  speedMul: number;
  pressure: number;
  stuckTimer: number;
  heldItem: number;
  itemPending: boolean;
  progress: number;
  lap: number;
  mistake: string;
  /** `DriverForm.pace` — which rung of this race's pace ladder this racer got. */
  form: number;
  /** Lifetime mistake count. */
  mistakes: number;
  /** Metres of lateral cover currently being used to defend the line. */
  blocking: number;
  /** The cruise ceiling this driver works to, m/s. */
  speedCap: number;
  /** Metres of lateral push currently coming from the wall reflex. */
  wallBias: number;
  /** Deepest barrier penetration the reflex saw this tick, metres. */
  wallDepth: number;
  /** Seconds of continuous barrier contact. */
  wallTouch: number;
  /** Times the honest stuck test has fired for this driver. */
  stuckEpisodes: number;
}

/** The subset of the item system the AI touches. Resolved at runtime. */
export interface ItemAccess {
  heldItem(kartId: number): ItemType | null;
  /** Returns metres to the incoming threat, or -1 when there is none. */
  threat(kartId: number): number;
  /** Fire / drop. `aimBack` requests a rearward throw. */
  use(kartId: number, aimBack: boolean, targetId: number): void;
  /** Optional explicit "hold behind me as a shield" hook. */
  hold(kartId: number, held: boolean): void;
}

/** No-op access used until the ItemSystem is wired. */
export const NULL_ITEMS: ItemAccess = {
  heldItem: () => null,
  threat: () => -1,
  use: () => undefined,
  hold: () => undefined,
};

// ---------------------------------------------------------------------------

type DriftPhaseAI = 'none' | 'hop' | 'hold' | 'release';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _wallPt = new THREE.Vector3();

export class AIDriver {
  readonly kartId: number;
  readonly control: AIControl = createControl();
  readonly debug: AIDebugState;

  personality: Personality;
  enabled = true;

  private state: KartState | null = null;
  private skill: SkillProfile;
  private readonly error: ErrorModel;
  private readonly band: BandOutput = createBandOutput();
  private form: DriverForm = NEUTRAL_FORM;
  private ccProfile: SkillProfile;
  private chassis: ChassisFacts = defaultChassis();
  /** Cached from `chassis`: what this kart may ask for through a corner. */
  private cornerAbility = 1;
  /**
   * Cached from `chassis` + the field reference: the cruise ceiling, m/s.
   *
   * Both of these are annotated `number` on purpose. `SPEED` is a `as const`
   * table, so `SPEED.fieldReference` carries the LITERAL type `28.5` — and an
   * un-annotated field initialised from it infers that literal, making every
   * later assignment a type error ("Type 'number' is not assignable to type
   * '28.5'"). The initialiser is a default, not a constraint.
   */
  private speedCap: number = SPEED.fieldReference;
  /** Median top speed of the grid, m/s. Set by AIManager. */
  private fieldRef: number = SPEED.fieldReference;
  /** Cached `chassis.turnRate × STEER.authoritySafety`. */
  private yawBase: number = STEER.yawAuthority * STEER.authoritySafety;
  /** Cached wall probe radii, metres. */
  private wallLeadRadius = 0.72 + WALL.leadMargin;
  private wallNowRadius = 0.72 + WALL.nowMargin;

  // ---- reusable query objects -------------------------------------------
  private readonly near: NearestResult = createNearestResult();
  private readonly aheadSample: LineSample = createLineSample();
  private readonly hereSample: LineSample = createLineSample();
  private readonly targetSample: LineSample = createLineSample();
  private readonly farWindow: CurvatureWindow = createCurvatureWindow();
  private readonly nearWindow: CurvatureWindow = createCurvatureWindow();
  /** Own sample object for the wall lead probe — see `updateWallAvoid`. */
  private readonly wallSample: LineSample = createLineSample();
  private readonly lookaheadPoint = new THREE.Vector3();

  // ---- steering state ----------------------------------------------------
  private steerSmooth = 0;
  private lateralPrev = 0;
  private hintStation = -1;

  // ---- speed state -------------------------------------------------------
  private speedIntegral = 0;
  /** True when the racing line, not the chassis ceiling, set the target speed. */
  private lineLimited = true;

  // ---- line choice -------------------------------------------------------
  private variant: LineVariant = 'optimal';
  private variantCooldown = 0;
  private variantShift = 0;
  private lastLineLateral = 0;

  // ---- avoidance ---------------------------------------------------------
  private avoidBias = 0;
  /** Lateral push away from a barrier, metres. See `WALL`. */
  private wallBias = 0;
  /** Multiplier the wall reflex is currently applying to the target speed. */
  private wallSpeedScale = 1;
  /** Seconds of continuous barrier contact. */
  private wallTouch = 0;
  /** Deepest barrier penetration seen this tick, metres. Debug only. */
  private wallDepth = 0;
  private blockBias = 0;
  private weavePhase = 0;
  /** Seconds spent actively covering the kart behind. */
  private blockTime = 0;
  /** Seconds left of "out of ideas, door open". */
  private blockRest = 0;

  // ---- drift -------------------------------------------------------------
  private driftPhase: DriftPhaseAI = 'none';
  private driftDir = 0;
  private driftTimer = 0;
  private driftCooldown = 0;
  private overshoot = 0;
  private chainTimer = 0;
  private chainDir = 0;
  private driftAttempts = 0;
  private miniTurbos = 0;
  private driftBoostSeconds = 0;

  // ---- recovery ----------------------------------------------------------
  private mode: DriveMode = 'grid';
  private stuckTimer = 0;
  private wrongWayTimer = 0;
  private offTrackTimer = 0;
  private modeTimer = 0;
  private recoverTotal = 0;
  private offTrackTotal = 0;
  private backwardsTotal = 0;
  /** Lifetime recovery seconds — `recoverTotal` is only the current episode. */
  private recoverLifetime = 0;
  /** Ring buffer of unwrapped arc length, metres. See `RECOVER.arcWindow`. */
  private readonly arcRing = new Float64Array(RECOVER.arcSamples);
  private arcRingFilled = 0;
  private arcRingHead = 0;
  private arcSampleTimer = 0;
  /** Unwrapped distance travelled along the line since `reset()`, metres. */
  private arcTravelled = 0;
  private arcPrev = -1;
  /** Seconds of "no meaningful arc progress". The honest stuck signal. */
  private noProgressTimer = 0;
  /** Lifetime counters, for probes and the debug overlay. */
  private stuckEpisodes = 0;
  private wallContacts = 0;
  /** Decaying count of recent stuck entries. See `RECOVER.streakForRespawn`. */
  private stuckStreak = 0;
  /** Seconds of uninterrupted ordinary racing. Feeds `composure`. */
  private settledFor = 0;
  /** Decaying count of recent barrier contacts. Also feeds `composure`. */
  private contactRate = 0;

  // ---- items -------------------------------------------------------------
  private items: ItemAccess = NULL_ITEMS;
  private itemTimer = 0;
  private itemPendingBack = false;
  private itemPendingTarget = -1;
  private itemPending = false;
  private holdTimer = 0;
  private tripleTimer = 0;
  private tripleLeft = 0;

  // ---- misc --------------------------------------------------------------
  private pressure = 0;
  private rocketOffset: number;
  private lapWatch = 0;

  constructor(kartId: number, personality: Personality, ccProfile: SkillProfile) {
    this.kartId = kartId;
    this.personality = personality;
    this.ccProfile = ccProfile;
    this.skill = blendSkill(personality, ccProfile, this.form);
    this.error = new ErrorModel(kartId + 1);
    // Rocket-start timing: good drivers nail it, chaotic ones bog down.
    this.rocketOffset =
      0.02 + (1 - clamp01(personality.itemSkill)) * 0.22 + (kartId % 5) * 0.012;

    this.debug = {
      kartId,
      personality: personality.id,
      label: personality.label,
      enabled: true,
      mode: 'grid',
      variant: 'optimal',
      steer: 0,
      accel: 0,
      brake: 0,
      drift: false,
      driftStage: 0,
      driftPhase: 'none',
      speed: 0,
      targetSpeed: 0,
      lateralError: 0,
      avoidBias: 0,
      lookahead: new THREE.Vector3(),
      lookaheadDistance: 0,
      cornerIntegral: 0,
      miniTurbos: 0,
      driftAttempts: 0,
      risk: 0,
      speedMul: 1,
      pressure: 0,
      stuckTimer: 0,
      heldItem: -1,
      itemPending: false,
      progress: 0,
      lap: 0,
      mistake: 'none',
      form: 1,
      mistakes: 0,
      blocking: 0,
      speedCap: SPEED.fieldReference,
      wallBias: 0,
      wallDepth: 0,
      wallTouch: 0,
      stuckEpisodes: 0,
    };
    // After `debug` exists — it writes into it.
    this.applyChassis();
  }

  // -------------------------------------------------------------------------
  //  Wiring
  // -------------------------------------------------------------------------

  setState(state: KartState): void {
    this.state = state;
  }

  setItems(access: ItemAccess): void {
    this.items = access;
  }

  setPersonality(p: Personality, ccProfile: SkillProfile): void {
    this.personality = p;
    this.ccProfile = ccProfile;
    this.skill = blendSkill(p, ccProfile, this.form);
    this.debug.personality = p.id;
    this.debug.label = p.label;
  }

  setCCProfile(ccProfile: SkillProfile): void {
    this.ccProfile = ccProfile;
    this.skill = blendSkill(this.personality, ccProfile, this.form);
  }

  /** Per-racer, per-race variation. See `DriverForm`. */
  setForm(form: DriverForm): void {
    this.form = form;
    this.skill = blendSkill(this.personality, this.ccProfile, form);
    this.error.rateScale = form.mistake;
    this.debug.form = form.pace;
  }

  get driverForm(): DriverForm {
    return this.form;
  }

  /** What chassis am I driving? Lets pace and corner confidence match the kart. */
  setChassis(facts: ChassisFacts): void {
    this.chassis.maxSpeed = facts.maxSpeed > 1 ? facts.maxSpeed : 28.4;
    this.chassis.handling = clamp01(facts.handling);
    this.chassis.traction = clamp01(facts.traction);
    this.chassis.turnRate = facts.turnRate > 0.5 ? facts.turnRate : STEER.yawAuthority;
    this.chassis.radius = facts.radius > 0.2 ? facts.radius : 0.72;
    this.applyChassis();
  }

  get chassisFacts(): ChassisFacts {
    return this.chassis;
  }

  /** Median top speed on the grid — the reference the chassis blend works from. */
  setFieldReference(refSpeed: number): void {
    this.fieldRef = refSpeed > 1 ? refSpeed : SPEED.fieldReference;
    this.applyChassis();
  }

  private applyChassis(): void {
    this.cornerAbility = clamp(
      SPEED.cornerBase +
        SPEED.cornerHandling * this.chassis.handling +
        SPEED.cornerTraction * this.chassis.traction,
      SPEED.cornerMin,
      1,
    );
    const own = this.chassis.maxSpeed;
    this.speedCap = Math.min(own, lerp(this.fieldRef, own, SPEED.chassisWeight));
    this.debug.speedCap = this.speedCap;
    this.yawBase = this.chassis.turnRate * STEER.authoritySafety;
    this.wallLeadRadius = this.chassis.radius + WALL.leadMargin;
    this.wallNowRadius = this.chassis.radius + WALL.nowMargin;
  }

  /**
   * Yaw rate this chassis can actually produce at `speed`, rad/s. Fitted to an
   * open-loop measurement of the real `PhysicsWorld` — see `STEER.authority*`,
   * which is also where the bug this replaced is written up.
   */
  private yawAuthorityAt(speed: number, drifting: boolean): number {
    const r = speed / STEER.authorityRef;
    const g = STEER.authorityFloor + STEER.authorityGain / (1 + r * r);
    const a = this.yawBase * g;
    return drifting ? a * STEER.driftAuthorityBonus : a;
  }

  /** The cruise ceiling this driver is working to, m/s. */
  get cruiseCap(): number {
    return this.speedCap;
  }

  /** New race: fresh mistake stream, same authored character. */
  reseed(seed: number): void {
    this.error.reseed(seed * 131 + this.kartId * 7 + 1);
  }

  get mistakeCount(): number {
    return this.error.mistakeCount;
  }

  /** Ground truth from the physics `kart:driftRelease` event. */
  notifyDriftRelease(tier: number, boostTime: number): void {
    if (tier >= 1 && boostTime > 0) {
      this.miniTurbos++;
      this.driftBoostSeconds += boostTime;
      this.debug.miniTurbos = this.miniTurbos;
    }
  }

  get band0(): BandOutput {
    return this.band;
  }

  get miniTurboCount(): number {
    return this.miniTurbos;
  }
  get driftAttemptCount(): number {
    return this.driftAttempts;
  }
  get boostSecondsEarned(): number {
    return this.driftBoostSeconds;
  }
  /** Seconds spent outside the road edge. */
  get offTrackSeconds(): number {
    return this.offTrackTotal;
  }
  /** Seconds spent pointing the wrong way. */
  get backwardsSeconds(): number {
    return this.backwardsTotal;
  }
  get recoverySeconds(): number {
    return this.recoverTotal;
  }
  /** Total recovery seconds over the whole race, not just this episode. */
  get recoveryLifetime(): number {
    return this.recoverLifetime;
  }
  /** Times the arc-progress / wall-pin tests fired. The "repeatedly" counter. */
  get stuckEpisodeCount(): number {
    return this.stuckEpisodes;
  }
  /**
   * True when recovery has been tried and tried and is not working — the caller
   * should respawn this kart. The old gate was `recoverySeconds > 5.5`, which a
   * driver that keeps *exiting* recovery successfully and then re-entering it two
   * seconds later never reaches: measured, a kart that spent 146 s of a 260 s race
   * making no progress never once asked for a respawn, because no single recovery
   * episode lasted 5.5 s.
   */
  get wantsRespawn(): boolean {
    return (
      this.stuckStreak >= RECOVER.streakForRespawn ||
      this.recoverTotal > RECOVER.giveUpSeconds
    );
  }
  /**
   * 0..1 — how well this driver is coping right now. 1 means it has strung
   * `RECOVER.composureSeconds` of ordinary racing together; 0 means it is in
   * recovery, pinned to a barrier, deep off the road, or has just been stuck.
   *
   * `Rubberband` reads this so it stops pushing a driver that is already over its
   * limit. Without it, being lost maximises risk, and risk keeps you lost — see the
   * COMPOSURE note in `Rubberband.ts`.
   */
  get composure(): number {
    if (this.mode !== 'race' && this.mode !== 'grid') return 0;
    const settled = clamp01(this.settledFor / RECOVER.composureSeconds);
    // …and a driver that keeps HITTING things is not coping either, even though it
    // never stops moving and so never trips any of the stuck tests.
    //
    // This is the whole of the owner's third report. Measured on the current tree,
    // 260 s, seed 12345, one kart dominates every city circuit — kart 5, the
    // `rival`, which is the kart the band tracks hardest:
    //
    //   circuit          band ON            band OFF
    //   tokyoNeon        51 contacts        13   (rival 38 -> 7)
    //   taipeiCircuit    38                  5   (rival 21 -> 5)
    //   neonMetropolis   55                 14   (rival 29 -> 13)
    //
    // Three quarters of all remaining wall contacts are the rubber band pushing
    // risk into a driver that is already failing to hold the road — and the
    // lap-time spread does not shrink with the band off (5.83->6.05, 6.18->6.57,
    // 5.94->6.73 s), so the band is not what makes the field a field. The pace
    // ladder is. The composure gate existed to stop exactly this and could not see
    // it, because its only inputs were "stuck" and "off-road": a kart clipping the
    // same barrier once a lap is doing neither.
    const rattled = clamp01(this.contactRate / RECOVER.contactsForPanic);
    return Math.min(settled, 1 - rattled);
  }

  /** Cleared by the caller once it has honoured `wantsRespawn`. */
  clearRespawnRequest(): void {
    this.stuckStreak = 0;
    this.recoverTotal = 0;
    this.noProgressTimer = 0;
    this.arcRingFilled = 0;
    this.wallTouch = 0;
  }
  /** Barrier contacts the wall reflex has seen. */
  get wallContactCount(): number {
    return this.wallContacts;
  }
  /** Seconds of continuous barrier contact right now. */
  get wallTouchSeconds(): number {
    return this.wallTouch;
  }
  get currentMode(): DriveMode {
    return this.mode;
  }
  get lateralError(): number {
    return this.near.lateral;
  }
  get lineCurvature(): number {
    return this.hereSample.curvature;
  }

  reset(): void {
    this.steerSmooth = 0;
    this.speedIntegral = 0;
    this.avoidBias = 0;
    this.wallBias = 0;
    this.wallSpeedScale = 1;
    this.wallTouch = 0;
    this.wallDepth = 0;
    this.wallContacts = 0;
    this.arcRingFilled = 0;
    this.arcRingHead = 0;
    this.arcSampleTimer = 0;
    this.arcTravelled = 0;
    this.arcPrev = -1;
    this.noProgressTimer = 0;
    this.stuckEpisodes = 0;
    this.stuckStreak = 0;
    this.settledFor = 0;
    this.contactRate = 0;
    this.recoverLifetime = 0;
    this.blockBias = 0;
    this.blockTime = 0;
    this.blockRest = 0;
    this.driftPhase = 'none';
    this.driftDir = 0;
    this.driftTimer = 0;
    this.driftCooldown = 0;
    this.overshoot = 0;
    this.chainTimer = 0;
    this.mode = 'grid';
    this.stuckTimer = 0;
    this.wrongWayTimer = 0;
    this.offTrackTimer = 0;
    this.modeTimer = 0;
    this.recoverTotal = 0;
    this.offTrackTotal = 0;
    this.backwardsTotal = 0;
    this.miniTurbos = 0;
    this.driftAttempts = 0;
    this.driftBoostSeconds = 0;
    this.hintStation = -1;
    this.variant = 'optimal';
    this.itemTimer = 0;
    this.itemPending = false;
    this.holdTimer = 0;
    this.tripleLeft = 0;
    this.control.steer = 0;
    this.control.accel = 0;
    this.control.brake = 0;
    this.control.drift = false;
    this.control.driftPressed = false;
  }

  // -------------------------------------------------------------------------
  //  THE TICK
  // -------------------------------------------------------------------------

  step(dt: number, world: DriverWorld, band: BandOutput): AIControl {
    const c = this.control;
    c.driftPressed = false;
    const st = this.state;
    if (!st || !this.enabled) {
      c.steer = 0;
      c.accel = 0;
      c.brake = 0;
      c.drift = false;
      return c;
    }
    this.band.speedMul = band.speedMul;
    this.band.risk = band.risk;
    this.band.aggression = band.aggression;

    // --- 1. PERCEPTION ----------------------------------------------------
    const line = world.line;
    _fwd.set(0, 0, -1).applyQuaternion(st.groundQuaternion ?? st.quaternion);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _up.set(0, 1, 0).applyQuaternion(st.groundQuaternion ?? st.quaternion);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);
    _up.normalize();
    _right.copy(_fwd).cross(_up);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();

    line.nearest(st.position, this.near, this.variant, this.hintStation);
    this.hintStation = this.near.station;
    line.sample(this.near.t, this.hereSample, this.variant);

    const speed = st.speed;
    const absSpeed = Math.abs(speed);

    // Timers -------------------------------------------------------------
    if (this.driftCooldown > 0) this.driftCooldown -= dt;
    if (this.variantCooldown > 0) this.variantCooldown -= dt;
    if (this.chainTimer > 0) this.chainTimer -= dt;
    this.variantShift = damp(this.variantShift, 0, 0.28, dt);
    this.weavePhase += dt;

    // Stunned / respawning: the physics owns us, keep the throttle honest.
    if (st.stunned) {
      c.steer = damp(this.steerSmooth, 0, 0.12, dt);
      this.steerSmooth = c.steer;
      c.accel = 1;
      c.brake = 0;
      c.drift = false;
      this.driftPhase = 'none';
      this.speedIntegral = 0;
      this.updateDebug(world, 0);
      return c;
    }

    // --- pressure & error model ------------------------------------------
    this.pressure = this.computePressure(world, st);
    this.error.update(
      dt,
      this.pressure,
      clamp01(this.skill.lineAccuracy * 0.7 + this.skill.item * 0.3),
      this.personality,
    );

    // --- barriers, BEFORE recovery -----------------------------------------
    // `updateRecovery` reads `wallTouch` as one of its trapped tests, and
    // `driveRecovery` reads `wallBias` to steer off whatever it is leaning on. If
    // this ran after the recovery branch (which returns early) both would freeze
    // at their last racing values for the whole recovery — i.e. the kart would try
    // to drive out of a wall it no longer believes is there.
    this.updateWallAvoid(dt, world, st, absSpeed);

    // --- recovery state machine (may take over completely) ----------------
    this.updateRecovery(dt, world, st, absSpeed);
    if (this.mode === 'reverse' || this.mode === 'realign') {
      this.driveRecovery(dt, world, st);
      this.itemThink(dt, world, st);
      this.updateDebug(world, this.hereSample.targetSpeed);
      return c;
    }

    // --- 2. TACTICS -------------------------------------------------------
    this.chooseVariant(dt, world, st);
    this.updateAvoidance(dt, world, st, absSpeed);

    // --- lookahead point --------------------------------------------------
    const lookDist = clamp(
      absSpeed * STEER.lookaheadSeconds * lerp(1.15, 0.92, clamp01(this.skill.lineAccuracy)),
      STEER.lookaheadMin,
      STEER.lookaheadMax,
    );
    line.sampleAhead(this.near.t, lookDist, this.aheadSample, this.variant);

    // Total lateral bias, clamped so they never leave the road for it.
    const apexErr = this.error.apexError(world.elapsed, this.personality, this.skill.error);
    let bias = this.avoidBias + this.blockBias + apexErr + this.variantShift;
    const room = Math.max(0.8, this.aheadSample.halfWidth - 1.35);
    const totalLat = clamp(this.aheadSample.lateral + bias, -room, room);
    bias = totalLat - this.aheadSample.lateral;
    // The wall term is added AFTER the road-width clamp on purpose. Everything
    // above is a preference and must stay on the road; this one is a barrier that
    // physically exists, and clamping a push away from it against the same road
    // width that put us next to it is how you get a kart that leans on a rail for
    // a whole lap.
    bias += this.wallBias;
    this.lastLineLateral = this.aheadSample.lateral;

    this.lookaheadPoint
      .copy(this.aheadSample.position)
      .addScaledVector(this.aheadSample.binormal, bias);

    // --- 3. STEERING ------------------------------------------------------
    _rel.subVectors(this.lookaheadPoint, st.position);
    // Work in the chassis plane so hills don't confuse the geometry.
    _rel.addScaledVector(_up, -_rel.dot(_up));
    const L = Math.max(1.5, _rel.length());
    const alpha = Math.atan2(_rel.dot(_right), _rel.dot(_fwd));

    // Pure pursuit: kappa = 2 sin(alpha) / L, then convert the required yaw
    // rate into a steer command using the physics' speed-dependent authority.
    const kappa = (2 * Math.sin(alpha)) / L;
    const vRef = Math.max(STEER.minPursuitSpeed, absSpeed);
    const authority = this.yawAuthorityAt(absSpeed, st.drifting);
    let steerRaw = (kappa * vRef) / Math.max(0.4, authority);
    steerRaw *= STEER.ppGain;

    // PD on lateral error. `near.lateral` is + when we are right of the line,
    // so the correction is negative (steer left).
    const latErr = this.near.lateral - bias;
    const latRate = (latErr - this.lateralPrev) / Math.max(1e-4, dt);
    this.lateralPrev = latErr;
    const tol = this.personality.laneTolerance;
    const deadband = latErr > 0 ? Math.max(0, latErr - tol * 0.35) : Math.min(0, latErr + tol * 0.35);
    steerRaw -= deadband * STEER.kP * this.skill.lineAccuracy;
    steerRaw -= clamp(latRate, -12, 12) * STEER.kD * this.skill.lineAccuracy;

    // Drift assistance.
    if (this.driftPhase === 'hop') steerRaw += this.driftDir * STEER.hopBias;
    else if (st.drifting && st.driftDirection !== 0)
      steerRaw += st.driftDirection * STEER.driftBias;

    // Human hands.
    steerRaw += this.error.steerError(world.elapsed, this.personality, this.skill.error);

    steerRaw = clamp(steerRaw, -1, 1);
    this.steerSmooth = damp(this.steerSmooth, steerRaw, STEER.smoothHalfLife, dt);
    c.steer = clamp(this.steerSmooth, -1, 1);

    // --- 4. SPEED ---------------------------------------------------------
    const targetSpeed = this.computeTargetSpeed(world, st, absSpeed);
    this.applySpeedControl(dt, targetSpeed, speed, st);

    // --- 5. DRIFT + ITEMS ------------------------------------------------
    this.updateDrift(dt, world, st, absSpeed);
    this.itemThink(dt, world, st);

    this.updateDebug(world, targetSpeed);
    return c;
  }

  // -------------------------------------------------------------------------
  //  Perception helpers
  // -------------------------------------------------------------------------

  /**
   * 0..1 — how contested the situation is. Feeds the mistake model, and this is
   * the mechanism that opens an overtaking lane: a chaser sitting on an AI's
   * bumper raises that AI's mistake rate until it runs one wide. It is invisible
   * (nobody slows down for you) and it is the authored design — it simply never
   * ran, because the mistake sampler could not fire. See `ErrorModel`.
   *
   * Directional on purpose. Somebody *behind* you is pressure; somebody ahead of
   * you is an opportunity, and the old radial version counted both the same.
   */
  private computePressure(world: DriverWorld, st: KartState): number {
    let p = 0;
    const karts = world.karts;
    const tangent = this.hereSample.tangent;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o === st || o.id === this.kartId) continue;
      _rel.subVectors(o.position, st.position);
      const d = _rel.length();
      if (d > PRESSURE.radius) continue;
      const along = _rel.dot(tangent);
      const close = 1 - d / PRESSURE.radius;
      // behind ⇒ full weight, alongside ⇒ most of it, ahead ⇒ barely any.
      const dir =
        along < -1.5
          ? PRESSURE.behind
          : along > 3.0
            ? PRESSURE.ahead
            : PRESSURE.alongside;
      p += close * dir * (o.isPlayer ? PRESSURE.playerFactor : 1);
    }
    if (st.racePosition <= 3) p += 0.1;
    return clamp01(p);
  }

  // -------------------------------------------------------------------------
  //  Tactics — line choice
  // -------------------------------------------------------------------------

  private chooseVariant(dt: number, world: DriverWorld, st: KartState): void {
    // Never change line in the middle of a corner.
    //
    // A switch injects up to 5 m of `variantShift` into the lateral target. Doing
    // that on a straight is a lane change; doing it while committed to an arc is a
    // second steering input on top of the one holding the corner, and the
    // controller cannot tell them apart. Measured on volcano's 340 m helix, the
    // rival flipped optimal/inside/outside every 25–60 m for the whole corner and
    // crossed the full 19 m road each time; 63–100 % of all AI wall contacts on
    // the four measured circuits happen on a non-`optimal` variant.
    //
    // `nearWindow` is one tick stale here (`updateDrift` refreshes it after this
    // runs) which at 30 m/s is 0.25 m of arc — irrelevant at this threshold.
    //
    // It gates the VARIANT only. The blocking bias at the bottom of this method
    // has to keep updating or a defender freezes its cover for the whole corner,
    // and blocking is authored differentiation, not a line choice.
    const maySwitch =
      this.variantCooldown <= 0 &&
      Math.abs(this.nearWindow.signed) <= SPEED.variantCornerIntegral;
    const line = world.line;
    const p = this.personality;
    const risk = this.band.risk;
    const aggression = clamp01(p.aggression + this.band.aggression);

    // Who is immediately ahead / behind along the track?
    let aheadGap = Infinity;
    let behindGap = Infinity;
    let behindLat = 0;
    const karts = world.karts;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o.id === this.kartId) continue;
      _rel.subVectors(o.position, st.position);
      const along = _rel.dot(this.hereSample.tangent);
      const lateral = _rel.dot(this.hereSample.binormal);
      const d = Math.abs(along);
      if (along > 0 && d < aheadGap && Math.abs(lateral) < 14) aheadGap = d;
      if (along < 0 && d < behindGap && Math.abs(lateral) < 14) {
        behindGap = d;
        behindLat = lateral;
      }
    }

    let want: LineVariant = 'optimal';

    // Shortcut first — it beats every other consideration when it is on.
    if (line.has('shortcut')) {
      const specs = line.shortcutSpecs;
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        let dEntry = (spec.entryT - this.near.t) * world.lapLength;
        if (dEntry < -world.lapLength * 0.5) dEntry += world.lapLength;
        const inside =
          this.near.t >= Math.min(spec.entryT, spec.exitT) &&
          this.near.t <= Math.max(spec.entryT, spec.exitT);
        const canBoost = !spec.requiresBoost || st.boostTime > 0.2 || st.heldItem === ItemType.Boost;
        const daring = risk > 0.3 || aggression > 0.7 || p.id === 'chaotic';
        if (canBoost && daring && (inside || (dEntry > 0 && dEntry < 45))) {
          want = 'shortcut';
          break;
        }
      }
    }

    if (want === 'optimal') {
      const attackScore =
        (aheadGap < p.aggressionRadius ? 1 - aheadGap / p.aggressionRadius : 0) *
          (0.35 + 0.65 * aggression) +
        Math.max(0, risk) * 0.75 +
        Math.max(0, p.lineBias) * 0.5;
      const defendScore =
        (behindGap < AVOID.rearRange ? 1 - behindGap / AVOID.rearRange : 0) * p.blocking * 1.35 +
        Math.max(0, -p.lineBias) * 0.6 +
        Math.max(0, -risk) * 0.4;

      const threshold = lerp(0.85, 0.4, p.lineSwitchiness);
      if (attackScore > defendScore && attackScore > threshold) {
        want = p.lineBias < -0.25 ? 'inside' : 'outside';
      } else if (defendScore > threshold) {
        want = 'inside';
      }
    }

    if (!world.line.has(want)) want = 'optimal';
    if (!maySwitch) want = this.variant;

    if (want !== this.variant) {
      // Carry the lateral difference as a decaying shift so the target never
      // jumps — a stepped target reads as a twitch.
      const before = this.lastLineLateral;
      this.variant = want;
      world.line.sample(this.near.t, this.targetSample, want);
      this.variantShift = clamp(before - this.targetSample.lateral + this.variantShift, -5, 5);
      this.variantCooldown = 0.6;
    }

    // Blocking bias — cover the side the chaser is on, but only for a while.
    // A defender that covers both sides forever is unpassable, which is half of
    // the D2 complaint. One committed move, then the door opens: that reads as a
    // driver who tried and lost the position, not as an invulnerable wall.
    let blockTarget = 0;
    const chased = behindGap < AVOID.rearRange && p.blocking > 0.25;
    if (this.blockRest > 0) {
      this.blockRest -= dt;
      this.blockTime = 0;
    } else if (chased) {
      this.blockTime += dt;
      if (this.blockTime > BLOCK.maxSeconds * lerp(0.7, 1.3, p.blocking)) {
        this.blockRest = BLOCK.restSeconds;
        this.blockTime = 0;
      } else {
        const w = 1 - behindGap / AVOID.rearRange;
        blockTarget = sign(behindLat) * w * p.blocking * BLOCK.strength;
        if (p.id === 'blocker') {
          blockTarget += Math.sin(this.weavePhase * 1.4) * w * BLOCK.weave;
        }
      }
    } else {
      this.blockTime = Math.max(0, this.blockTime - dt * 1.5);
    }
    this.blockBias = damp(this.blockBias, blockTarget, 0.35, dt);
    this.debug.blocking = this.blockBias;
  }

  // -------------------------------------------------------------------------
  //  Tactics — avoidance
  // -------------------------------------------------------------------------

  private updateAvoidance(dt: number, world: DriverWorld, st: KartState, absSpeed: number): void {
    const probe = clamp(absSpeed * AVOID.probeSeconds, AVOID.probeMin, AVOID.probeMax);
    let target = 0;

    // --- karts ------------------------------------------------------------
    const karts = world.karts;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o.id === this.kartId) continue;
      _rel.subVectors(o.position, st.position);
      const fwd = _rel.dot(_fwd);
      if (fwd < 0.5 || fwd > probe) continue;
      const lat = _rel.dot(_right);
      const corridor = AVOID.kartCorridor;
      if (Math.abs(lat) > corridor) continue;
      // Only worth avoiding if we are actually closing on them.
      const closing = absSpeed - Math.abs(o.speed);
      const urgency = closing > 0.5 ? clamp01(closing / 8) : 0.25;
      const w = (1 - fwd / probe) * (1 - Math.abs(lat) / corridor) * urgency;
      // Aggressive drivers lean on people instead of yielding.
      const strength = AVOID.kartStrength * this.personality.avoidance;
      // Pick a side: away from them, but prefer the side with more road.
      let side = lat !== 0 ? -sign(lat) : -sign(this.near.lateralFromCentre || 1);
      if (side === 0) side = 1;
      target += side * w * strength;
    }

    // --- hazards ----------------------------------------------------------
    const hazards = world.hazards;
    const hn = Math.min(world.hazardCount, hazards.length);
    for (let i = 0; i < hn; i++) {
      const h = hazards[i];
      _rel.subVectors(h.position, st.position);
      const fwd = _rel.dot(_fwd);
      if (fwd < 0.3 || fwd > probe * (h.homing ? 1.4 : 1)) continue;
      const lat = _rel.dot(_right);
      const corridor = h.radius + AVOID.hazardPad;
      if (Math.abs(lat) > corridor) continue;
      const w = (1 - fwd / probe) * (1 - Math.abs(lat) / corridor);
      // Hazard avoidance is never reduced by personality — nobody drives
      // through a banana on purpose.
      let side = lat !== 0 ? -sign(lat) : -sign(this.near.lateralFromCentre || 1);
      if (side === 0) side = 1;
      target += side * w * AVOID.hazardStrength;
    }

    target = clamp(target, -AVOID.maxBias, AVOID.maxBias);
    this.avoidBias = damp(this.avoidBias, target, AVOID.halfLife, dt);
  }

  // -------------------------------------------------------------------------
  //  Tactics — barriers
  // -------------------------------------------------------------------------

  /**
   * The wall reflex. Two swept-sphere queries: one where we will be in
   * `WALL.leadSeconds`, one where we are now. See the `WALL` block for why both.
   *
   * Zero allocation: `_wallPt` is module scope, and `collideWalls` writes into the
   * track's own shared result object (which is why every field is read out before
   * the second query — the first result is invalidated by it).
   */
  private updateWallAvoid(
    dt: number,
    world: DriverWorld,
    st: KartState,
    absSpeed: number,
  ): void {
    const probe = world.walls;
    this.wallSpeedScale = 1;
    this.wallDepth = 0;
    if (!probe) {
      this.wallBias = damp(this.wallBias, 0, WALL.halfLife, dt);
      this.wallTouch = 0;
      return;
    }

    let target = 0;
    let noseIn = 0;

    // --- lead probe: the wall we are about to arrive at --------------------
    //
    // Projecting `lead` metres straight along `_fwd` walks off the road plane on a
    // gradient — 12 m on a 10 % descent is 1.2 m of vertical error, and
    // `Track.collideWalls` rejects any query more than 0.55 m below the barrier
    // base or 0.7 m above its top, so on the hilly circuit the probe was silently
    // missing every guardrail it was meant to see. Take the lateral position from
    // the kart's own heading and the HEIGHT from the line at that arc distance.
    const lead = clamp(absSpeed * WALL.leadSeconds, WALL.leadMin, WALL.leadMax);
    world.line.sampleAhead(this.near.t, lead, this.wallSample, this.variant);
    _wallPt.copy(st.position).addScaledVector(_fwd, lead);
    _tmp.subVectors(_wallPt, this.wallSample.position);
    const vertical = _tmp.dot(this.wallSample.normal);
    _wallPt.addScaledVector(this.wallSample.normal, WALL.probeHeight - vertical);
    const ahead = probe.collideWalls(_wallPt, this.wallLeadRadius);
    if (ahead.hit && ahead.depth > 1e-4) {
      const depth = ahead.depth;
      // `normal` points OUT of the wall, so it is already the escape direction.
      const side = ahead.normal.dot(_right);
      noseIn = -ahead.normal.dot(_fwd);
      this.wallDepth = depth;
      const w = clamp01(depth / WALL.leadMargin);
      target += sign(side) * w * WALL.leadStrength;
      if (noseIn > WALL.noseInDot) {
        // Pointed at it as well as near it: lift.
        this.wallSpeedScale = lerp(1, WALL.speedCut, clamp01(noseIn * 2) * w);
      }
    }

    // --- contact-now probe: the term that survives the bounce -------------
    _wallPt.copy(st.position);
    const now = probe.collideWalls(_wallPt, this.wallNowRadius);
    if (now.hit && now.depth > 1e-4) {
      const depth = now.depth;
      const side = now.normal.dot(_right);
      if (depth > this.wallDepth) this.wallDepth = depth;
      const w = clamp01(0.45 + depth / WALL.nowMargin);
      target += sign(side) * w * WALL.nowStrength;
      if (this.wallTouch === 0) {
        this.wallContacts++;
        this.contactRate += 1;
      }
      this.wallTouch += dt;
    } else {
      this.wallTouch = 0;
    }

    target = clamp(target, -WALL.maxBias, WALL.maxBias);
    this.wallBias = damp(this.wallBias, target, WALL.halfLife, dt);
  }

  // -------------------------------------------------------------------------
  //  Speed
  // -------------------------------------------------------------------------

  private computeTargetSpeed(world: DriverWorld, st: KartState, absSpeed: number): number {
    const line = world.line;
    // Look ahead by a personality/CC-scaled time so cautious drivers and low
    // CC classes brake earlier for the same corner.
    const lead = clamp(
      absSpeed * SPEED.targetLead * this.skill.brakeMargin,
      4,
      absSpeed * SPEED.targetLeadMax + 6,
    );
    line.sampleAhead(this.near.t, lead, this.targetSample, this.variant);
    // How much of the line's corner speed does THIS chassis dare to carry?
    const lineV =
      Math.min(this.hereSample.targetSpeed, this.targetSample.targetSpeed) * this.cornerAbility;
    // Clamp to something this kart can actually do BEFORE the pace multiplier,
    // otherwise pace multiplies an unreachable number and does nothing at all.
    // (This is the D2 fix: see SPEED.capHeadroom and SPEED.chassisWeight.)
    const capV = this.speedCap * SPEED.capHeadroom;
    // Which constraint is binding? Braking is only ever for a CORNER: if the
    // cruise ceiling is what is holding us back — mid-boost, downhill, or just
    // running a shade quick — the answer is to lift off, not to stand on the
    // brakes. Without this the AI brakes hard the instant a mushroom expires.
    this.lineLimited = lineV <= capV;
    let v = Math.min(lineV, capV);

    // Pace: personality × CC × form × rubber band × slow wobble.
    v *= this.skill.pace;
    v *= this.band.speedMul;
    v *= this.error.paceError(world.elapsed, this.skill.error);
    // Risk: when trying harder, carry a little more speed into the corner.
    v *= 1 + Math.max(0, this.band.risk) * 0.035;

    // Mistakes.
    if (this.error.brakingLate) v *= 1.14;
    else if (this.error.lifting) v *= 0.8;

    // Surface.
    const s = st.surface;
    if (s !== SurfaceType.Road && s !== SurfaceType.Boost && s !== SurfaceType.Metal) {
      v *= SPEED.offRoadTargetMul;
    }

    // A barrier inside the lead probe, with the nose pointed at it. Lifting here
    // is what turns "hit the same corner every lap" into "run that corner wide and
    // lose two tenths", which is the behaviour the weakest drivers should show.
    //
    // It also has to license the BRAKE. `lineLimited` exists so a kart does not
    // throw a mushroom away braking on a straight, but its test is "is the racing
    // line slower than my cruise cap", and a kart carried over its cap by a hill or
    // a boost fails that test and has `c.brake` forced to zero — so on a fast
    // descent it could not slow down for anything at all. A wall in the lead probe
    // is not a straight.
    if (this.wallSpeedScale < 1) {
      v *= this.wallSpeedScale;
      this.lineLimited = true;
    }

    // The steering limit. See SPEED.yawLimitMargin — this is a hard physical
    // ceiling, not a preference, so it is applied last and it overrides `pace`.
    // `nearWindow.peak` is one tick stale (`updateDrift` refreshes it after this
    // runs) but it reaches ~0.8 s of travel rather than the braking lead's ~0.4 s,
    // which is what matters on a fast descent where the two samples either side of
    // the kart are both nearly straight and the corner is still coming.
    const kappa = Math.max(
      Math.abs(this.hereSample.curvature),
      Math.abs(this.targetSample.curvature),
      this.nearWindow.peak,
    );
    if (kappa > 1e-4) {
      let vy = v;
      for (let i = 0; i < SPEED.yawLimitIterations; i++) {
        const a = this.yawAuthorityAt(vy, st.drifting) * SPEED.yawLimitMargin;
        const next = a / kappa;
        vy = next < v ? next : v;
      }
      if (vy < v) {
        v = vy;
        // The binding constraint is now a CORNER, so braking for it is correct.
        this.lineLimited = true;
      }
    }

    // The overspeed brake licence. See SPEED.yawBrakeMargin — this is the
    // volcanoRush fix, and it is deliberately the last word on `lineLimited`.
    //
    // Gated on the overspeed first, because that test is free: below
    // `boostCornerDeadband` the PI controller's output is still positive (bias
    // 0.36 against kP 0.55) so there is no brake to license and nothing downstream
    // reads the flag differently, and only a driver actually running away from its
    // own target pays for the extra curvature scan.
    if (absSpeed > v + SPEED.boostCornerDeadband) {
      // `farWindow.peak` rather than a third `curvatureAhead`: the drift detector
      // already scans `clamp(v · 1.9, 18, 66)` m of line every tick, which is the
      // horizon this test wants anyway (braking 48 -> 38 m/s takes ~30 m, and a
      // fixed lead TIME cannot supply that because braking distance grows with v²
      // while `targetLead` grows with v — at 48 m/s the 0.42 s braking lead sees
      // 20 m). A fourth scan of the same array costs 6.5 us x 11 karts x 120 Hz
      // (`.probe-tmp/curvcost.ts`) for a horizon 40–66 m wide instead of 57–66.
      // One tick stale, i.e. 0.25 m of arc at 30 m/s.
      const kc = Math.max(kappa, this.farWindow.peak);
      if (kc > 1e-4) {
        // Same fixed point as above, but seeded from the speed we ACTUALLY have.
        // `yaw()` falls with speed, so seeding high and iterating converges from
        // the outside; three steps land within 0.2 m/s (verified against a
        // 40-step solve in `.probe-tmp/volcline.ts`).
        //
        // `drifting = false` deliberately. `driftAuthorityBonus` is a 1.3x flat
        // credit for the extra yaw a slide buys, and it is fine for the STEERING
        // divisor, but here it is the kart talking itself out of braking at the
        // exact moment it should not: measured on the spiral, the licence fired
        // at arc 840 and 845, the kart began a drift at 846, the ceiling jumped
        // 37.6 -> 48.9 m/s, the licence switched off and the boost override went
        // straight back to `accel = 1` at 36 m/s. A slide buys yaw by spending
        // lateral grip; it does not raise the speed at which the corner can be
        // made.
        let vc = absSpeed;
        for (let i = 0; i < SPEED.yawLimitIterations; i++) {
          vc = (this.yawAuthorityAt(vc, false) * SPEED.yawLimitMargin) / kc;
        }
        if (absSpeed > vc * SPEED.yawBrakeMargin) this.lineLimited = true;
      }
    }

    // Countdown: hold still, then feather the throttle for a rocket start.
    if (!world.raceStarted) {
      const c = world.countdown;
      if (c > this.rocketOffset + 0.35) return 0;
    }
    return Math.max(2, v);
  }

  private applySpeedControl(dt: number, target: number, speed: number, st: KartState): void {
    const c = this.control;
    if (target <= 0.01) {
      c.accel = 0;
      c.brake = 0.35;
      this.speedIntegral = 0;
      return;
    }
    const err = target - speed;

    const uP = err * SPEED.kP;
    const iContribution = this.speedIntegral * SPEED.kI;
    let u = SPEED.bias + uP + iContribution;

    // Anti-windup: freeze the integral when the output is already saturated in
    // the direction the error would push it. Without this the AI arrives at a
    // hairpin with a saturated integral and brakes two car lengths too late.
    const satHigh = u >= 1;
    const satLow = u <= -1 / SPEED.brakeGain;
    if (!(satHigh && err > 0) && !(satLow && err < 0)) {
      this.speedIntegral = clamp(this.speedIntegral + err * dt, -SPEED.iClamp, SPEED.iClamp);
    }
    u = SPEED.bias + err * SPEED.kP + this.speedIntegral * SPEED.kI;

    if (u >= 0) {
      c.accel = clamp01(u);
      c.brake = 0;
    } else {
      c.accel = 0;
      c.brake = clamp01(-u * SPEED.brakeGain);
    }

    // Not braking for a corner — just running above our own cruise ceiling.
    // Lift off and let drag do it; braking here would throw away every boost.
    if (!this.lineLimited) c.brake = 0;
    // Never brake in the air (nothing to brake against) and never brake mid
    // drift (you hold the throttle through a slide).
    if (!st.grounded) c.brake = 0;
    if (st.drifting || this.driftPhase === 'hop' || this.driftPhase === 'hold') {
      // A slide is not an excuse to ignore the target speed: a driver on a
      // slower pace brake-drifts. See SPEED.driftBrakeCap.
      const over = speed - target;
      c.brake = Math.min(
        c.brake,
        over > SPEED.driftBrakeDeadband ? SPEED.driftBrakeCap : 0,
      );
      c.accel = Math.max(
        c.accel,
        over > 0 ? SPEED.driftThrottleEase : SPEED.driftThrottleFloor,
      );
    }
    // Boosting? Foot down — unless a CORNER is what is holding us back.
    //
    // This was unconditional, and being last it silently outranked every speed
    // decision above it, including the steering limit. Measured on `volcanoRush`
    // 540–640 m: the target had correctly dropped to 22.8 m/s for a 52 m radius
    // corner while this line held `accel` at 1.0 and `brake` at 0 through a
    // stage-2 mini-turbo at 36.8 m/s. The kart ran from 10 m left of the line to
    // 30 m right of it, left the map (that 100 m has no barrier on its outside),
    // respawned, and repeated every ~3 s for the whole race — the last kart in the
    // field to finish zero laps.
    //
    // `lineLimited` is the distinction that makes this safe. It is false when the
    // binding constraint is the kart's own cruise ceiling — i.e. on every straight,
    // which is exactly where a mini-turbo is supposed to take you past it. So a
    // boost on a straight is still flat out and still pays out in full; only a
    // corner can take its foot off. Gating on `speed > target` instead would lift
    // on every straight, because a boost is *meant* to exceed the cruise target,
    // and a mini-turbo that never pays out is its own bug.
    //
    // Lifting also does not throw the boost away: the physics adds boost thrust as
    // `aLong += boostAccel · strength · env` with no reference to the throttle, the
    // raised soft cap is likewise unconditional, and nothing but a stun or a
    // respawn clears `boostTime`. That is why the brake here is allowed to be real
    // rather than token.
    if (st.boostTime > 0) {
      const over = speed - target;
      if (!this.lineLimited || over <= SPEED.boostCornerDeadband) {
        c.accel = 1;
        c.brake = 0;
      } else {
        c.accel = Math.min(c.accel, SPEED.boostCornerThrottle);
        if (st.grounded) {
          const ramp = clamp01(over / SPEED.boostBrakeRamp);
          c.brake = Math.max(c.brake, ramp * SPEED.boostCornerBrakeCap);
        } else {
          c.brake = 0;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  //  Drifting — the mini-turbo engine
  // -------------------------------------------------------------------------

  private updateDrift(dt: number, world: DriverWorld, st: KartState, absSpeed: number): void {
    const c = this.control;
    const line = world.line;
    const p = this.personality;

    const farLen = clamp(absSpeed * DRIFT.farSeconds, DRIFT.farMin, DRIFT.farMax);
    const nearLen = clamp(absSpeed * DRIFT.nearSeconds, DRIFT.nearMin, DRIFT.nearMax);
    line.curvatureAhead(this.near.t, farLen, this.farWindow, this.variant);
    line.curvatureAhead(this.near.t, nearLen, this.nearWindow, this.variant);

    const eager = Math.max(0.25, this.skill.drift * (1 + Math.max(0, this.band.risk) * 0.28));
    const enter = DRIFT.enterIntegral / eager;
    const exit = DRIFT.exitIntegral / Math.max(0.5, eager);

    const far = this.farWindow.signed;
    const nearInt = this.nearWindow.signed;
    const roomLeft = this.near.halfWidth - Math.abs(this.near.lateralFromCentre);
    // A slide needs road to slide into, and how much depends on how fast we are
    // going. See DRIFT.bailMargin.
    const bailRoom = DRIFT.bailMargin + absSpeed * DRIFT.bailLead;
    const entryRoom = DRIFT.entryMargin + absSpeed * DRIFT.bailLead;
    const canDrift =
      st.grounded &&
      absSpeed > DRIFT.minSpeed &&
      !st.stunned &&
      this.mode === 'race' &&
      roomLeft > entryRoom;

    switch (this.driftPhase) {
      case 'none': {
        c.drift = false;
        if (!canDrift || this.driftCooldown > 0) break;
        // Chained entry (S-section): we already decided the next direction.
        if (this.chainTimer > 0 && this.chainDir !== 0) {
          this.beginDrift(this.chainDir);
          this.chainTimer = 0;
          this.chainDir = 0;
          break;
        }
        if (Math.abs(far) > enter && Math.abs(nearInt) > enter * DRIFT.nearFraction) {
          this.beginDrift(sign(far));
        }
        break;
      }

      case 'hop': {
        c.drift = true;
        this.driftTimer += dt;
        if (st.drifting) {
          this.driftPhase = 'hold';
          this.driftTimer = 0;
          this.overshoot = 0;
          // Trust the physics about which way we actually latched.
          if (st.driftDirection !== 0) this.driftDir = st.driftDirection;
        } else if (this.driftTimer > DRIFT.hopTimeout || !canDrift) {
          this.driftPhase = 'none';
          this.driftTimer = 0;
          this.driftCooldown = DRIFT.cooldown * 2;
          c.drift = false;
        }
        break;
      }

      case 'hold': {
        c.drift = true;
        this.driftTimer += dt;

        const cornerAlive = Math.abs(nearInt) > exit && sign(nearInt) === this.driftDir;
        const stage = st.driftStage;
        const wantStage = (DriftStage.None + p.driftTierTarget) as DriftStage;
        const haveMin = stage >= DriftStage.Blue;

        // Emergency bail: about to leave the road, stunned, or airborne long.
        if (!st.grounded && st.airTime > 0.35) {
          this.endDrift(st, false);
          break;
        }
        if (roomLeft < bailRoom || st.stunned || this.mode !== 'race') {
          this.endDrift(st, haveMin);
          break;
        }
        if (!st.drifting) {
          // Physics dropped the drift (spun out, landed badly).
          this.driftPhase = 'none';
          this.driftCooldown = DRIFT.cooldown;
          c.drift = false;
          break;
        }

        if (cornerAlive) {
          this.overshoot = 0;
          // Corner still going: keep holding. Release early only if we already
          // have the tier we wanted AND the corner is nearly done.
          if (stage >= wantStage && Math.abs(nearInt) < exit * 2.1) {
            this.endDrift(st, true);
          }
          break;
        }

        // Corner over. Release if we have a boost; otherwise hold on briefly.
        if (haveMin) {
          this.endDrift(st, true);
        } else {
          this.overshoot += dt;
          if (this.overshoot > DRIFT.maxOvershoot * (0.6 + 0.4 * p.chaining)) {
            this.endDrift(st, false);
          }
        }
        break;
      }

      case 'release': {
        c.drift = false;
        this.driftTimer += dt;
        if (this.driftTimer >= DRIFT.releaseSeconds) {
          this.driftPhase = 'none';
          this.driftTimer = 0;
        }
        break;
      }
    }

    // Chain detection (S-sections): an opposite-direction corner arriving right
    // now means release for the mini-turbo, then immediately re-hop the other
    // way. This is where a drift specialist makes all its time.
    if (this.driftPhase === 'release' && this.chainDir === 0 && p.chaining > 0.35) {
      const nextDir = sign(far);
      if (nextDir !== 0 && nextDir !== this.driftDir && Math.abs(far) > enter * 0.55) {
        this.chainDir = nextDir;
        this.chainTimer = DRIFT.chainSeconds;
      }
    }
  }

  private beginDrift(dir: number): void {
    if (dir === 0) return;
    this.driftPhase = 'hop';
    this.driftDir = dir;
    this.driftTimer = 0;
    this.driftAttempts++;
    this.debug.driftAttempts = this.driftAttempts;
    this.control.drift = true;
    this.control.driftPressed = true;
  }

  private endDrift(st: KartState, expectBoost: boolean): void {
    this.driftPhase = 'release';
    this.driftTimer = 0;
    this.driftCooldown = DRIFT.cooldown;
    this.control.drift = false;
    // Local fallback count in case nobody emits `kart:driftRelease`.
    if (expectBoost && st.driftStage >= DriftStage.Blue) {
      this.debug.driftStage = st.driftStage;
    }
  }

  // -------------------------------------------------------------------------
  //  Recovery
  // -------------------------------------------------------------------------

  /**
   * Unwrapped arc length along the line, metres, monotonic while driving forwards.
   *
   * Deliberately derived from `near.distance` rather than `KartState.progress`:
   * `progress` is owned by the RaceDirector, and a driver whose progress is never
   * updated (a harness, a mode with no director, a bug elsewhere) must not conclude
   * it has been stuck for the entire race.
   */
  private updateArc(dt: number, world: DriverWorld, absSpeed: number): void {
    const L = Math.max(1, world.lapLength);
    // `near.t` rather than `near.distance`: `t` is the shared station
    // parameterisation, identical across line variants, whereas `distance` is the
    // arc length of whichever path is currently selected. Switching from `optimal`
    // to `outside` steps `distance` by the two paths' local arc difference, which
    // would look like several metres of progress that never happened — and a
    // variant switch is allowed every 0.6 s.
    const here = (this.near.t - Math.floor(this.near.t)) * L;
    if (this.arcPrev < 0) {
      this.arcPrev = here;
    } else {
      let d = here - this.arcPrev;
      // Wrap: the only jumps of more than half a lap in one tick are the lap line.
      if (d < -L * 0.5) d += L;
      else if (d > L * 0.5) d -= L;
      this.arcPrev = here;
      this.arcTravelled += d;
    }

    this.arcSampleTimer += dt;
    const period = RECOVER.arcWindow / RECOVER.arcSamples;
    if (this.arcSampleTimer < period) return;
    this.arcSampleTimer = 0;
    this.arcRing[this.arcRingHead] = this.arcTravelled;
    this.arcRingHead = (this.arcRingHead + 1) % RECOVER.arcSamples;
    if (this.arcRingFilled < RECOVER.arcSamples) {
      this.arcRingFilled++;
      return;
    }
    // Oldest sample is the one we are about to overwrite next.
    const oldest = this.arcRing[this.arcRingHead];
    const advanced = this.arcTravelled - oldest;
    if (advanced < RECOVER.arcMetres) {
      this.noProgressTimer += RECOVER.arcWindow;
    } else {
      this.noProgressTimer = 0;
    }
    void absSpeed;
  }

  private updateRecovery(
    dt: number,
    world: DriverWorld,
    st: KartState,
    absSpeed: number,
  ): void {
    const alignment = _fwd.dot(this.hereSample.tangent);
    const offRoadDepth = Math.abs(this.near.lateralFromCentre) - this.near.halfWidth;

    if (world.raceStarted) {
      if (absSpeed < RECOVER.stuckSpeed && !st.stunned) this.stuckTimer += dt;
      else this.stuckTimer = 0;
      if (alignment < -0.15 && absSpeed > 0.5) {
        this.wrongWayTimer += dt;
        this.backwardsTotal += dt;
      } else this.wrongWayTimer = 0;
      if (offRoadDepth > 1.0) {
        this.offTrackTimer += dt;
        this.offTrackTotal += dt;
      } else this.offTrackTimer = 0;
      if (this.stuckStreak > 0) {
        this.stuckStreak = Math.max(0, this.stuckStreak - RECOVER.streakDecay * dt);
      }
      if (this.contactRate > 0) {
        this.contactRate = Math.max(0, this.contactRate - RECOVER.contactDecay * dt);
      }
      // Composure: ordinary racing builds it, trouble of any kind zeroes it.
      const troubled =
        this.mode !== 'race' ||
        this.noProgressTimer > 0 ||
        this.wallTouch > WALL.pinSeconds ||
        this.offTrackTimer > RECOVER.offTrackSeconds * 0.5 ||
        offRoadDepth > 2.5;
      this.settledFor = troubled ? 0 : this.settledFor + dt;
      if (st.stunned) {
        // A spin-out is not being stuck. Reset the window rather than let a 2 s
        // stun in a pack accumulate into a false positive.
        this.noProgressTimer = 0;
        this.arcRingFilled = 0;
      } else {
        this.updateArc(dt, world, absSpeed);
      }
    }

    if (this.mode === 'grid') {
      if (world.raceStarted) this.mode = 'race';
      return;
    }

    if (this.mode === 'race') {
      const trapped =
        this.stuckTimer > RECOVER.stuckSeconds ||
        this.wrongWayTimer > RECOVER.wrongWaySeconds ||
        this.offTrackTimer > RECOVER.offTrackSeconds ||
        // The two the old machine could not see. Either one on its own is a
        // limit cycle: no arc progress means nothing is being achieved, and a
        // barrier held for a second means the kart is leaning on it, not racing.
        this.noProgressTimer > 0 ||
        this.wallTouch > WALL.pinSeconds;
      if (trapped) {
        if (this.noProgressTimer > 0 || this.wallTouch > WALL.pinSeconds) {
          this.stuckEpisodes++;
          this.stuckStreak += 1;
        }
        this.noProgressTimer = 0;
        this.arcRingFilled = 0;
        this.wallTouch = 0;
        // If we are pointing roughly the right way, just drive back; only
        // reverse when we are genuinely wedged or facing backwards.
        this.mode = alignment < 0.25 || this.stuckTimer > RECOVER.stuckSeconds ? 'reverse' : 'realign';
        this.modeTimer = 0;
        this.recoverTotal = 0;
        this.driftPhase = 'none';
        this.control.drift = false;
        this.speedIntegral = 0;
      }
      return;
    }

    // In recovery.
    this.modeTimer += dt;
    this.recoverTotal += dt;
    this.recoverLifetime += dt;
    if (this.mode === 'reverse' && this.modeTimer > RECOVER.reverseSeconds) {
      this.mode = 'realign';
      this.modeTimer = 0;
    } else if (this.mode === 'realign') {
      const back = Math.abs(this.near.lateralFromCentre) < this.near.halfWidth * 0.85;
      const settled = this.modeTimer > RECOVER.minSeconds;
      if (settled && alignment > RECOVER.exitAlignment && back && absSpeed > RECOVER.exitSpeed) {
        this.mode = 'race';
        this.modeTimer = 0;
        this.stuckTimer = 0;
        this.wrongWayTimer = 0;
        this.offTrackTimer = 0;
        this.recoverTotal = 0;
        // Clear the arc window as well. It kept filling during the recovery, and a
        // recovery covers very little ground by design — so without this the first
        // racing tick reads a stale "no progress" and dives straight back into
        // recovery, which is the flap `minSeconds` exists to prevent.
        this.noProgressTimer = 0;
        this.arcRingFilled = 0;
      } else if (this.modeTimer > RECOVER.realignSeconds) {
        // Try reversing again — maybe we are jammed against a wall.
        this.mode = 'reverse';
        this.modeTimer = 0;
      }
    }
  }

  private driveRecovery(dt: number, world: DriverWorld, st: KartState): void {
    const c = this.control;
    const line = world.line;
    line.sampleAhead(this.near.t, this.mode === 'reverse' ? 10 : 14, this.aheadSample, 'optimal');
    // Aim at the CENTRE OF THE ROAD, not at the racing line. The racing line is
    // the fastest way round; the centreline is the point furthest from both
    // barriers, and a kart in recovery has already proved it cannot be trusted
    // with the fast one. `sample.lateral` is the line's own offset from the
    // centreline, so subtracting it along the binormal lands on the centre.
    this.lookaheadPoint
      .copy(this.aheadSample.position)
      .addScaledVector(this.aheadSample.binormal, -this.aheadSample.lateral);

    _rel.subVectors(this.lookaheadPoint, st.position);
    _rel.addScaledVector(_up, -_rel.dot(_up));
    const alpha = Math.atan2(_rel.dot(_right), _rel.dot(_fwd));

    let steerRaw = clamp(alpha * 1.6, -1, 1);
    if (this.mode === 'reverse') {
      // Reversing inverts the steering geometry — flip so the nose swings
      // toward the line rather than away from it.
      steerRaw = -steerRaw;
      c.accel = 0;
      c.brake = 1;
    } else {
      c.accel = 1;
      c.brake = 0;
      // Still touching something while trying to drive out of it: steer off the
      // barrier as well as toward the centre. Without this a kart nose-in to a
      // wall aims 14 m up the road, which points straight through the wall.
      if (this.wallBias !== 0) {
        steerRaw = clamp(steerRaw + clamp(this.wallBias * 0.22, -0.7, 0.7), -1, 1);
      }
    }
    c.drift = false;
    this.steerSmooth = damp(this.steerSmooth, steerRaw, 0.08, dt);
    c.steer = clamp(this.steerSmooth, -1, 1);
  }

  // -------------------------------------------------------------------------
  //  Items
  // -------------------------------------------------------------------------

  private itemThink(dt: number, world: DriverWorld, st: KartState): void {
    // Triple sequencing.
    if (this.tripleLeft > 0) {
      this.tripleTimer -= dt;
      if (this.tripleTimer <= 0) {
        this.items.use(this.kartId, this.itemPendingBack, this.itemPendingTarget);
        this.tripleLeft--;
        this.tripleTimer = ITEMS.tripleSpacing;
      }
      return;
    }

    // Pending decision waiting out the reaction delay.
    if (this.itemPending) {
      this.itemTimer -= dt;
      if (this.itemTimer <= 0) {
        this.items.use(this.kartId, this.itemPendingBack, this.itemPendingTarget);
        this.itemPending = false;
      }
      return;
    }

    const held = st.heldItem ?? this.items.heldItem(this.kartId);
    this.debug.heldItem = held === null || held === undefined ? -1 : held;
    if (held === null || held === undefined) {
      this.holdTimer = 0;
      this.items.hold(this.kartId, false);
      return;
    }
    if (!world.raceStarted) return;

    this.holdTimer += dt;
    const threat = this.items.threat(this.kartId);
    const threatened = threat >= 0;

    // --- shield behaviour -------------------------------------------------
    const isShield =
      held === ItemType.Banana ||
      held === ItemType.GreenShell ||
      held === ItemType.RedShell ||
      held === ItemType.TripleBanana ||
      held === ItemType.TripleGreenShell ||
      held === ItemType.TripleRedShell;
    if (isShield) {
      const wantShield =
        (threatened && this.personality.shieldTendency > 0.25) ||
        (this.personality.shieldTendency > 0.7 && this.holdTimer < ITEMS.maxShieldSeconds);
      this.items.hold(this.kartId, wantShield);
      if (threatened && this.personality.shieldTendency > 0.25) {
        // Sitting on it IS the play. Do nothing.
        return;
      }
    } else {
      this.items.hold(this.kartId, false);
    }

    const decision = this.evaluateItem(held, world, st, threatened);
    if (!decision) return;

    this.itemPendingBack = decision.back;
    this.itemPendingTarget = decision.target;
    // 200–600 ms of human latency, scaled by personality and CC class.
    this.itemTimer = clamp(this.skill.reaction, ITEMS.reactionMin, ITEMS.reactionMax);
    this.itemPending = true;
    if (decision.count > 1) {
      this.tripleLeft = decision.count - 1;
      this.tripleTimer = ITEMS.tripleSpacing + this.itemTimer;
    }
  }

  private evaluateItem(
    held: ItemType,
    world: DriverWorld,
    st: KartState,
    threatened: boolean,
  ): { back: boolean; target: number; count: number } | null {
    const p = this.personality;
    const skillItem = clamp01(this.skill.item);
    // Poor item users just fire.
    const impatient = p.itemImpatience * (1.4 - skillItem);

    // Nearest kart ahead / behind, along our own heading.
    let aheadId = -1;
    let aheadDist = Infinity;
    let aheadAlign = 0;
    let behindId = -1;
    let behindDist = Infinity;
    let behindAlign = 0;
    let crowd = 0;
    const karts = world.karts;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o.id === this.kartId) continue;
      _rel.subVectors(o.position, st.position);
      const d = _rel.length();
      if (d < ITEMS.starRadius) crowd++;
      if (d < 0.5) continue;
      _tmp.copy(_rel).multiplyScalar(1 / d);
      const fdot = _tmp.dot(_fwd);
      const adotAbs = Math.abs(_tmp.dot(_right));
      if (fdot > 0 && d < aheadDist) {
        aheadDist = d;
        aheadId = o.id;
        aheadAlign = adotAbs;
      } else if (fdot <= 0 && d < behindDist) {
        behindDist = d;
        behindId = o.id;
        behindAlign = adotAbs;
      }
    }

    const straight = Math.abs(this.farWindow.signed) < ITEMS.straightIntegral;
    const speedRatio = clamp01(st.speedRatio);
    const offRoad =
      st.surface !== SurfaceType.Road &&
      st.surface !== SurfaceType.Boost &&
      st.surface !== SurfaceType.Metal;
    const cornerExit = st.boostTime <= 0 && Math.abs(this.nearWindow.signed) < 0.3 &&
      Math.abs(this.farWindow.signed) < 0.5;

    switch (held) {
      case ItemType.Boost:
      case ItemType.TripleBoost: {
        const count = held === ItemType.TripleBoost ? 3 : 1;
        if (offRoad) return { back: false, target: -1, count };
        if (st.boostTime > 0.15) return null;
        if ((straight || cornerExit) && speedRatio > ITEMS.boostMinRatio) {
          return { back: false, target: -1, count };
        }
        if (impatient > 0.85 && this.holdTimer > 2.5) return { back: false, target: -1, count };
        return null;
      }

      case ItemType.GreenShell:
      case ItemType.TripleGreenShell: {
        const count = held === ItemType.TripleGreenShell ? 3 : 1;
        const tol = ITEMS.greenAlign * lerp(2.2, 0.8, skillItem);
        if (aheadId >= 0 && aheadDist < ITEMS.greenRange && aheadAlign < tol) {
          return { back: false, target: aheadId, count };
        }
        if (behindId >= 0 && behindDist < ITEMS.rearRange && behindAlign < ITEMS.rearAlign) {
          return { back: true, target: behindId, count };
        }
        if (impatient > 0.8 && this.holdTimer > 4) return { back: false, target: -1, count };
        return null;
      }

      case ItemType.RedShell:
      case ItemType.TripleRedShell: {
        const count = held === ItemType.TripleRedShell ? 3 : 1;
        const range = ITEMS.redRange * lerp(0.55, 1.05, skillItem);
        if (aheadId >= 0 && aheadDist < range) {
          // Good users wait for a straight so the shell doesn't eat a wall.
          if (skillItem < 0.5 || straight || aheadDist < 22) {
            return { back: false, target: aheadId, count };
          }
        }
        if (behindId >= 0 && behindDist < ITEMS.rearRange * 0.8 && p.shieldTendency < 0.5) {
          return { back: true, target: behindId, count };
        }
        if (impatient > 0.85 && this.holdTimer > 5) return { back: false, target: aheadId, count };
        return null;
      }

      case ItemType.Banana:
      case ItemType.TripleBanana: {
        const count = held === ItemType.TripleBanana ? 3 : 1;
        // Drop on the line, at an apex — exactly where a chaser turns in.
        const atApex = Math.abs(this.hereSample.curvature) > 0.012;
        if (atApex && skillItem > 0.4) return { back: true, target: -1, count };
        if (behindId >= 0 && behindDist < ITEMS.rearRange * 0.7) {
          return { back: true, target: behindId, count };
        }
        if (this.holdTimer > (p.shieldTendency > 0.7 ? 11 : 5.5)) {
          return { back: true, target: -1, count };
        }
        return null;
      }

      case ItemType.Bomb: {
        if (aheadId >= 0 && aheadDist < ITEMS.bombRange && aheadAlign < 0.28) {
          return { back: false, target: aheadId, count: 1 };
        }
        if (behindId >= 0 && behindDist < 14) return { back: true, target: behindId, count: 1 };
        if (this.holdTimer > 7) return { back: false, target: -1, count: 1 };
        return null;
      }

      case ItemType.Star: {
        // Save it for a crowded moment — that is when invincibility pays.
        if (crowd >= ITEMS.starCrowd) return { back: false, target: -1, count: 1 };
        if (threatened) return { back: false, target: -1, count: 1 };
        if (offRoad) return { back: false, target: -1, count: 1 };
        if (this.holdTimer > lerp(1.4, 6.5, skillItem)) {
          return { back: false, target: -1, count: 1 };
        }
        return null;
      }

      case ItemType.Bullet: {
        // Only useful from a long way back and not on the final approach.
        const behindField = st.racePosition >= Math.max(5, Math.floor(world.fieldSize * 0.5));
        if (behindField && this.holdTimer > 0.8) return { back: false, target: -1, count: 1 };
        if (this.holdTimer > 8) return { back: false, target: -1, count: 1 };
        return null;
      }

      case ItemType.Lightning:
      case ItemType.BlueShell: {
        // Best used when the field is spread ahead of us.
        if (st.racePosition > 1 && this.holdTimer > lerp(0.6, 3.0, skillItem)) {
          return { back: false, target: -1, count: 1 };
        }
        if (this.holdTimer > 6) return { back: false, target: -1, count: 1 };
        return null;
      }

      case ItemType.Ghost:
      case ItemType.Squid:
      case ItemType.Coin:
      default:
        if (this.holdTimer > 0.5) return { back: false, target: -1, count: 1 };
        return null;
    }
  }

  // -------------------------------------------------------------------------

  private updateDebug(world: DriverWorld, targetSpeed: number): void {
    const d = this.debug;
    const st = this.state;
    d.enabled = this.enabled;
    d.mode = this.mode;
    d.variant = this.variant;
    d.steer = this.control.steer;
    d.accel = this.control.accel;
    d.brake = this.control.brake;
    d.drift = this.control.drift;
    d.driftPhase = this.driftPhase;
    d.driftStage = st ? st.driftStage : 0;
    d.speed = st ? st.speed : 0;
    d.targetSpeed = targetSpeed;
    d.lateralError = this.near.lateral;
    d.avoidBias = this.avoidBias + this.blockBias;
    d.lookahead.copy(this.lookaheadPoint);
    d.lookaheadDistance = this.lookaheadPoint.distanceTo(st ? st.position : this.lookaheadPoint);
    d.cornerIntegral = this.farWindow.signed;
    d.risk = this.band.risk;
    d.speedMul = this.band.speedMul;
    d.pressure = this.pressure;
    d.stuckTimer = this.stuckTimer;
    d.itemPending = this.itemPending;
    d.progress = st ? st.progress : 0;
    d.lap = st ? st.lap : 0;
    d.mistake = this.error.mistakeKind;
    d.mistakes = this.error.mistakeCount;
    d.wallBias = this.wallBias;
    d.wallDepth = this.wallDepth;
    d.wallTouch = this.wallTouch;
    d.stuckEpisodes = this.stuckEpisodes;
    this.lapWatch = world.elapsed;
  }
}
