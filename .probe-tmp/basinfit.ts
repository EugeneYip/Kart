/**
 * ============================================================================
 *  BASINFIT — where a harbour plate can actually go, and at what level
 * ============================================================================
 *  `plate.ts` says the two authored `harbourWater` plates are 76.9 % and 96.3 %
 *  underground. This finds placements that are not.
 *
 *  The plate is a PROP, so the constraint is LOCAL, and that is the whole point:
 *  a global `waterLevel` has to clear the lowest drivable point anywhere on the
 *  lap (-4.55 m on Boston, at a banked corner's outer shoulder 500 m from the
 *  harbour), while a plate beside the harbour front only has to clear the road
 *  BESIDE THE HARBOUR FRONT.
 *
 *  Search space: the authored knobs, and only those — `t`, `lat`, `scale`, `up`
 *  on a `harbourWater` entry in `CityDefs.ts`. The recipe builds 300 x 140 m
 *  with local +X along the road (verified against the built AABB: Hong Kong's
 *  instance measures 141 x 301 m).
 *
 *  Hard constraints, all of which can reject a candidate:
 *   B  BURIAL      terrain must be below the plate at every footprint sample.
 *                  A plate the ground pokes through is the defect being fixed.
 *   F  FREEBOARD   the plate must sit >= MIN_FREE below every DRAWN road
 *                  surface point within 220 m. Water above the street is worse
 *                  than no water.
 *   C  CORRIDOR    no footprint sample within CLEAR m of the drawn road.
 *   P  PROUDNESS   outside the footprint, the ground may not be more than
 *                  PROUD_FAR below the plate, except on the road-facing side
 *                  where a quay wall is correct and PROUD_QUAY applies.
 *                  This is what stops the fitter proposing a reservoir standing
 *                  on a hill.
 *
 *  Score is the area with at least 0.25 m of water over it — the area that will
 *  read as water rather than as a wet seam.
 *
 *  Run: node src/dev/node-run.mjs .probe-tmp/basinfit.ts [ids...] [--tier=ultra]
 *       [--top=N] [--near=t0,t1] [--red]
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import { TRACK_ORDER } from '@/track/TrackDefs';
import type { QualityTier } from '@/core/Types';

const ARGS = process.argv.slice(3);
const FLAGS = ARGS.filter((a) => a.startsWith('--'));
const ONLY = ARGS.filter((a) => !a.startsWith('--'));
const IDS = ONLY.length ? ONLY : TRACK_ORDER.slice();
const val = (n: string, d: string): string => (FLAGS.find((f) => f.startsWith(`--${n}=`)) ?? `--${n}=${d}`).slice(n.length + 3);
const TIER = val('tier', 'ultra') as QualityTier;
const TOP = Number(val('top', '6'));
const RED = FLAGS.includes('--red');
const NEAR = val('near', '').length ? val('near', '').split(',').map(Number) : null;
if (!QUALITY_PRESETS[TIER]) throw new Error(`unknown tier ${TIER}`);

/** The `harbourWater` recipe's half-extents, local +X along the road. */
const PLATE_X = 150, PLATE_Z = 70;
/** Metres of water surface below the lowest nearby drawn road point. */
const MIN_FREE = Number(val('free', '0.5'));
/** Metres of clear ground between the plate edge and the drawn road. */
const CLEAR = Number(val('clear', '12'));
/** How far the plate may stand above the ground just outside it, away from the road. */
const PROUD_FAR = Number(val("proudfar", "1.6"));
/** ...and on the road-facing side, where a quay wall is the correct read. */
const PROUD_QUAY = Number(val("proudquay", "5.0"));
/** Sample spacing inside the footprint, metres. */
const FS = 7;
/** Smallest largest-connected-body worth reporting, m2. */
const MIN_AREA = Number(val('minarea', '1500'));
/** Radius, from the plate centre, over which the road sets the level. */
const FREE_R = Number(val('freer', '150'));
/** ...and the radius inside which a road point HARD-caps the level. */
const NEAR_R = Number(val('nearr', '45'));
/** Allowed gap between the asphalt edge and the plate's near edge, metres. */
const [EDGE0, EDGE1] = val('edge', '14,70').split(',').map(Number);
/** Which side(s) of the road to search: `+`, `-`, or both. */
const SIDES: number[] = val('side', 'both') === '+' ? [1] : val('side', 'both') === '-' ? [-1] : [1, -1];

const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

console.log(`tier=${TIER}  plate ${PLATE_X * 2} x ${PLATE_Z * 2} m at scale 1\n`);

for (const id of IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS[TIER]);
  await env.init();
  const field = env.field;
  if (!field) throw new Error(`${id}: no field`);
  const L = track.lapLength;

  // ---- the drawn road surface, once ----------------------------------------
  // ---- ASPHALT vs SHOULDER, and why the gate is on the asphalt --------------
  // The gate used to be "below every drawn road point within R", and on Boston
  // that rejected every candidate. The number doing the rejecting was the OUTER
  // SHOULDER EDGE of a banked station: the harbour-front centreline is at 1.82 m
  // and its drawn edge at lat 20.5 is at 0.07 m, because 20.5 m of lever arm on
  // ~5 deg of superelevation is 1.75 m of drop. Water level with a shoulder that
  // a sea wall stands on is a quay at high water, which is correct; water over
  // the racing surface is not. So the hard gate is the ASPHALT, and the shoulder
  // clearance is measured and reported rather than enforced.
  interface Pt { x: number; z: number; y: number; hard: boolean; }
  const road: Pt[] = [];
  for (let d = 0; d < L; d += 4) {
    const s = track.sampleAtDistance(d);
    for (let lat = -34; lat <= 34; lat += 2) {
      _p.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, 40);
      const hit = track.raycastGround(_p, _up, 90);
      if (hit.hit) {
        road.push({
          x: hit.point.x, y: hit.point.y, z: hit.point.z,
          hard: Math.abs(lat) <= s.halfWidth + 1.6,
        });
      }
    }
  }
  // Bucket the road into a coarse hash so the per-candidate query is not O(all).
  const CELL = 32;
  const key = (x: number, z: number): number => ((Math.floor(x / CELL) + 4096) << 13) ^ (Math.floor(z / CELL) + 4096);
  const grid = new Map<number, Pt[]>();
  for (const p of road) {
    const k = key(p.x, p.z);
    const b = grid.get(k);
    if (b) b.push(p); else grid.set(k, [p]);
  }
  /** Nearest drawn-road point to (x,z) within `r`, and its height. */
  const roadNear = (x: number, z: number, r: number): { d: number; y: number } => {
    let bd = Infinity, by = 0;
    const c = Math.ceil(r / CELL);
    for (let i = -c; i <= c; i++) {
      for (let j = -c; j <= c; j++) {
        const b = grid.get(key(x + i * CELL, z + j * CELL));
        if (!b) continue;
        for (const p of b) {
          const dd = Math.hypot(p.x - x, p.z - z);
          if (dd < bd) { bd = dd; by = p.y; }
        }
      }
    }
    return { d: bd, y: by };
  };

  // ---- diagnostic: what the ground does beside each part of the lap ---------
  // A plate can only exist where the ground BESIDE the road is below the road.
  // Printing this first means a "0 survive" answer is readable rather than mute.
  if (FLAGS.includes('--scan')) {
    console.log(`--- ${id}: road height vs the ground beside it, by lap position ---`);
    console.log('     t   road y   ground min/max in lat bands 30-80 / 80-140 / 140-220 (both sides)');
    for (let t = 0; t < 1; t += 0.05) {
      const s = track.sampleAt(t);
      const bx = new THREE.Vector3(s.binormal.x, 0, s.binormal.z).normalize();
      const cells: string[] = [];
      for (const [b0, b1] of [[30, 80], [80, 140], [140, 220]] as const) {
        let lo = Infinity, hi = -Infinity;
        for (const side of [1, -1]) {
          for (let l = b0; l <= b1; l += 6) {
            for (let a = -80; a <= 80; a += 20) {
              const ax2 = new THREE.Vector3(s.tangent.x, 0, s.tangent.z).normalize();
              const h = field.heightAt(
                s.position.x + bx.x * side * l + ax2.x * a,
                s.position.z + bx.z * side * l + ax2.z * a,
              );
              lo = Math.min(lo, h); hi = Math.max(hi, h);
            }
          }
        }
        cells.push(`${lo.toFixed(1)}..${hi.toFixed(1)}`);
      }
      console.log(`  ${t.toFixed(2)}  ${s.position.y.toFixed(2).padStart(6)}   ${cells.join('   ')}`);
    }
    console.log('');
  }

  interface Cand {
    t: number; lat: number; scale: number; up: number; level: number;
    wet: number; deep: number; proudFar: number; proudQuay: number;
    free: number; standoff: number; nearEdge: number; freeAny: number; burial: number;
  }
  const cands: Cand[] = [];

  const T0 = NEAR ? NEAR[0] : 0, T1 = NEAR ? NEAR[1] : 1;
  let tried = 0, rejB = 0, rejF = 0, rejC = 0, rejP = 0, rejA = 0, rejE = 0;

  for (let t = T0; t < T1; t += 0.01) {
    const s = track.sampleAt(t % 1);
    // Along-road and across-road unit axes, both horizontal: the instance
    // transform is yaw-only, so the plate is level whatever the road is doing.
    const ax = new THREE.Vector3(s.tangent.x, 0, s.tangent.z).normalize();
    const bx = new THREE.Vector3(s.binormal.x, 0, s.binormal.z).normalize();
    for (const side of SIDES) {
      for (let latC = 30; latC <= 260; latC += 8) {
        for (const scale of [0.2, 0.28, 0.35, 0.45, 0.6, 0.75, 0.9, 1.0]) {
          tried++;
          const hx = PLATE_X * scale, hz = PLATE_Z * scale;
          const lat = side * latC;
          // NEAR EDGE — the gap between the quay and the water, at this station.
          // Without it the fitter's best answer on Boston was lat 238 scale 1.00:
          // 44 149 m² of water with its near edge 168 m from the centreline, i.e.
          // 148 m of dry ground between the sea wall and the sea. Big is not the
          // objective; being the thing beyond the quay is.
          const nearEdge = latC - hz - s.halfWidth;
          if (nearEdge < EDGE0 || nearEdge > EDGE1) { rejE++; continue; }
          const cx = s.position.x + bx.x * lat, cz = s.position.z + bx.z * lat;
          const anchorGround = field.heightAt(cx, cz);

          // ---- THE LEVEL COMES FROM THE ROAD, NOT FROM THE TERRAIN ----------
          // The first revision of this fitter set `level = terrainMax + 0.06` so
          // burial was 0 by construction, then tested freeboard. That is the
          // wrong way round and it rejected all 26 400 candidates on Boston: the
          // terrain max inside a 300 m footprint is set by whatever rim ridge
          // clips its corner, and a level chasing a 66 m ridge is above every
          // road on the circuit. The physical constraint is the road — water may
          // not stand above the street — so the road fixes the level, and the
          // footprint then has to fit UNDER it.
          // ---- WHICH ROAD SETS THE LEVEL --------------------------------
          // Not the whole circuit, and not just the asphalt. A banked apex 120 m
          // away whose outer shoulder dips 2 m below the harbour is not readable
          // as flooded — you cannot see the two together past a sea wall and a
          // crowd stand — but a shoulder 20 m from the waterline is. So the hard
          // gate is every DRAWN road point (asphalt or shoulder) within NEAR_R of
          // the plate's own footprint, and the whole-neighbourhood figure is
          // reported beside it rather than enforced.
          let free = Infinity, freeAny = Infinity;
          for (const p of road) {
            const du = Math.abs((p.x - cx) * ax.x + (p.z - cz) * ax.z);
            const dv = Math.abs((p.x - cx) * bx.x + (p.z - cz) * bx.z);
            const gap = Math.hypot(Math.max(du - hx, 0), Math.max(dv - hz, 0));
            if (gap > FREE_R) continue;
            if (p.y < freeAny) freeAny = p.y;
            if (gap <= NEAR_R && p.y < free) free = p.y;
          }
          if (!Number.isFinite(free)) { rejF++; continue; }
          const level = free - MIN_FREE;

          // ---- BURIAL IS NOT THE OBJECTIVE. OPEN WATER IS. -------------------
          // The first scoring pass required burial == 0, and on Hong Kong that
          // left nothing at the authored harbour: the promenade's outfield RISES
          // (0.09 m at lat 40, 5.6 m at lat 170), so no rectangle beside it is
          // entirely under any level below the road. But a plate the ground
          // crosses is not a broken plate — the crossing IS the shoreline, and
          // at the 2.5 deg the two surfaces meet at, it comes out as an
          // irregular waterline rather than a straight seam. What matters is how
          // much OPEN water is left and whether it is one body or a rash of
          // puddles, which is the same distinction `harbour.ts` draws for a
          // global plane. So: score the largest CONNECTED exposed component, and
          // report burial instead of forbidding it.
          const NU = Math.max(2, Math.round((2 * hx) / FS) + 1);
          const NV = Math.max(2, Math.round((2 * hz) / FS) + 1);
          const open = new Uint8Array(NU * NV);
          let total = 0, buried = 0, deep = 0, bad = false;
          let standoff = Infinity;
          for (let iu = 0; iu < NU && !bad; iu++) {
            const u = -hx + (iu / (NU - 1)) * 2 * hx;
            for (let iv = 0; iv < NV; iv++) {
              const v = -hz + (iv / (NV - 1)) * 2 * hz;
              const px = cx + ax.x * u + bx.x * v, pz = cz + ax.z * u + bx.z * v;
              const h = field.heightAt(px, pz);
              total++;
              if (h > level) { buried++; continue; }
              const rn = roadNear(px, pz, 60);
              if (rn.d < standoff) standoff = rn.d;
              if (rn.d < CLEAR) { bad = true; break; }
              open[iu * NV + iv] = 1;
              deep = Math.max(deep, level - h);
            }
          }
          if (bad) { rejC++; continue; }
          // Largest connected component of the exposed set.
          let bestComp = 0;
          {
            const seen = new Uint8Array(NU * NV);
            const stack: number[] = [];
            for (let i = 0; i < NU * NV; i++) {
              if (!open[i] || seen[i]) continue;
              let n = 0; stack.length = 0; stack.push(i); seen[i] = 1;
              while (stack.length) {
                const c = stack.pop() as number; n++;
                const iu = (c / NV) | 0, iv = c % NV;
                if (iu > 0 && open[c - NV] && !seen[c - NV]) { seen[c - NV] = 1; stack.push(c - NV); }
                if (iu < NU - 1 && open[c + NV] && !seen[c + NV]) { seen[c + NV] = 1; stack.push(c + NV); }
                if (iv > 0 && open[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
                if (iv < NV - 1 && open[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
              }
              if (n > bestComp) bestComp = n;
            }
          }
          const cellA = (2 * hx / (NU - 1)) * (2 * hz / (NV - 1));
          const wet = bestComp * cellA;
          if (wet < MIN_AREA) { rejA++; continue; }
          void rejB;

          // Pass 3: proudness just outside the perimeter.
          let proudFar = 0, proudQuay = 0;
          const OUT = 9;
          for (let u = -hx; u <= hx; u += FS * 2) {
            for (const v of [-hz - OUT, hz + OUT]) {
              const px = cx + ax.x * u + bx.x * v, pz = cz + ax.z * u + bx.z * v;
              const pr = level - field.heightAt(px, pz);
              // The road-facing edge is the one whose |lat| is smaller.
              const quaySide = Math.abs(lat + v) < Math.abs(lat);
              if (quaySide) proudQuay = Math.max(proudQuay, pr);
              else proudFar = Math.max(proudFar, pr);
            }
          }
          for (const u of [-hx - OUT, hx + OUT]) {
            for (let v = -hz; v <= hz; v += FS * 2) {
              const px = cx + ax.x * u + bx.x * v, pz = cz + ax.z * u + bx.z * v;
              proudFar = Math.max(proudFar, level - field.heightAt(px, pz));
            }
          }
          if (proudFar > PROUD_FAR || proudQuay > PROUD_QUAY) { rejP++; continue; }
          const burial = buried / total;

          cands.push({
            t, lat, scale, up: +(level - anchorGround).toFixed(2), level,
            wet, deep, proudFar, proudQuay, free: free - level, burial,
            standoff, nearEdge, freeAny: freeAny - level,
          });
        }
      }
    }
  }

  cands.sort((a, b) => b.wet - a.wet);
  console.log(`=== ${id} ===  ${tried} candidates; rejected `
    + `${rejB} burial, ${rejC} corridor, ${rejF} no-road-nearby, ${rejP} proudness, `
    + `${rejA} too small, ${rejE} near-edge; ${cands.length} survive`);
  if (!cands.length) {
    console.log('  no placement satisfies all four constraints\n');
  } else {
    console.log('      t    lat  scale     up   level   open body  max depth  asphalt-free  shoulder-free  standoff  nearEdge  burial  proud(far/quay)');
    for (const c of cands.slice(0, TOP)) {
      console.log(`  ${c.t.toFixed(3)} ${String(c.lat).padStart(5)}   ${c.scale.toFixed(2)}  `
        + `${c.up.toFixed(2).padStart(5)}  ${c.level.toFixed(2).padStart(6)}  `
        + `${c.wet.toFixed(0).padStart(7)} m²   ${c.deep.toFixed(2).padStart(5)} m   `
        + `${c.free.toFixed(2).padStart(8)} m  ${c.freeAny.toFixed(2).padStart(8)} m  ${c.standoff.toFixed(1).padStart(6)} m   `
        + `${c.nearEdge.toFixed(1).padStart(6)} m  ${(100 * c.burial).toFixed(0).padStart(4)} %  ${c.proudFar.toFixed(2)} / ${c.proudQuay.toFixed(2)}`);
    }
    console.log('');
  }

  if (RED) {
    // The two gates that now do the work are LEVEL (no nearby road under water)
    // and AREA (a largest connected open body worth the name). Burial is no
    // longer a gate, so breaking it proves nothing — an earlier revision of this
    // block raised the winner's level to force burial and correctly reported
    // "GATE IS INERT", because raising a plate can only reduce what pokes
    // through it. Break the live gates instead, one each way.
    const best = cands[0];
    if (!best) {
      console.log('  [RED] skipped: no surviving candidate to break\n');
    } else {
      const s2 = track.sampleAt(best.t);
      const ax = new THREE.Vector3(s2.tangent.x, 0, s2.tangent.z).normalize();
      const bx = new THREE.Vector3(s2.binormal.x, 0, s2.binormal.z).normalize();
      const cx = s2.position.x + bx.x * best.lat, cz = s2.position.z + bx.z * best.lat;
      const hx = PLATE_X * best.scale, hz = PLATE_Z * best.scale;

      // RED 1 — LEVEL. Raise the plate 1.5 m above the road that capped it.
      const raised = best.level + MIN_FREE + 1.5;
      let under = 0, nearest = Infinity;
      for (const p of road) {
        const du = Math.abs((p.x - cx) * ax.x + (p.z - cz) * ax.z);
        const dv = Math.abs((p.x - cx) * bx.x + (p.z - cz) * bx.z);
        const gap = Math.hypot(Math.max(du - hx, 0), Math.max(dv - hz, 0));
        if (gap > NEAR_R) continue;
        if (p.y < raised) { under++; nearest = Math.min(nearest, gap); }
      }
      console.log(`  [RED] level gate: winner raised to ${raised.toFixed(2)} m -> `
        + `${under} drawn road points within ${NEAR_R} m are now UNDER the water `
        + `(closest ${Number.isFinite(nearest) ? nearest.toFixed(1) : '-'} m) -> `
        + `${under > 0 ? 'REJECTED (gate is live)' : 'ACCEPTED — the level gate is inert'}`);
      if (under === 0) throw new Error(`${id}: RED level test did not go red`);

      // RED 2 — AREA. Drop the plate below the terrain it was sitting over.
      const sunk = best.level - best.deep - 0.5;
      let openN = 0, tot = 0;
      for (let u = -hx; u <= hx; u += FS) {
        for (let v = -hz; v <= hz; v += FS) {
          tot++;
          if (field.heightAt(cx + ax.x * u + bx.x * v, cz + ax.z * u + bx.z * v) <= sunk) openN++;
        }
      }
      console.log(`  [RED] area gate: winner sunk to ${sunk.toFixed(2)} m -> `
        + `${openN}/${tot} footprint samples still open -> `
        + `${openN === 0 ? 'REJECTED (gate is live)' : 'ACCEPTED — the area gate is inert'}\n`);
      if (openN !== 0) throw new Error(`${id}: RED area test did not go red`);
    }
  }
  env.dispose();
}
process.exit(0);
