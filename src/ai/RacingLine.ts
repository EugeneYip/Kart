/**
 * ============================================================================
 *  FOXY KART — RACING LINE
 * ============================================================================
 *  A real optimised racing line, not the centreline.
 *
 *  HOW IT WORKS
 *  ------------
 *  1. The lap is discretised into ~600 stations. Each station owns a lateral
 *     offset (metres, + = driver's right) constrained to the drivable width
 *     minus a safety margin.
 *
 *  2. MINIMUM-CURVATURE RELAXATION. Each station is repeatedly moved toward the
 *     midpoint of its two neighbours, then projected back onto the road-width
 *     constraint. That single rule is what produces genuine out-in-out apexes:
 *     the shortest *smoothest* path through a corridor naturally runs wide on
 *     entry, clips the apex, and drifts wide again on exit.
 *
 *     Plain neighbour smoothing propagates information one station per
 *     iteration, so a 600-station lap would need many thousands of passes.
 *     We instead relax MULTIGRID style: coarse strides first (64, 32, 16 …)
 *     so long-wavelength corrections land immediately, then finer strides for
 *     local detail. ~180 total iterations converges properly.
 *
 *  3. SPEED-WEIGHTED REFINEMENT (a K1999-style second phase). After the first
 *     speed profile exists, slow stations get relaxed harder than fast ones —
 *     straightening the tight bits at the expense of the parts where you are
 *     nowhere near the grip limit anyway.
 *
 *  4. SPEED PROFILE. Per-station cornering limit from v = sqrt(a_lat * r) using
 *     the *line's* local radius (circumradius of three consecutive points),
 *     then a BACKWARD pass applying the braking limit and a FORWARD pass
 *     applying the acceleration limit. This is the part that makes an AI brake
 *     at the right moment instead of scraping the wall on corner entry.
 *
 *  5. ALTERNATE LINES. `inside` (defensive, hugs the apex kerb), `outside`
 *     (overtaking, later apex, faster entry), and any declared `shortcut`.
 *     Each carries its own curvature and speed profile so the AI can commit to
 *     one and still brake correctly.
 *
 *  Everything is stored in flat Float64Arrays and every query writes into a
 *  caller-owned output object — zero allocation after construction.
 * ============================================================================
 */

import * as THREE from 'three';
import type { ITrackService, TrackSample } from '@/core/Types';
import { clamp, clamp01, lerp, smoothstep } from '@/core/MathUtils';

// ---------------------------------------------------------------------------
//  Tuning
// ---------------------------------------------------------------------------

export interface RacingLineOptions {
  /** Number of stations around the lap. */
  stations: number;
  /** Relaxation strides, coarse → fine. */
  strides: readonly number[];
  /** Iterations per stride. */
  iterationsPerStride: number;
  /** Relaxation factor, 0..1. */
  relax: number;
  /** Extra rounds of speed-weighted refinement. */
  refinementRounds: number;
  /** Iterations per refinement round. */
  refinementIterations: number;
  /** Clearance kept from the road edge for the optimal line, metres. */
  edgeMargin: number;
  /** Clearance for the defensive / overtaking lines, metres. */
  variantMargin: number;
  /** How far `inside` pulls toward the apex kerb, metres. */
  insideShift: number;
  /** How far `outside` pushes away from the apex, metres. */
  outsideShift: number;
  /** Lateral acceleration budget for the speed profile, m/s². */
  latAccel: number;
  /** Deceleration used by the backward pass, m/s². */
  brakeAccel: number;
  /** Acceleration used by the forward pass, m/s². */
  driveAccel: number;
  /** Hard ceiling on target speed, m/s. */
  maxSpeed: number;
  /** Floor on target speed, m/s — never crawl. */
  minSpeed: number;
  /** Passes of the backward/forward relaxation (loop needs > 1). */
  profilePasses: number;
}

export const LINE_DEFAULTS: RacingLineOptions = {
  stations: 600,
  strides: [64, 32, 16, 8, 4, 2, 1],
  iterationsPerStride: 26,
  relax: 0.62,
  refinementRounds: 2,
  refinementIterations: 40,
  edgeMargin: 1.95,
  variantMargin: 2.5,
  insideShift: 3.0,
  outsideShift: 3.2,
  latAccel: 30.0,
  brakeAccel: 21.0,
  driveAccel: 13.5,
  maxSpeed: 36.0,
  minSpeed: 9.0,
  profilePasses: 4,
};

// ---------------------------------------------------------------------------
//  Public shapes
// ---------------------------------------------------------------------------

export type LineVariant = 'optimal' | 'inside' | 'outside' | 'shortcut';

/** Result of `RacingLine.sample()`. Reused — never retained by the callee. */
export interface LineSample {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  /** tangent × normal — points to the driver's right. */
  binormal: THREE.Vector3;
  /** Speed the profile says you can carry here, m/s. */
  targetSpeed: number;
  /** Signed curvature of the line, 1/m. Positive = turning right. */
  curvature: number;
  /** Lateral offset of the line from the centreline, metres, + = right. */
  lateral: number;
  /** Drivable half-width of the road here, metres. */
  halfWidth: number;
  /** Normalised lap progress, [0,1). */
  t: number;
  /** Arc length along the line, metres. */
  distance: number;
  /** Nearest station index. */
  station: number;
}

export function createLineSample(): LineSample {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    targetSpeed: 0,
    curvature: 0,
    lateral: 0,
    halfWidth: 10,
    t: 0,
    distance: 0,
    station: 0,
  };
}

export interface NearestResult {
  /** Normalised lap progress of the closest point, [0,1). */
  t: number;
  station: number;
  /** Signed lateral offset of the query point from the LINE, + = right. */
  lateral: number;
  /** Perpendicular distance to the line, metres. */
  distanceToLine: number;
  /** Arc length along the line at the closest point, metres. */
  distance: number;
  /** Signed lateral offset from the CENTRELINE, + = right. */
  lateralFromCentre: number;
  /** Drivable half-width there, metres. */
  halfWidth: number;
}

export function createNearestResult(): NearestResult {
  return {
    t: 0,
    station: 0,
    lateral: 0,
    distanceToLine: 0,
    distance: 0,
    lateralFromCentre: 0,
    halfWidth: 10,
  };
}

/** Result of `curvatureAhead()`. */
export interface CurvatureWindow {
  /** ∫κ ds over the window, radians. Positive = net right-hand corner. */
  signed: number;
  /** ∫|κ| ds over the window, radians. */
  absolute: number;
  /** Peak |κ| inside the window, 1/m. */
  peak: number;
  /** Lowest target speed inside the window, m/s. */
  minSpeed: number;
  /** Metres to the slowest station in the window. */
  distanceToMin: number;
}

export function createCurvatureWindow(): CurvatureWindow {
  return { signed: 0, absolute: 0, peak: 0, minSpeed: 0, distanceToMin: 0 };
}

export interface ShortcutSpec {
  /** Lap progress where the shortcut branches off, [0,1). */
  entryT: number;
  /** Lap progress where it rejoins, [0,1). */
  exitT: number;
  /** Lateral offset to hold through the shortcut, metres, + = right. */
  lateral: number;
  /** Speed cap while on it (rough surface etc.), m/s. */
  speedCap?: number;
  /** True if it needs a boost/mushroom to be viable. */
  requiresBoost?: boolean;
  /** Free-form id for debugging. */
  id?: string;
}

// ---------------------------------------------------------------------------
//  Internals
// ---------------------------------------------------------------------------

interface LinePath {
  variant: LineVariant;
  /** Lateral offsets from the centreline, metres, + = right. Length N. */
  offsets: Float64Array;
  /** World positions, length (N+1)*3 — index N mirrors 0. */
  pts: Float64Array;
  /** Unit tangents, length (N+1)*3. */
  tans: Float64Array;
  /** Segment length station i → i+1, length N. */
  ds: Float64Array;
  /** Cumulative arc length, length N+1, cum[0] = 0, cum[N] = length. */
  cum: Float64Array;
  length: number;
  /** Signed curvature, length N+1. */
  curv: Float64Array;
  /** Cumulative ∫κ ds, length N+1. */
  cumSigned: Float64Array;
  /** Cumulative ∫|κ| ds, length N+1. */
  cumAbs: Float64Array;
  totalSigned: number;
  totalAbs: number;
  /** Target speed, length N+1. */
  speed: Float64Array;
  minSpeed: number;
  maxSpeed: number;
  /** Only used by the shortcut path: stations where it is actually active. */
  active: Uint8Array | null;
  spec: ShortcutSpec | null;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();

// ---------------------------------------------------------------------------

export class RacingLine {
  readonly stations: number;
  /** Centreline lap length reported by the track, metres. */
  readonly lapLength: number;

  private readonly opt: RacingLineOptions;

  // ---- centreline geometry (length N+1, index N mirrors 0) ----------------
  private readonly cpos: Float64Array;
  private readonly ctan: Float64Array;
  private readonly cnorm: Float64Array;
  private readonly cbin: Float64Array;
  private readonly chalf: Float64Array;
  /** Usable half-width for the optimal line, metres. */
  private readonly usable: Float64Array;
  /** Usable half-width for the alternate lines, metres. */
  private readonly usableVariant: Float64Array;
  /** Smoothed sign of centreline curvature, -1..1. Used to place variants. */
  private readonly cornerSign: Float64Array;

  private readonly paths = new Map<LineVariant, LinePath>();
  private readonly shortcuts: ShortcutSpec[] = [];

  /** Scratch reused by internal relaxation so nothing allocates. */
  private readonly scratchOffsets: Float64Array;

  private built = false;

  constructor(track: ITrackService, options: Partial<RacingLineOptions> = {}) {
    this.opt = { ...LINE_DEFAULTS, ...options };
    const n = Math.max(64, Math.floor(this.opt.stations));
    this.stations = n;
    this.lapLength = Number.isFinite(track.lapLength) && track.lapLength > 1 ? track.lapLength : 1000;

    this.cpos = new Float64Array((n + 1) * 3);
    this.ctan = new Float64Array((n + 1) * 3);
    this.cnorm = new Float64Array((n + 1) * 3);
    this.cbin = new Float64Array((n + 1) * 3);
    this.chalf = new Float64Array(n + 1);
    this.usable = new Float64Array(n + 1);
    this.usableVariant = new Float64Array(n + 1);
    this.cornerSign = new Float64Array(n + 1);
    this.scratchOffsets = new Float64Array(n);

    this.readCentreline(track);
  }

  // -------------------------------------------------------------------------
  //  Build
  // -------------------------------------------------------------------------

  /** Read the centreline once. Track samples may be shared scratch — copy. */
  private readCentreline(track: ITrackService): void {
    const n = this.stations;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      let s: TrackSample | null = null;
      try {
        s = track.sampleAt(t);
      } catch {
        s = null;
      }
      const i3 = i * 3;
      if (!s || !s.position) {
        // Degenerate track — fall back to a circle so we never NaN out.
        const ang = t * Math.PI * 2;
        const r = this.lapLength / (Math.PI * 2);
        this.cpos[i3] = Math.cos(ang) * r;
        this.cpos[i3 + 1] = 0;
        this.cpos[i3 + 2] = Math.sin(ang) * r;
        this.ctan[i3] = -Math.sin(ang);
        this.ctan[i3 + 1] = 0;
        this.ctan[i3 + 2] = Math.cos(ang);
        this.cnorm[i3 + 1] = 1;
        this.cbin[i3] = Math.cos(ang);
        this.cbin[i3 + 2] = Math.sin(ang);
        this.chalf[i] = 10;
        continue;
      }
      this.cpos[i3] = s.position.x;
      this.cpos[i3 + 1] = s.position.y;
      this.cpos[i3 + 2] = s.position.z;

      _a.copy(s.tangent);
      if (_a.lengthSq() < 1e-8) _a.set(0, 0, -1);
      _a.normalize();
      this.ctan[i3] = _a.x;
      this.ctan[i3 + 1] = _a.y;
      this.ctan[i3 + 2] = _a.z;

      _b.copy(s.normal);
      if (_b.lengthSq() < 1e-8) _b.set(0, 1, 0);
      _b.normalize();
      this.cnorm[i3] = _b.x;
      this.cnorm[i3 + 1] = _b.y;
      this.cnorm[i3 + 2] = _b.z;

      // binormal = tangent × normal (driver's right). Recompute rather than
      // trust the track, so a mis-signed field can never invert our lines.
      _c.copy(_a).cross(_b);
      if (_c.lengthSq() < 1e-8) _c.set(1, 0, 0);
      _c.normalize();
      this.cbin[i3] = _c.x;
      this.cbin[i3 + 1] = _c.y;
      this.cbin[i3 + 2] = _c.z;

      const hw = Number.isFinite(s.halfWidth) && s.halfWidth > 0.5 ? s.halfWidth : 10;
      this.chalf[i] = hw;
    }
    // Mirror station N = station 0.
    const n3 = n * 3;
    for (let k = 0; k < 3; k++) {
      this.cpos[n3 + k] = this.cpos[k];
      this.ctan[n3 + k] = this.ctan[k];
      this.cnorm[n3 + k] = this.cnorm[k];
      this.cbin[n3 + k] = this.cbin[k];
    }
    this.chalf[n] = this.chalf[0];

    for (let i = 0; i <= n; i++) {
      this.usable[i] = Math.max(0.6, this.chalf[i] - this.opt.edgeMargin);
      this.usableVariant[i] = Math.max(0.4, this.chalf[i] - this.opt.variantMargin);
    }
  }

  /**
   * Run the optimisation. Cheap enough to call from `init()` (a few ms for 600
   * stations) but kept explicit so the caller controls when it happens.
   */
  build(): void {
    if (this.built) return;
    const n = this.stations;

    // --- corner sign: smoothed sign of the centreline's own curvature -------
    const rawK = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      rawK[i] = this.geometricCurvature(this.cpos, i, n);
    }
    rawK[n] = rawK[0];
    // Two boxcar passes ≈ a gaussian; keeps straights at ~0 so the alternate
    // lines collapse onto the optimal one where there is no corner to attack.
    const tmp = new Float64Array(n + 1);
    const halfWin = Math.max(2, Math.round(n / 90));
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? rawK : tmp;
      const dst = pass === 0 ? tmp : rawK;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -halfWin; k <= halfWin; k++) sum += src[(i + k + n * 2) % n];
        dst[i] = sum / (halfWin * 2 + 1);
      }
      dst[n] = dst[0];
    }
    // Normalise into -1..1 with a soft knee: 0.02 1/m (r = 50 m) reads as a
    // full-commitment corner.
    for (let i = 0; i <= n; i++) {
      const k = rawK[i] / 0.02;
      this.cornerSign[i] = clamp(k, -1, 1);
    }

    // --- optimal line -------------------------------------------------------
    const optimal = this.makePath('optimal');
    this.relax(optimal.offsets, this.usable, null);
    this.finalisePath(optimal);

    for (let round = 0; round < this.opt.refinementRounds; round++) {
      // Speed-weighted phase: slow stations are pulled harder toward minimum
      // curvature; fast stations are already nowhere near the grip limit.
      this.relax(optimal.offsets, this.usable, optimal);
      this.finalisePath(optimal);
    }
    this.paths.set('optimal', optimal);

    // --- alternates ---------------------------------------------------------
    const inside = this.makePath('inside');
    const outside = this.makePath('outside');
    for (let i = 0; i < n; i++) {
      const sgn = this.cornerSign[i];
      const lim = this.usableVariant[i];
      inside.offsets[i] = clamp(optimal.offsets[i] + this.opt.insideShift * sgn, -lim, lim);
      outside.offsets[i] = clamp(optimal.offsets[i] - this.opt.outsideShift * sgn, -lim, lim);
    }
    // A short fine-grained relaxation keeps them physically driveable without
    // erasing the deliberate bias.
    this.relaxFine(inside.offsets, this.usableVariant, 18, 0.35);
    this.relaxFine(outside.offsets, this.usableVariant, 18, 0.35);
    this.finalisePath(inside);
    this.finalisePath(outside);
    this.paths.set('inside', inside);
    this.paths.set('outside', outside);

    this.rebuildShortcut();
    this.built = true;
  }

  private makePath(variant: LineVariant): LinePath {
    const n = this.stations;
    return {
      variant,
      offsets: new Float64Array(n),
      pts: new Float64Array((n + 1) * 3),
      tans: new Float64Array((n + 1) * 3),
      ds: new Float64Array(n),
      cum: new Float64Array(n + 1),
      length: 0,
      curv: new Float64Array(n + 1),
      cumSigned: new Float64Array(n + 1),
      cumAbs: new Float64Array(n + 1),
      totalSigned: 0,
      totalAbs: 0,
      speed: new Float64Array(n + 1),
      minSpeed: 0,
      maxSpeed: 0,
      active: null,
      spec: null,
    };
  }

  /**
   * MINIMUM-CURVATURE RELAXATION, multigrid.
   *
   * For each station: take the midpoint of its two (strided) neighbours,
   * project that onto the local lateral axis, and move the offset a fraction
   * of the way there — then clamp back inside the road. `weightBy`, when
   * supplied, biases the step by how slow the station is (phase 2).
   */
  private relax(offsets: Float64Array, limits: Float64Array, weightBy: LinePath | null): void {
    const n = this.stations;
    const { strides, iterationsPerStride, relax, refinementIterations } = this.opt;
    const vmax = weightBy ? Math.max(1, weightBy.maxSpeed) : 1;

    const runStride = (stride: number, iterations: number) => {
      const s = Math.max(1, Math.min(stride, Math.floor(n / 3)));
      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
          const im = (i - s + n) % n;
          const ip = (i + s) % n;
          // Neighbour world positions.
          this.offsetPoint(offsets, im, _a);
          this.offsetPoint(offsets, ip, _b);
          // Midpoint.
          _c.addVectors(_a, _b).multiplyScalar(0.5);
          // Project onto this station's lateral axis.
          const i3 = i * 3;
          _d.set(this.cpos[i3], this.cpos[i3 + 1], this.cpos[i3 + 2]);
          _e.subVectors(_c, _d);
          const target =
            _e.x * this.cbin[i3] + _e.y * this.cbin[i3 + 1] + _e.z * this.cbin[i3 + 2];

          let step = relax;
          if (weightBy) {
            // 1 at the slowest station, 0.3 flat out.
            const slowness = 1 - clamp01(weightBy.speed[i] / vmax);
            step = relax * (0.3 + 0.7 * slowness);
          }
          const lim = limits[i];
          offsets[i] = clamp(lerp(offsets[i], target, step), -lim, lim);
        }
      }
    };

    if (weightBy) {
      runStride(1, refinementIterations);
      return;
    }
    for (const stride of strides) runStride(stride, iterationsPerStride);
  }

  /** Short, gentle, stride-1 relaxation. Used to make the alternates driveable. */
  private relaxFine(
    offsets: Float64Array,
    limits: Float64Array,
    iterations: number,
    step: number,
  ): void {
    const n = this.stations;
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i++) {
        const im = (i - 1 + n) % n;
        const ip = (i + 1) % n;
        this.offsetPoint(offsets, im, _a);
        this.offsetPoint(offsets, ip, _b);
        _c.addVectors(_a, _b).multiplyScalar(0.5);
        const i3 = i * 3;
        _d.set(this.cpos[i3], this.cpos[i3 + 1], this.cpos[i3 + 2]);
        _e.subVectors(_c, _d);
        const target = _e.x * this.cbin[i3] + _e.y * this.cbin[i3 + 1] + _e.z * this.cbin[i3 + 2];
        const lim = limits[i];
        offsets[i] = clamp(lerp(offsets[i], target, step), -lim, lim);
      }
    }
  }

  /** World position of station `i` at the given offsets. */
  private offsetPoint(offsets: Float64Array, i: number, out: THREE.Vector3): THREE.Vector3 {
    const i3 = i * 3;
    const o = offsets[i];
    out.set(
      this.cpos[i3] + this.cbin[i3] * o,
      this.cpos[i3 + 1] + this.cbin[i3 + 1] * o,
      this.cpos[i3 + 2] + this.cbin[i3 + 2] * o,
    );
    return out;
  }

  /** Recompute points, tangents, arc length, curvature and the speed profile. */
  private finalisePath(path: LinePath): void {
    const n = this.stations;
    const { pts, tans, ds, cum, curv, cumSigned, cumAbs, speed } = path;

    for (let i = 0; i < n; i++) {
      this.offsetPoint(path.offsets, i, _a);
      const i3 = i * 3;
      pts[i3] = _a.x;
      pts[i3 + 1] = _a.y;
      pts[i3 + 2] = _a.z;
    }
    const n3 = n * 3;
    pts[n3] = pts[0];
    pts[n3 + 1] = pts[1];
    pts[n3 + 2] = pts[2];

    // Arc length + tangents.
    let total = 0;
    cum[0] = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const j3 = ((i + 1) % n) * 3;
      const dx = pts[j3] - pts[i3];
      const dy = pts[j3 + 1] - pts[i3 + 1];
      const dz = pts[j3 + 2] - pts[i3 + 2];
      const len = Math.hypot(dx, dy, dz) || 1e-4;
      ds[i] = len;
      total += len;
      cum[i + 1] = total;
    }
    path.length = total;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const im3 = ((i - 1 + n) % n) * 3;
      const ip3 = ((i + 1) % n) * 3;
      // Central difference — smoother than a forward difference.
      let tx = pts[ip3] - pts[im3];
      let ty = pts[ip3 + 1] - pts[im3 + 1];
      let tz = pts[ip3 + 2] - pts[im3 + 2];
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l;
      ty /= l;
      tz /= l;
      tans[i3] = tx;
      tans[i3 + 1] = ty;
      tans[i3 + 2] = tz;
    }
    tans[n3] = tans[0];
    tans[n3 + 1] = tans[1];
    tans[n3 + 2] = tans[2];

    // Curvature from the circumradius of three consecutive points.
    for (let i = 0; i < n; i++) curv[i] = this.geometricCurvature(pts, i, n);
    // 3-tap smooth so the profile doesn't chase discretisation noise.
    const sc = this.scratchOffsets;
    for (let i = 0; i < n; i++) {
      sc[i] = (curv[(i - 1 + n) % n] + curv[i] * 2 + curv[(i + 1) % n]) * 0.25;
    }
    for (let i = 0; i < n; i++) curv[i] = sc[i];
    curv[n] = curv[0];

    // Cumulative curvature integrals (used for corner detection).
    let sSum = 0;
    let aSum = 0;
    cumSigned[0] = 0;
    cumAbs[0] = 0;
    for (let i = 0; i < n; i++) {
      sSum += curv[i] * ds[i];
      aSum += Math.abs(curv[i]) * ds[i];
      cumSigned[i + 1] = sSum;
      cumAbs[i + 1] = aSum;
    }
    path.totalSigned = sSum;
    path.totalAbs = aSum;

    // --- speed profile ------------------------------------------------------
    const { latAccel, brakeAccel, driveAccel, maxSpeed, minSpeed, profilePasses } = this.opt;
    const cap = path.spec && path.spec.speedCap ? path.spec.speedCap : Infinity;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(curv[i]);
      const vCorner = k > 1e-5 ? Math.sqrt(latAccel / k) : maxSpeed;
      let v = Math.min(maxSpeed, vCorner);
      if (path.active && path.active[i] === 1 && cap < v) v = cap;
      speed[i] = Math.max(minSpeed, v);
    }

    // Backward pass — braking limit. Repeated so the loop closure converges.
    for (let pass = 0; pass < profilePasses; pass++) {
      for (let k = n - 1; k >= 0; k--) {
        const j = (k + 1) % n;
        const limit = Math.sqrt(speed[j] * speed[j] + 2 * brakeAccel * ds[k]);
        if (speed[k] > limit) speed[k] = limit;
      }
      // Forward pass — acceleration limit.
      for (let k = 0; k < n; k++) {
        const im = (k - 1 + n) % n;
        const limit = Math.sqrt(speed[im] * speed[im] + 2 * driveAccel * ds[im]);
        if (speed[k] > limit) speed[k] = limit;
      }
    }
    speed[n] = speed[0];

    let vmin = Infinity;
    let vmax = 0;
    for (let i = 0; i < n; i++) {
      if (speed[i] < vmin) vmin = speed[i];
      if (speed[i] > vmax) vmax = speed[i];
    }
    path.minSpeed = vmin;
    path.maxSpeed = vmax;
  }

  /**
   * Signed curvature at station `i` of a packed point array, 1/m.
   * Positive = turning right (matches `TrackSample.curvature`).
   */
  private geometricCurvature(pts: Float64Array, i: number, n: number): number {
    const i0 = ((i - 1 + n) % n) * 3;
    const i1 = i * 3;
    const i2 = ((i + 1) % n) * 3;
    const ax = pts[i1] - pts[i0];
    const ay = pts[i1 + 1] - pts[i0 + 1];
    const az = pts[i1 + 2] - pts[i0 + 2];
    const bx = pts[i2] - pts[i1];
    const by = pts[i2 + 1] - pts[i1 + 1];
    const bz = pts[i2 + 2] - pts[i1 + 2];
    // cross = a × b
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const crossLen = Math.hypot(cx, cy, cz);
    const la = Math.hypot(ax, ay, az);
    const lb = Math.hypot(bx, by, bz);
    const lc = Math.hypot(pts[i2] - pts[i0], pts[i2 + 1] - pts[i0 + 1], pts[i2 + 2] - pts[i0 + 2]);
    const denom = la * lb * lc;
    if (denom < 1e-9 || crossLen < 1e-12) return 0;
    const kappa = (2 * crossLen) / denom;
    // Sign: a × b along the local up means a left turn ⇒ negative curvature.
    const i13 = i * 3;
    const up =
      cx * this.cnorm[i13] + cy * this.cnorm[i13 + 1] + cz * this.cnorm[i13 + 2];
    return up > 0 ? -kappa : kappa;
  }

  // -------------------------------------------------------------------------
  //  Shortcuts
  // -------------------------------------------------------------------------

  /** Declare a shortcut. Rebuilds the `shortcut` line. */
  declareShortcut(spec: ShortcutSpec): void {
    this.shortcuts.push(spec);
    if (this.built) this.rebuildShortcut();
  }

  get hasShortcut(): boolean {
    return this.paths.has('shortcut');
  }

  get shortcutSpecs(): readonly ShortcutSpec[] {
    return this.shortcuts;
  }

  private rebuildShortcut(): void {
    if (this.shortcuts.length === 0) {
      this.paths.delete('shortcut');
      return;
    }
    const n = this.stations;
    const optimal = this.paths.get('optimal');
    if (!optimal) return;
    const path = this.makePath('shortcut');
    path.active = new Uint8Array(n);
    path.spec = this.shortcuts[0];
    path.offsets.set(optimal.offsets);

    for (const sc of this.shortcuts) {
      const a = Math.floor(clamp01(sc.entryT) * n) % n;
      const b = Math.floor(clamp01(sc.exitT) * n) % n;
      const span = (b - a + n) % n || n;
      for (let k = 0; k <= span; k++) {
        const i = (a + k) % n;
        // Smooth in/out so the AI does not need an impossible steering input.
        const u = k / span;
        const w = smoothstep(Math.min(u, 1 - u) * 4);
        const lim = this.chalf[i] + 6; // shortcuts may legitimately leave the road
        path.offsets[i] = clamp(lerp(optimal.offsets[i], sc.lateral, w), -lim, lim);
        if (w > 0.35) path.active[i] = 1;
      }
    }
    this.finalisePath(path);
    this.paths.set('shortcut', path);
  }

  // -------------------------------------------------------------------------
  //  Queries
  // -------------------------------------------------------------------------

  private path(variant: LineVariant): LinePath {
    const p = this.paths.get(variant);
    if (p) return p;
    const o = this.paths.get('optimal');
    if (o) return o;
    // Should never happen — build() always creates 'optimal'.
    const fallback = this.makePath('optimal');
    this.finalisePath(fallback);
    this.paths.set('optimal', fallback);
    return fallback;
  }

  /** Total arc length of a line, metres. */
  lineLength(variant: LineVariant = 'optimal'): number {
    return this.path(variant).length;
  }

  /** Fastest / slowest target speeds on a line — used for debug colouring. */
  speedRange(variant: LineVariant = 'optimal'): { min: number; max: number } {
    const p = this.path(variant);
    return { min: p.minSpeed, max: p.maxSpeed };
  }

  /**
   * Sample the line at normalised lap progress `t`.
   * Writes into `out` and returns it — never allocates.
   */
  sample(t: number, out: LineSample, variant: LineVariant = 'optimal'): LineSample {
    const p = this.path(variant);
    const n = this.stations;
    const tt = t - Math.floor(t);
    const f = tt * n;
    let i0 = Math.floor(f);
    if (i0 < 0) i0 = 0;
    if (i0 >= n) i0 = n - 1;
    const frac = f - i0;
    const i1 = i0 + 1; // arrays are N+1 long, index N mirrors 0
    const a3 = i0 * 3;
    const b3 = i1 * 3;

    out.position.set(
      lerp(p.pts[a3], p.pts[b3], frac),
      lerp(p.pts[a3 + 1], p.pts[b3 + 1], frac),
      lerp(p.pts[a3 + 2], p.pts[b3 + 2], frac),
    );
    out.tangent
      .set(
        lerp(p.tans[a3], p.tans[b3], frac),
        lerp(p.tans[a3 + 1], p.tans[b3 + 1], frac),
        lerp(p.tans[a3 + 2], p.tans[b3 + 2], frac),
      )
      .normalize();
    out.normal
      .set(
        lerp(this.cnorm[a3], this.cnorm[b3], frac),
        lerp(this.cnorm[a3 + 1], this.cnorm[b3 + 1], frac),
        lerp(this.cnorm[a3 + 2], this.cnorm[b3 + 2], frac),
      )
      .normalize();
    out.binormal.copy(out.tangent).cross(out.normal);
    if (out.binormal.lengthSq() < 1e-8) {
      out.binormal.set(
        lerp(this.cbin[a3], this.cbin[b3], frac),
        lerp(this.cbin[a3 + 1], this.cbin[b3 + 1], frac),
        lerp(this.cbin[a3 + 2], this.cbin[b3 + 2], frac),
      );
    }
    out.binormal.normalize();

    out.targetSpeed = lerp(p.speed[i0], p.speed[i1], frac);
    out.curvature = lerp(p.curv[i0], p.curv[i1], frac);
    out.lateral = lerp(p.offsets[i0], p.offsets[i1 % n], frac);
    out.halfWidth = lerp(this.chalf[i0], this.chalf[i1], frac);
    out.distance = lerp(p.cum[i0], p.cum[i1], frac);
    out.t = tt;
    out.station = i0;
    return out;
  }

  /** Sample `metres` further along the line from progress `t`. */
  sampleAhead(
    t: number,
    metres: number,
    out: LineSample,
    variant: LineVariant = 'optimal',
  ): LineSample {
    const p = this.path(variant);
    const d = this.distanceAt(t, variant) + metres;
    return this.sample(this.tAtDistance(d, p), out, variant);
  }

  /** Arc length along the line at progress `t`, metres. */
  distanceAt(t: number, variant: LineVariant = 'optimal'): number {
    const p = this.path(variant);
    const n = this.stations;
    const tt = t - Math.floor(t);
    const f = tt * n;
    let i0 = Math.floor(f);
    if (i0 < 0) i0 = 0;
    if (i0 >= n) i0 = n - 1;
    return lerp(p.cum[i0], p.cum[i0 + 1], f - i0);
  }

  /** Inverse of `distanceAt` — normalised progress at an arc length. */
  private tAtDistance(distance: number, p: LinePath): number {
    const n = this.stations;
    const L = p.length || 1;
    let d = distance % L;
    if (d < 0) d += L;
    // Binary search the cumulative table.
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = p.cum[lo + 1] - p.cum[lo] || 1e-4;
    return (lo + (d - p.cum[lo]) / seg) / n;
  }

  /**
   * Closest point on the line to a world position.
   *
   * `hintStation >= 0` restricts the search to a window around the hint, which
   * is what the AI uses every tick (O(1) instead of O(N)).
   */
  nearest(
    position: THREE.Vector3,
    out: NearestResult,
    variant: LineVariant = 'optimal',
    hintStation = -1,
  ): NearestResult {
    const p = this.path(variant);
    const n = this.stations;

    let best = -1;
    let bestD2 = Infinity;

    const consider = (i: number) => {
      const i3 = i * 3;
      const dx = position.x - p.pts[i3];
      const dy = position.y - p.pts[i3 + 1];
      const dz = position.z - p.pts[i3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    };

    if (hintStation >= 0) {
      const win = Math.max(6, Math.round(n / 24));
      for (let k = -win; k <= win; k++) consider((hintStation + k + n * 2) % n);
      // Sanity: if we ended up on the window edge the hint was stale — rescan.
      const delta = Math.abs(((best - hintStation + n * 1.5) % n) - n * 0.5);
      if (delta >= win - 1) best = -1;
    }
    if (best < 0) {
      bestD2 = Infinity;
      const coarse = Math.max(1, Math.round(n / 96));
      for (let i = 0; i < n; i += coarse) consider(i);
      const around = coarse + 1;
      const centre = best;
      for (let k = -around; k <= around; k++) consider((centre + k + n * 2) % n);
    }

    // Refine to sub-station accuracy by projecting onto the two adjacent
    // segments and keeping whichever projection is legal.
    const i = best;
    let bt = i / n;
    const i3 = i * 3;
    _a.set(p.pts[i3], p.pts[i3 + 1], p.pts[i3 + 2]);
    const fwd3 = ((i + 1) % n) * 3;
    const bwd3 = ((i - 1 + n) % n) * 3;
    _b.set(p.pts[fwd3] - p.pts[i3], p.pts[fwd3 + 1] - p.pts[i3 + 1], p.pts[fwd3 + 2] - p.pts[i3 + 2]);
    _c.set(p.pts[bwd3] - p.pts[i3], p.pts[bwd3 + 1] - p.pts[i3 + 1], p.pts[bwd3 + 2] - p.pts[i3 + 2]);
    _d.subVectors(position, _a);
    const fLen2 = _b.lengthSq() || 1e-6;
    const bLen2 = _c.lengthSq() || 1e-6;
    const uf = clamp01(_d.dot(_b) / fLen2);
    const ub = clamp01(_d.dot(_c) / bLen2);
    if (uf > 0) bt = (i + uf) / n;
    else if (ub > 0) bt = (i - ub + n) / n;

    // Now resample at the refined t to get exact geometry.
    const tt = bt - Math.floor(bt);
    const f = tt * n;
    let s0 = Math.floor(f);
    if (s0 < 0) s0 = 0;
    if (s0 >= n) s0 = n - 1;
    const frac = f - s0;
    const p0 = s0 * 3;
    const p1 = (s0 + 1) * 3;
    _a.set(
      lerp(p.pts[p0], p.pts[p1], frac),
      lerp(p.pts[p0 + 1], p.pts[p1 + 1], frac),
      lerp(p.pts[p0 + 2], p.pts[p1 + 2], frac),
    );
    _b.set(
      lerp(this.cbin[p0], this.cbin[p1], frac),
      lerp(this.cbin[p0 + 1], this.cbin[p1 + 1], frac),
      lerp(this.cbin[p0 + 2], this.cbin[p1 + 2], frac),
    ).normalize();
    _c.subVectors(position, _a);

    out.t = tt;
    out.station = s0;
    out.lateral = _c.dot(_b);
    out.distanceToLine = _c.length();
    out.distance = lerp(p.cum[s0], p.cum[s0 + 1], frac);
    out.halfWidth = lerp(this.chalf[s0], this.chalf[s0 + 1], frac);
    const lineOffset = lerp(p.offsets[s0], p.offsets[(s0 + 1) % n], frac);
    out.lateralFromCentre = lineOffset + out.lateral;
    return out;
  }

  /**
   * Curvature integral over the next `metres` of line — THE corner detector.
   * `signed` above ~0.6 rad means a sustained corner worth drifting.
   */
  curvatureAhead(
    t: number,
    metres: number,
    out: CurvatureWindow,
    variant: LineVariant = 'optimal',
  ): CurvatureWindow {
    const p = this.path(variant);
    const n = this.stations;
    const d0 = this.distanceAt(t, variant);
    const d1 = d0 + Math.max(0.5, metres);

    out.signed = this.cumLookup(p, p.cumSigned, p.totalSigned, d1) -
      this.cumLookup(p, p.cumSigned, p.totalSigned, d0);
    out.absolute = this.cumLookup(p, p.cumAbs, p.totalAbs, d1) -
      this.cumLookup(p, p.cumAbs, p.totalAbs, d0);

    // Peak curvature + slowest station inside the window.
    const s0 = Math.floor((t - Math.floor(t)) * n);
    const L = p.length || 1;
    let peak = 0;
    let vmin = Infinity;
    let dMin = metres;
    let walked = 0;
    for (let k = 0; k < n && walked < metres; k++) {
      const i = (s0 + k) % n;
      const a = Math.abs(p.curv[i]);
      if (a > peak) peak = a;
      if (p.speed[i] < vmin) {
        vmin = p.speed[i];
        dMin = walked;
      }
      walked += p.ds[i];
      if (walked > L) break;
    }
    out.peak = peak;
    out.minSpeed = vmin === Infinity ? p.maxSpeed : vmin;
    out.distanceToMin = dMin;
    return out;
  }

  /** Interpolate a cumulative array at an arbitrary (possibly >L) distance. */
  private cumLookup(p: LinePath, arr: Float64Array, total: number, distance: number): number {
    const n = this.stations;
    const L = p.length || 1;
    const laps = Math.floor(distance / L);
    let d = distance - laps * L;
    if (d < 0) d += L;
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = p.cum[lo + 1] - p.cum[lo] || 1e-4;
    const u = (d - p.cum[lo]) / seg;
    return laps * total + lerp(arr[lo], arr[lo + 1], u);
  }

  /** Target speed at progress `t` without a full sample. */
  targetSpeedAt(t: number, variant: LineVariant = 'optimal'): number {
    const p = this.path(variant);
    const n = this.stations;
    const tt = t - Math.floor(t);
    const f = tt * n;
    let i0 = Math.floor(f);
    if (i0 < 0) i0 = 0;
    if (i0 >= n) i0 = n - 1;
    return lerp(p.speed[i0], p.speed[i0 + 1], f - i0);
  }

  /** Is this variant available? */
  has(variant: LineVariant): boolean {
    return this.paths.has(variant);
  }

  // -------------------------------------------------------------------------
  //  Debug accessors (used by src/dev/ai.ts)
  // -------------------------------------------------------------------------

  /** Packed XYZ of every station on a line. Do not mutate. */
  debugPoints(variant: LineVariant = 'optimal'): Float64Array {
    return this.path(variant).pts;
  }

  /** Target speed per station. Do not mutate. */
  debugSpeeds(variant: LineVariant = 'optimal'): Float64Array {
    return this.path(variant).speed;
  }

  /** Signed curvature per station. Do not mutate. */
  debugCurvature(variant: LineVariant = 'optimal'): Float64Array {
    return this.path(variant).curv;
  }

  /** Lateral offsets per station, metres. Do not mutate. */
  debugOffsets(variant: LineVariant = 'optimal'): Float64Array {
    return this.path(variant).offsets;
  }

  /** Packed XYZ of the centreline. Do not mutate. */
  debugCentre(): Float64Array {
    return this.cpos;
  }

  /** Centreline binormals (driver's right). Do not mutate. */
  debugBinormals(): Float64Array {
    return this.cbin;
  }

  /** Road half-width per station. Do not mutate. */
  debugHalfWidths(): Float64Array {
    return this.chalf;
  }

  /** Summary numbers for assertions. */
  stats(): {
    stations: number;
    centreLength: number;
    optimalLength: number;
    insideLength: number;
    outsideLength: number;
    minSpeed: number;
    maxSpeed: number;
    meanAbsOffset: number;
    maxAbsOffset: number;
    totalTurning: number;
    finite: boolean;
  } {
    const p = this.path('optimal');
    const n = this.stations;
    let sum = 0;
    let max = 0;
    let finite = true;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(p.offsets[i]);
      sum += a;
      if (a > max) max = a;
      if (!Number.isFinite(p.offsets[i]) || !Number.isFinite(p.speed[i])) finite = false;
    }
    return {
      stations: n,
      centreLength: this.lapLength,
      optimalLength: p.length,
      insideLength: this.paths.has('inside') ? this.path('inside').length : 0,
      outsideLength: this.paths.has('outside') ? this.path('outside').length : 0,
      minSpeed: p.minSpeed,
      maxSpeed: p.maxSpeed,
      meanAbsOffset: sum / n,
      maxAbsOffset: max,
      totalTurning: p.totalAbs,
      finite,
    };
  }
}
