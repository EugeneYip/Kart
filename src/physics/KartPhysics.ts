/**
 * ============================================================================
 *  FOXY KART — ARCADE DRIVING MODEL
 * ============================================================================
 *  This file owns `KartBody` (the physics-side companion to `KartState`) and
 *  the per-kart integration step.
 *
 *  It is deliberately NOT a vehicle simulation. It is a model that *reads* as
 *  physical while staying 100 % predictable for the player:
 *
 *   • Longitudinal — a drive curve that tapers toward a SOFT speed cap, so a
 *     boost can legally exceed the cap and bleed back down instead of clipping.
 *
 *   • Lateral — the chassis yaws freely; the velocity direction chases the
 *     chassis with a *magnitude-preserving rotation* limited by a tyre-load
 *     curve. Preserving magnitude is the single most important trick in the
 *     file: it is why a drift keeps its speed and why chaining drifts is fast.
 *     At extreme slip (spun out, shunted sideways) the model crossfades to
 *     plain lateral damping so momentum can't be laundered into forward speed.
 *
 *   • Vertical — left entirely to Suspension.ts. This file only integrates.
 *
 *  Frame convention: -Z forward, +Y up (see AGENTS.md §2). All chassis maths
 *  happens in the orthonormal triad (forward, right, up) rebuilt every step,
 *  so banked road, ramps and anti-gravity walls all "just work".
 *
 *  Yaw sign convention: POSITIVE yaw rate = turning LEFT (right-hand rule about
 *  `up`). Steering right therefore produces a negative yaw rate. `driftDirection`
 *  keeps the KartState convention (+1 = right).
 * ============================================================================
 */

import * as THREE from 'three';
import type { GroundHit, ITrackService, KartState, KartTuning } from '@/core/Types';
import { DriftStage, SurfaceType } from '@/core/Types';
import { SURFACES, WORLD } from '@/core/Config';
import { bus } from '@/core/EventBus';
import { clamp, clamp01, damp, lerp, moveTowards, smoothstep } from '@/core/MathUtils';

// ---------------------------------------------------------------------------
//  Constants — the feel lives here.
// ---------------------------------------------------------------------------

export const PHYS = {
  /** Peak of the tyre curve, radians (~8°). */
  peakSlip: 0.14,
  /** How much grip is left at huge slip angles, 0..1. */
  slipFalloff: 0.34,
  /** Lateral acceleration budget at grip 1.0, m/s². The steering curve below is
   *  deliberately kept INSIDE this budget at every speed: if the chassis can yaw
   *  faster than the tyres can redirect the velocity, the kart writes off its own
   *  momentum as slip and the player feels a twitchy input followed by a mushy
   *  slide. Only a fully-committed drift is allowed to approach the limit. */
  latAccel: 55,
  /** Speed scrubbed per radian of velocity redirection (gripping / drifting). */
  gripScrub: 0.042,
  driftScrub: 0.03,
  /** Slip window over which magnitude-preserving redirect fades into damping. */
  redirectFadeLo: 0.75,
  redirectFadeHi: 1.45,
  /** Coast drag, 1/s. Almost switched off at full throttle. */
  coastDrag: 0.55,
  /** Surface drag scaling into 1/s. */
  surfaceDragScale: 9.0,
  /** Throttle's suppression of coast drag. */
  throttleDragRelief: 0.95,
  /** How fast overspeed above the soft cap bleeds off, 1/s. */
  overspeedDecay: 1.9,
  /** Boost: extra soft-cap metres/second at strength 1. */
  boostSpeedBonus: 11.0,
  /** Boost: extra forward acceleration at strength 1, m/s². */
  boostAccel: 30.0,
  /** Boost tail, seconds. */
  boostFade: 0.35,
  /** Boost grants off-road immunity for this long. */
  boostOffroadImmunity: 0.4,
  /** Yaw response half-life, seconds. Lower = twitchier. */
  yawHalfLife: 0.045,

  // --- steering authority vs speed -----------------------------------------
  /**
   * `authority = turnRate * (steerFloor + (1-steerFloor) / (1 + (v/steerRef)²))`
   *
   * A square falloff, not the old `1/(1+kv)`: it keeps essentially ALL of the
   * low-speed agility (a hairpin at 5 m/s is unchanged) and then drops away hard,
   * so a 38 m/s sweeper is a wide, planted arc instead of a flick. The old curve
   * bottomed out at 73 % of full authority, which at 38 m/s asked the tyres for
   * 7.3 g — well past the `latAccel` budget — and the surplus yaw came straight
   * back out as slip. Every speed now sits comfortably inside the budget, which
   * is what "planted and predictable" actually means numerically.
   */
  steerFloor: 0.22,
  steerRef: 15,

  // --- steering inertia -----------------------------------------------------
  /** Lock units per second while winding ON. 1/7.0 ≈ 0.14 s to full lock. */
  steerRate: 7.0,
  /** ...and while unwinding. Faster, so you can always catch the kart. */
  steerReturnRate: 11.0,
  /** Smoothing on top of the rate limit — kills the corner in the ramp. */
  steerSmoothHalf: 0.030,

  // --- wall alignment -------------------------------------------------------
  /**
   * A barrier you are leaning on physically resists rotation INTO itself, and
   * modelling that is not cosmetic — it is the difference between a wall you can
   * slide down and a wall that ends your run. Without it the chassis keeps yawing
   * while the wall pins the velocity along its face, so the slip angle marches
   * off toward 90°, the tyre model's large-slip branch stops preserving magnitude
   * and starts plain-damping instead, and the kart's entire momentum is deleted
   * over about a second. Measured: 18 m/s → 0.03 m/s in 3 s of light contact.
   *
   * `wallNoseLimit` is the `forward·n` below which the nose counts as aimed into
   * the wall; `wallAlignRate` is the restoring yaw that walks it back to parallel.
   */
  wallNoseLimit: 0.0,
  wallAlignRate: 2.4,

  // --- the verge band (P0b-5) -----------------------------------------------
  /**
   * Metres past the asphalt edge that count as "fully on the verge". 1.6 m is
   * one kerb width (`TrackBuilder.CROSS.kerbW` = 1.55) — the assumption is
   * documented rather than imported because `ITrackService` publishes
   * `halfWidth` but not the kerb/shoulder widths.
   *
   * `vergeAmount` = clamp01((|lat| - halfWidth) / vergeRef), so a kart whose CoM
   * is 0.4 m over the line is charged a quarter of the drag and a kart sitting
   * squarely on the kerb is charged all of it.
   */
  vergeRef: 1.6,
  /**
   * Continuous drag over the verge band, 1/s at full overlap. **Deliberately
   * NOT multiplied by `throttleDragRelief`**: full throttle switches coast and
   * surface drag almost off (relief = 0.05), so a throttle-scaled term would
   * make cutting a corner across the kerb completely free. This is the number
   * that makes the friction model a real cost instead of an exploit.
   */
  vergeDrag: 0.9,
  /**
   * Surfaces that already charge their own drag (grass, sand, dirt) must not be
   * double-charged: the verge term fades to zero across
   * `vergeSurfaceCap ± vergeSurfaceSpan` of `SurfaceProperties.drag`. Asphalt
   * (0.010), metal (0.008) and ice (0.004) get the full term; dirt (0.055) and
   * grass (0.100) get none.
   */
  vergeSurfaceCap: 0.03,
  vergeSurfaceSpan: 0.02,

  /** Yaw authority retained while airborne. */
  airYawFactor: 0.34,
  /** Aerodynamic downforce at top speed, in g. Keeps ramps landing flat. */
  downforce: 0.55,
  /** Extra hill drama on top of the geometrically-correct slope force. */
  slopeBias: 0.2,
  /** Anti-gravity magnetic stick, m/s². */
  agStick: 22,
  /** Glider: gravity scale + forward bleed (1/s) + pitch authority. */
  glideGravity: 0.2,
  glideBleed: 0.22,
  glidePitch: 7.0,
  /** Hop impulse, m/s, and the gravity scale applied while hopping. */
  hopSpeed: 2.6,
  hopGravity: 0.615, // 2*2.6/(26*0.615) ≈ 0.325 s of hang time
  /** Minimum CoM height above the contact point — the anti-tunnel hard floor. */
  minRideHeight: 0.3,
  /** Ground probe lift for the anti-tunnel clamp, metres. */
  clampLift: 3.0,
  /** Speed below which steering authority is gated off. */
  steerGateSpeed: 1.5,
  /** Boost pad re-trigger cooldown. */
  padCooldown: 0.6,
} as const;

export type BoostSource = 'drift' | 'item' | 'pad' | 'start' | 'trick';
export type StunKind = 'spin' | 'squash' | 'flip' | 'shock' | 'none';

export enum DriftPhase {
  None = 0,
  Hop = 1,
  Drifting = 2,
}

// ---------------------------------------------------------------------------

export interface WheelData {
  /** World-space suspension attachment point. */
  attach: THREE.Vector3;
  /** World-space contact point (valid when grounded). */
  contact: THREE.Vector3;
  normal: THREE.Vector3;
  /** Current spring length, metres. */
  springLen: number;
  prevSpringLen: number;
  /** Normalised compression, 0 = fully extended, 1 = bottomed out. */
  compression: number;
  /** Spring force magnitude along `normal`, newtons. */
  force: number;
  grounded: boolean;
  surface: SurfaceType;
  /** Accumulated rotation, radians. */
  spin: number;
  spinRate: number;
  /** 0..1 — how much this tyre is sliding, drives smoke/marks. */
  slip: number;
}

function makeWheel(): WheelData {
  return {
    attach: new THREE.Vector3(),
    contact: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    springLen: 0.35,
    prevSpringLen: 0.35,
    compression: 0.3,
    force: 0,
    grounded: false,
    surface: SurfaceType.Road,
    spin: 0,
    spinRate: 0,
    slip: 0,
  };
}

/** Everything physics needs that does not belong in the public KartState. */
export interface KartBody {
  readonly id: number;
  state: KartState;
  tuning: KartTuning;

  // ---- control input ----
  ctrlSteer: number;
  ctrlAccel: number;
  ctrlBrake: number;
  ctrlDrift: boolean;
  ctrlDriftPressed: boolean;
  /** `ctrlSteer` after rate limiting — the steering rack's own position. */
  steerRaw: number;
  /** ...and after smoothing. THIS is what the yaw model reads. */
  steerCmd: number;

  // ---- kinematics ----
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  prevPosition: THREE.Vector3;
  /** Orthonormal chassis triad, rebuilt every step. */
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  /** Ground-aligned orientation (no body lean). */
  groundQuat: THREE.Quaternion;
  /** Full visual orientation (lean + pitch + drift roll + stun spin). */
  bodyQuat: THREE.Quaternion;
  /** rad/s about `up`; positive = left. */
  yawRate: number;
  /** Suspension-driven body attitude relative to the contact plane. */
  pitch: number;
  roll: number;
  pitchVel: number;
  rollVel: number;
  /** Extra yaw applied purely for visuals (spin-out). */
  spinYaw: number;

  // ---- suspension output ----
  wheels: WheelData[];
  /** Sum of suspension forces, world space, newtons. */
  suspForce: THREE.Vector3;
  suspTorquePitch: number;
  suspTorqueRoll: number;
  contactNormal: THREE.Vector3;
  /** Contact normal load / static load. Drives grip. */
  loadFactor: number;
  grounded: boolean;
  groundedWheels: number;
  /** `grounded` as of the END of the previous step — drives edge detection. */
  wasGrounded: boolean;
  airTime: number;
  groundTime: number;
  lastGroundPoint: THREE.Vector3;
  lastGroundNormal: THREE.Vector3;
  hadGround: boolean;
  /** Closing speed of the most recent landing, m/s. */
  landImpact: number;

  // ---- surface ----
  surface: SurfaceType;
  prevSurface: SurfaceType;
  rumblePhase: number;
  padCooldown: number;

  // ---- road frame, published once per step by `resolveSurface` --------------
  //  Cached so the contact model can classify a barrier and the drag model can
  //  measure the verge band without either of them projecting again.
  /** Signed lateral offset of the CoM from the centreline, metres (+ = right). */
  roadLat: number;
  /** Half-width of the drivable asphalt at that point, metres. */
  roadHalfWidth: number;
  /** Road surface normal at the nearest centreline point. */
  roadNormal: THREE.Vector3;
  /** Road lateral axis at the nearest centreline point. */
  roadBinormal: THREE.Vector3;
  /**
   * 0..1 — how far past the asphalt edge the CoM is, in units of `PHYS.vergeRef`.
   * Drives the verge friction (KartPhysics) and the verge rumble (Suspension).
   */
  vergeAmount: number;

  // ---- drift ----
  driftPhase: DriftPhase;
  driftDir: number;
  driftTime: number;
  /** Accumulated charge in "charge-seconds", compared against driftTiers. */
  driftCharge: number;
  driftStage: DriftStage;
  driftAngle: number;
  driftAngleTarget: number;
  driftLean: number;
  /** Seconds spent steering fully out of the current drift. */
  counterTime: number;
  hopTime: number;
  hopHeld: boolean;
  /** Seconds left in which a drift press still counts as "at the lip". */
  airDriftGrace: number;

  // ---- tricks ----
  trickArmed: boolean;
  trickActive: boolean;
  trickTime: number;
  trickName: string;
  trickCooldown: number;

  // ---- boost ----
  boostTime: number;
  boostStrength: number;
  boostImmunity: number;

  // ---- stun / respawn ----
  stunKind: StunKind;
  stunTime: number;
  stunTotal: number;
  invulnTime: number;
  respawnTime: number;
  respawnTotal: number;
  respawnFrom: THREE.Vector3;
  respawnTo: THREE.Vector3;
  respawnQuat: THREE.Quaternion;
  fallTime: number;

  // ---- mode ----
  antiGravity: boolean;
  gliding: boolean;
  glideTime: number;
  bumpCooldown: number;
  wallCooldown: number;
  /** True on any tick where a wall probe is overlapping. */
  wallContact: boolean;
  /**
   * What is being touched: 0 none, 1 verge (track edge — friction only),
   * 2 solid scenery. See `Contact` in KartCollision.
   */
  contactClass: number;
  /** Unit normal of the wall last touched, pointing AWAY from the wall. */
  wallNormal: THREE.Vector3;
  /** Seconds left of post-impact grace — see KartCollision.resolveWalls. */
  wallGrace: number;
  /** Closing speed of the impact that opened the current contact, m/s. */
  wallImpactRef: number;
  /**
   * Monotonic count of *penalised* impacts. Since P0b-5 the ONLY thing that can
   * increment this is a near-head-on shunt into solid scenery: a verge contact
   * is friction, not a penalty, and must never appear here. QA asserts on it.
   */
  wallImpacts: number;
  /** Subset of `wallImpacts` charged by solid scenery. Debug/QA only. */
  solidImpacts: number;
  /** Count of continuous scrape events published. Debug/QA only. */
  scrapeEvents: number;
  /** Seconds spent grounded on `Void` — the recovery grace. See checkBounds. */
  voidTime: number;

  // ---- readouts (debug / VFX) ----
  slipAngle: number;
  gripFactor: number;
  latAccelUsed: number;
  lateralSpeed: number;
  forwardSpeed: number;
  /** Net longitudinal acceleration this step, m/s² along `forward`.
   *  Suspension reads this to produce pitch (squat / dive) — see Suspension.ts. */
  longAccel: number;
  /** Net lateral acceleration this step, m/s² along `right`. Drives body roll. */
  lateralAccel: number;
  /** Vertical visual squash (1 = normal). `squash` stun flattens the kart. */
  visualScale: number;
  /** Uniform visual scale (1 = normal). `shock` shrinks the kart. */
  visualShrink: number;
}

// ---------------------------------------------------------------------------
//  Module-level scratch. Nothing in this file allocates after construction.
// ---------------------------------------------------------------------------

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _hitScratch: GroundHit = {
  hit: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
  surface: SurfaceType.Road,
};
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_DOWN = new THREE.Vector3(0, -1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

const TRICK_NAMES = ['spin', 'backflip', 'frontflip', 'sideflip', 'corkscrew'] as const;

// ---------------------------------------------------------------------------

export function createBody(state: KartState, tuning: KartTuning): KartBody {
  const b: KartBody = {
    id: state.id,
    state,
    tuning,

    ctrlSteer: 0,
    ctrlAccel: 0,
    ctrlBrake: 0,
    ctrlDrift: false,
    ctrlDriftPressed: false,
    steerRaw: 0,
    steerCmd: 0,

    position: new THREE.Vector3().copy(state.position),
    velocity: new THREE.Vector3().copy(state.velocity),
    prevPosition: new THREE.Vector3().copy(state.position),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    groundQuat: new THREE.Quaternion().copy(state.quaternion),
    bodyQuat: new THREE.Quaternion().copy(state.quaternion),
    yawRate: 0,
    pitch: 0,
    roll: 0,
    pitchVel: 0,
    rollVel: 0,
    spinYaw: 0,

    wheels: [makeWheel(), makeWheel(), makeWheel(), makeWheel()],
    suspForce: new THREE.Vector3(),
    suspTorquePitch: 0,
    suspTorqueRoll: 0,
    contactNormal: new THREE.Vector3(0, 1, 0),
    loadFactor: 1,
    grounded: false,
    groundedWheels: 0,
    wasGrounded: false,
    airTime: 0,
    groundTime: 0,
    lastGroundPoint: new THREE.Vector3().copy(state.position),
    lastGroundNormal: new THREE.Vector3(0, 1, 0),
    hadGround: false,
    landImpact: 0,

    surface: SurfaceType.Road,
    prevSurface: SurfaceType.Road,
    rumblePhase: state.id * 1.7,
    padCooldown: 0,

    roadLat: 0,
    roadHalfWidth: 11,
    roadNormal: new THREE.Vector3(0, 1, 0),
    roadBinormal: new THREE.Vector3(1, 0, 0),
    vergeAmount: 0,

    driftPhase: DriftPhase.None,
    driftDir: 0,
    driftTime: 0,
    driftCharge: 0,
    driftStage: DriftStage.None,
    driftAngle: 0,
    driftAngleTarget: 0,
    driftLean: 0,
    counterTime: 0,
    hopTime: 0,
    hopHeld: false,
    airDriftGrace: 0,

    trickArmed: false,
    trickActive: false,
    trickTime: 0,
    trickName: 'spin',
    trickCooldown: 0,

    boostTime: 0,
    boostStrength: 0,
    boostImmunity: 0,

    stunKind: 'none',
    stunTime: 0,
    stunTotal: 0,
    invulnTime: 0,
    respawnTime: 0,
    respawnTotal: 0,
    respawnFrom: new THREE.Vector3(),
    respawnTo: new THREE.Vector3(),
    respawnQuat: new THREE.Quaternion(),
    fallTime: 0,

    antiGravity: false,
    gliding: false,
    glideTime: 0,
    bumpCooldown: 0,
    wallCooldown: 0,
    wallContact: false,
    contactClass: 0,
    wallNormal: new THREE.Vector3(0, 1, 0),
    wallGrace: 0,
    wallImpactRef: 0,
    wallImpacts: 0,
    solidImpacts: 0,
    scrapeEvents: 0,
    voidTime: 0,

    slipAngle: 0,
    gripFactor: 1,
    latAccelUsed: 0,
    lateralSpeed: 0,
    forwardSpeed: 0,
    longAccel: 0,
    lateralAccel: 0,
    visualScale: 1,
    visualShrink: 1,
  };

  // Derive the triad from the spawn orientation.
  b.forward.set(0, 0, -1).applyQuaternion(state.quaternion).normalize();
  b.up.set(0, 1, 0).applyQuaternion(state.quaternion).normalize();
  orthonormalise(b);
  b.contactNormal.copy(b.up);
  b.lastGroundNormal.copy(b.up);
  return b;
}

/** Re-derive `right` and re-orthogonalise `forward` against `up`. */
export function orthonormalise(b: KartBody): void {
  if (b.up.lengthSq() < 1e-8) b.up.copy(WORLD_UP);
  b.up.normalize();
  // Project forward onto the plane of `up`.
  b.forward.addScaledVector(b.up, -b.forward.dot(b.up));
  if (b.forward.lengthSq() < 1e-8) {
    // Degenerate (nose exactly along `up`) — pick any stable tangent.
    const seed = Math.abs(b.up.y) < 0.9 ? WORLD_UP : AXIS_X;
    b.forward.copy(seed).cross(b.up);
    if (b.forward.lengthSq() < 1e-8) b.forward.set(1, 0, 0);
  }
  b.forward.normalize();
  b.right.copy(b.forward).cross(b.up).normalize();
}

// ---------------------------------------------------------------------------
//  External impulses
// ---------------------------------------------------------------------------

export function applyBoostTo(
  b: KartBody,
  seconds: number,
  strength: number,
  source: BoostSource,
): void {
  if (seconds <= 0) return;
  // Durations stack (capped), strength takes the max — a mushroom during a
  // mini-turbo extends it rather than making you twice as fast.
  b.boostTime = Math.min(6.0, b.boostTime + seconds);
  b.boostStrength = Math.max(b.boostStrength, strength);
  b.boostImmunity = Math.max(b.boostImmunity, PHYS.boostOffroadImmunity);
  bus.emit('kart:boost', { kartId: b.id, duration: seconds, source });
}

export function applyStunTo(b: KartBody, seconds: number, kind: StunKind): void {
  if (b.invulnTime > 0 || b.state.starTime > 0) return;
  if (b.respawnTime > 0) return;
  b.stunKind = kind;
  b.stunTime = Math.max(b.stunTime, seconds);
  b.stunTotal = b.stunTime;
  cancelDrift(b, false);
  b.boostTime = 0;
  b.boostStrength = 0;

  if (kind === 'spin') {
    // "All speed lost" — the brake does the rest of the work over the spin, but
    // the initial dump has to be instant or a shell feels like a tap.
    b.velocity.multiplyScalar(0.22);
    b.forwardSpeed *= 0.22;
    bus.emit('kart:spinout', { kartId: b.id, position: b.position });
  } else if (kind === 'squash') {
    bus.emit('kart:squash', { kartId: b.id });
  } else if (kind === 'flip') {
    b.velocity.multiplyScalar(0.35);
    b.forwardSpeed *= 0.35;
    b.velocity.addScaledVector(b.up, 9.5);
    bus.emit('kart:spinout', { kartId: b.id, position: b.position });
  } else if (kind === 'shock') {
    b.velocity.multiplyScalar(0.55);
    b.forwardSpeed *= 0.55;
  }
}

/** `impulse` is in newton-seconds. */
export function applyImpulseTo(b: KartBody, impulse: THREE.Vector3): void {
  b.velocity.addScaledVector(impulse, 1 / b.tuning.mass);
}

export function beginRespawn(b: KartBody, track: ITrackService): void {
  if (b.respawnTime > 0) return;
  const sample = track.project(b.position);
  const rs = track.getRespawn(sample.t);
  b.respawnFrom.copy(b.position);
  b.respawnTo.copy(rs.position);
  b.respawnQuat.copy(rs.quaternion);
  b.respawnTotal = 0.95;
  b.respawnTime = b.respawnTotal;
  b.fallTime = 0;
  b.stunKind = 'none';
  b.stunTime = 0;
  b.boostTime = 0;
  b.boostStrength = 0;
  cancelDrift(b, false);
  bus.emit('kart:respawn', { kartId: b.id });
}

export function cancelDrift(b: KartBody, grantBoost: boolean): void {
  if (b.driftPhase === DriftPhase.Drifting && grantBoost && b.driftStage >= DriftStage.Blue) {
    const tier = b.driftStage - DriftStage.Blue; // 0,1,2
    const secs = b.tuning.driftBoosts[tier];
    bus.emit('kart:driftRelease', { kartId: b.id, tier: tier + 1, boostTime: secs });
    applyBoostTo(b, secs, 0.85 + tier * 0.12, 'drift');
  } else if (b.driftPhase === DriftPhase.Drifting) {
    bus.emit('kart:driftRelease', { kartId: b.id, tier: 0, boostTime: 0 });
  }
  b.driftPhase = DriftPhase.None;
  b.driftDir = 0;
  b.driftTime = 0;
  b.driftCharge = 0;
  b.driftStage = DriftStage.None;
  b.driftAngleTarget = 0;
  b.counterTime = 0;
  b.hopTime = 0;
  b.hopHeld = false;
}

// ---------------------------------------------------------------------------
//  Tyre model
// ---------------------------------------------------------------------------

/**
 * Normalised lateral force vs slip angle. Rises to 1.0 at the peak (~8°) then
 * falls away to `1 - slipFalloff`. The falloff is what makes oversteer
 * controllable rather than binary: once you're past the peak, pushing harder
 * gives you less, so the slide is progressive.
 */
export function tyreCurve(slipAbs: number): number {
  const s = slipAbs / PHYS.peakSlip;
  if (s <= 1) return Math.sin(s * Math.PI * 0.5);
  return 1 - PHYS.slipFalloff * (1 - Math.exp(-(s - 1) * 0.85));
}

// ---------------------------------------------------------------------------
//  The step
// ---------------------------------------------------------------------------

export function stepKart(b: KartBody, dt: number, track: ITrackService): void {
  const t = b.tuning;
  const st = b.state;

  b.prevPosition.copy(b.position);

  // --- timers ------------------------------------------------------------
  if (b.invulnTime > 0) b.invulnTime = Math.max(0, b.invulnTime - dt);
  if (b.boostImmunity > 0) b.boostImmunity = Math.max(0, b.boostImmunity - dt);
  if (b.padCooldown > 0) b.padCooldown = Math.max(0, b.padCooldown - dt);
  if (b.bumpCooldown > 0) b.bumpCooldown = Math.max(0, b.bumpCooldown - dt);
  if (b.trickCooldown > 0) b.trickCooldown = Math.max(0, b.trickCooldown - dt);
  if (st.starTime > 0) st.starTime = Math.max(0, st.starTime - dt);
  if (b.boostTime > 0) {
    b.boostTime = Math.max(0, b.boostTime - dt);
    if (b.boostTime === 0) b.boostStrength = 0;
  }
  if (b.stunTime > 0) {
    b.stunTime = Math.max(0, b.stunTime - dt);
    if (b.stunTime === 0) b.stunKind = 'none';
  }

  // --- respawn owns the kart completely ----------------------------------
  if (b.respawnTime > 0) {
    stepRespawn(b, dt);
    return;
  }

  // --- surface -----------------------------------------------------------
  resolveRoadFrame(b, track);
  resolveSurface(b, track);
  let props = SURFACES[b.surface] ?? SURFACES[SurfaceType.Road];
  if (b.grounded && b.surface === SurfaceType.Void) {
    // A kart with wheels still on ground the track calls `Void` is off the
    // racing line, not in a hole. `SURFACES[Void]` is all zeros — including
    // `speedMul: 0`, which collapses the soft cap and deletes the kart's speed
    // outright. On the shipping track that band is only 0.4 m wide, just past
    // the shoulder edge, so the old behaviour was a hard stop for what the
    // player reads as a wide line. Charge heavy off-road instead; `checkBounds`
    // owns the actual recovery, and it now waits `COLL.voidGrace` first.
    props = SURFACES[SurfaceType.OffRoad];
  }
  const immune = b.boostImmunity > 0 || st.starTime > 0;
  const speedMul = immune ? Math.max(1, props.speedMul) : props.speedMul;
  const surfDrag = immune ? Math.min(0.012, props.drag) : props.drag;
  const surfGrip = immune ? Math.max(1, props.grip) : props.grip;

  // --- boost envelope ----------------------------------------------------
  const boostEnv = b.boostTime > 0 ? smoothstep(b.boostTime / PHYS.boostFade) : 0;
  const boosting = boostEnv > 0.002;

  // --- stun gating -------------------------------------------------------
  //  `spin` / `flip` take the kart away from the player entirely.
  //  `squash` / `shock` leave you driving — just humiliatingly slowly, which is
  //  far more MK8 than freezing the controls.
  const stunned = b.stunTime > 0;
  const hardStun = stunned && (b.stunKind === 'spin' || b.stunKind === 'flip');
  let steerIn = b.ctrlSteer;
  let accelIn = b.ctrlAccel;
  let brakeIn = b.ctrlBrake;
  let stunSpeedMul = 1;
  if (hardStun) {
    steerIn = 0;
    accelIn = 0;
    brakeIn = 1;
  } else if (stunned) {
    steerIn *= 0.8;
    stunSpeedMul = b.stunKind === 'squash' ? 0.3 : 0.45;
  }

  // Visual deformation: squash flattens, shock shrinks. Both recover with a
  // small overshoot once the timer ends (the pop-back is half the joke).
  const squashK = stunned && b.stunKind === 'squash' ? clamp01(b.stunTime / 0.18) : 0;
  const shrinkK = stunned && b.stunKind === 'shock' ? clamp01(b.stunTime / 0.18) : 0;
  b.visualScale = damp(b.visualScale, lerp(1, 0.3, squashK), 0.055, dt);
  b.visualShrink = damp(b.visualShrink, lerp(1, 0.58, shrinkK), 0.07, dt);

  // --- apply world forces (suspension + gravity) -------------------------
  _v1.copy(b.suspForce).multiplyScalar(1 / t.mass);

  let gravMag = WORLD.gravity;
  if (b.gliding) gravMag *= PHYS.glideGravity;
  else if (b.driftPhase === DriftPhase.Hop && !b.grounded) gravMag *= PHYS.hopGravity;

  if (b.antiGravity) {
    // Gravity follows the road normal, and a magnetic term glues us to it.
    _v2.copy(b.contactNormal).multiplyScalar(-WORLD.antiGravityStrength);
    if (!b.grounded && b.hadGround) _v2.addScaledVector(b.lastGroundNormal, -PHYS.agStick);
    _v1.add(_v2);
  } else {
    _v1.addScaledVector(WORLD_DOWN, gravMag);
  }

  // Aerodynamic downforce — stops fast karts skating off crests.
  if (b.grounded) {
    const sr = clamp01(Math.abs(b.forwardSpeed) / Math.max(1, t.maxSpeed));
    _v1.addScaledVector(b.contactNormal, -PHYS.downforce * WORLD.gravity * sr * sr);

    // Banked road: the tyres CARRY the lateral component of gravity. Without
    // this a parked kart slithers sideways down a 25° bank, which is both wrong
    // and horrible; with it, a wall-ride holds and only ice lets go (the term is
    // scaled by surface grip, so `grip 0.22` ice keeps 78 % of the slide).
    if (!b.antiGravity) {
      const gLat = WORLD_DOWN.dot(b.right) * gravMag;
      _v1.addScaledVector(b.right, -gLat * clamp01(surfGrip * b.loadFactor));
    }
  }

  b.velocity.addScaledVector(_v1, dt);

  // --- steering inertia ---------------------------------------------------
  // A real steering rack has mass. Feeding the stick straight into the yaw
  // target is most of what reads as "the kart over-reacts": a 1-frame step to
  // full lock is a step input no vehicle can produce. Rate-limit it (asymmetric
  // — unwinding is faster than winding on, so you can always catch a slide),
  // then smooth off the corner the limiter leaves behind. Both stages use `dt`,
  // so the result is identical at any substep count.
  const steerTarget = clamp(steerIn, -1, 1);
  const unwinding =
    Math.abs(steerTarget) < Math.abs(b.steerRaw) || steerTarget * b.steerRaw < 0;
  b.steerRaw = moveTowards(
    b.steerRaw,
    steerTarget,
    (unwinding ? PHYS.steerReturnRate : PHYS.steerRate) * dt,
  );
  b.steerCmd = damp(b.steerCmd, b.steerRaw, PHYS.steerSmoothHalf, dt);
  const steer = b.steerCmd;

  // --- yaw ---------------------------------------------------------------
  const speedH = Math.hypot(b.velocity.dot(b.forward), b.velocity.dot(b.right));
  const absSpeed = Math.abs(b.forwardSpeed);
  const speedRatio = clamp01(absSpeed / Math.max(1, t.maxSpeed));

  // MK8's signature: tight at walking pace, deliberately lazy at racing speed.
  // See PHYS.steerFloor / steerRef for why the falloff is square.
  const sf = absSpeed / PHYS.steerRef;
  const authority = t.turnRate * (PHYS.steerFloor + (1 - PHYS.steerFloor) / (1 + sf * sf));
  const speedGate = clamp01(speedH / PHYS.steerGateSpeed);
  const reversing = b.forwardSpeed < -0.4;

  let targetYaw: number;
  if (b.driftPhase === DriftPhase.Drifting) {
    // Steering modulates how tight the drift line is; it can never flip sides.
    // The bonus multiplies the SAME speed-faded authority as gripping, so it can
    // never stack into a yaw rate the tyres can't deliver — that was how a
    // high-speed drift used to launder its own momentum into slip.
    const inward = clamp(steer * b.driftDir, -1, 1);
    const tighten = lerp(0.52, 1.0 + t.driftTurnBonus, (inward + 1) * 0.5);
    targetYaw = -b.driftDir * authority * tighten * speedGate;
  } else if (!b.grounded) {
    targetYaw = -steer * t.turnRate * PHYS.airYawFactor;
  } else {
    targetYaw = -steer * authority * speedGate * (reversing ? -0.8 : 1);
  }

  // --- leaning on a barrier ----------------------------------------------
  // The wall resists rotation into itself. Applied to the TARGET, not to
  // `yawRate`, so the yaw filter can't fight it back: editing `yawRate` here
  // would just be undone by the damp toward `targetYaw` on the next tick.
  // (`wallContact` / `wallNormal` are one tick stale — walls resolve after this
  // function — which is 8 ms and invisible.)
  // The grace window (not just this tick's overlap) so that a kart bounced off a
  // steep hit keeps straightening while it is airborne of the wall — that
  // follow-through is most of why sliding down a guardrail feels helpful.
  if ((b.wallContact || b.wallGrace > 0) && b.grounded && !hardStun) {
    // d(forward·n)/dω = (up × forward)·n. Its sign is the direction of yaw that
    // turns the nose back OUT of the wall.
    const swing = _v3.crossVectors(b.up, b.forward).dot(b.wallNormal);
    const into = b.forward.dot(b.wallNormal);
    if (into < PHYS.wallNoseLimit && Math.abs(swing) > 1e-4) {
      const outward = swing >= 0 ? 1 : -1;
      // Cancel any yaw that would dig the nose in further...
      if (targetYaw * outward < 0) targetYaw = 0;
      // ...and add a restoring rate proportional to how nose-in we are, so a kart
      // that arrived at 30° walks itself back to parallel and slides.
      targetYaw += outward * PHYS.wallAlignRate * clamp01(-into);
    }
  }

  if (hardStun) {
    // Two full rotations over the stun. Deterministic, reads as a clean spin-out.
    targetYaw = (Math.PI * 4) / Math.max(0.2, b.stunTotal);
  }

  b.yawRate = damp(b.yawRate, targetYaw, PHYS.yawHalfLife, dt);

  // Rotate the chassis about its own up axis.
  _q1.setFromAxisAngle(b.up, b.yawRate * dt);
  b.forward.applyQuaternion(_q1);
  orthonormalise(b);

  // --- decompose velocity into the chassis triad -------------------------
  let vFwd = b.velocity.dot(b.forward);
  let vRight = b.velocity.dot(b.right);
  let vUp = b.velocity.dot(b.up);

  // --- lateral: tyre model ----------------------------------------------
  const planar = Math.hypot(vFwd, vRight);
  const beta = Math.atan2(vRight, Math.max(Math.abs(vFwd), 0.001));
  b.slipAngle = beta;

  if (b.grounded && planar > 0.05) {
    const drifting = b.driftPhase === DriftPhase.Drifting;
    const betaTarget = drifting ? -b.driftDir * b.driftAngle : 0;
    const betaErr = beta - betaTarget;

    const tyre = tyreCurve(Math.abs(betaErr));
    const baseRate = drifting ? t.driftGrip : t.grip;
    const gripRate =
      baseRate * surfGrip * tyre * b.loadFactor * (boosting ? 1.08 : 1) * (b.antiGravity ? 1.12 : 1);
    b.gripFactor = tyre * surfGrip * b.loadFactor;

    // Magnitude-preserving redirect, blended out at extreme slip so that a
    // sideways shunt can't be laundered into forward speed.
    const redirect =
      1 -
      smoothstep(
        (Math.abs(beta) - PHYS.redirectFadeLo) / (PHYS.redirectFadeHi - PHYS.redirectFadeLo),
      );

    let dBeta = -betaErr * (1 - Math.exp(-gripRate * dt));

    // Cornering-force budget: |Δv_lat| ≤ a_max·dt. This is where high-speed
    // understeer comes from, and why boosting into a corner pushes wide.
    const latBudget =
      PHYS.latAccel * surfGrip * tyre * b.loadFactor * (drifting ? 1.1 : 1) * (boosting ? 1.06 : 1);
    const maxDBeta = (latBudget * dt) / Math.max(2.0, planar);
    if (dBeta > maxDBeta) dBeta = maxDBeta;
    else if (dBeta < -maxDBeta) dBeta = -maxDBeta;
    b.latAccelUsed = (Math.abs(dBeta) * planar) / dt;

    if (redirect > 0.001) {
      const nb = beta + dBeta * redirect;
      const scrub = 1 - clamp01((drifting ? PHYS.driftScrub : PHYS.gripScrub) * Math.abs(dBeta));
      const mag = planar * scrub;
      const fSign = vFwd < 0 ? -1 : 1;
      vFwd = mag * Math.cos(nb) * fSign;
      vRight = mag * Math.sin(nb);
    }
    if (redirect < 0.999) {
      // Plain lateral damping for the remainder.
      const kill = 1 - Math.exp(-gripRate * dt * (1 - redirect));
      vRight -= vRight * kill;
    }
  } else if (!b.grounded) {
    // Airborne: only a whisper of aero side-force.
    b.gripFactor = 0;
    vRight -= vRight * (1 - Math.exp(-0.35 * dt));
  } else {
    vRight -= vRight * (1 - Math.exp(-t.grip * surfGrip * dt));
  }

  // --- longitudinal ------------------------------------------------------
  const softCap =
    (t.maxSpeed * speedMul + boostEnv * b.boostStrength * PHYS.boostSpeedBonus) * stunSpeedMul;

  let aLong = 0;
  if (!hardStun) {
    if (accelIn > 0.001) {
      const r = clamp01(Math.max(0, vFwd) / Math.max(1, softCap));
      aLong += accelIn * t.acceleration * Math.max(0, 1 - Math.pow(r, 1.6));
    }
    if (brakeIn > 0.001) {
      if (vFwd > 0.35) {
        aLong -= brakeIn * t.brakeForce;
      } else if (accelIn < 0.15) {
        // Reverse out of a wall.
        const rr = clamp01(-vFwd / t.maxReverseSpeed);
        aLong -= brakeIn * t.acceleration * 0.55 * Math.max(0, 1 - rr * rr);
      }
    }
  }

  // Boost thrust — instant attack, smooth tail.
  if (boosting) aLong += PHYS.boostAccel * b.boostStrength * boostEnv;

  // Drag. Almost switched off under throttle so the drive curve alone sets
  // terminal speed; dominant when coasting or off-road.
  const throttleRelief = 1 - PHYS.throttleDragRelief * accelIn * (boosting ? 1 : 1);
  let dragRate: number;
  if (b.grounded) {
    dragRate = (PHYS.coastDrag + surfDrag * PHYS.surfaceDragScale) * throttleRelief;
    if (b.driftPhase === DriftPhase.Drifting) dragRate += 0.05;
  } else {
    dragRate = WORLD.airDrag * 0.22;
    if (b.gliding) dragRate = PHYS.glideBleed;
  }
  aLong -= vFwd * dragRate;

  // The verge (P0b-5). Riding the kerb / apron is FRICTION — a steady, entirely
  // predictable cost with no impulse, no yaw and no event, applied outside the
  // throttle relief above so that it bites under power. Fades out on surfaces
  // that already charge their own drag so grass isn't billed twice.
  if (b.grounded && b.vergeAmount > 0) {
    const fade = clamp01((PHYS.vergeSurfaceCap - surfDrag) / PHYS.vergeSurfaceSpan);
    aLong -= vFwd * PHYS.vergeDrag * b.vergeAmount * fade;
  }

  // Gravity along the slope. NOTE: the honest slope force is ALREADY applied —
  // `_v1` carries gravity plus the suspension normal force, whose sum on an
  // incline is exactly the down-slope component. This is a small extra bias on
  // top of it so hills read as more dramatic than they geometrically are.
  if (b.grounded && !b.antiGravity) {
    aLong += WORLD_DOWN.dot(b.forward) * WORLD.gravity * PHYS.slopeBias;
  }

  vFwd += aLong * dt;

  // Soft cap: exceed it freely, bleed back exponentially. Never clamp.
  if (vFwd > softCap) vFwd -= (vFwd - softCap) * (1 - Math.exp(-PHYS.overspeedDecay * dt));
  const revCap = -t.maxReverseSpeed;
  if (vFwd < revCap) vFwd -= (vFwd - revCap) * (1 - Math.exp(-6 * dt));

  // --- glider ------------------------------------------------------------
  if (b.gliding) {
    b.glideTime += dt;
    // brake = nose up (float), accel = nose down (dive for speed).
    const pitchCmd = clamp(brakeIn - accelIn, -1, 1);
    vUp += pitchCmd * PHYS.glidePitch * dt;
    vUp = Math.max(vUp, -9);
    // Trade altitude for speed when diving.
    if (pitchCmd < 0) vFwd += -pitchCmd * 6.0 * dt;
    b.pitch = damp(b.pitch, pitchCmd * 0.32, 0.18, dt);
  } else {
    b.glideTime = 0;
  }

  // --- weight-transfer inputs for the suspension -------------------------
  // These two numbers are the *entire* reason the chassis pitches and rolls:
  // Suspension.ts turns them into a torque about the contact patch. Longitudinal
  // is the net drive/brake accel; lateral is the centripetal accel a = ω × v,
  // whose component along `right` is -yawRate·vFwd.
  b.longAccel = clamp(aLong, -80, 80);
  b.lateralAccel = clamp(-b.yawRate * vFwd, -90, 90);

  // --- recompose ---------------------------------------------------------
  b.forwardSpeed = vFwd;
  b.lateralSpeed = vRight;
  b.velocity.copy(b.forward).multiplyScalar(vFwd);
  b.velocity.addScaledVector(b.right, vRight);
  b.velocity.addScaledVector(b.up, vUp);

  // --- integrate ---------------------------------------------------------
  b.position.addScaledVector(b.velocity, dt);

  // --- anti-tunnel hard floor -------------------------------------------
  groundClamp(b, track);

  // --- orientation -------------------------------------------------------
  buildQuaternions(b, dt);

  // --- boost pads --------------------------------------------------------
  if (b.grounded && b.surface === SurfaceType.Boost && b.padCooldown <= 0) {
    b.padCooldown = PHYS.padCooldown;
    applyBoostTo(b, 0.9, 1.0, 'pad');
  }

  guardNaN(b);
}

/**
 * Re-derive the chassis-frame speeds after an external solver (walls, kart↔kart,
 * item impulses) has edited `velocity` directly. Cheap, and it keeps the HUD /
 * audio / VFX readouts honest in the same step the hit happened.
 */
export function syncVelocityReadouts(b: KartBody): void {
  b.forwardSpeed = b.velocity.dot(b.forward);
  b.lateralSpeed = b.velocity.dot(b.right);
}

// ---------------------------------------------------------------------------

/**
 * Where the CoM sits in the road's own frame. One projection per step, cached on
 * the body, consumed by three places that would otherwise each project again:
 * the verge drag below, `Suspension`'s verge rumble, and `KartCollision`'s
 * contact classifier. `ITrackService.project` is allocation-free (both the real
 * `Track` and the bench return pooled samples), so this adds no garbage.
 */
function resolveRoadFrame(b: KartBody, track: ITrackService): void {
  const s = track.project(b.position);
  b.roadHalfWidth = s.halfWidth;
  b.roadNormal.copy(s.normal);
  b.roadBinormal.copy(s.binormal);
  _v1.copy(b.position).sub(s.position);
  b.roadLat = _v1.dot(s.binormal);
  const over = Math.abs(b.roadLat) - s.halfWidth;
  b.vergeAmount = b.grounded && over > 0 ? clamp01(over / PHYS.vergeRef) : 0;
}

function resolveSurface(b: KartBody, track: ITrackService): void {
  let s: SurfaceType;
  if (b.grounded) {
    // Majority vote across the grounded wheels — no flicker on surface seams.
    let best = SurfaceType.Road;
    let bestLoad = -1;
    for (let i = 0; i < 4; i++) {
      const w = b.wheels[i];
      if (w.grounded && w.force > bestLoad) {
        bestLoad = w.force;
        best = w.surface;
      }
    }
    s = best;
  } else {
    // Airborne: a point query mostly answers "which volume am I in". Void in
    // mid-air is expected and must not be mistaken for a surface change.
    const probe = track.surfaceAt(b.position);
    s = probe === SurfaceType.Void ? b.prevSurface : probe;
  }

  b.antiGravity = s === SurfaceType.AntiGravity;

  // Gliding: entering a glider volume while airborne, or launching from one.
  if (s === SurfaceType.Glider) {
    if (!b.grounded) b.gliding = true;
  }
  if (b.grounded && b.gliding && b.groundTime > 0.05) b.gliding = false;

  if (s !== b.prevSurface) {
    bus.emit('kart:surfaceChange', { kartId: b.id, from: b.prevSurface, to: s });
    b.prevSurface = s;
  }
  b.surface = s;
}

/**
 * The one guarantee that must never fail: at 40 m/s a fixed step moves 0.33 m,
 * and this probe reaches 3 m above the chassis, so the kart cannot end a step
 * beneath the road no matter how it got there.
 */
function groundClamp(b: KartBody, track: ITrackService): void {
  _v1.copy(b.position).addScaledVector(b.up, PHYS.clampLift);
  const hit = track.raycastGround(_v1, b.up, PHYS.clampLift + 8);
  if (!hit.hit) return;
  copyHit(hit);
  // Height of the CoM above the surface, measured along `up`.
  _v2.copy(b.position).sub(_hitScratch.point);
  const h = _v2.dot(_hitScratch.normal);
  if (h < PHYS.minRideHeight) {
    b.position.addScaledVector(_hitScratch.normal, PHYS.minRideHeight - h);
    const vn = b.velocity.dot(_hitScratch.normal);
    if (vn < 0) b.velocity.addScaledVector(_hitScratch.normal, -vn);
  }
}

function copyHit(h: GroundHit): void {
  _hitScratch.hit = h.hit;
  _hitScratch.point.copy(h.point);
  _hitScratch.normal.copy(h.normal);
  _hitScratch.distance = h.distance;
  _hitScratch.surface = h.surface;
}

// ---------------------------------------------------------------------------

function buildQuaternions(b: KartBody, dt: number): void {
  // Ground-aligned basis. Kart faces -Z, so local +Z is "backward".
  _v1.copy(b.forward).multiplyScalar(-1);
  _m1.makeBasis(b.right, b.up, _v1);
  b.groundQuat.setFromRotationMatrix(_m1);

  // Visual lean: the physical suspension attitude plus a drift roll INTO the
  // corner (real karts lean out, MK8 karts lean in — we do both, and the
  // drift term wins because it reads better).
  const targetLean =
    b.driftPhase === DriftPhase.Drifting ? b.driftDir * (0.16 + b.driftAngle * 0.42) : 0;
  b.driftLean = damp(b.driftLean, targetLean, 0.1, dt);

  const rollTotal = b.roll + b.driftLean;
  const pitchTotal = b.pitch;

  b.bodyQuat.copy(b.groundQuat);
  if (Math.abs(pitchTotal) > 1e-5) {
    _q1.setFromAxisAngle(AXIS_X, pitchTotal);
    b.bodyQuat.multiply(_q1);
  }
  if (Math.abs(rollTotal) > 1e-5) {
    // Roll is about the chassis forward axis = local -Z.
    _q2.setFromAxisAngle(AXIS_Z, -rollTotal);
    b.bodyQuat.multiply(_q2);
  }
  // Trick tumble + squash spin are pure visual yaw/pitch on top.
  if (b.trickActive) {
    _q3.setFromAxisAngle(AXIS_X, b.trickTime * Math.PI * 2);
    b.bodyQuat.multiply(_q3);
  }
  if (Math.abs(b.spinYaw) > 1e-5) {
    _q3.setFromAxisAngle(AXIS_Y, b.spinYaw);
    b.bodyQuat.multiply(_q3);
  }
}

// ---------------------------------------------------------------------------

function stepRespawn(b: KartBody, dt: number): void {
  b.respawnTime = Math.max(0, b.respawnTime - dt);
  const k = 1 - b.respawnTime / b.respawnTotal; // 0 -> 1

  // Lift out, arc across, settle in.
  const arc = Math.sin(k * Math.PI) * 3.2;
  b.position.lerpVectors(b.respawnFrom, b.respawnTo, smoothstep(k));
  b.position.y += arc;

  b.velocity.set(0, 0, 0);
  b.yawRate = 0;
  b.steerRaw = 0;
  b.steerCmd = 0;
  b.wallGrace = 0;
  b.wallContact = false;
  b.contactClass = 0;
  b.vergeAmount = 0;
  b.pitch = damp(b.pitch, 0, 0.1, dt);
  b.roll = damp(b.roll, 0, 0.1, dt);
  b.pitchVel = 0;
  b.rollVel = 0;
  b.groundQuat.slerp(b.respawnQuat, 1 - Math.exp(-9 * dt));
  b.bodyQuat.copy(b.groundQuat);
  b.forward.set(0, 0, -1).applyQuaternion(b.groundQuat);
  b.up.set(0, 1, 0).applyQuaternion(b.groundQuat);
  orthonormalise(b);

  for (let i = 0; i < 4; i++) {
    b.wheels[i].compression = 0.12;
    b.wheels[i].grounded = false;
  }

  if (b.respawnTime <= 0) {
    b.position.copy(b.respawnTo);
    // Drop back in at 40 % pace, facing the right way.
    b.velocity.copy(b.forward).multiplyScalar(b.tuning.maxSpeed * 0.4);
    b.forwardSpeed = b.tuning.maxSpeed * 0.4;
    b.invulnTime = 1.6;
    b.hadGround = false;
    b.airTime = 0;
  }
}

// ---------------------------------------------------------------------------

function guardNaN(b: KartBody): void {
  if (
    Number.isFinite(b.position.x) &&
    Number.isFinite(b.position.y) &&
    Number.isFinite(b.position.z) &&
    Number.isFinite(b.velocity.x) &&
    Number.isFinite(b.velocity.y) &&
    Number.isFinite(b.velocity.z) &&
    Number.isFinite(b.yawRate)
  ) {
    return;
  }
  console.warn(`[Physics] non-finite state on kart ${b.id} — resetting`);
  b.position.copy(b.lastGroundPoint);
  b.position.y += 1.0;
  b.velocity.set(0, 0, 0);
  b.yawRate = 0;
  b.steerRaw = 0;
  b.steerCmd = 0;
  b.wallGrace = 0;
  b.wallContact = false;
  b.contactClass = 0;
  b.vergeAmount = 0;
  b.voidTime = 0;
  b.pitch = 0;
  b.roll = 0;
  b.pitchVel = 0;
  b.rollVel = 0;
  b.forwardSpeed = 0;
  b.lateralSpeed = 0;
  b.up.copy(WORLD_UP);
  b.forward.set(0, 0, -1);
  orthonormalise(b);
}

// ---------------------------------------------------------------------------

export function writeState(b: KartBody, dt: number): void {
  const st = b.state;
  const t = b.tuning;

  st.position.copy(b.position);
  st.quaternion.copy(b.bodyQuat);
  st.groundQuaternion.copy(b.groundQuat);
  st.velocity.copy(b.velocity);
  st.speed = b.forwardSpeed;
  st.speedRatio = clamp(b.forwardSpeed / Math.max(1, t.maxSpeed), -1, 2);
  st.angularVelocity = b.yawRate;

  const drifting = b.driftPhase === DriftPhase.Drifting;
  st.steerAngle = drifting
    ? clamp(b.driftDir * 0.34 + b.steerCmd * 0.26, -0.62, 0.62)
    : b.steerCmd * 0.5;

  for (let i = 0; i < 4; i++) {
    st.suspension[i] = b.wheels[i].compression;
    st.wheelSpin[i] = b.wheels[i].spin;
    st.wheelGrounded[i] = b.wheels[i].grounded;
  }

  st.grounded = b.grounded;
  st.airTime = b.airTime;
  st.surface = b.surface;

  st.drifting = drifting;
  st.driftStage = b.driftStage;
  st.driftDirection = drifting ? b.driftDir : 0;
  st.driftCharge = driftChargeNormalised(b);

  st.boostTime = b.boostTime;
  st.boostStrength = b.boostStrength;

  st.hopping = b.driftPhase === DriftPhase.Hop || (drifting && b.hopTime > 0);
  st.stunned = b.stunTime > 0;
  st.stunTime = b.stunTime;
  st.invulnerable = b.invulnTime > 0 || b.respawnTime > 0;

  st.gliding = b.gliding;
  st.antiGravity = b.antiGravity;

  // Engine note: speed plus a slip/spin component so it screams under a drift.
  const load = clamp01(Math.abs(st.speedRatio));
  const slipRev = clamp01(Math.abs(b.lateralSpeed) * 0.06);
  const boostRev = b.boostTime > 0 ? 0.18 : 0;
  const target = clamp01(0.1 + load * 0.82 + slipRev * 0.2 + boostRev);
  st.rpm = damp(st.rpm, target, 0.05, dt);
}

/** 0..1 progress toward the NEXT drift tier. */
export function driftChargeNormalised(b: KartBody): number {
  if (b.driftPhase !== DriftPhase.Drifting) return 0;
  const tiers = b.tuning.driftTiers;
  const c = b.driftCharge;
  if (c < tiers[0]) return clamp01(c / tiers[0]);
  if (c < tiers[1]) return clamp01((c - tiers[0]) / (tiers[1] - tiers[0]));
  if (c < tiers[2]) return clamp01((c - tiers[1]) / (tiers[2] - tiers[1]));
  return 1;
}

export { TRICK_NAMES, WORLD_UP, WORLD_DOWN, AXIS_X, AXIS_Y, AXIS_Z };
