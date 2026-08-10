/**
 * ============================================================================
 *  CHASE CAMERA — the feel of the game
 * ============================================================================
 *  The single most important idea in here: **the camera yaw follows the kart's
 *  velocity direction, not its facing.** During a drift the nose points inward
 *  while the camera stays behind the direction of travel, which is exactly why
 *  MK8 drifts read so clearly — you see the kart's flank, and the corner stays
 *  in frame.
 *
 *  Everything else is in service of that: a critically damped spring arm,
 *  speed-coupled distance and FOV, terrain-anticipating pitch, sub-4° roll,
 *  wall-aware pull-in, noise shake, landing dips and boost punches.
 *
 *  `CameraRig` owns the mechanism, `CinematicCamera` owns the authored shots,
 *  this file owns the direction. No allocations in `update()`.
 * ============================================================================
 */

import * as THREE from 'three';
import type {
  FrameContext,
  InputState,
  ISubsystem,
  ITrackService,
  KartState,
  TrackSample,
} from '@/core/Types';
import { bus } from '@/core/EventBus';
import { RACE } from '@/core/Config';
import { angleDelta, clamp, clamp01, damp, smoothstep } from '@/core/MathUtils';
import {
  CameraRig,
  callOptional,
  clampDistance,
  createRigTargets,
  projectOnPlane,
  readVector3,
  Spring,
  yawDirection,
  yawOf,
  type IKartRoster,
  type LateDependency,
  type RigTargets,
} from './CameraRig';
import { CinematicCamera, type ChasePose } from './CinematicCamera';

export type CameraMode =
  | 'chase'
  | 'chase-far'
  | 'first-person'
  | 'cinematic'
  | 'intro'
  | 'results'
  | 'replay'
  | 'free';

/**
 * Every number that defines the feel. Tuned by driving the rig in
 * `src/dev/camera.html` — see the report for what each one changes.
 */
export const CAMERA_TUNING = {
  // --- framing ---
  baseFov: 65,
  fovAtTopSpeed: 82,
  fovBoostKick: 6.5,
  fovMin: 60,
  fovMax: 92,
  fovSpeedExponent: 1.35,
  fovAttackOmega: 13.0,
  fovReleaseOmega: 4.4,
  fovZeta: 0.85,

  // --- spring arm ---
  baseDistance: 5.4,
  baseHeight: 2.15,
  distanceSpeedGain: 1.2,
  heightSpeedGain: 0.2,
  boostDistancePunch: 1.0,
  farDistanceBonus: 1.6,
  farHeightBonus: 0.55,
  lookBackDistance: 0.5,
  /** Hard Euclidean bounds on camera↔kart separation. */
  minSeparation: 3.7,
  maxSeparation: 8.8,
  posOmega: 11.5,
  posZeta: 1.0,
  lookOmega: 9.5,
  lookZeta: 1.0,
  /**
   * Fraction of the spring's steady-state lag cancelled by velocity
   * feed-forward. 1.0 = exact. Without this the camera sits `2·zeta·v/omega`
   * (≈6.9 m at 40 m/s) too far back and `maxSeparation` — not `baseDistance` —
   * ends up framing the shot at speed. Slightly under 1 keeps a whisper of
   * "the speed is pulling the camera back", which reads well.
   */
  velocityLead: 0.94,

  // --- yaw: velocity-led, not facing-led ---
  /** slerp(velocityYaw, kartYaw, facingBlend) — 0.25 keeps a hint of the nose. */
  facingBlend: 0.25,
  velocityYawMinSpeed: 2.2,
  velocityYawFullSpeed: 6.5,
  yawOmega: 8.5,
  yawZeta: 0.92,
  yawLookBackOmega: 16.0,
  yawLookBackZeta: 0.58,
  yawReturnZeta: 0.95,
  /** Yaw lead into the drift, radians (~5.5°) — keeps the apex visible. */
  driftLeadRad: 0.096,
  /** Camera slides to the *outside* of the drift arc, metres. */
  driftShoulder: 0.95,

  // --- look target ---
  lookHeight: 1.15,
  lookAheadBase: 3.2,
  lookAheadSpeed: 7.5,

  // --- terrain anticipation ---
  terrainAheadBase: 6.0,
  terrainAheadSpeed: 12.0,
  /**
   * How much of the rise ahead is fed into the rig height. Kept low: at 0.5
   * with a ±6 m clamp a steep crest threw the camera 3 m upward, which both
   * looked like a jump cut and pushed the rig into `maxSeparation`, so the
   * clamp — not the art direction — ended up framing the shot.
   */
  terrainAnchorAnticipation: 0.32,
  /** The look point may lift more: that is what keeps the horizon steady. */
  terrainLookAnticipation: 0.85,
  /** Metres of rise/drop that anticipation responds to at all. */
  terrainRiseClamp: 3.5,

  // --- roll ---
  rollMax: 0.061, // 3.5°
  rollFromLateral: 0.0042,
  rollFromDrift: 0.026,
  rollOmega: 6.5,
  rollZeta: 1.0,

  // --- impulses ---
  landingDipVelocity: 5.4,
  landingDipMax: 1.0,
  landingShake: 0.55,
  boostPunchHalfLife: 0.085,
  boostReleaseHalfLife: 0.34,
  boostForwardTilt: 0.55,

  // --- world interaction ---
  upBlendHalfLife: 0.115, // ≈0.4 s to settle on a new track normal
  groundClearance: 0.4,
  collisionRadius: 0.45,
  collisionSteps: 6,
  occlusionAttack: 0.035,
  occlusionRelease: 0.3,

  // --- countdown framing ---
  countdownPullIn: 0.8,
  countdownOrbit: 0.42,

  // --- first person ---
  fpHeight: 1.02,
  fpForward: 0.24,
  fpFov: 78,
  fpFovSpeedGain: 8,
  fpSteerLook: 0.14,
  fpBobAmplitude: 0.022,

  /** Fallback for speedRatio when a kart doesn't publish one. */
  topSpeedRef: 30,
} as const;

// --- module scratch: the update path allocates nothing -----------------------
const _kartFwd = new THREE.Vector3();
const _fwdPlane = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upTarget = new THREE.Vector3(0, 1, 0);
const _anchor = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _yawDir = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, -1);

export class ChaseCamera implements ISubsystem {
  readonly baseFov: number = CAMERA_TUNING.baseFov;

  private camera: THREE.PerspectiveCamera;
  private karts: IKartRoster;
  private track: ITrackService;
  private input: InputState;

  readonly rig = new CameraRig();
  readonly cinematic: CinematicCamera;

  private mode: CameraMode = 'chase';
  private targetId = 0;
  private targets: RigTargets = createRigTargets();

  // --- solved state ---
  private yaw = 0;
  private yawVel = 0;
  private prevKartYaw = 0;
  private readonly dist = new Spring(CAMERA_TUNING.baseDistance);
  private readonly height = new Spring(CAMERA_TUNING.baseHeight);
  private speedSmooth = 0;
  private boostPunch = 0;
  private occlusion = 1;
  private lookBackOffset = 0;
  private lookBackSign = 1;
  private bobPhase = 0;
  private initialised = false;

  // --- late-wired deps ---
  private vfx: LateDependency | null = null;
  private race: LateDependency | null = null;
  private lastRaceState = '';

  // --- capability flags (other agents build in parallel) ---
  private canProject = false;
  private canSampleDistance = false;
  private canCollide = false;
  private canRaycast = false;
  private canBounds = false;

  private unsubscribe: Array<() => void> = [];

  /** Live numbers for the debug HUD / automated assertions. */
  readonly debug = {
    mode: 'chase' as string,
    distance: 0,
    fov: 65,
    /** Radians between the camera yaw and the kart's velocity direction. */
    yawError: 0,
    /** Radians between the camera yaw and the kart's facing. */
    facingError: 0,
    posSpringSpeed: 0,
    lookSpringSpeed: 0,
    distSpringVel: 0,
    heightSpringVel: 0,
    occlusion: 1,
    roll: 0,
    speedRatio: 0,
    shake: 0,
    grounded: 0,
  };

  constructor(
    camera: THREE.PerspectiveCamera,
    karts: IKartRoster,
    track: ITrackService,
    input: InputState,
  ) {
    this.camera = camera;
    this.karts = karts;
    this.track = track;
    this.input = input;
    this.cinematic = new CinematicCamera(camera, karts, track, this.rig);
    this.cinematic.setPoseProvider(this.providePose);
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  init(): void {
    const t = this.track as unknown as Record<string, unknown> | null;
    this.canProject = typeof t?.['project'] === 'function';
    this.canSampleDistance = typeof t?.['sampleAtDistance'] === 'function';
    this.canCollide = typeof t?.['collideWalls'] === 'function';
    this.canRaycast = typeof t?.['raycastGround'] === 'function';
    this.canBounds = typeof t?.['isOutOfBounds'] === 'function';

    // Default to the player's kart if the roster already knows one.
    const list = this.karts?.karts;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        if (list[i]?.isPlayer) { this.targetId = list[i].id; break; }
      }
    }

    this.unsubscribe.push(
      bus.on('camera:shake', ({ amount, seconds }) => this.rig.shake.add(amount, seconds)),
      bus.on('kart:land', ({ kartId, impact }) => {
        if (kartId !== this.targetId) return;
        const k = clamp01(impact / 14);
        this.height.kick(-CAMERA_TUNING.landingDipVelocity * Math.min(k, CAMERA_TUNING.landingDipMax));
        this.rig.shake.add(CAMERA_TUNING.landingShake * k, 0.28 + 0.2 * k);
      }),
      bus.on('kart:boost', ({ kartId, duration }) => {
        if (kartId !== this.targetId) return;
        this.boostPunch = Math.min(1.35, this.boostPunch + 0.75 + clamp01(duration / 2) * 0.4);
        this.rig.shake.add(0.22, 0.18);
      }),
      bus.on('kart:wallHit', ({ kartId, impact }) => {
        if (kartId !== this.targetId) return;
        this.rig.shake.add(clamp01(impact / 16) * 0.85, 0.34);
      }),
      bus.on('kart:spinout', ({ kartId }) => {
        if (kartId !== this.targetId) return;
        this.rig.shake.add(0.6, 0.5);
      }),
      bus.on('kart:driftTier', ({ kartId }) => {
        if (kartId !== this.targetId) return;
        this.rig.shake.add(0.12, 0.14);
      }),
      bus.on('race:finish', ({ kartId }) => {
        if (kartId === this.targetId) this.playFinish(kartId);
      }),
    );

    this.snapToTarget();
  }

  setVfx(vfx: LateDependency): void {
    this.vfx = vfx;
    this.cinematic.setVfx(vfx);
  }

  setRace(race: LateDependency): void {
    this.race = race;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.cinematic.dispose();
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    this.debug.mode = mode;
    bus.emit('camera:mode', { mode });

    if (mode === 'chase' || mode === 'chase-far' || mode === 'first-person') {
      // Coming back from an authored shot: re-derive the steady-state pose so
      // the handoff is a cut-free continuation, not a lurch.
      if (prev === 'intro' || prev === 'cinematic' || prev === 'results' || prev === 'replay') {
        this.cinematic.abort();
        this.snapToTarget();
      }
    } else if (mode === 'results') {
      this.cinematic.playResults(this.targetId);
    } else if (mode === 'replay') {
      this.cinematic.startReplay(this.targetId);
    } else if (mode === 'cinematic') {
      this.cinematic.startMenuIdle(this.targetId);
    }
  }

  getMode(): CameraMode { return this.mode; }

  setTarget(kartId: number): void {
    if (this.targetId === kartId) return;
    this.targetId = kartId;
    if (this.mode === 'chase' || this.mode === 'chase-far') this.snapToTarget();
  }

  getTarget(): number { return this.targetId; }

  /** Pre-race flyby. Resolves when the shot has landed on the chase pose. */
  async playIntro(): Promise<void> {
    this.snapToTarget();
    this.mode = 'intro';
    this.debug.mode = 'intro';
    bus.emit('camera:mode', { mode: 'intro' });
    await this.cinematic.playIntro(this.targetId);
    if (this.mode === 'intro') {
      this.mode = 'chase';
      this.debug.mode = 'chase';
      this.snapToTarget();
      bus.emit('camera:mode', { mode: 'chase' });
    }
  }

  /** Beauty pass on the kart crossing the line. */
  playFinish(kartId: number): void {
    this.setTarget(kartId);
    this.mode = 'cinematic';
    this.debug.mode = 'finish';
    bus.emit('camera:mode', { mode: 'finish' });
    this.cinematic.playFinish(kartId);
  }

  /** Title-screen background camera. */
  playMenuIdle(): void { this.setMode('cinematic'); }

  /** TV-style trackside replay. */
  playReplay(kartId = this.targetId): void {
    this.setTarget(kartId);
    this.setMode('replay');
  }

  /**
   * Collapse all lag: place the camera exactly where the chase solution wants
   * it, with zero spring velocity.
   */
  snapToTarget(): void {
    const k = this.currentKart();
    if (!k) return;
    const kartYaw = this.kartYawOf(k);
    this.yaw = this.solveTargetYaw(k, kartYaw, 0);
    this.yawVel = 0;
    this.prevKartYaw = kartYaw;
    this.speedSmooth = this.rawSpeedRatio(k);
    this.occlusion = 1;
    this.lookBackOffset = this.input?.lookBack ? Math.PI * this.lookBackSign : 0;
    this.buildChaseTargets(k, 0, true);
    this.rig.snap(this.targets);
    this.dist.velocity = 0;
    this.height.velocity = 0;
    this.rig.applyTo(this.camera);
    this.initialised = true;
  }

  // -------------------------------------------------------------------------
  // main update
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    const dt = clamp(ctx.dt, 0, 1 / 15);
    // 'free' means another system (the QA harness) is driving the camera.
    if (this.mode === 'free') return;
    this.syncWithRace();

    const k = this.currentKart();
    if (!k) return;
    const kp = k.position;
    if (!isFinite(kp.x) || !isFinite(kp.y) || !isFinite(kp.z)) return;
    if (!this.initialised) this.snapToTarget();

    // Pull shake published by the VFX system (feature-detected).
    const so = readVector3(this.vfx, 'shakeOffset');
    const sr = readVector3(this.vfx, 'shakeRotation');
    if (so) this.rig.shake.externalOffset.copy(so); else this.rig.shake.externalOffset.set(0, 0, 0);
    if (sr) this.rig.shake.externalRotation.copy(sr); else this.rig.shake.externalRotation.set(0, 0, 0);

    if (this.mode === 'intro' || this.mode === 'cinematic' || this.mode === 'results' || this.mode === 'replay') {
      if (!this.cinematic.active) {
        // The authored shot ran out — fall back to gameplay framing.
        this.setMode(this.raceState() === 'results' ? 'results' : 'chase');
        if (this.mode === 'results' && !this.cinematic.active) this.setMode('chase');
      } else {
        this.cinematic.update(dt);
        this.writeDebug(k);
        return;
      }
    }

    if (this.mode === 'first-person') this.solveFirstPerson(k, dt);
    else this.solveChase(k, dt);

    this.writeDebug(k);
  }

  // -------------------------------------------------------------------------
  // chase solve
  // -------------------------------------------------------------------------

  private solveChase(k: KartState, dt: number): void {
    this.buildChaseTargets(k, dt, false);
    this.rig.step(this.targets, dt);
    if (this.rig.sanitize(k.position)) {
      // Something upstream produced NaN — resnap rather than propagate it.
      this.snapToTarget();
      return;
    }
    this.enforceBounds(k);
    this.rig.applyTo(this.camera);
  }

  /**
   * Fill `this.targets` for the current frame. Called with `dt = 0` to preview
   * the steady-state pose (used by the intro handoff and `snapToTarget`).
   */
  private buildChaseTargets(k: KartState, dt: number, snap: boolean): void {
    const T = CAMERA_TUNING;
    const far = this.mode === 'chase-far';
    const kp = k.position;

    // --- speed ------------------------------------------------------------
    const raw = this.rawSpeedRatio(k);
    // Fast attack, slow release: acceleration should feel immediate, lifting
    // off should feel like coasting.
    this.speedSmooth = snap ? raw
      : damp(this.speedSmooth, raw, raw > this.speedSmooth ? 0.085 : 0.22, dt);
    const sr = clamp01(this.speedSmooth);

    // --- boost punch: fast attack, slow release ---------------------------
    const boosting = k.boostTime > 0;
    this.boostPunch = snap ? (boosting ? 1 : 0)
      : damp(this.boostPunch, boosting ? 1 : 0,
        boosting ? T.boostPunchHalfLife : T.boostReleaseHalfLife, dt);
    const punch = clamp(this.boostPunch, 0, 1.35);

    // --- track basis (anti-gravity aware) ---------------------------------
    const sample = this.project(kp);
    _upTarget.copy(sample ? sample.normal : WORLD_UP);
    if (_upTarget.lengthSq() < 1e-6) _upTarget.copy(WORLD_UP);
    else _upTarget.normalize();
    // A kart in the air keeps the last surface normal; a grounded kart on a
    // wall gets the wall's. Blending is done by the rig over ~0.4 s.
    const up = this.targets.up;
    up.copy(_upTarget);

    // --- yaw --------------------------------------------------------------
    const kartYaw = this.kartYawOf(k);
    const targetYaw = this.solveTargetYaw(k, kartYaw, dt);

    const lookBack = this.input?.lookBack === true;
    if (lookBack && Math.abs(this.lookBackOffset) < 0.04) {
      // Swing the way the driver is already leaning; feels intentional.
      this.lookBackSign = (this.input.steer ?? 0) >= 0 ? 1 : -1;
    }
    const lookBackTarget = lookBack ? Math.PI * this.lookBackSign : 0;
    this.lookBackOffset = snap ? lookBackTarget
      : damp(this.lookBackOffset, lookBackTarget, lookBack ? 0.055 : 0.075, dt);
    if (!lookBack && Math.abs(this.lookBackOffset) < 0.004) this.lookBackOffset = 0;

    const yawErr = angleDelta(this.yaw, targetYaw + this.lookBackOffset);
    // Look-behind swings hard with a touch of overshoot; the return is nearly
    // critical so it settles without a second wobble.
    const swinging = lookBack || this.lookBackOffset !== 0;
    const yawOmega = swinging ? T.yawLookBackOmega : T.yawOmega;
    const yawZeta = swinging ? (lookBack ? T.yawLookBackZeta : T.yawReturnZeta) : T.yawZeta;
    if (dt > 0) {
      const w = yawOmega;
      const oo = w * w;
      const den = 1 + 2 * dt * yawZeta * w + dt * dt * oo;
      this.yawVel = (this.yawVel + dt * oo * yawErr) / den;
      this.yaw += dt * this.yawVel;
      if (this.yaw > Math.PI * 4 || this.yaw < -Math.PI * 4) {
        this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      }
    }

    // --- distance / height ------------------------------------------------
    const countdown = this.countdownFraction();
    let distTarget = T.baseDistance
      + sr * T.distanceSpeedGain
      + punch * T.boostDistancePunch
      + (far ? T.farDistanceBonus : 0)
      + (lookBack ? T.lookBackDistance : 0)
      - countdown * T.countdownPullIn;
    let heightTarget = T.baseHeight + sr * T.heightSpeedGain + (far ? T.farHeightBonus : 0);

    // --- terrain anticipation --------------------------------------------
    // Sample a few metres ahead so crests and dips are *anticipated*. Reacting
    // to them is what makes a horizon lurch.
    let rise = 0;
    if (sample) {
      const ahead = T.terrainAheadBase + sr * T.terrainAheadSpeed;
      const aheadSample = this.sampleAhead(sample, ahead);
      if (aheadSample) {
        _tmp.copy(aheadSample.position).sub(sample.position);
        rise = clamp(_tmp.dot(up), -T.terrainRiseClamp, T.terrainRiseClamp);
      }
    }
    heightTarget += rise * T.terrainAnchorAnticipation;

    if (snap) {
      this.dist.snap(distTarget);
      this.height.snap(heightTarget);
    } else {
      this.dist.step(distTarget, 7.5, 1.0, dt);
      this.height.step(heightTarget, 8.5, 1.0, dt);
    }
    const distance = clamp(this.dist.value, 2.6, 11);
    const height = clamp(this.height.value, 0.35, 7);

    // --- basis in the track plane ----------------------------------------
    // A slow pre-race orbit unwinds to dead-behind exactly as GO lands.
    yawDirection(this.yaw + countdown * T.countdownOrbit, _yawDir);
    _kartFwd.copy(FWD).applyQuaternion(k.groundQuaternion ?? k.quaternion);
    projectOnPlane(_yawDir, up, _kartFwd, _fwdPlane);
    _right.copy(_fwdPlane).cross(up).normalize();
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);

    // --- drift shoulder: slide to the outside of the arc ------------------
    const driftIntensity = k.drifting
      ? clamp01(0.55 + 0.45 * (k.driftStage as number) / 4) * clamp01(Math.abs(k.speed) / 8)
      : 0;
    const shoulder = -(k.driftDirection || 0) * T.driftShoulder * driftIntensity;

    // --- anchor -----------------------------------------------------------
    _anchor.copy(kp)
      .addScaledVector(_fwdPlane, -distance)
      .addScaledVector(up, height)
      .addScaledVector(_right, shoulder);

    // Boost tilts the rig forward a touch — reads as leaning into the surge.
    if (punch > 0.001) _anchor.addScaledVector(up, -punch * T.boostForwardTilt * 0.25);

    this.avoidCollision(kp, up, height, dt);
    clampDistance(_anchor, kp, T.minSeparation, T.maxSeparation);
    this.targets.anchor.copy(_anchor);

    // --- look target ------------------------------------------------------
    // `_fwdPlane` is already flipped while looking back, so a positive
    // look-ahead correctly frames whatever is chasing you.
    const lookAhead = T.lookAheadBase + sr * T.lookAheadSpeed;
    _look.copy(kp)
      .addScaledVector(up, T.lookHeight + rise * T.terrainLookAnticipation)
      .addScaledVector(_fwdPlane, lookBack ? lookAhead * 0.55 : lookAhead);
    if (punch > 0.001) _look.addScaledVector(_fwdPlane, punch * 1.4);
    this.targets.look.copy(_look);

    // --- roll -------------------------------------------------------------
    // Derive the turn rate from the *yaw history*, which is far more reliable
    // across physics implementations than a sign convention on angularVelocity.
    const yawRate = dt > 0 ? angleDelta(this.prevKartYaw, kartYaw) / dt : 0;
    this.prevKartYaw = kartYaw;
    // yaw decreases when turning right, so this is +1 for a right-hander.
    const turn = clamp(-yawRate, -4, 4);
    let rollTarget = -turn * Math.abs(k.speed) * T.rollFromLateral;
    rollTarget += -(k.driftDirection || 0) * T.rollFromDrift * driftIntensity;
    this.targets.roll = clamp(rollTarget, -T.rollMax, T.rollMax);

    // --- FOV --------------------------------------------------------------
    const fovTarget = clamp(
      T.baseFov
      + Math.pow(sr, T.fovSpeedExponent) * (T.fovAtTopSpeed - T.baseFov)
      + punch * T.fovBoostKick
      + (lookBack ? -2 : 0),
      T.fovMin, T.fovMax,
    );
    this.targets.fov = fovTarget;
    this.targets.fovOmega = fovTarget > this.rig.fov.value ? T.fovAttackOmega : T.fovReleaseOmega;
    this.targets.fovZeta = T.fovZeta;

    this.targets.posOmega = T.posOmega;
    this.targets.posZeta = T.posZeta;
    this.targets.lookOmega = T.lookOmega;
    this.targets.lookZeta = T.lookZeta;
    this.targets.rollOmega = T.rollOmega;
    this.targets.rollZeta = T.rollZeta;
    this.targets.upHalfLife = T.upBlendHalfLife;

    // --- velocity feed-forward -------------------------------------------
    // Cancel the springs' steady-state lag so the settled pose is the pose we
    // actually authored above. See `RigTargets.anchorLead`.
    const v = k.velocity;
    if (isFinite(v.x) && isFinite(v.y) && isFinite(v.z)) {
      const lead = T.velocityLead;
      this.targets.anchorLead.copy(v).multiplyScalar(lead * 2 * T.posZeta / T.posOmega);
      this.targets.lookLead.copy(v).multiplyScalar(lead * 2 * T.lookZeta / T.lookOmega);
    } else {
      this.targets.anchorLead.set(0, 0, 0);
      this.targets.lookLead.set(0, 0, 0);
    }
  }

  /**
   * The camera's desired heading: mostly the direction of travel, pulled a
   * quarter of the way back toward the nose, plus a lead into the drift.
   */
  private solveTargetYaw(k: KartState, kartYaw: number, dt: number): number {
    const T = CAMERA_TUNING;
    const v = k.velocity;
    const horizontal = Math.sqrt(v.x * v.x + v.z * v.z);

    let yaw = kartYaw;
    // Reversing must not flip the camera in front of the kart.
    if (horizontal > T.velocityYawMinSpeed && k.speed > -0.5) {
      _tmp.set(v.x, 0, v.z);
      const velYaw = yawOf(_tmp);
      const d = angleDelta(kartYaw, velYaw);
      const w = smoothstep((horizontal - T.velocityYawMinSpeed) /
        (T.velocityYawFullSpeed - T.velocityYawMinSpeed));
      yaw = kartYaw + d * (1 - T.facingBlend) * w;
    }

    // Lead into the turn: yaw decreases going right, hence the minus.
    if (k.drifting && k.driftDirection !== 0) {
      const intensity = clamp01(Math.abs(k.speed) / 8);
      yaw -= T.driftLeadRad * k.driftDirection * intensity;
    }
    void dt;
    return yaw;
  }

  /**
   * Sphere-march from the kart to the desired camera position; pull in when
   * blocked, ease back out when clear.
   */
  private avoidCollision(kp: THREE.Vector3, up: THREE.Vector3, height: number, dt: number): void {
    const T = CAMERA_TUNING;
    _origin.copy(kp).addScaledVector(up, height * 0.55);
    _seg.copy(_anchor).sub(_origin);

    let frac = 1;
    if (this.canCollide) {
      const steps = T.collisionSteps;
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        _tmp.copy(_origin).addScaledVector(_seg, f);
        let blocked = false;
        try {
          const hit = this.track.collideWalls(_tmp, T.collisionRadius);
          blocked = hit?.hit === true;
        } catch {
          this.canCollide = false;
        }
        if (!blocked && this.canBounds) {
          try {
            blocked = this.track.isOutOfBounds(_tmp) === true;
          } catch {
            this.canBounds = false;
          }
        }
        if (blocked) {
          frac = Math.max(0.3, (i - 1) / steps);
          break;
        }
      }
    }

    // Snap in (0.035 s), ease out (0.3 s) — a camera that pops back out fast
    // reads as a glitch every time you brush a barrier.
    this.occlusion = damp(this.occlusion, frac,
      frac < this.occlusion ? T.occlusionAttack : T.occlusionRelease, dt);
    if (this.occlusion < 0.999) {
      _anchor.copy(_origin).addScaledVector(_seg, clamp01(this.occlusion));
    }

    // Never below the ground.
    this.clampAboveGround(_anchor, up);
  }

  private clampAboveGround(point: THREE.Vector3, up: THREE.Vector3): void {
    if (!this.canRaycast) return;
    _tmp2.copy(point).addScaledVector(up, 2.5);
    try {
      const hit = this.track.raycastGround(_tmp2, up, 16);
      if (hit?.hit) {
        _tmp2.copy(point).sub(hit.point);
        const above = _tmp2.dot(up);
        if (above < CAMERA_TUNING.groundClearance) {
          point.addScaledVector(up, CAMERA_TUNING.groundClearance - above);
        }
      }
    } catch {
      this.canRaycast = false;
    }
  }

  /** Hard guarantees applied to the committed pose, after the springs. */
  private enforceBounds(k: KartState): void {
    const pos = this.rig.pos.value;
    this.clampAboveGround(pos, this.rig.up);
    clampDistance(pos, k.position, CAMERA_TUNING.minSeparation, CAMERA_TUNING.maxSeparation);
    // Kill any spring velocity that is driving us back into the floor.
    const into = this.rig.pos.velocity.dot(this.rig.up);
    if (into < 0) {
      _tmp2.copy(this.rig.up).multiplyScalar(into * 0.5);
      this.rig.pos.velocity.sub(_tmp2);
    }
  }

  // -------------------------------------------------------------------------
  // first person
  // -------------------------------------------------------------------------

  private solveFirstPerson(k: KartState, dt: number): void {
    const T = CAMERA_TUNING;
    const kp = k.position;
    const sample = this.project(kp);
    const up = this.targets.up;
    up.copy(sample ? sample.normal : WORLD_UP);
    if (up.lengthSq() < 1e-6) up.copy(WORLD_UP);
    else up.normalize();

    const raw = this.rawSpeedRatio(k);
    this.speedSmooth = damp(this.speedSmooth, raw, raw > this.speedSmooth ? 0.085 : 0.22, dt);
    const sr = clamp01(this.speedSmooth);

    _kartFwd.copy(FWD).applyQuaternion(k.quaternion);
    projectOnPlane(_kartFwd, up, _kartFwd, _fwdPlane);
    _right.copy(_fwdPlane).cross(up).normalize();

    // Head bob from wheel travel + speed. Small — this is a helmet cam, not a
    // handheld shot.
    this.bobPhase += dt * (4.5 + sr * 22);
    const susp = k.suspension;
    const compression = susp ? (susp[0] + susp[1] + susp[2] + susp[3]) * 0.25 : 0.5;
    const bob = Math.sin(this.bobPhase) * T.fpBobAmplitude * (0.4 + sr)
      + (0.5 - compression) * 0.06;

    _anchor.copy(kp)
      .addScaledVector(up, T.fpHeight + bob)
      .addScaledVector(_fwdPlane, T.fpForward);

    const lookBack = this.input?.lookBack === true;
    const steer = this.input?.steer ?? 0;
    const lookYaw = (lookBack ? Math.PI : 0) + steer * T.fpSteerLook;
    _tmp.copy(_fwdPlane).applyAxisAngle(up, -lookYaw);
    _look.copy(_anchor).addScaledVector(_tmp, 14).addScaledVector(up, 0.4);

    this.targets.anchor.copy(_anchor);
    this.targets.look.copy(_look);
    this.targets.roll = clamp(-steer * 0.026 - (k.driftDirection || 0) * 0.02 * (k.drifting ? 1 : 0),
      -T.rollMax, T.rollMax);
    this.targets.fov = clamp(T.fpFov + sr * T.fpFovSpeedGain, T.fovMin, T.fovMax);
    this.targets.fovOmega = 10;
    this.targets.posOmega = 42;
    this.targets.posZeta = 1.0;
    this.targets.lookOmega = 18;
    this.targets.lookZeta = 1.0;
    this.targets.rollOmega = 8;
    this.targets.upHalfLife = T.upBlendHalfLife;
    // A helmet cam must be rigidly attached; without the feed-forward it trails
    // ~1.9 m behind the driver's head at 40 m/s.
    const v = k.velocity;
    if (isFinite(v.x) && isFinite(v.y) && isFinite(v.z)) {
      this.targets.anchorLead.copy(v).multiplyScalar(2 * this.targets.posZeta / this.targets.posOmega);
      this.targets.lookLead.copy(v).multiplyScalar(2 * this.targets.lookZeta / this.targets.lookOmega);
    } else {
      this.targets.anchorLead.set(0, 0, 0);
      this.targets.lookLead.set(0, 0, 0);
    }

    this.rig.step(this.targets, dt);
    if (this.rig.sanitize(kp)) return;
    this.rig.applyTo(this.camera);
  }

  // -------------------------------------------------------------------------
  // race integration
  // -------------------------------------------------------------------------

  private raceState(): string {
    const r = this.race as Record<string, unknown> | null;
    const s = r?.['state'];
    return typeof s === 'string' ? s : '';
  }

  /** 1 → 0 across the countdown, for the pre-race framing. */
  private countdownFraction(): number {
    const r = this.race as Record<string, unknown> | null;
    if (!r || this.raceState() !== 'countdown') return 0;
    const c = r['countdown'];
    if (typeof c !== 'number' || !isFinite(c)) return 0;
    return clamp01(c / Math.max(0.1, RACE.countdownSeconds));
  }

  private syncWithRace(): void {
    const state = this.raceState();
    if (state === this.lastRaceState) return;
    this.lastRaceState = state;

    if (state === 'intro') {
      if (this.mode !== 'intro') void this.playIntro();
    } else if (state === 'countdown' || state === 'racing') {
      if (this.mode === 'intro') {
        this.cinematic.abort();
        this.mode = 'chase';
        this.debug.mode = 'chase';
        this.snapToTarget();
      }
    } else if (state === 'results') {
      if (this.mode !== 'results') this.setMode('results');
    }
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private currentKart(): KartState | null {
    const list = this.karts?.karts;
    if (!list || list.length === 0) return null;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k && k.id === this.targetId) return k;
    }
    return list[0] ?? null;
  }

  private rawSpeedRatio(k: KartState): number {
    const r = k.speedRatio;
    if (typeof r === 'number' && isFinite(r) && r !== 0) return clamp01(Math.abs(r));
    const s = typeof k.speed === 'number' && isFinite(k.speed) ? Math.abs(k.speed) : 0;
    return clamp01(s / CAMERA_TUNING.topSpeedRef);
  }

  private kartYawOf(k: KartState): number {
    _kartFwd.copy(FWD).applyQuaternion(k.groundQuaternion ?? k.quaternion);
    if (Math.abs(_kartFwd.x) + Math.abs(_kartFwd.z) < 0.03) return this.prevKartYaw;
    return yawOf(_kartFwd);
  }

  private project(position: THREE.Vector3): TrackSample | null {
    if (!this.canProject) return null;
    try {
      const s = this.track.project(position);
      if (s && isFinite(s.position.x)) return s;
      return null;
    } catch {
      this.canProject = false;
      return null;
    }
  }

  private sampleAhead(from: TrackSample, metres: number): TrackSample | null {
    if (!this.canSampleDistance) return null;
    try {
      const s = this.track.sampleAtDistance(from.distance + metres);
      if (s && isFinite(s.position.x)) return s;
      return null;
    } catch {
      this.canSampleDistance = false;
      return null;
    }
  }

  /** Steady-state chase pose, handed to the cinematic camera for its landing. */
  private providePose = (out: ChasePose): void => {
    const k = this.currentKart();
    if (!k) return;
    this.buildChaseTargets(k, 0, false);
    out.position.copy(this.targets.anchor);
    out.look.copy(this.targets.look);
    out.up.copy(this.targets.up);
    out.fov = this.targets.fov;
  };

  private writeDebug(k: KartState): void {
    const d = this.debug;
    d.mode = this.mode;
    d.distance = this.camera.position.distanceTo(k.position);
    d.fov = this.camera.fov;
    const v = k.velocity;
    const h = Math.sqrt(v.x * v.x + v.z * v.z);
    d.yawError = h > 0.5 ? angleDelta(this.yaw, yawOf(_tmp.set(v.x, 0, v.z))) : 0;
    d.facingError = angleDelta(this.yaw, this.kartYawOf(k));
    d.posSpringSpeed = this.rig.pos.speed;
    d.lookSpringSpeed = this.rig.look.speed;
    d.distSpringVel = this.dist.velocity;
    d.heightSpringVel = this.height.velocity;
    d.occlusion = this.occlusion;
    d.roll = this.rig.roll.value;
    d.speedRatio = this.speedSmooth;
    d.shake = this.rig.shake.amplitude * this.rig.shake.envelope;
    d.grounded = k.grounded ? 1 : 0;
  }

  /** Escape hatch used by the QA harness: nudge the VFX/audio duck, etc. */
  notify(method: string, ...args: unknown[]): void {
    callOptional(this.vfx, method, ...args);
  }
}
