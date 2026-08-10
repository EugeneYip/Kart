/**
 * ============================================================================
 *  APEX KART — PHYSICS WORLD
 * ============================================================================
 *  The only entry point into physics. Everything else in the game talks to this
 *  object and nothing else in `src/physics`.
 *
 *  Runs at a fixed 120 Hz (Config.FIXED_DT). ALL physics happens here — no
 *  subsystem is allowed to move a kart. PhysicsWorld writes results into the
 *  `KartState` objects it was handed by `setKarts()` and never touches a mesh,
 *  a material or the scene graph.
 *
 *  Step order per tick, and why it is this order:
 *
 *    1. Suspension          reads the CURRENT pose → contact normals, spring
 *                           forces, grounded flags, body attitude.
 *    2. DriftSystem         needs fresh `grounded` (to land a hop) and must set
 *                           the drift phase BEFORE the integrator reads it.
 *    3. stepKart            yaw, tyre model, drive/drag, gravity, integration.
 *    4. Walls               positional + slide response, per kart.
 *    5. Bounds              respawn triggers.
 *    6. Kart ↔ kart         one pass over all pairs, after everyone has moved.
 *    7. writeState          publish to KartState (once, at the end, so nobody
 *                           ever observes a half-resolved frame).
 *
 *  ZERO ALLOCATIONS after `setKarts`. Every vector/quaternion lives at module
 *  scope in this file or in KartPhysics/Suspension/KartCollision.
 * ============================================================================
 */

import * as THREE from 'three';
import type {
  FrameContext,
  ISubsystem,
  ITrackService,
  KartState,
  KartTuning,
} from '@/core/Types';
import { clamp } from '@/core/MathUtils';
import { Suspension } from './Suspension';
import { DriftSystem } from './DriftSystem';
import { checkBounds, resolveKartPairs, resolveWalls } from './KartCollision';
import {
  applyBoostTo,
  applyImpulseTo,
  applyStunTo,
  beginRespawn,
  cancelDrift,
  createBody,
  stepKart,
  writeState,
  type BoostSource,
  type KartBody,
  type StunKind,
} from './KartPhysics';
import { DEFAULT_TUNING_ID, makeTuning, type CCClass } from './Tuning';

export interface KartControl {
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  driftPressed: boolean;
}

const BOOST_SOURCES: readonly BoostSource[] = ['drift', 'item', 'pad', 'start', 'trick'];
const STUN_KINDS: readonly StunKind[] = ['spin', 'squash', 'flip', 'shock'];

export class PhysicsWorld implements ISubsystem {
  /** Per-kart chassis tuning. Public so UI/AI can read stats without a getter. */
  readonly tunings = new Map<number, KartTuning>();

  /** Live bodies, in the same order as the `KartState[]` handed to setKarts. */
  readonly bodies: KartBody[] = [];

  /** Rolling average cost of one fixed step for ALL karts, milliseconds. */
  stepMs = 0;
  /** Worst single step seen since the last `resetPerf()`. */
  stepMsPeak = 0;

  private track: ITrackService;
  private suspension = new Suspension();
  private drift = new DriftSystem();
  private byId = new Map<number, KartBody>();
  private cc: CCClass = 150;
  private frozen = false;

  constructor(track: ITrackService) {
    this.track = track;
  }

  init(): void {
    /* Nothing to build — the solvers are stateless. Present for ISubsystem. */
  }

  // -------------------------------------------------------------------------
  //  Setup
  // -------------------------------------------------------------------------

  /**
   * Adopt the authoritative kart list. Called once by Game after KartManager has
   * created the `KartState` objects; safe to call again to rebuild the field.
   * Tunings registered via `setTuning()` before this call are honoured.
   */
  setKarts(karts: KartState[]): void {
    this.bodies.length = 0;
    this.byId.clear();
    for (let i = 0; i < karts.length; i++) {
      const st = karts[i];
      let tuning = this.tunings.get(st.id);
      if (!tuning) {
        tuning = makeTuning(DEFAULT_TUNING_ID, this.cc);
        this.tunings.set(st.id, tuning);
      }
      const body = createBody(st, tuning);
      this.bodies.push(body);
      this.byId.set(st.id, body);
      writeState(body, 1 / 120);
    }
  }

  /** Replace one kart's chassis. Takes effect on the next step. */
  setTuning(kartId: number, tuning: KartTuning): void {
    this.tunings.set(kartId, tuning);
    const b = this.byId.get(kartId);
    if (b) b.tuning = tuning;
  }

  /** Default CC class for karts whose tuning wasn't supplied explicitly. */
  setCC(cc: CCClass): void {
    this.cc = cc;
  }

  /** Freeze the field (countdown, race end cinematics) without losing state. */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  // -------------------------------------------------------------------------
  //  Per-frame control input
  // -------------------------------------------------------------------------

  /**
   * Push control for one kart. Called at DISPLAY rate by the player input path
   * and by the AI; `driftPressed` is LATCHED (OR-ed) rather than overwritten, so
   * a press can never be lost when zero fixed steps run in a frame, nor be
   * consumed twice when two do.
   */
  setControl(kartId: number, c: KartControl): void {
    const b = this.byId.get(kartId);
    if (!b) return;
    b.ctrlSteer = clamp(c.steer, -1, 1);
    b.ctrlAccel = clamp(c.accel, 0, 1);
    b.ctrlBrake = clamp(c.brake, 0, 1);
    b.ctrlDrift = c.drift;
    if (c.driftPressed) b.ctrlDriftPressed = true;
  }

  // -------------------------------------------------------------------------
  //  External effects (items, race director)
  // -------------------------------------------------------------------------

  applyBoost(kartId: number, seconds: number, strength: number, source: string): void {
    const b = this.byId.get(kartId);
    if (!b) return;
    const src = (BOOST_SOURCES.includes(source as BoostSource) ? source : 'item') as BoostSource;
    applyBoostTo(b, seconds, strength, src);
  }

  applyStun(kartId: number, seconds: number, kind: 'spin' | 'squash' | 'flip' | 'shock'): void {
    const b = this.byId.get(kartId);
    if (!b) return;
    const k = (STUN_KINDS.includes(kind) ? kind : 'spin') as StunKind;
    applyStunTo(b, seconds, k);
  }

  /** Newton-seconds, world space. */
  applyImpulse(kartId: number, impulse: THREE.Vector3): void {
    const b = this.byId.get(kartId);
    if (b) applyImpulseTo(b, impulse);
  }

  respawn(kartId: number): void {
    const b = this.byId.get(kartId);
    if (b) beginRespawn(b, this.track);
  }

  /** Star power / bullet: temporary invulnerability without a stun. */
  setInvulnerable(kartId: number, seconds: number): void {
    const b = this.byId.get(kartId);
    if (b) b.invulnTime = Math.max(b.invulnTime, seconds);
  }

  /** Drop the drift with no payout — used when an item interrupts you. */
  breakDrift(kartId: number): void {
    const b = this.byId.get(kartId);
    if (b) cancelDrift(b, false);
  }

  /**
   * Teleport (grid placement, bullet bill rails, debug). Clears momentum so the
   * kart doesn't inherit whatever it was doing before.
   */
  place(kartId: number, position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    const b = this.byId.get(kartId);
    if (!b) return;
    b.position.copy(position);
    b.prevPosition.copy(position);
    b.velocity.set(0, 0, 0);
    b.groundQuat.copy(quaternion);
    b.bodyQuat.copy(quaternion);
    b.forward.set(0, 0, -1).applyQuaternion(quaternion);
    b.up.set(0, 1, 0).applyQuaternion(quaternion);
    b.yawRate = 0;
    b.pitch = 0;
    b.roll = 0;
    b.pitchVel = 0;
    b.rollVel = 0;
    b.forwardSpeed = 0;
    b.lateralSpeed = 0;
    b.longAccel = 0;
    b.lateralAccel = 0;
    b.boostTime = 0;
    b.boostStrength = 0;
    b.stunTime = 0;
    b.stunKind = 'none';
    b.respawnTime = 0;
    b.fallTime = 0;
    b.airTime = 0;
    b.hadGround = false;
    cancelDrift(b, false);
    for (let i = 0; i < 4; i++) {
      const w = b.wheels[i];
      w.springLen = b.tuning.suspensionRest;
      w.prevSpringLen = w.springLen;
      w.compression = 0;
      w.grounded = false;
      w.force = 0;
    }
    writeState(b, 1 / 120);
  }

  // -------------------------------------------------------------------------
  //  Read-only accessors for the other subsystems
  // -------------------------------------------------------------------------

  getBody(kartId: number): KartBody | undefined {
    return this.byId.get(kartId);
  }

  tuningOf(kartId: number): KartTuning | undefined {
    return this.tunings.get(kartId);
  }

  /** Slip angle in radians — VFX uses it for tyre smoke, camera for shake. */
  slipAngleOf(kartId: number): number {
    return this.byId.get(kartId)?.slipAngle ?? 0;
  }

  /** 0..1 how much grip the tyres are actually finding. */
  gripOf(kartId: number): number {
    return this.byId.get(kartId)?.gripFactor ?? 1;
  }

  /** Per-wheel slide amount 0..1, for smoke/skid decals. FL FR RL RR. */
  wheelSlipOf(kartId: number, wheel: number): number {
    return this.byId.get(kartId)?.wheels[wheel]?.slip ?? 0;
  }

  /** Vertical squash (squash stun) and uniform shrink (shock stun). 1 = normal. */
  visualScaleOf(kartId: number): number {
    return this.byId.get(kartId)?.visualScale ?? 1;
  }
  visualShrinkOf(kartId: number): number {
    return this.byId.get(kartId)?.visualShrink ?? 1;
  }

  /** Trick name currently being performed, or null. */
  trickOf(kartId: number): string | null {
    const b = this.byId.get(kartId);
    return b && b.trickActive ? b.trickName : null;
  }

  /** Effective top speed right now, including boost and surface. */
  softCapOf(kartId: number): number {
    const b = this.byId.get(kartId);
    if (!b) return 0;
    return b.tuning.maxSpeed + (b.boostTime > 0 ? b.boostStrength * 11 : 0);
  }

  resetPerf(): void {
    this.stepMsPeak = 0;
  }

  // -------------------------------------------------------------------------
  //  The step
  // -------------------------------------------------------------------------

  fixedUpdate(ctx: FrameContext): void {
    const dt = ctx.fixedDt;
    const bodies = this.bodies;
    const n = bodies.length;
    if (n === 0) return;

    const t0 = performance.now();

    if (this.frozen) {
      // Countdown: the kart is alive (suspension settles, engine revs) but it
      // cannot move. Throttle still feeds the rev counter for a rocket start.
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        this.suspension.solve(b, this.track, dt);
        b.velocity.set(0, 0, 0);
        b.forwardSpeed = 0;
        b.lateralSpeed = 0;
        b.yawRate = 0;
        b.ctrlDriftPressed = false;
        b.wasGrounded = b.grounded;
        writeState(b, dt);
      }
      this.recordPerf(t0);
      return;
    }

    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      this.suspension.solve(b, this.track, dt);
      this.drift.update(b, dt);
      stepKart(b, dt, this.track);
      if (b.respawnTime <= 0) {
        resolveWalls(b, this.track, dt);
        checkBounds(b, this.track, dt);
      }
    }

    resolveKartPairs(bodies, dt);

    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      b.wasGrounded = b.grounded;
      writeState(b, dt);
    }

    this.recordPerf(t0);
  }

  private recordPerf(t0: number): void {
    const ms = performance.now() - t0;
    // 0.06 EMA ≈ a ~1/4 s window at 120 Hz. Cheap and allocation-free.
    this.stepMs += (ms - this.stepMs) * 0.06;
    if (ms > this.stepMsPeak) this.stepMsPeak = ms;
  }

  dispose(): void {
    this.bodies.length = 0;
    this.byId.clear();
    this.tunings.clear();
  }
}
