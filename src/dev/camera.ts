/**
 * ============================================================================
 *  CAMERA / RACE BENCH — src/dev/camera.html
 * ============================================================================
 *  A self-contained rig for the camera and race director. It deliberately does
 *  NOT depend on the real Track, KartManager, Physics, VFX or Audio modules —
 *  those are being written in parallel. Instead:
 *
 *    · `TestTrack`   — a full `ITrackService`: oval + hairpin + crest + dip
 *                      + guardrails, analytic and therefore always closed.
 *    · `TestPhysics` — `setControl` / `setFrozen` / `applyBoost` / `place`,
 *                      plus a small arcade integrator for the player and rail
 *                      followers for the AI field. This exercises the real
 *                      RaceDirector → physics control bridge.
 *    · `TestAi`      — `setDifficulty` / `setRaceStarted` / `resetRace`.
 *
 *  Everything else is the real thing: `ChaseCamera`, `CinematicCamera`,
 *  `CameraRig`, `RaceDirector`, `RaceState`, `Standings`.
 *
 *  `window.__CAM__.runTests()` runs the headless assertion suite and returns
 *  plain JSON, which is what the automated verification reads.
 * ============================================================================
 */

import * as THREE from 'three';
import type {
  FrameContext,
  GroundHit,
  InputState,
  ITrackService,
  KartState,
  TrackSample,
  WallHit,
} from '@/core/Types';
import { DriftStage, SurfaceType } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { FIXED_DT } from '@/core/Config';
import { clamp, clamp01, angleDelta } from '@/core/MathUtils';
import { ChaseCamera, CAMERA_TUNING, type CameraMode } from '@/camera/ChaseCamera';
import { RaceDirector } from '@/game/RaceDirector';

// ===========================================================================
//  TEST TRACK
// ===========================================================================

const TWO_PI = Math.PI * 2;
const LAP_SAMPLES = 720;
const ROAD_HALF = 11.0;
const HAIRPIN_HALF = 13.5;
const WALL_MARGIN = 1.35;
const WALL_HEIGHT = 1.7;

/** Angular centre of the hairpin pinch, radians of the parametric loop. */
const HAIRPIN_THETA = 4.95;
const CREST_THETA = 2.05;
const DIP_THETA = 3.25;

function angDist(a: number, b: number): number {
  let d = Math.abs(a - b) % TWO_PI;
  if (d > Math.PI) d = TWO_PI - d;
  return d;
}

function makeSample(): TrackSample {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: ROAD_HALF,
    t: 0,
    distance: 0,
    curvature: 0,
    bank: 0,
  };
}

function copySample(dst: TrackSample, src: TrackSample): TrackSample {
  dst.position.copy(src.position);
  dst.tangent.copy(src.tangent);
  dst.normal.copy(src.normal);
  dst.binormal.copy(src.binormal);
  (dst as { halfWidth: number }).halfWidth = src.halfWidth;
  (dst as { t: number }).t = src.t;
  (dst as { distance: number }).distance = src.distance;
  (dst as { curvature: number }).curvature = src.curvature;
  (dst as { bank: number }).bank = src.bank;
  return dst;
}

function lerpSample(dst: TrackSample, a: TrackSample, b: TrackSample, f: number): TrackSample {
  dst.position.lerpVectors(a.position, b.position, f);
  dst.tangent.lerpVectors(a.tangent, b.tangent, f).normalize();
  dst.normal.lerpVectors(a.normal, b.normal, f).normalize();
  dst.binormal.crossVectors(dst.tangent, dst.normal).normalize();
  (dst as { halfWidth: number }).halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * f;
  (dst as { distance: number }).distance = a.distance + (b.distance - a.distance) * f;
  (dst as { curvature: number }).curvature = a.curvature + (b.curvature - a.curvature) * f;
  (dst as { bank: number }).bank = a.bank + (b.bank - a.bank) * f;
  return dst;
}

/** Ring buffer of samples so a caller can hold two results at once. */
class SamplePool {
  private readonly list: TrackSample[] = [];
  private i = 0;
  constructor(n: number) { for (let k = 0; k < n; k++) this.list.push(makeSample()); }
  next(): TrackSample { const s = this.list[this.i]; this.i = (this.i + 1) % this.list.length; return s; }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class TestTrack implements ITrackService {
  readonly lapCount = 3;
  lapLength = 0;

  /** Resampled, arc-length-uniform centreline. */
  readonly table: TrackSample[] = [];
  private readonly step: number;

  private readonly poolProject = new SamplePool(6);
  private readonly poolDistance = new SamplePool(6);
  private readonly poolAt = new SamplePool(4);
  private projectHint = 0;

  private readonly gridPos = new THREE.Vector3();
  private readonly gridQuat = new THREE.Quaternion();

  /** Diagnostics for the report. */
  minRadius = Infinity;
  maxRise = 0;
  minRise = 0;

  constructor() {
    // --- analytic centreline: r(theta) with a hairpin pinch, y with a crest
    //     and a dip. Periodic in theta, so the loop is closed by construction.
    const raw: THREE.Vector3[] = [];
    const N = 2048;
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TWO_PI;
      raw.push(this.point(th, new THREE.Vector3()));
    }

    // --- arc length -------------------------------------------------------
    const cum: number[] = [0];
    for (let i = 1; i <= N; i++) {
      const a = raw[i - 1];
      const b = raw[i % N];
      cum.push(cum[i - 1] + a.distanceTo(b));
    }
    this.lapLength = cum[N];
    this.step = this.lapLength / LAP_SAMPLES;

    // --- resample uniformly ----------------------------------------------
    let cursor = 0;
    for (let k = 0; k < LAP_SAMPLES; k++) {
      const d = k * this.step;
      while (cursor < N && cum[cursor + 1] < d) cursor++;
      const seg = Math.max(1e-6, cum[cursor + 1] - cum[cursor]);
      const f = clamp01((d - cum[cursor]) / seg);
      const s = makeSample();
      s.position.lerpVectors(raw[cursor], raw[(cursor + 1) % N], f);
      (s as { distance: number }).distance = d;
      (s as { t: number }).t = d / this.lapLength;
      this.table.push(s);
    }

    // --- frames, curvature, banking, width -------------------------------
    for (let k = 0; k < LAP_SAMPLES; k++) {
      const prev = this.table[(k - 1 + LAP_SAMPLES) % LAP_SAMPLES];
      const cur = this.table[k];
      const next = this.table[(k + 1) % LAP_SAMPLES];
      cur.tangent.copy(next.position).sub(prev.position).normalize();

      // Signed curvature about world up: positive = turning right.
      const a = Math.atan2(
        cur.position.x - prev.position.x, cur.position.z - prev.position.z,
      );
      const b = Math.atan2(
        next.position.x - cur.position.x, next.position.z - cur.position.z,
      );
      const dTheta = angleDelta(a, b);
      const curvature = -dTheta / (2 * this.step);
      (cur as { curvature: number }).curvature = curvature;
      const radius = Math.abs(curvature) > 1e-6 ? 1 / Math.abs(curvature) : Infinity;
      if (radius < this.minRadius) this.minRadius = radius;

      // Bank into the corner, capped. Widen the hairpin so it stays driveable.
      const bank = clamp(curvature * 190, -0.30, 0.30);
      (cur as { bank: number }).bank = bank;
      const pinch = Math.exp(-Math.pow(angDist(cur.t * TWO_PI, HAIRPIN_THETA), 2) / 0.22);
      (cur as { halfWidth: number }).halfWidth = ROAD_HALF + (HAIRPIN_HALF - ROAD_HALF) * pinch;

      // Normal: world up, de-tangented, then rolled by the bank.
      cur.normal.copy(UP).addScaledVector(cur.tangent, -UP.dot(cur.tangent)).normalize();
      _q.setFromAxisAngle(cur.tangent, bank);
      cur.normal.applyQuaternion(_q).normalize();
      cur.binormal.crossVectors(cur.tangent, cur.normal).normalize();

      if (cur.position.y > this.maxRise) this.maxRise = cur.position.y;
      if (cur.position.y < this.minRise) this.minRise = cur.position.y;
    }
  }

  /** The generating curve. Oval, pinched into a hairpin, with a crest + dip. */
  private point(th: number, out: THREE.Vector3): THREE.Vector3 {
    // Depth/width of the pinch are tuned so the tightest radius lands near
    // 14 m — a real hairpin — without folding the loop back over itself.
    const pinch = Math.exp(-Math.pow(angDist(th, HAIRPIN_THETA), 2) / 0.22);
    const r = 152 - 78 * pinch;
    const x = r * Math.sin(th) * 1.28;
    const z = -r * Math.cos(th);
    const crest = 8.5 * Math.exp(-Math.pow(angDist(th, CREST_THETA), 2) / 0.16);
    const dip = 5.0 * Math.exp(-Math.pow(angDist(th, DIP_THETA), 2) / 0.10);
    return out.set(x, crest - dip, z);
  }

  // --- ITrackService -------------------------------------------------------

  sampleAtDistance(d: number): TrackSample {
    const out = this.poolDistance.next();
    const L = this.lapLength;
    let dd = ((d % L) + L) % L;
    const f = dd / this.step;
    const i = Math.floor(f) % LAP_SAMPLES;
    const j = (i + 1) % LAP_SAMPLES;
    lerpSample(out, this.table[i], this.table[j], f - Math.floor(f));
    (out as { distance: number }).distance = dd;
    (out as { t: number }).t = dd / L;
    return out;
  }

  sampleAt(t: number): TrackSample {
    const out = this.poolAt.next();
    return copySample(out, this.sampleAtDistance((((t % 1) + 1) % 1) * this.lapLength));
  }

  project(position: THREE.Vector3): TrackSample {
    // Coarse global scan, then refine around the winner and the last hint.
    let best = this.projectHint;
    let bestD = Infinity;
    for (let i = 0; i < LAP_SAMPLES; i += 9) {
      const d = this.table[i].position.distanceToSquared(position);
      if (d < bestD) { bestD = d; best = i; }
    }
    for (let k = -10; k <= 10; k++) {
      const i = (best + k + LAP_SAMPLES) % LAP_SAMPLES;
      const d = this.table[i].position.distanceToSquared(position);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.projectHint = best;

    // Sub-sample along the segment for a smooth, monotonic `t`.
    const a = this.table[best];
    const b = this.table[(best + 1) % LAP_SAMPLES];
    const c = this.table[(best - 1 + LAP_SAMPLES) % LAP_SAMPLES];
    _v.copy(b.position).sub(a.position);
    const lenSq = Math.max(1e-6, _v.lengthSq());
    let f = _v2.copy(position).sub(a.position).dot(_v) / lenSq;
    let i0 = best;
    if (f < 0) {
      _v.copy(a.position).sub(c.position);
      f = 1 + _v2.copy(position).sub(a.position).dot(_v) / Math.max(1e-6, _v.lengthSq());
      i0 = (best - 1 + LAP_SAMPLES) % LAP_SAMPLES;
    }
    f = clamp01(f);
    const out = this.poolProject.next();
    lerpSample(out, this.table[i0], this.table[(i0 + 1) % LAP_SAMPLES], f);
    const d = (i0 + f) * this.step;
    (out as { distance: number }).distance = d;
    (out as { t: number }).t = (d / this.lapLength) % 1;
    return out;
  }

  /** Signed lateral offset of a world point, metres, right-positive. */
  lateralOf(position: THREE.Vector3, sample: TrackSample): number {
    return _v3.copy(position).sub(sample.position).dot(sample.binormal);
  }

  /** Exact road height under a world point, along world up. */
  groundYAt(position: THREE.Vector3): number {
    const s = this.project(position);
    const denom = UP.dot(s.normal);
    if (Math.abs(denom) < 1e-4) return s.position.y;
    const along = _v3.copy(position).sub(s.position).dot(s.normal);
    return position.y - along / denom;
  }

  private readonly hit: GroundHit = {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: 0, surface: SurfaceType.Road,
  };

  raycastGround(origin: THREE.Vector3, up: THREE.Vector3, maxDist: number): GroundHit {
    const s = this.project(origin);
    const denom = up.dot(s.normal);
    const h = this.hit;
    if (Math.abs(denom) < 1e-4) { h.hit = false; return h; }
    const along = _v3.copy(origin).sub(s.position).dot(s.normal);
    const dist = along / denom;
    if (dist < -0.5 || dist > maxDist) { h.hit = false; h.distance = dist; return h; }
    h.hit = true;
    h.point.copy(origin).addScaledVector(up, -dist);
    h.normal.copy(s.normal);
    h.distance = dist;
    h.surface = Math.abs(this.lateralOf(origin, s)) > s.halfWidth * 0.93
      ? SurfaceType.Grass : SurfaceType.Road;
    return h;
  }

  private readonly wall: WallHit = {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), depth: 0,
  };

  collideWalls(position: THREE.Vector3, radius: number): WallHit {
    const s = this.project(position);
    const lat = this.lateralOf(position, s);
    const limit = s.halfWidth + WALL_MARGIN;
    const w = this.wall;
    const over = Math.abs(lat) + radius - limit;
    if (over <= 0) { w.hit = false; w.depth = 0; return w; }
    w.hit = true;
    w.depth = over;
    const sgn = lat >= 0 ? 1 : -1;
    w.normal.copy(s.binormal).multiplyScalar(-sgn);
    w.point.copy(s.position).addScaledVector(s.binormal, sgn * limit);
    return w;
  }

  surfaceAt(position: THREE.Vector3): SurfaceType {
    const s = this.project(position);
    const lat = Math.abs(this.lateralOf(position, s));
    if (lat > s.halfWidth * 0.93) return SurfaceType.Grass;
    return SurfaceType.Road;
  }

  racingLineAt(t: number, lookahead: number): THREE.Vector3 {
    const s = this.sampleAtDistance((((t % 1) + 1) % 1) * this.lapLength + lookahead);
    // Bias to the inside of the corner, which is what a racing line does.
    return _v.copy(s.position).addScaledVector(s.binormal, clamp(s.curvature * 260, -6, 6));
  }

  getStartPosition(index: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const row = Math.floor(index / 2);
    const side = index % 2 === 0 ? -1 : 1;
    // Behind the line: t wraps to just under 1.
    const d = this.lapLength - 8 - row * 5.0;
    const s = this.sampleAtDistance(d);
    this.gridPos.copy(s.position)
      .addScaledVector(s.binormal, side * 3.6)
      .addScaledVector(s.normal, 0.42);
    this.quatFromSample(s, this.gridQuat);
    return { position: this.gridPos, quaternion: this.gridQuat };
  }

  getRespawn(t: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const s = this.sampleAt(t);
    this.gridPos.copy(s.position).addScaledVector(s.normal, 0.6);
    this.quatFromSample(s, this.gridQuat);
    return { position: this.gridPos, quaternion: this.gridQuat };
  }

  isOutOfBounds(position: THREE.Vector3): boolean {
    const s = this.project(position);
    if (Math.abs(this.lateralOf(position, s)) > s.halfWidth + 9) return true;
    return _v3.copy(position).sub(s.position).dot(s.normal) < -14;
  }

  /** Orientation whose forward is the tangent and whose up is the normal. */
  quatFromSample(s: TrackSample, out: THREE.Quaternion): THREE.Quaternion {
    _v.copy(s.tangent).multiplyScalar(-1); // local +Z is backwards
    const m = new THREE.Matrix4();
    m.makeBasis(s.binormal, s.normal, _v);
    return out.setFromRotationMatrix(m);
  }
}

// ===========================================================================
//  TEST KARTS
// ===========================================================================

function makeKart(id: number, isPlayer: boolean): KartState {
  return {
    id, isPlayer,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    groundQuaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    speed: 0, speedRatio: 0, angularVelocity: 0,
    steerAngle: 0,
    suspension: [0.5, 0.5, 0.5, 0.5],
    wheelSpin: [0, 0, 0, 0],
    wheelGrounded: [true, true, true, true],
    grounded: true, airTime: 0, surface: SurfaceType.Road,
    drifting: false, driftStage: DriftStage.None, driftDirection: 0, driftCharge: 0,
    boostTime: 0, boostStrength: 0,
    hopping: false, stunned: false, stunTime: 0, invulnerable: false, starTime: 0,
    gliding: false, antiGravity: false,
    lap: 0, progress: 0, racePosition: id + 1, finished: false, finishTime: 0,
    lapTimes: [],
    rpm: 0, heldItem: null, itemCount: 0,
  };
}

interface Control { steer: number; accel: number; brake: number; drift: boolean; driftPressed: boolean }

const TOP_SPEED = 28;
const GRAVITY = 26;

/**
 * Minimal stand-in for `PhysicsWorld`. Implements exactly the methods the race
 * director probes for, so the real control bridge is under test.
 */
export class TestPhysics {
  readonly karts: KartState[] = [];
  private readonly ctrl = new Map<number, Control>();
  private readonly railT = new Map<number, number>();
  private readonly railSpeed = new Map<number, number>();
  private frozen = true;
  cc = 150;

  /** Player state that isn't in KartState. */
  private heading = 0;
  private vy = 0;
  private slip = 0;
  private driftTime = 0;
  private wasGrounded = true;

  constructor(private readonly track: TestTrack, count: number) {
    for (let i = 0; i < count; i++) {
      const k = makeKart(i, i === 0);
      this.karts.push(k);
      this.ctrl.set(i, { steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false });
      this.railT.set(i, 0);
      this.railSpeed.set(i, 20 + (i % 5) * 1.4);
    }
  }

  // --- probed API ---------------------------------------------------------
  setCC(cc: number): void { this.cc = cc; }
  setFrozen(f: boolean): void { this.frozen = f; }
  get isFrozen(): boolean { return this.frozen; }

  setControl(kartId: number, c: Control): void {
    const t = this.ctrl.get(kartId);
    if (!t) return;
    t.steer = c.steer; t.accel = c.accel; t.brake = c.brake;
    t.drift = c.drift;
    if (c.driftPressed) t.driftPressed = true;
  }

  applyBoost(kartId: number, seconds: number, strength: number): void {
    const k = this.karts[kartId];
    if (!k) return;
    k.boostTime = Math.max(k.boostTime, seconds);
    k.boostStrength = Math.max(k.boostStrength, strength);
  }

  place(kartId: number, position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    const k = this.karts[kartId];
    if (!k) return;
    k.position.copy(position);
    k.quaternion.copy(quaternion);
    k.groundQuaternion.copy(quaternion);
    k.velocity.set(0, 0, 0);
    k.speed = 0; k.speedRatio = 0;
    const s = this.track.project(position);
    this.railT.set(kartId, s.t);
    if (k.isPlayer) {
      _v.set(0, 0, -1).applyQuaternion(quaternion);
      this.heading = Math.atan2(_v.x, _v.z);
      this.vy = 0; this.slip = 0; this.driftTime = 0;
    }
  }

  // --- simulation ---------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (this.frozen) {
      for (const k of this.karts) { k.speed = 0; k.speedRatio = 0; k.velocity.set(0, 0, 0); }
      this.clearEdges();
      return;
    }
    for (const k of this.karts) {
      if (k.isPlayer) this.stepPlayer(k, dt);
      else this.stepRail(k, dt);
      if (k.boostTime > 0) k.boostTime = Math.max(0, k.boostTime - dt);
      else k.boostStrength = 0;
      k.rpm = clamp01(Math.abs(k.speed) / TOP_SPEED * 0.8 + (k.boostTime > 0 ? 0.2 : 0));
    }
    this.clearEdges();
  }

  private clearEdges(): void {
    for (const c of this.ctrl.values()) c.driftPressed = false;
  }

  private stepPlayer(k: KartState, dt: number): void {
    const c = this.ctrl.get(k.id)!;
    const sample = this.track.project(k.position);
    const lat = this.track.lateralOf(k.position, sample);
    const offRoad = Math.abs(lat) > sample.halfWidth * 0.93;

    // --- hop / drift ------------------------------------------------------
    if (c.driftPressed && k.grounded) {
      this.vy = 6.2;
      k.grounded = false;
      k.hopping = true;
      bus.emit('kart:hop', { kartId: k.id, position: k.position });
    }
    const wantDrift = c.drift && Math.abs(k.speed) > 6;
    if (wantDrift && !k.drifting && Math.abs(c.steer) > 0.15) {
      k.drifting = true;
      k.driftDirection = c.steer > 0 ? 1 : -1;
      this.driftTime = 0;
      bus.emit('kart:driftStart', { kartId: k.id, direction: k.driftDirection });
    } else if (!c.drift && k.drifting) {
      const tier = k.driftStage as number;
      if (tier >= 2) {
        const boost = 0.5 + tier * 0.25;
        k.boostTime = Math.max(k.boostTime, boost);
        k.boostStrength = 1.3;
        bus.emit('kart:driftRelease', { kartId: k.id, tier, boostTime: boost });
        bus.emit('kart:boost', { kartId: k.id, duration: boost, source: 'drift' });
      }
      k.drifting = false;
      k.driftDirection = 0;
      k.driftStage = DriftStage.None;
      k.driftCharge = 0;
      this.driftTime = 0;
    }
    if (k.drifting) {
      this.driftTime += dt;
      const tiers = [0.55, 1.35, 2.4];
      let stage = DriftStage.Charging;
      if (this.driftTime > tiers[2]) stage = DriftStage.Purple;
      else if (this.driftTime > tiers[1]) stage = DriftStage.Orange;
      else if (this.driftTime > tiers[0]) stage = DriftStage.Blue;
      if (stage !== k.driftStage) {
        k.driftStage = stage;
        if (stage >= DriftStage.Blue) {
          bus.emit('kart:driftTier', { kartId: k.id, tier: stage as number, position: k.position });
        }
      }
      k.driftCharge = clamp01(this.driftTime / tiers[2]);
    }

    // --- longitudinal -----------------------------------------------------
    const boost = k.boostTime > 0 ? k.boostStrength : 0;
    const maxSpeed = TOP_SPEED * (offRoad ? 0.6 : 1) * (boost > 0 ? 1.42 : 1);
    const accel = c.accel * (boost > 0 ? 46 : 19) - c.brake * 34;
    let sp = k.speed + accel * dt;
    sp -= sp * (offRoad ? 0.9 : 0.28) * dt;
    sp = clamp(sp, -8, maxSpeed);
    k.speed = sp;

    // --- yaw --------------------------------------------------------------
    const grip = clamp01(Math.abs(sp) / 8);
    const rate = (k.drifting ? 1.55 : 1.0) * 2.3 * grip * (1 - clamp01(Math.abs(sp) / 60));
    this.heading -= c.steer * rate * dt;

    // Drift makes the travel direction lag the nose — the whole reason the
    // camera follows velocity rather than facing.
    const slipTarget = k.drifting ? k.driftDirection * 0.42 * clamp01(this.driftTime / 0.4) : 0;
    this.slip += (slipTarget - this.slip) * clamp01(dt * 9);

    const travel = this.heading + this.slip;
    k.velocity.set(Math.sin(travel) * sp, this.vy, Math.cos(travel) * sp);

    // --- integrate + ground ----------------------------------------------
    k.position.addScaledVector(k.velocity, dt);
    const groundY = this.track.groundYAt(k.position) + 0.42;
    if (!k.grounded) {
      this.vy -= GRAVITY * dt;
      k.airTime += dt;
      if (k.position.y <= groundY) {
        const impact = Math.abs(this.vy);
        k.position.y = groundY;
        this.vy = 0;
        k.grounded = true;
        k.hopping = false;
        k.airTime = 0;
        bus.emit('kart:land', { kartId: k.id, position: k.position, impact });
      }
    } else {
      // Stick to the surface; a crest that falls away faster than gravity
      // launches the kart, which is exactly what we want to film.
      const drop = k.position.y - groundY;
      if (drop > 0.35 && Math.abs(sp) > 10) {
        k.grounded = false;
        this.vy = 0;
      } else {
        k.position.y = groundY;
        this.vy = 0;
      }
    }
    if (!this.wasGrounded && k.grounded) { /* landing already emitted */ }
    this.wasGrounded = k.grounded;

    // --- walls ------------------------------------------------------------
    const s2 = this.track.project(k.position);
    const lat2 = this.track.lateralOf(k.position, s2);
    const limit = s2.halfWidth + WALL_MARGIN - 0.6;
    if (Math.abs(lat2) > limit) {
      const sgn = lat2 >= 0 ? 1 : -1;
      k.position.addScaledVector(s2.binormal, (limit - Math.abs(lat2)) * sgn);
      k.speed *= 0.72;
      bus.emit('kart:wallHit', {
        kartId: k.id, position: k.position, impact: Math.abs(k.speed) * 0.6,
        normal: _v.copy(s2.binormal).multiplyScalar(-sgn).clone(),
      });
    }

    // --- publish ----------------------------------------------------------
    k.surface = offRoad ? SurfaceType.Grass : SurfaceType.Road;
    k.speedRatio = clamp01(Math.abs(sp) / TOP_SPEED);
    k.steerAngle = c.steer * 0.5;
    k.angularVelocity = -c.steer * rate;
    const bodyUp = s2.normal;
    _v.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    _v2.copy(_v).addScaledVector(bodyUp, -_v.dot(bodyUp)).normalize();
    _v3.crossVectors(_v2, bodyUp).normalize();
    const m = new THREE.Matrix4().makeBasis(_v3, bodyUp, _v2.clone().negate());
    k.groundQuaternion.setFromRotationMatrix(m);
    k.quaternion.copy(k.groundQuaternion);
    // Visual lean into the drift.
    _q.setFromAxisAngle(_v2, -k.driftDirection * 0.12 * (k.drifting ? 1 : 0));
    k.quaternion.premultiply(_q);
    const comp = 0.5 - clamp(this.vy, -6, 6) * 0.05;
    k.suspension[0] = k.suspension[1] = k.suspension[2] = k.suspension[3] = clamp01(comp);
    for (let i = 0; i < 4; i++) k.wheelGrounded[i] = k.grounded;
  }

  /** AI stand-in: follows the centreline on rails at a steady pace. */
  private stepRail(k: KartState, dt: number): void {
    const speed = this.railSpeed.get(k.id) ?? 20;
    const L = this.track.lapLength;
    let t = this.railT.get(k.id) ?? 0;
    const boosted = speed * (k.boostTime > 0 ? 1.3 : 1);
    t = (t + (boosted * dt) / L) % 1;
    this.railT.set(k.id, t);
    const s = this.track.sampleAtDistance(t * L);
    const side = ((k.id % 2 === 0) ? -1 : 1) * 3.0;
    k.position.copy(s.position).addScaledVector(s.binormal, side).addScaledVector(s.normal, 0.42);
    k.velocity.copy(s.tangent).multiplyScalar(boosted);
    k.speed = boosted;
    k.speedRatio = clamp01(boosted / TOP_SPEED);
    this.track.quatFromSample(s, k.quaternion);
    k.groundQuaternion.copy(k.quaternion);
    k.grounded = true;
    k.surface = SurfaceType.Road;
  }

  /**
   * Teleport a kart to a normalised lap position — used by the lap tests.
   * Speed is preserved; the heading is re-aimed down the track so a teleported
   * player carries on driving in a straight line.
   */
  forceTo(kartId: number, t: number, lateral = 0): void {
    const k = this.karts[kartId];
    if (!k) return;
    const s = this.track.sampleAtDistance((((t % 1) + 1) % 1) * this.track.lapLength);
    k.position.copy(s.position).addScaledVector(s.binormal, lateral).addScaledVector(s.normal, 0.42);
    this.railT.set(kartId, ((t % 1) + 1) % 1);
    this.track.quatFromSample(s, k.quaternion);
    k.groundQuaternion.copy(k.quaternion);
    if (k.isPlayer) {
      this.heading = Math.atan2(s.tangent.x, s.tangent.z);
      this.slip = 0;
      this.vy = 0;
      k.drifting = false;
      k.driftDirection = 0;
      k.driftStage = DriftStage.None;
      this.driftTime = 0;
    }
  }

  /** Normalised lap position of the flattest, straightest stretch. */
  straightestT(): number {
    let best = 0;
    let bestK = Infinity;
    for (const s of this.track.table) {
      const score = Math.abs(s.curvature) * 400 + Math.abs(s.bank) * 4;
      if (score < bestK) { bestK = score; best = s.t; }
    }
    return best;
  }
}

/** Stand-in for AIManager. */
class TestAi {
  difficulty = 150;
  started = false;
  countdown = 0;
  enabled = new Set<number>();
  setDifficulty(cc: number): void { this.difficulty = cc; }
  setRaceStarted(started: boolean, countdown = 0): void { this.started = started; this.countdown = countdown; }
  resetRace(): void { this.enabled.clear(); }
  setEnabled(id: number, on: boolean): void { if (on) this.enabled.add(id); else this.enabled.delete(id); }
}

// ===========================================================================
//  HARNESS
// ===========================================================================

const KART_COUNT = 8;

function makeInput(): InputState {
  return {
    steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false,
    item: false, itemPressed: false, lookBack: false, startPressed: false,
    usingGamepad: false,
  };
}

interface Ctx { dt: number; fixedDt: number; elapsed: number; frame: number; alpha: number }

class Harness {
  readonly track = new TestTrack();
  readonly physics: TestPhysics;
  readonly ai = new TestAi();
  readonly input = makeInput();
  readonly camera: ChaseCamera;
  readonly race: RaceDirector;

  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly cam = new THREE.PerspectiveCamera(65, 1, 0.1, 3000);

  private readonly ctx: Ctx = { dt: FIXED_DT, fixedDt: FIXED_DT, elapsed: 0, frame: 0, alpha: 0 };
  private accumulator = 0;
  private last = 0;
  private kartMeshes: THREE.Object3D[] = [];
  private hudEl: HTMLElement;
  private helpEl: HTMLElement;
  private resultsEl: HTMLElement;
  private keys = new Set<string>();
  private hudTick = 0;

  /** Freeze the loop (still renders) — used for deterministic screenshots. */
  paused = false;
  /** QA input override; replaces the keyboard while set. */
  override: Partial<InputState> | null = null;
  /** When true, `steer` is driven by the racing-line follower. */
  autopilot = false;
  private pulses = new Set<'driftPressed' | 'itemPressed' | 'startPressed'>();

  constructor(container: HTMLElement) {
    this.physics = new TestPhysics(this.track, KART_COUNT);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    container.appendChild(this.renderer.domElement);

    this.camera = new ChaseCamera(this.cam, this.physics, this.track, this.input);
    this.race = new RaceDirector(this.physics, this.track, this.input);
    this.race.setPhysics(this.physics);
    this.race.setAi(this.ai);
    this.race.setCamera(this.camera);
    this.camera.setRace(this.race);
    this.camera.init();
    this.race.init();

    this.buildWorld();
    this.hudEl = document.getElementById('hud')!;
    this.helpEl = document.getElementById('help')!;
    this.resultsEl = document.getElementById('results')!;
    this.bindKeys();
    this.resize();
    addEventListener('resize', () => this.resize());

    this.race.beginRace({ trackId: 'bench', cc: 150, laps: 3, skipIntro: true });
    this.last = performance.now();
    requestAnimationFrame(this.loop);

    // `#shot=speed|drift|air|intro` reproduces a pose deterministically.
    const m = /shot=([a-z]+)/.exec(location.hash);
    if (m) console.log('[bench]', JSON.stringify(this.shot(m[1])));
  }

  // --- world ------------------------------------------------------------

  private buildWorld(): void {
    this.scene.background = new THREE.Color(0x0a1020);
    this.scene.fog = new THREE.Fog(0x0a1020, 220, 900);

    const sun = new THREE.DirectionalLight(0xfff2e0, 3.0);
    sun.position.set(120, 180, 90);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x2a2418, 0.9));

    // --- road ribbon ------------------------------------------------------
    const tab = this.track.table;
    const n = tab.length;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const s = tab[i % n];
      const l = _v.copy(s.position).addScaledVector(s.binormal, -s.halfWidth);
      const r = _v2.copy(s.position).addScaledVector(s.binormal, s.halfWidth);
      pos.push(l.x, l.y, l.z, r.x, r.y, r.z);
      const vv = s.distance / 7;
      uv.push(0, vv, 1, vv);
    }
    for (let i = 0; i < n; i++) {
      // Wind counter-clockwise seen from above so the surface normal is +up.
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const road = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      map: roadTexture(), roughness: 0.85, metalness: 0.0,
    }));
    this.scene.add(road);

    // --- grass verge, so "below the ground" is visible as well as measured ---
    const vp: number[] = [];
    const vi: number[] = [];
    for (let i = 0; i <= n; i++) {
      const s = tab[i % n];
      const l = _v.copy(s.position).addScaledVector(s.binormal, -(s.halfWidth + 26)).addScaledVector(s.normal, -0.4);
      const r = _v2.copy(s.position).addScaledVector(s.binormal, s.halfWidth + 26).addScaledVector(s.normal, -0.4);
      vp.push(l.x, l.y, l.z, r.x, r.y, r.z);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      vi.push(a, b, c, b, d, c);
    }
    const vg = new THREE.BufferGeometry();
    vg.setAttribute('position', new THREE.Float32BufferAttribute(vp, 3));
    vg.setIndex(vi);
    vg.computeVertexNormals();
    this.scene.add(new THREE.Mesh(vg, new THREE.MeshStandardMaterial({
      color: 0x25391f, roughness: 1.0,
    })));

    // --- guardrails -------------------------------------------------------
    for (const sgn of [-1, 1]) {
      const wp: number[] = [];
      const wi: number[] = [];
      for (let i = 0; i <= n; i++) {
        const s = tab[i % n];
        const base = _v.copy(s.position).addScaledVector(s.binormal, sgn * (s.halfWidth + WALL_MARGIN));
        wp.push(base.x, base.y, base.z, base.x, base.y + WALL_HEIGHT, base.z);
      }
      for (let i = 0; i < n; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        wi.push(a, c, b, b, c, d);
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
      wg.setIndex(wi);
      wg.computeVertexNormals();
      this.scene.add(new THREE.Mesh(wg, new THREE.MeshStandardMaterial({
        color: 0xd8dee8, roughness: 0.45, metalness: 0.3, side: THREE.DoubleSide,
      })));
    }

    // --- karts ------------------------------------------------------------
    for (let i = 0; i < KART_COUNT; i++) {
      const root = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.7, 1.9),
        new THREE.MeshStandardMaterial({
          color: i === 0 ? 0xff4d3a : new THREE.Color().setHSL((i * 0.13) % 1, 0.6, 0.5).getHex(),
          roughness: 0.4, metalness: 0.2,
        }),
      );
      body.position.y = 0.45;
      root.add(body);
      const nose = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.3, 0.5),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x223344, roughness: 0.3 }),
      );
      nose.position.set(0, 0.62, -1.0);
      root.add(nose);
      for (const [wx, wz] of [[-0.72, -0.62], [0.72, -0.62], [-0.72, 0.66], [0.72, 0.66]]) {
        const w = new THREE.Mesh(
          new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14),
          new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.7 }),
        );
        w.rotation.z = Math.PI / 2;
        w.position.set(wx, 0.32, wz);
        root.add(w);
      }
      this.scene.add(root);
      this.kartMeshes.push(root);
    }
  }

  private resize(): void {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  // --- input ------------------------------------------------------------

  private bindKeys(): void {
    addEventListener('keydown', (e) => {
      if (e.repeat) { return; }
      this.keys.add(e.code);
      switch (e.code) {
        case 'Digit1': this.camera.setMode('chase'); break;
        case 'Digit2': this.camera.setMode('chase-far'); break;
        case 'Digit3': this.camera.setMode('first-person'); break;
        case 'Digit4': this.camera.setMode('cinematic'); break;
        case 'Digit5': this.camera.setMode('replay'); break;
        case 'Digit6': this.camera.setMode('results'); break;
        case 'KeyI': void this.camera.playIntro(); break;
        case 'KeyO': this.race.beginRace({ cc: 150, laps: 3 }); break;
        case 'KeyR': this.race.restart(); break;
        case 'KeyP': this.paused = !this.paused; break;
        case 'KeyG': bus.emit('camera:shake', { amount: 0.8, seconds: 0.5 }); break;
        case 'KeyL': bus.emit('kart:land', {
          kartId: 0, position: this.physics.karts[0].position, impact: 12,
        }); break;
        case 'KeyB': this.physics.applyBoost(0, 1.6, 1.4); bus.emit('kart:boost', {
          kartId: 0, duration: 1.6, source: 'item',
        }); break;
        case 'KeyF': this.camera.playFinish(0); break;
        case 'KeyT': void this.showTests(); break;
        case 'Escape': this.resultsEl.classList.remove('on'); break;
        default: break;
      }
      if (e.code === 'Space' || e.code === 'ShiftLeft') this.input.driftPressed = true;
      if (e.code === 'KeyE') this.input.itemPressed = true;
      if (e.code === 'Enter') this.input.startPressed = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  private pollInput(): void {
    const k = this.keys;
    const i = this.input;
    i.accel = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    i.brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    i.steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    i.drift = k.has('Space') || k.has('ShiftLeft');
    i.item = k.has('KeyE');
    i.lookBack = k.has('KeyQ');
    if (this.override) Object.assign(i, this.override);
    if (this.autopilot) i.steer = clamp(this.autoSteer() + i.steer, -1, 1);
    for (const p of this.pulses) i[p] = true;
    this.pulses.clear();
  }

  /**
   * Steering that keeps the player on the racing line. Scripted shots need the
   * kart to stay on the road; open-loop sine steering just grinds the barrier.
   */
  autoSteer(gain = 2.6, lookahead = 26): number {
    const k = this.physics.karts[0];
    const s = this.track.project(k.position);
    const ahead = this.track.racingLineAt(s.t, lookahead);
    const dx = ahead.x - k.position.x;
    const dz = ahead.z - k.position.z;
    let vx = k.velocity.x, vz = k.velocity.z;
    if (Math.hypot(vx, vz) < 0.5) { vx = s.tangent.x; vz = s.tangent.z; }
    const nl = Math.hypot(vx, vz) || 1;
    vx /= nl; vz /= nl;
    // right = travel x up = (-vz, 0, vx); target . right == this cross term.
    const cross = vx * dz - vz * dx;
    const dl = Math.hypot(dx, dz) || 1;
    return clamp((cross / dl) * gain, -1, 1);
  }

  /** One-frame rising edge, for scripted hops / item taps. */
  pulse(key: 'driftPressed' | 'itemPressed' | 'startPressed'): void { this.pulses.add(key); }

  private endFrame(): void {
    this.input.driftPressed = false;
    this.input.itemPressed = false;
    this.input.startPressed = false;
  }

  // --- loop -------------------------------------------------------------

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.paused) { this.renderNow(); return; }

    this.pollInput();
    this.stepWorld(dt);
    this.syncMeshes();
    this.renderer.render(this.scene, this.cam);

    this.hudTick += dt;
    if (this.hudTick > 0.08) { this.hudTick = 0; this.writeHud(); }
    this.endFrame();
  };

  /** One display frame: fixed steps, then the display-rate systems. */
  stepWorld(dt: number): void {
    this.ctx.dt = dt;
    this.ctx.frame++;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 8) {
      this.accumulator -= FIXED_DT;
      this.ctx.elapsed += FIXED_DT;
      this.physics.fixedUpdate(FIXED_DT);
      this.race.fixedUpdate(this.ctx as FrameContext);
      steps++;
    }
    this.ctx.alpha = this.accumulator / FIXED_DT;
    this.race.update(this.ctx as FrameContext);
    this.camera.update(this.ctx as FrameContext);
  }

  private syncMeshes(): void {
    for (let i = 0; i < this.kartMeshes.length; i++) {
      const k = this.physics.karts[i];
      this.kartMeshes[i].position.copy(k.position);
      this.kartMeshes[i].quaternion.copy(k.quaternion);
    }
  }

  private writeHud(): void {
    const d = this.camera.debug;
    const r = this.race.debug;
    const k = this.physics.karts[0];
    const deg = (x: number) => (x * 180 / Math.PI).toFixed(1);
    this.hudEl.innerHTML =
      `mode      <b>${d.mode}</b>\n` +
      `distance  ${d.distance.toFixed(2)} m   (bounds ${CAMERA_TUNING.minSeparation}–${CAMERA_TUNING.maxSeparation})\n` +
      `fov       ${d.fov.toFixed(1)}°\n` +
      `yaw err   ${deg(d.yawError)}°  vs velocity\n` +
      `facing    ${deg(d.facingError)}°  vs nose\n` +
      `roll      ${deg(d.roll)}°\n` +
      `spring    pos ${d.posSpringSpeed.toFixed(2)}  look ${d.lookSpringSpeed.toFixed(2)}\n` +
      `          dist ${d.distSpringVel.toFixed(2)}  height ${d.heightSpringVel.toFixed(2)}\n` +
      `occlusion ${d.occlusion.toFixed(3)}   shake ${d.shake.toFixed(3)}\n` +
      `speed     ${(k.speed * 3.6).toFixed(0)} km/h  ratio ${d.speedRatio.toFixed(2)}  ${k.grounded ? 'ground' : 'AIR'}\n` +
      `drift     ${k.drifting ? `tier ${k.driftStage} dir ${k.driftDirection}` : '—'}  boost ${k.boostTime.toFixed(2)}\n` +
      `\n` +
      `race      <b>${r.phase}</b>  countdown ${r.countdown.toFixed(2)}  t ${r.raceTime.toFixed(2)}\n` +
      `player    P${r.playerPosition}  lap ${r.playerLap}/${this.race.totalLaps}` +
      `${r.wrongWay ? '  WRONG WAY' : ''}${r.rocketStart ? '  ROCKET' : ''}\n` +
      `order     ${this.race.order.join(' ')}\n` +
      `track     lap ${this.track.lapLength.toFixed(0)} m  minR ${this.track.minRadius.toFixed(1)} m  ` +
      `rise ${this.track.minRise.toFixed(1)}..${this.track.maxRise.toFixed(1)} m`;
    void this.helpEl;
  }

  private async showTests(): Promise<void> {
    this.resultsEl.classList.add('on');
    this.resultsEl.textContent = 'running…';
    const res = await runTests(this);
    const lines: string[] = [`CAMERA / RACE ASSERTIONS — ${res.pass ? 'ALL PASS' : 'FAILURES'}`, ''];
    for (const t of res.tests) {
      lines.push(`${t.pass ? '  PASS  ' : '  FAIL  '}${t.name.padEnd(26)} ${t.detail}`);
    }
    this.resultsEl.innerHTML = lines
      .map((l) => l.startsWith('  PASS') ? `<span class="pass">${l}</span>`
        : l.startsWith('  FAIL') ? `<span class="fail">${l}</span>` : l)
      .join('\n');
  }

  // --- test helpers -------------------------------------------------------

  /** Deterministic headless step at exactly one fixed tick, using `input` as-is. */
  tick(): void { this.stepWorld(FIXED_DT); this.endFrame(); }

  /** Draw the current state immediately — immune to rAF throttling. */
  renderNow(): void {
    this.syncMeshes();
    this.renderer.render(this.scene, this.cam);
    this.writeHud();
  }

  /**
   * Advance `seconds` deterministically using the live keyboard/override input,
   * then draw. Used for scripted screenshots — no reliance on rAF pacing.
   */
  run(seconds: number): void {
    const n = Math.max(1, Math.round(seconds / FIXED_DT));
    for (let i = 0; i < n; i++) { this.pollInput(); this.tick(); }
    this.renderNow();
  }

  /** Normalised lap position of the sharpest corner. */
  private tightestT(): number {
    let best = 0;
    let bestK = 0;
    for (const s of this.track.table) {
      const k = Math.abs(s.curvature);
      if (k > bestK) { bestK = k; best = s.t; }
    }
    return best;
  }

  /** Normalised lap position of the highest point — the crest. */
  private crestT(): number {
    let best = 0;
    let bestY = -Infinity;
    for (const s of this.track.table) {
      if (s.position.y > bestY) { bestY = s.position.y; best = s.t; }
    }
    return best;
  }

  /**
   * Reproducible scripted poses, addressable by `#shot=<name>`. Vite full-reloads
   * whenever a sibling agent writes a file, so a pose that only exists in a
   * console session evaporates; driving it from the hash survives reloads.
   */
  shot(name: string): Record<string, number | string | boolean> {
    const C = { accel: 1, brake: 0, steer: 0, drift: false, lookBack: false, item: false };
    this.paused = true;
    this.autopilot = true;
    this.camera.setMode('chase');
    const k = this.physics.karts[0];

    if (name === 'intro') {
      this.autopilot = false;
      this.override = { ...C, accel: 0 };
      this.race.beginRace({ cc: 150, laps: 3 });
      this.run(3.1);
    } else if (name === 'drift') {
      this.override = { ...C };
      this.race.beginRace({ cc: 150, laps: 12, skipIntro: true });
      this.run(3.7);
      // Line up 45 m before the hairpin, at pace, then hold the drift through it.
      const t = this.tightestT() - 45 / this.track.lapLength;
      this.physics.forceTo(0, t);
      this.run(2.2);
      this.physics.forceTo(0, t);
      this.run(1.4);
      this.override = { ...C, drift: true };
      this.pulse('driftPressed');
      this.run(1.5);
    } else if (name === 'air') {
      this.override = { ...C };
      this.race.beginRace({ cc: 150, laps: 12, skipIntro: true });
      this.run(3.7);
      const t = this.crestT() - 70 / this.track.lapLength;
      this.physics.forceTo(0, t);
      this.run(2.6);
      this.physics.forceTo(0, t);
      this.run(1.4);
      this.pulse('driftPressed');           // hop, then the crest launches it
      this.runUntil(() => !k.grounded, 3.0);
      this.run(0.16);
    } else {
      // 'speed'
      this.override = { ...C };
      this.race.beginRace({ cc: 150, laps: 12, skipIntro: true });
      this.run(3.7);
      this.run(8.0);
      this.physics.applyBoost(0, 2.4, 1.5);
      this.run(0.6);
    }

    const d = this.camera.debug;
    this.renderNow();
    return {
      shot: name, phase: this.race.state, kmh: Math.round(k.speed * 3.6),
      fov: +d.fov.toFixed(1), distance: +d.distance.toFixed(2),
      speedRatio: +d.speedRatio.toFixed(2), rollDeg: +(d.roll * 57.2958).toFixed(2),
      yawErrDeg: +(d.yawError * 57.2958).toFixed(1), grounded: k.grounded,
      drifting: k.drifting, driftStage: k.driftStage as number, mode: d.mode,
    };
  }

  /** Step until `predicate` is true or `maxSeconds` elapse. Returns seconds used. */
  runUntil(predicate: () => boolean, maxSeconds: number): number {
    const n = Math.max(1, Math.round(maxSeconds / FIXED_DT));
    for (let i = 0; i < n; i++) {
      this.pollInput();
      this.tick();
      if (predicate()) { this.renderNow(); return (i + 1) * FIXED_DT; }
    }
    this.renderNow();
    return -1;
  }

  setInput(patch: Partial<InputState>): void { Object.assign(this.input, patch); }
}

// ---------------------------------------------------------------------------
//  road texture (procedural, no network)
// ---------------------------------------------------------------------------

function roadTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a3f47';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 40 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 6},0.5)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  // Kerb edges + centre dashes.
  for (let y = 0; y < 256; y += 32) {
    g.fillStyle = (y / 32) % 2 === 0 ? '#e8e8ee' : '#d0413a';
    g.fillRect(0, y, 10, 32);
    g.fillRect(246, y, 10, 32);
  }
  g.fillStyle = 'rgba(240,240,250,0.75)';
  for (let y = 0; y < 256; y += 48) g.fillRect(126, y, 4, 26);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ===========================================================================
//  ASSERTION SUITE
// ===========================================================================

interface TestResult { name: string; pass: boolean; detail: string }
interface TestReport { pass: boolean; tests: TestResult[]; numbers: Record<string, number> }

function finite(...xs: number[]): boolean { for (const x of xs) if (!isFinite(x)) return false; return true; }

/**
 * Read the race phase through a call so the checker treats it as a fresh
 * observation rather than a narrowed readonly property.
 */
function phaseOf(race: RaceDirector): string { return race.state; }

/** Spin the countdown out, with a hard step budget. */
function runCountdown(h: Harness): void {
  for (let i = 0; i < 900; i++) {
    if (phaseOf(h.race) !== 'countdown') return;
    h.tick();
  }
}

export async function runTests(h: Harness): Promise<TestReport> {
  const tests: TestResult[] = [];
  const numbers: Record<string, number> = {};
  const add = (name: string, pass: boolean, detail: string) => tests.push({ name, pass, detail });

  const cam = h.camera;
  const race = h.race;
  const track = h.track;
  const player = h.physics.karts[0];

  // -----------------------------------------------------------------------
  // 1. State machine: idle -> countdown -> racing, with 3/2/1/GO beats.
  // -----------------------------------------------------------------------
  {
    const beats: number[] = [];
    const off = bus.on('race:countdown', (p) => beats.push(p.count));
    race.abortRace();
    const wasIdle = phaseOf(race) === 'idle';
    race.beginRace({ cc: 150, laps: 3, skipIntro: true });
    const wasCountdown = phaseOf(race) === 'countdown';
    let sawRacing = false;
    h.setInput({ accel: 0 });
    for (let i = 0; i < 700; i++) { h.tick(); if (phaseOf(race) === 'racing') { sawRacing = true; break; } }
    off();
    const ok = wasIdle && wasCountdown && sawRacing
      && beats.join(',') === '3,2,1,0';
    add('stateMachine', ok,
      `idle=${wasIdle} countdown=${wasCountdown} racing=${sawRacing} beats=[${beats.join(',')}]`);
    numbers.countdownBeats = beats.length;
  }

  // -----------------------------------------------------------------------
  // 2. Rocket start / burnout adjudication.
  // -----------------------------------------------------------------------
  {
    race.beginRace({ cc: 150, laps: 3, skipIntro: true });
    h.setInput({ accel: 0 });
    // Hold the throttle only inside the last 0.3 s.
    while (phaseOf(race) === 'countdown') {
      h.setInput({ accel: race.countdown <= 0.30 ? 1 : 0 });
      h.tick();
    }
    const rocket = race.didRocketStart;

    race.beginRace({ cc: 150, laps: 3, skipIntro: true });
    h.setInput({ accel: 1 });               // held from the very first light
    runCountdown(h);
    const jumped = race.didRocketStart;
    const burnout = race.debug.burnout > 0;
    h.setInput({ accel: 0 });
    add('rocketStart', rocket && !jumped && burnout,
      `late-hold=${rocket} early-hold-rocket=${jumped} burnout=${burnout} (${race.debug.burnout.toFixed(2)} s)`);
  }

  // -----------------------------------------------------------------------
  // 3. Lap counting across the t-wrap, forwards and backwards.
  // -----------------------------------------------------------------------
  {
    race.beginRace({ cc: 150, laps: 3, skipIntro: true });
    runCountdown(h);
    const laps: Array<{ lap: number; t: number }> = [];
    const off = bus.on('race:lap', (p) => { if (p.kartId === 0) laps.push({ lap: p.lap, t: p.lapTime }); });

    // Walk the kart forward around the whole lap in 240 hops so every
    // checkpoint region is visited in order, then over the line.
    const walk = (from: number, to: number, steps: number) => {
      for (let i = 1; i <= steps; i++) {
        h.physics.forceTo(0, from + (to - from) * (i / steps));
        h.tick();
      }
    };
    // The grid sits behind the line, so the first crossing is the *start*, not
    // a lap. Bank that first, then measure real laps from there.
    const gridLap = race.getRawLap(0);
    walk(0.0, 0.004, 2);
    const lap0 = race.getRawLap(0);
    walk(0.004, 0.999, 260);          // full lap 1
    walk(0.999, 1.004, 4);            // cross the line: t 0.999 -> 0.004
    const afterFwd = race.getRawLap(0);
    // Reverse back over the line: t 0.004 -> 0.996
    walk(1.004, 0.996, 4);
    const afterBack = race.getRawLap(0);
    // …and forward again; the lap must come straight back.
    walk(0.996, 1.002, 4);
    const afterRe = race.getRawLap(0);
    off();

    const ok = gridLap === 0 && lap0 === 1
      && afterFwd === lap0 + 1 && afterBack === lap0 && afterRe === lap0 + 1 && laps.length >= 1;
    add('lapWrap', ok,
      `grid=${gridLap} afterStartLine=${lap0} forward=${afterFwd} reversed=${afterBack} ` +
      `re-crossed=${afterRe} lapEvents=${laps.length}`);
    numbers.lapOnGrid = gridLap;
    numbers.lapAfterStart = lap0;
    numbers.lapAfterForward = afterFwd;
    numbers.lapAfterBackward = afterBack;
    numbers.lapAfterRecross = afterRe;
  }

  // -----------------------------------------------------------------------
  // 4. Ranking: progress order, and positionChange on a swap.
  // -----------------------------------------------------------------------
  {
    race.beginRace({ cc: 150, laps: 3, skipIntro: true });
    runCountdown(h);
    const changes: Array<{ id: number; from: number; to: number }> = [];
    const off = bus.on('race:positionChange', (p) => changes.push({ id: p.kartId, from: p.from, to: p.to }));
    h.physics.forceTo(0, 0.10); h.physics.forceTo(1, 0.30);
    for (let i = 0; i < 6; i++) { h.physics.forceTo(0, 0.10); h.physics.forceTo(1, 0.30); h.tick(); }
    const leaderIsOne = race.getPosition(1) < race.getPosition(0);
    for (let i = 0; i < 6; i++) { h.physics.forceTo(0, 0.55); h.physics.forceTo(1, 0.30); h.tick(); }
    const leaderIsZero = race.getPosition(0) < race.getPosition(1);
    off();
    add('ranking', leaderIsOne && leaderIsZero && changes.length > 0,
      `kart1-ahead=${leaderIsOne} then-kart0-ahead=${leaderIsZero} changes=${changes.length}`);
    numbers.positionChanges = changes.length;
  }

  // -----------------------------------------------------------------------
  // 5. 120 s of scripted driving: ground clearance, FOV, distance, NaN.
  // -----------------------------------------------------------------------
  {
    race.beginRace({ cc: 150, laps: 12, skipIntro: true });
    runCountdown(h);
    cam.setMode('chase');

    let minClear = Infinity, minFov = Infinity, maxFov = -Infinity;
    let minDist = Infinity, maxDist = -Infinity;
    let nan = 0;
    let maxShake = 0;
    const steps = Math.round(120 / FIXED_DT);
    for (let i = 0; i < steps; i++) {
      const t = i * FIXED_DT;
      // Scripted lap: full throttle, sinusoidal steering, drift bursts,
      // periodic hops, look-behind sweeps.
      const steer = Math.sin(t * 0.55) * 0.9 + Math.sin(t * 1.9) * 0.25;
      const drift = Math.sin(t * 0.33) > 0.45;
      h.setInput({
        accel: 1, brake: t % 17 < 0.4 ? 1 : 0, steer: clamp(steer, -1, 1),
        drift, driftPressed: drift && Math.abs((t % 3.0) - 0) < FIXED_DT,
        lookBack: t % 23 < 1.2,
      });
      h.tick();

      const p = h.cam.position;
      if (!finite(p.x, p.y, p.z, h.cam.fov)) nan++;
      if (!finite(player.position.x, player.position.y, player.position.z, player.speed)) nan++;
      const gy = track.groundYAt(p);
      minClear = Math.min(minClear, p.y - gy);
      minFov = Math.min(minFov, h.cam.fov);
      maxFov = Math.max(maxFov, h.cam.fov);
      const d = p.distanceTo(player.position);
      minDist = Math.min(minDist, d);
      maxDist = Math.max(maxDist, d);
      maxShake = Math.max(maxShake, cam.debug.shake);
    }

    // --- and a top-speed straight, so the FOV/distance ceilings are actually
    //     exercised rather than merely bounded.
    let topSpeed = 0;
    h.physics.forceTo(0, h.physics.straightestT());
    for (let i = 0; i < Math.round(9 / FIXED_DT); i++) {
      const t = i * FIXED_DT;
      if (i % Math.round(2.5 / FIXED_DT) === 0) {
        h.physics.applyBoost(0, 1.8, 1.5);
        bus.emit('kart:boost', { kartId: 0, duration: 1.8, source: 'pad' });
      }
      h.setInput({ accel: 1, brake: 0, steer: Math.sin(t * 0.7) * 0.06, drift: false, lookBack: false });
      h.tick();
      const p = h.cam.position;
      if (!finite(p.x, p.y, p.z, h.cam.fov)) nan++;
      minClear = Math.min(minClear, p.y - track.groundYAt(p));
      minFov = Math.min(minFov, h.cam.fov);
      maxFov = Math.max(maxFov, h.cam.fov);
      const d = p.distanceTo(player.position);
      minDist = Math.min(minDist, d);
      maxDist = Math.max(maxDist, d);
      topSpeed = Math.max(topSpeed, player.speed);
    }
    h.setInput({ accel: 0, steer: 0, drift: false, lookBack: false, brake: 0 });

    numbers.topSpeedReached = topSpeed;
    numbers.minGroundClearance = minClear;
    numbers.minFov = minFov; numbers.maxFov = maxFov;
    numbers.minDistance = minDist; numbers.maxDistance = maxDist;
    numbers.nanCount = nan;
    numbers.maxShake = maxShake;

    add('groundClearance', minClear > 0,
      `min ${minClear.toFixed(3)} m above road over 129 s`);
    add('fovRange', minFov >= 60 - 1e-3 && maxFov <= 92 + 1e-3,
      `${minFov.toFixed(2)}° … ${maxFov.toFixed(2)}° (allowed 60–92), top speed ` +
      `${topSpeed.toFixed(1)} m/s`);
    add('cameraDistance', minDist >= 3.5 && maxDist <= 9.0,
      `${minDist.toFixed(3)} … ${maxDist.toFixed(3)} m (allowed 3.5–9)`);
    add('noNaN', nan === 0, `${nan} non-finite samples in ${steps + Math.round(9 / FIXED_DT)} steps (129 s)`);
  }

  // -----------------------------------------------------------------------
  // 6. Yaw settles within 0.6 s of a drift ending.
  // -----------------------------------------------------------------------
  {
    race.beginRace({ cc: 150, laps: 12, skipIntro: true });
    runCountdown(h);
    cam.setMode('chase');
    // Launch down the flattest, straightest stretch so the only thing moving
    // the camera at the end of the test is the camera itself.
    h.physics.forceTo(0, h.physics.straightestT());
    h.setInput({ accel: 1, steer: 0, drift: false, lookBack: false, brake: 0 });
    for (let i = 0; i < Math.round(2.2 / FIXED_DT); i++) h.tick();

    // A 0.7 s right-hand drift: enough to build a real slip angle without
    // putting the kart into the guardrail.
    h.setInput({ accel: 1, steer: 0.35, drift: true, driftPressed: true });
    h.tick();
    h.setInput({ accel: 1, steer: 0.35, drift: true, driftPressed: false });
    for (let i = 0; i < Math.round(0.7 / FIXED_DT); i++) h.tick();
    const errAtRelease = Math.abs(cam.debug.yawError);

    // Release and hold a straight line.
    h.setInput({ accel: 1, steer: 0, drift: false });

    const limit = 0.05;      // ~2.9°
    // "Settled" means the last time it was ever above the limit — a camera that
    // dips under and then wobbles back out has not settled.
    let lastAbove = -FIXED_DT;
    let worst = 0;
    const window = 0.9;
    const maxSteps = Math.round(window / FIXED_DT);
    for (let i = 0; i < maxSteps; i++) {
      h.tick();
      const err = Math.abs(cam.debug.yawError);
      worst = Math.max(worst, err);
      if (err >= limit) lastAbove = i * FIXED_DT;
    }
    const settleAt = lastAbove + FIXED_DT;
    numbers.yawErrorAtDriftRelease = errAtRelease;
    numbers.yawSettleSeconds = settleAt;
    numbers.yawWorstDuringSettle = worst;
    add('yawSettle', settleAt >= 0 && settleAt <= 0.6 && errAtRelease > limit,
      `${settleAt.toFixed(3)} s for |yawErr| to stay under ${limit} rad after the drift ` +
      `(budget 0.60 s); ${errAtRelease.toFixed(4)} rad at release, peak ${worst.toFixed(4)} rad`);
  }

  // -----------------------------------------------------------------------
  // 7. Intro lands on the chase pose.
  // -----------------------------------------------------------------------
  {
    /**
     * Play the flyby and measure the jump between the last frame of the shot
     * and the first frame of gameplay framing. Run twice: parked (a pure
     * measure of the authored landing) and rolling (the real case, where the
     * chase target is still moving under the cut).
     */
    const measureIntro = async (moving: boolean): Promise<{ seam: number; frames: number }> => {
      race.beginRace({ cc: 150, laps: 12, skipIntro: true });
      h.setInput({ accel: 0, steer: 0, drift: false, lookBack: false, brake: 0 });
      runCountdown(h);
      h.physics.forceTo(0, h.physics.straightestT());
      if (moving) {
        h.setInput({ accel: 1 });
        for (let i = 0; i < Math.round(2.5 / FIXED_DT); i++) h.tick();
      } else {
        h.physics.setFrozen(true);
        for (let i = 0; i < 60; i++) h.tick();
      }

      const before = new THREE.Vector3();
      let seam = -1;
      let frames = 0;
      let wasIntro = false;
      const p = cam.playIntro();
      for (let i = 0; i < Math.round(11 / FIXED_DT); i++) {
        if (cam.getMode() === 'intro') {
          wasIntro = true;
          frames++;
          before.copy(h.cam.position);
        } else if (wasIntro) {
          seam = before.distanceTo(h.cam.position);
          break;
        }
        h.tick();
        await Promise.resolve();      // let the intro promise settle
      }
      await p;
      h.physics.setFrozen(false);
      h.setInput({ accel: 0 });
      return { seam, frames };
    };

    const parked = await measureIntro(false);
    const rolling = await measureIntro(true);
    numbers.introSeamParkedMetres = parked.seam;
    numbers.introSeamRollingMetres = rolling.seam;
    numbers.introFrames = parked.frames;
    const ok = parked.seam >= 0 && parked.seam <= 0.15
      && rolling.seam >= 0 && rolling.seam <= 0.15
      && parked.frames > 300;   // the shot really ran (~6.2 s at 120 Hz)
    add('introLanding', ok,
      `parked ${parked.seam.toFixed(4)} m, rolling ${rolling.seam.toFixed(4)} m ` +
      `(budget 0.15 m); shot ran ${parked.frames} frames`);
  }

  // -----------------------------------------------------------------------
  // 8. Full race to completion: finish order, results, race:complete.
  // -----------------------------------------------------------------------
  {
    let complete: ReadonlyArray<{ kartId: number; position: number; time: number }> = [];
    const off = bus.on('race:complete', (p) => { complete = p.results; });
    race.beginRace({ cc: 150, laps: 1, skipIntro: true });
    runCountdown(h);
    // Teleport every kart around a single lap so the whole field finishes.
    for (let lapStep = 1; lapStep <= 320; lapStep++) {
      const t = lapStep / 300;
      for (let id = 0; id < KART_COUNT; id++) h.physics.forceTo(id, t * (1 - id * 0.0006));
      h.tick();
    }
    for (let i = 0; i < Math.round(20 / FIXED_DT); i++) {
      h.tick();
      if (phaseOf(race) === 'results') break;
    }
    off();
    const rs = race.results;
    const positionsOk = rs.length === KART_COUNT
      && rs.every((r, i) => r.position === i + 1);
    add('raceComplete', phaseOf(race) === 'results' && positionsOk && complete.length === KART_COUNT,
      `state=${phaseOf(race)} results=${rs.length} contiguous=${positionsOk} event=${complete.length}`);
    numbers.resultRows = rs.length;
  }

  // -----------------------------------------------------------------------
  // 9. Pause gates the sim; resume restores the phase.
  // -----------------------------------------------------------------------
  {
    race.beginRace({ cc: 150, laps: 3, skipIntro: true });
    runCountdown(h);
    h.setInput({ accel: 1 });
    for (let i = 0; i < 120; i++) h.tick();
    race.pause();
    const t0 = race.raceTime;
    const p0 = player.position.clone();
    for (let i = 0; i < 120; i++) h.tick();
    const frozen = race.raceTime === t0 && p0.distanceTo(player.position) < 1e-6;
    race.resume();
    for (let i = 0; i < 30; i++) h.tick();
    const resumed = phaseOf(race) === 'racing' && race.raceTime > t0;
    h.setInput({ accel: 0 });
    add('pauseResume', frozen && resumed,
      `frozen=${frozen} resumedPhase=${phaseOf(race)} clock ${t0.toFixed(2)}→${race.raceTime.toFixed(2)}`);
  }

  // -----------------------------------------------------------------------
  // 10. Track sanity — the bench itself must be a real circuit.
  // -----------------------------------------------------------------------
  {
    numbers.lapLength = track.lapLength;
    numbers.minCornerRadius = track.minRadius;
    numbers.riseRange = track.maxRise - track.minRise;
    const ok = track.lapLength > 500 && track.minRadius > 12 && track.minRadius < 60
      && numbers.riseRange > 6;
    add('trackShape', ok,
      `lap ${track.lapLength.toFixed(0)} m, tightest radius ${track.minRadius.toFixed(1)} m, ` +
      `elevation range ${numbers.riseRange.toFixed(1)} m`);
  }

  // reset to a clean racing state for interactive use
  race.beginRace({ cc: 150, laps: 3, skipIntro: true });
  return { pass: tests.every((t) => t.pass), tests, numbers };
}

// ===========================================================================
//  BOOT
// ===========================================================================

declare global {
  interface Window {
    __CAM__?: {
      harness: Harness;
      camera: ChaseCamera;
      race: RaceDirector;
      track: TestTrack;
      physics: TestPhysics;
      setMode: (m: CameraMode) => void;
      runTests: () => Promise<TestReport>;
    };
  }
}

const container = document.getElementById('app');
if (container) {
  const h = new Harness(container);
  window.__CAM__ = {
    harness: h,
    camera: h.camera,
    race: h.race,
    track: h.track,
    physics: h.physics,
    setMode: (m: CameraMode) => h.camera.setMode(m),
    runTests: () => runTests(h),
  };
}
