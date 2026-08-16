/**
 * ============================================================================
 *  THE DRAWN RIBBON — shared ground truth for the driving-envelope audit
 * ============================================================================
 *  Lifted verbatim out of `.probe-tmp/propfoot.ts` so that the certification
 *  probe and the enumeration probe (`.probe-tmp/envelope.ts`) grade against
 *  ONE implementation. Two copies of a ground truth is two ground truths, and
 *  the second one drifts silently.
 *
 *  The rationale for the approach lives in `propfoot.ts`'s header and is not
 *  repeated here. In one line: `roadSurface` / `roadKerbs` / `roadShoulder_*` /
 *  `trackDeck` triangles, XZ-bucketed, queried with a vertical line; the deck a
 *  point stands on is the nearest crossing BELOW it. No centreline, so a banked
 *  binormal cannot put a tower 52 m away on the racing line and a flyover
 *  cannot be graded against the carriageway underneath it.
 * ============================================================================
 */
import * as THREE from 'three';
import type { Track } from '@/track/Track';

/** Triangle tags. The asphalt is its own mesh, which IS the lateral test. */
export const K_ROAD = 1, K_KERB = 2, K_SHOULDER = 3, K_DECK = 4;
export const KIND_NAME: Record<number, string> = { 1: 'asphalt', 2: 'kerb', 3: 'shoulder', 4: 'deck' };

/** A vertex this far above the drawn surface counts as standing on the road. */
export const ABOVE_TOL = 0.05;

export class Soup {
  private tri: Float64Array;
  private kind: Uint8Array;
  private n = 0;
  private cell = 6;
  private grid = new Map<number, number[]>();
  /** Output of the last `hits()` — heights and their tags, unsorted. */
  readonly hy: number[] = [];
  readonly hk: number[] = [];
  /** Set if `add` ran out of room; a silently truncated index is a lie. */
  overflowed = false;

  constructor(cap: number) { this.tri = new Float64Array(cap * 9); this.kind = new Uint8Array(cap); }

  get count(): number { return this.n; }

  add(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, k: number): void {
    const i = this.n * 9;
    if (i + 9 > this.tri.length) { this.overflowed = true; return; }
    this.tri[i] = a.x; this.tri[i + 1] = a.y; this.tri[i + 2] = a.z;
    this.tri[i + 3] = b.x; this.tri[i + 4] = b.y; this.tri[i + 5] = b.z;
    this.tri[i + 6] = c.x; this.tri[i + 7] = c.y; this.tri[i + 8] = c.z;
    this.kind[this.n] = k;
    const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x);
    const z0 = Math.min(a.z, b.z, c.z), z1 = Math.max(a.z, b.z, c.z);
    for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++) {
      for (let gz = Math.floor(z0 / this.cell); gz <= Math.floor(z1 / this.cell); gz++) {
        const key = gx * 73856093 ^ gz * 19349663;
        let l = this.grid.get(key);
        if (!l) { l = []; this.grid.set(key, l); }
        l.push(this.n);
      }
    }
    this.n++;
  }

  /** Is ANY ribbon triangle bucketed inside this XZ box? Instance-level cull. */
  anyNear(x0: number, x1: number, z0: number, z1: number): boolean {
    for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++) {
      for (let gz = Math.floor(z0 / this.cell); gz <= Math.floor(z1 / this.cell); gz++) {
        if (this.grid.has(gx * 73856093 ^ gz * 19349663)) return true;
      }
    }
    return false;
  }

  /** Every y at which a vertical line through (x, z) crosses the ribbon. */
  hits(x: number, z: number): number {
    this.hy.length = 0; this.hk.length = 0;
    const list = this.grid.get(Math.floor(x / this.cell) * 73856093 ^ Math.floor(z / this.cell) * 19349663);
    if (!list) return 0;
    for (const t of list) {
      const i = t * 9;
      const ax = this.tri[i], ay = this.tri[i + 1], az = this.tri[i + 2];
      const bx = this.tri[i + 3], by = this.tri[i + 4], bz = this.tri[i + 5];
      const cx = this.tri[i + 6], cy = this.tri[i + 7], cz = this.tri[i + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;   // edge-on to the vertical line
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      this.hy.push(u * ay + v * by + w * cy);
      this.hk.push(this.kind[t]);
    }
    return this.hy.length;
  }

  /**
   * Brute force, no grid and no barycentric test: the nearest DRAWN ASPHALT
   * VERTEX to (x, z) in plan. This is the instrument that proved neon's
   * `skyscraperWindows` finding an artefact (52.2 m from the nearest asphalt
   * while the centreline ground truth called it 9.93 m inside), and it is kept
   * here as an independent cross-check on the bucketed query above: two
   * implementations that share no code have to agree before a number is used.
   */
  nearestAsphaltInPlan(x: number, z: number): { dist: number; y: number } {
    let best = Infinity, bestY = 0;
    for (let t = 0; t < this.n; t++) {
      if (this.kind[t] !== K_ROAD) continue;
      const i = t * 9;
      for (let c = 0; c < 3; c++) {
        const dx = this.tri[i + c * 3] - x, dz = this.tri[i + c * 3 + 2] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; bestY = this.tri[i + c * 3 + 1]; }
      }
    }
    return { dist: Math.sqrt(best), y: bestY };
  }
}

/**
 * @param breakSoup  sabotage arm: mistag the asphalt as shoulder, so every
 *                   lateral verdict must collapse and the red checks go red.
 */
export function ribbonSoup(track: Track, breakSoup = false): Soup {
  // Walls, the tunnel lining and decals are excluded: a barrier top or a bore
  // ceiling is not a surface anything is seated on.
  const tagOf = (name: string): number => {
    if (name === 'roadSurface') return breakSoup ? K_SHOULDER : K_ROAD;
    if (name === 'roadKerbs') return K_KERB;
    if (name.startsWith('roadShoulder_')) return K_SHOULDER;
    if (name === 'trackDeck') return K_DECK;
    return 0;
  };
  const s = new Soup(400000);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  track.roadGroup.updateMatrixWorld(true);
  track.roadGroup.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const k = tagOf(mesh.name);
    if (k === 0) return;
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      s.add(a, b, c, k);
    }
  });
  return s;
}

/** What the ribbon says about one world-space point. */
export enum Verdict {
  /** No ribbon crossing at all under this XZ — nothing to judge against. */
  NoRibbon = 0,
  /** Every crossing is above the point: it is under the road, or off it. */
  UnderAll = 1,
  /** On a deck, but outside the driving band (buried, or scenery overhead). */
  Clear = 2,
  /** In the band over the asphalt. THE finding. */
  OnRoad = 3,
  /** In the band, but over kerb / shoulder / deck fascia, not the tarmac. */
  Beside = 4,
}

export interface Seat { verdict: Verdict; deckY: number; above: number; kind: number; decks: number; }
const _seat: Seat = { verdict: Verdict.NoRibbon, deckY: 0, above: 0, kind: 0, decks: 0 };

/**
 * Seat a point on the ribbon: pick the NEAREST CROSSING BELOW it and judge
 * against that deck alone. This is the whole multi-level fix in six lines.
 */
export function seat(soup: Soup, x: number, y: number, z: number, driveHeight: number): Seat {
  const n = soup.hits(x, z);
  _seat.decks = n;
  if (n === 0) { _seat.verdict = Verdict.NoRibbon; return _seat; }
  let best = -Infinity, bestK = 0;
  for (let i = 0; i < n; i++) {
    const hy = soup.hy[i];
    if (hy > y) continue;
    // On a tie (the asphalt/kerb seam) the asphalt wins: conservative.
    if (hy > best || (hy > best - 1e-4 && soup.hk[i] === K_ROAD)) { best = hy; bestK = soup.hk[i]; }
  }
  if (best === -Infinity) { _seat.verdict = Verdict.UnderAll; return _seat; }
  _seat.deckY = best; _seat.kind = bestK; _seat.above = y - best;
  if (_seat.above <= ABOVE_TOL || _seat.above >= driveHeight) _seat.verdict = Verdict.Clear;
  else _seat.verdict = bestK === K_ROAD ? Verdict.OnRoad : Verdict.Beside;
  return _seat;
}

/**
 * Is (x, z) over the drawn asphalt of the deck at height `deckY`?
 *
 * Used by `depthInsideAsphalt` below. Deck-scoped so a flyover's carriageway
 * cannot answer for the one underneath it.
 */
export function overAsphaltAt(soup: Soup, x: number, z: number, deckY: number, slack = 2.0): boolean {
  const n = soup.hits(x, z);
  for (let i = 0; i < n; i++) {
    if (soup.hk[i] === K_ROAD && Math.abs(soup.hy[i] - deckY) < slack) return true;
  }
  return false;
}

/**
 * HOW FAR INSIDE THE DRAWN ASPHALT a point stands, in PLAN, measured from the
 * mesh and nothing else.
 *
 * `propfoot.ts` reports this as `halfWidth - |lat|` from a centreline
 * projection, and that number goes NEGATIVE on volcano's portals — it claims a
 * vertex is outside the drivable width while the ribbon says it is standing on
 * the asphalt. Both cannot be true. The centreline version is the one that is
 * wrong: it samples every 2 m and filters candidates by `|along| < 2`, so on a
 * station where the half-width is changing it reports a NEIGHBOUR's half-width.
 *
 * This measures the thing itself. March out from (x, z) in `dirs` directions
 * and bisect for the radius at which the deck's asphalt ends; the answer is the
 * smallest such radius over all directions, i.e. the distance to the nearest
 * edge of the drawn carriageway. No centreline, no binormal, no half-width.
 *
 * @param maxR  give up past this radius (a point in the middle of a 24 m road
 *              is ~12 m from the edge; 30 m is comfortably past any of them).
 */
export function depthInsideAsphalt(
  soup: Soup, x: number, z: number, deckY: number, dirs = 64, maxR = 30, bisect = 14,
): number {
  if (!overAsphaltAt(soup, x, z, deckY)) return -1;
  let worst = maxR;
  for (let k = 0; k < dirs; k++) {
    const a = (k / dirs) * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    // Coarse march first — the asphalt is convex in plan only locally, so step
    // out in 0.25 m increments until it stops being asphalt, then bisect.
    let lo = 0, hi = -1;
    for (let r = 0.25; r <= worst; r += 0.25) {
      if (!overAsphaltAt(soup, x + dx * r, z + dz * r, deckY)) { hi = r; lo = r - 0.25; break; }
    }
    if (hi < 0) continue;                       // still asphalt at `worst`
    for (let b = 0; b < bisect; b++) {
      const mid = (lo + hi) * 0.5;
      if (overAsphaltAt(soup, x + dx * mid, z + dz * mid, deckY)) lo = mid; else hi = mid;
    }
    if (lo < worst) worst = lo;
  }
  return worst;
}
