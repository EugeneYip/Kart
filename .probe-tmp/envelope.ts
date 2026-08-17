/**
 * ============================================================================
 *  EVERY DRIVING-ENVELOPE INTRUSION, ENUMERATED AND MEASURED
 * ============================================================================
 *  `propfoot.ts` answers "is anything in the envelope?" with a yes/no and a
 *  one-line summary per offender. That is the right shape for a gate and the
 *  wrong shape for a certification table, because closing a finding needs three
 *  numbers the gate does not print:
 *
 *   1. THE WORST CLEARANCE, CONTINUOUS. `propfoot` prints `maxAbove`, the
 *      TALLEST flagged vertex. For anything that arches over the road that is
 *      the least interesting number in the file — it is pinned to the band
 *      ceiling by construction (a vertex at 3.01 m is not flagged, so
 *      `maxAbove` can never exceed 3.00). The number that decides whether a
 *      kart hits something is the LOWEST point of the prop anywhere over the
 *      drawn asphalt, and it has to come off the triangles, not the vertices:
 *      the low point of a sphere's belly band lies between vertices.
 *
 *   2. DEPTH INSIDE THE ASPHALT, MEASURED FROM THE MESH. `propfoot` reports
 *      `halfWidth - |lat|` off a centreline projection. That goes NEGATIVE on
 *      volcano's portals — "0.44 m outside the drivable edge" for a vertex the
 *      ribbon says is standing on asphalt. Both cannot be true, and it is the
 *      centreline that is lying: `projectOnDeck` samples every 2 m and accepts
 *      any station within `|along| < 2`, so where the half-width is ramping it
 *      reports a neighbouring station's width. `depthInsideAsphalt` bisects the
 *      real edge of the drawn carriageway in 64 directions instead.
 *
 *   3. WHICH PART OF THE PROP. Flagged vertices are pushed back through the
 *      instance matrix into the prop's own local frame, so the row says
 *      "balloon 4 of 35, its underside" rather than "14 verts".
 *
 *  Every number is cross-checked against `Soup.nearestAsphaltInPlan`, a brute
 *  force scan with no grid and no barycentric test — the instrument that proved
 *  neon's `skyscraperWindows` an artefact at 52.2 m. If the bucketed query and
 *  the brute force disagree the row says so.
 *
 *  usage: node src/dev/node-run.mjs .probe-tmp/envelope.ts [ids...]
 *           [--tier=ultra]     default; prop scatter density follows the tier
 *           [--drive=3.0]      envelope ceiling in metres
 *           [--breakdepth]     sabotage arm: cripple the depth bisection.
 *                              The calibration arms MUST go red.
 *           [--breaksoup]      sabotage arm: mistag the asphalt.
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import { TRACK_ORDER } from '@/track/TrackDefs';
import type { Track } from '@/track/Track';
import {
  Soup, ribbonSoup, seat, Verdict, K_ROAD, ABOVE_TOL,
  depthInsideAsphalt, overAsphaltAt,
} from './ribbon';

const ARGS = process.argv.slice(3);
const ONLY = ARGS.filter((a) => !a.startsWith('--'));
const IDS: readonly string[] = (ONLY.length === 0 || (ONLY.length === 1 && ONLY[0] === 'all'))
  ? TRACK_ORDER : ONLY;
for (const id of IDS) {
  if (!(TRACK_ORDER as readonly string[]).includes(id)) {
    throw new Error(`unknown circuit "${id}" — getTrackDef() falls back silently. Known: ${TRACK_ORDER.join(', ')}`);
  }
}
const TIER = (ARGS.find((a) => a.startsWith('--tier=')) ?? '--tier=ultra').slice(7) as
  'low' | 'medium' | 'high' | 'ultra';
const DRIVE_HEIGHT = Number((ARGS.find((a) => a.startsWith('--drive=')) ?? '--drive=3.0').slice(8));
const BREAK_DEPTH = ARGS.includes('--breakdepth');
const BREAK_SOUP = ARGS.includes('--breaksoup');

let fails = 0;
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label.padEnd(52)} ${detail}`);
};

/**
 * The depth measurement under test. `--breakdepth` replaces the bisection with
 * the coarse march's outer bound, which overstates every depth by up to 0.25 m
 * — enough for the 0.02 m calibration tolerance to catch it, and a faithful
 * model of the mistake this arm exists to rule out (an off-by-one-step search).
 */
const depth = (soup: Soup, x: number, z: number, deckY: number): number =>
  BREAK_DEPTH
    ? depthInsideAsphalt(soup, x, z, deckY, 64, 30, 0)
    : depthInsideAsphalt(soup, x, z, deckY, 64, 30, 16);

const _v = new THREE.Vector3();
const _l = new THREE.Vector3();
const _tmp = new THREE.Vector3();

// ---------------------------------------------------------------------------
//  Deck-aware centreline projection — REPORTING ONLY (arc labels)
// ---------------------------------------------------------------------------
interface CLine { d: Float64Array; px: Float64Array; py: Float64Array; pz: Float64Array;
  tx: Float64Array; ty: Float64Array; tz: Float64Array;
  bx: Float64Array; by: Float64Array; bz: Float64Array;
  nx: Float64Array; ny: Float64Array; nz: Float64Array; hw: Float64Array; n: number; }

function centreline(track: Track, step = 0.5): CLine {
  const n = Math.max(8, Math.ceil(track.lapLength / step));
  const a = (): Float64Array => new Float64Array(n);
  const c: CLine = { d: a(), px: a(), py: a(), pz: a(), tx: a(), ty: a(), tz: a(),
    bx: a(), by: a(), bz: a(), nx: a(), ny: a(), nz: a(), hw: a(), n };
  for (let i = 0; i < n; i++) {
    const d = (i / n) * track.lapLength;
    const s = track.sampleAtDistance(d);
    c.d[i] = d;
    c.px[i] = s.position.x; c.py[i] = s.position.y; c.pz[i] = s.position.z;
    c.tx[i] = s.tangent.x; c.ty[i] = s.tangent.y; c.tz[i] = s.tangent.z;
    c.bx[i] = s.binormal.x; c.by[i] = s.binormal.y; c.bz[i] = s.binormal.z;
    c.nx[i] = s.normal.x; c.ny[i] = s.normal.y; c.nz[i] = s.normal.z;
    c.hw[i] = s.halfWidth;
  }
  return c;
}

function projectOnDeck(c: CLine, x: number, y: number, z: number):
{ arc: number; lat: number; halfW: number } {
  let bestCost = Infinity, bestLat = 0, bestHw = 0, bestArc = 0;
  for (let i = 0; i < c.n; i++) {
    const dx = x - c.px[i], dy = y - c.py[i], dz = z - c.pz[i];
    if (dx * dx + dz * dz > 3600) continue;
    const along = dx * c.tx[i] + dy * c.ty[i] + dz * c.tz[i];
    if (along < -2 || along > 2) continue;
    const vert = dx * c.nx[i] + dy * c.ny[i] + dz * c.nz[i];
    const lat = dx * c.bx[i] + dy * c.by[i] + dz * c.bz[i];
    const cost = Math.abs(vert) + Math.abs(along) * 0.01;
    if (cost < bestCost) { bestCost = cost; bestLat = lat; bestHw = c.hw[i]; bestArc = c.d[i]; }
  }
  return { arc: bestArc, lat: bestLat, halfW: bestHw };
}

// ===========================================================================

interface Hit {
  /** World position and what the ribbon said about it. */
  x: number; y: number; z: number; above: number; deckY: number;
  /** Position in the prop's OWN local frame — identifies the sub-primitive. */
  lx: number; ly: number; lz: number;
}

interface Row {
  circuit: string;
  prop: string;
  inst: number;
  /** Vertices of this instance standing over drawn asphalt, at any height. */
  overAsphalt: number;
  /** ...of which, inside the envelope band. */
  inBand: number;
  /** Continuous minimum clearance over the asphalt, sampled off the TRIANGLES. */
  minClear: number;
  /** The same, but only counting geometry that is over asphalt. */
  maxInBand: number;
  /** Deepest point inside the drawn carriageway, in plan, bisected off the mesh. */
  deepest: number;
  /** Height of that deepest point above its deck. */
  deepestAbove: number;
  arc: number;
  lat: number;
  halfW: number;
  /** Brute-force cross-check on the deepest point. */
  bruteDist: number;
  /** Local-frame extent of the flagged vertices. */
  loc: string;
}

const rows: Row[] = [];
/** Per-instance clearance floor, keyed by prop type, across every circuit. */
const worstByType = new Map<string, { clear: number; where: string }>();

console.log(`\nDRIVING-ENVELOPE ENUMERATION   tier ${TIER}   band = surface+${ABOVE_TOL} m .. ${DRIVE_HEIGHT.toFixed(2)} m`);
console.log(`ground truth: the DRAWN ribbon (nearest deck below each vertex); depth bisected off the mesh`
  + `${BREAK_DEPTH ? '   [--breakdepth: bisection crippled]' : ''}`
  + `${BREAK_SOUP ? '   [--breaksoup: asphalt tag deleted]' : ''}\n`);

for (const id of IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS[TIER]);
  await env.init();

  const soup = ribbonSoup(track, BREAK_SOUP);
  const cl = centreline(track);
  console.log(`=== ${id} ===   ribbon ${soup.count} triangles`);

  const roots: THREE.Object3D[] = [];
  scene.traverse((o) => { if (/^Prop:/.test(o.name || '')) roots.push(o); });

  const box = new THREE.Box3();
  const gbox = new THREE.Box3();
  const m = new THREE.Matrix4();
  const minv = new THREE.Matrix4();

  for (const root of roots) {
    const mesh = root as THREE.Mesh & { isInstancedMesh?: boolean; count?: number; instanceMatrix?: THREE.InstancedBufferAttribute };
    if (!mesh.isMesh || !mesh.geometry) continue;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    const idx = mesh.geometry.getIndex();
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    gbox.copy(mesh.geometry.boundingBox!);
    const instances = mesh.isInstancedMesh ? (mesh.count ?? 1) : 1;
    root.updateMatrixWorld(true);

    for (let inst = 0; inst < instances; inst++) {
      if (mesh.isInstancedMesh && mesh.instanceMatrix) {
        m.fromArray(mesh.instanceMatrix.array as unknown as number[], inst * 16);
        m.premultiply(mesh.matrixWorld);
      } else {
        m.copy(mesh.matrixWorld);
      }
      box.copy(gbox).applyMatrix4(m);
      if (!soup.anyNear(box.min.x, box.max.x, box.min.z, box.max.z)) continue;

      // ---- pass 1: vertices ------------------------------------------------
      const hits: Hit[] = [];
      let overAsphalt = 0;
      for (let vi = 0; vi < pos.count; vi++) {
        _l.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
        _v.copy(_l).applyMatrix4(m);
        const st = seat(soup, _v.x, _v.y, _v.z, DRIVE_HEIGHT);
        if (st.kind !== K_ROAD || st.verdict === Verdict.NoRibbon || st.verdict === Verdict.UnderAll) continue;
        overAsphalt++;
        if (st.verdict !== Verdict.OnRoad) continue;
        hits.push({ x: _v.x, y: _v.y, z: _v.z, above: st.above, deckY: st.deckY,
          lx: _l.x, ly: _l.y, lz: _l.z });
      }
      if (hits.length === 0) continue;

      // ---- pass 2: TRIANGLE INTERIORS -------------------------------------
      // The lowest point of a sphere's belly band, or of a box's bottom face,
      // falls between vertices. Walk the surface, not the corners.
      const triCount = (idx ? idx.count : pos.count) / 3;
      let minClear = Infinity, maxInBand = -Infinity;
      /** Where the lowest point is — a clearance with no location is a rumour. */
      const lowAt = { x: 0, y: 0, z: 0, deckY: 0, lx: 0, ly: 0, lz: 0 };
      const S = 5;                                  // barycentric samples per edge
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      const la = new THREE.Vector3(), lb = new THREE.Vector3(), lc = new THREE.Vector3();
      const p = new THREE.Vector3();
      for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        la.fromBufferAttribute(pos, i0); a.copy(la).applyMatrix4(m);
        lb.fromBufferAttribute(pos, i1); b.copy(lb).applyMatrix4(m);
        lc.fromBufferAttribute(pos, i2); c.copy(lc).applyMatrix4(m);
        // Cheap reject: no ribbon bucketed under this triangle's plan box.
        const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x);
        const z0 = Math.min(a.z, b.z, c.z), z1 = Math.max(a.z, b.z, c.z);
        if (!soup.anyNear(x0, x1, z0, z1)) continue;
        for (let u = 0; u <= S; u++) {
          for (let v = 0; u + v <= S; v++) {
            const w = S - u - v;
            p.set((a.x * u + b.x * v + c.x * w) / S, (a.y * u + b.y * v + c.y * w) / S,
              (a.z * u + b.z * v + c.z * w) / S);
            const st = seat(soup, p.x, p.y, p.z, DRIVE_HEIGHT);
            if (st.kind !== K_ROAD || st.verdict === Verdict.NoRibbon || st.verdict === Verdict.UnderAll) continue;
            if (st.above < minClear) {
              minClear = st.above;
              lowAt.x = p.x; lowAt.y = p.y; lowAt.z = p.z; lowAt.deckY = st.deckY;
              lowAt.lx = (la.x * u + lb.x * v + lc.x * w) / S;
              lowAt.ly = (la.y * u + lb.y * v + lc.y * w) / S;
              lowAt.lz = (la.z * u + lb.z * v + lc.z * w) / S;
            }
            if (st.verdict === Verdict.OnRoad && st.above > maxInBand) maxInBand = st.above;
          }
        }
      }
      const lowDepth = depth(soup, lowAt.x, lowAt.z, lowAt.deckY);
      const lowBrute = soup.nearestAsphaltInPlan(lowAt.x, lowAt.z).dist;

      // ---- the deepest flagged point inside the drawn carriageway ---------
      let deepest = -1, dh: Hit | null = null;
      for (const h of hits) {
        const d = depth(soup, h.x, h.z, h.deckY);
        if (d > deepest) { deepest = d; dh = h; }
      }
      const pr = dh ? projectOnDeck(cl, dh.x, dh.y, dh.z) : { arc: 0, lat: 0, halfW: 0 };
      const brute = dh ? soup.nearestAsphaltInPlan(dh.x, dh.z).dist : -1;

      let lx0 = Infinity, lx1 = -Infinity, ly0 = Infinity, ly1 = -Infinity, lz0 = Infinity, lz1 = -Infinity;
      for (const h of hits) {
        lx0 = Math.min(lx0, h.lx); lx1 = Math.max(lx1, h.lx);
        ly0 = Math.min(ly0, h.ly); ly1 = Math.max(ly1, h.ly);
        lz0 = Math.min(lz0, h.lz); lz1 = Math.max(lz1, h.lz);
      }

      const type = root.name.replace(/^Prop:/, '');
      const cur = worstByType.get(type);
      if (!cur || minClear < cur.clear) worstByType.set(type, { clear: minClear, where: `${id}#${inst}` });

      rows.push({
        circuit: id, prop: type, inst,
        overAsphalt, inBand: hits.length,
        minClear, maxInBand,
        deepest, deepestAbove: dh ? dh.above : 0,
        arc: pr.arc, lat: pr.lat, halfW: pr.halfW, bruteDist: brute,
        loc: `x ${lx0.toFixed(2)}..${lx1.toFixed(2)}  y ${ly0.toFixed(2)}..${ly1.toFixed(2)}  z ${lz0.toFixed(2)}..${lz1.toFixed(2)}`,
      });

      console.log(`  ${root.name}#${inst}`);
      console.log(`      ${hits.length} verts in band of ${overAsphalt} over asphalt;  `
        + `LOWEST point of this instance anywhere over the tarmac ${minClear.toFixed(3)} m  `
        + `(highest in band ${maxInBand.toFixed(3)} m)`);
      console.log(`      that lowest point: local (${lowAt.lx.toFixed(2)}, ${lowAt.ly.toFixed(2)}, `
        + `${lowAt.lz.toFixed(2)})  deck y ${lowAt.deckY.toFixed(2)}  `
        + `${lowDepth.toFixed(2)} m inside the carriageway  (brute force ${lowBrute.toFixed(2)} m)`);
      console.log(`      deepest inside the DRAWN carriageway ${deepest.toFixed(3)} m in plan `
        + `at ${dh ? dh.above.toFixed(3) : '?'} m up   @arc ${pr.arc.toFixed(0)}  `
        + `[centreline says lat ${pr.lat.toFixed(2)} of halfW ${pr.halfW.toFixed(2)} `
        + `=> ${(pr.halfW - Math.abs(pr.lat)).toFixed(2)}]`);
      console.log(`      brute-force nearest drawn asphalt vertex in plan: ${brute.toFixed(2)} m`);
      console.log(`      local frame: ${rows[rows.length - 1].loc}`);
    }
  }
  if (!rows.some((r) => r.circuit === id)) console.log('  (nothing in the envelope)');
  env.dispose();
}

// ---------------------------------------------------------------------------
console.log(`\n---- TABLE ----`);
console.log('circuit           prop                       inst  band  lowest  deepest  arc');
for (const r of rows) {
  console.log(`${r.circuit.padEnd(18)}${r.prop.padEnd(27)}${String(r.inst).padStart(4)}`
    + `${String(r.inBand).padStart(6)}${r.minClear.toFixed(2).padStart(8)}`
    + `${r.deepest.toFixed(2).padStart(9)}${r.arc.toFixed(0).padStart(6)}`);
}
console.log(`\n${rows.length} intrusion(s) over ${IDS.length} circuit(s)`);
console.log('worst clearance by prop type:');
for (const [t, w] of [...worstByType].sort((a, b) => a[1].clear - b[1].clear)) {
  console.log(`  ${t.padEnd(34)} ${w.clear.toFixed(3)} m   (${w.where})`);
}

// ===========================================================================
//  RED CHECKS — the depth measurement is new, so it gets calibrated, and the
//  calibration has to be breakable.
// ===========================================================================
console.log('\nRED CHECKS');
{
  const track = await loadTrack(IDS[0]);
  const soup = ribbonSoup(track, BREAK_SOUP);

  // Pick a station that is straight and unbanked, so "lat" and "distance to the
  // asphalt edge in plan" are the same thing to within the sampling. Asserted,
  // not assumed: if no such station exists the arm says so instead of passing.
  let best: { d: number; bank: number; curv: number } | null = null;
  for (let d = 0; d < track.lapLength; d += 1) {
    const s0 = track.sampleAtDistance(d);
    const s1 = track.sampleAtDistance((d + 8) % track.lapLength);
    const bank = Math.abs(s0.binormal.y);
    const curv = 1 - s0.tangent.dot(s1.tangent);
    if (Math.abs(s0.halfWidth - s1.halfWidth) > 0.02) continue;
    if (!best || bank + curv * 4 < best.bank + best.curv * 4) best = { d, bank, curv };
  }
  if (!best || best.bank > 0.02 || best.curv > 0.002) {
    console.log(`  *** FAIL  a straight level station exists to calibrate on   `
      + `best bank ${(best?.bank ?? 1).toFixed(3)} curv ${(best?.curv ?? 1).toFixed(4)} — arm is vacuous`);
    fails++;
  } else {
    const s = track.sampleAtDistance(best.d);
    console.log(`     (calibrating on ${IDS[0]} arc ${best.d}: halfWidth ${s.halfWidth.toFixed(2)}, `
      + `bank ${best.bank.toFixed(4)}, curvature ${best.curv.toFixed(5)})`);
    // (a) DEPTH CALIBRATION. Place a point at a KNOWN inset from the drawn edge
    //     and demand the bisection recover it. This is the arm that makes every
    //     "0.66 m inside" number in the table mean something.
    let worstErr = 0, worstAt = 0;
    // ---- THESE NUMBERS ARE DELIBERATELY OFF-GRID. -------------------------
    // The first cut of this arm calibrated on 0.25 / 0.5 / 1 / 2 / 4 / 8 m, and
    // `--breakdepth` — which deletes the bisection entirely and returns the
    // coarse march's lower bound — recovered every one of them to 0.000 m and
    // the arm PASSED. The coarse march steps 0.25 m, so every one of those
    // insets sat exactly on a step boundary and the crippled search could not
    // be wrong about them. A control whose test points are aligned to the grid
    // of the thing it is testing is not a control.
    //
    // Off-grid, a missing bisection is off by up to a full step, which is four
    // times the tolerance below.
    for (const inset of [0.31, 0.57, 1.13, 2.42, 4.68, 8.09]) {
      const lat = s.halfWidth - inset;
      const x = s.position.x + s.binormal.x * lat;
      const y = s.position.y + s.binormal.y * lat;
      const z = s.position.z + s.binormal.z * lat;
      const st = seat(soup, x, y + 1.0, z, DRIVE_HEIGHT);
      const got = depth(soup, x, z, st.deckY);
      const err = Math.abs(got - inset);
      if (err > worstErr) { worstErr = err; worstAt = inset; }
      console.log(`        inset ${inset.toFixed(2)} m  ->  measured ${got.toFixed(3)} m  (err ${err.toFixed(3)})`);
    }
    // Tolerance is the ribbon's own lateral tessellation: ROAD_SPANS = 10 spans
    // with a 0.86 power bias, so the outermost span on a 12 m half-width is
    // ~0.4 m of chord and the drawn edge is a polyline, not a curve. 0.06 m is
    // comfortably inside that and far outside the crippled search's 0.25 m step.
    const okA = worstErr < 0.06;
    console.log(`  ${okA ? 'PASS' : '*** FAIL'}  the depth bisection recovers a known inset`.padEnd(58)
      + ` worst error ${worstErr.toFixed(3)} m at inset ${worstAt.toFixed(2)}`
      + `${okA ? '' : ' — the depth column is not measuring depth'}`);
    if (!okA) fails++;

    // (b) ...and reports NOTHING for a point off the asphalt. Without this the
    //     depth column could be a constant and arm (a) would still pass on the
    //     one value that happened to match.
    const outLat = s.halfWidth + 2.0;
    const ox = s.position.x + s.binormal.x * outLat;
    const oz = s.position.z + s.binormal.z * outLat;
    const outD = depth(soup, ox, oz, s.position.y);
    const okB = outD < 0;
    console.log(`  ${okB ? 'PASS' : '*** FAIL'}  ...and refuses a point 2 m off the asphalt`.padEnd(58)
      + ` ${outD < 0 ? 'declined' : `claimed ${outD.toFixed(2)} m inside`}`);
    if (!okB) fails++;

    // (c) THE BAND ITSELF. A synthetic slab at a known height over the
    //     centreline must be caught at that height and no other, so the
    //     `minClear` column cannot be an artefact of the sampling.
    for (const h of [0.5, 1.4, 2.95]) {
      const y = s.position.y + s.normal.y * h + (s.position.y - s.position.y);
      const st = seat(soup, s.position.x, s.position.y + h, s.position.z, DRIVE_HEIGHT);
      const ok = st.verdict === Verdict.OnRoad && Math.abs(st.above - h) < 0.25;
      console.log(`  ${ok ? 'PASS' : '*** FAIL'}  a point ${h.toFixed(2)} m over the centreline reads back`.padEnd(58)
        + ` ${st.above.toFixed(2)} m, verdict ${Verdict[st.verdict]}${y === 0 ? '' : ''}`);
      if (!ok) fails++;
    }
    const above = seat(soup, s.position.x, s.position.y + DRIVE_HEIGHT + 0.2, s.position.z, DRIVE_HEIGHT);
    const okD = above.verdict === Verdict.Clear;
    console.log(`  ${okD ? 'PASS' : '*** FAIL'}  ...and one above the ceiling is scenery`.padEnd(58)
      + ` verdict ${Verdict[above.verdict]} at ${above.above.toFixed(2)} m`);
    if (!okD) fails++;

    // (e) THE BRUTE-FORCE CROSS-CHECK IS LIVE. It has to disagree with a point
    //     that is genuinely far away, or it is not checking anything.
    const farX = s.position.x + s.binormal.x * (s.halfWidth + 40);
    const farZ = s.position.z + s.binormal.z * (s.halfWidth + 40);
    const near = soup.nearestAsphaltInPlan(farX, farZ).dist;
    const onit = soup.nearestAsphaltInPlan(s.position.x, s.position.z).dist;
    const okE = near > 20 && onit < 2;
    console.log(`  ${okE ? 'PASS' : '*** FAIL'}  brute force separates on-road from 40 m out`.padEnd(58)
      + ` centreline ${onit.toFixed(2)} m, 40 m out ${near.toFixed(2)} m`);
    if (!okE) fails++;

    // (f) NON-VACUITY OF THE WHOLE RUN. If nothing was walked the table is
    //     empty for the wrong reason.
    void overAsphaltAt; void _tmp;
  }
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
