/**
 * ============================================================================
 *  ROAD INTRUSION AUDIT  —  "is any prop standing on the carriageway?"
 * ============================================================================
 *  node src/dev/node-run.mjs .probe-tmp/roadintrude.ts [circuitId|all] [--v]
 *
 *  Independent re-derivation of the owner's "terrain structures visually
 *  interfere with the track" complaint. Two numbers per circuit:
 *
 *    A. REACHES INSIDE  — instances whose oriented bounding box has at least
 *       one corner horizontally inside the drawn asphalt half-width AND
 *       within VERT_BAND metres of that piece of road's surface. The vertical
 *       band is what stops a pylon 40 m under a flyover deck being counted as
 *       "in the road", and it is applied PER BRANCH: at a switchback or a
 *       helix, several pieces of road pass over the same XZ, so the test picks
 *       the branch that is vertically closest rather than the one that is
 *       nearest in plan.
 *
 *    B. SIGHTLINE      — fraction of the road ahead a driver cannot see,
 *       sampled from an eye on the racing line at every station.
 *
 *  Everything is geometry: instance matrices, local AABBs, station frames.
 *  Nothing here reads a pixel (the headless canvas shim returns rgb(0,0,0)
 *  for every texel, so a pixel measurement would be a lie).
 * ============================================================================
 */

import * as THREE from 'three';
import { Track } from '@/track/Track';
import { QUALITY_PRESETS } from '@/core/Config';
import { Environment } from '@/world/Environment';
import { TRACK_IDS, fakeRenderer } from '@/dev/headless';
import type { PathStation, WorldContext } from '@/world/WorldTextures';

// --------------------------------------------------------------------------
//  Tunables
// --------------------------------------------------------------------------

/**
 * Vertical band, relative to the road surface, in which a corner counts as
 * being "in" that road: `[BAND_LO, BAND_HI]`.
 *
 * Asymmetric on purpose. Anything more than 2 m BELOW the tarmac is under a
 * bridge deck or in a cutting and is not in the driver's way — volcano's
 * `lavaFountain` is authored at `lat 0, up -26`, deliberately below the broken
 * bridge, and its glow tops out 5.7 m under the deck. Anything up to 8 m above
 * is in the way, unless it is a corridor prop (below).
 */
const BAND_LO = -2;
const BAND_HI = 8;

/**
 * Props that BELONG over the carriageway: the start gantry arches across it,
 * tunnel portals frame it, deck pylons hold it up. Mirrors `CORRIDOR_PROPS` in
 * Props.ts — kept as a literal here so the probe cannot be silently widened by
 * an edit to the file it is auditing.
 */
const CORRIDOR = new Set([
  'startgantry', 'balloonarch', 'arch', 'tunnelportal', 'hoload',
  'bridgepylon', 'spiralpylon', 'monorailpylon', 'agpylon', 'energypylon',
  'bridgearch', 'overpassarch',
]);

/** `Prop:authored:startgantry:clothSign` -> `startgantry`. */
function baseType(meshName: string): string {
  const parts = meshName.replace(/^Prop:/, '').split(':');
  return (parts[0] === 'authored' ? parts[1] ?? '' : parts[0]).toLowerCase();
}
/** Eye height above the road surface, metres (kart driver's eye). */
const EYE_UP = 1.25;
/** Road-ahead samples per station. */
const AHEAD_N = 30;
/** Distance of the furthest road-ahead sample, metres. */
const AHEAD_MAX = 170;
/** Nearest road-ahead sample, metres. */
const AHEAD_MIN = 12;
/** A station is "blocked" at or above this hidden fraction. */
const BLOCK_FRAC = 0.4;

// --------------------------------------------------------------------------
//  Types
// --------------------------------------------------------------------------

interface Inst {
  name: string;
  /** instance index within its InstancedMesh */
  idx: number;
  matrix: THREE.Matrix4;
  inverse: THREE.Matrix4;
  local: THREE.Box3;
  /** world-space centre + radius, for broad-phase rejection */
  cx: number; cy: number; cz: number; radius: number;
  /** belongs over the carriageway (gantry, portal, deck pylon) */
  corridor: boolean;
}

interface Hit {
  /** metres the worst corner reaches inboard of the asphalt edge */
  inside: number;
  /** signed height of that corner above the road surface */
  rise: number;
  /** arc length of the road branch it intrudes on */
  arc: number;
  halfWidth: number;
  /** road roll at that branch, degrees */
  rollDeg: number;
  /** world XZ of the worst corner */
  wx: number; wz: number;
  /** instance origin, and what the generators would have seen there */
  ox: number; oz: number;
  originLat: number;
  originHalfWidth: number;
  /** `TerrainField.roadDistanceAt` at the origin — what annulus/roadside test */
  fieldDist: number;
  /** distance to the nearest AUTHORED placement of any type, metres */
  authoredGap: number;
  authoredType: string;
}

// --------------------------------------------------------------------------
//  Road queries
// --------------------------------------------------------------------------

/**
 * Nearest piece of road to a world point, restricted to branches whose surface
 * sits in `[y - BAND_HI, y - BAND_LO]`. Returns null when no branch qualifies.
 *
 * Scans every chord rather than trusting a single nearest-station lookup: the
 * volcano helix and the caldera switchback both stack two carriageways over one
 * patch of ground, and a plan-only "nearest" answers for the wrong one.
 *
 * ---- THE TWO FRAMES, AND WHY THIS ONE IS THE ROAD'S -----------------------
 * `PathStation.halfWidth` is the half-width of the asphalt measured **in the
 * road's own plane**: `Track.getDecorationHints()` resolves a prop's `lat` with
 * `position + binormal * lat` on the full 3-D BANKED binormal and then compares
 * that same `lat` against `halfWidth + kerbW + shoulder`. But
 * `PathStation.bx/bz` is that binormal *flattened and renormalised into XZ*, so
 * anything that measures `Math.hypot(x - cx, z - cz)` and compares it with
 * `halfWidth` — `roadVerge()` in WorldTextures, `roadClearance()` in Props — is
 * comparing a HORIZONTAL distance against a ROAD-PLANE width.
 *
 * The two agree only on the flat. Volcano's caldera chute is rolled 34 deg,
 * where an 11.0 m half-width road is 11.0*cos(34) = 9.1 m wide in plan and its
 * edge stands 6.2 m above the centreline: the plan-frame test claims 1.9 m of
 * road that is not there, and volcano's five authored `warningPost`s at
 * `lat -12.5` are reported 0.9 m "inside" a road they in fact clear by 1.5 m.
 *
 * So this works in the road's plane, from the same two numbers the road mesh
 * does: horizontal half-extent `halfWidth * cos(roll)`, and a surface that
 * rises `tanBank` per metre of horizontal lateral offset.
 */
function nearestRoad(
  st: readonly PathStation[], x: number, y: number, z: number,
): { lat: number; inside: number; halfWidth: number; roadY: number; arc: number; tanBank: number } | null {
  const n = st.length;
  let bestLat = Infinity;
  let out: {
    lat: number; inside: number; halfWidth: number; roadY: number; arc: number; tanBank: number;
  } | null = null;
  for (let i = 0; i < n; i++) {
    const a = st[i], b = st[(i + 1) % n];
    const ex = b.px - a.px, ez = b.pz - a.pz;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-6) continue;
    let t = ((x - a.px) * ex + (z - a.pz) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.px + ex * t, pz = a.pz + ez * t;
    const lat = Math.hypot(x - px, z - pz);
    if (lat >= bestLat) continue;
    // Signed horizontal offset: MAGNITUDE from the perpendicular distance to the
    // chord, SIGN from the station's (flattened) binormal, so the cross-fall is
    // applied on the correct side.
    //
    // Using the raw binormal projection for the magnitude is wrong and was
    // measured to be wrong: where the projection clamps to a chord END the offset
    // vector is mostly ALONG the road, the binormal dot product collapses toward
    // zero, and a catch-fence 134 m off the circuit was reported 10.9 m inside an
    // 11.5 m road. For an interior projection the two agree by construction (the
    // offset is perpendicular to the chord, and so is the binormal).
    let bx = a.bx + (b.bx - a.bx) * t, bz = a.bz + (b.bz - a.bz) * t;
    const bl = Math.hypot(bx, bz);
    if (bl > 1e-6) { bx /= bl; bz /= bl; }
    const h = ((x - px) * bx + (z - pz) * bz >= 0 ? lat : -lat);
    const tanBank = a.tanBank + (b.tanBank - a.tanBank) * t;
    const roadY = a.py + (b.py - a.py) * t + h * tanBank;
    const rise = y - roadY;
    if (rise < BAND_LO || rise > BAND_HI) continue;
    bestLat = lat;
    const ds = b.s - a.s;
    const halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * t;
    out = {
      lat,
      // Road-plane test: the asphalt only covers halfWidth*cos(roll) in plan.
      inside: halfWidth / Math.sqrt(1 + tanBank * tanBank) - Math.abs(h),
      halfWidth,
      roadY,
      arc: a.s + (ds > 0 ? ds : 0) * t,
      tanBank,
    };
  }
  return out;
}

/** Road surface point + half width at an arc length (used by the sightline pass). */
function stationAt(st: readonly PathStation[], i: number): PathStation {
  return st[((i % st.length) + st.length) % st.length];
}

// --------------------------------------------------------------------------
//  Instance collection
// --------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _sph = new THREE.Vector3();

function collect(root: THREE.Object3D): Inst[] {
  const out: Inst[] = [];
  root.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh) return;
    const geo = im.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return;
    const r0 = Math.max(
      Math.hypot(bb.max.x, bb.max.y, bb.max.z),
      Math.hypot(bb.min.x, bb.min.y, bb.min.z),
    );
    const corridor = CORRIDOR.has(baseType(im.name));
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, _m);
      const e = _m.elements;
      // Uniform-ish scale: props are composed with setScalar.
      const sx = Math.hypot(e[0], e[1], e[2]);
      const sy = Math.hypot(e[4], e[5], e[6]);
      const sz = Math.hypot(e[8], e[9], e[10]);
      const s = Math.max(sx, sy, sz);
      const c = bb.getCenter(_sph).applyMatrix4(_m);
      out.push({
        name: im.name,
        idx: i,
        matrix: _m.clone(),
        inverse: _m.clone().invert(),
        local: bb,
        cx: c.x, cy: c.y, cz: c.z,
        radius: r0 * s + 0.01,
        corridor,
      });
    }
  });
  return out;
}

// --------------------------------------------------------------------------
//  A. Reaches-inside
// --------------------------------------------------------------------------

const _c = new THREE.Vector3();
const _org = new THREE.Vector3();

interface Authored { type: string; x: number; z: number }

function reachesInside(
  st: readonly PathStation[], inst: Inst,
  fieldDistAt: (x: number, z: number) => number, authored: readonly Authored[],
): Hit | null {
  const bb = inst.local;
  let best: Hit | null = null;
  for (let k = 0; k < 8; k++) {
    _c.set(
      k & 1 ? bb.max.x : bb.min.x,
      k & 2 ? bb.max.y : bb.min.y,
      k & 4 ? bb.max.z : bb.min.z,
    ).applyMatrix4(inst.matrix);
    const r = nearestRoad(st, _c.x, _c.y, _c.z);
    if (!r) continue;
    const inside = r.inside;
    if (best === null || inside > best.inside) {
      best = {
        inside,
        rise: _c.y - r.roadY,
        arc: r.arc,
        halfWidth: r.halfWidth,
        rollDeg: (Math.atan(r.tanBank) * 180) / Math.PI,
        wx: _c.x, wz: _c.z,
        ox: 0, oz: 0, originLat: 0, originHalfWidth: 0, fieldDist: 0,
        authoredGap: Infinity, authoredType: '-',
      };
    }
  }
  if (best) {
    _org.setFromMatrixPosition(inst.matrix);
    best.ox = _org.x; best.oz = _org.z;
    const ro = nearestRoad(st, _org.x, _org.y, _org.z);
    best.originLat = ro ? ro.lat : -1;
    best.originHalfWidth = ro ? ro.halfWidth : -1;
    best.fieldDist = fieldDistAt(_org.x, _org.z);
    for (const p of authored) {
      const d = Math.hypot(p.x - _org.x, p.z - _org.z);
      if (d < best.authoredGap) { best.authoredGap = d; best.authoredType = p.type; }
    }
  }
  return best;
}

// --------------------------------------------------------------------------
//  B. Sightline
// --------------------------------------------------------------------------

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Slab test of a segment against an instance's local AABB. */
function segmentHitsBox(inst: Inst, ox: number, oy: number, oz: number,
  tx: number, ty: number, tz: number): boolean {
  // Broad phase: distance from the segment to the instance's bounding sphere.
  const dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-9) return false;
  let u = ((inst.cx - ox) * dx + (inst.cy - oy) * dy + (inst.cz - oz) * dz) / len2;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const px = ox + dx * u, py = oy + dy * u, pz = oz + dz * u;
  const gap = Math.hypot(inst.cx - px, inst.cy - py, inst.cz - pz);
  if (gap > inst.radius) return false;

  _o.set(ox, oy, oz).applyMatrix4(inst.inverse);
  _d.set(tx, ty, tz).applyMatrix4(inst.inverse).sub(_o);
  const bb = inst.local;
  let t0 = 0, t1 = 1;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? _o.x : a === 1 ? _o.y : _o.z;
    const d = a === 0 ? _d.x : a === 1 ? _d.y : _d.z;
    const lo = a === 0 ? bb.min.x : a === 1 ? bb.min.y : bb.min.z;
    const hi = a === 0 ? bb.max.x : a === 1 ? bb.max.y : bb.max.z;
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
      continue;
    }
    let n = (lo - o) / d, f = (hi - o) / d;
    if (n > f) { const s = n; n = f; f = s; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t0 > t1) return false;
  }
  return true;
}

// --------------------------------------------------------------------------
//  Report
// --------------------------------------------------------------------------

interface Summary {
  id: string;
  stations: number;
  props: number;
  insideProps: number;
  insideInstances: number;
  worstInside: number;
  worstLine: string;
  blocked: number;
  worstHidden: number;
  worstHiddenLine: string;
  lines: string[];
}

async function audit(track: Track, env: Environment, id: string, verbose: boolean): Promise<Summary> {
  const ctx = (env as unknown as { ctx: WorldContext | null }).ctx;
  if (!ctx) throw new Error('environment has no context');
  const st = ctx.stations;
  const root = env.props?.group;
  if (!root) throw new Error('no props group');
  const all = collect(root);
  // Corridor props are meant to be over the carriageway; they are neither an
  // intrusion nor an occlusion defect. Everything else is fair game.
  const insts = all.filter((i) => !i.corridor);

  // ---- A ------------------------------------------------------------------
  const field = ctx.field as unknown as { roadDistanceAt(x: number, z: number): number };
  const fieldDistAt = (x: number, z: number): number => field.roadDistanceAt(x, z);
  const authored: Authored[] = (ctx.hints.props ?? []).map((p) => ({
    type: p.type, x: p.position.x, z: p.position.z,
  }));
  const byType = new Map<string, Hit[]>();
  /** How close every prop gets to the asphalt edge — used to choose the slack. */
  const bands = [0, 0.25, 0.5, 1, 2];
  const nearCount = new Array<number>(bands.length).fill(0);
  const nearNames: string[][] = bands.map(() => []);
  for (const inst of insts) {
    const h = reachesInside(st, inst, fieldDistAt, authored);
    if (!h) continue;
    for (let bi = 0; bi < bands.length; bi++) {
      // `inside > -band` == the box reaches to within `band` metres of the edge.
      if (h.inside > -bands[bi]) {
        nearCount[bi]++;
        if (nearNames[bi].length < 8 && !nearNames[bi].includes(inst.name)) {
          nearNames[bi].push(inst.name);
        }
      }
    }
    if (h.inside <= 0) continue;
    let l = byType.get(inst.name);
    if (!l) { l = []; byType.set(inst.name, l); }
    l.push(h);
  }
  let worstInside = 0, worstLine = '—', insideInstances = 0;
  const lines: string[] = [];
  const total = st.length ? st[st.length - 1].s + (st[1] ? st[1].s - st[0].s : 7) : 1;
  for (const [name, hits] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    hits.sort((a, b) => b.inside - a.inside);
    insideInstances += hits.length;
    const w = hits[0];
    const line = `  ${name.padEnd(26)} ${String(hits.length).padStart(3)} inst`
      + `  worst reach ${w.inside.toFixed(1)} m inside`
      + `  at d=${w.arc.toFixed(0)} m (t=${(w.arc / total).toFixed(3)})`
      + `  halfW ${w.halfWidth.toFixed(1)}  roll ${w.rollDeg.toFixed(0)} deg`
      + `  rise ${w.rise.toFixed(1)} m`;
    lines.push(line);
    if (verbose) {
      for (const h of hits.slice(0, 6)) {
        lines.push(`      d=${h.arc.toFixed(0)} t=${(h.arc / total).toFixed(3)}`
          + ` inside ${h.inside.toFixed(2)} rise ${h.rise.toFixed(1)}`
          + ` halfW ${h.halfWidth.toFixed(1)} roll ${h.rollDeg.toFixed(0)}`
          + ` corner=(${h.wx.toFixed(1)}, ${h.wz.toFixed(1)})`);
        lines.push(`         origin=(${h.ox.toFixed(1)}, ${h.oz.toFixed(1)})`
          + ` originLat ${h.originLat.toFixed(1)} vs halfW ${h.originHalfWidth.toFixed(1)}`
          + ` | field.roadDistanceAt ${h.fieldDist.toFixed(1)}`
          + ` | nearest authored '${h.authoredType}' at ${h.authoredGap.toFixed(2)} m`
          + `${h.authoredGap < 0.05 ? '  == THIS IS AN AUTHORED ANCHOR' : ''}`);
      }
    }
    if (w.inside > worstInside) { worstInside = w.inside; worstLine = `${name} ${w.inside.toFixed(1)} m`; }
  }
  lines.push(`  edge proximity (instances whose box reaches within N m of the asphalt edge):`);
  for (let bi = 0; bi < bands.length; bi++) {
    lines.push(`      within ${bands[bi].toFixed(2)} m: ${String(nearCount[bi]).padStart(3)}`
      + `   ${nearNames[bi].join(' ')}`);
  }

  // ---- B ------------------------------------------------------------------
  let blocked = 0, worstHidden = 0, worstHiddenLine = '—';
  const n = st.length;
  if (process.argv.includes('--noB')) {
    return {
      id, stations: n, props: all.length,
      insideProps: byType.size, insideInstances, worstInside, worstLine,
      blocked: -1, worstHidden: 0, worstHiddenLine: 'skipped', lines,
    };
  }
  const perStation = Math.max(1, total / n);
  const aheadStep = Math.max(1, Math.round(AHEAD_MIN / perStation));
  for (let i = 0; i < n; i++) {
    const s = st[i];
    const ox = s.px, oy = s.py + EYE_UP, oz = s.pz;
    let hidden = 0;
    for (let k = 0; k < AHEAD_N; k++) {
      const dist = AHEAD_MIN + ((AHEAD_MAX - AHEAD_MIN) * k) / (AHEAD_N - 1);
      const j = i + aheadStep + Math.round((dist - AHEAD_MIN) / perStation);
      const t = stationAt(st, j);
      // Aim at the road surface a little above the tarmac, mid-lane.
      const lane = ((k % 3) - 1) * 0.55 * t.halfWidth;
      const tx = t.px + t.bx * lane, tz = t.pz + t.bz * lane;
      const ty = t.py + 0.35;
      for (const inst of insts) {
        if (segmentHitsBox(inst, ox, oy, oz, tx, ty, tz)) { hidden++; break; }
      }
    }
    const frac = hidden / AHEAD_N;
    if (frac >= BLOCK_FRAC) blocked++;
    if (frac > worstHidden) {
      worstHidden = frac;
      worstHiddenLine = `t=${(s.s / total).toFixed(3)} d=${s.s.toFixed(0)} m  ${hidden}/${AHEAD_N} hidden`;
    }
  }

  return {
    id, stations: n, props: all.length,
    insideProps: byType.size, insideInstances, worstInside, worstLine,
    blocked, worstHidden, worstHiddenLine, lines,
  };
}

// --------------------------------------------------------------------------

const arg = process.argv[3] ?? 'all';
const verbose = process.argv.includes('--v');
const ids = arg === 'all' ? [...TRACK_IDS] : [arg];

const scene = new THREE.Scene();
const renderer = fakeRenderer();
const track = new Track(scene, renderer, QUALITY_PRESETS.low);
const env = new Environment(scene, renderer, track, QUALITY_PRESETS.low);

const rows: Summary[] = [];
for (const id of ids) {
  await track.loadTrack(id);
  env.dispose();
  await env.init();
  rows.push(await audit(track, env, id, verbose));
}

console.log('');
console.log('=== ROAD INTRUSION AUDIT ==========================================');
console.log(`    rise band [${BAND_LO}, ${BAND_HI}] m | sightline ${AHEAD_N} samples`
  + ` ${AHEAD_MIN}-${AHEAD_MAX} m | blocked at >=${(BLOCK_FRAC * 100) | 0}%`
  + ' | corridor props excluded');
for (const r of rows) {
  console.log('');
  console.log(`${r.id}   (${r.stations} stations, ${r.props} prop instances)`);
  console.log(`  A. prop types reaching INSIDE the drivable road: ${r.insideProps}`
    + `   instances: ${r.insideInstances}   worst: ${r.worstLine}`);
  for (const l of r.lines) console.log(l);
  console.log(`  B. stations with >=${(BLOCK_FRAC * 100) | 0}% of the road ahead hidden:`
    + ` ${r.blocked}/${r.stations} (${((r.blocked / r.stations) * 100).toFixed(1)}%)`
    + `   worst ${(r.worstHidden * 100).toFixed(0)}%  ${r.worstHiddenLine}`);
}
console.log('');
console.log('SUMMARY  circuit            insideTypes  insideInst  worst(m)  blocked');
for (const r of rows) {
  console.log(`         ${r.id.padEnd(18)} ${String(r.insideProps).padStart(11)}`
    + ` ${String(r.insideInstances).padStart(11)} ${r.worstInside.toFixed(1).padStart(9)}`
    + ` ${String(r.blocked).padStart(8)}`);
}
console.log('===================================================================');
