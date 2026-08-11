/**
 * ============================================================================
 *  APEX KART — PHYSICS BENCH  (dev harness, not shipped)
 * ============================================================================
 *  A standalone page for developing and PROVING the handling model without
 *  depending on the Track or Kart agents. It contains:
 *
 *   • `TestTrack` — a complete analytic `ITrackService`: a stadium oval with
 *     two flat straights, two 25° banked arcs, a launch ramp, a boost pad,
 *     an anti-gravity arc, guardrails, a grass apron and a void beyond.
 *     Everything is a closed-form height field, so `raycastGround` is exact
 *     and the numbers below mean something.
 *
 *   • A visible box-kart with four suspension-driven wheel markers, a chase
 *     camera, keyboard control via `@/core/Input`, and a live readout of every
 *     number that matters.
 *
 *   • `window.__PHYS__.tests.runAll()` — a scripted, headless test battery with
 *     numeric assertions (top speed, drift charge timing, cornering speed loss,
 *     wall scrub, tunnelling, NaN fuzz, banked stability, perf).
 * ============================================================================
 */

import * as THREE from 'three';
import { Engine } from '@/core/Engine';
import { Input } from '@/core/Input';
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

const R = 60; // arc radius / half-separation of the straights
const L = 55; // half-length of each straight
const ROAD = 11; // road half-width
const BANK = (25 * Math.PI) / 180; // peak bank on the arcs
const RAMP_H = 2.4;
const WALL_TIGHT = 11.6; // guardrail offset on the ramp straight + arcs
const WALL_WIDE = 19.4; // ...and on the grass-apron straight
const WALL_HEIGHT = 1.4;
const GRASS_LIMIT = 42; // beyond this there is no ground at all
const OOB_LIMIT = 34;

const ARC_LEN = Math.PI * R;
const STRAIGHT_LEN = 2 * L;
const LAP = 2 * STRAIGHT_LEN + 2 * ARC_LEN;

/** Region ids. 0 = ramp straight (travel −Z), 1 = arc A, 2 = apron straight, 3 = arc B. */
const enum Region {
  RampStraight = 0,
  ArcA = 1,
  ApronStraight = 2,
  ArcB = 3,
}

/** Scratch result of the nearest-centreline solve. Never allocated per call. */
const G = {
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

function geoAt(x: number, z: number): void {
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
function arcBankBlend(a: number): number {
  return smoothstep(Math.min(a, Math.PI - a) / 0.55);
}

/** Height of the ramp on the +R straight as a function of z (travel is −Z). */
function rampHeight(z: number): number {
  if (z >= 20 || z <= -18) return 0;
  if (z >= 4) {
    const s = (20 - z) / 16;
    return RAMP_H * s * s; // steepest right at the lip → a real kicker
  }
  return RAMP_H * (1 - smoothstep((4 - z) / 22));
}

function wallInsetFor(region: Region, z: number): number {
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
    if (au > GRASS_LIMIT) return SurfaceType.Void;
    return SurfaceType.Grass;
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
    // Guardrails are finite: clear the top and you're over them.
    if (Number.isFinite(surf) && position.y - surf > WALL_HEIGHT + 0.35) return out;

    const u = G.u;
    if (u > inset - radius) {
      out.hit = true;
      out.depth = radius - (inset - u);
      out.normal.set(-G.bx, 0, -G.bz);
      out.point.set(G.cx + G.bx * inset, position.y, G.cz + G.bz * inset);
    } else if (u < -inset + radius) {
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

  project(position: THREE.Vector3): TrackSample {
    geoAt(position.x, position.z);
    return this.fillSample(G.dist);
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

// ===========================================================================
//  SCENE
// ===========================================================================

const app = document.getElementById('app') as HTMLElement;
const hudEl = document.getElementById('hud') as HTMLElement;
const barsEl = document.getElementById('bars') as HTMLElement;
const resultsEl = document.getElementById('results') as HTMLElement;

const engine = new Engine(app, 'high');
engine.adaptiveResolution = false;
const input = new Input(engine.canvas);
input.init();

const track = new TestTrack();
const physics = new PhysicsWorld(track);

const KART_COUNT = 12;
const CHARS = Object.keys(CHARACTER_STATS);
const karts: KartState[] = [];
for (let i = 0; i < KART_COUNT; i++) karts.push(makeKartState(i, i === 0));
for (let i = 0; i < KART_COUNT; i++) {
  physics.setTuning(i, makeTuning(CHARS[i % CHARS.length], 150));
}
physics.setKarts(karts);

// --- lighting (functional, not art-directed — this page is a bench) --------
const scene = engine.scene;
scene.background = new THREE.Color(0x0a0d16);
scene.fog = new THREE.Fog(0x0a0d16, 180, 520);
const sun = new THREE.DirectionalLight(0xfff2df, 2.6);
sun.position.set(-60, 90, 40);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x8fb7ff, 0x2a2418, 0.85));

// --- track mesh ------------------------------------------------------------
function buildTrackMesh(): THREE.Mesh {
  const along = 480;
  const across = 15;
  const verts = new Float32Array(along * across * 3);
  const cols = new Float32Array(along * across * 3);
  const idx: number[] = [];
  const c = new THREE.Color();
  const p = new THREE.Vector3();

  for (let i = 0; i < along; i++) {
    const d = (i / (along - 1)) * LAP;
    const s = track.sampleAtDistance(d);
    p.copy(s.position);
    const bx = s.binormal.x;
    const bz = s.binormal.z;
    for (let j = 0; j < across; j++) {
      const u = (j / (across - 1) - 0.5) * 2 * (ROAD + 8);
      const x = p.x + bx * u;
      const z = p.z + bz * u;
      const y = track.heightAt(x, z);
      const o = (i * across + j) * 3;
      verts[o] = x;
      verts[o + 1] = Number.isFinite(y) ? y : 0;
      verts[o + 2] = z;

      const surf = track.surfaceAt(new THREE.Vector3(x, 0, z));
      if (Math.abs(u) > ROAD) c.setHex(0x2f4a24);
      else if (surf === SurfaceType.Boost) c.setHex(0xd8761f);
      else if (surf === SurfaceType.AntiGravity) c.setHex(0x3b2f6e);
      else c.setHex(0x33363d);
      // Faint lateral striping so motion and banking are legible.
      const stripe = j % 2 === 0 ? 1.0 : 0.9;
      const kerb = Math.abs(u) > ROAD - 1.1 && Math.abs(u) <= ROAD ? 1.9 : 1;
      cols[o] = c.r * stripe * kerb;
      cols[o + 1] = c.g * stripe * kerb * (kerb > 1 ? 0.45 : 1);
      cols[o + 2] = c.b * stripe * kerb * (kerb > 1 ? 0.45 : 1);
    }
  }
  for (let i = 0; i < along - 1; i++) {
    for (let j = 0; j < across - 1; j++) {
      const a = i * across + j;
      const b = a + 1;
      const cc = a + across;
      const dd = cc + 1;
      idx.push(a, cc, b, b, cc, dd);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.04 }),
  );
}

function buildWallMesh(): THREE.Mesh {
  const along = 420;
  const verts: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? 1 : -1;
    for (let i = 0; i < along; i++) {
      const d = (i / (along - 1)) * LAP;
      const s = track.sampleAtDistance(d);
      geoAt(s.position.x, s.position.z);
      const inset = wallInsetFor(G.region, G.cz);
      const x = s.position.x + s.binormal.x * inset * sgn;
      const z = s.position.z + s.binormal.z * inset * sgn;
      const y = track.heightAt(x, z);
      const y0 = Number.isFinite(y) ? y : 0;
      verts.push(x, y0, z, x, y0 + WALL_HEIGHT, z);
    }
    for (let i = 0; i < along - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    base += along * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: 0x9aa6bb,
      roughness: 0.6,
      metalness: 0.25,
      side: THREE.DoubleSide,
    }),
  );
}

const trackMesh = buildTrackMesh();
scene.add(trackMesh);
const wallMesh = buildWallMesh();
scene.add(wallMesh);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(700, 700),
  new THREE.MeshStandardMaterial({ color: 0x1b2a16, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.06;
scene.add(ground);

/** Flat-mode floor, swapped in for the scripted tests. */
const flatFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600, 30, 30),
  new THREE.MeshStandardMaterial({ color: 0x30343c, roughness: 0.85, wireframe: false }),
);
flatFloor.rotation.x = -Math.PI / 2;
flatFloor.visible = false;
scene.add(flatFloor);

// --- kart visuals ----------------------------------------------------------
const bodyGeo = new THREE.BoxGeometry(1, 1, 1);
const noseGeo = new THREE.BoxGeometry(0.5, 0.22, 0.5);
const wheelGeo = new THREE.CylinderGeometry(1, 1, 0.26, 16);
wheelGeo.rotateZ(Math.PI / 2);
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.75 });
const wheelMatAir = new THREE.MeshStandardMaterial({ color: 0xff4d4d, roughness: 0.6 });

interface KartVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  nose: THREE.Mesh;
  wheels: THREE.Mesh[];
}
const visuals: KartVisual[] = [];
const HUES = [0.55, 0.02, 0.12, 0.3, 0.45, 0.68, 0.78, 0.88, 0.62, 0.18, 0.35, 0.5];
for (let i = 0; i < KART_COUNT; i++) {
  const t = physics.tuningOf(i)!;
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(HUES[i % HUES.length], 0.75, i === 0 ? 0.55 : 0.4),
    roughness: 0.45,
    metalness: 0.3,
  });
  const body = new THREE.Mesh(bodyGeo, mat);
  body.scale.set(t.halfExtents.x * 2, t.halfExtents.y * 2, t.halfExtents.z * 2);
  group.add(body);
  const nose = new THREE.Mesh(noseGeo, new THREE.MeshStandardMaterial({ color: 0xffe6a0 }));
  nose.position.set(0, t.halfExtents.y * 0.6, -t.halfExtents.z);
  group.add(nose);
  const wheels: THREE.Mesh[] = [];
  for (let w = 0; w < 4; w++) {
    const m = new THREE.Mesh(wheelGeo, wheelMat);
    m.scale.setScalar(t.wheelRadius);
    group.add(m);
    wheels.push(m);
  }
  scene.add(group);
  visuals.push({ group, body, nose, wheels });
}

// ===========================================================================
//  DRIVING
// ===========================================================================

const camera = engine.camera;
const camPos = new THREE.Vector3(0, 8, 20);
const camTarget = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

let paused = false;
let charIndex = 0;

function resetPlayer(): void {
  const s = track.getStartPosition(0);
  physics.place(0, s.position, s.quaternion);
}
function resetAll(): void {
  for (let i = 0; i < KART_COUNT; i++) {
    const s = track.getStartPosition(i);
    physics.place(i, s.position, s.quaternion);
  }
}
resetAll();

/** Dumb lane-follower so the AI karts move and collide. */
const aiScratch = new THREE.Vector3();
function driveAI(i: number): void {
  const b = physics.getBody(i);
  if (!b) return;
  const s = track.project(b.position);
  aiScratch.copy(track.racingLineAt(s.t, 14 + i * 0.7)).sub(b.position);
  const fwdErr = aiScratch.dot(b.forward);
  const sideErr = aiScratch.dot(b.right);
  const steer = clamp((sideErr / Math.max(4, Math.abs(fwdErr))) * -2.4, -1, 1);
  const wantDrift = Math.abs(steer) > 0.72 && b.forwardSpeed > 12;
  physics.setControl(i, {
    steer,
    accel: 1,
    brake: 0,
    drift: wantDrift,
    driftPressed: wantDrift && !b.ctrlDrift,
  });
}

// --- events (proof that the bus contract is honoured) ----------------------
const log: string[] = [];
function pushLog(s: string): void {
  log.unshift(s);
  if (log.length > 7) log.pop();
}
bus.on('kart:hop', (e) => e.kartId === 0 && pushLog('hop'));
bus.on('kart:driftStart', (e) => e.kartId === 0 && pushLog(`driftStart ${e.direction > 0 ? 'R' : 'L'}`));
bus.on('kart:driftTier', (e) => e.kartId === 0 && pushLog(`TIER ${e.tier}`));
bus.on('kart:driftRelease', (e) => e.kartId === 0 && pushLog(`release t${e.tier} ${e.boostTime.toFixed(2)}s`));
bus.on('kart:boost', (e) => e.kartId === 0 && pushLog(`boost ${e.source} ${e.duration.toFixed(2)}s`));
bus.on('kart:trick', (e) => e.kartId === 0 && pushLog(`TRICK ${e.name}`));
bus.on('kart:wallHit', (e) => e.kartId === 0 && pushLog(`wall ${e.impact.toFixed(1)} m/s`));
bus.on('kart:kartHit', (e) => (e.a === 0 || e.b === 0) && pushLog(`bump ${e.impact.toFixed(1)}`));
bus.on('kart:land', (e) => e.kartId === 0 && e.impact > 0 && pushLog(`land ${e.impact.toFixed(1)}`));
bus.on('kart:respawn', (e) => e.kartId === 0 && pushLog('RESPAWN'));
bus.on('kart:spinout', (e) => e.kartId === 0 && pushLog('SPINOUT'));

// --- harness subsystem ----------------------------------------------------
const harness = {
  fixedUpdate(): void {
    if (paused) return;
    for (let i = 1; i < KART_COUNT; i++) driveAI(i);
  },
  update(ctx: FrameContext): void {
    if (!paused) {
      const s = input.state;
      physics.setControl(0, {
        steer: s.steer,
        accel: s.accel,
        brake: s.brake,
        drift: s.drift,
        driftPressed: s.driftPressed,
      });
    }
    syncVisuals();
    updateCamera(ctx.dt);
    updateHud();
  },
};

function syncVisuals(): void {
  for (let i = 0; i < KART_COUNT; i++) {
    const st = karts[i];
    const t = physics.tuningOf(i)!;
    const v = visuals[i];
    v.group.position.copy(st.position);
    v.group.quaternion.copy(st.quaternion);
    v.body.scale.set(
      t.halfExtents.x * 2 * physics.visualShrinkOf(i),
      t.halfExtents.y * 2 * physics.visualScaleOf(i) * physics.visualShrinkOf(i),
      t.halfExtents.z * 2 * physics.visualShrinkOf(i),
    );
    for (let w = 0; w < 4; w++) {
      const off = t.wheelOffsets[w];
      // Compression 0 = fully extended (hangs low), 1 = bottomed out (tucked up).
      const drop = t.suspensionRest - st.suspension[w] * t.suspensionTravel;
      v.wheels[w].position.set(off.x, off.y - drop, off.z);
      v.wheels[w].rotation.x = st.wheelSpin[w];
      v.wheels[w].material = st.wheelGrounded[w] ? wheelMat : wheelMatAir;
      if (w < 2) v.wheels[w].rotation.y = st.steerAngle;
    }
  }
}

function updateCamera(dt: number): void {
  const st = karts[0];
  _v.set(0, 0, 1).applyQuaternion(st.groundQuaternion);
  _v2.set(0, 1, 0).applyQuaternion(st.groundQuaternion);
  const back = 8.5 + clamp01(Math.abs(st.speed) / 30) * 3.5;
  camTarget.copy(st.position).addScaledVector(_v, back).addScaledVector(_v2, 3.4);
  const k = 1 - Math.exp(-7 * dt);
  camPos.lerp(camTarget, k);
  camera.position.copy(camPos);
  _v.copy(st.position).addScaledVector(_v2, 1.0);
  camera.lookAt(_v);
}

function bar(label: string, v: number, color: string, text: string): string {
  const pct = Math.round(clamp01(v) * 100);
  return `<div class="row">${label} <span style="float:right">${text}</span><div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div></div>`;
}

const STAGE_NAMES = ['—', 'charge', 'BLUE', 'ORANGE', 'PURPLE'];
const SURF_NAMES = [
  'Road', 'OffRoad', 'Dirt', 'Grass', 'Sand', 'Water', 'Ice',
  'Metal', 'Wood', 'Boost', 'AntiGrav', 'Glider', 'Void',
];

function updateHud(): void {
  const st = karts[0];
  const b = physics.getBody(0)!;
  const t = b.tuning;
  const kmh = st.speed * 3.6;
  hudEl.innerHTML =
    `<b>${CHARS[charIndex % CHARS.length]}</b>  ${paused ? '[PAUSED]' : ''}\n` +
    `speed    ${st.speed.toFixed(2)} m/s  (${kmh.toFixed(0)} km/h)  cap ${t.maxSpeed.toFixed(1)}\n` +
    `drift    ${STAGE_NAMES[st.driftStage]}  charge ${(st.driftCharge * 100).toFixed(0)}%  dir ${st.driftDirection}\n` +
    `dAngle   ${((b.driftAngle * 180) / Math.PI).toFixed(1)}°   slip ${((st.speed !== 0 ? b.slipAngle : 0) * 180 / Math.PI).toFixed(1)}°\n` +
    `grip     ${b.gripFactor.toFixed(2)}   latAccel ${b.latAccelUsed.toFixed(1)} m/s²\n` +
    `boost    ${st.boostTime.toFixed(2)}s × ${st.boostStrength.toFixed(2)}\n` +
    `susp     ${st.suspension.map((v) => v.toFixed(2)).join(' ')}\n` +
    `ground   ${st.wheelGrounded.map((v) => (v ? '#' : '.')).join(' ')}  air ${st.airTime.toFixed(2)}s\n` +
    `pitch    ${((b.pitch * 180) / Math.PI).toFixed(1)}°  roll ${((b.roll * 180) / Math.PI).toFixed(1)}°  lean ${((b.driftLean * 180) / Math.PI).toFixed(1)}°\n` +
    `surface  ${SURF_NAMES[st.surface]}   yaw ${st.angularVelocity.toFixed(2)} rad/s\n` +
    `phys     ${physics.stepMs.toFixed(3)} ms/step (12 karts)  fps ${engine.fpsAverage.toFixed(0)}\n` +
    `\n${log.join('\n')}`;

  barsEl.innerHTML =
    bar('speed', Math.abs(st.speed) / 42, '#4fc3ff', `${st.speed.toFixed(1)}`) +
    bar('drift charge', st.driftCharge, ['#888', '#888', '#3aa0ff', '#ff9d2e', '#c964ff'][st.driftStage], STAGE_NAMES[st.driftStage]) +
    bar('boost', st.boostTime / 2, '#ffd45e', `${st.boostTime.toFixed(2)}`) +
    bar('rpm', st.rpm, '#ff6f91', st.rpm.toFixed(2)) +
    bar('FL', st.suspension[0], '#9be36b', st.suspension[0].toFixed(2)) +
    bar('FR', st.suspension[1], '#9be36b', st.suspension[1].toFixed(2)) +
    bar('RL', st.suspension[2], '#6bd8e3', st.suspension[2].toFixed(2)) +
    bar('RR', st.suspension[3], '#6bd8e3', st.suspension[3].toFixed(2));
}

engine.add(physics);
engine.add(input);
engine.add(harness);
engine.add({ update: () => input.endFrame() });
void engine.initAll().then(() => engine.start());

// --- extra keys -----------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') resetAll();
  else if (e.code === 'KeyP') paused = !paused;
  else if (e.code === 'KeyB') physics.applyBoost(0, 1.4, 1.0, 'item');
  else if (e.code === 'KeyK') physics.applyStun(0, 1.1, 'spin');
  else if (e.code === 'KeyL') physics.applyStun(0, 2.0, 'squash');
  else if (e.code === 'KeyC') {
    charIndex = (charIndex + 1) % CHARS.length;
    physics.setTuning(0, makeTuning(CHARS[charIndex], 150));
  } else if (e.code === 'Escape') resultsEl.classList.remove('on');
  else if (e.code === 'KeyT') {
    resultsEl.classList.add('on');
    resultsEl.innerHTML = 'running…';
    setTimeout(() => {
      const r = runAll();
      resultsEl.innerHTML = formatReport(r);
    }, 30);
  }
});

// ===========================================================================
//  SCRIPTED TEST BATTERY
// ===========================================================================

interface Assertion {
  name: string;
  value: string;
  expect: string;
  pass: boolean;
}
interface TestReport {
  assertions: Assertion[];
  notes: string[];
}

const ctxT = { dt: FIXED_DT, fixedDt: FIXED_DT, elapsed: 0, frame: 0, alpha: 0 };
const testCtx = ctxT as unknown as FrameContext;

function stepPhysics(n: number): void {
  for (let i = 0; i < n; i++) {
    ctxT.elapsed += FIXED_DT;
    ctxT.frame++;
    physics.fixedUpdate(testCtx);
  }
}

/** Solo mode: one kart only, so nothing else perturbs a measurement. */
function solo(): void {
  physics.setKarts([karts[0]]);
}
function full(): void {
  physics.setKarts(karts);
  resetAll();
}

const CTRL_IDLE = { steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false };
function ctrl(
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
function place(d: number, lateral: number, speed: number, degRight = 0): void {
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

function placeFlat(speed: number, bankDeg = 0): void {
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
  place(2 * STRAIGHT_LEN + ARC_LEN + STRAIGHT_LEN * 0 + 2 * STRAIGHT_LEN + ARC_LEN * 0.5 - 2 * STRAIGHT_LEN, 0, 24);
  place(2 * STRAIGHT_LEN + ARC_LEN + STRAIGHT_LEN + ARC_LEN * 0.5, 0, 24);
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

interface FullReport {
  groups: Array<{ name: string; report: TestReport }>;
  passed: number;
  failed: number;
}

function runAll(): FullReport {
  const wasPaused = paused;
  paused = true;
  engine.stop();

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
  paused = wasPaused;
  engine.start();
  return { groups, passed, failed };
}

function formatReport(r: FullReport): string {
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

// ===========================================================================
//  PROBE SURFACE
// ===========================================================================

declare global {
  interface Window {
    __PHYS__: {
      physics: PhysicsWorld;
      track: TestTrack;
      karts: KartState[];
      engine: Engine;
      runAll: () => FullReport;
      report: () => string;
      setPaused: (v: boolean) => void;
      step: (n: number) => void;
      reset: () => void;
    };
  }
}

window.__PHYS__ = {
  physics,
  track,
  karts,
  engine,
  runAll,
  report: () => {
    const r = runAll();
    return formatReport(r)
      .replace(/<[^>]+>/g, '')
      .trim();
  },
  setPaused: (v: boolean) => {
    paused = v;
  },
  step: stepPhysics,
  reset: resetAll,
};

// eslint-disable-next-line no-console
console.log('[physics bench] ready — window.__PHYS__ , press T for the assertion suite');
