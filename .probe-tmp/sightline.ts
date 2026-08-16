/**
 * ============================================================================
 *  D4 — SIGHTLINE OCCLUSION: WHICH PROPS HIDE THE ROAD THROUGH A CORNER
 * ============================================================================
 *  The existing road-volume guard (`Props.insideRoadVolume`) asks "is this prop
 *  inside the tunnel bore / bridge deck / anti-gravity tube?". That is a
 *  containment test and it cannot answer the owner's complaint, which is about
 *  props that clear the corridor perfectly but stand between the driver's eye
 *  and the piece of road they need to read.
 *
 *  So: put the eye where the chase camera actually is, aim it where the chase
 *  camera actually aims, and cast rays at the road surface ahead. Any prop whose
 *  oriented bounding box is hit between the eye and the road point is stealing
 *  the racing line.
 *
 *  Pure geometry — no pixels, no GPU.
 *
 *  Occluder proxy is the instance's own geometry bounding box transformed by its
 *  instance matrix (a real OBB, ray tested in the instance's local space), which
 *  is exact for the boxy recipes (towers, blocks, walls) and conservative for
 *  the spindly ones (masts, pylons, signs on poles).
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';

// Driven off the SHIPPING registry, with an optional id filter on the command
// line, so a circuit added to `TRACKS` cannot be invisible to this probe.
import { TRACK_ORDER } from '@/track/TrackDefs';
const ONLY = process.argv.slice(3).filter((a) => !a.startsWith('--'));
// `all` is spelled out, because it used to be swallowed as a circuit id:
// `getTrackDef()` falls back silently on an unknown id, so `sightline.ts all`
// measured sunsetCoastline alone and printed `=== all ===` over it.
const PROBE_IDS: readonly string[] = (ONLY.length === 0 || (ONLY.length === 1 && ONLY[0] === 'all'))
  ? TRACK_ORDER : ONLY;
for (const id of PROBE_IDS) {
  if (!(TRACK_ORDER as readonly string[]).includes(id)) {
    throw new Error(`unknown circuit "${id}" — getTrackDef() would fall back silently and you would `
      + `be measuring sunsetCoastline under someone else's name. Known: ${TRACK_ORDER.join(', ')}`);
  }
}

/**
 * ---- THE TIER THIS AUDIT RUNS AT, AND WHY IT IS NOW A FLAG ------------------
 *
 * This probe hardcoded `QUALITY_PRESETS.low`, as does every world-building probe
 * in this directory, on the strength of the note in `src/dev/headless.ts`:
 * "Only texture *resolution* follows the tier — the spline, the ring plan, the
 * racing line, the boost pads, the item-box spawns and every `ITrackService`
 * query are bit-identical across tiers."
 *
 * Every noun in that sentence is a **`Track`** noun. `Environment` is not
 * `Track`, and prop SCATTER DENSITY does follow the tier. Measured by building
 * each circuit at both tiers and diffing the `Prop:*` census: **7476 instances
 * at low against 8889 at ultra across the eight circuits — 15.9 % of the
 * shipping world that this audit had never seen.** newYorkCircuit alone goes
 * `rock` 14 -> 24, `parkedCar` 21 -> 34, `streetlight` 42 -> 71: precisely the
 * roadside classes an intrusion audit exists to catch. `Engine` defaults the
 * shipping game to `ultra`.
 *
 * Default stays `low` because procedural texture generation without a GPU canvas
 * costs ~3.7 s per circuit there against far more at higher tiers, and eight
 * circuits at ultra is a slow run. But it is a FLAG now, and any claim of the
 * form "no prop intrudes on any circuit" has to be made with `--tier=ultra`.
 */
const TIER_ARG = process.argv.slice(3).find((a) => a.startsWith('--tier='));
const TIER = (TIER_ARG ? TIER_ARG.slice(7) : 'low') as 'low' | 'medium' | 'high' | 'ultra';

// --- chase camera, from CAMERA_TUNING at ~0.9 speed ratio -------------------
const CAM_BACK = 5.4 + 1.2 * 0.9;      // baseDistance + distanceSpeedGain
const CAM_UP = 2.15 + 0.2 * 0.9;       // baseHeight  + heightSpeedGain
const LOOK_AHEAD = 3.2 + 7.5 * 0.9;    // lookAheadBase + lookAheadSpeed
const LOOK_UP = 1.15;                  // lookHeight
const FOV_Y = 70 * Math.PI / 180;      // 65 base, rises with speed
const ASPECT = 16 / 9;

/** How far ahead the driver needs to read the road, and how wide. */
const RANGES = [18, 26, 36, 50, 68, 88];
const LATERALS = [-0.85, -0.45, 0, 0.45, 0.85];
const STATION_STEP = 6;

/**
 * Excluded from the occlusion count, with reasons:
 *
 *  HOLLOW  — authored to straddle the road (gantry, portal, arch, banner). Their
 *            bounding box spans the opening you drive through, so a box proxy
 *            calls the empty span solid. A gantry crossing your view is intended.
 *  DYNAMIC — trams and gulls are `motion` props: their instance matrices are
 *            written in `Props.update()`, so at build time they sit at the
 *            origin with an identity transform and would "occlude" the whole lap.
 */
// `brooklyntower` joins the set on a MEASUREMENT, not on a name: it is a
// `CORRIDOR_PROPS` gate whose two pointed arches leave 8.39 m of clear
// headroom over every lateral sample of the carriageway, walked triangle by
// triangle in `.probe-tmp/citynew.ts`. Without it the box proxy calls a 41 x
// 71 m opening solid and reports 16 blind stations that no driver ever sees.
const HOLLOW = /gantry|portal|arch|balloon|hoload|banner|bridge|brooklyntower/i;
const DYNAMIC = /tram|gull/i;

interface Occluder {
  name: string;
  inst: number;
  /** instance matrix inverse, for local-space slab tests */
  inv: THREE.Matrix4;
  box: THREE.Box3;
  /** world position, for reporting */
  pos: THREE.Vector3;
  radius: number;
  size: THREE.Vector3;
  corridor: boolean;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _hit = new THREE.Vector3();

/** Ray-vs-OBB. Returns the near hit distance along the (unnormalised) segment, or -1. */
function hitOBB(oc: Occluder, ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number): number {
  _o.set(ox, oy, oz).applyMatrix4(oc.inv);
  // The direction transforms by the upper 3x3 only, and must NOT be normalised —
  // keeping its length means the slab parameter t stays the fraction along the
  // eye->road segment, which is exactly what "is it in front of the road" needs.
  const e = oc.inv.elements;
  _d.set(
    e[0] * dx + e[4] * dy + e[8] * dz,
    e[1] * dx + e[5] * dy + e[9] * dz,
    e[2] * dx + e[6] * dy + e[10] * dz,
  );
  let tmin = 0, tmax = 1;
  const lo = oc.box.min, hi = oc.box.max;
  const comp = [
    [_o.x, _d.x, lo.x, hi.x],
    [_o.y, _d.y, lo.y, hi.y],
    [_o.z, _d.z, lo.z, hi.z],
  ];
  for (const [o, d, a, b] of comp) {
    if (Math.abs(d) < 1e-9) {
      if (o < a || o > b) return -1;
      continue;
    }
    let t0 = (a - o) / d, t1 = (b - o) / d;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

interface Blame {
  key: string;
  name: string;
  hits: number;
  stations: Set<number>;
  worstStation: number;
  pos: THREE.Vector3;
  /** lateral offset of the prop from its own nearest centreline point, metres */
  lat: number;
  /** arc position of that centreline point */
  propD: number;
  /** road half-width there, so `lat` can be read as "inside/outside the road" */
  halfW: number;
  /** height of the prop centre above the road plane */
  rise: number;
  /** world-space size of the occluder box */
  size: THREE.Vector3;
  corridor: boolean;
}

for (const id of PROBE_IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS[TIER]);
  await env.init();

  // --- gather occluders ----------------------------------------------------
  const props: Occluder[] = [];
  let nHollow = 0, nDynamic = 0, nFlat = 0, nOther = 0;
  const m = new THREE.Matrix4();
  scene.traverse((o) => {
    const mesh = o as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh || mesh.count <= 0) return;
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bb = geo.boundingBox;
    if (!bb) return;
    if (!mesh.name.startsWith('Prop:')) { nOther += mesh.count; return; }
    // Nothing under a metre tall can hide the road ahead from a 2.3 m eye.
    const size = bb.getSize(new THREE.Vector3());
    if (size.y < 0.9) { nFlat += mesh.count; return; }
    if (HOLLOW.test(mesh.name)) { nHollow += mesh.count; return; }
    if (DYNAMIC.test(mesh.name)) { nDynamic += mesh.count; return; }
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      const world = m.clone().premultiply(mesh.matrixWorld);
      const centre = bb.getCenter(new THREE.Vector3()).applyMatrix4(world);
      const sc = new THREE.Vector3().setFromMatrixScale(world);
      const radius = (geo.boundingSphere?.radius ?? size.length() * 0.5)
        * Math.max(sc.x, sc.y, sc.z);
      props.push({
        name: mesh.name, inst: i, inv: world.clone().invert(), box: bb,
        pos: centre, radius, corridor: false,
        size: new THREE.Vector3(size.x * sc.x, size.y * sc.y, size.z * sc.z),
      });
    }
  });

  // --- does any solid prop's GEOMETRY reach inside the drivable road? -------
  //
  // The blame table below reports each prop's centre. A 12 m-wide building whose
  // centre sits 10 m from the centreline still puts its near wall at 4 m — inside
  // a 7.7 m half-width road. The road-volume guard cannot see this: it only tests
  // tunnel bores, bridge decks and anti-gravity tubes, and on open tarmac there
  // is no volume to be inside of. So test the eight world corners of every
  // occluder box directly, ignoring anything more than 6 m above the road plane
  // (a roof overhanging the verge is fine; a wall on the tarmac is not).
  const intruders: Array<{ name: string; inst: number; reach: number; halfW: number;
    d: number; y: number; roll: number; }> = [];
  {
    const corner = new THREE.Vector3();
    const world = new THREE.Matrix4();
    const WUP = new THREE.Vector3(0, 1, 0);
    for (const oc of props) {
      world.copy(oc.inv).invert();
      let worstLat = Infinity, worstHalf = 0, worstD = 0, worstY = 0, worstRoll = 0;
      for (let c = 0; c < 8; c++) {
        corner.set(
          c & 1 ? oc.box.max.x : oc.box.min.x,
          c & 2 ? oc.box.max.y : oc.box.min.y,
          c & 4 ? oc.box.max.z : oc.box.min.z,
        ).applyMatrix4(world);
        const g = track.project(corner);
        const rise = corner.clone().sub(g.position).dot(g.normal);
        if (rise > 6 || rise < -3) continue;
        const lat = Math.abs(corner.clone().sub(g.position).dot(g.binormal));
        if (lat - g.halfWidth < worstLat - worstHalf) {
          worstLat = lat; worstHalf = g.halfWidth; worstD = g.distance; worstY = rise;
          // Roll of the carriageway there. `lat` is measured along the binormal,
          // so on a rolled road an authored `lat` buys altitude instead of
          // sideways clearance — printing the roll is what makes an intrusion
          // attributable to the bank rather than to the recipe's width.
          worstRoll = Math.acos(Math.min(1, Math.abs(g.normal.dot(WUP)))) * 180 / Math.PI;
        }
      }
      if (worstLat < worstHalf) {
        intruders.push({
          name: oc.name, inst: oc.inst, reach: worstHalf - worstLat,
          halfW: worstHalf, d: worstD, y: worstY, roll: worstRoll,
        });
      }
    }
  }

  // --- walk the lap --------------------------------------------------------
  const L = track.lapLength;
  const blame = new Map<string, Blame>();
  let samples = 0, inFrame = 0, blocked = 0;
  const perStation: Array<{ d: number; t: number; curv: number; inFrame: number; blocked: number }> = [];

  for (let d = 0; d < L; d += STATION_STEP) {
    const s = track.sampleAtDistance(d);
    const eye = s.position.clone()
      .addScaledVector(s.normal, CAM_UP)
      .addScaledVector(s.tangent, -CAM_BACK);
    const la = track.sampleAtDistance((d + LOOK_AHEAD) % L);
    const look = la.position.clone().addScaledVector(la.normal, LOOK_UP);
    const fwd = look.clone().sub(eye).normalize();
    // ---- THE CAMERA BASIS MUST BE THE ROAD'S, NOT THE WORLD'S ---------------
    //
    // `right = cross(fwd, worldUp)` assumes the camera is level. Neon's anti-
    // gravity stretch banks to **84 degrees** (`TrackDefs.ts` N6, `bank: 84`):
    // the chase camera rolls with the carriageway, so on that section a
    // world-up basis rolls the test frustum 84 degrees away from the frame the
    // player is actually looking at — it swaps the horizontal and vertical
    // field of view and puts the real offenders outside the tested cone. That
    // is how 24 samples of `authored:agpylon` got dismissed as "a false
    // positive of a flat-road test on tube geometry": the test WAS flat-road,
    // but the conclusion was backwards — a rolled test finds more, not fewer.
    const right = new THREE.Vector3().crossVectors(fwd, s.normal).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const tanY = Math.tan(FOV_Y * 0.5);
    const tanX = tanY * ASPECT;

    let stIn = 0, stBlocked = 0;
    for (const range of RANGES) {
      const t = track.sampleAtDistance((d + range) % L);
      for (const latF of LATERALS) {
        samples++;
        const target = t.position.clone().addScaledVector(t.binormal, latF * t.halfWidth);
        const rel = target.clone().sub(eye);
        const vz = rel.dot(fwd);
        if (vz <= 1) continue;
        if (Math.abs(rel.dot(right)) > vz * tanX) continue;
        if (Math.abs(rel.dot(up)) > vz * tanY) continue;
        inFrame++; stIn++;

        // nearest blocking prop along the segment
        let bestT = 2, bestOc: Occluder | null = null;
        for (const oc of props) {
          // cheap reject: is the sphere anywhere near the segment?
          const w = oc.pos.clone().sub(eye);
          const proj = w.dot(rel) / rel.lengthSq();
          if (proj < 0.02 || proj > 0.98) continue;
          const closest = rel.clone().multiplyScalar(proj).sub(w).length();
          if (closest > oc.radius + 1) continue;
          const th = hitOBB(oc, eye.x, eye.y, eye.z, rel.x, rel.y, rel.z);
          if (!(th > 0.02 && th < 0.98 && th < bestT)) continue;
          // UNDER-DECK REJECTION, IN THE ROAD'S OWN FRAME. In a concave (valley)
          // vertical curve the straight chord from the eye to a distant road
          // point passes BELOW the road surface, so everything authored under
          // the deck — bridge pylons hang 12-22 m down — registers as an
          // occluder. The road occludes them first in the real frame, so a hit
          // that lands below the local road surface is not a sightline defect.
          //
          // `_hit.y < road.position.y` is the world-Y version of that test and
          // it is WRONG wherever the road is rolled. At `bank: 84` the road
          // normal is 6 degrees off horizontal, so "below the road" in world Y
          // covers most of the volume *beside* the carriageway — including the
          // half of the anti-gravity tube the driver is looking straight at.
          // Dotted against the road's own normal it means what it says.
          _hit.copy(rel).multiplyScalar(th).add(eye);
          const road = track.project(_hit);
          if (_hit.clone().sub(road.position).dot(road.normal) < -0.75) continue;
          bestT = th; bestOc = oc;
        }
        if (bestOc) {
          blocked++; stBlocked++;
          const key = `${bestOc.name}#${bestOc.inst}`;
          let b = blame.get(key);
          if (!b) {
            // The prop's OWN place on the circuit: project it onto the spline, so
            // `lat` is "how far from the centreline is this building" — the number
            // the track author needs — not an offset measured from the eye.
            const g = track.project(bestOc.pos);
            const rel2 = bestOc.pos.clone().sub(g.position);
            b = {
              key, name: bestOc.name, hits: 0, stations: new Set(), worstStation: d,
              pos: bestOc.pos,
              lat: rel2.dot(g.binormal),
              propD: g.distance,
              halfW: g.halfWidth,
              rise: rel2.dot(g.normal),
              size: bestOc.size,
              corridor: bestOc.corridor,
            };
            blame.set(key, b);
          }
          b.hits++;
          b.stations.add(d);
        }
      }
    }
    perStation.push({ d, t: s.t, curv: s.curvature, inFrame: stIn, blocked: stBlocked });
  }

  console.log(`\n=== ${id} ===`);
  console.log(`  occluder proxies: ${props.length} solid prop instances`
    + `  (excluded: ${nHollow} hollow/straddling, ${nDynamic} dynamic, ${nFlat} under 0.9 m,`
    + ` ${nOther} non-prop meshes)`);
  console.log(`  road-ahead samples: ${samples}, in frame ${inFrame}`
    + `, occluded by a prop ${blocked} (${(100 * blocked / Math.max(1, inFrame)).toFixed(1)}% of what should be visible)`);
  const bad = perStation.filter((p) => p.inFrame > 0 && p.blocked / p.inFrame >= 0.4);
  console.log(`  stations where a prop hides >=40% of the visible road ahead: ${bad.length}`
    + `/${perStation.length} (${(100 * bad.length / perStation.length).toFixed(1)}% of the lap)`);

  // Group intruders by recipe so the report is about authoring, not instances.
  const byRecipe = new Map<string, { n: number; worst: number; ds: number[]; roll: number }>();
  for (const it of intruders) {
    const r = byRecipe.get(it.name) ?? { n: 0, worst: 0, ds: [], roll: 0 };
    r.n++;
    if (it.reach > r.worst) { r.worst = it.reach; r.roll = it.roll; }
    r.ds.push(Math.round(it.d));
    byRecipe.set(it.name, r);
  }
  console.log(`  props whose geometry reaches INSIDE the drivable road (within 6 m of the`
    + ` road plane): ${intruders.length}`);
  for (const [n, r] of [...byRecipe].sort((a, b) => b[1].worst - a[1].worst).slice(0, 8)) {
    const ds = r.ds.sort((a, b) => a - b);
    console.log(`    ${n.padEnd(34)} ${String(r.n).padStart(3)} instances`
      + `  worst reach ${r.worst.toFixed(1)} m past the road edge`
      + `  at d=${ds[0]}-${ds[ds.length - 1]} m`
      + `  (road rolled ${r.roll.toFixed(0)} deg there)`);
  }
  // Per-instance, for whichever recipe is worst: the fix is an authoring change
  // and that needs each instance's own arc, roll and reach, not a group summary.
  const worstRecipe = [...byRecipe].sort((a, b) => b[1].worst - a[1].worst)[0];
  if (worstRecipe && worstRecipe[1].worst > 1.0) {
    console.log(`    -- every intruding instance of ${worstRecipe[0]} --`);
    for (const it of intruders.filter((i) => i.name === worstRecipe[0])
      .sort((a, b) => a.d - b.d)) {
      console.log(`       #${String(it.inst).padStart(2)}  d=${it.d.toFixed(0).padStart(4)} m`
        + `  t=${(it.d / L).toFixed(3)}  roll ${it.roll.toFixed(0).padStart(2)} deg`
        + `  halfW ${it.halfW.toFixed(1)}  reaches ${it.reach.toFixed(1)} m inside`
        + `  rise ${it.y.toFixed(1)} m`);
    }
  }

  const worst = perStation
    .filter((p) => p.inFrame > 0)
    .map((p) => ({ ...p, frac: p.blocked / p.inFrame }))
    .sort((a, b) => b.frac - a.frac)
    .slice(0, 8);
  console.log('  worst stations (t = lap fraction, curv = 1/m, R = corner radius):');
  for (const w of worst) {
    const R = Math.abs(w.curv) > 1e-4 ? (1 / Math.abs(w.curv)).toFixed(0) + ' m' : 'straight';
    console.log(`    t=${w.t.toFixed(3)}  d=${String(Math.round(w.d)).padStart(4)} m`
      + `  ${String(w.blocked).padStart(2)}/${String(w.inFrame).padStart(2)} road samples hidden`
      + ` (${(100 * w.frac).toFixed(0)}%)  curv ${w.curv.toFixed(4)} R=${R}`
      + `  turning ${w.curv > 0 ? 'right' : w.curv < 0 ? 'left' : '-'}`);
  }

  const top = [...blame.values()].sort((a, b) => b.hits - a.hits).slice(0, 12);
  console.log('  worst individual props  (lat = the PROP\'s own offset from the centreline;'
    + ' |lat| < halfW means it overhangs the road):');
  for (const b of top) {
    const st = [...b.stations].sort((x, y) => x - y);
    const clear = Math.abs(b.lat) - b.halfW;
    console.log(`    ${b.key.padEnd(34)} ${String(b.hits).padStart(4)} smp`
      + ` ${String(st.length).padStart(3)} st`
      + `  prop at d=${String(Math.round(b.propD)).padStart(4)} m`
      + ` lat ${(b.lat >= 0 ? '+' : '') + b.lat.toFixed(1)}`
      + ` (halfW ${b.halfW.toFixed(1)}, clear ${clear >= 0 ? '+' : ''}${clear.toFixed(1)} m)`
      + ` rise ${b.rise.toFixed(1)} m`
      + ` box ${b.size.x.toFixed(0)}x${b.size.y.toFixed(0)}x${b.size.z.toFixed(0)} m`
      + `  seen from d=${Math.round(st[0])}-${Math.round(st[st.length - 1])}`);
  }

  env.dispose();
}
