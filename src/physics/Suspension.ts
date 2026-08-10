/**
 * ============================================================================
 *  APEX KART — RAYCAST SUSPENSION
 * ============================================================================
 *  Four independent spring-dampers, each a downward raycast from its corner of
 *  the chassis against `ITrackService.raycastGround`.
 *
 *  What this buys us, and why each part matters:
 *
 *   1. WEIGHT TRANSFER. Every corner force is applied at its *contact point*,
 *      not at the centre of mass, so the sum produces a genuine torque. The
 *      nose dives under braking and lifts under power because the drive force
 *      acts at ground level while inertia acts at the CoM. Nothing about that
 *      is faked — it falls out of `Σ r × F`.
 *
 *   2. ANTI-ROLL BARS. A torsion bar per axle transfers load from the loaded
 *      wheel to the unloaded one. Without them a soft kart flops onto its
 *      outside wheels and the body roll reads as seasickness. With them the
 *      kart leans just enough to be legible. The rear bar is deliberately
 *      stiffer than the front — that's a small oversteer bias, which is what
 *      makes the thing want to drift.
 *
 *   3. CONFORMING. The load-weighted average contact normal becomes the
 *      chassis `up`, so banked road and ramps are followed smoothly. Airborne,
 *      the kart holds its last attitude and levels out slowly.
 *
 *  Damping is expressed as a RATIO (KartTuning.suspensionDamping = 0.55). At
 *  120 Hz with ω_n ≈ 17 rad/s that is nowhere near the stability limit, so the
 *  springs can be stiff enough to feel like a go-kart without ever ringing.
 * ============================================================================
 */

import * as THREE from 'three';
import type { GroundHit, ITrackService } from '@/core/Types';
import { SurfaceType } from '@/core/Types';
import { SURFACES, WORLD } from '@/core/Config';
import { bus } from '@/core/EventBus';
import { clamp, clamp01, damp, hash11 } from '@/core/MathUtils';
import type { KartBody } from './KartPhysics';
import { orthonormalise } from './KartPhysics';

const SUSP = {
  /** Ray start offset above the attach point, metres. Lets a wheel that has
   *  been shoved under the road recover instead of falling through. */
  rayLift: 0.5,
  /** Anti-roll bar authority as a fraction of the corner spring rate. */
  arbFront: 0.32,
  arbRear: 0.42,
  /** Bump stop multiplier once the spring is fully compressed. */
  bumpStop: 7.0,
  /** Extra rotational damping, 1/s — belt & braces against divergence. */
  attitudeDamp: 1.6,
  /** Hard limit on suspension-driven body attitude, radians. */
  maxPitch: 0.34,
  maxRoll: 0.3,
  /** Scales the weight-transfer torque. 1.0 is "physically honest" but the
   *  arcade lateral accel budget (5 g) is not, so we take a fraction of it —
   *  enough that the body visibly loads up, not enough to look seasick. */
  transferGain: 0.55,
  /** Half-life for the chassis `up` chasing the contact normal, grounded. */
  normalHalfLifeGround: 0.055,
  /** ...and the slow level-out toward world up while airborne. */
  normalHalfLifeAir: 0.85,
  /** Anti-gravity conforms harder — it must hug walls and ceilings. */
  normalHalfLifeAG: 0.03,
  /** Off-road rumble: metres of ground displacement at roughness 1. */
  rumbleAmp: 0.055,
  rumbleFreq: 26,
  /** Landing impact threshold, m/s, below which we don't emit `kart:land`. */
  landThreshold: 1.2,
  /** How long all four wheels must be off the ground to count as airborne. */
  airGrace: 0.0,
} as const;

// --- module-level scratch --------------------------------------------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _normalSum = new THREE.Vector3();
const _upTarget = new THREE.Vector3();
const _hit: GroundHit = {
  hit: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
  surface: SurfaceType.Road,
};
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _rawForce = [0, 0, 0, 0];

export class Suspension {
  /**
   * Solves all four corners and writes:
   *   body.wheels[i].{compression, force, grounded, normal, contact, surface, spin}
   *   body.suspForce (world N), body.suspTorquePitch/Roll (N·m)
   *   body.contactNormal, body.up, body.grounded, body.airTime, body.loadFactor
   *   body.pitch / body.roll  (integrated from the torques)
   */
  solve(b: KartBody, track: ITrackService, dt: number): void {
    const t = b.tuning;
    const restLen = t.suspensionRest;
    const travel = t.suspensionTravel;
    const minLen = restLen - travel;
    const k = t.suspensionStiffness;
    const cornerMass = t.mass * 0.25;
    const c = 2 * t.suspensionDamping * Math.sqrt(k * cornerMass);
    const rayLen = SUSP.rayLift + restLen + t.wheelRadius;

    // Chassis frame including the current body attitude — the wheels must move
    // with the leaning body or the springs have nothing to restore.
    _v1.copy(b.right);
    _v2.copy(b.up);
    _v3.copy(b.forward);
    applyAttitude(_v1, _v2, _v3, b.pitch, b.roll);

    b.suspForce.set(0, 0, 0);
    _torque.set(0, 0, 0);
    _normalSum.set(0, 0, 0);

    let grounded = 0;
    let totalForce = 0;

    const props = SURFACES[b.surface] ?? SURFACES[SurfaceType.Road];
    const speedAbs = Math.abs(b.forwardSpeed);
    b.rumblePhase += dt * SUSP.rumbleFreq * (0.4 + clamp01(speedAbs / 20));

    for (let i = 0; i < 4; i++) {
      const w = b.wheels[i];
      const off = t.wheelOffsets[i];

      // World attach point from the leaned chassis frame.
      w.attach
        .copy(b.position)
        .addScaledVector(_v1, off.x)
        .addScaledVector(_v2, off.y)
        .addScaledVector(_v3, -off.z); // local +Z is backward, forward is -Z

      _v4.copy(w.attach).addScaledVector(_v2, SUSP.rayLift);
      const hit = track.raycastGround(_v4, _v2, rayLen);

      w.prevSpringLen = w.springLen;

      if (!hit.hit) {
        w.grounded = false;
        w.force = 0;
        // Droop back to full extension so the wheel visually drops in the air.
        w.springLen = damp(w.springLen, restLen, 0.09, dt);
        w.compression = clamp01((restLen - w.springLen) / travel);
        w.slip = damp(w.slip, 0, 0.12, dt);
        _rawForce[i] = 0;
        continue;
      }

      copyHit(hit);

      // Off-road rumble: shake the *ground*, not the chassis — that way the
      // springs do the work and the shake is filtered exactly like a real bump.
      let dist = _hit.distance;
      if (props.roughness > 0.01 && speedAbs > 1.5) {
        const n = hash11(Math.floor(b.rumblePhase * 3.1) + i * 37.7) - 0.5;
        dist += n * SUSP.rumbleAmp * props.roughness * clamp01(speedAbs / 14) * 2;
      }

      let len = dist - SUSP.rayLift - t.wheelRadius;
      if (len > restLen) {
        // Ground is out of reach: wheel hangs, no force.
        w.grounded = false;
        w.force = 0;
        w.springLen = damp(w.springLen, restLen, 0.09, dt);
        w.compression = clamp01((restLen - w.springLen) / travel);
        w.slip = damp(w.slip, 0, 0.12, dt);
        _rawForce[i] = 0;
        continue;
      }
      if (len < minLen - 0.25) len = minLen - 0.25; // sanity floor

      w.springLen = len;
      w.compression = clamp01((restLen - len) / travel);
      w.grounded = true;
      w.normal.copy(_hit.normal);
      w.contact.copy(_hit.point);
      w.surface = _hit.surface;
      grounded++;

      // Hooke + damper. Damper uses the measured rate of compression, which is
      // what makes a landing squat once and stop instead of pogoing.
      const compressRate = (w.prevSpringLen - len) / dt;
      let f = k * (restLen - len) + c * compressRate;

      // Bump stop.
      if (len < minLen) f += SUSP.bumpStop * k * (minLen - len);

      if (f < 0) f = 0; // springs push, never pull
      _rawForce[i] = f;
    }

    // --- anti-roll bars ----------------------------------------------------
    // Front axle = wheels 0,1 ; rear axle = 2,3.
    const arbF = SUSP.arbFront * k * travel * (b.wheels[0].compression - b.wheels[1].compression);
    const arbR = SUSP.arbRear * k * travel * (b.wheels[2].compression - b.wheels[3].compression);
    if (b.wheels[0].grounded && b.wheels[1].grounded) {
      _rawForce[0] = Math.max(0, _rawForce[0] - arbF);
      _rawForce[1] = Math.max(0, _rawForce[1] + arbF);
    }
    if (b.wheels[2].grounded && b.wheels[3].grounded) {
      _rawForce[2] = Math.max(0, _rawForce[2] - arbR);
      _rawForce[3] = Math.max(0, _rawForce[3] + arbR);
    }

    // --- accumulate force + torque -----------------------------------------
    const maxCorner = t.mass * WORLD.gravity * 6; // clamp absurd landing spikes
    for (let i = 0; i < 4; i++) {
      const w = b.wheels[i];
      if (!w.grounded) {
        w.force = 0;
        continue;
      }
      const f = Math.min(_rawForce[i], maxCorner);
      w.force = f;
      totalForce += f;
      _normalSum.addScaledVector(w.normal, f + 1);

      // F = normal * f, applied at the contact point.
      _v4.copy(w.normal).multiplyScalar(f);
      b.suspForce.add(_v4);

      // tau += r × F  with r measured from the centre of mass.
      _torque.x += (w.contact.y - b.position.y) * _v4.z - (w.contact.z - b.position.z) * _v4.y;
      _torque.y += (w.contact.z - b.position.z) * _v4.x - (w.contact.x - b.position.x) * _v4.z;
      _torque.z += (w.contact.x - b.position.x) * _v4.y - (w.contact.y - b.position.y) * _v4.x;
    }

    // --- ground state ------------------------------------------------------
    const wasGrounded = b.grounded;
    b.groundedWheels = grounded;
    b.grounded = grounded > 0;

    if (b.grounded) {
      _normalSum.normalize();
      b.contactNormal.copy(_normalSum);
      b.lastGroundNormal.copy(_normalSum);
      b.lastGroundPoint.copy(b.wheels[0].grounded ? b.wheels[0].contact : b.position);
      b.hadGround = true;
      b.groundTime += dt;
      if (!wasGrounded) {
        const impact = Math.max(0, -b.velocity.dot(b.contactNormal));
        b.airTime = 0;
        b.landImpact = impact;
        bus.emit('kart:land', {
          kartId: b.id,
          position: b.position,
          impact: impact > SUSP.landThreshold ? impact : 0,
        });
      }
      b.airTime = 0;
    } else {
      b.airTime += dt;
      b.groundTime = 0;
      b.contactNormal.copy(b.lastGroundNormal);
    }

    // Load factor: how planted are we, relative to sitting still.
    const staticLoad = t.mass * WORLD.gravity;
    b.loadFactor = clamp(totalForce / staticLoad, 0.0, 1.8);
    if (!b.grounded) b.loadFactor = 0;

    // --- chassis `up` chases the contact plane ------------------------------
    if (b.grounded) {
      _upTarget.copy(b.contactNormal);
      const hl = b.antiGravity ? SUSP.normalHalfLifeAG : SUSP.normalHalfLifeGround;
      dampDir(b.up, _upTarget, hl, dt);
    } else if (!b.antiGravity) {
      // Hold the launch attitude, then level out slowly. Holding it is what
      // makes ramps feel like ramps instead of teleports.
      dampDir(b.up, WORLD_UP, SUSP.normalHalfLifeAir, dt);
    }
    orthonormalise(b);

    // --- integrate body attitude from the real torques ----------------------
    const L = t.halfExtents.z * 2;
    const W = t.halfExtents.x * 2;
    const H = t.halfExtents.y * 2;
    const iPitch = (t.mass * (L * L + H * H)) / 12;
    const iRoll = (t.mass * (W * W + H * H)) / 12;

    // Recompute the leaned axes so the torque projection matches the frame we
    // built the wheels in.
    _v1.copy(b.right);
    _v2.copy(b.up);
    _v3.copy(b.forward);
    applyAttitude(_v1, _v2, _v3, b.pitch, b.roll);

    let tauPitch = _torque.dot(_v1);
    let tauRoll = _torque.dot(_v3);

    // Longitudinal + lateral tyre forces act at ground level while inertia acts
    // at the CoM, a height `h` above it → a couple of magnitude F·h.
    //   accelerating (longAccel > 0)  → tauPitch > 0 → nose lifts, tail squats
    //   braking      (longAccel < 0)  → nose dives
    //   left turn    (lateralAccel<0) → tauRoll > 0 → body leans right (outward)
    // The drift lean added in buildQuaternions deliberately fights that outward
    // roll, which is exactly the MK8 read: planted body, kart tipped into the arc.
    const h = Math.abs(t.wheelOffsets[0].y) + t.wheelRadius + t.suspensionRest * 0.5;
    const g = SUSP.transferGain * h * t.mass;
    tauPitch += b.longAccel * g;
    tauRoll += -b.lateralAccel * g;

    if (b.grounded) {
      b.pitchVel += (tauPitch / iPitch) * dt;
      b.rollVel += (tauRoll / iRoll) * dt;
    } else {
      // In the air there is nothing to push against: bleed the attitude away.
      b.pitchVel = damp(b.pitchVel, 0, 0.35, dt);
      b.rollVel = damp(b.rollVel, 0, 0.35, dt);
      b.pitch = damp(b.pitch, 0, 0.5, dt);
      b.roll = damp(b.roll, 0, 0.5, dt);
    }

    const decay = Math.exp(-SUSP.attitudeDamp * dt);
    b.pitchVel *= decay;
    b.rollVel *= decay;
    // Hard velocity clamp: a divergent attitude is the only way this solver can
    // explode, and 12 rad/s is already far past anything believable.
    b.pitchVel = clamp(b.pitchVel, -12, 12);
    b.rollVel = clamp(b.rollVel, -12, 12);

    b.pitch += b.pitchVel * dt;
    b.roll += b.rollVel * dt;

    if (b.pitch > SUSP.maxPitch) { b.pitch = SUSP.maxPitch; b.pitchVel = Math.min(0, b.pitchVel); }
    if (b.pitch < -SUSP.maxPitch) { b.pitch = -SUSP.maxPitch; b.pitchVel = Math.max(0, b.pitchVel); }
    if (b.roll > SUSP.maxRoll) { b.roll = SUSP.maxRoll; b.rollVel = Math.min(0, b.rollVel); }
    if (b.roll < -SUSP.maxRoll) { b.roll = -SUSP.maxRoll; b.rollVel = Math.max(0, b.rollVel); }

    if (!Number.isFinite(b.pitch) || !Number.isFinite(b.roll)) {
      b.pitch = 0; b.roll = 0; b.pitchVel = 0; b.rollVel = 0;
    }

    // --- wheel spin (visual) ------------------------------------------------
    const roll = b.forwardSpeed / Math.max(0.05, t.wheelRadius);
    const slipping = b.state.drifting || (Math.abs(b.lateralSpeed) > 3 && b.grounded);
    for (let i = 0; i < 4; i++) {
      const w = b.wheels[i];
      const rear = i >= 2;
      // Rear wheels overspin while drifting or launching — the classic read.
      const boostSpin = b.boostTime > 0 && rear ? 1.35 : 1;
      const driftSpin = slipping && rear ? 1.45 : 1;
      const target = w.grounded ? roll * boostSpin * driftSpin : roll * 0.85;
      w.spinRate = damp(w.spinRate, target, 0.05, dt);
      w.spin = (w.spin + w.spinRate * dt) % (Math.PI * 2);
      const targetSlip = w.grounded
        ? clamp01(Math.abs(b.lateralSpeed) * 0.09 + (b.state.drifting && rear ? 0.4 : 0))
        : 0;
      w.slip = damp(w.slip, targetSlip, 0.08, dt);
    }
  }
}

// ---------------------------------------------------------------------------

/** Rotate an orthonormal triad in place by (pitch about right, roll about forward). */
function applyAttitude(
  right: THREE.Vector3,
  up: THREE.Vector3,
  forward: THREE.Vector3,
  pitch: number,
  roll: number,
): void {
  if (Math.abs(pitch) > 1e-5) {
    // Rotate up & forward about `right`.
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    // f' = f cos + (r × f) sin ; r × f = -up  (right-handed with right=f×up)
    const fx = forward.x * cp + up.x * sp;
    const fy = forward.y * cp + up.y * sp;
    const fz = forward.z * cp + up.z * sp;
    const ux = up.x * cp - forward.x * sp;
    const uy = up.y * cp - forward.y * sp;
    const uz = up.z * cp - forward.z * sp;
    forward.set(fx, fy, fz);
    up.set(ux, uy, uz);
  }
  if (Math.abs(roll) > 1e-5) {
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    // Rotate up & right about `forward`: u' = u cos + (f × u) sin = u cos + r sin
    const ux = up.x * cr + right.x * sr;
    const uy = up.y * cr + right.y * sr;
    const uz = up.z * cr + right.z * sr;
    const rx = right.x * cr - up.x * sr;
    const ry = right.y * cr - up.y * sr;
    const rz = right.z * cr - up.z * sr;
    up.set(ux, uy, uz);
    right.set(rx, ry, rz);
  }
}

/** Frame-rate independent slerp of one unit vector toward another. */
function dampDir(cur: THREE.Vector3, target: THREE.Vector3, halfLife: number, dt: number): void {
  const f = halfLife <= 0 ? 0 : Math.pow(2, -dt / halfLife);
  cur.x = target.x + (cur.x - target.x) * f;
  cur.y = target.y + (cur.y - target.y) * f;
  cur.z = target.z + (cur.z - target.z) * f;
  if (cur.lengthSq() < 1e-8) cur.copy(target);
  cur.normalize();
}

function copyHit(h: GroundHit): void {
  _hit.hit = h.hit;
  _hit.point.copy(h.point);
  _hit.normal.copy(h.normal);
  _hit.distance = h.distance;
  _hit.surface = h.surface;
}
