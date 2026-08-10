/**
 * ============================================================================
 *  APEX KART — AI DRIVER
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
import type { KartState } from '@/core/Types';
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
  blendSkill,
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
  /** Yaw authority estimate, rad/s at full lock, low speed. */
  yawAuthority: 2.6,
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
  /** Cap on brake while drifting — you hold the throttle through a slide. */
  driftBrakeCap: 0.0,
  /** Off-road: pull the target down so they don't fight the surface. */
  offRoadTargetMul: 0.82,
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
  /** Bail out of a drift if we are this far outside the road edge. */
  bailMargin: 0.6,
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

/** Everything a driver may read about the world, owned by AIManager. */
export interface DriverWorld {
  line: RacingLine;
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

  // ---- reusable query objects -------------------------------------------
  private readonly near: NearestResult = createNearestResult();
  private readonly aheadSample: LineSample = createLineSample();
  private readonly hereSample: LineSample = createLineSample();
  private readonly targetSample: LineSample = createLineSample();
  private readonly farWindow: CurvatureWindow = createCurvatureWindow();
  private readonly nearWindow: CurvatureWindow = createCurvatureWindow();
  private readonly lookaheadPoint = new THREE.Vector3();

  // ---- steering state ----------------------------------------------------
  private steerSmooth = 0;
  private lateralPrev = 0;
  private hintStation = -1;

  // ---- speed state -------------------------------------------------------
  private speedIntegral = 0;

  // ---- line choice -------------------------------------------------------
  private variant: LineVariant = 'optimal';
  private variantCooldown = 0;
  private variantShift = 0;
  private lastLineLateral = 0;

  // ---- avoidance ---------------------------------------------------------
  private avoidBias = 0;
  private blockBias = 0;
  private weavePhase = 0;

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
    this.skill = blendSkill(personality, ccProfile);
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
    };
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
    this.skill = blendSkill(p, ccProfile);
    this.debug.personality = p.id;
    this.debug.label = p.label;
  }

  setCCProfile(ccProfile: SkillProfile): void {
    this.skill = blendSkill(this.personality, ccProfile);
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
    this.blockBias = 0;
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
      world.elapsed,
      this.pressure,
      clamp01(this.skill.lineAccuracy * 0.7 + this.skill.item * 0.3),
      this.personality,
    );

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
    const authority = STEER.yawAuthority * (0.55 + 0.45 / (1 + absSpeed * 0.04));
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

  /** 0..1 — how contested the situation is. Feeds the mistake model. */
  private computePressure(world: DriverWorld, st: KartState): number {
    let p = 0;
    const karts = world.karts;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o === st || o.id === this.kartId) continue;
      const d = o.position.distanceTo(st.position);
      if (d < 16) {
        p += (1 - d / 16) * 0.55;
        if (o.isPlayer) p += (1 - d / 16) * 0.35;
      }
    }
    if (st.racePosition <= 3) p += 0.1;
    return clamp01(p);
  }

  // -------------------------------------------------------------------------
  //  Tactics — line choice
  // -------------------------------------------------------------------------

  private chooseVariant(dt: number, world: DriverWorld, st: KartState): void {
    if (this.variantCooldown > 0) return;
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

    if (want !== this.variant) {
      // Carry the lateral difference as a decaying shift so the target never
      // jumps — a stepped target reads as a twitch.
      const before = this.lastLineLateral;
      this.variant = want;
      world.line.sample(this.near.t, this.targetSample, want);
      this.variantShift = clamp(before - this.targetSample.lateral + this.variantShift, -5, 5);
      this.variantCooldown = 0.6;
    }

    // Blocking bias — cover the side the chaser is on.
    let blockTarget = 0;
    if (behindGap < AVOID.rearRange && p.blocking > 0.25) {
      const w = 1 - behindGap / AVOID.rearRange;
      blockTarget = sign(behindLat) * w * p.blocking * 2.3;
      if (p.id === 'blocker') {
        blockTarget += Math.sin(this.weavePhase * 1.4) * w * 1.6;
      }
    }
    this.blockBias = damp(this.blockBias, blockTarget, 0.35, dt);
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
    let v = Math.min(this.hereSample.targetSpeed, this.targetSample.targetSpeed);

    // Pace: personality × CC × rubber band × slow wobble.
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

    // Never brake in the air (nothing to brake against) and never brake mid
    // drift (you hold the throttle through a slide).
    if (!st.grounded) c.brake = 0;
    if (st.drifting || this.driftPhase === 'hop' || this.driftPhase === 'hold') {
      c.brake = Math.min(c.brake, SPEED.driftBrakeCap);
      c.accel = Math.max(c.accel, 0.85);
    }
    // Boosting? Foot down.
    if (st.boostTime > 0) {
      c.accel = 1;
      c.brake = 0;
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
    const canDrift =
      st.grounded &&
      absSpeed > DRIFT.minSpeed &&
      !st.stunned &&
      this.mode === 'race' &&
      roomLeft > DRIFT.bailMargin;

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
        if (roomLeft < DRIFT.bailMargin || st.stunned || this.mode !== 'race') {
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
    }

    if (this.mode === 'grid') {
      if (world.raceStarted) this.mode = 'race';
      return;
    }

    if (this.mode === 'race') {
      const trapped =
        this.stuckTimer > RECOVER.stuckSeconds ||
        this.wrongWayTimer > RECOVER.wrongWaySeconds ||
        this.offTrackTimer > RECOVER.offTrackSeconds;
      if (trapped) {
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
    if (this.mode === 'reverse' && this.modeTimer > RECOVER.reverseSeconds) {
      this.mode = 'realign';
      this.modeTimer = 0;
    } else if (this.mode === 'realign') {
      const back = Math.abs(this.near.lateralFromCentre) < this.near.halfWidth * 0.85;
      if (alignment > RECOVER.exitAlignment && back && absSpeed > RECOVER.exitSpeed) {
        this.mode = 'race';
        this.modeTimer = 0;
        this.stuckTimer = 0;
        this.wrongWayTimer = 0;
        this.offTrackTimer = 0;
        this.recoverTotal = 0;
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
    // Aim at a point comfortably up the line, on the centre of the road.
    line.sampleAhead(this.near.t, this.mode === 'reverse' ? 10 : 14, this.aheadSample, 'optimal');
    this.lookaheadPoint.copy(this.aheadSample.position);

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
    this.lapWatch = world.elapsed;
  }
}
