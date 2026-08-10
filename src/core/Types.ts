/**
 * ============================================================================
 *  APEX KART — SHARED CONTRACTS
 * ============================================================================
 *  This file is the single source of truth for cross-module interfaces.
 *  Every subsystem (physics, track, vfx, items, ai, ui, audio, camera)
 *  communicates ONLY through the types declared here.
 *
 *  RULE: Subsystems must not import from each other's internals.
 *        They import from '@/core/Types' and receive dependencies via
 *        their constructor or their update() context.
 * ============================================================================
 */

import type * as THREE from 'three';

// ---------------------------------------------------------------------------
// Time / update context
// ---------------------------------------------------------------------------

/** Passed to every `update()` in the game. All times in seconds. */
export interface FrameContext {
  /** Variable frame delta, already clamped to a sane maximum. */
  readonly dt: number;
  /** Fixed physics timestep (constant, see Config.FIXED_DT). */
  readonly fixedDt: number;
  /** Seconds since the engine started. */
  readonly elapsed: number;
  /** Monotonic frame counter. */
  readonly frame: number;
  /** Interpolation alpha [0,1] between the last two physics states. */
  readonly alpha: number;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InputState {
  /** -1 (full left) .. +1 (full right), analog-aware, already smoothed. */
  steer: number;
  /** 0..1 */
  accel: number;
  /** 0..1 */
  brake: number;
  /** Drift / hop button held. */
  drift: boolean;
  /** Rising edge of the drift button this frame. */
  driftPressed: boolean;
  /** Use item button held. */
  item: boolean;
  /** Rising edge of item this frame. */
  itemPressed: boolean;
  /** Look-behind. */
  lookBack: boolean;
  /** Menu confirm / start, rising edge. */
  startPressed: boolean;
  /** True when the most recent input came from a gamepad. */
  usingGamepad: boolean;
}

// ---------------------------------------------------------------------------
// Surfaces — what the kart is driving on
// ---------------------------------------------------------------------------

export enum SurfaceType {
  Road = 0,
  OffRoad = 1,
  Dirt = 2,
  Grass = 3,
  Sand = 4,
  Water = 5,
  Ice = 6,
  Metal = 7,
  Wood = 8,
  Boost = 9,
  AntiGravity = 10,
  Glider = 11,
  Void = 12,
}

export interface SurfaceProperties {
  /** Multiplier on max speed. 1 = full road speed. */
  speedMul: number;
  /** Lateral grip coefficient. */
  grip: number;
  /** Rolling resistance / drag. */
  drag: number;
  /** Screen-shake + suspension rumble amplitude. */
  roughness: number;
  /** Particle/decal family emitted by the wheels. */
  particle: 'none' | 'dust' | 'grass' | 'sand' | 'spray' | 'sparks' | 'snow';
  /** Tyre-roll audio bank id. */
  sfx: string;
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

/** Result of sampling the track at a given arc-length / progress value. */
export interface TrackSample {
  /** World position on the racing centreline. */
  position: THREE.Vector3;
  /** Unit tangent (direction of travel). */
  tangent: THREE.Vector3;
  /** Unit normal (track "up", banked + anti-gravity aware). */
  normal: THREE.Vector3;
  /** tangent × normal — points to the driver's right. */
  binormal: THREE.Vector3;
  /** Half-width of the drivable road at this point, metres. */
  halfWidth: number;
  /** Normalised distance along the lap, [0,1). */
  t: number;
  /** Distance along the lap in metres. */
  distance: number;
  /** Signed curvature, 1/m. Positive = turning right. */
  curvature: number;
  /** Bank angle in radians. */
  bank: number;
}

/** A raycast query answered by the track/collision system. */
export interface GroundHit {
  hit: boolean;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Distance from ray origin. */
  distance: number;
  surface: SurfaceType;
}

export interface WallHit {
  hit: boolean;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Penetration depth in metres. */
  depth: number;
}

/**
 * The collision + navigation service the track module exposes.
 * Physics and AI depend on THIS, never on the track's meshes.
 */
export interface ITrackService {
  /** Total lap length in metres. */
  readonly lapLength: number;
  readonly lapCount: number;
  /** Sample the centreline by normalised progress [0,1). */
  sampleAt(t: number): TrackSample;
  /** Sample by arc length in metres (wraps). */
  sampleAtDistance(d: number): TrackSample;
  /** Nearest point on the centreline to a world position. */
  project(position: THREE.Vector3): TrackSample;
  /** Downward (along -up) ground probe. */
  raycastGround(origin: THREE.Vector3, up: THREE.Vector3, maxDist: number): GroundHit;
  /** Swept sphere against walls / guardrails. */
  collideWalls(position: THREE.Vector3, radius: number): WallHit;
  /** Surface classification at a world point. */
  surfaceAt(position: THREE.Vector3): SurfaceType;
  /** The ideal racing line, for AI. Returns a point ahead by `lookahead` metres. */
  racingLineAt(t: number, lookahead: number): THREE.Vector3;
  /** Grid start positions, index 0 = pole. */
  getStartPosition(index: number): { position: THREE.Vector3; quaternion: THREE.Quaternion };
  /** Respawn point after falling out of bounds. */
  getRespawn(t: number): { position: THREE.Vector3; quaternion: THREE.Quaternion };
  /** Is this world position outside the playable volume? */
  isOutOfBounds(position: THREE.Vector3): boolean;
}

// ---------------------------------------------------------------------------
// Karts
// ---------------------------------------------------------------------------

export enum DriftStage {
  None = 0,
  Charging = 1,
  Blue = 2,
  Orange = 3,
  Purple = 4,
}

/** Per-frame readout of a kart. Consumed by VFX, audio, camera, UI, AI. */
export interface KartState {
  readonly id: number;
  readonly isPlayer: boolean;

  position: THREE.Vector3;
  /** Full orientation including body roll/pitch. */
  quaternion: THREE.Quaternion;
  /** Orientation of the chassis ignoring visual lean — for physics queries. */
  groundQuaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  /** Signed forward speed, m/s. */
  speed: number;
  /** speed / currentMaxSpeed, [0,1+]. */
  speedRatio: number;
  /** Radians/second about the up axis. */
  angularVelocity: number;

  /** Visual steer angle of the front wheels, radians. */
  steerAngle: number;
  /** Per-wheel suspension compression [0,1] — FL, FR, RL, RR. */
  suspension: [number, number, number, number];
  /** Per-wheel spin, radians. */
  wheelSpin: [number, number, number, number];
  /** Per-wheel contact flag. */
  wheelGrounded: [boolean, boolean, boolean, boolean];

  grounded: boolean;
  airTime: number;
  surface: SurfaceType;

  drifting: boolean;
  driftStage: DriftStage;
  /** -1 left, +1 right, 0 none. */
  driftDirection: number;
  /** 0..1 progress to the next drift tier. */
  driftCharge: number;

  /** Seconds of boost remaining, 0 = not boosting. */
  boostTime: number;
  boostStrength: number;

  hopping: boolean;
  /** Currently spinning out / squashed / etc. */
  stunned: boolean;
  stunTime: number;
  invulnerable: boolean;
  /** Star power. */
  starTime: number;

  /** Gliding / anti-gravity modes. */
  gliding: boolean;
  antiGravity: boolean;

  // Race progress
  lap: number;
  /** Monotonic progress = lap + t. Used for ranking. */
  progress: number;
  /** 1-based finishing/current position. */
  racePosition: number;
  finished: boolean;
  finishTime: number;
  lapTimes: number[];

  /** Engine RPM 0..1, drives audio pitch. */
  rpm: number;
  /** Which item is held, or null. */
  heldItem: ItemType | null;
  itemCount: number;
}

/** Everything the physics module needs to know about a chassis. */
export interface KartTuning {
  mass: number;
  /** m/s */
  maxSpeed: number;
  maxReverseSpeed: number;
  /** m/s^2 */
  acceleration: number;
  brakeForce: number;
  /** Radians/sec at full lock, low speed. */
  turnRate: number;
  /** Lateral grip. */
  grip: number;
  driftGrip: number;
  /** Extra yaw while drifting. */
  driftTurnBonus: number;
  /** Time in seconds to reach each drift tier. */
  driftTiers: [number, number, number];
  /** Boost durations for each tier. */
  driftBoosts: [number, number, number];
  weight: number;
  handling: number;
  /** Suspension. */
  suspensionRest: number;
  suspensionTravel: number;
  suspensionStiffness: number;
  suspensionDamping: number;
  /** Half-extents of the collision box. */
  halfExtents: THREE.Vector3;
  /** Wheel positions in local space, FL FR RL RR. */
  wheelOffsets: THREE.Vector3[];
  wheelRadius: number;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export enum ItemType {
  Boost = 0,
  TripleBoost = 1,
  GreenShell = 2,
  TripleGreenShell = 3,
  RedShell = 4,
  TripleRedShell = 5,
  Banana = 6,
  TripleBanana = 7,
  Bomb = 8,
  Star = 9,
  Lightning = 10,
  Ghost = 11,
  Bullet = 12,
  BlueShell = 13,
  Coin = 14,
  Squid = 15,
}

export interface ItemHitEvent {
  targetId: number;
  sourceId: number;
  item: ItemType;
  /** Where the hit happened, for VFX. */
  point: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface IAudioService {
  /** One-shot, optionally positional. */
  play(id: string, opts?: { position?: THREE.Vector3; volume?: number; rate?: number }): void;
  /** Continuous engine loop bound to a kart. */
  bindEngine(kartId: number, isPlayer: boolean): void;
  updateEngine(kartId: number, rpm: number, load: number, position: THREE.Vector3): void;
  setMusicIntensity(v: number): void;
  /** Global duck for cinematic moments. */
  duck(amount: number, seconds: number): void;
}

// ---------------------------------------------------------------------------
// VFX
// ---------------------------------------------------------------------------

export interface IVfxService {
  /** Fire a named one-shot effect. */
  burst(id: string, position: THREE.Vector3, normal?: THREE.Vector3, scale?: number): void;
  /** Full-screen impulses. */
  screenShake(amount: number, seconds: number): void;
  /** 0..1 speed-line / chromatic intensity. */
  setSpeedIntensity(v: number): void;
  flash(color: THREE.ColorRepresentation, amount: number, seconds: number): void;
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  tier: QualityTier;
  renderScale: number;
  shadowMapSize: number;
  cascadeCount: number;
  ssao: boolean;
  ssr: boolean;
  motionBlur: boolean;
  bloom: boolean;
  dof: boolean;
  particleBudget: number;
  anisotropy: number;
  foliageDensity: number;
  reflectionProbes: boolean;
}

// ---------------------------------------------------------------------------
// Generic lifecycle every subsystem implements
// ---------------------------------------------------------------------------

export interface ISubsystem {
  /** Called once, after the scene exists. May be async for asset generation. */
  init?(): void | Promise<void>;
  /** Fixed-rate step; do physics here. */
  fixedUpdate?(ctx: FrameContext): void;
  /** Variable-rate step; do visuals here. */
  update?(ctx: FrameContext): void;
  /** Called on canvas resize. */
  resize?(width: number, height: number): void;
  dispose?(): void;
}
