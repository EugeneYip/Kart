/**
 * ============================================================================
 *  TrackSpline — the geometric spine of a circuit
 * ============================================================================
 *
 *  A closed (or open) **centripetal Catmull-Rom** curve (alpha = 0.5) with:
 *
 *   * **Arc-length reparameterisation.** Every public query is in metres, never
 *     in raw curve parameter. A dense chord table is integrated once, then
 *     resampled into an arc-uniform LUT (>= 2048 entries, ~0.5 m spacing).
 *     Naive `getPointAt`-style sampling is wildly non-uniform on hand-authored
 *     control points and would corrupt AI lookahead and lap progress.
 *
 *   * **Rotation-minimising frames.** The road "up" is parallel-transported
 *     along the curve so the ribbon never twists on its own, then the *authored*
 *     bank is rolled on top. For closed loops the residual twist after one lap
 *     is measured and distributed backwards so the frame is exactly periodic.
 *
 *   * **Per-control-point attributes** — half width, bank, shoulder widths
 *     (smoothly interpolated with the same non-uniform basis as the position)
 *     plus discrete per-segment attributes (surface, wall style, feature flags).
 *
 *   * **O(1) projection.** A chamfer-propagated XZ bucket grid stores up to four
 *     well-separated seed samples per cell (so stacked road — spirals, bridges
 *     over the start straight — resolves correctly in 3D), followed by a damped
 *     Newton refinement on arc length. Exact enough to rank twelve karts.
 *
 *  Sign conventions (see `TrackSample` in core/Types):
 *    tangent   = direction of travel
 *    normal    = road up (banked)
 *    binormal  = tangent x normal = driver's right
 *    curvature > 0 means turning right
 *    bank      > 0 banks correctly for a right-hand corner (left edge higher)
 */

import * as THREE from 'three';
import type { TrackSample } from '@/core/Types';
import { SurfaceType } from '@/core/Types';
import { clamp } from '@/core/MathUtils';

// ---------------------------------------------------------------------------
// Authoring vocabulary
// ---------------------------------------------------------------------------

/**
 * Feature flags. A flag authored on control point *i* applies to the segment
 * that *starts* at point i, so features turn on and off at node boundaries.
 */
export const TF = {
  None: 0,
  /** Anti-gravity plating: karts stick to the road at any bank. */
  AntiGravity: 1 << 0,
  /** Glider volume — airborne karts here deploy the glider. */
  Glider: 1 << 1,
  /** Whole-width boost strip. */
  Boost: 1 << 2,
  /** Tunnel: an arch is built over the road and vertex colour is darkened. */
  Tunnel: 1 << 3,
  /** Elevated deck: shoulders are cut back to a narrow kerb + barrier. */
  Bridge: 1 << 4,
  /** No road at all — this is a jump. */
  Gap: 1 << 5,
  /** Suppress the kerb on the left / right. */
  NoKerbL: 1 << 6,
  NoKerbR: 1 << 7,
  /** Launch ramp: kerbs off, road blends up into the lip. */
  Ramp: 1 << 8,
  /** Rain-slick: puddles + near-mirror roughness. */
  Wet: 1 << 9,
  /** Under a structure — darken vertex colour without building a tunnel. */
  Dark: 1 << 10,
  /** Start/finish grid paint lives on this segment. */
  Grid: 1 << 11,
} as const;

export type WallStyle =
  | 'none'
  | 'guardrail'
  | 'concrete'
  | 'energy'
  | 'building'
  | 'rock'
  | 'fence'
  | 'wood';

/** One hand-authored control point. */
export interface SplineNodeSpec {
  /** World position of the centreline node, metres. */
  p: readonly [number, number, number];
  /** Half width of the drivable road. Default 11 (a 22 m road). */
  hw?: number;
  /** Authored bank, **degrees**. Positive banks for a right-hand corner. */
  bank?: number;
  /** Off-road shoulder width outside the kerb, left / right. Default 5. */
  shL?: number;
  shR?: number;
  /** Road surface for the segment starting here. */
  surface?: SurfaceType;
  /** Off-road shoulder surface. */
  shoulderSurface?: SurfaceType;
  wallL?: WallStyle;
  wallR?: WallStyle;
  /** Bitwise OR of `TF.*`. */
  flags?: number;
  /** Design note — shows up in the dev harness. */
  tag?: string;
}

/** Resolved node — every field present. */
export interface SplineNode {
  x: number; y: number; z: number;
  hw: number;
  /** radians */
  bank: number;
  shL: number;
  shR: number;
  surface: SurfaceType;
  shoulderSurface: SurfaceType;
  wallL: WallStyle;
  wallR: WallStyle;
  flags: number;
  tag: string;
}

/**
 * A `TrackSample` plus the two smooth channels that were being computed and
 * thrown away.
 *
 * `TrackSample` (in `core/Types.ts`, the cross-subsystem contract) carries
 * `halfWidth` — channel 0 — and stops there. Channels 2 and 3, the authored
 * off-road shoulder widths, are the other half of "how wide is the road here":
 * the DRAWN carriageway is `halfWidth + kerbW + shoulder`, and the shoulder is
 * the widest and most variable term of the three (0-9 m authored, with four
 * 24 m nodes, against a fixed 1.55 m kerb).
 *
 * Every consumer outside `src/track` that needed them therefore had to guess.
 * `WorldTextures.PathStation` documents a `SH_FALLBACK` of 3 m for exactly that
 * reason, and until this interface existed *every* station on *every* circuit
 * took it — which put Boston's bridge girder, and with it 48 stay cables, 1.5 m
 * outboard of the deck it is supposed to stand on and 2.1 m above its surface
 * (`.probe-tmp/shoulderfix.ts`, claim C). Publishing the numbers costs two
 * cubic evaluations on a parameter `sampleAtDistance` has already solved for.
 *
 * Structurally a superset of `TrackSample`, so anything typed against the
 * contract keeps working unchanged and nothing in `core` had to move.
 */
export interface SplineSample extends TrackSample {
  /** Authored off-road shoulder width outside the kerb, driver's LEFT, metres. */
  shoulderL: number;
  /** ...and driver's RIGHT. */
  shoulderR: number;
}

/** Discrete + smooth attributes at an arc length. */
export interface SplineAttribs {
  halfWidth: number;
  /** radians */
  bank: number;
  shoulderL: number;
  shoulderR: number;
  surface: SurfaceType;
  shoulderSurface: SurfaceType;
  wallL: WallStyle;
  wallR: WallStyle;
  flags: number;
  /** Index of the control point that owns this segment. */
  node: number;
}

export interface SplineDefaults {
  hw: number;
  bank: number;
  shL: number;
  shR: number;
  surface: SurfaceType;
  shoulderSurface: SurfaceType;
  wallL: WallStyle;
  wallR: WallStyle;
  flags: number;
}

const DEFAULTS: SplineDefaults = {
  hw: 11,
  bank: 0,
  shL: 5,
  shR: 5,
  surface: SurfaceType.Road,
  shoulderSurface: SurfaceType.Grass,
  wallL: 'guardrail',
  wallR: 'guardrail',
  flags: 0,
};

export function resolveNodes(
  specs: readonly SplineNodeSpec[],
  defaults: Partial<SplineDefaults> = {},
): SplineNode[] {
  const d: SplineDefaults = { ...DEFAULTS, ...defaults };
  return specs.map((s) => ({
    x: s.p[0], y: s.p[1], z: s.p[2],
    hw: s.hw ?? d.hw,
    bank: ((s.bank ?? d.bank) * Math.PI) / 180,
    shL: s.shL ?? d.shL,
    shR: s.shR ?? d.shR,
    surface: s.surface ?? d.surface,
    shoulderSurface: s.shoulderSurface ?? d.shoulderSurface,
    wallL: s.wallL ?? d.wallL,
    wallR: s.wallR ?? d.wallR,
    flags: s.flags ?? d.flags,
    tag: s.tag ?? '',
  }));
}

// ---------------------------------------------------------------------------
// Module scratch — nothing in here allocates per call
// ---------------------------------------------------------------------------

const _p = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

/** Rodrigues rotation of `v` about the unit axis `k` by `ang`, in place. */
function rotateAbout(v: THREE.Vector3, k: THREE.Vector3, ang: number): THREE.Vector3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const kx = k.x, ky = k.y, kz = k.z;
  const vx = v.x, vy = v.y, vz = v.z;
  // k x v
  const cx = ky * vz - kz * vy;
  const cy = kz * vx - kx * vz;
  const cz = kx * vy - ky * vx;
  const kd = (kx * vx + ky * vy + kz * vz) * (1 - c);
  v.x = vx * c + cx * s + kx * kd;
  v.y = vy * c + cy * s + ky * kd;
  v.z = vz * c + cz * s + kz * kd;
  return v;
}

const DENSE_PER_SEG = 48;

// ---------------------------------------------------------------------------

export class TrackSpline {
  readonly nodes: SplineNode[];
  readonly closed: boolean;
  /** Number of cubic segments. */
  readonly segCount: number;
  /** Total arc length, metres. */
  readonly length: number;

  /** Cubic coefficients per segment: [ax..dz] laid out a,b,c,d each xyz. */
  private co: Float64Array;
  /** Per-segment cubic coefficients for the 4 smooth scalar channels. */
  private sc: Float64Array; // segCount * 4 channels * 4 coeffs
  /** Endpoint values per channel per segment, for overshoot clamping. */
  private scEnds: Float64Array; // segCount * 4 * 2

  /** Dense cumulative arc length; DENSE_PER_SEG samples per segment + 1. */
  private denseCum: Float64Array;

  // --- arc-uniform LUT -----------------------------------------------------
  private lutN = 0;
  private lutStep = 1;
  private lutParam!: Float64Array;
  private lutPos!: Float32Array;
  private lutNrm!: Float32Array;

  // --- projection grid -----------------------------------------------------
  private gMinX = 0;
  private gMinZ = 0;
  private gCell = 5;
  private gW = 1;
  private gH = 1;
  private gSeeds!: Int32Array; // 4 per cell, -1 = empty
  private coarseStride = 1;
  /** Squared radius within which a seeded projection is believed. */
  private seedTrustR2 = 4096;

  /** Bounding box of the centreline (before width). */
  readonly bounds = new THREE.Box3();

  constructor(nodes: SplineNode[], closed = true) {
    if (nodes.length < (closed ? 3 : 2)) {
      throw new Error(`[TrackSpline] need >= ${closed ? 3 : 2} control points`);
    }
    this.nodes = nodes;
    this.closed = closed;
    this.segCount = closed ? nodes.length : nodes.length - 1;

    const ns = this.segCount;
    this.co = new Float64Array(ns * 12);
    this.sc = new Float64Array(ns * 16);
    this.scEnds = new Float64Array(ns * 8);
    this.denseCum = new Float64Array(ns * DENSE_PER_SEG + 1);

    this.buildCoefficients();
    this.length = this.buildArcTable();
    this.buildLut();
    this.buildFrames();
    this.buildGrid();
  }

  // =========================================================================
  //  Construction
  // =========================================================================

  private nodeAt(i: number): SplineNode {
    const n = this.nodes.length;
    if (this.closed) return this.nodes[((i % n) + n) % n];
    return this.nodes[clamp(i, 0, n - 1)];
  }

  /**
   * Non-uniform (centripetal) Catmull-Rom -> per-segment cubic coefficients.
   *
   *   knots  t0..t3 spaced by |dP|^0.5
   *   m1 = (t2-t1) * ( (P1-P0)/(t1-t0) - (P2-P0)/(t2-t0) + (P2-P1)/(t2-t1) )
   *   m2 = (t2-t1) * ( (P2-P1)/(t2-t1) - (P3-P1)/(t3-t1) + (P3-P2)/(t3-t2) )
   *
   * then Hermite -> power basis so evaluation is 3 fused multiply-adds.
   */
  private buildCoefficients(): void {
    const ALPHA = 0.5;
    const ns = this.segCount;

    for (let i = 0; i < ns; i++) {
      const P0 = this.nodeAt(i - 1);
      const P1 = this.nodeAt(i);
      const P2 = this.nodeAt(i + 1);
      const P3 = this.nodeAt(i + 2);

      const d01 = Math.max(1e-4, Math.hypot(P1.x - P0.x, P1.y - P0.y, P1.z - P0.z));
      const d12 = Math.max(1e-4, Math.hypot(P2.x - P1.x, P2.y - P1.y, P2.z - P1.z));
      const d23 = Math.max(1e-4, Math.hypot(P3.x - P2.x, P3.y - P2.y, P3.z - P2.z));

      const k01 = Math.pow(d01, ALPHA);
      const k12 = Math.pow(d12, ALPHA);
      const k23 = Math.pow(d23, ALPHA);

      const o = i * 12;
      for (let axis = 0; axis < 3; axis++) {
        const p0 = axis === 0 ? P0.x : axis === 1 ? P0.y : P0.z;
        const p1 = axis === 0 ? P1.x : axis === 1 ? P1.y : P1.z;
        const p2 = axis === 0 ? P2.x : axis === 1 ? P2.y : P2.z;
        const p3 = axis === 0 ? P3.x : axis === 1 ? P3.y : P3.z;

        const m1 = k12 * ((p1 - p0) / k01 - (p2 - p0) / (k01 + k12) + (p2 - p1) / k12);
        const m2 = k12 * ((p2 - p1) / k12 - (p3 - p1) / (k12 + k23) + (p3 - p2) / k23);

        this.co[o + axis] = p1;                                  // a
        this.co[o + 3 + axis] = m1;                              // b
        this.co[o + 6 + axis] = -3 * p1 + 3 * p2 - 2 * m1 - m2;  // c
        this.co[o + 9 + axis] = 2 * p1 - 2 * p2 + m1 + m2;       // d
      }

      // --- smooth scalar channels (same basis, clamped on evaluation) ------
      const ch = [
        [P0.hw, P1.hw, P2.hw, P3.hw],
        [P0.bank, P1.bank, P2.bank, P3.bank],
        [P0.shL, P1.shL, P2.shL, P3.shL],
        [P0.shR, P1.shR, P2.shR, P3.shR],
      ];
      for (let c = 0; c < 4; c++) {
        const [v0, v1, v2, v3] = ch[c];
        const m1 = k12 * ((v1 - v0) / k01 - (v2 - v0) / (k01 + k12) + (v2 - v1) / k12);
        const m2 = k12 * ((v2 - v1) / k12 - (v3 - v1) / (k12 + k23) + (v3 - v2) / k23);
        const so = i * 16 + c * 4;
        this.sc[so + 0] = v1;
        this.sc[so + 1] = m1;
        this.sc[so + 2] = -3 * v1 + 3 * v2 - 2 * m1 - m2;
        this.sc[so + 3] = 2 * v1 - 2 * v2 + m1 + m2;
        this.scEnds[i * 8 + c * 2 + 0] = Math.min(v1, v2);
        this.scEnds[i * 8 + c * 2 + 1] = Math.max(v1, v2);
      }
    }
  }

  /** Integrate chord lengths into `denseCum`. Returns total length. */
  private buildArcTable(): number {
    const ns = this.segCount;
    let acc = 0;
    this.denseCum[0] = 0;
    let px = 0, py = 0, pz = 0;
    this.evalParam(0, _p);
    px = _p.x; py = _p.y; pz = _p.z;
    let w = 1;
    for (let i = 0; i < ns; i++) {
      for (let k = 1; k <= DENSE_PER_SEG; k++) {
        this.evalParam(i + k / DENSE_PER_SEG, _p);
        acc += Math.hypot(_p.x - px, _p.y - py, _p.z - pz);
        px = _p.x; py = _p.y; pz = _p.z;
        this.denseCum[w++] = acc;
      }
    }
    return acc;
  }

  /** Resample into an arc-uniform LUT with >= 2048 entries. */
  private buildLut(): void {
    const n = Math.max(2048, Math.ceil(this.length / 0.5));
    this.lutN = n;
    this.lutStep = this.length / n;
    this.lutParam = new Float64Array(n + 1);
    this.lutPos = new Float32Array((n + 1) * 3);
    this.lutNrm = new Float32Array((n + 1) * 3);

    const dense = this.denseCum;
    let cursor = 0;
    for (let j = 0; j <= n; j++) {
      const d = Math.min(this.length, j * this.lutStep);
      while (cursor < dense.length - 2 && dense[cursor + 1] < d) cursor++;
      const a = dense[cursor];
      const bb = dense[cursor + 1];
      const f = bb - a > 1e-9 ? (d - a) / (bb - a) : 0;
      const s = (cursor + f) / DENSE_PER_SEG;
      this.lutParam[j] = Math.min(s, this.segCount);
      this.evalParam(this.lutParam[j], _p);
      this.lutPos[j * 3 + 0] = _p.x;
      this.lutPos[j * 3 + 1] = _p.y;
      this.lutPos[j * 3 + 2] = _p.z;
      this.bounds.expandByPoint(_p);
    }
  }

  /**
   * Parallel transport (rotation-minimising) frames over the LUT, then remove
   * the closure twist so a closed loop's frame is exactly periodic.
   */
  private buildFrames(): void {
    const n = this.lutN;
    const nrm = this.lutNrm;

    // seed: world up, made perpendicular to the first tangent
    this.tangentAtParam(this.lutParam[0], _t);
    _n.set(0, 1, 0);
    if (Math.abs(_t.y) > 0.98) _n.set(1, 0, 0);
    _n.addScaledVector(_t, -_n.dot(_t)).normalize();
    nrm[0] = _n.x; nrm[1] = _n.y; nrm[2] = _n.z;

    const prevT = new THREE.Vector3().copy(_t);
    const cur = new THREE.Vector3().copy(_n);

    for (let j = 1; j <= n; j++) {
      this.tangentAtParam(this.lutParam[j], _t);
      // minimal rotation taking prevT -> _t, applied to the carried normal
      _ax.crossVectors(prevT, _t);
      const sinA = _ax.length();
      if (sinA > 1e-7) {
        _ax.multiplyScalar(1 / sinA);
        const ang = Math.atan2(sinA, clamp(prevT.dot(_t), -1, 1));
        rotateAbout(cur, _ax, ang);
      }
      // re-orthogonalise against drift
      cur.addScaledVector(_t, -cur.dot(_t));
      const l = cur.length();
      if (l < 1e-6) {
        cur.set(0, 1, 0).addScaledVector(_t, -_t.y).normalize();
      } else {
        cur.multiplyScalar(1 / l);
      }
      nrm[j * 3 + 0] = cur.x;
      nrm[j * 3 + 1] = cur.y;
      nrm[j * 3 + 2] = cur.z;
      prevT.copy(_t);
    }

    if (!this.closed) return;

    // Residual twist between the transported end frame and the start frame.
    this.tangentAtParam(this.lutParam[0], _t);
    _n.set(nrm[0], nrm[1], nrm[2]);
    _tmp.set(nrm[n * 3 + 0], nrm[n * 3 + 1], nrm[n * 3 + 2]);
    _tmp.addScaledVector(_t, -_tmp.dot(_t)).normalize();
    _tmp2.crossVectors(_tmp, _n);
    const twist = Math.atan2(_tmp2.dot(_t), clamp(_tmp.dot(_n), -1, 1));

    if (Math.abs(twist) > 1e-6) {
      for (let j = 0; j <= n; j++) {
        const f = j / n;
        this.tangentAtParam(this.lutParam[j], _t);
        cur.set(nrm[j * 3 + 0], nrm[j * 3 + 1], nrm[j * 3 + 2]);
        rotateAbout(cur, _t, twist * f);
        cur.addScaledVector(_t, -cur.dot(_t)).normalize();
        nrm[j * 3 + 0] = cur.x;
        nrm[j * 3 + 1] = cur.y;
        nrm[j * 3 + 2] = cur.z;
      }
    }
  }

  /**
   * Bucket grid for O(1) projection seeding. Each cell keeps up to four seed
   * samples that are far apart in arc length, so stacked geometry (spirals,
   * flyovers) still resolves to the correct layer once we compare in 3D.
   */
  private buildGrid(): void {
    let maxCorridor = 0;
    for (const nd of this.nodes) {
      maxCorridor = Math.max(maxCorridor, nd.hw + Math.max(nd.shL, nd.shR) + 2);
    }
    const margin = maxCorridor + 26;
    const trust = maxCorridor + 14;
    this.seedTrustR2 = trust * trust;
    this.gCell = 5;
    this.gMinX = this.bounds.min.x - margin;
    this.gMinZ = this.bounds.min.z - margin;
    this.gW = Math.max(1, Math.ceil((this.bounds.max.x - this.bounds.min.x + margin * 2) / this.gCell));
    this.gH = Math.max(1, Math.ceil((this.bounds.max.z - this.bounds.min.z + margin * 2) / this.gCell));
    this.gSeeds = new Int32Array(this.gW * this.gH * 4).fill(-1);

    // Stamp every ~2 m of centreline into the cells within `radius`.
    this.coarseStride = Math.max(1, Math.round(2 / this.lutStep));
    const radius = margin;
    const cellR = Math.ceil(radius / this.gCell);
    const sepMetres = Math.max(18, this.length * 0.012);

    for (let j = 0; j <= this.lutN; j += this.coarseStride) {
      const sx = this.lutPos[j * 3 + 0];
      const sz = this.lutPos[j * 3 + 2];
      const cx = Math.floor((sx - this.gMinX) / this.gCell);
      const cz = Math.floor((sz - this.gMinZ) / this.gCell);
      for (let oz = -cellR; oz <= cellR; oz++) {
        const gz = cz + oz;
        if (gz < 0 || gz >= this.gH) continue;
        for (let ox = -cellR; ox <= cellR; ox++) {
          const gx = cx + ox;
          if (gx < 0 || gx >= this.gW) continue;
          const ccx = this.gMinX + (gx + 0.5) * this.gCell;
          const ccz = this.gMinZ + (gz + 0.5) * this.gCell;
          const dd = (ccx - sx) * (ccx - sx) + (ccz - sz) * (ccz - sz);
          if (dd > radius * radius) continue;
          this.insertSeed(gx, gz, j, dd, ccx, ccz, sepMetres);
        }
      }
    }
  }

  private insertSeed(
    gx: number, gz: number, idx: number, dist2: number,
    ccx: number, ccz: number, sep: number,
  ): void {
    const base = (gz * this.gW + gx) * 4;
    const seeds = this.gSeeds;
    const dIdx = idx * this.lutStep;

    // Replace a stored seed that belongs to the same stretch of track.
    for (let s = 0; s < 4; s++) {
      const e = seeds[base + s];
      if (e < 0) continue;
      let delta = Math.abs(e * this.lutStep - dIdx);
      if (this.closed) delta = Math.min(delta, this.length - delta);
      if (delta < sep) {
        const ex = this.lutPos[e * 3 + 0] - ccx;
        const ez = this.lutPos[e * 3 + 2] - ccz;
        if (dist2 < ex * ex + ez * ez) seeds[base + s] = idx;
        return;
      }
    }
    // Take a free slot.
    for (let s = 0; s < 4; s++) {
      if (seeds[base + s] < 0) { seeds[base + s] = idx; return; }
    }
    // Full: evict the furthest.
    let worst = -1;
    let worstD = dist2;
    for (let s = 0; s < 4; s++) {
      const e = seeds[base + s];
      const ex = this.lutPos[e * 3 + 0] - ccx;
      const ez = this.lutPos[e * 3 + 2] - ccz;
      const d = ex * ex + ez * ez;
      if (d > worstD) { worstD = d; worst = s; }
    }
    if (worst >= 0) seeds[base + worst] = idx;
  }

  // =========================================================================
  //  Raw parameter-space evaluation
  // =========================================================================

  /** Split a global parameter into (segment, local u), wrapping if closed. */
  private split(s: number): number {
    const ns = this.segCount;
    if (this.closed) {
      s = s % ns;
      if (s < 0) s += ns;
    } else {
      s = clamp(s, 0, ns - 1e-9);
    }
    return s;
  }

  evalParam(s: number, out: THREE.Vector3): THREE.Vector3 {
    s = this.split(s);
    let i = Math.floor(s);
    if (i >= this.segCount) i = this.segCount - 1;
    const u = s - i;
    const o = i * 12;
    const c = this.co;
    const u2 = u * u;
    const u3 = u2 * u;
    out.set(
      c[o] + c[o + 3] * u + c[o + 6] * u2 + c[o + 9] * u3,
      c[o + 1] + c[o + 4] * u + c[o + 7] * u2 + c[o + 10] * u3,
      c[o + 2] + c[o + 5] * u + c[o + 8] * u2 + c[o + 11] * u3,
    );
    return out;
  }

  /** dP/du (not unit length). */
  derivParam(s: number, out: THREE.Vector3): THREE.Vector3 {
    s = this.split(s);
    let i = Math.floor(s);
    if (i >= this.segCount) i = this.segCount - 1;
    const u = s - i;
    const o = i * 12;
    const c = this.co;
    const u2 = u * u;
    out.set(
      c[o + 3] + 2 * c[o + 6] * u + 3 * c[o + 9] * u2,
      c[o + 4] + 2 * c[o + 7] * u + 3 * c[o + 10] * u2,
      c[o + 5] + 2 * c[o + 8] * u + 3 * c[o + 11] * u2,
    );
    return out;
  }

  /** d2P/du2. */
  deriv2Param(s: number, out: THREE.Vector3): THREE.Vector3 {
    s = this.split(s);
    let i = Math.floor(s);
    if (i >= this.segCount) i = this.segCount - 1;
    const u = s - i;
    const o = i * 12;
    const c = this.co;
    out.set(
      2 * c[o + 6] + 6 * c[o + 9] * u,
      2 * c[o + 7] + 6 * c[o + 10] * u,
      2 * c[o + 8] + 6 * c[o + 11] * u,
    );
    return out;
  }

  tangentAtParam(s: number, out: THREE.Vector3): THREE.Vector3 {
    this.derivParam(s, out);
    const l = out.length();
    if (l < 1e-9) out.set(0, 0, -1);
    else out.multiplyScalar(1 / l);
    return out;
  }

  // =========================================================================
  //  Arc-length space
  // =========================================================================

  /** Wrap (closed) or clamp (open) a distance into the valid range. */
  wrapDistance(d: number): number {
    if (this.closed) {
      d = d % this.length;
      if (d < 0) d += this.length;
      return d;
    }
    return clamp(d, 0, this.length);
  }

  /** Curve parameter at an arc length. O(1). */
  paramAtDistance(d: number): number {
    d = this.wrapDistance(d);
    const f = d / this.lutStep;
    let i = Math.floor(f);
    if (i >= this.lutN) i = this.lutN - 1;
    const frac = f - i;
    const a = this.lutParam[i];
    let bb = this.lutParam[i + 1];
    if (bb < a) bb += this.segCount; // wrap seam
    return a + (bb - a) * frac;
  }

  /** Arc length at a curve parameter. */
  distanceAtParam(s: number): number {
    s = this.split(s);
    const f = s * DENSE_PER_SEG;
    let i = Math.floor(f);
    const maxI = this.denseCum.length - 2;
    if (i > maxI) i = maxI;
    const frac = f - i;
    return this.denseCum[i] + (this.denseCum[i + 1] - this.denseCum[i]) * frac;
  }

  /** Normalised lap progress at an arc length. */
  tAtDistance(d: number): number {
    return this.wrapDistance(d) / this.length;
  }

  /** Transported (unbanked) road-up at an arc length, into `out`. */
  private transportedNormal(d: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.wrapDistance(d) / this.lutStep;
    let i = Math.floor(f);
    if (i >= this.lutN) i = this.lutN - 1;
    const frac = f - i;
    const nr = this.lutNrm;
    const a = i * 3;
    const b = (i + 1) * 3;
    out.set(
      nr[a] + (nr[b] - nr[a]) * frac,
      nr[a + 1] + (nr[b + 1] - nr[a + 1]) * frac,
      nr[a + 2] + (nr[b + 2] - nr[a + 2]) * frac,
    );
    const l = out.length();
    if (l < 1e-6) out.set(0, 1, 0);
    else out.multiplyScalar(1 / l);
    return out;
  }

  /** Smooth scalar channel (0 hw, 1 bank, 2 shL, 3 shR) at a parameter. */
  private scalarAtParam(s: number, ch: number): number {
    s = this.split(s);
    let i = Math.floor(s);
    if (i >= this.segCount) i = this.segCount - 1;
    const u = s - i;
    const o = i * 16 + ch * 4;
    const v =
      this.sc[o] + this.sc[o + 1] * u + this.sc[o + 2] * u * u + this.sc[o + 3] * u * u * u;
    // Clamp to the segment's endpoint range: hand-authored width/bank changes
    // must never overshoot into something the designer didn't ask for.
    const lo = this.scEnds[i * 8 + ch * 2];
    const hi = this.scEnds[i * 8 + ch * 2 + 1];
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Owning control-point index at an arc length. */
  nodeIndexAtDistance(d: number): number {
    const s = this.paramAtDistance(d);
    let i = Math.floor(this.split(s));
    if (i >= this.segCount) i = this.segCount - 1;
    return i;
  }

  attribsAtDistance(d: number, out: SplineAttribs): SplineAttribs {
    const s = this.paramAtDistance(d);
    let i = Math.floor(this.split(s));
    if (i >= this.segCount) i = this.segCount - 1;
    const nd = this.nodes[i];
    out.halfWidth = this.scalarAtParam(s, 0);
    out.bank = this.scalarAtParam(s, 1);
    out.shoulderL = this.scalarAtParam(s, 2);
    out.shoulderR = this.scalarAtParam(s, 3);
    out.surface = nd.surface;
    out.shoulderSurface = nd.shoulderSurface;
    out.wallL = nd.wallL;
    out.wallR = nd.wallR;
    out.flags = nd.flags;
    out.node = i;
    return out;
  }

  /** Flags at an arc length (cheap path — no attribute interpolation). */
  flagsAtDistance(d: number): number {
    return this.nodes[this.nodeIndexAtDistance(d)].flags;
  }

  // =========================================================================
  //  The main sampling entry point
  // =========================================================================

  /**
   * Fill `out` with the full frame at arc length `d`. `out` is written in
   * place; nothing allocates.
   */
  sampleAtDistance(d: number, out: SplineSample): SplineSample {
    const dw = this.wrapDistance(d);
    const s = this.paramAtDistance(dw);

    this.evalParam(s, out.position);
    this.derivParam(s, _d1);
    const v = _d1.length() || 1e-6;
    out.tangent.copy(_d1).multiplyScalar(1 / v);

    this.transportedNormal(dw, _n);
    // orthogonalise against the exact tangent
    _n.addScaledVector(out.tangent, -_n.dot(out.tangent));
    const nl = _n.length();
    if (nl < 1e-6) _n.set(0, 1, 0);
    else _n.multiplyScalar(1 / nl);

    const bank = this.scalarAtParam(s, 1);
    if (bank !== 0) rotateAbout(_n, out.tangent, bank);

    out.normal.copy(_n);
    out.binormal.crossVectors(out.tangent, _n).normalize();

    out.halfWidth = this.scalarAtParam(s, 0);
    out.bank = bank;
    out.distance = dw;
    out.t = dw / this.length;
    // Channels 2 and 3 on the parameter that is already solved: two cubics, no
    // second LUT search. See `SplineSample` for what used to happen without
    // them — every consumer outside `src/track` guessed 3 m.
    out.shoulderL = this.scalarAtParam(s, 2);
    out.shoulderR = this.scalarAtParam(s, 3);

    // Signed curvature about the road up: k = (r'' . right) / |r'|^2
    this.deriv2Param(s, _d2);
    out.curvature = _d2.dot(out.binormal) / (v * v);
    return out;
  }

  /** Sample by normalised lap progress. */
  sampleAt(t: number, out: SplineSample): SplineSample {
    return this.sampleAtDistance(t * this.length, out);
  }

  // =========================================================================
  //  Projection
  // =========================================================================

  /**
   * Damped Newton on arc length: minimise |P(d) - q|^2.
   *   g(d)  = |P(d) - q|^2 / 2
   *   g'(d) = (P - q) . T
   *   g''(d) ~ 1 + (P - q) . dT/dd
   */
  private refine(d: number, point: THREE.Vector3, iters: number): number {
    const stepMax = this.coarseStride * this.lutStep * 1.6;
    for (let it = 0; it < iters; it++) {
      const s = this.paramAtDistance(d);
      this.evalParam(s, _p);
      this.derivParam(s, _d1);
      const v = _d1.length() || 1e-6;
      _t.copy(_d1).multiplyScalar(1 / v);
      _tmp.copy(_p).sub(point);
      const g1 = _tmp.dot(_t);
      this.deriv2Param(s, _d2);
      const tdotd2 = _t.dot(_d2);
      _tmp2.copy(_d2).addScaledVector(_t, -tdotd2).multiplyScalar(1 / (v * v));
      const g2 = 1 + _tmp.dot(_tmp2);
      const denom = g2 > 0.15 ? g2 : 0.15;
      let step = g1 / denom;
      if (step > stepMax) step = stepMax;
      else if (step < -stepMax) step = -stepMax;
      d = this.wrapDistance(d - step);
      if (Math.abs(step) < 1e-4) break;
    }
    return d;
  }

  /**
   * Nearest arc length on the centreline to `point`.
   * Grid seed -> pick the best candidate in 3D -> damped Newton on arc length.
   *
   * `seed` is a previous answer for a nearby point (a kart's other wheels, the
   * same kart one tick ago). When it converges to something plausible the grid
   * lookup is skipped entirely, which is the difference between the ~5760
   * ground probes a second costing 12 ms and costing 4.
   */
  nearestDistance(point: THREE.Vector3, seed = -1): number {
    if (seed >= 0) {
      const d = this.refine(this.wrapDistance(seed), point, 3);
      let delta = Math.abs(d - seed);
      if (this.closed) delta = Math.min(delta, this.length - delta);
      if (delta < 9) {
        this.evalParam(this.paramAtDistance(d), _p);
        if (_p.distanceToSquared(point) < this.seedTrustR2) return d;
      }
    }

    let best = -1;
    let bestD2 = Infinity;

    const gx = Math.floor((point.x - this.gMinX) / this.gCell);
    const gz = Math.floor((point.z - this.gMinZ) / this.gCell);
    if (gx >= 0 && gx < this.gW && gz >= 0 && gz < this.gH) {
      const base = (gz * this.gW + gx) * 4;
      for (let s = 0; s < 4; s++) {
        const e = this.gSeeds[base + s];
        if (e < 0) continue;
        const dx = this.lutPos[e * 3] - point.x;
        const dy = this.lutPos[e * 3 + 1] - point.y;
        const dz = this.lutPos[e * 3 + 2] - point.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = e; }
      }
    }

    if (best < 0) {
      // Far outside the corridor (or off the grid): strided fallback scan.
      const stride = this.coarseStride * 4;
      for (let e = 0; e <= this.lutN; e += stride) {
        const dx = this.lutPos[e * 3] - point.x;
        const dy = this.lutPos[e * 3 + 1] - point.y;
        const dz = this.lutPos[e * 3 + 2] - point.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = e; }
      }
    }

    return this.refine(best * this.lutStep, point, 5);
  }

  /** Nearest centreline sample to a world position. */
  project(point: THREE.Vector3, out: SplineSample): SplineSample {
    return this.sampleAtDistance(this.nearestDistance(point), out);
  }

  /** Signed lateral offset of `point` from a sample: +right, metres. */
  lateralOf(point: THREE.Vector3, sample: TrackSample): number {
    return (
      (point.x - sample.position.x) * sample.binormal.x +
      (point.y - sample.position.y) * sample.binormal.y +
      (point.z - sample.position.z) * sample.binormal.z
    );
  }

  /** Signed height of `point` above a sample's reference plane, metres. */
  verticalOf(point: THREE.Vector3, sample: TrackSample): number {
    return (
      (point.x - sample.position.x) * sample.normal.x +
      (point.y - sample.position.y) * sample.normal.y +
      (point.z - sample.position.z) * sample.normal.z
    );
  }

  // =========================================================================
  //  Introspection helpers used by the builder / dev tools
  // =========================================================================

  /** Arc length at which control point `i` sits. */
  distanceOfNode(i: number): number {
    return this.distanceAtParam(i);
  }

  /** Max |curvature| in a window, for adaptive tessellation. */
  curvatureAtDistance(d: number): number {
    const s = this.paramAtDistance(d);
    this.derivParam(s, _d1);
    const v = _d1.length() || 1e-6;
    this.deriv2Param(s, _d2);
    this.transportedNormal(d, _n);
    _n.addScaledVector(_d1, -_n.dot(_d1) / (v * v));
    _b.crossVectors(_d1, _n).normalize();
    return _d2.dot(_b) / (v * v);
  }
}

/** Allocate an empty SplineSample. */
export function makeSample(): SplineSample {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: 11,
    t: 0,
    distance: 0,
    curvature: 0,
    bank: 0,
    shoulderL: 5,
    shoulderR: 5,
  };
}

export function makeAttribs(): SplineAttribs {
  return {
    halfWidth: 11,
    bank: 0,
    shoulderL: 5,
    shoulderR: 5,
    surface: SurfaceType.Road,
    shoulderSurface: SurfaceType.Grass,
    wallL: 'guardrail',
    wallR: 'guardrail',
    flags: 0,
    node: 0,
  };
}

export function copySample(src: SplineSample, dst: SplineSample): SplineSample {
  dst.position.copy(src.position);
  dst.tangent.copy(src.tangent);
  dst.normal.copy(src.normal);
  dst.binormal.copy(src.binormal);
  dst.halfWidth = src.halfWidth;
  dst.t = src.t;
  dst.distance = src.distance;
  dst.curvature = src.curvature;
  dst.bank = src.bank;
  dst.shoulderL = src.shoulderL;
  dst.shoulderR = src.shoulderR;
  return dst;
}
