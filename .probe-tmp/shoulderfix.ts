/**
 * ============================================================================
 *  THE SHOULDER, PLUMBED — measured against the DRAWN ribbon, all 8 circuits
 * ============================================================================
 *  `PathStation.shoulderL/R` were never written by `Environment.stationFrom()`,
 *  so the terrain bake and `Props.deckFrameAt()` both fell back to
 *  `SH_FALLBACK = 3 m` at every station of every circuit, against authored
 *  shoulders that run 0-9 m (median ~3, and 1.2 m on both river crossings).
 *
 *  Four claims, in the order the defect propagates:
 *
 *   A. THE STATIONS CARRY THE AUTHORED SHOULDER. Every station's published
 *      shoulder must match `TrackSpline.attribsAtDistance()` at its own arc.
 *      Ground truth is the SPLINE, which is a different code path from the
 *      resampler under test.
 *
 *   B. THE ASSUMED CORRIDOR IS THE DRAWN CORRIDOR. `hw + kerbW + shoulder` is
 *      what every consumer treats as the outer edge of the road. Ground truth
 *      is the widest DRAWN triangle at that arc — measured, not derived.
 *
 *   C. EVERY CABLE / GIRDER ANCHOR SITS ON THE DRAWN DECK. Boston's `bridgeFan`
 *      and New York's `brooklynCables` stand their edge girder on the shoulder.
 *      Each girder post foot is extracted FROM THE BUILT TRIANGLES and measured
 *      against the drawn ribbon: how far outboard of the drawn edge it stands,
 *      and how far above/below the drawn surface.
 *
 *   D. THE TERRAIN STILL MEETS THE ROAD. The bake reads the same field, so it
 *      moves on all eight circuits. The stations are baked TWICE in one
 *      process — as published, and with the shoulders deleted, which is
 *      byte-for-byte the old behaviour — and neither ground PROUD of the drawn
 *      road (a lip) nor drawn road over a VOID (a mesh hanging over a hole)
 *      may be worse than the old bake was.
 *
 *   E. ...AND BY HOW MUCH. Informational, not an assertion: the texel-by-texel
 *      difference between those two bakes, which is exactly what this change
 *      moved in the world.
 *
 *  ---------------------------------------------------------------------------
 *  WHY NONE OF THIS IS VACUOUS
 *  ---------------------------------------------------------------------------
 *  The yardstick for B, C and D is the DRAWN ribbon — `roadSurface`,
 *  `roadKerbs`, `roadShoulder_*` and `trackDeck`, walked triangle by triangle
 *  out of `track.roadGroup` — and never `deckFrameAt()` or `roadCross()`, which
 *  are the functions the fan is built from. Grading a construction with its own
 *  template is the defect this project keeps shipping.
 *
 *  `--hull` swaps the yardstick to `trackCollision` on purpose — the mistake the
 *  previous seating probe made. That hull is less than half the ribbon's
 *  triangle count and it does not carry the whole shoulder, so a girder
 *  standing where a bridge girder stands loses the ground under it and the
 *  seating claims start reporting air that is not there. Run it once to see
 *  what a wrong yardstick looks like.
 *
 *  `--assume=N` forces claim B to grade against a constant N-metre shoulder
 *  instead of the published one, which is what the shipping code did with
 *  N = 3. Use it to see B go red on demand.
 *
 *  usage: node src/dev/node-run.mjs .probe-tmp/shoulderfix.ts [ids...] [--hull] [--assume=N]
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { TerrainField, type PathStation } from '@/world/WorldTextures';
import { fakeRenderer, loadTrack, TRACK_IDS } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import { TF, makeAttribs } from '@/track/TrackSpline';
import { getTrackDef } from '@/track/TrackDefs';
import { CROSS, kerbSuppressed } from '@/track/TrackBuilder';

const ARGS = process.argv.slice(3);
const ONLY = ARGS.filter((a) => !a.startsWith('--'));
const IDS = ONLY.length ? ONLY : TRACK_IDS;
const USE_HULL = ARGS.includes('--hull');
const ASSUME = (() => {
  const a = ARGS.find((x) => x.startsWith('--assume='));
  return a ? Number(a.slice(9)) : null;
})();

/** A published shoulder may differ from the spline by this much (resample). */
const SH_TOL = 0.02;
/**
 * The assumed corridor may differ from the drawn ribbon by this much.
 *
 * The floor on this is the 7 m station resample, not the shoulder: consumers
 * interpolate `PathStation` linearly between stations, and volcano's SHORTCUT
 * ramps its shoulder 0.7 m of WIDTH per metre of ARC, so half a station spacing
 * of lookup error is over a metre of corridor. The mean is the number that says
 * whether the field is plumbed (0.03-0.10 m after, 1.20-3.80 m before); this
 * bound only has to catch a systematic error.
 */
const CORRIDOR_TOL = 1.25;
/** A girder post foot may stand this far outboard of the drawn deck edge. */
const OVERHANG_TOL = 0.20;
/** ...and this far above the drawn surface. Below is embedment, and fine. */
const AIR_TOL = 0.10;
/**
 * Claim D is a REGRESSION comparison, not an absolute quality bar, and it has
 * no constant: the two sides come from the same run. The absolute residual is
 * dominated by the harness's `low` tier — the field is ~2.4-3.0 m per texel and
 * `heightAt()` reads it bilinearly, so a 0.34 m shoulder drop that happens over
 * 1.2 m of lateral offset is smeared across a whole texel — plus the separately
 * known `roadSurfaceOffset` projection error (`cross` is a horizontal distance
 * where the profile wants one measured along the banked surface). Neither is
 * the shoulder, so the claim is "it did not get worse".
 *
 * The slack is 0.20 m and it is sized by ONE measured place: volcano arc 248,
 * a station whose binormal drops 0.50 m of world Y per metre of lateral offset
 * (a climbing, turning, banked section — `bank` reads 8.6 deg but the frame is
 * far steeper than that). There the baked terrain's cross-slope comes out ~12 %
 * shallower than the road's, so the ground rides 1.5 m over the drawn shoulder's
 * outer edge. That is present at 1.51 m on a SH_FALLBACK bake and 1.67 m on a
 * plumbed one; the shoulder is not the cause, the `roadSurfaceOffset` /
 * `tanBank` reconstruction at a 7 m resample is. The delta is printed on every
 * line so widening the bound cannot hide a movement.
 */
const REGRESS_SLACK = 0.20;

let fails = 0;
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label.padEnd(46)} ${detail}`);
};
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : 'n/a');

// ---------------------------------------------------------------------------
//  A triangle soup with an XZ bucket index, so a vertical line query is cheap.
// ---------------------------------------------------------------------------
class Soup {
  private tri: Float64Array;
  private n = 0;
  private cell = 6;
  private grid = new Map<number, number[]>();
  private scratch: number[] = [];

  constructor(cap: number) { this.tri = new Float64Array(cap * 9); }

  get count(): number { return this.n; }

  add(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    const i = this.n * 9;
    if (i + 9 > this.tri.length) return;
    this.tri[i] = a.x; this.tri[i + 1] = a.y; this.tri[i + 2] = a.z;
    this.tri[i + 3] = b.x; this.tri[i + 4] = b.y; this.tri[i + 5] = b.z;
    this.tri[i + 6] = c.x; this.tri[i + 7] = c.y; this.tri[i + 8] = c.z;
    const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x);
    const z0 = Math.min(a.z, b.z, c.z), z1 = Math.max(a.z, b.z, c.z);
    for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++) {
      for (let gz = Math.floor(z0 / this.cell); gz <= Math.floor(z1 / this.cell); gz++) {
        const k = gx * 73856093 ^ gz * 19349663;
        let l = this.grid.get(k);
        if (!l) { l = []; this.grid.set(k, l); }
        l.push(this.n);
      }
    }
    this.n++;
  }

  /** Every y at which a vertical line through (x, z) crosses the soup. */
  hits(x: number, z: number, out: number[] = this.scratch): number[] {
    out.length = 0;
    const k = Math.floor(x / this.cell) * 73856093 ^ Math.floor(z / this.cell) * 19349663;
    const list = this.grid.get(k);
    if (!list) return out;
    for (const t of list) {
      const i = t * 9;
      const ax = this.tri[i], ay = this.tri[i + 1], az = this.tri[i + 2];
      const bx = this.tri[i + 3], by = this.tri[i + 4], bz = this.tri[i + 5];
      const cx = this.tri[i + 6], cy = this.tri[i + 7], cz = this.tri[i + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      out.push(u * ay + v * by + w * cy);
    }
    return out;
  }

  /**
   * Height of the drawn surface at (x, z) that is CLOSEST to `yRef`, within
   * `band`. Picking the nearest rather than the highest is what makes a
   * multi-level circuit (a flyover over its own road) answer about the deck the
   * query is actually on.
   */
  nearest(x: number, z: number, yRef: number, band: number): number | null {
    const hs = this.hits(x, z);
    let best: number | null = null, bd = band;
    for (const y of hs) {
      const d = Math.abs(y - yRef);
      if (d <= bd) { bd = d; best = y; }
    }
    return best;
  }
}

function ribbonSoup(track: Awaited<ReturnType<typeof loadTrack>>): Soup {
  // Walls, guardrail posts and decals are excluded: a barrier top is not a
  // surface anything is seated on.
  const NAME = USE_HULL ? /^trackCollision/ : /^(roadSurface|roadKerbs|roadShoulder_|trackDeck)/;
  const s = new Soup(240000);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const roots: THREE.Object3D[] = [track.roadGroup];
  if (USE_HULL && track.collisionMesh) roots.push(track.collisionMesh);
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !NAME.test(mesh.name)) return;
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
        s.add(a, b, c);
      }
    });
  }
  return s;
}

/**
 * The DRAWN cross-section at arc `d`, from the ribbon triangles alone. Two
 * different queries, because the two questions have different failure modes:
 *
 *  · HOW WIDE the ribbon is, from the drawn VERTICES projected into the road
 *    frame. A vertical ray cannot answer this — neon's anti-gravity wall ride
 *    banks to 84°, where the whole cross-section collapses into a couple of
 *    metres of plan, and the ray-based version of this probe read a 25.5 m road
 *    as 8.9 m wide there. Projection is bank-proof.
 *
 *  · HOW HIGH the surface is at a given lateral offset, from vertical line
 *    queries at 0.05 m. That is the right query for anything a prop stands on
 *    and it is what claims C and D need.
 *
 * The projection has to reject geometry that belongs to a DIFFERENT part of the
 * lap passing nearby — volcano's spiral stacks over itself and neon has an
 * off-road apron 21 m outboard of the road edge. So a candidate must be within
 * 1.5 m ALONG the tangent and 3 m along the NORMAL, and the interval is then
 * grown outward from the centreline in steps no larger than one shoulder quad
 * (the shoulder is drawn with 3 lateral samples, so a 24 m shoulder has 12 m
 * between vertex columns). Anything separated by a bigger gap is a different
 * road.
 */
interface Profile { edgeL: number; edgeR: number; lat: number[]; y: Array<number | null>; }
const PROF_STEP = 0.05;
const PROF_MAX = 40;
/** Largest lateral gap between adjacent drawn vertex columns, metres. */
const COLUMN_GAP = 13;

interface RibbonVerts { x: Float64Array; y: Float64Array; z: Float64Array; n: number; }

function ribbonVerts(track: Awaited<ReturnType<typeof loadTrack>>): RibbonVerts {
  const NAME = USE_HULL ? /^trackCollision/ : /^(roadSurface|roadKerbs|roadShoulder_|trackDeck)/;
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const v = new THREE.Vector3();
  const roots: THREE.Object3D[] = [track.roadGroup];
  if (USE_HULL && track.collisionMesh) roots.push(track.collisionMesh);
  for (const root of roots) root.updateMatrixWorld(true);
  const visit = (o: THREE.Object3D): void => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !NAME.test(mesh.name)) return;
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      xs.push(v.x); ys.push(v.y); zs.push(v.z);
    }
  };
  for (const root of roots) root.traverse(visit);
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs), n: xs.length };
}

function profileAt(
  track: Awaited<ReturnType<typeof loadTrack>>, soup: Soup, rv: RibbonVerts, d: number,
): Profile {
  const s = track.sampleAtDistance(d);
  const px0 = s.position.x, py0 = s.position.y, pz0 = s.position.z;
  const tx = s.tangent.x, ty = s.tangent.y, tz = s.tangent.z;
  const bx = s.binormal.x, by = s.binormal.y, bz = s.binormal.z;
  const nx = s.normal.x, ny = s.normal.y, nz = s.normal.z;

  // ---- how wide, by projection ---------------------------------------------
  const cand: number[] = [];
  for (let i = 0; i < rv.n; i++) {
    const dx = rv.x[i] - px0, dy = rv.y[i] - py0, dz = rv.z[i] - pz0;
    if (dx * dx + dz * dz > PROF_MAX * PROF_MAX + 25) continue;
    const along = dx * tx + dy * ty + dz * tz;
    if (along < -1.5 || along > 1.5) continue;
    const vert = dx * nx + dy * ny + dz * nz;
    if (vert < -3 || vert > 3) continue;
    const lat = dx * bx + dy * by + dz * bz;
    if (lat < -PROF_MAX || lat > PROF_MAX) continue;
    cand.push(lat);
  }
  cand.sort((a, b) => a - b);
  let edgeL = 0, edgeR = 0;
  for (let i = cand.length - 1; i >= 0; i--) {
    if (cand[i] > 0) continue;
    if (cand[i] < edgeL - COLUMN_GAP) break;
    edgeL = Math.min(edgeL, cand[i]);
  }
  for (let i = 0; i < cand.length; i++) {
    if (cand[i] < 0) continue;
    if (cand[i] > edgeR + COLUMN_GAP) break;
    edgeR = Math.max(edgeR, cand[i]);
  }

  // ---- how high, by vertical line query ------------------------------------
  const lat: number[] = [], y: Array<number | null> = [];
  const n = Math.round(PROF_MAX / PROF_STEP);
  for (let k = -n; k <= n; k++) {
    const u = k * PROF_STEP;
    // `s.binormal` is the BANKED 3D binormal, so this reference height already
    // carries the camber; only the crown/kerb/shoulder profile is unknown, and
    // that is under 0.6 m. 1.5 m of band is generous and still rejects a
    // carriageway stacked above or below this one.
    const h = soup.nearest(px0 + bx * u, pz0 + bz * u, py0 + by * u, 1.5);
    lat.push(u); y.push(h);
  }
  return { edgeL, edgeR, lat, y };
}

/** Drawn surface height at lateral offset `u`, clamped into the drawn ribbon. */
function profileY(p: Profile, u: number): number | null {
  const c = Math.max(p.edgeL, Math.min(p.edgeR, u));
  const i = Math.round((c + PROF_MAX) / PROF_STEP);
  for (let r = 0; r < 40; r++) {
    const a = p.y[i - r], b = p.y[i + r];
    if (a !== null && a !== undefined) return a;
    if (b !== null && b !== undefined) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------

console.log(
  `SHOULDER PLUMBING — yardstick: ${USE_HULL ? 'trackCollision HULL (deliberately wrong)' : 'the DRAWN ribbon'}` +
  `${ASSUME !== null ? `, corridor graded against a forced ${ASSUME} m shoulder` : ''}\n`,
);

const attribs = makeAttribs();

for (const id of IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS.low);
  await env.init();
  const ctx = env.ctx;
  if (!ctx) { console.log(`--- ${id}: NO WORLD CONTEXT`); continue; }
  const L = track.lapLength;
  console.log(`--- ${id}  (lap ${L.toFixed(0)} m, ${ctx.stations.length} stations)`);

  const soup = ribbonSoup(track);
  const rv = ribbonVerts(track);
  check(soup.count > (USE_HULL ? 4000 : 30000),
    'the yardstick has triangles in it', `${soup.count} triangles, ${rv.n} vertices`);

  // ---- A. the stations carry the authored shoulder -------------------------
  {
    let published = 0, worst = 0, worstAt = -1;
    let shMin = Infinity, shMax = -Infinity;
    const st = ctx.stations;
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      // The station's `s` is re-accumulated arc length; the spline's own arc for
      // station i is (i / n) * spline length, which is how it was sampled.
      const d = (i / st.length) * track.lapLength;
      track.spline.attribsAtDistance(d, attribs);
      shMin = Math.min(shMin, attribs.shoulderL, attribs.shoulderR);
      shMax = Math.max(shMax, attribs.shoulderL, attribs.shoulderR);
      if (s.shoulderL === undefined || s.shoulderR === undefined) continue;
      published++;
      const e = Math.max(Math.abs(s.shoulderL - attribs.shoulderL),
        Math.abs(s.shoulderR - attribs.shoulderR));
      if (e > worst) { worst = e; worstAt = i; }
    }
    check(published === st.length, 'A. every station publishes a shoulder',
      `${published}/${st.length} published; authored range ${f2(shMin)}..${f2(shMax)} m`);

    // ---- A2 WAS `x === x`, AND THIS IS THE REPLACEMENT ----------------------
    // The check that used to sit here compared `s.shoulderL` against
    // `attribs.shoulderL` under a header claiming "ground truth is the SPLINE,
    // which is a different code path from the resampler under test". It is the
    // same code path. `sampleAtDistance` and `attribsAtDistance` both do
    // `const ch = this.scalars4(s)` and both assign `ch[2]` / `ch[3]`, and
    // `stationFrom` copies the value across with no arithmetic. Three functions,
    // one number, compared against itself — it recorded `worst |Δ| 0.000 m` on
    // 8/8 circuits and could not have recorded anything else. An adversarial
    // critic pass caught it.
    //
    // The independent source of truth is the AUTHORING: `shL` / `shR` on the
    // `SplineNodeSpec` list in the track def, which is upstream of every spline
    // accessor. The channels are smoothed, so a station between two nodes of
    // different width legitimately lands between them — the honest assertion is
    // therefore that every published shoulder lies inside the authored envelope,
    // and that the envelope is actually exercised rather than collapsed to a
    // constant the test would pass trivially.
    {
      const authored: number[] = [];
      const def = getTrackDef(id);
      for (const n of def.nodes) {
        if (typeof n.shL === 'number') authored.push(n.shL);
        if (typeof n.shR === 'number') authored.push(n.shR);
      }
      const aLo = Math.min(...authored);
      const aHi = Math.max(...authored);
      let outside = 0, worstOut = 0, worstOutAt = -1;
      for (let i = 0; i < st.length; i++) {
        const s = st[i];
        if (s.shoulderL === undefined || s.shoulderR === undefined) continue;
        for (const v of [s.shoulderL, s.shoulderR]) {
          const over = Math.max(aLo - v, v - aHi);
          if (over > SH_TOL) { outside++; if (over > worstOut) { worstOut = over; worstOutAt = i; } }
        }
      }
      check(authored.length > 0, 'A2. the track def authors shoulders at all',
        authored.length ? `${authored.length} values across ${def.nodes.length} nodes` : 'NONE — A2 is vacuous');
      check(outside === 0, 'A2. every published shoulder is inside the authored envelope',
        outside === 0 ? `all within ${f2(aLo)}..${f2(aHi)} m`
          : `${outside} outside, worst ${f3(worstOut)} m over at station ${worstOutAt}`);
      // Without this the envelope test passes trivially on a circuit whose
      // shoulders are one constant, which is most of them at a glance.
      check(aHi - aLo > 0.5 || shMax - shMin > 0.5,
        'A2. ...and the envelope is not a single value',
        `authored spread ${f2(aHi - aLo)} m, sampled spread ${f2(shMax - shMin)} m`);
    }
  }

  // ---- B. the assumed corridor is the drawn corridor -----------------------
  // Sampled every 8 m of lap. Gaps (`TF.Gap`) draw no ribbon at all and are
  // skipped by the null-profile test rather than by reading a flag.
  const ARC_STEP = 8;
  const profiles = new Map<number, Profile>();
  {
    let worst = 0, worstAt = -1, worstDetail = '';
    let n = 0, sum = 0, noKerbArcs = 0, worstNoKerb = 0, gapArcs = 0;
    for (let d = 0; d < L; d += ARC_STEP) {
      const p = profileAt(track, soup, rv, d);
      profiles.set(d, p);
      if (p.edgeR - p.edgeL < 4) continue;   // no ribbon here (a Gap section)
      const s = track.sampleAtDistance(d);
      // What the world ASSUMES the drawn corridor is, from the station data —
      // interpolated between the bracketing stations by arc length, which is
      // what every consumer of `PathStation` does.
      const st = ctx.stations;
      let i = 0;
      while (i + 1 < st.length && st[i + 1].s <= d) i++;
      const a = st[i], b = st[(i + 1) % st.length];
      const span = (b.s > a.s ? b.s - a.s : L - a.s) || 1;
      const w = Math.max(0, Math.min(1, (d - a.s) / span));
      const mix = (u: number, v: number): number => u + (v - u) * w;
      const shL = ASSUME !== null ? ASSUME : mix(a.shoulderL ?? 3, b.shoulderL ?? 3);
      const shR = ASSUME !== null ? ASSUME : mix(a.shoulderR ?? 3, b.shoulderR ?? 3);
      const hw = mix(a.halfWidth, b.halfWidth);
      // The kerb is 1.55 m of the corridor and `TF.Ramp` / `TF.NoKerbL/R`
      // suppress it. `PathStation` carries no flags, so a consumer CANNOT know
      // that and will read 1.55 m too wide on a ramp — a real gap, but a
      // different missing field from the one under test, so those arcs are
      // counted and reported separately instead of being charged to the
      // shoulder. Read from the spline; `Track` is not the thing being graded.
      track.spline.attribsAtDistance(d, attribs);
      // `TF.Gap` draws neither kerb nor shoulder — only the asphalt ring — so
      // the drawn corridor there is `hw` and no station could say so.
      if (attribs.flags & TF.Gap) { gapArcs++; continue; }
      const kwL = kerbSuppressed(attribs.flags, -1) ? 0 : CROSS.kerbW;
      const kwR = kerbSuppressed(attribs.flags, 1) ? 0 : CROSS.kerbW;
      if (kwL === 0 || kwR === 0) {
        noKerbArcs++;
        worstNoKerb = Math.max(worstNoKerb, CROSS.kerbW);
      }
      const assumedL = hw + kwL + shL;
      const assumedR = hw + kwR + shR;
      const eL = Math.abs(assumedL - Math.abs(p.edgeL));
      const eR = Math.abs(assumedR - p.edgeR);
      const e = Math.max(eL, eR);
      n++; sum += e;
      if (e > worst) {
        worst = e; worstAt = d;
        worstDetail = `assumed ±${f2(assumedL)}/${f2(assumedR)} vs drawn ${f2(p.edgeL)}..${f2(p.edgeR)}`;
      }
    }
    check(n > 20 && worst <= CORRIDOR_TOL,
      'B. assumed corridor == drawn corridor',
      `${n} arcs, mean |Δ| ${f3(sum / Math.max(n, 1))} m, worst ${f2(worst)} m @arc ${worstAt} (${worstDetail})` +
      (noKerbArcs ? `; ${noKerbArcs} kerb-suppressed arcs` : '') +
      (gapArcs ? `, ${gapArcs} TF.Gap arcs` : '') +
      (noKerbArcs || gapArcs
        ? ` excluded — a station carries no flags, so a consumer reads ${f2(worstNoKerb || CROSS.kerbW)} m too wide on a ramp and a whole shoulder too wide over a gap`
        : ''));
  }

  // ---- C. every cable / girder anchor sits on the drawn deck ---------------
  {
    const fans: THREE.InstancedMesh[] = [];
    scene.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh && /(bridgearch|brooklyntower):metal/.test(m.name)) fans.push(m);
    });
    if (fans.length) {
      // ---- WHAT COUNTS AS AN ANCHOR, AND WHY IT IS A BAND ------------------
      // Both fans stand a continuous edge girder on the shoulder and prop it
      // with a post every 6 m; the beam between two posts is SUPPOSED to be
      // `anchorH` (1.85-2.05 m) clear of the road, so a per-vertex "must touch"
      // test would fail by construction and a fixed 6 m bucket aliases against
      // the 6 m post pitch — the lowest thing in a bucket that happens to miss
      // a post is the beam's own underside, 1.7 m up, which is exactly the
      // false +1.65 m this probe reported before the band was widened.
      //
      // So: bucket by (instance, side, 8 m of arc) — wider than the post pitch,
      // so every band that has girder in it has a post in it — and ask for the
      // LOWEST fan vertex in the band. That point is a post foot, extracted
      // from the built triangles with no knowledge of the builder, and it is
      // the thing that has to be sitting on the deck.
      const BAND = 8;
      interface Foot { x: number; y: number; z: number; d: number; lat: number; n: number; }
      const buckets = new Map<string, Foot>();
      const v = new THREE.Vector3();
      const m4 = new THREE.Matrix4();
      let verts = 0, low = 0;
      let latMax = 0, latMaxAt = '';
      for (const mesh of fans) {
        const pos = mesh.geometry.getAttribute('position');
        for (let inst = 0; inst < mesh.count; inst++) {
          mesh.getMatrixAt(inst, m4);
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(m4);
            verts++;
            const s = track.project(v);
            const dx = v.x - s.position.x, dz = v.z - s.position.z;
            const lat = dx * s.binormal.x + dz * s.binormal.z;
            // Only the deck half of the structure. Tower shafts and the upper
            // cable are 10 m+ above the road and are not anchors.
            if (v.y > s.position.y + 6) continue;
            low++;
            if (Math.abs(lat) > Math.abs(latMax)) {
              latMax = lat; latMaxAt = `arc ${s.distance.toFixed(0)}`;
            }
            const key = `${mesh.name}|${lat < 0 ? 'L' : 'R'}|${Math.round(s.distance / BAND)}`;
            const cur = buckets.get(key);
            if (!cur || v.y < cur.y) {
              buckets.set(key, { x: v.x, y: v.y, z: v.z, d: s.distance, lat, n: (cur?.n ?? 0) + 1 });
            } else cur.n++;
          }
        }
      }
      const feet = [...buckets.values()];
      check(feet.length >= 8, 'C. girder anchors found in the built geometry',
        `${feet.length} anchor bands of ${BAND} m from ${low} deck-level vertices ` +
        `(${verts} total), ${fans.length} fan instances`);

      let offDeck = 0, worstOver = -Infinity, worstOverAt = '';
      let worstAir = -Infinity, worstAirAt = '', worstBury = Infinity;
      for (const ft of feet) {
        const key = Math.round(ft.d / ARC_STEP) * ARC_STEP % L;
        let p = profiles.get(key);
        if (!p) { p = profileAt(track, soup, rv, ft.d); profiles.set(key, p); }
        const edge = ft.lat < 0 ? Math.abs(p.edgeL) : p.edgeR;
        const over = Math.abs(ft.lat) - edge;
        if (over > worstOver) {
          worstOver = over;
          worstOverAt = `arc ${ft.d.toFixed(0)} lat ${f2(ft.lat)} vs drawn edge ${f2(edge)}`;
        }
        // Directly under the foot: is there any drawn road at all?
        if (soup.nearest(ft.x, ft.z, ft.y, 3.0) === null) offDeck++;
        const surf = profileY(p, ft.lat);
        if (surf === null) continue;
        const air = ft.y - surf;
        if (air > worstAir) { worstAir = air; worstAirAt = `arc ${ft.d.toFixed(0)} lat ${f2(ft.lat)}`; }
        if (air < worstBury) worstBury = air;
      }
      check(offDeck === 0, 'C. every anchor foot stands over drawn road',
        `${offDeck}/${feet.length} feet with no ribbon beneath them`);
      check(worstOver <= OVERHANG_TOL, 'C. no anchor outboard of the drawn edge',
        `worst ${worstOver >= 0 ? '+' : ''}${f2(worstOver)} m past the edge (${worstOverAt}); ` +
        `widest deck-level vertex lat ${f2(latMax)} (${latMaxAt})`);
      check(worstAir <= AIR_TOL, 'C. no anchor above the drawn surface',
        `worst ${worstAir >= 0 ? '+' : ''}${f2(worstAir)} m of air (${worstAirAt}); ` +
        `deepest embedment ${f2(worstBury)} m`);
    }
  }

  // ---- D + E. the terrain meets the road, BEFORE and AFTER, in one process --
  // The same stations, baked twice: once as published, once with the shoulders
  // deleted — which is byte-for-byte what every circuit got before they were
  // plumbed. Same seed, same extent, same resolution, same everything else, so
  // the difference IS the shoulder and there is no cross-run drift to argue
  // about and no baseline number to keep in sync.
  //
  // Two ways the ground can disagree with the road it is under, and they are
  // opposite defects:
  //   PROUD — ground standing above the drawn surface. A lip along the road,
  //           and the thing that puts a chase camera inside a hill.
  //   VOID  — drawn road with nothing under it for a metre or more. The
  //           shoulder mesh hangs over a hole, which is what a 24 m authored
  //           shoulder got when the bake assumed 3 m.
  // Sections flagged `TF.Bridge` are excluded from VOID: a deck is supposed to
  // have air under it.
  {
    const f0 = ctx.field;
    const stripped: PathStation[] = ctx.stations.map((s) => {
      const c: PathStation = { ...s };
      delete c.shoulderL; delete c.shoulderR;
      return c;
    });
    const f1 = new TerrainField({
      seed: f0.seed, extent: f0.extent, res: f0.res,
      centreX: f0.centreX, centreZ: f0.centreZ,
      stations: stripped, theme: f0.theme, waterLevel: f0.waterLevel,
      amplitude: f0.amplitude,
    }, null);

    interface Score { proud: number; proudAt: string; void_: number; voidAt: string; sum: number; n: number; }
    const mk = (): Score => ({ proud: -Infinity, proudAt: '', void_: 0, voidAt: '', sum: 0, n: 0 });
    const now = mk(), was = mk();
    for (const [d, p] of profiles) {
      if (p.edgeR - p.edgeL < 4) continue;
      const s = track.sampleAtDistance(d);
      track.spline.attribsAtDistance(d, attribs);
      // A tunnel is a bore through rock: ground ABOVE the road is the point of
      // it, so it cannot be a lip. A bridge deck is supposed to have air under
      // it. A gap has no road to measure against.
      const bored = (attribs.flags & TF.Tunnel) !== 0;
      const deck = bored || (attribs.flags & TF.Bridge) !== 0;
      if (attribs.flags & TF.Gap) continue;
      for (let k = 0; k <= 40; k++) {
        const u = p.edgeL + (p.edgeR - p.edgeL) * (k / 40);
        const px = s.position.x + s.binormal.x * u;
        const pz = s.position.z + s.binormal.z * u;
        const ribY = p.y[Math.round((u + PROF_MAX) / PROF_STEP)];
        if (ribY === null || ribY === undefined) continue;
        for (const [f, sc] of [[f0, now], [f1, was]] as Array<[TerrainField, Score]>) {
          const g = f.heightAt(px, pz);
          const dy = g - ribY;
          if (!bored && dy > sc.proud) { sc.proud = dy; sc.proudAt = `arc ${d} lat ${f2(u)}`; }
          if (!deck && -dy > sc.void_) { sc.void_ = -dy; sc.voidAt = `arc ${d} lat ${f2(u)}`; }
          if (!deck) { sc.n++; sc.sum += Math.abs(dy); }
        }
      }
    }
    check(now.n > 200 && now.proud <= was.proud + REGRESS_SLACK,
      'D. terrain no more proud of the road than before',
      `worst +${f2(now.proud)} m (${now.proudAt}) vs +${f2(was.proud)} m on a SH_FALLBACK bake ` +
      `[${now.proud - was.proud >= 0 ? '+' : ''}${f2(now.proud - was.proud)} m]; ` +
      `mean |Δ| ${f3(now.sum / Math.max(now.n, 1))} vs ${f3(was.sum / Math.max(was.n, 1))} m, ${now.n} samples`);
    check(now.n > 200 && now.void_ <= was.void_ + REGRESS_SLACK,
      'D. no more drawn road over a void than before',
      `worst ${f2(now.void_)} m (${now.voidAt}) vs ${f2(was.void_)} m on a SH_FALLBACK bake ` +
      `[${now.void_ - was.void_ >= 0 ? '+' : ''}${f2(now.void_ - was.void_)} m]`);

    let maxD = 0, maxAt = 0, sum2 = 0, moved = 0;
    const N = f0.height.length;
    for (let i = 0; i < N; i++) {
      const dh = f0.height[i] - f1.height[i];
      const a = Math.abs(dh);
      sum2 += dh * dh;
      if (a > 0.1) moved++;
      if (a > Math.abs(maxD)) { maxD = dh; maxAt = i; }
    }
    const mx = f0.originX + ((maxAt % f0.res) + 0.5) * f0.metresPerTexel;
    const mz = f0.originZ + (Math.floor(maxAt / f0.res) + 0.5) * f0.metresPerTexel;
    console.log(
      `  ----  E. heightfield vs a SH_FALLBACK bake        ` +
      `${moved}/${N} texels moved >0.1 m (${(100 * moved / N).toFixed(2)} %), ` +
      `rms ${f3(Math.sqrt(sum2 / N))} m, worst ${maxD >= 0 ? '+' : ''}${f2(maxD)} m ` +
      `at (${mx.toFixed(0)}, ${mz.toFixed(0)})`,
    );
    f1.dispose();
  }

  env.dispose();
  console.log('');
}

console.log(fails === 0 ? 'PASS: 0 assertions failed' : `*** ${fails} assertion(s) FAILED`);
process.exit(0);
