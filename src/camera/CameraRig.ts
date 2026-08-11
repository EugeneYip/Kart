/**
 * ============================================================================
 *  CAMERA RIG — the mechanism underneath every camera in FOXY KART
 * ============================================================================
 *  This file owns *how* the camera moves; `ChaseCamera` owns *where it wants
 *  to be*. Keeping them apart means the intro cinematic, the replay cameras
 *  and the chase camera all inherit the same physical feel: springs with
 *  velocity carried across frames, noise-driven shake, and a single place
 *  where the final pose is committed to the THREE camera.
 *
 *  Nothing in here allocates after construction.
 * ============================================================================
 */

import * as THREE from 'three';
import type { KartState } from '@/core/Types';
import { clamp, clamp01, damp, hash11, smootherstep } from '@/core/MathUtils';

// ---------------------------------------------------------------------------
// Dependency shapes
// ---------------------------------------------------------------------------

/**
 * Structural view of the kart roster. `KartManager` satisfies this without
 * needing to know the camera exists — and the camera never imports it, so the
 * two modules can be built in any order.
 */
export interface IKartRoster {
  readonly karts: ReadonlyArray<KartState>;
}

/**
 * A dependency that is wired in later and probed by feature detection.
 * Deliberately opaque: we must compile before the other agent's class exists.
 */
export type LateDependency = object;

/** Call `target[method](...args)` if it exists. Never throws. */
export function callOptional(
  target: LateDependency | null | undefined,
  method: string,
  ...args: unknown[]
): unknown {
  if (!target) return undefined;
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== 'function') return undefined;
  try {
    return (fn as (...a: unknown[]) => unknown).apply(target, args);
  } catch (err) {
    console.warn(`[camera] optional call ${method}() failed:`, err);
    return undefined;
  }
}

/** Read a Vector3-shaped property off a late dependency, or null. */
export function readVector3(
  target: LateDependency | null | undefined,
  key: string,
): THREE.Vector3 | null {
  if (!target) return null;
  const v = (target as Record<string, unknown>)[key];
  if (!v || typeof v !== 'object') return null;
  const c = v as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof c.x === 'number' && typeof c.y === 'number' && typeof c.z === 'number') {
    return v as THREE.Vector3;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Springs
// ---------------------------------------------------------------------------

/** Output of one spring integration step. The instance is reused — copy it. */
export interface SpringStep {
  value: number;
  velocity: number;
}

const springOut: SpringStep = { value: 0, velocity: 0 };

/**
 * One step of a damped harmonic oscillator, integrated with implicit Euler.
 *
 * `omega` is the undamped angular frequency (rad/s — roughly "how urgently it
 * chases"), `zeta` the damping ratio: 1 = critically damped (no overshoot, the
 * default for anything load-bearing), < 1 = overshoot (look-behind swings,
 * boost punch), > 1 = sluggish.
 *
 * Implicit Euler is unconditionally stable, so a 200 ms hitch can never make
 * the camera explode — which a naive explicit spring absolutely will.
 */
export function springDamper(
  current: number,
  velocity: number,
  target: number,
  omega: number,
  zeta: number,
  dt: number,
): SpringStep {
  if (dt <= 0) {
    springOut.value = current;
    springOut.velocity = velocity;
    return springOut;
  }
  const w = omega > 1e-4 ? omega : 1e-4;
  const z = zeta < 0 ? 0 : zeta;
  const oo = w * w;
  const den = 1 + 2 * dt * z * w + dt * dt * oo;
  const v = (velocity - dt * oo * (current - target)) / den;
  springOut.velocity = v;
  springOut.value = current + dt * v;
  return springOut;
}

/** Scalar spring that remembers its own velocity. */
export class Spring {
  value: number;
  velocity = 0;

  constructor(initial = 0) {
    this.value = initial;
  }

  step(target: number, omega: number, zeta: number, dt: number): number {
    const s = springDamper(this.value, this.velocity, target, omega, zeta, dt);
    this.value = s.value;
    this.velocity = s.velocity;
    return this.value;
  }

  /** Teleport with no residual motion. */
  snap(value: number): void {
    this.value = value;
    this.velocity = 0;
  }

  /** Inject velocity — the honest way to do an impulse (landing dip, punch). */
  kick(deltaVelocity: number): void {
    this.velocity += deltaVelocity;
  }
}

/** Three independent springs sharing one Vector3, for positions. */
export class Spring3 {
  readonly value = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  step(target: THREE.Vector3, omega: number, zeta: number, dt: number): THREE.Vector3 {
    let s = springDamper(this.value.x, this.velocity.x, target.x, omega, zeta, dt);
    this.value.x = s.value; this.velocity.x = s.velocity;
    s = springDamper(this.value.y, this.velocity.y, target.y, omega, zeta, dt);
    this.value.y = s.value; this.velocity.y = s.velocity;
    s = springDamper(this.value.z, this.velocity.z, target.z, omega, zeta, dt);
    this.value.z = s.value; this.velocity.z = s.velocity;
    return this.value;
  }

  snap(target: THREE.Vector3): void {
    this.value.copy(target);
    this.velocity.set(0, 0, 0);
  }

  /** Magnitude of the spring velocity — handy for debug readouts. */
  get speed(): number {
    return this.velocity.length();
  }
}

// ---------------------------------------------------------------------------
// Noise — shake must read as impact, not as a bug
// ---------------------------------------------------------------------------

/**
 * 1D Perlin (gradient) noise. Random jitter looks like a broken frame; smooth
 * gradient noise looks like a camera operator being shoved. Range ≈ [-1, 1].
 */
export function perlin1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = hash11(i * 1.7 + seed * 57.31) * 2 - 1;
  const g1 = hash11((i + 1) * 1.7 + seed * 57.31) * 2 - 1;
  const u = smootherstep(f);
  // lerp of the two gradient dot products — real Perlin, not value noise.
  return (g0 * f) * (1 - u) + (g1 * (f - 1)) * u;
}

/** Two octaves of `perlin1` — a body blow plus a rattle. */
export function shakeNoise(x: number, seed: number): number {
  return (perlin1(x, seed) * 0.68 + perlin1(x * 2.37 + 11.3, seed + 3.1) * 0.32) * 2.0;
}

/**
 * Positional + rotational shake with a decaying envelope.
 * Applied in *camera space* so it always reads as the operator being hit,
 * never as the world sliding.
 */
export class ShakeState {
  /** Peak amplitude, in metres for the positional part. */
  amplitude = 0;
  /** 1 → 0 envelope. */
  envelope = 0;
  private decayRate = 4;
  private phase = 0;
  private seed = 1;

  /** Extra shake injected by another subsystem (VfxManager). */
  readonly externalOffset = new THREE.Vector3();
  readonly externalRotation = new THREE.Vector3();

  readonly offset = new THREE.Vector3();
  readonly rotation = new THREE.Vector3();

  add(amount: number, seconds: number): void {
    const a = clamp(amount, 0, 4);
    if (a <= 0) return;
    // A new, bigger hit takes over; a smaller one only tops up the envelope.
    if (a >= this.amplitude * 0.85) {
      this.amplitude = Math.max(this.amplitude * 0.35, a);
      this.seed = 1 + Math.floor(hash11(this.phase * 13.7 + a * 91.3) * 512);
    }
    this.envelope = 1;
    this.decayRate = 1 / Math.max(0.05, seconds);
  }

  clear(): void {
    this.amplitude = 0;
    this.envelope = 0;
    this.offset.set(0, 0, 0);
    this.rotation.set(0, 0, 0);
  }

  update(dt: number): void {
    this.phase += dt;
    if (this.envelope > 0) {
      this.envelope = Math.max(0, this.envelope - this.decayRate * dt);
    }
    // pow(env, 1.7): snappy hit, long quiet tail. Linear decay reads as fake.
    const env = this.envelope <= 0 ? 0 : Math.pow(this.envelope, 1.7);
    const amp = this.amplitude * env;
    if (amp <= 1e-5) {
      this.offset.copy(this.externalOffset);
      this.rotation.copy(this.externalRotation);
      return;
    }
    const t = this.phase * 26.0;
    this.offset.set(
      shakeNoise(t, this.seed) * amp * 0.115,
      shakeNoise(t * 1.13 + 5.7, this.seed + 17) * amp * 0.135,
      shakeNoise(t * 0.87 + 19.4, this.seed + 31) * amp * 0.05,
    ).add(this.externalOffset);
    this.rotation.set(
      shakeNoise(t * 1.31 + 41.2, this.seed + 47) * amp * 0.0125,
      shakeNoise(t * 1.07 + 63.9, this.seed + 61) * amp * 0.0125,
      shakeNoise(t * 0.71 + 87.1, this.seed + 79) * amp * 0.021,
    ).add(this.externalRotation);
  }
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

/** Everything the rig needs to know per frame. Filled in by the caller. */
export interface RigTargets {
  /** World position the camera wants to occupy. */
  readonly anchor: THREE.Vector3;
  /** World point the camera wants to look at. */
  readonly look: THREE.Vector3;
  /**
   * Velocity feed-forward, added to the *spring target* only.
   *
   * A critically damped spring chasing a target that moves at a constant `v`
   * settles a fixed `2·zeta·v/omega` behind it — 6.9 m at 40 m/s with
   * `posOmega = 11.5`. Left alone, the hard separation clamp (not the art
   * direction) ends up deciding the framing at speed. Leading the spring
   * target by exactly that much cancels the lag, so the settled pose is
   * `anchor`. `snap()` ignores the lead, which is why it lives here rather
   * than being folded into `anchor`.
   */
  readonly anchorLead: THREE.Vector3;
  /** Same, for the look point. */
  readonly lookLead: THREE.Vector3;
  /** Desired up axis (track normal for anti-gravity). */
  readonly up: THREE.Vector3;
  fov: number;
  /** Roll about the view axis, radians. */
  roll: number;
  posOmega: number;
  posZeta: number;
  lookOmega: number;
  lookZeta: number;
  fovOmega: number;
  fovZeta: number;
  rollOmega: number;
  rollZeta: number;
  /** Seconds for the up-vector to close half the gap to `up`. */
  upHalfLife: number;
}

export function createRigTargets(): RigTargets {
  return {
    anchor: new THREE.Vector3(),
    look: new THREE.Vector3(),
    anchorLead: new THREE.Vector3(),
    lookLead: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    fov: 65,
    roll: 0,
    posOmega: 11.5,
    posZeta: 1.0,
    lookOmega: 9.0,
    lookZeta: 1.0,
    fovOmega: 8.0,
    fovZeta: 0.9,
    rollOmega: 6.5,
    rollZeta: 1.0,
    upHalfLife: 0.115,
  };
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// module-level scratch — the rig never allocates
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _lead = new THREE.Vector3();

/**
 * Holds the *actual* camera pose and eases it toward the targets. The pose is
 * kept here (rather than read back off the THREE camera) so shake and the
 * ground clamp never feed back into the springs.
 */
export class CameraRig {
  readonly pos = new Spring3();
  readonly look = new Spring3();
  readonly fov = new Spring(65);
  readonly roll = new Spring(0);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly shake = new ShakeState();

  /** Final committed position including shake — what the camera actually used. */
  readonly finalPosition = new THREE.Vector3();
  readonly finalQuaternion = new THREE.Quaternion();

  private lastFov = -1;

  get position(): THREE.Vector3 { return this.pos.value; }
  get lookPoint(): THREE.Vector3 { return this.look.value; }

  /** Advance every spring. Does not touch the THREE camera. */
  step(t: RigTargets, dt: number): void {
    _lead.copy(t.anchor).add(t.anchorLead);
    this.pos.step(_lead, t.posOmega, t.posZeta, dt);
    _lead.copy(t.look).add(t.lookLead);
    this.look.step(_lead, t.lookOmega, t.lookZeta, dt);
    this.fov.step(t.fov, t.fovOmega, t.fovZeta, dt);
    this.roll.step(t.roll, t.rollOmega, t.rollZeta, dt);

    // Up blends on a half-life so wall-riding transitions read as a deliberate
    // roll rather than a snap.
    const f = t.upHalfLife <= 0 ? 0 : Math.pow(2, -dt / t.upHalfLife);
    this.up.x = t.up.x + (this.up.x - t.up.x) * f;
    this.up.y = t.up.y + (this.up.y - t.up.y) * f;
    this.up.z = t.up.z + (this.up.z - t.up.z) * f;
    if (this.up.lengthSq() < 1e-6) this.up.copy(AXIS_Y);
    else this.up.normalize();

    this.shake.update(dt);
  }

  /** Jump the whole rig to the targets with no residual velocity. */
  snap(t: RigTargets): void {
    this.pos.snap(t.anchor);
    this.look.snap(t.look);
    this.fov.snap(t.fov);
    this.roll.snap(t.roll);
    this.up.copy(t.up).normalize();
    this.shake.clear();
  }

  /** Commit the pose (plus shake) to a real camera. */
  applyTo(camera: THREE.PerspectiveCamera): void {
    const p = this.pos.value;
    const l = this.look.value;

    // Degenerate look direction (camera exactly on its target) → keep the last
    // orientation rather than producing NaN.
    _v.copy(l).sub(p);
    if (_v.lengthSq() < 1e-8) {
      _v.copy(AXIS_Z).multiplyScalar(-1).applyQuaternion(this.finalQuaternion);
      _v.add(p);
      _m4.lookAt(p, _v, this.up);
    } else {
      _m4.lookAt(p, l, this.up);
    }
    _q.setFromRotationMatrix(_m4);

    // Roll about the view axis, then noise rotation — both in camera space.
    const rot = this.shake.rotation;
    _e.set(rot.x, rot.y, this.roll.value + rot.z, 'XYZ');
    _qa.setFromEuler(_e);
    _q.multiply(_qa);

    // Positional shake also in camera space.
    _right.copy(AXIS_X).applyQuaternion(_q);
    _up.copy(AXIS_Y).applyQuaternion(_q);
    const off = this.shake.offset;
    this.finalPosition.copy(p)
      .addScaledVector(_right, off.x)
      .addScaledVector(_up, off.y)
      .addScaledVector(_v.copy(AXIS_Z).applyQuaternion(_q), off.z);

    if (!isFinite(this.finalPosition.x) || !isFinite(this.finalPosition.y) || !isFinite(this.finalPosition.z)) {
      this.finalPosition.copy(p);
    }

    this.finalQuaternion.copy(_q);
    camera.position.copy(this.finalPosition);
    camera.quaternion.copy(_q);

    const fov = clamp(this.fov.value, 20, 110);
    if (Math.abs(fov - this.lastFov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
      this.lastFov = fov;
    }
  }

  /** Recover from a non-finite state instead of poisoning every later frame. */
  sanitize(fallback: THREE.Vector3): boolean {
    const bad = (v: THREE.Vector3) => !isFinite(v.x) || !isFinite(v.y) || !isFinite(v.z);
    if (!bad(this.pos.value) && !bad(this.look.value) && isFinite(this.fov.value) && isFinite(this.roll.value)) {
      return false;
    }
    this.pos.value.copy(fallback);
    this.pos.velocity.set(0, 0, 0);
    this.look.value.copy(fallback);
    this.look.velocity.set(0, 0, 0);
    if (!isFinite(this.fov.value)) this.fov.snap(65);
    if (!isFinite(this.roll.value)) this.roll.snap(0);
    this.up.copy(AXIS_Y);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Signed heading of a direction in the XZ plane, matching `yawDirection`.
 * `yaw = atan2(x, z)` so that (0,0,-1) — the kart's local forward — is π.
 */
export function yawOf(dir: THREE.Vector3): number {
  return Math.atan2(dir.x, dir.z);
}

/** Inverse of `yawOf`. Writes into `out`. */
export function yawDirection(yaw: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}

/**
 * Project `dir` into the plane perpendicular to `up` and normalise.
 * Falls back to `fallback` when the projection is degenerate (looking straight
 * along the up axis), which happens the instant you enter a vertical
 * anti-gravity section.
 */
export function projectOnPlane(
  dir: THREE.Vector3,
  up: THREE.Vector3,
  fallback: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.copy(dir).addScaledVector(up, -dir.dot(up));
  if (out.lengthSq() < 1e-5) {
    out.copy(fallback).addScaledVector(up, -fallback.dot(up));
    if (out.lengthSq() < 1e-5) out.set(0, 0, -1);
  }
  return out.normalize();
}

/**
 * Clamp `point` so its distance from `centre` lies in [min, max], preserving
 * direction. Guarantees the camera is never inside the kart nor absurdly far,
 * whatever the collision solver decided.
 */
export function clampDistance(
  point: THREE.Vector3,
  centre: THREE.Vector3,
  min: number,
  max: number,
): void {
  _v.copy(point).sub(centre);
  const d = _v.length();
  if (d < 1e-5) {
    point.set(centre.x, centre.y + min * 0.5, centre.z + min * 0.87);
    return;
  }
  const target = clamp(d, min, max);
  if (Math.abs(target - d) > 1e-6) {
    point.copy(centre).addScaledVector(_v, target / d);
  }
}

/** Exponential smoothing with different rates for rising and falling. */
export function asymmetricDamp(
  current: number,
  target: number,
  attackHalfLife: number,
  releaseHalfLife: number,
  dt: number,
): number {
  return damp(current, target, target > current ? attackHalfLife : releaseHalfLife, dt);
}

export { clamp01 };
