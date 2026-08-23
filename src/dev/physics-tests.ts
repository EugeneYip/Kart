/**
 * ============================================================================
 *  FOXY KART — PHYSICS TEST BATTERY  (dev harness, not shipped)
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
import { DriftPhase, PHYS } from '@/physics/KartPhysics';
import { COLL } from '@/physics/KartCollision';
import { DRIFT } from '@/physics/DriftSystem';
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
    // The lap runs ramp straight [0, SL] → arc A [SL, SL+AL] → apron straight
    // [SL+AL, 2·SL+AL] → arc B [2·SL+AL, LAP], which is exactly how
    // `fillSample()` inverts it. This read `2 * STRAIGHT_LEN` and so put the
    // apron straight at [408.5, 518.5] — 110 m too far along, and squarely on top
    // of arc B's range. `project()` returns `fillSample(G.dist)`, so every kart on
    // the apron straight was handed a road frame from the far side of arc B: at
    // z = 0 it got a centreline point 138 m away, banked 25° instead of flat.
    G.dist = side > 0 ? L - z : STRAIGHT_LEN + ARC_LEN + (z + L);
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

  /**
   * Is the query clear of the barrier vertically — over its top, or below its
   * foot? `Track.collideWalls` answers this with `vert` measured in the road
   * frame against `base = surfaceHeight(side * wallLat, ...)`: the surface height
   * AT THE WALL FACE, which the spline defines everywhere. This must do the same.
   *
   * It used to sample `heightAt(position.x, position.z)` — under the QUERY — and
   * substitute `0` when that came back NaN. Over the void, that reads as "level
   * with the barrier's foot", so a kart 80 m off the track at y = 8 was reported
   * as buried `radius + 67.3` m INSIDE the guardrail. `resolveWalls` then pushed
   * it out by that residual and the kart was back on the kerb in a single step —
   * before `checkBounds` (step 5) ever ran (step 4). That, and not the projection
   * or the respawn code, is why "out of bounds → respawn" never fired: nothing
   * was ever out of bounds by the time the bounds test looked.
   *
   * The barrier's foot is always on defined ground (`inset` < `GRASS_LIMIT`), so
   * there is no NaN case left to paper over.
   */
  private overBarrier(position: THREE.Vector3, inset: number, side: -1 | 1): boolean {
    const base = this.heightAt(G.cx + G.bx * inset * side, G.cz + G.bz * inset * side);
    const above = position.y - base;
    // Matches Track.collideWalls' `vert < base - 0.55 || vert > top + 0.7` gate.
    return above < -0.55 || above > this.wallHeightOn(side) + 0.35;
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

    // The bracket search MUST evaluate `maxDist` itself, hence the clamp and the
    // exit test at the bottom rather than in the `for` header. Marching
    // `t += step` while `t <= maxDist` only ever samples multiples of `step`, so
    // the final partial step is never looked at: with step 0.16 against the
    // suspension's ray (`rayLift + rest + wheelRadius` = 1.228 m) the last sample
    // landed at 1.120 m and ground between 1.120 and 1.228 m was INVISIBLE.
    //
    // That blind band is exactly where a kart parked on the 25° bank sits: the
    // measured wheel distance there is 1.1176–1.1217 m, straddling 1.120, so each
    // wheel reported `hit: false` on roughly half of all ticks and
    // "banked 25°: all wheels planted" read `no` for a kart that had not moved
    // 3.5 mm in three seconds. The bisection below was never at fault.
    const step = 0.16;
    let t1 = 0;
    let f1 = f0;
    let found = false;
    for (let t = step; ; t += step) {
      const tc = t < maxDist ? t : maxDist;
      f1 = f(tc);
      t1 = tc;
      if (f1 <= 0) {
        found = true;
        break;
      }
      if (tc >= maxDist) break;
      t0 = tc;
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

    const u = G.u;
    // Barriers are finite: clear the top and you're over them. Checked PER SIDE,
    // because one of them may be a building.
    if (u > inset - radius) {
      if (this.overBarrier(position, inset, 1)) return out;
      out.hit = true;
      out.depth = radius - (inset - u);
      out.normal.set(-G.bx, 0, -G.bz);
      out.point.set(G.cx + G.bx * inset, position.y, G.cz + G.bz * inset);
    } else if (u < -inset + radius) {
      if (this.overBarrier(position, inset, -1)) return out;
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

/**
 * Bench self-check. Not a claim about the kart — a claim about `TestTrack`.
 *
 * Every measurement in this file is taken through `ITrackService`, so a defect
 * in the analytic track reads as a physics result. Three have already cost real
 * time: `project()` returning the oval's centreline in `flat` mode (16 m/s top
 * speed), the anti-gravity arc-length arithmetic wrapping past `LAP`, and
 * `geoAt()` putting the apron straight 110 m too far along the lap — which
 * handed every kart on that straight a road frame from the far side of arc B,
 * banked 25° where the road is flat. None of the three was caught by anything,
 * because a wrong road frame produces plausible-looking numbers.
 *
 * These two assertions are the cheap invariants that catch that whole class.
 */
function tTrack(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  const p = new THREE.Vector3();
  const off = new THREE.Vector3();

  // 1 — the forward map (`fillSample`: arc length → pose) and the inverse map
  // (`geoAt`: position → arc length) must be the same parameterisation.
  let worstD = 0;
  let worstAt = 0;
  for (let d = 0; d < LAP; d += 1.0) {
    const s = track.sampleAtDistance(d);
    geoAt(s.position.x, s.position.z);
    // Wrapped difference: d and G.dist are both in [0, LAP).
    let err = Math.abs(G.dist - d);
    if (err > LAP / 2) err = LAP - err;
    if (err > worstD) {
      worstD = err;
      worstAt = d;
    }
  }
  notes.push(`lap parameterisation: worst |geoAt(sampleAtDistance(d)) − d| = ${worstD.toFixed(3)} m at d = ${worstAt.toFixed(0)} m`);
  a.push({ name: 'lap arc length is invertible', value: `${worstD.toFixed(3)} m`, expect: '< 0.5 m', pass: worstD < 0.5 });

  // 2 — `project()` must return the NEAREST centreline point, i.e. the offset
  // from the kart to it must be perpendicular to the direction of travel. This
  // is what `resolveRoadFrame` assumes when it reads `roadLat` and `vergeAmount`.
  let worstT = 0;
  let worstTAt = 0;
  for (let d = 0; d < LAP; d += 2.0) {
    const c = track.sampleAtDistance(d);
    for (const lat of [-8, 0, 8]) {
      p.copy(c.position).addScaledVector(c.binormal, lat);
      const s = track.project(p);
      const along = Math.abs(off.copy(p).sub(s.position).dot(s.tangent));
      if (along > worstT) {
        worstT = along;
        worstTAt = d;
      }
    }
  }
  notes.push(`projection: worst along-track residual = ${worstT.toFixed(3)} m at d = ${worstTAt.toFixed(0)} m (a nearest-point solve has none)`);
  a.push({ name: 'project() returns the nearest point', value: `${worstT.toFixed(3)} m`, expect: '< 0.6 m', pass: worstT < 0.6 });

  return { assertions: a, notes };
}

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

  // --- the hop is a hop, NOT a trick --------------------------------------
  // Regression for the defect that `hopSpeed` 4.6 exposed: the hop finally left
  // the ground, and `DriftSystem.tricks()` classified it as a ramp launch, so
  // every drift hop flipped the chassis ~90° and collected a trick boost. The
  // guard meant to prevent that read `hopTime`, which the drift state machine has
  // already zeroed by then (`hopMinAir` is 0.02 s) — see `KartBody.hopLaunch`.
  //
  // These assert the PLAYER-VISIBLE consequences — no trick event, no trick
  // boost — not the internal flag, because the flag is what was wrong before.
  const hopRun = (
    steer: number,
    breakTheGuard: boolean,
  ): { air: number; trick: string; boost: number; committedOnPress: boolean } => {
    placeFlat(t.maxSpeed * 0.6);
    physics.setControl(0, ctrl(steer, 1));
    stepPhysics(30);
    let trick = '';
    let boost = 0;
    const offT = bus.on('kart:trick', (e) => { trick = e.name; });
    const offB = bus.on('kart:boost', (e) => { if (e.source === 'trick') boost = e.duration; });
    physics.setControl(0, ctrl(steer, 1, 0, true, true));
    let airS = 0;
    let committed = false;
    for (let i = 0; i < 200; i++) {
      stepPhysics(1);
      physics.setControl(0, ctrl(steer, 1, 0, true, false));
      const bb = physics.getBody(0)!;
      // The negative control: put the old broken behaviour back by throwing away
      // the provenance latch every frame, exactly as a zeroed `hopTime` did.
      if (breakTheGuard) bb.hopLaunch = false;
      if (i === 0) committed = bb.driftPhase === DriftPhase.Drifting;
      if (!bb.grounded) airS += FIXED_DT;
      else if (airS > 0) break;
    }
    stepPhysics(20); // let the landing pay out, if it is going to
    offT();
    offB();
    return { air: airS, trick, boost, committedOnPress: committed };
  };

  const hopPlain = hopRun(0, false);
  notes.push(`straight drift hop: airborne ${hopPlain.air.toFixed(3)}s, trick "${hopPlain.trick || 'none'}", trick boost ${hopPlain.boost.toFixed(2)}s`);
  a.push({ name: 'a drift hop arms no trick', value: `${hopPlain.trick || 'none'} (airborne ${hopPlain.air.toFixed(3)}s)`, expect: 'none, while still airborne', pass: hopPlain.trick === '' && hopPlain.air > 0.22 });
  a.push({ name: 'a drift hop pays no trick boost', value: `${hopPlain.boost.toFixed(2)} s`, expect: '0.00 s', pass: hopPlain.boost === 0 });

  // The drift can commit on the press tick (P0g), which ends the Hop phase
  // immediately — a second route to a departure with no hop phase left to read.
  const hopTurning = hopRun(1, false);
  notes.push(`hop with the drift committed on the press tick (phase=Drifting at +1: ${hopTurning.committedOnPress}): airborne ${hopTurning.air.toFixed(3)}s, trick "${hopTurning.trick || 'none'}", boost ${hopTurning.boost.toFixed(2)}s`);
  a.push({ name: 'a hop that commits its drift at once arms no trick', value: `${hopTurning.trick || 'none'} / ${hopTurning.boost.toFixed(2)} s`, expect: 'none / 0.00 s', pass: hopTurning.trick === '' && hopTurning.boost === 0 });

  // NEGATIVE CONTROL. Without this, the two assertions above could pass because
  // nothing ever arms a trick on a flat straight, and they would be worthless.
  const hopBroken = hopRun(0, true);
  notes.push(`negative control — provenance latch discarded each frame: trick "${hopBroken.trick || 'none'}", boost ${hopBroken.boost.toFixed(2)}s (this is the shipped defect, reproduced on demand)`);
  a.push({ name: 'breaking the hop-origin test brings the defect back', value: `${hopBroken.trick || 'none'} / ${hopBroken.boost.toFixed(2)} s`, expect: 'a named trick and a boost > 0', pass: hopBroken.trick !== '' && hopBroken.boost > 0 });

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

/** Steering the grind run holds against the barrier. The budget derives from it. */
const GRIND_STEER = 0.35;

function tWall(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  solo();
  const t = physics.tuningOf(0)!;

  // The grind budget, derived from the collision constants rather than written
  // down. Read HERE and not at module scope, so it tracks the constants a caller
  // may have changed — a hoisted `const` would freeze at import and quietly
  // report a budget the model is no longer being held to.
  const GRIND_PRESS = COLL.vergePressFloor + (1 - COLL.vergePressFloor) * GRIND_STEER;
  const GRIND_DRAG = COLL.vergeContactDrag * GRIND_PRESS;
  const GRIND_FLOOR = Math.exp(-GRIND_DRAG * 3);

  /**
   * Drive at a barrier at `deg` off the tangent; report the impact tick.
   *
   * TWO THINGS HERE WERE WRONG, and together they are why the four assertions
   * below reported `Infinity %` at the P0b-5/P0b-6 baseline.
   *
   * 1. **It waited for a PENALTY.** The trigger was `wallImpacts > pen0`, and
   *    `KartCollision` increments `wallImpacts` in exactly one place —
   *    `solidImpact()`, reached only for `Contact.Solid`. A verge contact is
   *    documented as never being a penalty ("`wallImpacts` is NOT incremented —
   *    a verge contact is not a penalty and must never be counted as one"), so
   *    the trigger could not fire on a guardrail no matter what the kart did.
   *    `before` therefore kept its `0` sentinel and `after` its `-1`, and
   *    `(0 - -1) / 0` is what printed. Measured: the kart reached the rail on
   *    tick 349 / 115 / 62 at 10° / 30° / 60° and stayed in contact for ~40
   *    ticks each time — the run-up and the contact were always fine.
   *    It now triggers on `wallContact`, and a light graze IS a contact.
   *
   * 2. **It aimed at the wrong barrier.** The ranges asserted below are the
   *    solid-collider shunt: `retain = 1 - solidScrub · smoothstep((sin A -
   *    solidKnee)/solidSpan)` gives 0 % at 10°, ~9 % at 30° and ~50 % retained
   *    at 60°, which is 6–20 %, < 8 % and 45–70 % exactly. The verge is a
   *    friction contact with no discrete cost at all and could never produce
   *    them. `TestTrack.tallWall` was added in the same commit as this test to
   *    provide a nine-metre facade for precisely this purpose and was then
   *    wired to nothing; `solid` here turns it on. The verge gets its own sweep
   *    below, so neither class is left unmeasured.
   *
   * Division is guarded: with no contact `before` stays 0 and `loss()` returns
   * NaN, which fails every comparison instead of printing a non-finite ratio.
   */
  const hitAt = (
    deg: number,
    solid: boolean,
  ): { before: number; after: number; min: number; penalties: number; contact: boolean } => {
    // Flat part of the ramp straight, well before the ramp, aimed at the
    // outer barrier. lateral −2 gives ~13 m of run-up to it.
    track.tallWall = solid ? 'outer' : 'none';
    place(4, -2, 25, deg);
    const b0 = physics.getBody(0)!;
    const pen0 = b0.wallImpacts;
    let before = 0;
    let after = 0;
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
      if (hitStep < 0 && b.wallContact) {
        before = prev;
        after = b.velocity.length(); // the contact tick itself: the true cost
        hitStep = 1;
      } else if (hitStep > 0) {
        hitStep++;
        min = Math.min(min, physics.getBody(0)!.velocity.length());
        if (hitStep > 40) break;
      }
    }
    track.tallWall = 'none';
    return {
      before,
      after,
      min,
      penalties: physics.getBody(0)!.wallImpacts - pen0,
      contact: hitStep > 0,
    };
  };

  // NaN, not Infinity: a probe that never touched anything must fail loudly, not
  // divide by its own sentinel.
  const loss = (r: { before: number; after: number; contact: boolean }) =>
    r.contact && r.before > 0 ? (r.before - r.after) / r.before : NaN;
  const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)} %` : 'NO CONTACT');
  const mn = (r: { min: number }) => (r.min < 1e8 ? r.min.toFixed(2) : 'n/a');

  // ---- CLASS 3: solid scenery. The discrete, angle-scaled shunt. ----------
  const r30 = hitAt(30, true);
  notes.push(`30° building hit: ${r30.before.toFixed(2)} → ${r30.after.toFixed(2)} m/s on the contact tick (min over the next 0.33 s ${mn(r30)}), loss ${pct(loss(r30))}`);
  a.push({ name: '30° building scrub', value: pct(loss(r30)), expect: '6–20 %', pass: loss(r30) > 0.06 && loss(r30) < 0.2 });
  a.push({ name: '30° building does NOT stop the kart', value: `min ${mn(r30)} m/s`, expect: '> 40 % of entry', pass: r30.min > r30.before * 0.4 });

  const r10 = hitAt(10, true);
  notes.push(`10° graze:       ${r10.before.toFixed(2)} → ${r10.after.toFixed(2)} m/s, loss ${pct(loss(r10))}`);
  a.push({ name: '10° building graze is nearly free', value: pct(loss(r10)), expect: '< 8 %', pass: loss(r10) < 0.08 });

  const r60 = hitAt(60, true);
  notes.push(`60° clout:       ${r60.before.toFixed(2)} → ${r60.after.toFixed(2)} m/s, loss ${pct(loss(r60))}, min ${mn(r60)}`);
  a.push({ name: '60° building hit keeps half its speed', value: `${((1 - loss(r60)) * 100).toFixed(1)} % retained`, expect: '45–70 %', pass: 1 - loss(r60) > 0.45 && 1 - loss(r60) < 0.7 });
  a.push({ name: 'steeper hit costs more', value: `${(loss(r10) * 100).toFixed(0)} < ${(loss(r30) * 100).toFixed(0)} < ${(loss(r60) * 100).toFixed(0)} %`, expect: 'monotonic', pass: loss(r10) < loss(r30) && loss(r30) < loss(r60) });
  a.push({ name: 'one penalty per impact', value: `${r30.penalties} / ${r10.penalties} / ${r60.penalties}`, expect: '≤ 3 each', pass: r30.penalties <= 3 && r10.penalties <= 3 && r60.penalties <= 3 });

  // ---- CLASS 1: the verge. Friction only — the other half of the sweep. ---
  // Retargeting the four assertions above at a facade would otherwise leave the
  // kerbside guardrail — the barrier a player actually meets — with no
  // angle-swept coverage at all. Both claims here are lifted from the contract
  // at the top of `KartCollision.ts`, not fitted to the current output.
  const v10 = hitAt(10, false);
  const v30 = hitAt(30, false);
  const v60 = hitAt(60, false);
  notes.push(`verge arrivals (guardrail): 10° ${pct(loss(v10))}, 30° ${pct(loss(v30))}, 60° ${pct(loss(v60))} lost on the contact tick; ${v10.penalties + v30.penalties + v60.penalties} penalties in total`);
  a.push({ name: 'verge contact is never a penalty', value: `${v10.penalties} / ${v30.penalties} / ${v60.penalties}`, expect: '0 / 0 / 0', pass: v10.contact && v30.contact && v60.contact && v10.penalties === 0 && v30.penalties === 0 && v60.penalties === 0 });
  a.push({ name: '60° verge arrival is redirected, not absorbed', value: `${((1 - loss(v60)) * 100).toFixed(1)} % retained`, expect: '> 90 %', pass: 1 - loss(v60) > 0.9 });

  // --- THE REGRESSION THAT MATTERED: grinding a wall must not be a crash ----
  // At 120 Hz a kart merely leaning on a barrier used to take ~240 impact
  // penalties a second; 3 s of it cost 99.9 % of the kart's speed. Anything that
  // reintroduces a per-tick penalty will fail here and nowhere else.
  //
  // ---- WHY THIS NO LONGER SAYS "> 60 % OF FREE SPEED" ----------------------
  // That threshold was a proxy chosen against a 99.9 % failure mode, and three
  // things were wrong with it once the verge model landed. It read 52 % and the
  // number was real — `leanOnBarrier()` computes press = 0.5775 here and behaves
  // exactly as documented — so it is replaced by a derivation, not widened.
  //
  //  1. It charged the barrier for the KERB. The wall run has to start at
  //     u = −11.7 to reach a rail at 12.7 m when the asphalt ends at 11, so it
  //     rides the kerb band for all 3 s and pays `PHYS.vergeDrag` on top; the
  //     baseline ran down the centreline and paid none. Measured: the kerb alone
  //     costs 3.4 m/s of the 14.6 m/s gap. The baseline is now the SAME LINE at
  //     steer 0, so the kerb is charged to both sides and cancels.
  //  2. It sampled one instant. The contact is not a smooth decay — it holds a
  //     stable equilibrium that oscillates ±1.5 m/s as the chassis bounces on the
  //     barrier (measured over 12 s: 16.20, 15.11, 13.23, 16.79, 15.36, 15.27,
  //     then it leaves the rail on the arc and recovers to 27). Tick 360 landed
  //     in a trough, so the reading carried ~12 % of noise. Now a mean over the
  //     final second.
  //  3. The budget was a guess. It is now derived from the barrier's own drag
  //     constant: `leanOnBarrier` returns
  //       press = vergePressFloor + (1 − vergePressFloor)·|steer| = 0.5775
  //     and the scrape is charged at `vergeContactDrag · press` = 0.3176 /s. With
  //     the engine contributing NOTHING, 3 s of that leaves exp(−0.3176·3) =
  //     38.6 %. Under full throttle it must do better, so 38.6 % of the
  //     like-for-like baseline is a floor the model derives for itself, and the
  //     old per-tick-penalty regression (0.1 % retained) misses it by 400×.
  //  3. The budget was a guess, and deriving it turned out NOT to give a usable
  //     assertion. The derivation itself is sound and is printed as a note every
  //     run: `leanOnBarrier` returns
  //       press = vergePressFloor + (1 − vergePressFloor)·|steer| = 0.5775
  //     and the scrape is charged at `vergeContactDrag · press` = 0.3176 /s, so
  //     3 s of it with the engine contributing nothing leaves exp(−0.3176·3) =
  //     38.6 %. Measured: 65.0 %, comfortably above.
  //
  //     But a floor derived from `vergeContactDrag` MOVES WITH IT, so it cannot
  //     fail. `Measured:` at `vergeContactDrag` 4.0 the floor drops to 0.1 % and
  //     the assertion passes at 35.8 % — a barrier seven times harsher than
  //     shipped, and still green. DECISIONS' "a test that cannot fail must not
  //     ship" says delete rather than ship that, so the arithmetic stays as a
  //     note and the assertion below is anchored to something that does not move.
  //
  // WHAT THE ASSERTION IS ANCHORED TO. `maxSpeed · 0.4` — because the game
  // already uses exactly that number as "a speed you can race from": a respawn
  // drops you back in at `tuning.maxSpeed * 0.4` (KartPhysics, "Drop back in at
  // 40 % pace"). So the claim is *grinding a barrier must not leave you worse off
  // than being fished out of the void and put back on the road*, which is a
  // sharper reading of "it never stops you" than any percentage of a free run.
  // It is falsifiable both ways: `Measured:` `vergeContactDrag` 4.0 gives 26.7 %
  // of top speed and `vergePressFloor` 1.0 with drag 1.6 gives 32.6 %, and both
  // go red.
  //
  // The old `> 60 % of free speed` is not reproduced as an assertion anywhere.
  // Its replacement is deliberately a different claim, not a looser one: the
  // original bundled the kerb and sampled one noisy instant, so no threshold on
  // it could have meant much.
  const grind = (
    withWall: boolean,
    // Tied to GRIND_STEER, not repeated: the derived budget below is only valid
    // for the input the run actually holds.
    steer = -GRIND_STEER,
  ): { v: number; vPrev: number; contact: number; penalties: number } => {
    // With the wall: start beside the tight guardrail and lean gently into it.
    // Without: straight down the middle, steer 0 — the control run must not touch
    // a barrier at all, so it cannot steer (0.35 of lock puts it in the OTHER
    // guardrail inside three seconds, which made the first version of this
    // control run just as dead as the case it was supposed to baseline).
    place(4, withWall ? -(WALL_TIGHT - 1.0) : 0, 18, 0);
    const b = physics.getBody(0)!;
    const pen0 = b.wallImpacts;
    let contact = 0;
    // Means over the 2nd and 3rd seconds, not the value at tick 360 — see (2).
    let sumPrev = 0;
    let nPrev = 0;
    let sumLast = 0;
    let nLast = 0;
    for (let i = 0; i < 120 * 3; i++) {
      physics.setControl(0, ctrl(withWall ? steer : 0, 1));
      stepPhysics(1);
      if (b.wallContact) contact++;
      const v = b.velocity.length();
      if (i >= 120 && i < 240) {
        sumPrev += v;
        nPrev++;
      } else if (i >= 240) {
        sumLast += v;
        nLast++;
      }
    }
    return {
      v: sumLast / nLast,
      vPrev: sumPrev / nPrev,
      contact,
      penalties: b.wallImpacts - pen0,
    };
  };
  const gw = grind(true);
  const gf = grind(false);
  // Same line as the wall run, steer 0: it never reaches the barrier (0 contact
  // ticks), so it carries the kerb cost and not the barrier's. Reported, so the
  // barrier's share of the gap is visible rather than inferred.
  const gk = grind(true, 0);
  const raceable = t.maxSpeed * 0.4;
  notes.push(`3 s leaning on the guardrail at 18 m/s entry: |v| ${gw.v.toFixed(2)} m/s (mean over the final second, ${((gw.v / gw.vPrev) * 100).toFixed(1)} % of the second before it), ${gw.contact}/360 contact ticks, ${gw.penalties} penalties`);
  notes.push(`  same line at steer 0 ${gk.v.toFixed(2)} m/s, centreline free run ${gf.v.toFixed(2)} m/s — the gap between those two is the kerb band alone (PHYS.vergeDrag), which the barrier is not responsible for`);
  notes.push(`  derivation, recorded not asserted: barrier scrape ${GRIND_DRAG.toFixed(4)}/s (vergeContactDrag ${COLL.vergeContactDrag} × press ${GRIND_PRESS.toFixed(4)}) → 3 s with no engine would leave ${(GRIND_FLOOR * 100).toFixed(1)} % of the same line; measured ${((gw.v / gk.v) * 100).toFixed(1)} %`);
  a.push({ name: 'grinding a wall is not a crash', value: `${gw.v.toFixed(2)} m/s (${((gw.v / t.maxSpeed) * 100).toFixed(1)} % of top speed)`, expect: `> ${raceable.toFixed(1)} m/s (respawn pace)`, pass: gw.v > raceable });
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

  // --- a bump-scale departure is not a trick ------------------------------
  // `trickLaunchSpeed` is what separates a kerb blip from a kicker. A real kerb
  // on this bench measures ~0.24 m/s of world-vertical and does not leave the
  // ground at all, so the gate is exercised here with a synthetic departure just
  // under the threshold: lifted clear of the springs with 1.0 m/s of rise, drift
  // HELD so that anything eligible would arm immediately.
  placeFlat(26);
  physics.setControl(0, ctrl(0, 1, 0, true, false));
  stepPhysics(30);
  let bumpTrick = '';
  let bumpBoost = 0;
  const offB1 = bus.on('kart:trick', (e) => { bumpTrick = e.name; });
  const offB2 = bus.on('kart:boost', (e) => { if (e.source === 'trick') bumpBoost = e.duration; });
  {
    const bb = physics.getBody(0)!;
    bb.position.y += 0.30;                     // clear of the suspension
    bb.velocity.addScaledVector(bb.up, 1.0);   // under trickLaunchSpeed (1.6)
    for (let i = 0; i < 200; i++) {
      stepPhysics(1);
      physics.setControl(0, ctrl(0, 1, 0, true, false));
    }
  }
  offB1();
  offB2();
  notes.push(`bump-scale departure (1.0 m/s < trickLaunchSpeed ${DRIFT.trickLaunchSpeed}): trick "${bumpTrick || 'none'}", boost ${bumpBoost.toFixed(2)}s`);
  a.push({ name: 'a bump-scale launch is not a trick', value: `${bumpTrick || 'none'} / ${bumpBoost.toFixed(2)} s`, expect: 'none / 0.00 s', pass: bumpTrick === '' && bumpBoost === 0 });

  // --- a late press after a real lip still arms (trickGrace) ---------------
  // The launch itself arms nothing here, because drift is not held as the kart
  // leaves; the press lands in the air, inside `trickGrace`. This is the path the
  // hop fix must not break — a mid-air press is not a hop impulse.
  track.mode = 'track';
  place(0, 0, 26);
  let lateTrick = '';
  let lateBoost = 0;
  let pressedAirborne = false;
  const offL1 = bus.on('kart:trick', (e) => { lateTrick = e.name; });
  const offL2 = bus.on('kart:boost', (e) => { if (e.source === 'trick') lateBoost = e.duration; });
  {
    let sent = false;
    for (let i = 0; i < 120 * 5; i++) {
      const bb = physics.getBody(0)!;
      const press = !bb.grounded && !sent;
      if (press) { sent = true; pressedAirborne = true; }
      physics.setControl(0, ctrl(0, 1, 0, sent, press));
      stepPhysics(1);
    }
  }
  offL1();
  offL2();
  notes.push(`late mid-air press after the lip (press delivered airborne: ${pressedAirborne}, grace ${DRIFT.trickGrace}s): trick "${lateTrick || 'none'}", boost ${lateBoost.toFixed(2)}s`);
  a.push({ name: 'a late press after the lip still tricks', value: `${lateTrick || 'none'} / ${lateBoost.toFixed(2)} s`, expect: 'named trick, > 0 s', pass: pressedAirborne && lateTrick !== '' && lateBoost > 0 });

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

/**
 * 25 m into the apron straight. The one stretch of this track with grass a kart
 * can sit on for four seconds: the apron's guardrail is blended out to
 * `WALL_WIDE`, so lateral 15 is 4.4 m clear of it, and the surface there is
 * `Grass` rather than the kerb band.
 */
const APRON_GRASS = STRAIGHT_LEN + ARC_LEN + 25;

function tMisc(): TestReport {
  const a: Assertion[] = [];
  const notes: string[] = [];
  solo();
  const t = physics.tuningOf(0)!;

  // --- off-road slowdown ---------------------------------------------------
  // Apron straight, out on the grass. `2 * STRAIGHT_LEN + ARC_LEN` was NOT the
  // apron straight: it was built from `geoAt()`'s apron arc length, which was
  // 110 m too large (fixed above), and `place()` inverts the lap with
  // `fillSample()`, which was always right. So this landed 55 m into ARC B, at
  // lateral 15 — outside that region's `WALL_TIGHT` guardrail (12.7 m), which
  // promptly pushed the kart back to u ≈ 11.95. The kart therefore spent the
  // whole 4 s pinned against a barrier on the KERB, and `surfaceAt` correctly
  // answered `Road` for the kerb band. Nothing was ever measured on grass.
  //
  // 25 m into the apron straight instead: the guardrail there has blended out to
  // `WALL_WIDE` (19.4 m), so lateral 15 is clear grass with 4.4 m to spare, and
  // 4 s at grass speed covers ~65 m of the straight's remaining 80 m.
  place(APRON_GRASS, 15, 22);
  physics.setControl(0, ctrl(0, 1));
  stepPhysics(120 * 4);
  const grassSpeed = physics.getBody(0)!.forwardSpeed;
  const grassSurf = karts[0].surface;
  notes.push(`grass: settles at ${grassSpeed.toFixed(2)} m/s (surface id ${grassSurf}, road cap ${t.maxSpeed.toFixed(1)})`);
  a.push({ name: 'off-road slows you', value: `${grassSpeed.toFixed(2)} m/s`, expect: `< ${(t.maxSpeed * 0.72).toFixed(1)}`, pass: grassSpeed < t.maxSpeed * 0.72 && grassSurf === SurfaceType.Grass });

  // --- boost is immune to off-road for 0.4 s ------------------------------
  place(APRON_GRASS, 15, 22);
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
  // TWO BUGS LIVED HERE, both of which made this pair of assertions lie.
  //
  // 1. The teleport target was `(0, 8, 0)` — "dead centre of the infield". That
  //    is the ONE point on an oval where the projection is degenerate: it is
  //    equidistant from both straights, so the road frame resolves ambiguously
  //    and the kart was flung 40 m laterally in the FIRST 8 ms step, from x=0 to
  //    x=-40.9. `stepKart` runs before `checkBounds`, so by the time the bounds
  //    test looked, |u| was 19.1 m — inside OOB_LIMIT (34) — and no respawn was
  //    ever due. `isOutOfBounds` was true at the moment of the teleport and
  //    false one step later. Now it teleports straight out past the apron on a
  //    straight, where the projection is unambiguous.
  //
  // 2. `offset` was read as `G.u` AFTER calling `track.project()` — but
  //    `project` returns the nearest CENTRELINE point and leaves `G` describing
  //    that point, where `u` is ~0 by construction. So `offset` was always
  //    ~0.01 and `offset < ROAD` was trivially true: it measured nothing at all.
  //    `isOutOfBounds()` calls `geoAt` on the position you pass it, so asking it
  //    is both the real question and a correct way to leave `G` on the kart.
  //
  // Respawn itself was never broken. Verified independently against all three
  // shipping circuits: a kart put 120 m to the side, or 60 m below the road,
  // raises `kart:respawn` on the very first step with respawnTime 0.95.
  place(APRON_GRASS, 0, 10);
  const bb = physics.getBody(0)!;
  // x = R + 80 on a straight: |u| = 80 m, well past OOB_LIMIT, unambiguous.
  bb.position.set(R + 80, 8, 0);
  const oobAtStart = track.isOutOfBounds(bb.position);
  let didRespawn = false;
  const off = bus.on('kart:respawn', () => (didRespawn = true));
  stepPhysics(200);
  off();
  const stillOut = track.isOutOfBounds(bb.position);
  const offset = Math.abs(G.u); // set by the isOutOfBounds call above, not by project
  notes.push(`out-of-bounds respawn: OOB at start ${oobAtStart}, fired ${didRespawn}; ended ${offset.toFixed(2)} m off the centreline (still out: ${stillOut}) at ${bb.forwardSpeed.toFixed(2)} m/s`);
  a.push({ name: 'out of bounds → respawn', value: `${didRespawn}, |u| ${offset.toFixed(2)} m`, expect: 'true, < 11 m', pass: didRespawn && offset < ROAD });
  a.push({ name: 'respawn at ~40 % speed', value: `${bb.forwardSpeed.toFixed(2)} m/s`, expect: `≈ ${(t.maxSpeed * 0.4).toFixed(1)}`, pass: bb.forwardSpeed > 4 });

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
    { name: 'BENCH SELF-CHECK', report: tTrack() },
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
  let out = `FOXY KART — PHYSICS ASSERTIONS   ${r.passed} passed / ${r.failed} failed\n`;
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
