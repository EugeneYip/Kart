/**
 * ============================================================================
 *  PLATE — is the prop-based water actually water, and is any of it visible?
 * ============================================================================
 *  The critic's finding was "`WaterDisc` is 0 meshes on the five city circuits,
 *  so there is no water anywhere in the City Series". Counting `WaterDisc` is
 *  not the same question: `hongKongHarbour` and `newYorkCircuit` both author a
 *  `harbourWater` PROP, and `newYorkCircuit` a `parkLake` as well. A probe that
 *  only knows about `Water` cannot see them.
 *
 *  So measure the props instead, on the BUILT world at the shipping tier:
 *
 *   * world AABB of every water-surface instance, and its surface Y;
 *   * BURIAL — the fraction of the plate's footprint where the baked terrain is
 *     ABOVE the plate. A buried plate is exactly as invisible as no plate;
 *   * FREEBOARD — how far the plate's surface sits below the nearest drivable
 *     road surface, i.e. whether it reads as water you look down at;
 *   * SIGHTLINE — the closest approach of the road to the plate, and the arc of
 *     the lap from which some part of it is within 260 m;
 *   * COST — draw calls and triangles it contributes.
 *
 *  RED TEST (`--red`): re-run burial against a plate pushed 12 m underground.
 *  If the burial number does not go to 100 %, the burial test is inert.
 *
 *  Run: node src/dev/node-run.mjs .probe-tmp/plate.ts [ids...] [--tier=ultra] [--red]
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
const TIER = ((FLAGS.find((f) => f.startsWith('--tier=')) ?? '--tier=ultra').slice(7)) as QualityTier;
const RED = FLAGS.includes('--red');
/** `--sweep=lo,hi,step`: re-measure this plate at a range of vertical offsets. */
const SWEEP = (FLAGS.find((f) => f.startsWith('--sweep=')) ?? '').slice(8);
if (!QUALITY_PRESETS[TIER]) throw new Error(`unknown tier ${TIER}`);

/** Mesh names that are a water SURFACE (not the coping or the apron). */
const WATERY = /harbourwater|parklake|waterplate/i;

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up2 = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Matrix4();

console.log(`tier=${TIER}\n`);

for (const id of IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS[TIER]);
  await env.init();
  scene.updateMatrixWorld(true);
  const field = env.field;
  if (!field) throw new Error(`${id}: no field`);
  const L = track.lapLength;

  interface Plate {
    name: string; centre: THREE.Vector3; box: THREE.Box3; tris: number;
    world: THREE.Matrix4; local: THREE.Box3;
    mat: string; rough: number; metal: number; envInt: number; emissive: number;
    animated: boolean;
  }
  const plates: Plate[] = [];
  let allCalls = 0, allTris = 0;

  scene.traverse((o) => {
    const mesh = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!mesh.isMesh) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const idx = g.getIndex();
    const per = (idx ? idx.count : (g.getAttribute('position')?.count ?? 0)) / 3;
    const n = mesh.isInstancedMesh ? (mesh.count ?? 0) : 1;
    if (n > 0) { allCalls++; allTris += per * n; }
    if (!WATERY.test(mesh.name)) return;

    const mat = mesh.material as THREE.MeshStandardMaterial;
    // `aFlap` is the props system's only vertex-animation channel; a surface with
    // no non-zero aFlap cannot move, whatever its material does.
    const flapAttr = g.getAttribute('aFlap');
    let animated = false;
    if (flapAttr) for (let i = 0; i < flapAttr.count; i++) if (flapAttr.getX(i) !== 0) { animated = true; break; }

    const im = mesh as unknown as THREE.InstancedMesh;
    const count = mesh.isInstancedMesh ? (mesh.count ?? 0) : 1;
    for (let i = 0; i < count; i++) {
      if (mesh.isInstancedMesh) im.getMatrixAt(i, _m); else _m.identity();
      if (mesh.isInstancedMesh && _m.equals(IDENTITY)) continue;
      const world = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, _m);
      const box = new THREE.Box3().setFromBufferAttribute(
        g.getAttribute('position') as THREE.BufferAttribute,
      ).applyMatrix4(world);
      plates.push({
        name: `${mesh.name}#${i}`,
        centre: new THREE.Vector3().setFromMatrixPosition(world),
        box,
        world,
        local: new THREE.Box3().setFromBufferAttribute(
          g.getAttribute('position') as THREE.BufferAttribute,
        ),
        tris: per,
        mat: mat?.type ?? '?',
        rough: mat?.roughness ?? -1,
        metal: mat?.metalness ?? -1,
        envInt: mat?.envMapIntensity ?? -1,
        emissive: mat?.emissiveIntensity ?? -1,
        animated,
      });
    }
  });

  console.log(`=== ${id} ===  env ${allCalls} calls / ${(allTris / 1e6).toFixed(3)} M tris`
    + `   water-surface props: ${plates.length}`);
  if (!plates.length) { console.log('  (no water-surface prop on this circuit)\n'); env.dispose(); continue; }

  // Every drawn road point, once: the sweep needs them per level.
  const roadPts: THREE.Vector3[] = [];
  for (let d = 0; d < L; d += 4) {
    const s2 = track.sampleAtDistance(d);
    for (let lat = -34; lat <= 34; lat += 2) {
      _p.copy(s2.position).addScaledVector(s2.binormal, lat).addScaledVector(s2.normal, 40);
      const hit = track.raycastGround(_p, _up2, 90);
      if (hit.hit) roadPts.push(hit.point.clone());
    }
  }

  for (const pl of plates) {
    // ---- burial: sample the plate footprint against the baked terrain --------
    // ITERATE THE PLATE, NOT ITS AABB. The first revision walked the world-space
    // bounding box, and every one of these plates is yawed to the road: an 84 x
    // 180 m rectangle at 45 degrees has a 187 x 187 m AABB, so more than half of
    // what was being sampled was not the plate at all. It over-reported Boston's
    // open water by 4 %, Taipei's by 66 % and Taipei's greatest depth by 3x
    // (4.59 m against a real 1.44), and it inflated New York's ORIGINAL burial
    // figure the same way. Local space, through the instance matrix, is the only
    // sampling that answers the question asked.
    //
    // `deepest` is a MAX, and the first revision took a min and printed it as
    // "deepest water". A minimum clearance over a plate that meets the ground at
    // its own shoreline is 0.00 m by definition, on every plate, which is exactly
    // what it reported three times.
    //
    // `body` is the largest CONNECTED open component: a plate showing 4000 m2 as
    // one lagoon and one showing it as forty puddles are not the same object.
    const STEP = 4;
    const sx = pl.local.max.x - pl.local.min.x, sz = pl.local.max.z - pl.local.min.z;
    const scl = new THREE.Vector3().setFromMatrixScale(pl.world);
    const NX = Math.max(2, Math.round((sx * scl.x) / STEP) + 1);
    const NZ = Math.max(2, Math.round((sz * scl.z) / STEP) + 1);
    const cellA = ((sx * scl.x) / (NX - 1)) * ((sz * scl.z) / (NZ - 1));
    const _w = new THREE.Vector3();
    const measure = (dy: number): { burial: number; deepest: number; area: number; body: number } => {
      const y = pl.centre.y + dy;
      const open = new Uint8Array(NX * NZ);
      let below = 0, total = 0, deepest = 0;
      for (let ix = 0; ix < NX; ix++) {
        for (let iz = 0; iz < NZ; iz++) {
          total++;
          _w.set(
            pl.local.min.x + (ix / (NX - 1)) * sx, 0,
            pl.local.min.z + (iz / (NZ - 1)) * sz,
          ).applyMatrix4(pl.world);
          const h = field.heightAt(_w.x, _w.z);
          if (h > y) { below++; continue; }
          open[ix * NZ + iz] = 1;
          deepest = Math.max(deepest, y - h);
        }
      }
      let body = 0;
      const seen = new Uint8Array(NX * NZ);
      const stack: number[] = [];
      for (let i = 0; i < NX * NZ; i++) {
        if (!open[i] || seen[i]) continue;
        let n = 0; stack.length = 0; stack.push(i); seen[i] = 1;
        while (stack.length) {
          const c = stack.pop() as number; n++;
          const ix = (c / NZ) | 0, iz = c % NZ;
          if (ix > 0 && open[c - NZ] && !seen[c - NZ]) { seen[c - NZ] = 1; stack.push(c - NZ); }
          if (ix < NX - 1 && open[c + NZ] && !seen[c + NZ]) { seen[c + NZ] = 1; stack.push(c + NZ); }
          if (iz > 0 && open[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
          if (iz < NZ - 1 && open[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
        }
        if (n > body) body = n;
      }
      return {
        burial: total ? below / total : 1,
        deepest,
        area: (total - below) * cellA,
        body: body * cellA,
      };
    };
    const m0 = measure(0);

    /** Horizontal gap from a world point to the plate's own rotated footprint. */
    const _inv = new THREE.Matrix4().copy(pl.world).invert();
    const _lp = new THREE.Vector3();
    const gapToPlate = (w: THREE.Vector3): number => {
      _lp.copy(w).applyMatrix4(_inv);
      const du = Math.max(pl.local.min.x - _lp.x, 0, _lp.x - pl.local.max.x) * scl.x;
      const dv = Math.max(pl.local.min.z - _lp.z, 0, _lp.z - pl.local.max.z) * scl.z;
      return Math.hypot(du, dv);
    };

    // ---- how the road sees it -------------------------------------------------
    // FREEBOARD is measured against the DRAWN road surface, not the centreline.
    // The centreline is up to 1.75 m above its own banked shoulder edge and it is
    // the shoulder that would look flooded.
    let nearest = Infinity, nearestT = 0, arcInSight = 0, samples = 0;
    let freeboard = Infinity, freeNear = Infinity, drowned = 0;
    for (let d = 0; d < L; d += 4) {
      samples++;
      const s = track.sampleAtDistance(d);
      _p.copy(s.position);
      const dist = gapToPlate(_p);
      if (dist < nearest) { nearest = dist; nearestT = d / L; }
      if (dist < 260) arcInSight++;
      for (let lat = -34; lat <= 34; lat += 2) {
        _p.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, 40);
        const hit = track.raycastGround(_p, _up2, 90);
        if (!hit.hit) continue;
        const gap = gapToPlate(hit.point);
        if (gap > 140) continue;
        const f = hit.point.y - pl.centre.y;
        if (f < freeboard) freeboard = f;
        if (gap <= 45) {
          if (f < freeNear) freeNear = f;
          if (f < 0) drowned++;
        }
      }
    }

    console.log(`  ${pl.name}`);
    console.log(`    surface y ${pl.centre.y.toFixed(2)}  plate ${(sx * scl.x).toFixed(0)} x ${(sz * scl.z).toFixed(0)} m  `
      + `y range ${pl.box.min.y.toFixed(2)}..${pl.box.max.y.toFixed(2)}  ${pl.tris} tris`);
    console.log(`    material ${pl.mat} rough ${pl.rough.toFixed(2)} metal ${pl.metal.toFixed(2)} `
      + `envInt ${pl.envInt.toFixed(2)} emissiveInt ${pl.emissive.toFixed(2)}  `
      + `vertex-animated: ${pl.animated ? 'YES' : 'NO (static geometry)'}`);
    console.log(`    burial ${(100 * m0.burial).toFixed(1)} % of footprint under terrain; `
      + `${(m0.area).toFixed(0)} m² open, largest body ${m0.body.toFixed(0)} m²; `
      + `deepest ${m0.deepest.toFixed(2)} m`);
    console.log(`    road closest approach ${nearest.toFixed(1)} m at t=${nearestT.toFixed(3)}; `
      + `in sight (<260 m) for ${(100 * arcInSight / samples).toFixed(0)} % of the lap`);
    console.log(`    freeboard vs the DRAWN road: ${Number.isFinite(freeNear) ? `${freeNear.toFixed(2)} m` : 'n/a'} `
      + `within 45 m (${drowned} road samples under water), `
      + `${Number.isFinite(freeboard) ? `${freeboard.toFixed(2)} m` : 'n/a'} within 140 m`);

    if (SWEEP) {
      // What the plate would do at other levels, without a rebuild. `up` in
      // `CityDefs.ts` moves the surface one-for-one, so `dy` here IS the change
      // to `up`, and `drowned` is the count of DRAWN road samples within 45 m
      // that end up under the water — the number that has to reach 0.
      const [lo, hi, st] = SWEEP.split(',').map(Number);
      console.log('    sweep:   d(up)   level   open body    burial   drowned road samples (<45 m)');
      for (let dy = lo; dy <= hi + 1e-9; dy += st) {
        const m = measure(dy);
        // COUNT alone is misleading: 723 road samples 5 cm under the surface and
        // 723 samples 4 m under it are the same number and not the same defect.
        // Report the worst magnitude beside it.
        let dr = 0, worst = 0;
        for (const r of roadPts) {
          if (gapToPlate(r) > 45) continue;
          const under = (pl.centre.y + dy) - r.y;
          if (under > 0) { dr++; worst = Math.max(worst, under); }
        }
        console.log(`           ${dy.toFixed(2).padStart(6)}  ${(pl.centre.y + dy).toFixed(2).padStart(6)}  `
          + `${m.body.toFixed(0).padStart(8)} m²  ${(100 * m.burial).toFixed(1).padStart(6)} %   `
          + `${String(dr).padStart(4)}, worst ${worst.toFixed(2)} m`);
      }
    }

    if (RED) {
      const mred = measure(-12);
      const ok = mred.burial > 0.99;
      console.log(`    [RED] same plate pushed 12 m down: burial ${(100 * mred.burial).toFixed(1)} % `
        + `-> ${ok ? 'BURIED (check is live)' : 'STILL EXPOSED — burial test is inert'}`);
      if (!ok) throw new Error(`${id}/${pl.name}: RED burial test did not go red`);
    }
  }
  console.log('');
  env.dispose();
}
process.exit(0);
