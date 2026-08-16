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
if (!QUALITY_PRESETS[TIER]) throw new Error(`unknown tier ${TIER}`);

/** Mesh names that are a water SURFACE (not the coping or the apron). */
const WATERY = /harbourwater|parklake|waterplate/i;

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
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

  for (const pl of plates) {
    // ---- burial: sample the plate footprint against the baked terrain --------
    const measure = (dy: number): { burial: number; minFree: number; area: number } => {
      const y = pl.centre.y + dy;
      let below = 0, total = 0, minFree = Infinity;
      const STEP = 4;
      for (let x = pl.box.min.x; x <= pl.box.max.x; x += STEP) {
        for (let z = pl.box.min.z; z <= pl.box.max.z; z += STEP) {
          total++;
          const h = field.heightAt(x, z);
          if (h > y) below++;
          else minFree = Math.min(minFree, y - h);
        }
      }
      return {
        burial: total ? below / total : 1,
        minFree: Number.isFinite(minFree) ? minFree : 0,
        area: (total - below) * STEP * STEP,
      };
    };
    const m0 = measure(0);

    // ---- how the road sees it -------------------------------------------------
    let nearest = Infinity, nearestT = 0, arcInSight = 0, samples = 0;
    let freeboard = Infinity;
    for (let d = 0; d < L; d += 4) {
      samples++;
      const s = track.sampleAtDistance(d);
      _p.copy(s.position);
      const dx = Math.max(pl.box.min.x - _p.x, 0, _p.x - pl.box.max.x);
      const dz = Math.max(pl.box.min.z - _p.z, 0, _p.z - pl.box.max.z);
      const dist = Math.hypot(dx, dz);
      if (dist < nearest) { nearest = dist; nearestT = d / L; }
      if (dist < 260) arcInSight++;
      if (dist < 120) freeboard = Math.min(freeboard, s.position.y - pl.centre.y);
    }

    const sx = (pl.box.max.x - pl.box.min.x), sz = (pl.box.max.z - pl.box.min.z);
    console.log(`  ${pl.name}`);
    console.log(`    surface y ${pl.centre.y.toFixed(2)}  span ${sx.toFixed(0)} x ${sz.toFixed(0)} m  `
      + `y range ${pl.box.min.y.toFixed(2)}..${pl.box.max.y.toFixed(2)}  ${pl.tris} tris`);
    console.log(`    material ${pl.mat} rough ${pl.rough.toFixed(2)} metal ${pl.metal.toFixed(2)} `
      + `envInt ${pl.envInt.toFixed(2)} emissiveInt ${pl.emissive.toFixed(2)}  `
      + `vertex-animated: ${pl.animated ? 'YES' : 'NO (static geometry)'}`);
    console.log(`    burial ${(100 * m0.burial).toFixed(1)} % of footprint under terrain; `
      + `${(m0.area).toFixed(0)} m² of open surface; deepest water ${m0.minFree.toFixed(2)} m`);
    console.log(`    road closest approach ${nearest.toFixed(1)} m at t=${nearestT.toFixed(3)}; `
      + `in sight (<260 m) for ${(100 * arcInSight / samples).toFixed(0)} % of the lap; `
      + `freeboard from the road ${Number.isFinite(freeboard) ? `${freeboard.toFixed(2)} m` : 'n/a'}`);

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
