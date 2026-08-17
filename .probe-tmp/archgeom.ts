/**
 * ============================================================================
 *  WHAT THE OFFENDING PROPS ARE ACTUALLY BUILT OUT OF
 * ============================================================================
 *  `envelope.ts` says the balloon arch's lowest point over the tarmac is at
 *  local (10.96, 3.21) and the portal's is at local (9.52, 4.03, 4.05). Those
 *  are coordinates in a geometry built by arithmetic several layers deep in
 *  `Props.ts`, and reconstructing which primitive owns them by re-deriving the
 *  recipe on paper is exactly the mistake `.probe-tmp/citymeta.ts` documents.
 *
 *  So read the built vertices back instead. For each named prop this prints:
 *    * the geometry's local bounding box (which pins `span` / `R`),
 *    * the distinct primitive clusters along local x, so a balloon or a reveal
 *      stone can be identified by index rather than by guess,
 *    * each anchor's arc, half-width and bank, which is what the recipe reads.
 *
 *  usage: node src/dev/node-run.mjs .probe-tmp/archgeom.ts <ids|all> [--tier=ultra]
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import { TRACK_ORDER } from '@/track/TrackDefs';

const ARGS = process.argv.slice(3);
const ONLY = ARGS.filter((a) => !a.startsWith('--'));
const IDS: readonly string[] = (ONLY.length === 0 || ONLY[0] === 'all') ? TRACK_ORDER : ONLY;
const TIER = (ARGS.find((a) => a.startsWith('--tier=')) ?? '--tier=ultra').slice(7) as
  'low' | 'medium' | 'high' | 'ultra';
const WANT = /balloonArch|tunnelportal|startgantry/;

for (const id of IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS[TIER]);
  await env.init();
  console.log(`\n=== ${id} ===`);

  const roots: THREE.Object3D[] = [];
  scene.traverse((o) => { if (/^Prop:/.test(o.name || '') && WANT.test(o.name)) roots.push(o); });

  for (const root of roots) {
    const mesh = root as THREE.Mesh & { isInstancedMesh?: boolean; count?: number; instanceMatrix?: THREE.InstancedBufferAttribute };
    if (!mesh.isMesh || !mesh.geometry) continue;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    const n = mesh.isInstancedMesh ? (mesh.count ?? 1) : 1;
    console.log(`  ${root.name}   ${n} instance(s)   ${pos.count} verts`);
    console.log(`    local bbox  x ${bb.min.x.toFixed(2)}..${bb.max.x.toFixed(2)}  `
      + `y ${bb.min.y.toFixed(2)}..${bb.max.y.toFixed(2)}  z ${bb.min.z.toFixed(2)}..${bb.max.z.toFixed(2)}`);

    // Cluster vertices into primitives by local x, and for each cluster report
    // the vertical extent. For the arch that is one row per balloon; for the
    // portal it separates the reveal rings from the headwall.
    const byX = new Map<number, { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; n: number }>();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const key = Math.round(x * 2) / 2;                 // 0.5 m buckets
      let c = byX.get(key);
      if (!c) { c = { x0: x, x1: x, y0: y, y1: y, z0: z, z1: z, n: 0 }; byX.set(key, c); }
      c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x);
      c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y);
      c.z0 = Math.min(c.z0, z); c.z1 = Math.max(c.z1, z);
      c.n++;
    }
    const keys = [...byX.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      const c = byX.get(k)!;
      // Only the half of the structure the findings are on, to keep it short.
      if (Math.abs(k) < 8.0 || Math.abs(k) > 16.0) continue;
      console.log(`      x ${c.x0.toFixed(2)}..${c.x1.toFixed(2)}   `
        + `y ${c.y0.toFixed(2)}..${c.y1.toFixed(2)}   z ${c.z0.toFixed(2)}..${c.z1.toFixed(2)}   ${c.n} verts`);
    }

    // Where each instance stands, and what the road is doing there.
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let inst = 0; inst < n; inst++) {
      if (mesh.isInstancedMesh && mesh.instanceMatrix) {
        m.fromArray(mesh.instanceMatrix.array as unknown as number[], inst * 16);
        m.premultiply(mesh.matrixWorld);
      } else m.copy(mesh.matrixWorld);
      p.setFromMatrixPosition(m);
      const g = track.project(p);
      const s = track.sampleAtDistance(g.distance);
      console.log(`      #${inst} anchor @arc ${g.distance.toFixed(0)}  halfWidth ${s.halfWidth.toFixed(2)}  `
        + `binormal.y ${s.binormal.y.toFixed(4)} (bank ${(Math.asin(Math.min(1, Math.abs(s.binormal.y))) * 180 / Math.PI).toFixed(2)} deg)  `
        + `anchor y ${p.y.toFixed(2)} vs centreline y ${s.position.y.toFixed(2)}`);
    }
  }
  env.dispose();
}
