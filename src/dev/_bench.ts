/* eslint-disable */
/**
 * Headless numeric bench for the physics agent. NOT part of the game.
 * Built with `vite build --ssr` and run under node — see the agent's report.
 * Deleted when the task is done.
 */
import * as THREE from 'three';
import type {
  FrameContext,
  GroundHit,
  ITrackService,
  KartState,
  TrackSample,
  WallHit,
} from '@/core/Types';
import { DriftStage, SurfaceType } from '@/core/Types';
import { FIXED_DT } from '@/core/Config';
import { bus } from '@/core/EventBus';
import { clamp, moveTowards } from '@/core/MathUtils';
import { PhysicsWorld } from '@/physics/PhysicsWorld';
import { CHARACTER_STATS, makeTuning } from '@/physics/Tuning';

// ---------------------------------------------------------------------------
//  A corridor: flat (optionally banked about z) ground, two vertical walls.
// ---------------------------------------------------------------------------

const WALL_X = 11;
const WALL_H = 1.4;

class BenchTrack implements ITrackService {
  readonly lapLength = 4000;
  readonly lapCount = 3;

  /** Bank about the z axis, radians. Ground plane: y = -x*tan(bank). */
  bank = 0;
  /** Set huge to remove the walls entirely (control runs). */
  wallX = WALL_X;

  /** Instrumentation. */
  wallQueryHits = 0;

  private _s: TrackSample = {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: WALL_X,
    t: 0,
    distance: 0,
    curvature: 0,
    bank: 0,
  };
  private _g: GroundHit = {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    surface: SurfaceType.Road,
  };
  private _w: WallHit = {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(1, 0, 0),
    depth: 0,
  };
  private _n = new THREE.Vector3(0, 1, 0);

  planeNormal(): THREE.Vector3 {
    return this._n.set(Math.sin(this.bank), Math.cos(this.bank), 0);
  }
  surfaceY(x: number): number {
    return -x * Math.tan(this.bank);
  }

  private fill(d: number): TrackSample {
    const s = this._s;
    const n = this.planeNormal();
    s.position.set(0, 0, -d);
    s.tangent.set(0, 0, -1);
    s.normal.copy(n);
    s.binormal.copy(s.tangent).cross(s.normal).normalize();
    s.distance = d;
    s.t = (d / this.lapLength) % 1;
    s.bank = this.bank;
    return s;
  }
  sampleAt(t: number): TrackSample {
    return this.fill(t * this.lapLength);
  }
  sampleAtDistance(d: number): TrackSample {
    return this.fill(d);
  }
  project(p: THREE.Vector3): TrackSample {
    return this.fill(-p.z);
  }

  raycastGround(origin: THREE.Vector3, up: THREE.Vector3, maxDist: number): GroundHit {
    const g = this._g;
    g.hit = false;
    const n = this.planeNormal();
    const denom = n.dot(up);
    if (denom <= 1e-6) return g;
    const t = n.dot(origin) / denom; // travel along -up
    if (t < -0.001 || t > maxDist) return g;
    g.hit = true;
    g.point.copy(origin).addScaledVector(up, -t);
    g.normal.copy(n);
    g.distance = t;
    g.surface = SurfaceType.Road;
    return g;
  }

  collideWalls(position: THREE.Vector3, radius: number): WallHit {
    const w = this._w;
    w.hit = false;
    w.depth = 0;
    const sy = this.surfaceY(position.x);
    if (position.y < sy - 0.55 || position.y > sy + WALL_H + 0.7) return w;
    let bestDepth = 0;
    let bestSide = 1;
    let bestGap = 0;
    for (const side of [-1, 1]) {
      const clearance = this.wallX - side * position.x;
      if (clearance > radius) continue;
      const depth = radius - clearance;
      if (depth > bestDepth) {
        bestDepth = depth;
        bestSide = side;
        bestGap = clearance;
      }
    }
    if (bestDepth <= 0) return w;
    w.hit = true;
    w.depth = bestDepth;
    w.point.set(bestSide * this.wallX, position.y, position.z);
    w.normal.set(-bestSide, 0, 0);
    this.wallQueryHits++;
    return w;
  }

  surfaceAt(): SurfaceType {
    return SurfaceType.Road;
  }
  racingLineAt(t: number, lookahead: number): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -(t * this.lapLength + lookahead));
  }
  getStartPosition(index: number) {
    return { position: new THREE.Vector3(0, 0.5, index * 3), quaternion: new THREE.Quaternion() };
  }
  getRespawn(t: number) {
    const d = t * this.lapLength;
    return { position: new THREE.Vector3(0, 0.5, -d), quaternion: new THREE.Quaternion() };
  }
  isOutOfBounds(p: THREE.Vector3): boolean {
    return Math.abs(p.x) > 60 || p.y < this.surfaceY(p.x) - 25;
  }
}

// ---------------------------------------------------------------------------

function makeKartState(id: number, isPlayer: boolean): KartState {
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

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 0x100000000;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
}

// ---------------------------------------------------------------------------

const KART_COUNT = 12;
const track = new BenchTrack();
const physics = new PhysicsWorld(track);
const karts: KartState[] = [];
const CHARS = Object.keys(CHARACTER_STATS);
for (let i = 0; i < KART_COUNT; i++) {
  const st = makeKartState(i, i === 0);
  karts.push(st);
  physics.setTuning(i, makeTuning(CHARS[i % CHARS.length], 150));
}
physics.setKarts(karts);

const ctxT = { dt: FIXED_DT, fixedDt: FIXED_DT, elapsed: 0, frame: 0, alpha: 0 };
const testCtx = ctxT as unknown as FrameContext;

function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    ctxT.elapsed += FIXED_DT;
    ctxT.frame++;
    physics.fixedUpdate(testCtx);
  }
}
function solo(): void {
  physics.setKarts([karts[0]]);
  physics.setTuning(0, makeTuning('nova', 150));
}
const IDLE = { steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false };
function ctrl(steer: number, accel: number, brake = 0, drift = false, driftPressed = false) {
  return { steer, accel, brake, drift, driftPressed };
}

/** Place kart 0 on the plane at (x,z), heading `degRight` off -Z, at `speed`. */
function place(x: number, z: number, speed: number, degRight = 0): void {
  const up = track.planeNormal().clone();
  const rad = (degRight * Math.PI) / 180;
  const fwd = new THREE.Vector3(Math.sin(rad), 0, -Math.cos(rad));
  fwd.addScaledVector(up, -fwd.dot(up)).normalize();
  const right = new THREE.Vector3().copy(fwd).cross(up).normalize();
  const back = new THREE.Vector3().copy(fwd).multiplyScalar(-1);
  const q = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, back),
  );
  // Natural ride height ≈ |hubY| + (rest - sag) + wheelRadius ≈ 0.71 m. Dropping
  // the chassis in below that bottoms the springs and LAUNCHES the kart, which
  // silently put the first revision of this bench on the airborne yaw branch.
  const pos = new THREE.Vector3(x, track.surfaceY(x), z).addScaledVector(up, 0.78);
  physics.place(0, pos, q);
  physics.setControl(0, IDLE);
  step(150);
  const b = physics.getBody(0)!;
  if (!b.grounded) say(`  !! place(): kart not grounded after settle (airTime ${b.airTime.toFixed(2)})`);
  b.velocity.copy(b.forward).multiplyScalar(speed);
  b.forwardSpeed = speed;
}

const out: string[] = [];
function say(s: string): void {
  out.push(s);
}
function head(s: string): void {
  say('');
  say('### ' + s);
}

// ===========================================================================
//  1. WALL IMPACT BY ANGLE
// ===========================================================================

interface WallResult {
  deg: number;
  entry: number;
  exit: number;
  retain: number;
  min: number;
  minRetain: number;
  contactTicks: number;
  penalties: number;
  yawKick: number;
  driftBroken: boolean;
}

function wallImpactsOf(): number {
  const b = physics.getBody(0)! as unknown as { wallImpacts?: number };
  return b.wallImpacts ?? -1;
}
/** What PHYSICS thinks — not what the track mock was asked. */
function wallContactOf(): boolean {
  const b = physics.getBody(0)! as unknown as { wallContact?: boolean };
  return b.wallContact === true;
}

function fireAtWall(deg: number, speed: number): WallResult {
  solo();
  track.wallX = WALL_X;
  const rad = (deg * Math.PI) / 180;
  // Start far enough out that the run-up is short in every direction.
  const runup = 3.0;
  const x0 = WALL_X - 0.9 - Math.max(0.4, Math.sin(rad)) * runup;
  const z0 = 0;
  place(x0, z0, speed, deg);
  const b = physics.getBody(0)!;
  const p0 = wallImpactsOf();

  let entry = -1;
  let exit = -1;
  let at250 = -1;
  let atTick = -1;
  let min = 1e9;
  let contactTicks = 0;
  let sinceContact = 999;
  let sinceFirst = 0;
  let yawPeak = 0;
  let firstSeen = false;

  for (let i = 0; i < 120 * 4; i++) {
    // Throttle held (what a player actually does), no steering.
    physics.setControl(0, ctrl(0, 1));
    const before = b.velocity.length();
    step(1);
    const contacted = wallContactOf();
    if (contacted) {
      if (!firstSeen) {
        firstSeen = true;
        entry = before;
      }
      contactTicks++;
      sinceContact = 0;
      exit = b.velocity.length();
      // The tick on which the penalty was actually charged: the pure impact cost.
      if (atTick < 0 && wallImpactsOf() > p0) atTick = b.velocity.length();
      yawPeak = Math.max(yawPeak, Math.abs(b.yawRate));
    } else if (firstSeen) {
      sinceContact++;
    }
    if (firstSeen) {
      sinceFirst++;
      min = Math.min(min, b.velocity.length());
      // Snapshot 0.25 s after first touch: the impact response has fully played
      // out but a long grind has not yet had time to matter.
      if (sinceFirst === 30) at250 = b.velocity.length();
    }
    if (firstSeen && sinceContact > 6) break;
  }
  if (at250 < 0) at250 = exit;
  if (atTick < 0) atTick = exit;
  return {
    deg,
    entry,
    exit,
    at250,
    atTick,
    tickRetain: atTick / entry,
    retain: at250 / entry,
    episodeRetain: exit / entry,
    min,
    minRetain: min / entry,
    contactTicks,
    penalties: wallImpactsOf() - p0,
    yawKick: yawPeak,
  };
}

function tWallAngles(): void {
  head('Wall impact at 30 m/s — retained speed by impact angle');
  say('  impact  = |v| on the tick the penalty was charged / |v| the tick before contact.');
  say('  @0.25s  = same, 0.25 s later (impact resolved, grind not yet significant).');
  say('  Episode = |v| at the end of the whole contact (a shallow hit then GRINDS the wall');
  say('            for the rest of the run because nothing steers it away).');
  say('  deg |  entry  | impact | @0.25s | episode | min |v| | minRet | contactTicks | pen | peak|yaw|');
  for (const deg of [5, 15, 30, 60, 90]) {
    const r = fireAtWall(deg, 30);
    say(
      `  ${String(deg).padStart(3)} | ${r.entry.toFixed(2).padStart(7)} | ${(
        r.tickRetain * 100
      )
        .toFixed(1)
        .padStart(5)}% | ${(r.retain * 100).toFixed(1).padStart(5)}% | ${(
        r.episodeRetain * 100
      )
        .toFixed(1)
        .padStart(6)}% | ${r.min.toFixed(2).padStart(7)} | ${(r.minRetain * 100)
        .toFixed(1)
        .padStart(5)}% | ${String(r.contactTicks).padStart(12)} | ${String(r.penalties).padStart(
        3,
      )} | ${r.yawKick.toFixed(2).padStart(8)}`,
    );
  }
}

// ===========================================================================
//  2. WALL HUGGING
// ===========================================================================

function tWallHug(): void {
  head('Wall hugging');

  // --- 2a: parked hard against the wall, 3 s, no input --------------------
  solo();
  track.wallX = WALL_X;
  place(WALL_X - 0.6, 0, 0, 0);
  const b = physics.getBody(0)!;
  const p0 = wallImpactsOf();
  let contactTicks = 0;
  let events = 0;
  const off = bus.on('kart:wallHit', () => events++);
  for (let i = 0; i < 120 * 3; i++) {
    physics.setControl(0, IDLE);
    step(1);
    if (wallContactOf()) contactTicks++;
  }
  off();
  say(
    `  parked 3 s: contactTicks ${contactTicks}/360, penalised impacts ${
      wallImpactsOf() - p0
    }, kart:wallHit events ${events}, |v| ${b.velocity.length().toFixed(3)} m/s`,
  );

  // --- 2b: driving along the wall with steering pressure into it ----------
  const run = (withWall: boolean): { v: number; contactTicks: number; penalties: number; events: number } => {
    solo();
    track.wallX = withWall ? WALL_X : 5000;
    place(withWall ? WALL_X - 0.85 : 0, 0, 18, 0);
    const bb = physics.getBody(0)!;
    const base = wallImpactsOf();
    let ct = 0;
    let ev = 0;
    const o = bus.on('kart:wallHit', () => ev++);
    for (let i = 0; i < 120 * 3; i++) {
      physics.setControl(0, ctrl(0.35, 1));
      step(1);
      if (wallContactOf()) ct++;
    }
    o();
    return { v: bb.velocity.length(), contactTicks: ct, penalties: wallImpactsOf() - base, events: ev };
  };
  const w = run(true);
  const f = run(false);
  say(
    `  3 s grinding the wall at 18 m/s entry, steer 0.35 into it, full throttle:`,
  );
  say(
    `     with wall: |v| ${w.v.toFixed(2)} m/s, contactTicks ${w.contactTicks}/360, penalised impacts ${w.penalties}, spark events ${w.events}`,
  );
  say(`     no wall  : |v| ${f.v.toFixed(2)} m/s   →  wall cost ${((1 - w.v / f.v) * 100).toFixed(1)}%`);

  // --- 2c: full-lock into the wall for 3 s (the worst case) ---------------
  const run2 = (withWall: boolean): { v: number; ct: number; pen: number } => {
    solo();
    track.wallX = withWall ? WALL_X : 5000;
    place(withWall ? WALL_X - 0.85 : 0, 0, 22, 0);
    const bb = physics.getBody(0)!;
    const base = wallImpactsOf();
    let ct = 0;
    for (let i = 0; i < 120 * 3; i++) {
      physics.setControl(0, ctrl(1, 1));
      step(1);
      if (wallContactOf()) ct++;
    }
    return { v: bb.velocity.length(), ct, pen: wallImpactsOf() - base };
  };
  const w2 = run2(true);
  say(
    `  3 s of FULL LOCK into the wall at 22 m/s entry: |v| ${w2.v.toFixed(
      2,
    )} m/s, contactTicks ${w2.ct}/360, penalised impacts ${w2.pen}`,
  );
  track.wallX = WALL_X;
}

// ===========================================================================
//  3. YAW AUTHORITY vs SPEED
// ===========================================================================

/**
 * Hold the planar speed at `speed` without touching the vertical component —
 * zeroing vUp lifts the kart off its springs and silently switches the yaw model
 * to the airborne branch, which is how the first version of this bench lied.
 */
function pin(speed: number, keepLateral = false): void {
  const b = physics.getBody(0)!;
  const vUp = b.velocity.dot(b.up);
  const vRight = keepLateral ? b.velocity.dot(b.right) : 0;
  b.velocity
    .copy(b.forward)
    .multiplyScalar(speed)
    .addScaledVector(b.right, vRight)
    .addScaledVector(b.up, vUp);
  b.forwardSpeed = speed;
}

function pinnedYaw(speed: number, steer: number, seconds = 1.5): number {
  solo();
  track.wallX = 5000;
  place(0, 0, speed, 0);
  const b = physics.getBody(0)!;
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    physics.setControl(0, ctrl(steer, 1));
    step(1);
    pin(speed);
  }
  if (!b.grounded) return NaN;
  return Math.abs(b.yawRate);
}

/** Free run: no pinning. Returns peak yaw rate and the trajectory radius. */
function freeYaw(speed: number): { yaw: number; radius: number; v: number } {
  solo();
  track.wallX = 5000;
  place(0, 0, speed, 0);
  const b = physics.getBody(0)!;
  let yawPeak = 0;
  let v = speed;
  const dir0 = new THREE.Vector3();
  let turned = 0;
  const prev = new THREE.Vector3();
  prev.copy(b.velocity).normalize();
  for (let i = 0; i < 120 * 1.2; i++) {
    physics.setControl(0, ctrl(1, 1));
    step(1);
    yawPeak = Math.max(yawPeak, Math.abs(b.yawRate));
    dir0.copy(b.velocity).normalize();
    turned += Math.acos(clamp(prev.dot(dir0), -1, 1));
    prev.copy(dir0);
    v = b.velocity.length();
  }
  const omega = turned / 1.2;
  return { yaw: yawPeak, radius: omega > 1e-4 ? v / omega : Infinity, v };
}

function tYaw(): void {
  head('Yaw authority at full lock (chassis yaw rate, speed pinned)');
  say('  speed |  yawRate  | deg/s | turn radius | lateral g');
  for (const v of [5, 15, 25, 38]) {
    const y = pinnedYaw(v, 1);
    say(
      `  ${String(v).padStart(5)} | ${y.toFixed(3).padStart(9)} | ${((y * 180) / Math.PI)
        .toFixed(1)
        .padStart(5)} | ${(v / y).toFixed(1).padStart(11)} m | ${((v * y) / 9.81).toFixed(2)}`,
    );
  }
  head('Free run at full lock (trajectory, not pinned)');
  for (const v of [15, 25]) {
    const r = freeYaw(v);
    say(
      `  entry ${v} m/s → peak yaw ${r.yaw.toFixed(3)} rad/s, mean traj radius ${r.radius.toFixed(
        1,
      )} m, |v| ${r.v.toFixed(1)}`,
    );
  }
  head('Drift yaw at full inward lock (speed pinned)');
  for (const v of [15, 25]) {
    solo();
    track.wallX = 5000;
    place(0, 0, v, 0);
    const b = physics.getBody(0)!;
    physics.setControl(0, ctrl(1, 1, 0, true, true));
    step(1);
    let engaged = false;
    for (let i = 0; i < 240; i++) {
      physics.setControl(0, ctrl(1, 1, 0, true, false));
      step(1);
      pin(v, true);
      if (karts[0].drifting) {
        engaged = true;
        break;
      }
    }
    for (let i = 0; i < 150; i++) {
      physics.setControl(0, ctrl(1, 1, 0, true, false));
      step(1);
      pin(v, true);
    }
    const dy = Math.abs(b.yawRate);
    const g = pinnedYaw(v, 1);
    say(
      `  ${v} m/s: drift yaw ${dy.toFixed(3)} rad/s vs grip ${g.toFixed(3)} rad/s  (×${(
        dy / g
      ).toFixed(2)})  engaged=${engaged}  latAccel needed ${(v * dy).toFixed(1)} m/s²`,
    );
  }
}

// ===========================================================================
//  4. STEER RAMP TIME
// ===========================================================================

function tSteerRamp(): void {
  head('Steering ramp (centre → full lock), speed pinned at 20 m/s');
  const speed = 20;
  const steady = pinnedYaw(speed, 1, 2.5);

  const measure = (inputRate: number): { t50: number; t90: number; t95: number } => {
    solo();
    track.wallX = 5000;
    place(0, 0, speed, 0);
    const b = physics.getBody(0)!;
    let inSteer = 0;
    let t50 = -1;
    let t90 = -1;
    let t95 = -1;
    for (let i = 0; i < 120 * 2; i++) {
      // Input.ts: moveTowards(steer, target, rate*dt). rate <= 0 → no pre-filter.
      inSteer = inputRate > 0 ? moveTowards(inSteer, 1, inputRate * FIXED_DT) : 1;
      physics.setControl(0, ctrl(inSteer, 1));
      step(1);
      pin(speed);
      const f = Math.abs(b.yawRate) / steady;
      const t = (i + 1) * FIXED_DT;
      if (t50 < 0 && f >= 0.5) t50 = t;
      if (t90 < 0 && f >= 0.9) t90 = t;
      if (t95 < 0 && f >= 0.95) t95 = t;
      if (t95 > 0) break;
    }
    return { t50, t90, t95 };
  };
  const a = measure(0);
  const b75 = measure(7.5);
  const b14 = measure(14);
  say(`  steady-state yaw at 20 m/s: ${steady.toFixed(3)} rad/s`);
  say(
    `  ctrlSteer stepped to 1 instantly  : 50% ${a.t50.toFixed(3)}s  90% ${a.t90.toFixed(
      3,
    )}s  95% ${a.t95.toFixed(3)}s`,
  );
  say(
    `  + Input.ts ramp as shipped (7.5/s): 50% ${b75.t50.toFixed(3)}s  90% ${b75.t90.toFixed(
      3,
    )}s  95% ${b75.t95.toFixed(3)}s`,
  );
  say(
    `  + Input.ts ramp proposed  (14/s)  : 50% ${b14.t50.toFixed(3)}s  90% ${b14.t90.toFixed(
      3,
    )}s  95% ${b14.t95.toFixed(3)}s`,
  );

  // Return-to-centre.
  solo();
  track.wallX = 5000;
  place(0, 0, speed, 0);
  const b = physics.getBody(0)!;
  for (let i = 0; i < 180; i++) {
    physics.setControl(0, ctrl(1, 1));
    step(1);
    pin(speed);
  }
  const from = Math.abs(b.yawRate);
  let tBack = -1;
  for (let i = 0; i < 240; i++) {
    physics.setControl(0, ctrl(0, 1));
    step(1);
    pin(speed);
    if (Math.abs(b.yawRate) < from * 0.1) {
      tBack = (i + 1) * FIXED_DT;
      break;
    }
  }
  say(`  full lock → 10% of yaw after release: ${tBack.toFixed(3)}s`);
}

// ===========================================================================
//  5. ACCELERATION
// ===========================================================================

function tAccel(): void {
  head('0 → top speed');
  solo();
  track.wallX = 5000;
  place(0, 0, 0, 0);
  physics.setControl(0, ctrl(0, 1));
  step(120 * 14);
  const terminal = physics.getBody(0)!.forwardSpeed;

  place(0, 0, 0, 0);
  const b = physics.getBody(0)!;
  b.velocity.set(0, 0, 0);
  b.forwardSpeed = 0;
  let t95 = -1;
  let t98 = -1;
  for (let i = 0; i < 120 * 12; i++) {
    physics.setControl(0, ctrl(0, 1));
    step(1);
    const v = b.forwardSpeed;
    const t = (i + 1) * FIXED_DT;
    if (t95 < 0 && v >= terminal * 0.95) t95 = t;
    if (t98 < 0 && v >= terminal * 0.98) t98 = t;
    if (t98 > 0) break;
  }
  say(
    `  terminal ${terminal.toFixed(2)} m/s (${(terminal * 3.6).toFixed(
      0,
    )} km/h) — 95% at ${t95.toFixed(2)}s, 98% at ${t98.toFixed(2)}s   [want 2.5–3.5 s]`,
  );
}

// ===========================================================================
//  6. DRIFT: entry → Purple
// ===========================================================================

function tDrift(): void {
  head('Drift charge');
  solo();
  track.wallX = 5000;
  const t = physics.tuningOf(0)!;
  place(0, 0, t.maxSpeed * 0.95, 0);
  const b = physics.getBody(0)!;
  const tiers: number[] = [];
  let respawns = 0;
  const offR = bus.on('kart:respawn', () => respawns++);
  const off = bus.on('kart:driftTier', (e) => {
    tiers[e.tier] = ctxT.elapsed;
  });
  physics.setControl(0, ctrl(1, 1, 0, true, true));
  step(1);
  let engaged = -1;
  for (let i = 0; i < 120 * 2; i++) {
    physics.setControl(0, ctrl(1, 1, 0, true, false));
    step(1);
    if (karts[0].drifting) {
      engaged = ctxT.elapsed;
      break;
    }
  }
  for (let i = 0; i < 120 * 8; i++) {
    physics.setControl(0, ctrl(1, 1, 0, true, false));
    step(1);
    if (karts[0].driftStage >= DriftStage.Purple) break;
  }
  off();
  offR();
  const purple = tiers[3] !== undefined ? tiers[3] - engaged : -1;
  say(
    `  entry → Blue ${(tiers[1] - engaged).toFixed(2)}s, Orange ${(tiers[2] - engaged).toFixed(
      2,
    )}s, Purple ${purple.toFixed(2)}s   [want Purple ≈ 3.0 s]  respawns ${respawns}`,
  );
  say(
    `  sustained drift angle ${((b.driftAngle * 180) / Math.PI).toFixed(
      1,
    )}°, forward ${b.forwardSpeed.toFixed(2)} m/s, |v| ${b.velocity
      .length()
      .toFixed(2)} of maxSpeed ${t.maxSpeed.toFixed(2)}, slip ${(
      (b.slipAngle * 180) /
      Math.PI
    ).toFixed(1)}°`,
  );

  // release payout
  let boost = 0;
  const off2 = bus.on('kart:boost', (e) => {
    if (e.source === 'drift') boost = e.duration;
  });
  physics.setControl(0, ctrl(1, 1, 0, false, false));
  step(2);
  off2();
  say(`  purple release boost ${boost.toFixed(2)}s`);
}

// ===========================================================================
//  7. 90° CORNER: drifted vs gripping
// ===========================================================================

function tCorner(): void {
  head('90° corner');
  const run = (drifting: boolean) => {
    solo();
    track.wallX = 5000;
    const t = physics.tuningOf(0)!;
    place(0, 0, t.maxSpeed * 0.98, 0);
    physics.setControl(0, ctrl(0, 1));
    step(90);
    const b = physics.getBody(0)!;
    if (drifting) {
      physics.setControl(0, ctrl(1, 1, 0, true, true));
      step(1);
      for (let i = 0; i < 120; i++) {
        physics.setControl(0, ctrl(1, 1, 0, true, false));
        step(1);
        if (karts[0].drifting) break;
      }
    }
    const v0 = b.forwardSpeed;
    const m0 = b.velocity.length();
    const h0 = new THREE.Vector3().copy(b.forward);
    let steps = 0;
    let respawns = 0;
    const or = bus.on('kart:respawn', () => respawns++);
    for (let i = 0; i < 120 * 8; i++) {
      physics.setControl(0, ctrl(1, 1, 0, drifting, false));
      step(1);
      steps++;
      if (Math.acos(clamp(h0.dot(b.forward), -1, 1)) >= Math.PI / 2) break;
    }
    or();
    return {
      v0,
      v1: b.forwardSpeed,
      m0,
      m1: b.velocity.length(),
      time: steps * FIXED_DT,
      loss: 1 - b.forwardSpeed / v0,
      mloss: 1 - b.velocity.length() / m0,
      respawns,
    };
  };
  const d = run(true);
  const g = run(false);
  say(
    `  drifted  90°: fwd ${d.v0.toFixed(2)} → ${d.v1.toFixed(2)} (${(d.loss * 100).toFixed(
      1,
    )}% lost) | |v| ${d.m0.toFixed(2)} → ${d.m1.toFixed(2)} (${(d.mloss * 100).toFixed(
      1,
    )}% lost) in ${d.time.toFixed(2)}s  respawns ${d.respawns}   [want < 12%]`,
  );
  say(
    `  gripping 90°: fwd ${g.v0.toFixed(2)} → ${g.v1.toFixed(2)} (${(g.loss * 100).toFixed(
      1,
    )}% lost) | |v| ${g.m0.toFixed(2)} → ${g.m1.toFixed(2)} (${(g.mloss * 100).toFixed(
      1,
    )}% lost) in ${g.time.toFixed(2)}s`,
  );
  say(`  drift is the fast line: ${d.time <= g.time + 0.02 ? 'YES' : 'NO'}`);
}

// ===========================================================================
//  8. 25° BANK
// ===========================================================================

function tBank(): void {
  head('25° bank');
  solo();
  track.wallX = 5000;
  track.bank = (25 * Math.PI) / 180;
  place(0, 0, 0, 0);
  const b = physics.getBody(0)!;
  physics.setControl(0, IDLE);
  step(240);
  let minH = 1e9;
  let maxH = -1e9;
  let allGrounded = true;
  for (let i = 0; i < 360; i++) {
    physics.setControl(0, IDLE);
    step(1);
    const n = track.planeNormal();
    const h =
      b.position.x * n.x + b.position.y * n.y + b.position.z * n.z; // dist to plane
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
    for (let w = 0; w < 4; w++) if (!b.wheels[w].grounded) allGrounded = false;
  }
  say(
    `  at rest: ride-height band ${((maxH - minH) * 1000).toFixed(2)} mm, all wheels planted ${
      allGrounded ? 'yes' : 'no'
    }, lateral creep ${Math.abs(b.lateralSpeed).toFixed(3)} m/s   [want band < 10 mm, creep < 1.0]`,
  );

  place(0, 0, 22, 0);
  physics.setControl(0, ctrl(0, 1));
  step(120); // let the drive/suspension transient settle before measuring
  let maxDelta = 0;
  let last = 0;
  for (let i = 0; i < 360; i++) {
    physics.setControl(0, ctrl(0, 1));
    step(1);
    const n = track.planeNormal();
    const h = b.position.x * n.x + b.position.y * n.y + b.position.z * n.z;
    if (i > 0) maxDelta = Math.max(maxDelta, Math.abs(h - last));
    last = h;
  }
  say(`  driving it at 22 m/s: max per-step ride-height change ${(maxDelta * 1000).toFixed(1)} mm   [want < 25 mm]`);
  track.bank = 0;
}

// ===========================================================================
//  9. FUZZ
// ===========================================================================

function tFuzz(): void {
  head('60 s random-input fuzz, 12 karts');
  track.wallX = WALL_X;
  track.bank = 0;
  physics.setKarts(karts);
  for (let i = 0; i < KART_COUNT; i++) {
    physics.setTuning(i, makeTuning(CHARS[i % CHARS.length], 150));
    const q = new THREE.Quaternion();
    physics.place(i, new THREE.Vector3((i % 4) * 3 - 4.5, 0.5, -i * 5), q);
  }
  const rng = new Rng(0xc0ffee);
  let bad = 0;
  let checks = 0;
  let respawns = 0;
  let warns = 0;
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warns++;
    void a;
  };
  const off = bus.on('kart:respawn', () => respawns++);
  physics.resetPerf();
  const t0 = Date.now();
  for (let i = 0; i < 120 * 60; i++) {
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
        physics.applyStun(rng.int(0, KART_COUNT - 1), 1.2, kinds[rng.int(0, 3)]);
      }
    }
    step(1);
    for (let k = 0; k < KART_COUNT; k++) {
      const b = physics.getBody(k)!;
      checks++;
      if (
        !Number.isFinite(b.position.x) ||
        !Number.isFinite(b.position.y) ||
        !Number.isFinite(b.position.z) ||
        !Number.isFinite(b.velocity.x) ||
        !Number.isFinite(b.velocity.y) ||
        !Number.isFinite(b.velocity.z) ||
        !Number.isFinite(b.yawRate) ||
        !Number.isFinite(b.driftAngle)
      )
        bad++;
    }
  }
  off();
  console.warn = origWarn;
  const ms = Date.now() - t0;
  say(
    `  ${checks} state checks, non-finite ${bad}, guardNaN warnings ${warns}, respawns ${respawns}`,
  );
  say(
    `  sim cost: ${ms} ms wall clock for 7200 steps × 12 karts; physics.stepMs ${physics.stepMs.toFixed(
      3,
    )} ms, peak ${physics.stepMsPeak.toFixed(3)} ms`,
  );
}

// ===========================================================================

function main(): void {
  const label = process.argv[2] ?? 'run';
  say(`## PHYSICS BENCH — ${label}`);
  tWallAngles();
  tWallHug();
  tYaw();
  tSteerRamp();
  tAccel();
  tDrift();
  tCorner();
  tBank();
  tFuzz();
  say('');
  console.log(out.join('\n'));
}

main();
