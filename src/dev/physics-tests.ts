/**
 * ============================================================================
 *  APEX KART — PHYSICS TEST BATTERY  (dev harness, not shipped)
 * ============================================================================
 *  The DOM-free half of the physics bench. Everything here runs under plain
 *  Node, which is the entire point:
 *
 *      node src/dev/node-run.mjs src/dev/physics-run.ts
 *
 *  `src/dev/physics.ts` is the browser page — scene, chase camera, keyboard
 *  input, live HUD — and it imports this module. The two were one file until
 *  the assertion suite turned out to be unrunnable in CI because the page
 *  constructs a real `THREE.WebGLRenderer` at import time. A suite you cannot
 *  run headlessly is a suite nobody runs.
 *
 *  Contents:
 *
 *   • `TestTrack` — a complete analytic `ITrackService`: a stadium oval with
 *     two flat straights, two 25° banked arcs, a launch ramp, a boost pad,
 *     an anti-gravity arc, guardrails, a grass apron and a void beyond.
 *     Everything is a closed-form height field, so `raycastGround` is exact
 *     and the numbers below mean something.
 *
 *   • `runAll()` — a scripted, headless test battery with numeric assertions
 *     (top speed, drift charge timing, cornering speed loss, wall scrub,
 *     tunnelling, tricks, anti-gravity, NaN fuzz, banked stability, perf).
 * ============================================================================
 */

import * as THREE from 'three';
import { bus } from '@/core/EventBus';
import { FIXED_DT } from '@/core/Config';
import {
  DriftStage,
  SurfaceType,
  type FrameContext,
  type GroundHit,
  type ITrackService,
  type KartState,
  type TrackSample,
  type WallHit,
} from '@/core/Types';
import { Rng, clamp, clamp01, smoothstep } from '@/core/MathUtils';
import { PhysicsWorld } from '@/physics/PhysicsWorld';
import { PHYS } from '@/physics/KartPhysics';
import { CHARACTER_STATS, makeTuning } from '@/physics/Tuning';

// ===========================================================================
//  TEST TRACK
// ===========================================================================

export const R = 60; // arc radius / half-separation of the straights
export const L = 55; // half-length of each straight
export const ROAD = 11; // road half-width
/**
 * Kerb / verge width outside the asphalt edge. Matches `TrackBuilder.CROSS.kerbW`
 * (1.55 m) and, like the shipping track, this band is classified `Road` — it is
 * NOT a special off-road surface. That matters: the cost of riding the verge has
 * to come from the contact model (`PHYS.vergeDrag`), because on the real circuit
 * `Track.classify()` also answers `Road` for the kerb zone. A bench that made the
 * kerb grass would have "proved" a friction model that does not exist.
 */
export const KERB = 1.55;
export const BANK = (25 * Math.PI) / 180; // peak bank on the arcs
export const RAMP_H = 2.4;
/**
 * Guardrail offset on the ramp straight + arcs. Sits just outside the kerb, as
 * on the real cross-section (`halfWidth + kerbW + shoulder + 0.12`); the bench
 * has no shoulder, so `ROAD + KERB + 0.15`.
 */
export const WALL_TIGHT = ROAD + KERB + 0.15;
export const WALL_WIDE = 19.4; // ...and on the grass-apron straight
export const WALL_HEIGHT = 1.4;
/** Height of the `tallWall` test building — over `COLL.solidProbeLift`. */
export const BUILDING_HEIGHT = 9.0;
export const GRASS_LIMIT = 42; // beyond this there is no ground at all
export const OOB_LIMIT = 34;

export const ARC_LEN = Math.PI * R;
export const STRAIGHT_LEN = 2 * L;
export const LAP = 2 * STRAIGHT_LEN + 2 * ARC_LEN;

/** Region ids. 0 = ramp straight (travel −Z), 1 = arc A, 2 = apron straight, 3 = arc B. */
export enum Region {
  RampStraight = 0,
  ArcA = 1,
  ApronStraight = 2,
  ArcB = 3,
}

/** Scratch result of the nearest-centreline solve. Never allocated per call. */
export const G = {
  region: Region.RampStraight,
  /** Nearest centreline point (XZ; height added separately). */
  cx: 0,
  cz: 0,
  /** Unit 2D tangent (direction of travel). */
  tx: 0,
  tz: 0,
  /** Unit 2D outward normal == driver's right. */
  bx: 0,
  bz: 0,
  /** Signed lateral offset, positive = outward. */
  u: 0,
  bank: 0,
  /** Arc length along the lap of the nearest point. */
  dist: 0,
  curvature: 0,
};

export function geoAt(x: number, z: number): void {
  if (z > L) {
    // Arc B — centre (0, +L), travel from −X side to +X side over the top.
    const dx = x;
    const dz = z - L;
    const r = Math.hypot(dx, dz) || 1e-6;
    const cosP = dx / r;
    const sinP = dz / r;
    G.region = Region.ArcB;
    G.cx = cosP * R;
    G.cz = L + sinP * R;
    G.tx = sinP;
    G.tz = -cosP;
    G.bx = cosP;
    G.bz = sinP;
    G.u = r - R;
    const phi = Math.atan2(sinP, cosP); // 0..π over this arc
    G.dist = 2 * STRAIGHT_LEN + ARC_LEN + (Math.PI - phi) * R;
    G.bank = BANK * arcBankBlend(Math.PI - phi);
    G.curvature = -1 / R;
  } else if (z < -L) {
    // Arc A — centre (0, −L).
    const dx = x;
    const dz = z + L;
    const r = Math.hypot(dx, dz) || 1e-6;
    const cosP = dx / r;
    const sinP = dz / r;
    G.region = Region.ArcA;
    G.cx = cosP * R;
    G.cz = -L + sinP * R;
    G.tx = sinP;
    G.tz = -cosP;
    G.bx = cosP;
    G.bz = sinP;
    G.u = r - R;
    const phi = Math.atan2(sinP, cosP); // 0..−π over this arc
    G.dist = STRAIGHT_LEN + -phi * R;
    G.bank = BANK * arcBankBlend(-phi);
    G.curvature = -1 / R;
  } else {
    const side = x >= 0 ? 1 : -1;
    G.region = side > 0 ? Region.RampStraight : Region.ApronStraight;
    G.cx = side * R;
    G.cz = z;
    G.tx = 0;
    G.tz = -side;
    G.bx = side;
    G.bz = 0;
    G.u = side * x - R;
    G.bank = 0;
    G.curvature = 0;
    G.dist = side > 0 ? L - z : 2 * STRAIGHT_LEN + ARC_LEN + (z + L);
  }
}

/** Ramps the bank in and out over the first/last 0.55 rad of an arc. */
export function arcBankBlend(a: number): number {
  return smoothstep(Math.min(a, Math.PI - a) / 0.55);
}

/** Height of the ramp on the +R straight as a function of z (travel is −Z). */
export function rampHeight(z: number): number {
  if (z >= 20 || z <= -18) return 0;
  if (z >= 4) {
    const s = (20 - z) / 16;
    return RAMP_H * s * s; // steepest right at the lip → a real kicker
  }
  return RAMP_H * (1 - smoothstep((4 - z) / 22));
}

export function wallInsetFor(region: Region, z: number): number {
  if (region !== Region.ApronStraight) return WALL_TIGHT;
  // Blend the guardrail outward over 10 m so the apron doesn't start with a step.
  const k = smoothstep((L - Math.abs(z)) / 10);
  return WALL_TIGHT + (WALL_WIDE - WALL_TIGHT) * k;
}

export class TestTrack implements ITrackService {
  readonly lapLength = LAP;
  readonly lapCount = 3;

  /** 'track' = the oval. 'flat' = an infinite plane banked by `flatBank`. */
  mode: 'track' | 'flat' = 'track';
  flatBank = 0;
  /**
   * Which side's barrier is a nine-metre building rather than a kerbside rail.
   * The contact model classifies the two differently (verge → friction only;
   * solid → soft collider) and it detects "tall" by re-probing 3.6 m up, so the
   * bench needs a barrier that is actually tall to exercise the second class.
   * Off by default so no other test can be perturbed by it.
   */
  tallWall: 'none' | 'inner' | 'outer' = 'none';

  private gh: GroundHit = {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    surface: SurfaceType.Road,
  };
  private wh: WallHit = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), depth: 0 };
  private smp: TrackSample = {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: ROAD,
    t: 0,
    distance: 0,
    curvature: 0,
    bank: 0,
  };
  private rl = new THREE.Vector3();
  private startQ = new THREE.Quaternion();
  private startP = new THREE.Vector3();
  private basis = new THREE.Matrix4();

  // ---- the height field ---------------------------------------------------

  /** Surface height at (x,z). NaN when there is no ground (the void). */
  heightAt(x: number, z: number): number {
    if (this.mode === 'flat') return -Math.tan(this.flatBank) * x;
    geoAt(x, z);
    if (Math.abs(G.u) > GRASS_LIMIT) return NaN;
    const base = G.region === Region.RampStraight ? rampHeight(G.cz) : 0;
    if (Math.abs(G.u) <= ROAD + 6) return base + G.u * Math.tan(G.bank);
    // Off the shoulder the bank flattens out into the surrounding field.
    const fade = clamp01(1 - (Math.abs(G.u) - (ROAD + 6)) / 8);
    return base * fade + G.u * Math.tan(G.bank) * fade;
  }

  private surfaceOf(x: number, z: number): SurfaceType {
    if (this.mode === 'flat') return SurfaceType.Road;
    geoAt(x, z);
    const au = Math.abs(G.u);
    if (au <= ROAD) {
      if (G.region === Region.ArcB) return SurfaceType.AntiGravity;
      if (G.region === Region.ApronStraight && G.cz > -22 && G.cz < -6 && au < 4.5) {
        return SurfaceType.Boost;
      }
      return SurfaceType.Road;
    }
    // The kerb band. `Road`, exactly as `Track.classify()` answers for the kerb
    // zone on all three circuits — see the KERB comment above.
    if (au <= ROAD + KERB) return SurfaceType.Road;
    if (au > GRASS_LIMIT) return SurfaceType.Void;
    return SurfaceType.Grass;
  }

  /** Barrier height on one side — `tallWall` turns one of them into a building. */
  private wallHeightOn(side: -1 | 1): number {
    if (this.tallWall === 'inner' && side < 0) return BUILDING_HEIGHT;
    if (this.tallWall === 'outer' && side > 0) return BUILDING_HEIGHT;
    return WALL_HEIGHT;
  }

  /** Central-difference normal of the height field. */
  private normalAt(x: number, z: number, out: THREE.Vector3): void {
    const e = 0.14;
    const hx0 = this.heightAt(x - e, z);
    const hx1 = this.heightAt(x + e, z);
    const hz0 = this.heightAt(x, z - e);
    const hz1 = this.heightAt(x, z + e);
    const dx = Number.isFinite(hx1) && Number.isFinite(hx0) ? (hx1 - hx0) / (2 * e) : 0;
    const dz = Number.isFinite(hz1) && Number.isFinite(hz0) ? (hz1 - hz0) / (2 * e) : 0;
    out.set(-dx, 1, -dz).normalize();
  }

  // ---- ITrackService ------------------------------------------------------

  raycastGround(origin: THREE.Vector3, up: THREE.Vector3, maxDist: number): GroundHit {
    const out = this.gh;
    out.hit = false;
    const dx = -up.x;
    const dy = -up.y;
    const dz = -up.z;

    const f = (t: number): number => {
      const h = this.heightAt(origin.x + dx * t, origin.z + dz * t);
      if (!Number.isFinite(h)) return Number.POSITIVE_INFINITY;
      return origin.y + dy * t - h;
    };

    let t0 = 0;
    let f0 = f(0);
    if (f0 <= 0) {
      // Origin is already at/below the surface — report a contact at t=0 so the
      // caller can push out rather than seeing a miss and falling through.
      out.hit = true;
      out.distance = 0;
      out.point.set(origin.x, this.heightAt(origin.x, origin.z), origin.z);
      this.normalAt(origin.x, origin.z, out.normal);
      out.surface = this.surfaceOf(origin.x, origin.z);
      return out;
    }

    const step = 0.16;
    let t1 = 0;
    let f1 = f0;
    let found = false;
    for (let t = step; t <= maxDist + 1e-6; t += step) {
      f1 = f(t);
      t1 = t;
      if (f1 <= 0) {
        found = true;
        break;
      }
      t0 = t;
      f0 = f1;
    }
    if (!found) return out;

    for (let i = 0; i < 14; i++) {
      const tm = (t0 + t1) * 0.5;
      const fm = f(tm);
      if (fm > 0) {
        t0 = tm;
        f0 = fm;
      } else {
        t1 = tm;
        f1 = fm;
      }
    }

    const hx = origin.x + dx * t1;
    const hz = origin.z + dz * t1;
    out.hit = true;
    out.distance = t1;
    out.point.set(hx, origin.y + dy * t1, hz);
    this.normalAt(hx, hz, out.normal);
    out.surface = this.surfaceOf(hx, hz);
    return out;
  }

  collideWalls(position: THREE.Vector3, radius: number): WallHit {
    const out = this.wh;
    out.hit = false;
    out.depth = 0;
    if (this.mode === 'flat') return out;

    geoAt(position.x, position.z);
    const inset = wallInsetFor(G.region, G.cz);
    const surf = this.heightAt(position.x, position.z);
    const above = Number.isFinite(surf) ? position.y - surf : 0;

    const u = G.u;
    // Barriers are finite: clear the top and you're over them. Checked PER SIDE,
    // because one of them may be a building.
    if (u > inset - radius) {
      if (above > this.wallHeightOn(1) + 0.35) return out;
      out.hit = true;
      out.depth = radius - (inset - u);
      out.normal.set(-G.bx, 0, -G.bz);
      out.point.set(G.cx + G.bx * inset, position.y, G.cz + G.bz * inset);
    } else if (u < -inset + radius) {
      if (above > this.wallHeightOn(-1) + 0.35) return out;
      out.hit = true;
      out.depth = radius - (u + inset);
      out.normal.set(G.bx, 0, G.bz);
      out.point.set(G.cx - G.bx * inset, position.y, G.cz - G.bz * inset);
    }
    return out;
  }

  surfaceAt(position: THREE.Vector3): SurfaceType {
    return this.surfaceOf(position.x, position.z);
  }

  isOutOfBounds(position: THREE.Vector3): boolean {
    if (this.mode === 'flat') return position.y < -400;
    if (position.y < -30) return true;
    geoAt(position.x, position.z);
    return Math.abs(G.u) > OOB_LIMIT;
  }

  /**
   * Nearest centreline point. In `flat` mode this MUST answer "directly beneath
   * the kart, on an infinitely wide road": the plane has no edges, so nothing on
   * it can be a verge. Returning the oval's centreline instead (which is what
   * this did before the verge model existed) put the kart ~60 m off a road it
   * was not on, so `KartPhysics.resolveRoadFrame` saw a permanent full-overlap
   * verge and every flat-mode measurement in this file — top speed, drift
   * retention, cornering — silently collapsed. Symptom: 16 m/s top speed.
   */
  project(position: THREE.Vector3): TrackSample {
    if (this.mode === 'flat') return this.flatSample(position);
    geoAt(position.x, position.z);
    return this.fillSample(G.dist);
  }

  private flatSample(position: THREE.Vector3): TrackSample {
    const s = this.smp;
    s.position.set(position.x, this.heightAt(position.x, position.z), position.z);
    this.normalAt(position.x, position.z, s.normal);
    s.tangent.set(0, 0, -1);
    s.tangent.addScaledVector(s.normal, -s.tangent.dot(s.normal)).normalize();
    s.binormal.copy(s.tangent).cross(s.normal).normalize();
    s.halfWidth = 1e6; // an infinite plane is all road
    s.distance = 0;
    s.t = 0;
    s.curvature = 0;
    s.bank = this.flatBank;
    return s;
  }

  sampleAt(t: number): TrackSample {
    return this.sampleAtDistance(t * LAP);
  }

  sampleAtDistance(d: number): TrackSample {
    return this.fillSample(((d % LAP) + LAP) % LAP);
  }

  /** Centreline pose at arc length `d`. */
  private fillSample(d: number): TrackSample {
    const s = this.smp;
    let x: number;
    let z: number;
    if (d < STRAIGHT_LEN) {
      x = R;
      z = L - d;
    } else if (d < STRAIGHT_LEN + ARC_LEN) {
      const phi = -(d - STRAIGHT_LEN) / R;
      x = Math.cos(phi) * R;
      z = -L + Math.sin(phi) * R;
    } else if (d < 2 * STRAIGHT_LEN + ARC_LEN) {
      x = -R;
      z = -L + (d - STRAIGHT_LEN - ARC_LEN);
    } else {
      const phi = Math.PI - (d - 2 * STRAIGHT_LEN - ARC_LEN) / R;
      x = Math.cos(phi) * R;
      z = L + Math.sin(phi) * R;
    }

    geoAt(x, z);
    const h = this.heightAt(x, z);
    s.position.set(x, Number.isFinite(h) ? h : 0, z);
    this.normalAt(x, z, s.normal);

    // 3D tangent: the 2D direction of travel lifted by the local slope.
    const ahead = 0.6;
    const hA = this.heightAt(x + G.tx * ahead, z + G.tz * ahead);
    const hB = this.heightAt(x - G.tx * ahead, z - G.tz * ahead);
    const dh = Number.isFinite(hA) && Number.isFinite(hB) ? (hA - hB) / (2 * ahead) : 0;
    s.tangent.set(G.tx, dh, G.tz).normalize();
    s.binormal.copy(s.tangent).cross(s.normal).normalize();
    s.halfWidth = ROAD;
    s.distance = d;
    s.t = d / LAP;
    s.curvature = G.curvature;
    s.bank = G.bank;
    return s;
  }

  racingLineAt(t: number, lookahead: number): THREE.Vector3 {
    const s = this.sampleAtDistance(t * LAP + lookahead);
    return this.rl.copy(s.position);
  }

  getStartPosition(index: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const row = Math.floor(index / 2);
    const col = index % 2 === 0 ? -1 : 1;
    const d = 8 + row * 5.0;
    const s = this.sampleAtDistance(-d);
    this.startP.copy(s.position).addScaledVector(s.binormal, col * 4.2).addScaledVector(s.normal, 0.75);
    this.basis.makeBasis(s.binormal, s.normal, this.tmpBack(s));
    this.startQ.setFromRotationMatrix(this.basis);
    return { position: this.startP, quaternion: this.startQ };
  }

  getRespawn(t: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const s = this.sampleAtDistance(t * LAP + 6);
    this.startP.copy(s.position).addScaledVector(s.normal, 0.85);
    this.basis.makeBasis(s.binormal, s.normal, this.tmpBack(s));
    this.startQ.setFromRotationMatrix(this.basis);
    return { position: this.startP, quaternion: this.startQ };
  }

  private backScratch = new THREE.Vector3();
  private tmpBack(s: TrackSample): THREE.Vector3 {
    return this.backScratch.copy(s.tangent).multiplyScalar(-1);
  }
}

// ===========================================================================
//  KART STATE FACTORY (KartManager's job in the real game)
// ===========================================================================

export function makeKartState(id: number, isPlayer: boolean): KartState {
  return {
    id,
    isPlayer,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    groundQuaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    speed: 0,
    speedRatio: 0,
    angularVelocity: 0,
    steerAngle: 0,
    suspension: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    wheelGrounded: [false, false, false, false],
    grounded: false,
    airTime: 0,
    surface: SurfaceType.Road,
    drifting: false,
    driftStage: DriftStage.None,
    driftDirection: 0,
    driftCharge: 0,
    boostTime: 0,
    boostStrength: 0,
    hopping: false,
    stunned: false,
    stunTime: 0,
    invulnerable: false,
    starTime: 0,
    gliding: false,
    antiGravity: false,
    lap: 0,
    progress: 0,
    racePosition: id + 1,
    finished: false,
    finishTime: 0,
    lapTimes: [],
    rpm: 0,
    heldItem: null,
    itemCount: 0,
  };
}

// ===========================================================================
//  THE WORLD UNDER TEST
//  One track, one PhysicsWorld, twelve karts. Shared with the browser page so
//  that what you drive by hand and what the battery asserts are the same
//  objects.
// ===========================================================================

export const track = new TestTrack();
export const physics = new PhysicsWorld(track);

export const KART_COUNT = 12;
export const CHARS = Object.keys(CHARACTER_STATS);
export const karts: KartState[] = [];
for (let i = 0; i < KART_COUNT; i++) karts.push(makeKartState(i, i === 0));
for (let i = 0; i < KART_COUNT; i++) {
  physics.setTuning(i, makeTuning(CHARS[i % CHARS.length], 150));
}
physics.setKarts(karts);

export function resetPlayer(): void {
  const s = track.getStartPosition(0);
  physics.place(0, s.position, s.quaternion);
}

export function resetAll(): void {
  for (let i = 0; i < KART_COUNT; i++) {
    const s = track.getStartPosition(i);
    physics.place(i, s.position, s.quaternion);
  }
}
resetAll();
// ===========================================================================
//  SCRIPTED TEST BATTERY
// ===========================================================================

export interface Assertion {
  name: string;
  value: string;
  expect: string;
  pass: boolean;
}
export interface TestReport {
  assertions: Assertion[];
  notes: string[];
}

const ctxT = { dt: FIXED_DT, fixedDt: FIXED_DT, elapsed: 0, frame: 0, alpha: 0 };
const testCtx = ctxT as unknown as FrameContext;

export function stepPhysics(n: number): void {
  for (let i = 0; i < n; i++) {
    ctxT.elapsed += FIXED_DT;
    ctxT.frame++;
    physics.fixedUpdate(testCtx);
  }
}

/** Solo mode: one kart only, so nothing else perturbs a measurement. */
export function solo(): void {
  physics.setKarts([karts[0]]);
}
export function full(): void {
  physics.setKarts(karts);
  resetAll();
}

const CTRL_IDLE = { steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false };
export function ctrl(
  steer: number,
  accel: number,
  brake = 0,
  drift = false,
  driftPressed = false,
): { steer: number; accel: number; brake: number; drift: boolean; driftPressed: boolean } {
  return { steer, accel, brake, drift, driftPressed };
}

/**
 * Drop the player kart at arc length `d`, `lateral` metres off the centreline,
 * heading `degRight` degrees away from the tangent, at `speed` m/s.
 */
export function place(d: number, lateral: number, speed: number, degRight = 0): void {
  const s = track.sampleAtDistance(d);
  const pos = new THREE.Vector3().copy(s.position).addScaledVector(s.binormal, lateral);
  const up = new THREE.Vector3().copy(s.normal);
  const rad = (degRight * Math.PI) / 180;
  const fwd = new THREE.Vector3()
    .copy(s.tangent)
    .multiplyScalar(Math.cos(rad))
    .addScaledVector(s.binormal, Math.sin(rad))
    .normalize();
  const right = new THREE.Vector3().copy(fwd).cross(up).normalize();
  up.copy(right).cross(fwd).normalize();
  const back = new THREE.Vector3().copy(fwd).multiplyScalar(-1);
  const m = new THREE.Matrix4().makeBasis(right, up, back);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  pos.addScaledVector(up, 0.75);
  physics.place(0, pos, q);
  const b = physics.getBody(0)!;
  b.velocity.copy(fwd).multiplyScalar(speed);
  b.forwardSpeed = speed;
  // Let the suspension settle before anything is measured.
  physics.setControl(0, CTRL_IDLE);
  stepPhysics(10);
  b.velocity.copy(b.forward).multiplyScalar(speed);
  b.forwardSpeed = speed;
}

export function placeFlat(speed: number, bankDeg = 0): void {
  track.mode = 'flat';
  track.flatBank = (bankDeg * Math.PI) / 180;
  const b = physics.getBody(0)!;
  const up = new THREE.Vector3(Math.tan(track.flatBank), 1, 0).normalize();
  const fwd = new THREE.Vector3(0, 0, -1);
  const right = new THREE.Vector3().copy(fwd).cross(up).normalize();
  fwd.copy(up).cross(right).normalize();
  const back = new THREE.Vector3().copy(fwd).multiplyScalar(-1);
  const m = new THREE.Matrix4().makeBasis(right, up, back);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  physics.place(0, new THREE.Vector3(0, 1.0, 0), q);
  physics.setControl(0, CTRL_IDLE);
  stepPhysics(24);
  b.velocity.copy(b.forward).multiplyScalar(speed);
  b.forwardSpeed = speed;
}

// ---------------------------------------------------------------------------

function tTopSpeed(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  solo();
  const t = physics.tuningOf(0)!;

  // Pass 1 — find the actual terminal speed.
  placeFlat(0);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(120 * 14);
  const terminal = physics.getBody(0)!.forwardSpeed;

  // Pass 2 — time the climb.
  placeFlat(0);
  let t95 = -1;
  let t98 = -1;
  let t99 = -1;
  for (let i = 0; i < 120 * 12; i++) {
    physics.setControl(0, ctrl(0, 1));
    stepPhysics(1);
    const v = physics.getBody(0)!.forwardSpeed;
    const s = i * FIXED_DT;
    if (t95 < 0 && v >= terminal * 0.95) t95 = s;
    if (t98 < 0 && v >= terminal * 0.98) t98 = s;
    if (t99 < 0 && v >= terminal * 0.99) t99 = s;
  }
  notes.push(`terminal ${terminal.toFixed(2)} m/s (${(terminal * 3.6).toFixed(0)} km/h), tuning cap ${t.maxSpeed.toFixed(2)}`);
  notes.push(`t95 ${t95.toFixed(2)}s   t98 ${t98.toFixed(2)}s   t99 ${t99.toFixed(2)}s`);
  a.push({ name: '0 → top speed (98%)', value: `${t98.toFixed(2)} s`, expect: '2.5–3.5 s', pass: t98 >= 2.5 && t98 <= 3.5 });
  a.push({ name: 'top speed sane', value: `${terminal.toFixed(2)} m/s`, expect: '26–31 m/s', pass: terminal > 26 && terminal < 31 });

  // Boost must exceed the cap and bleed back.
  placeFlat(terminal * 0.98);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(60);
  physics.applyBoost(0, 1.2, 1.0, 'item');
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    stepPhysics(1);
    peak = Math.max(peak, physics.getBody(0)!.forwardSpeed);
  }
  stepPhysics(120 * 3);
  const back = physics.getBody(0)!.forwardSpeed;
  notes.push(`boost peak ${peak.toFixed(2)} m/s, settles back to ${back.toFixed(2)} m/s`);
  a.push({ name: 'boost exceeds soft cap', value: `${peak.toFixed(2)} m/s`, expect: `> ${(terminal + 4).toFixed(1)}`, pass: peak > terminal + 4 });
  a.push({ name: 'boost decays back to cap', value: `${back.toFixed(2)} m/s`, expect: `≈ ${terminal.toFixed(1)}`, pass: Math.abs(back - terminal) < 1.0 });

  track.mode = 'track';
  return { assertions: a, notes };
}

function tDrift(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  solo();
  const t = physics.tuningOf(0)!;

  // --- hop: height & air time ---------------------------------------------
  placeFlat(t.maxSpeed * 0.6);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(30);
  physics.setControl(0, ctrl(0, 1, 0, true, true));
  let air = 0;
  let peakY = -1e9;
  const y0 = physics.getBody(0)!.position.y;
  for (let i = 0; i < 200; i++) {
    stepPhysics(1);
    physics.setControl(0, ctrl(0, 1, 0, true, false));
    const b = physics.getBody(0)!;
    peakY = Math.max(peakY, b.position.y);
    if (!b.grounded) air += FIXED_DT;
    else if (air > 0) break;
  }
  notes.push(`hop air time ${air.toFixed(3)} s, rise ${(peakY - y0).toFixed(3)} m`);
  a.push({ name: 'hop air time', value: `${air.toFixed(3)} s`, expect: '0.22–0.40 s', pass: air > 0.22 && air < 0.4 });

  // --- entry → Purple ------------------------------------------------------
  placeFlat(t.maxSpeed * 0.72);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(60);
  physics.setControl(0, ctrl(1, 1, 0, true, true));
  let engaged = -1;
  let blue = -1;
  let orange = -1;
  let purple = -1;
  const entrySpeed = physics.getBody(0)!.forwardSpeed;
  for (let i = 0; i < 120 * 8; i++) {
    stepPhysics(1);
    physics.setControl(0, ctrl(1, 1, 0, true, false));
    const st = karts[0];
    const s = i * FIXED_DT;
    if (engaged < 0 && st.drifting) engaged = s;
    if (engaged >= 0) {
      if (blue < 0 && st.driftStage >= DriftStage.Blue) blue = s - engaged;
      if (orange < 0 && st.driftStage >= DriftStage.Orange) orange = s - engaged;
      if (purple < 0 && st.driftStage >= DriftStage.Purple) {
        purple = s - engaged;
        break;
      }
    }
  }
  const driftSpeed = physics.getBody(0)!.forwardSpeed;
  // NOTE: judge "does the drift hold speed" on |velocity|, NOT on forwardSpeed.
  // forwardSpeed is the component along the CHASSIS, and a 36° drift is sideways
  // by definition, so cos(36°) ≈ 0.81 of the speed is missing from that number no
  // matter how perfectly the momentum is preserved. Momentum is the thing the
  // player feels, and momentum is |velocity|.
  const driftMag = physics.getBody(0)!.velocity.length();
  notes.push(`engage at ${engaged.toFixed(2)}s after press; Blue ${blue.toFixed(2)}s  Orange ${orange.toFixed(2)}s  Purple ${purple.toFixed(2)}s`);
  notes.push(`through the drift: entry ${entrySpeed.toFixed(2)} → |v| ${driftMag.toFixed(2)} m/s (chassis-forward component ${driftSpeed.toFixed(2)})`);
  notes.push(`sustained drift angle ${((physics.getBody(0)!.driftAngle * 180) / Math.PI).toFixed(1)}°`);
  a.push({ name: 'entry → Purple', value: `${purple.toFixed(2)} s`, expect: '2.6–3.4 s', pass: purple > 2.6 && purple < 3.4 });
  a.push({ name: 'entry → Blue', value: `${blue.toFixed(2)} s`, expect: '0.5–1.0 s', pass: blue > 0.5 && blue < 1.0 });
  a.push({ name: 'drift holds speed (|v|)', value: `${((driftMag / entrySpeed) * 100).toFixed(1)} %`, expect: '> 90 %', pass: driftMag / entrySpeed > 0.9 });

  // --- release grants the boost -------------------------------------------
  let releasedTier = -1;
  let boostGiven = 0;
  const offA = bus.on('kart:driftRelease', (e) => {
    releasedTier = e.tier;
    boostGiven = e.boostTime;
  });
  physics.setControl(0, ctrl(1, 1, 0, false, false));
  stepPhysics(4);
  offA();
  notes.push(`release at Purple → tier ${releasedTier}, boost ${boostGiven.toFixed(2)}s (tuning ${t.driftBoosts[2].toFixed(2)})`);
  a.push({ name: 'purple release boost', value: `tier ${releasedTier}, ${boostGiven.toFixed(2)} s`, expect: `tier 3, ${t.driftBoosts[2].toFixed(2)} s`, pass: releasedTier === 3 && Math.abs(boostGiven - t.driftBoosts[2]) < 0.01 });

  // --- releasing before Blue gives nothing --------------------------------
  placeFlat(t.maxSpeed * 0.72);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(60);
  physics.setControl(0, ctrl(1, 1, 0, true, true));
  for (let i = 0; i < 45; i++) {
    stepPhysics(1);
    physics.setControl(0, ctrl(1, 1, 0, true, false));
  }
  let earlyTier = -1;
  let earlyBoost = -1;
  const offB = bus.on('kart:driftRelease', (e) => {
    earlyTier = e.tier;
    earlyBoost = e.boostTime;
  });
  physics.setControl(0, ctrl(1, 1, 0, false, false));
  stepPhysics(4);
  offB();
  a.push({ name: 'early release = nothing', value: `tier ${earlyTier}, ${earlyBoost.toFixed(2)} s`, expect: 'tier 0, 0 s', pass: earlyTier === 0 && earlyBoost === 0 });

  // --- steering modulates the drift angle ---------------------------------
  placeFlat(t.maxSpeed * 0.8);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(60);
  physics.setControl(0, ctrl(1, 1, 0, true, true));
  for (let i = 0; i < 120; i++) {
    stepPhysics(1);
    physics.setControl(0, ctrl(1, 1, 0, true, false));
  }
  const wide = (physics.getBody(0)!.driftAngle * 180) / Math.PI;
  for (let i = 0; i < 120; i++) {
    stepPhysics(1);
    physics.setControl(0, ctrl(-1, 1, 0, true, false));
  }
  const tight = (physics.getBody(0)!.driftAngle * 180) / Math.PI;
  notes.push(`drift angle: inward ${wide.toFixed(1)}° → counter ${tight.toFixed(1)}°`);
  a.push({ name: 'drift angle range', value: `${tight.toFixed(1)}° – ${wide.toFixed(1)}°`, expect: '≈12° – 38°', pass: tight < 20 && wide > 30 && wide - tight > 8 });

  track.mode = 'track';
  return { assertions: a, notes };
}

function tCorner(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  solo();
  const t = physics.tuningOf(0)!;

  // Yaw authority must fall off hard with speed — that is the whole of "planted
  // and predictable". Guard it so nobody can quietly re-twitch the steering.
  const yawAt = (speed: number): number => {
    placeFlat(speed);
    const b = physics.getBody(0)!;
    for (let i = 0; i < 180; i++) {
      physics.setControl(0, ctrl(1, 1));
      stepPhysics(1);
      // Pin the planar speed; leave the vertical alone or the kart lifts off its
      // springs and silently reads the AIRBORNE yaw branch instead.
      const vUp = b.velocity.dot(b.up);
      b.velocity.copy(b.forward).multiplyScalar(speed).addScaledVector(b.up, vUp);
      b.forwardSpeed = speed;
    }
    return b.grounded ? Math.abs(b.yawRate) : NaN;
  };
  const yaw5 = yawAt(5);
  const yaw25 = yawAt(25);
  const yaw38 = yawAt(38);
  notes.push(`full-lock yaw: 5 m/s ${yaw5.toFixed(2)}  25 m/s ${yaw25.toFixed(2)}  38 m/s ${yaw38.toFixed(2)} rad/s`);
  notes.push(`...lateral demand: ${((5 * yaw5) / 9.81).toFixed(2)} g / ${((25 * yaw25) / 9.81).toFixed(2)} g / ${((38 * yaw38) / 9.81).toFixed(2)} g (budget ${(PHYS.latAccel / 9.81).toFixed(1)} g)`);
  a.push({ name: 'low-speed agility survives', value: `${yaw5.toFixed(2)} rad/s at 5 m/s`, expect: '> 2.0', pass: yaw5 > 2.0 });
  a.push({ name: 'authority falls off with speed', value: `${yaw25.toFixed(2)} @25, ${yaw38.toFixed(2)} @38`, expect: '< 1.30 and < 1.00', pass: yaw25 < 1.3 && yaw38 < 1.0 });
  a.push({ name: 'yaw stays inside the grip budget', value: `${((38 * yaw38) / 9.81).toFixed(2)} g at 38 m/s`, expect: `< ${(PHYS.latAccel / 9.81).toFixed(1)} g`, pass: 38 * yaw38 < PHYS.latAccel });

  const run = (drifting: boolean): { loss: number; time: number; v0: number; v1: number; mloss: number } => {
    placeFlat(t.maxSpeed * 0.98);
    physics.setControl(0, ctrl(0, 1));
    stepPhysics(90);
    const b = physics.getBody(0)!;
    const h0 = new THREE.Vector3().copy(b.forward);
    if (drifting) {
      physics.setControl(0, ctrl(1, 1, 0, true, true));
      stepPhysics(1);
      // Let the hop land and the drift engage before starting the clock.
      for (let i = 0; i < 90; i++) {
        physics.setControl(0, ctrl(1, 1, 0, true, false));
        stepPhysics(1);
        if (karts[0].drifting) break;
      }
    }
    const v0 = physics.getBody(0)!.velocity.length();
    const f0 = physics.getBody(0)!.forwardSpeed;
    h0.copy(physics.getBody(0)!.forward);
    let steps = 0;
    for (let i = 0; i < 120 * 8; i++) {
      physics.setControl(0, ctrl(1, 1, 0, drifting, false));
      stepPhysics(1);
      steps++;
      const dot = clamp(h0.dot(physics.getBody(0)!.forward), -1, 1);
      if (Math.acos(dot) >= Math.PI / 2) break;
    }
    const v1 = physics.getBody(0)!.velocity.length();
    return {
      loss: 1 - v1 / v0,
      mloss: 1 - physics.getBody(0)!.forwardSpeed / f0,
      time: steps * FIXED_DT,
      v0,
      v1,
    };
  };

  const d = run(true);
  const g = run(false);
  // Again: |v|, not forwardSpeed. See the note in tDrift.
  notes.push(`drifted 90°: |v| ${d.v0.toFixed(2)} → ${d.v1.toFixed(2)} m/s in ${d.time.toFixed(2)}s (${(d.loss * 100).toFixed(1)}% lost; chassis-forward component fell ${(d.mloss * 100).toFixed(1)}% because the kart is 36° sideways)`);
  notes.push(`gripping 90°: |v| ${g.v0.toFixed(2)} → ${g.v1.toFixed(2)} m/s in ${g.time.toFixed(2)}s (${(g.loss * 100).toFixed(1)}% lost)`);
  a.push({ name: '90° drifted corner loss (|v|)', value: `${(d.loss * 100).toFixed(1)} %`, expect: '< 12 %', pass: d.loss < 0.12 });
  a.push({ name: 'drifting turns faster than gripping', value: `${d.time.toFixed(2)}s vs ${g.time.toFixed(2)}s`, expect: 'drift ≤ grip', pass: d.time <= g.time + 0.02 });

  track.mode = 'track';
  return { assertions: a, notes };
}

function tWall(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  solo();

  const hitAt = (deg: number): { before: number; after: number; min: number; penalties: number } => {
    // Flat part of the ramp straight, well before the ramp, aimed at the
    // outer guardrail. lateral −2 gives ~13 m of run-up to the wall.
    place(4, -2, 25, deg);
    const b0 = physics.getBody(0)!;
    const pen0 = b0.wallImpacts;
    let before = 0;
    let after = -1;
    let min = 1e9;
    let hitStep = -1;
    let prev = 25;
    // 480 ticks, not 240: from lateral −2 a 10° line needs 54 m of run-up to
    // reach the guardrail, which is 2.2 s at 25 m/s. The old budget expired
    // first, so the "graze" sub-test was silently measuring a kart that had
    // never touched anything.
    for (let i = 0; i < 480; i++) {
      physics.setControl(0, ctrl(0, 1));
      const b = physics.getBody(0)!;
      if (hitStep < 0) prev = b.velocity.length();
      stepPhysics(1);
      // Drive off the PENALTY, not off the VFX event — the event is cooldown-
      // gated and a light graze deliberately doesn't raise one at all.
      if (hitStep < 0 && b.wallImpacts > pen0) {
        before = prev;
        after = b.velocity.length(); // the impact tick itself: the true cost
        hitStep = 1;
      } else if (hitStep > 0) {
        hitStep++;
        min = Math.min(min, physics.getBody(0)!.velocity.length());
        if (hitStep > 40) break;
      }
    }
    return { before, after, min, penalties: physics.getBody(0)!.wallImpacts - pen0 };
  };

  const loss = (r: { before: number; after: number }) => (r.before - r.after) / r.before;

  const r30 = hitAt(30);
  notes.push(`30° wall hit: ${r30.before.toFixed(2)} → ${r30.after.toFixed(2)} m/s on the impact tick (min over the next 0.33 s ${r30.min.toFixed(2)}), loss ${(loss(r30) * 100).toFixed(1)}%`);
  a.push({ name: '30° wall scrub', value: `${(loss(r30) * 100).toFixed(1)} %`, expect: '6–20 %', pass: loss(r30) > 0.06 && loss(r30) < 0.2 });
  a.push({ name: '30° wall does NOT stop the kart', value: `min ${r30.min.toFixed(2)} m/s`, expect: '> 40 % of entry', pass: r30.min > r30.before * 0.4 });

  const r10 = hitAt(10);
  notes.push(`10° graze:    ${r10.before.toFixed(2)} → ${r10.after.toFixed(2)} m/s, loss ${(loss(r10) * 100).toFixed(1)}%`);
  a.push({ name: '10° graze is nearly free', value: `${(loss(r10) * 100).toFixed(1)} %`, expect: '< 8 %', pass: loss(r10) < 0.08 });

  const r60 = hitAt(60);
  notes.push(`60° clout:    ${r60.before.toFixed(2)} → ${r60.after.toFixed(2)} m/s, loss ${(loss(r60) * 100).toFixed(1)}%, min ${r60.min.toFixed(2)}`);
  a.push({ name: '60° hit keeps half its speed', value: `${((1 - loss(r60)) * 100).toFixed(1)} % retained`, expect: '45–70 %', pass: 1 - loss(r60) > 0.45 && 1 - loss(r60) < 0.7 });
  a.push({ name: 'steeper hit costs more', value: `${(loss(r10) * 100).toFixed(0)} < ${(loss(r30) * 100).toFixed(0)} < ${(loss(r60) * 100).toFixed(0)} %`, expect: 'monotonic', pass: loss(r10) < loss(r30) && loss(r30) < loss(r60) });
  a.push({ name: 'one penalty per impact', value: `${r30.penalties} / ${r10.penalties} / ${r60.penalties}`, expect: '≤ 3 each', pass: r30.penalties <= 3 && r10.penalties <= 3 && r60.penalties <= 3 });

  // --- THE REGRESSION THAT MATTERED: grinding a wall must not be a crash ----
  // At 120 Hz a kart merely leaning on a barrier used to take ~240 impact
  // penalties a second; 3 s of it cost 99.9 % of the kart's speed. Anything that
  // reintroduces a per-tick penalty will fail here and nowhere else.
  const grind = (withWall: boolean): { v: number; contact: number; penalties: number } => {
    // With the wall: start beside the tight guardrail and lean gently into it.
    // Without: straight down the middle, steer 0 — the control run must not touch
    // a barrier at all, so it cannot steer (0.35 of lock puts it in the OTHER
    // guardrail inside three seconds, which made the first version of this
    // control run just as dead as the case it was supposed to baseline).
    place(4, withWall ? -(WALL_TIGHT - 1.0) : 0, 18, 0);
    const b = physics.getBody(0)!;
    const pen0 = b.wallImpacts;
    let contact = 0;
    for (let i = 0; i < 120 * 3; i++) {
      physics.setControl(0, ctrl(withWall ? -0.35 : 0, 1));
      stepPhysics(1);
      if (b.wallContact) contact++;
    }
    return { v: b.velocity.length(), contact, penalties: b.wallImpacts - pen0 };
  };
  const gw = grind(true);
  const gf = grind(false);
  notes.push(`3 s leaning on the guardrail at 18 m/s entry: |v| ${gw.v.toFixed(2)} m/s vs ${gf.v.toFixed(2)} free (cost ${(((gf.v - gw.v) / gf.v) * 100).toFixed(1)}%), ${gw.contact}/360 contact ticks, ${gw.penalties} penalties`);
  a.push({ name: 'grinding a wall is not a crash', value: `${gw.v.toFixed(2)} of ${gf.v.toFixed(2)} m/s`, expect: '> 60 % of free speed', pass: gw.v > gf.v * 0.6 });
  a.push({ name: 'a grind is not re-penalised per tick', value: `${gw.penalties} penalties over ${gw.contact} contact ticks`, expect: '< 15', pass: gw.penalties < 15 });

  return { assertions: a, notes };
}

function tTunnel(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  solo();

  // 40 m/s over the ramp: a fixed step is 0.33 m of travel and the kicker has a
  // slope discontinuity, which is exactly where a naive integrator falls through.
  place(0, 0, 40);
  physics.applyBoost(0, 8, 1.6, 'item');
  let minClear = 1e9;
  let maxJump = 0;
  let below = 0;
  let airborneSteps = 0;
  const prev = new THREE.Vector3();
  const b = physics.getBody(0)!;
  prev.copy(b.position);
  for (let i = 0; i < 120 * 6; i++) {
    physics.setControl(0, ctrl(0, 1));
    stepPhysics(1);
    const p = b.position;
    const h = track.heightAt(p.x, p.z);
    const jump = p.distanceTo(prev);
    prev.copy(p);
    if (jump > maxJump) maxJump = jump;
    if (Number.isFinite(h)) {
      const clear = p.y - h;
      if (b.grounded) minClear = Math.min(minClear, clear);
      if (clear < -0.02) below++;
    }
    if (!b.grounded) airborneSteps++;
  }
  notes.push(`min grounded clearance ${minClear.toFixed(3)} m (CoM above surface), steps below surface ${below}`);
  notes.push(`max per-step displacement ${maxJump.toFixed(3)} m at 40 m/s (expected ≈ 0.33 m), airborne ${(airborneSteps * FIXED_DT).toFixed(2)}s of 6.00s`);
  a.push({ name: 'no ground tunnelling at 40 m/s', value: `${below} steps below surface`, expect: '0', pass: below === 0 });
  a.push({ name: 'minimum ride height held', value: `${minClear.toFixed(3)} m`, expect: '> 0.28 m', pass: minClear > 0.28 });

  // Trick + landing boost off the same ramp.
  place(0, 0, 26);
  let tricked = '';
  let trickBoost = 0;
  const off1 = bus.on('kart:trick', (e) => {
    tricked = e.name;
  });
  const off2 = bus.on('kart:boost', (e) => {
    if (e.source === 'trick') trickBoost = e.duration;
  });
  for (let i = 0; i < 120 * 5; i++) {
    physics.setControl(0, ctrl(0, 1, 0, true, i === 0));
    stepPhysics(1);
  }
  off1();
  off2();
  notes.push(`ramp trick: "${tricked || 'none'}", landing boost ${trickBoost.toFixed(2)}s`);
  a.push({ name: 'ramp trick + landing boost', value: `${tricked || 'none'} / ${trickBoost.toFixed(2)} s`, expect: 'named trick, > 0 s', pass: tricked !== '' && trickBoost > 0 });

  return { assertions: a, notes };
}

function tBank(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  solo();

  placeFlat(0, 25);
  physics.setControl(0, ctrl(0, 0));
  stepPhysics(120 * 2);
  const b = physics.getBody(0)!;
  let minH = 1e9;
  let maxH = -1e9;
  let maxStepDelta = 0;
  let allGrounded = true;
  let lastH = 0;
  let maxRollVel = 0;
  for (let i = 0; i < 120 * 3; i++) {
    stepPhysics(1);
    const h = b.position.y - track.heightAt(b.position.x, b.position.z);
    if (i > 0) maxStepDelta = Math.max(maxStepDelta, Math.abs(h - lastH));
    lastH = h;
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
    maxRollVel = Math.max(maxRollVel, Math.abs(b.rollVel));
    for (let w = 0; w < 4; w++) if (!b.wheels[w].grounded) allGrounded = false;
  }
  const slide = Math.abs(b.lateralSpeed);
  notes.push(`25° bank at rest: ride height ${minH.toFixed(4)}–${maxH.toFixed(4)} m (band ${(maxH - minH).toFixed(4)} m), max per-step change ${maxStepDelta.toFixed(5)} m`);
  notes.push(`roll ${((b.roll * 180) / Math.PI).toFixed(2)}°, peak |rollVel| ${maxRollVel.toFixed(3)} rad/s, lateral creep ${slide.toFixed(3)} m/s`);
  a.push({ name: 'banked 25°: no jitter', value: `band ${((maxH - minH) * 1000).toFixed(2)} mm`, expect: '< 10 mm', pass: maxH - minH < 0.01 });
  a.push({ name: 'banked 25°: all wheels planted', value: allGrounded ? 'yes' : 'no', expect: 'yes', pass: allGrounded });
  a.push({ name: 'banked 25°: does not slither', value: `${slide.toFixed(3)} m/s`, expect: '< 1.0 m/s', pass: slide < 1.0 });

  // ...and stable while driving across it.
  placeFlat(22, 25);
  let maxDelta2 = 0;
  let last2 = b.position.y - track.heightAt(b.position.x, b.position.z);
  for (let i = 0; i < 120 * 3; i++) {
    physics.setControl(0, ctrl(0, 1));
    stepPhysics(1);
    const h = b.position.y - track.heightAt(b.position.x, b.position.z);
    maxDelta2 = Math.max(maxDelta2, Math.abs(h - last2));
    last2 = h;
  }
  notes.push(`driving a 25° bank at 22 m/s: max per-step ride-height change ${maxDelta2.toFixed(4)} m`);
  a.push({ name: 'banked 25° under power: stable', value: `${(maxDelta2 * 1000).toFixed(1)} mm/step`, expect: '< 25 mm', pass: maxDelta2 < 0.025 });

  track.mode = 'track';
  track.flatBank = 0;
  return { assertions: a, notes };
}

function tFuzz(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  full();
  const rng = new Rng(0xc0ffee);
  const steps = 120 * 60; // 60 s
  let bad = 0;
  let checks = 0;
  let respawns = 0;
  const off = bus.on('kart:respawn', () => respawns++);

  physics.resetPerf();
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    if (i % 30 === 0) {
      for (let k = 0; k < KART_COUNT; k++) {
        physics.setControl(k, {
          steer: rng.range(-1, 1),
          accel: rng.next() > 0.15 ? 1 : 0,
          brake: rng.next() > 0.85 ? 1 : 0,
          drift: rng.next() > 0.45,
          driftPressed: rng.next() > 0.7,
        });
      }
      if (rng.next() > 0.9) physics.applyBoost(rng.int(0, KART_COUNT - 1), 1, 1, 'item');
      if (rng.next() > 0.93) {
        const kinds = ['spin', 'squash', 'flip', 'shock'] as const;
        physics.applyStun(rng.int(0, KART_COUNT - 1), 1.2, rng.pick(kinds));
      }
      if (rng.next() > 0.96) {
        const im = new THREE.Vector3(rng.range(-1, 1), rng.range(0, 1), rng.range(-1, 1)).multiplyScalar(4000);
        physics.applyImpulse(rng.int(0, KART_COUNT - 1), im);
      }
    }
    physics.fixedUpdate(testCtx);
    ctxT.elapsed += FIXED_DT;
    if (i % 20 === 0) {
      for (let k = 0; k < KART_COUNT; k++) {
        const st = karts[k];
        checks++;
        if (
          !Number.isFinite(st.position.x) || !Number.isFinite(st.position.y) || !Number.isFinite(st.position.z) ||
          !Number.isFinite(st.velocity.x) || !Number.isFinite(st.velocity.y) || !Number.isFinite(st.velocity.z) ||
          !Number.isFinite(st.speed) || !Number.isFinite(st.quaternion.x) || !Number.isFinite(st.quaternion.w) ||
          !Number.isFinite(st.angularVelocity) || !Number.isFinite(st.suspension[0])
        ) {
          bad++;
        }
      }
    }
  }
  const wall = performance.now() - t0;
  off();
  notes.push(`60 s × 12 karts of random input: ${checks} state samples, ${bad} non-finite, ${respawns} respawns`);
  notes.push(`wall clock ${wall.toFixed(0)} ms for ${steps} steps → ${(wall / steps).toFixed(3)} ms per fixed step (12 karts)`);
  notes.push(`internal EMA ${physics.stepMs.toFixed(3)} ms/step, peak ${physics.stepMsPeak.toFixed(3)} ms`);
  a.push({ name: 'no NaN after 60 s fuzz', value: `${bad} of ${checks}`, expect: '0', pass: bad === 0 });
  a.push({ name: 'fixed step budget (12 karts)', value: `${(wall / steps).toFixed(3)} ms`, expect: '< 1.5 ms', pass: wall / steps < 1.5 });

  return { assertions: a, notes };
}

function tMisc(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  solo();
  const t = physics.tuningOf(0)!;

  // --- off-road slowdown ---------------------------------------------------
  // Apron straight, out on the grass.
  place(2 * STRAIGHT_LEN + ARC_LEN + 55, 15, 22);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(120 * 4);
  const grassSpeed = physics.getBody(0)!.forwardSpeed;
  const grassSurf = karts[0].surface;
  notes.push(`grass: settles at ${grassSpeed.toFixed(2)} m/s (surface id ${grassSurf}, road cap ${t.maxSpeed.toFixed(1)})`);
  a.push({ name: 'off-road slows you', value: `${grassSpeed.toFixed(2)} m/s`, expect: `< ${(t.maxSpeed * 0.72).toFixed(1)}`, pass: grassSpeed < t.maxSpeed * 0.72 && grassSurf === SurfaceType.Grass });

  // --- boost is immune to off-road for 0.4 s ------------------------------
  place(2 * STRAIGHT_LEN + ARC_LEN + 55, 15, 22);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(120 * 3);
  const beforeB = physics.getBody(0)!.forwardSpeed;
  physics.applyBoost(0, 1.2, 1, 'drift');
  stepPhysics(36); // 0.3 s — still inside the immunity window
  const duringB = physics.getBody(0)!.forwardSpeed;
  notes.push(`boost on grass: ${beforeB.toFixed(2)} → ${duringB.toFixed(2)} m/s in 0.3 s`);
  a.push({ name: 'boost ignores off-road briefly', value: `+${(duringB - beforeB).toFixed(2)} m/s`, expect: '> +5 m/s', pass: duringB - beforeB > 5 });

  // --- reverse from a standstill ------------------------------------------
  placeFlat(0);
  for (let i = 0; i < 120 * 3; i++) {
    physics.setControl(0, ctrl(0, 0, 1));
    stepPhysics(1);
  }
  const rev = physics.getBody(0)!.forwardSpeed;
  notes.push(`reverse settles at ${rev.toFixed(2)} m/s (cap ${(-t.maxReverseSpeed).toFixed(2)})`);
  a.push({ name: 'reverse from standstill', value: `${rev.toFixed(2)} m/s`, expect: '−4 … −12 m/s', pass: rev < -4 && rev > -12 });
  track.mode = 'track';

  // --- spin-out kills speed and rotates twice ----------------------------
  place(4, 0, 25);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(24);
  const b = physics.getBody(0)!;
  const preSpin = b.forwardSpeed;
  const fwd0 = new THREE.Vector3().copy(b.forward);
  physics.applyStun(0, 1.1, 'spin');
  let turned = 0;
  const prevF = new THREE.Vector3().copy(b.forward);
  for (let i = 0; i < 132; i++) {
    stepPhysics(1);
    turned += prevF.angleTo(b.forward);
    prevF.copy(b.forward);
  }
  const postSpin = b.forwardSpeed;
  notes.push(`spin-out: ${preSpin.toFixed(2)} → ${postSpin.toFixed(2)} m/s, rotated ${(turned / (Math.PI * 2)).toFixed(2)} turns in 1.1 s`);
  a.push({ name: 'spin stun loses all speed', value: `${postSpin.toFixed(2)} m/s`, expect: '< 2 m/s', pass: Math.abs(postSpin) < 2 });
  a.push({ name: 'spin = 2 rotations', value: `${(turned / (Math.PI * 2)).toFixed(2)} turns`, expect: '1.7–2.3', pass: turned / (Math.PI * 2) > 1.7 && turned / (Math.PI * 2) < 2.3 });
  void fwd0;

  // --- respawn on falling out of bounds ----------------------------------
  place(2 * STRAIGHT_LEN + ARC_LEN + 55, 0, 10);
  const bb = physics.getBody(0)!;
  bb.position.set(0, 8, 0); // dead centre of the infield → out of bounds
  let didRespawn = false;
  const off = bus.on('kart:respawn', () => (didRespawn = true));
  stepPhysics(200);
  off();
  const backOnTrack = track.project(bb.position);
  const offset = Math.abs(G.u);
  notes.push(`out-of-bounds respawn fired: ${didRespawn}; ended ${offset.toFixed(2)} m off the centreline at ${bb.forwardSpeed.toFixed(2)} m/s`);
  a.push({ name: 'out of bounds → respawn', value: `${didRespawn}, |u| ${offset.toFixed(2)} m`, expect: 'true, < 11 m', pass: didRespawn && offset < ROAD });
  a.push({ name: 'respawn at ~40 % speed', value: `${bb.forwardSpeed.toFixed(2)} m/s`, expect: `≈ ${(t.maxSpeed * 0.4).toFixed(1)}`, pass: bb.forwardSpeed > 4 });
  void backOnTrack;

  // --- anti-gravity arc ---------------------------------------------------
  // THIS WAS A TEST BUG, NOT A GAME BUG — recording the arithmetic so nobody
  // "fixes" the physics to satisfy it again. `surfaceOf()` returns
  // `AntiGravity` only on `Region.ArcB`, and `geoAt()` gives Arc B the arc
  // length range [2·STRAIGHT_LEN + ARC_LEN, 2·STRAIGHT_LEN + 2·ARC_LEN]
  // = [408.5 m, 597.0 m], so its midpoint is 502.7 m.
  //
  // There used to be two `place()` calls here. The first computed
  //   2·SL + AL + SL·0 + 2·SL + AL·0.5 − 2·SL  =  2·SL + 1.5·AL  =  502.7 m
  // which is exactly right. The second then overwrote it with
  //   2·SL + AL + SL + AL·0.5              =  3·SL + 1.5·AL  =  612.7 m
  // and LAP is 597.0 m, so that **wrapped to 15.8 m** — the ramp straight, a
  // whole region away from the anti-gravity arc. The test then stepped 60 ticks
  // (0.5 s ≈ 12 m at 24 m/s) and asserted on `antiGravity`, which of course
  // read false. Anti-gravity was engaging the entire time; the kart was simply
  // never put anywhere near it.
  place(2 * STRAIGHT_LEN + ARC_LEN * 1.5, 0, 24);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(60);
  const agOn = karts[0].antiGravity;
  const agGrounded = karts[0].grounded;
  notes.push(`anti-gravity arc: flag ${agOn}, grounded ${agGrounded}, speed ${physics.getBody(0)!.forwardSpeed.toFixed(2)} m/s`);
  a.push({ name: 'anti-gravity engages + sticks', value: `${agOn} / grounded ${agGrounded}`, expect: 'true / true', pass: agOn && agGrounded });

  // --- heavier kart wins the shove ---------------------------------------
  physics.setKarts([karts[0], karts[1]]);
  physics.setTuning(0, makeTuning('torque', 150)); // 280 kg
  physics.setTuning(1, makeTuning('pip', 150)); // 148 kg
  const heavy = physics.getBody(0)!;
  const light = physics.getBody(1)!;
  const s0 = track.sampleAtDistance(6);
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4().makeBasis(
    s0.binormal,
    s0.normal,
    new THREE.Vector3().copy(s0.tangent).multiplyScalar(-1),
  );
  q.setFromRotationMatrix(m);
  physics.place(0, new THREE.Vector3().copy(s0.position).addScaledVector(s0.normal, 0.8), q);
  physics.place(
    1,
    new THREE.Vector3().copy(s0.position).addScaledVector(s0.normal, 0.8).addScaledVector(s0.binormal, 1.2),
    q,
  );
  heavy.velocity.copy(heavy.right).multiplyScalar(6);
  light.velocity.set(0, 0, 0);
  stepPhysics(20);
  const heavyPush = heavy.velocity.dot(s0.binormal);
  const lightPush = light.velocity.dot(s0.binormal);
  notes.push(`shove: 280 kg kart retains ${heavyPush.toFixed(2)} m/s, 148 kg kart flung to ${lightPush.toFixed(2)} m/s`);
  a.push({ name: 'heavier kart shoves lighter', value: `${lightPush.toFixed(2)} vs ${heavyPush.toFixed(2)} m/s`, expect: 'light > heavy', pass: lightPush > heavyPush });

  physics.setTuning(0, makeTuning(CHARS[0], 150));
  physics.setTuning(1, makeTuning(CHARS[1], 150));
  return { assertions: a, notes };
}

// ---------------------------------------------------------------------------

export interface FullReport {
  groups: Array<{ name: string; report: TestReport }>;
  passed: number;
  failed: number;
}

/**
 * Hooks so the browser page can quiesce itself (stop the render loop, pause its
 * own control feed) around a run without this module knowing that a page
 * exists. Headless callers pass nothing.
 */
export interface RunHooks {
  before?: () => void;
  after?: () => void;
}

export function runAll(hooks: RunHooks = {}): FullReport {
  hooks.before?.();

  const groups: Array<{ name: string; report: TestReport }> = [
    { name: 'ACCELERATION & BOOST', report: tTopSpeed() },
    { name: 'DRIFT & MINI-TURBO', report: tDrift() },
    { name: 'CORNERING', report: tCorner() },
    { name: 'WALLS', report: tWall() },
    { name: 'RAMPS / TUNNELLING / TRICKS', report: tTunnel() },
    { name: 'BANKED SURFACE STABILITY', report: tBank() },
    { name: 'SURFACES, STUNS, RESPAWN, MASS', report: tMisc() },
    { name: 'FUZZ + PERF', report: tFuzz() },
  ];

  let passed = 0;
  let failed = 0;
  for (const g of groups) {
    for (const x of g.report.assertions) x.pass ? passed++ : failed++;
  }

  track.mode = 'track';
  track.flatBank = 0;
  full();
  hooks.after?.();
  return { groups, passed, failed };
}

/**
 * Plain-text report — the headless entry point's output.
 *
 * The strip pattern is anchored to the two tags `formatReport` actually emits.
 * A generic `/<[^>]+>/g` is WRONG here and produced a silently mislabelled
 * report: half the `expect` strings begin with `<` (e.g. `"< 20.7"`), and
 * `[^>]+` happily runs across the newline to the `>` of the NEXT line's
 * `<span class="pass">`, deleting the expectation, the line break and the
 * following assertion's PASS/FAIL tag. Every verdict after such a line was
 * shifted up by one, so the text report disagreed with `runAll()`'s own counts.
 */
export function reportText(hooks: RunHooks = {}): string {
  return formatReport(runAll(hooks))
    .replace(/<\/?(?:b|span)(?:\s[^>\n]*)?>/g, '')
    .trim();
}

export function formatReport(r: FullReport): string {
  let out = `APEX KART — PHYSICS ASSERTIONS   ${r.passed} passed / ${r.failed} failed\n`;
  out += '─'.repeat(84) + '\n';
  for (const g of r.groups) {
    out += `\n<b>${g.name}</b>\n`;
    for (const a of g.report.assertions) {
      const tag = a.pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>';
      out += `  ${tag}  ${a.name.padEnd(38)} ${a.value.padEnd(22)} expect ${a.expect}\n`;
    }
    for (const n of g.report.notes) out += `        · ${n}\n`;
  }
  return out;
}
