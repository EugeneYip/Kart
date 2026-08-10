/**
 * ============================================================================
 *  Checkpoints — lap validation, anti-skip, the grid and respawns
 * ============================================================================
 *
 *  ~40 invisible planes strung along the lap at equal arc length. A kart's lap
 *  only counts when it has passed enough of them *in order*, which is what
 *  stops someone reversing over the line or cutting the cove jump backwards
 *  from banking a lap.
 *
 *  `updateProgress()` is deliberately *not* called from Track's own update:
 *  Track has no kart roster (see its constructor). Whichever subsystem owns
 *  the roster calls it — and if RaceDirector already runs its own LapTracker,
 *  it simply doesn't, and this class still serves the grid, the respawn table
 *  and `checkpointCount` for anti-skip validation elsewhere.
 * ============================================================================
 */

import * as THREE from 'three';
import { RACE } from '@/core/Config';
import type { KartState } from '@/core/Types';
import { clamp, wrap } from '@/core/MathUtils';
import { makeAttribs, makeSample } from './TrackSpline';
import type { TrackSpline } from './TrackSpline';
import { CROSS, surfaceHeight } from './TrackBuilder';

const _s = makeSample();
const _at = makeAttribs();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _back = new THREE.Vector3();

/** Per-kart lap bookkeeping. */
interface KartProgress {
  /** Index of the last checkpoint legitimately passed. */
  last: number;
  /** Checkpoints collected on the current lap. */
  hit: number;
  /** Bitset of collected checkpoints this lap. */
  seen: Uint8Array;
  lap: number;
  prevT: number;
  /** Set once the kart has left the grid. */
  started: boolean;
}

export interface RespawnPoint {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Arc length of this respawn, metres. */
  distance: number;
}

/** Fraction of the lap's checkpoints needed for a crossing to count. */
const REQUIRED_FRACTION = 0.72;
/** How far ahead a kart may jump before the checkpoint is treated as skipped. */
const MAX_SKIP = 3;

export class Checkpoints {
  readonly count: number;
  readonly lapCount: number;
  /** Arc length of each checkpoint. */
  readonly distances: Float32Array;
  /** Respawn frames, one per checkpoint. */
  readonly respawns: RespawnPoint[] = [];

  private spline: TrackSpline;
  private progress = new Map<number, KartProgress>();
  private required: number;
  private debug: THREE.Mesh | null = null;
  private grid: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion }> = [];

  constructor(spline: TrackSpline, lapCount: number, count = 40) {
    this.spline = spline;
    this.lapCount = Math.max(1, lapCount);
    this.count = Math.max(8, count);
    this.required = Math.floor(this.count * REQUIRED_FRACTION);
    this.distances = new Float32Array(this.count);

    const L = spline.length;
    for (let i = 0; i < this.count; i++) {
      const d = (i / this.count) * L;
      this.distances[i] = d;
      spline.sampleAtDistance(d, _s);
      spline.attribsAtDistance(d, _at);
      const h = surfaceHeight(0, _at.halfWidth, _at.shoulderR, d, false);
      _v.copy(_s.position).addScaledVector(_s.normal, h + 1.35);
      _back.copy(_s.tangent).negate();
      _m.makeBasis(_s.binormal, _s.normal, _back);
      this.respawns.push({
        position: _v.clone(),
        quaternion: new THREE.Quaternion().setFromRotationMatrix(_m),
        distance: d,
      });
    }

    this.buildGrid();
  }

  // =========================================================================
  //  Grid
  // =========================================================================

  /**
   * A staggered two-column grid behind the line. Pole (index 0) sits on the
   * inside of turn one, and the odd column is nudged back by `gridStagger` so
   * nobody starts wheel-to-wheel.
   */
  private buildGrid(): void {
    const L = this.spline.length;
    for (let i = 0; i < 12; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2;
      const behind = 8.5 + row * RACE.gridSpacing * 1.55 + (col === 1 ? RACE.gridStagger : 0);
      const d = wrap(L - behind, L);
      this.spline.sampleAtDistance(d, _s);
      this.spline.attribsAtDistance(d, _at);
      const lat = (col === 0 ? -1 : 1) * Math.min(_at.halfWidth * 0.44, 4.8);
      const h = surfaceHeight(lat, _at.halfWidth, lat < 0 ? _at.shoulderL : _at.shoulderR, d, false);
      _v.copy(_s.position)
        .addScaledVector(_s.binormal, lat)
        .addScaledVector(_s.normal, h + 0.45);
      _back.copy(_s.tangent).negate();
      _m.makeBasis(_s.binormal, _s.normal, _back);
      this.grid.push({
        position: _v.clone(),
        quaternion: new THREE.Quaternion().setFromRotationMatrix(_m),
      });
    }
  }

  getStartPosition(index: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const g = this.grid[clamp(index | 0, 0, this.grid.length - 1)];
    return { position: g.position.clone(), quaternion: g.quaternion.clone() };
  }

  // =========================================================================
  //  Respawn
  // =========================================================================

  /** Nearest respawn at or just behind normalised progress `t`. */
  getRespawn(t: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const f = wrap(t, 1) * this.count;
    // Step back one checkpoint so the driver is dropped before the thing they
    // fell off, not on top of it.
    const i = ((Math.floor(f) - 1 + this.count) % this.count);
    const r = this.respawns[i];
    return { position: r.position.clone(), quaternion: r.quaternion.clone() };
  }

  /** Checkpoint region a normalised progress value falls in. */
  indexAt(t: number): number {
    return Math.floor(wrap(t, 1) * this.count) % this.count;
  }

  // =========================================================================
  //  Progress / validation
  // =========================================================================

  reset(startT = 0): void {
    this.progress.clear();
    void startT;
  }

  private stateFor(k: KartState): KartProgress {
    let p = this.progress.get(k.id);
    if (!p) {
      p = {
        last: this.indexAt(k.progress % 1),
        hit: 1,
        seen: new Uint8Array(this.count),
        lap: k.lap,
        prevT: k.progress % 1,
        started: false,
      };
      p.seen[p.last] = 1;
      this.progress.set(k.id, p);
    }
    return p;
  }

  /**
   * Fold one kart's position into its lap record. Writes `lap` and `progress`
   * on the kart state. Returns true on the frame a lap is completed.
   */
  updateProgress(k: KartState): boolean {
    const s = this.spline.project(k.position, _s);
    const t = s.t;
    const p = this.stateFor(k);
    const idx = this.indexAt(t);

    // --- checkpoint credit, in order only ----------------------------------
    if (idx !== p.last) {
      let fwd = idx - p.last;
      if (fwd < 0) fwd += this.count;
      let back = p.last - idx;
      if (back < 0) back += this.count;
      if (fwd <= MAX_SKIP) {
        // legitimate forward movement: credit everything we passed through
        for (let j = 1; j <= fwd; j++) {
          const c = (p.last + j) % this.count;
          if (!p.seen[c]) { p.seen[c] = 1; p.hit++; }
        }
        p.last = idx;
      } else if (back <= MAX_SKIP) {
        // going backwards is allowed, it just doesn't earn anything
        p.last = idx;
      }
      // anything else is a teleport/skip: ignore until they rejoin in order
    }

    // --- line crossing ------------------------------------------------------
    let lapped = false;
    const crossedForward = p.prevT > 0.72 && t < 0.28;
    const crossedBackward = p.prevT < 0.28 && t > 0.72;
    if (crossedForward) {
      if (!p.started) {
        p.started = true;
        p.lap = Math.max(1, p.lap);
        p.seen.fill(0);
        p.seen[idx] = 1;
        p.hit = 1;
      } else if (p.hit >= this.required) {
        p.lap++;
        lapped = true;
        p.seen.fill(0);
        p.seen[idx] = 1;
        p.hit = 1;
      }
      // else: sector(s) missed, the crossing simply doesn't count
    } else if (crossedBackward && p.lap > 0) {
      p.lap = Math.max(0, p.lap - 1);
      p.seen.fill(0);
      p.hit = this.required; // don't punish twice for one mistake
    }
    p.prevT = t;

    if (!p.started && t < 0.5) {
      // rolled off the grid across the line before the flag
      p.started = true;
      p.lap = Math.max(1, p.lap);
    }

    k.lap = p.lap;
    k.progress = Math.max(0, p.lap) + t;
    return lapped;
  }

  /** Fraction of this lap's checkpoints collected, [0,1]. */
  lapValidity(kartId: number): number {
    const p = this.progress.get(kartId);
    return p ? Math.min(1, p.hit / Math.max(1, this.required)) : 0;
  }

  // =========================================================================
  //  Debug visualisation (used by src/dev/track.ts)
  // =========================================================================

  /** Lazily build translucent gates so the harness can see the checkpoints. */
  debugMesh(): THREE.Mesh {
    if (this.debug) return this.debug;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const H = 6;
    for (let i = 0; i < this.count; i++) {
      const d = this.distances[i];
      this.spline.sampleAtDistance(d, _s);
      this.spline.attribsAtDistance(d, _at);
      const hw = _at.halfWidth + CROSS.kerbW;
      const base = surfaceHeight(0, _at.halfWidth, _at.shoulderR, d, false);
      const b = pos.length / 3;
      for (const side of [-1, 1] as const) {
        for (const up of [0, 1]) {
          _v.copy(_s.position)
            .addScaledVector(_s.binormal, side * hw)
            .addScaledVector(_s.normal, base + up * H);
          pos.push(_v.x, _v.y, _v.z);
          const hot = i === 0 ? 1 : 0;
          col.push(hot, 1 - hot * 0.4, up ? 0.2 : 0.9);
        }
      }
      idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.debug = new THREE.Mesh(g, m);
    this.debug.name = 'checkpointGates';
    this.debug.visible = false;
    this.debug.frustumCulled = false;
    return this.debug;
  }

  dispose(): void {
    if (this.debug) {
      this.debug.geometry.dispose();
      (this.debug.material as THREE.Material).dispose();
      this.debug = null;
    }
    this.progress.clear();
  }
}
