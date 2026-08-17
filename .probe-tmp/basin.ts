/**
 * ============================================================================
 *  BASIN — is the city water READABLE, and does it drown anything?
 * ============================================================================
 *  `.probe-tmp/plate.ts` answers burial and freeboard. Two things it does not
 *  answer, and both decide this job:
 *
 *   1. **DROWNING, STRICTLY.** `plate.ts` counts a road sample as "under water"
 *      when it is below the plate's surface AND within 45 m of the plate's
 *      footprint. 45 m outside a footprint is not under it. On
 *      `hongKongHarbour` that reports 723 drowned road samples where the honest
 *      count — inside the rotated footprint, under the plate's own local
 *      surface height at that point — is what has to be zero. This probe only
 *      counts samples strictly INSIDE the footprint.
 *
 *   2. **READABILITY, AS PIXELS.** The whole complaint is that water 1.3-1.9 m
 *      below a flat road is invisible from the racing line. Area and burial say
 *      nothing about that. So: put the camera where the chase camera goes,
 *      project every open-water cell, MARCH THE RAY against the heightfield to
 *      throw away cells hidden behind the bank, and report the share of an
 *      800 x 450 frame the surviving water covers. That number is comparable
 *      with a screenshot, which is the point.
 *
 *  Also reported, because both are constraints on the fix:
 *   * `field.minHeight` vs `Water.init()`'s gate. `Water` returns before
 *     building anything only while `waterLevel < minHeight - 3`; city circuits
 *     run `waterLevel = -9` (the `city` default for `waterLevel: null`), so
 *     **minHeight must stay above -6.00 m** or the disc, the reflection target
 *     and an extra full-scene pass all switch themselves on.
 *   * SCATTER INTRUSION — instanced props and foliage whose origin lands inside
 *     a water footprint.
 *
 *  RED MODES — every one of these must move the number it targets:
 *    --red=drown    lift every plate 6 m. Burial must collapse. NOTE: on a
 *                   circuit where no road is inside a footprint this does NOT
 *                   move the drowned count — use `overroad` for that.
 *    --red=overroad inflate every footprint by 200 m and lift it 2 m, so it
 *                   swallows the carriageway. The strict drowned count must go
 *                   from 0 to thousands, or the counter is inert.
 *    --red=bury     add 20 m to every terrain sample. Burial must hit 100 %.
 *    --red=expose   subtract 20 m. Burial must hit 0 %.
 *    --red=occlude  raise the terrain between eye and water by 30 m. Visible
 *                   water must go to zero while open area is unchanged.
 *    --red=scatter  test the intrusion counter against a footprint centred on
 *                   the start line instead of on the water.
 *
 *  Run: node src/dev/node-run.mjs .probe-tmp/basin.ts [ids...] [--tier=ultra]
 *                                                     [--red=mode]
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import type { QualityTier } from '@/core/Types';

const ARGS = process.argv.slice(3);
const FLAGS = ARGS.filter((a) => a.startsWith('--'));
const ONLY = ARGS.filter((a) => !a.startsWith('--'));
const IDS = ONLY.length ? ONLY
  : ['bostonHarbor', 'taipeiCircuit', 'tokyoNeon', 'hongKongHarbour', 'newYorkCircuit'];
const TIER = ((FLAGS.find((f) => f.startsWith('--tier=')) ?? '--tier=ultra').slice(7)) as QualityTier;
const RED = (FLAGS.find((f) => f.startsWith('--red=')) ?? '').slice(6);
if (!QUALITY_PRESETS[TIER]) throw new Error(`unknown tier ${TIER}`);

/** Mesh names that are a water SURFACE (not the coping or the apron). */
const WATERY = /harbourwater|parklake:metal|waterplate/i;

/** Frame the readability number is quoted in. Matches the review viewport. */
const FRAME_W = 800, FRAME_H = 450, FRAME_FOV = 60;
/** Chase-camera pose: metres behind the centreline point, metres above it. */
const CHASE_BACK = 8, CHASE_UP = 4;

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up2 = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Matrix4();

const terrBias = RED === 'bury' ? 20 : RED === 'expose' ? -20 : 0;
const plateBias = RED === 'drown' ? 6 : RED === 'overroad' ? 2 : 0;
const footInflate = RED === 'overroad' ? 200 : 0;

console.log(`tier=${TIER}${RED ? `   RED MODE = ${RED}` : ''}\n`);

for (const id of IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS[TIER]);
  await env.init();
  scene.updateMatrixWorld(true);
  const field = env.field;
  const ctx = env.ctx;
  if (!field || !ctx) throw new Error(`${id}: no field`);
  const L = track.lapLength;

  const ground = (x: number, z: number): number => field.heightAt(x, z) + terrBias;

  // ---- the Water.init() gate ------------------------------------------------
  const waterChunks = (env.water as unknown as { chunks?: unknown[] } | null)?.chunks?.length ?? 0;
  const gateOff = ctx.waterLevel < field.minHeight - 3;
  let calls = 0, tris = 0;
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!mesh.isMesh) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const idx = g.getIndex();
    const per = (idx ? idx.count : (g.getAttribute('position')?.count ?? 0)) / 3;
    const n = mesh.isInstancedMesh ? (mesh.count ?? 0) : 1;
    if (n > 0) { calls++; tris += per * n; }
  });

  console.log(`=== ${id} ===  env ${calls} calls / ${(tris / 1e6).toFixed(3)} M tris`);
  console.log(`  field height ${field.minHeight.toFixed(2)} .. ${field.maxHeight.toFixed(2)} m`
    + `   waterLevel ${ctx.waterLevel}`
    + `   Water.init gate: ${gateOff ? 'OFF (0 sectors)' : '*** ON — DISC + REFLECTION BUILT ***'}`
    + `   water meshes ${waterChunks}`
    + `   headroom to gate: minHeight may fall to ${(ctx.waterLevel + 3).toFixed(2)} m`);

  // ---- collect plates in their own frame -----------------------------------
  interface Plate {
    name: string; world: THREE.Matrix4; inv: THREE.Matrix4;
    local: THREE.Box3; scl: THREE.Vector3; surfY: number;
  }
  const plates: Plate[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!mesh.isMesh || !WATERY.test(mesh.name)) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const im = mesh as unknown as THREE.InstancedMesh;
    const count = mesh.isInstancedMesh ? (mesh.count ?? 0) : 1;
    for (let i = 0; i < count; i++) {
      if (mesh.isInstancedMesh) im.getMatrixAt(i, _m); else _m.identity();
      if (mesh.isInstancedMesh && _m.equals(IDENTITY)) continue;
      const world = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, _m);
      const lb = new THREE.Box3().setFromBufferAttribute(
        g.getAttribute('position') as THREE.BufferAttribute,
      );
      if (footInflate) { lb.min.x -= footInflate; lb.max.x += footInflate; lb.min.z -= footInflate; lb.max.z += footInflate; }
      plates.push({
        name: `${mesh.name}#${i}`,
        world,
        inv: new THREE.Matrix4().copy(world).invert(),
        local: lb,
        scl: new THREE.Vector3().setFromMatrixScale(world),
        surfY: new THREE.Vector3().setFromMatrixPosition(world).y + plateBias,
      });
    }
  });
  if (!plates.length) { console.log('  (no water-surface prop on this circuit)\n'); env.dispose(); continue; }

  /** Horizontal gap from a world point to a plate's own ROTATED footprint. */
  const gapTo = (pl: Plate, w: THREE.Vector3): number => {
    _v.copy(w).applyMatrix4(pl.inv);
    const du = Math.max(pl.local.min.x - _v.x, 0, _v.x - pl.local.max.x) * pl.scl.x;
    const dv = Math.max(pl.local.min.z - _v.z, 0, _v.z - pl.local.max.z) * pl.scl.z;
    return Math.hypot(du, dv);
  };

  // =========================================================================
  //  1. DROWNING — strictly inside the footprint
  // =========================================================================
  // Walk the DRAWN road surface with the ground raycast (the same surface the
  // kart drives on, including kerb and shoulder), and only count a sample when
  // it is inside a plate's rotated footprint AND below that plate's surface.
  let drowned = 0, worstDrown = 0, worstAt = '';
  let roadSamples = 0;
  let minClear = Infinity, minClearAt = '';
  for (let d = 0; d < L; d += 2) {
    const s = track.sampleAtDistance(d);
    for (let lat = -26; lat <= 26; lat += 0.5) {
      _p.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, 40);
      const hit = track.raycastGround(_p, _up2, 90);
      if (!hit.hit) continue;
      roadSamples++;
      for (const pl of plates) {
        if (gapTo(pl, hit.point) > 0) continue;
        const clear = hit.point.y - pl.surfY;
        if (clear < minClear) {
          minClear = clear;
          minClearAt = `t=${(d / L).toFixed(3)} lat ${lat.toFixed(1)}`;
        }
        if (clear < 0) {
          drowned++;
          if (-clear > worstDrown) {
            worstDrown = -clear;
            worstAt = `t=${(d / L).toFixed(3)} lat ${lat.toFixed(1)} road y ${hit.point.y.toFixed(2)} vs plate ${pl.surfY.toFixed(2)}`;
          }
        }
      }
    }
  }
  console.log(`  ROAD: ${roadSamples} drawn-surface samples; ${drowned} strictly inside a water`
    + ` footprint and below its surface${drowned ? ` — WORST ${worstDrown.toFixed(2)} m (${worstAt})` : ''}`);
  if (Number.isFinite(minClear)) {
    console.log(`        closest road-over-water clearance ${minClear.toFixed(2)} m at ${minClearAt}`);
  } else {
    console.log('        no drawn road surface overlaps any water footprint');
  }

  // =========================================================================
  //  2. OPEN WATER + READABILITY
  // =========================================================================
  for (const pl of plates) {
    const sx = pl.local.max.x - pl.local.min.x, sz = pl.local.max.z - pl.local.min.z;
    const wx = sx * pl.scl.x, wz = sz * pl.scl.z;
    const STEP = 2.5;
    const NX = Math.max(2, Math.round(wx / STEP) + 1);
    const NZ = Math.max(2, Math.round(wz / STEP) + 1);
    const cellA = (wx / (NX - 1)) * (wz / (NZ - 1));
    const open: THREE.Vector3[] = [];
    let below = 0, total = 0, deepest = 0;
    const grid = new Uint8Array(NX * NZ);
    for (let ix = 0; ix < NX; ix++) {
      for (let iz = 0; iz < NZ; iz++) {
        total++;
        _v.set(pl.local.min.x + (ix / (NX - 1)) * sx, 0, pl.local.min.z + (iz / (NZ - 1)) * sz)
          .applyMatrix4(pl.world);
        const h = ground(_v.x, _v.z);
        if (h > pl.surfY) { below++; continue; }
        grid[ix * NZ + iz] = 1;
        deepest = Math.max(deepest, pl.surfY - h);
        open.push(new THREE.Vector3(_v.x, pl.surfY, _v.z));
      }
    }
    // largest connected component
    let body = 0;
    const seen = new Uint8Array(NX * NZ);
    const stack: number[] = [];
    for (let i = 0; i < NX * NZ; i++) {
      if (!grid[i] || seen[i]) continue;
      let n = 0; stack.length = 0; stack.push(i); seen[i] = 1;
      while (stack.length) {
        const c = stack.pop() as number; n++;
        const ix = (c / NZ) | 0, iz = c % NZ;
        if (ix > 0 && grid[c - NZ] && !seen[c - NZ]) { seen[c - NZ] = 1; stack.push(c - NZ); }
        if (ix < NX - 1 && grid[c + NZ] && !seen[c + NZ]) { seen[c + NZ] = 1; stack.push(c + NZ); }
        if (iz > 0 && grid[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
        if (iz < NZ - 1 && grid[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      }
      if (n > body) body = n;
    }

    // ---- BANK: how high does land stand above the water just outside it? ----
    // Sampled on a ring 12 m and 40 m beyond the footprint, all round.
    let bank12 = 0, bank40 = 0, bankN = 0;
    for (let a = 0; a < 64; a++) {
      const th = (a / 64) * Math.PI * 2;
      const dirx = Math.cos(th), dirz = Math.sin(th);
      // walk out from the plate centre until outside the footprint, then sample
      const c = new THREE.Vector3().setFromMatrixPosition(pl.world);
      let r = 1;
      while (r < 400 && gapTo(pl, _p.set(c.x + dirx * r, 0, c.z + dirz * r)) <= 0) r += 2;
      if (r >= 400) continue;
      bankN++;
      bank12 += Math.max(0, ground(c.x + dirx * (r + 12), c.z + dirz * (r + 12)) - pl.surfY);
      bank40 += Math.max(0, ground(c.x + dirx * (r + 40), c.z + dirz * (r + 40)) - pl.surfY);
    }

    // ---- READABILITY -------------------------------------------------------
    // Chase camera every 8 m of lap. For each pose: project every open cell,
    // ray-march the heightfield between eye and cell, and sum the projected
    // area of the survivors as a share of an 800x450 frame.
    const aspect = FRAME_W / FRAME_H;
    const tanV = Math.tan((FRAME_FOV * Math.PI / 180) / 2);
    const tanH = tanV * aspect;
    // pixels per steradian-ish: a cell of world area A at distance D facing the
    // camera covers A*cos/D^2 of solid angle; the frame covers 4*tanH*tanV of
    // the unit image plane. Work in image-plane units and convert to pixels.
    const framePlane = (2 * tanH) * (2 * tanV);
    let bestPct = 0, bestT = 0, arcVisible = 0, poses = 0;
    const eye = new THREE.Vector3(), fwd = new THREE.Vector3(), rgt = new THREE.Vector3(), upv = new THREE.Vector3();
    const rel = new THREE.Vector3();
    const occBias = RED === 'occlude' ? 30 : 0;
    for (let d = 0; d < L; d += 8) {
      poses++;
      const s = track.sampleAtDistance(d);
      eye.copy(s.position).addScaledVector(s.normal, CHASE_UP).addScaledVector(s.tangent, -CHASE_BACK);
      const s2 = track.sampleAtDistance((d + 45) % L);
      fwd.copy(s2.position).addScaledVector(s2.normal, 1).sub(eye).normalize();
      rgt.crossVectors(fwd, _up2).normalize();
      upv.crossVectors(rgt, fwd).normalize();
      let planeArea = 0;
      for (const w of open) {
        rel.copy(w).sub(eye);
        const zc = rel.dot(fwd);
        if (zc < 1) continue;
        const xc = rel.dot(rgt) / zc, yc = rel.dot(upv) / zc;
        if (Math.abs(xc) > tanH || Math.abs(yc) > tanV) continue;
        // occlusion: march the segment eye->w against the heightfield
        const dist = rel.length();
        let hidden = false;
        const steps = Math.max(4, Math.min(120, Math.round(dist / 4)));
        for (let k = 1; k < steps; k++) {
          const f = k / steps;
          const px = eye.x + (w.x - eye.x) * f;
          const pz = eye.z + (w.z - eye.z) * f;
          const py = eye.y + (w.y - eye.y) * f;
          if (ground(px, pz) + occBias > py) { hidden = true; break; }
        }
        if (hidden) continue;
        // projected area on the image plane: cell is horizontal, so the
        // foreshortening factor is |cos| between the view ray and world up.
        const cosT = Math.abs(rel.y) / dist;
        planeArea += (cellA * cosT) / (zc * zc);
      }
      const pct = 100 * planeArea / framePlane;
      if (pct > bestPct) { bestPct = pct; bestT = d / L; }
      if (pct >= 1.0) arcVisible++;
    }

    console.log(`  ${pl.name}  ${wx.toFixed(0)} x ${wz.toFixed(0)} m  surface y ${pl.surfY.toFixed(2)}`);
    console.log(`    open ${(total - below) * cellA | 0} m² (${(100 * (1 - below / total)).toFixed(1)} %`
      + ` of footprint), largest body ${(body * cellA) | 0} m², deepest ${deepest.toFixed(2)} m`);
    console.log(`    bank above water: +${(bank12 / Math.max(1, bankN)).toFixed(2)} m at 12 m out,`
      + ` +${(bank40 / Math.max(1, bankN)).toFixed(2)} m at 40 m out (${bankN} bearings)`);
    console.log(`    READABLE: best ${bestPct.toFixed(2)} % of an 800x450 frame at t=${bestT.toFixed(3)};`
      + ` >=1 % of frame for ${(100 * arcVisible / poses).toFixed(0)} % of the lap`);
  }

  // =========================================================================
  //  3. SCATTER INTRUSION
  // =========================================================================
  // Instanced-mesh origins inside a water footprint. `--red=scatter` moves the
  // footprints to the start line so the counter has to find something.
  const foots = RED === 'scatter'
    ? [(() => {
      const s = track.sampleAtDistance(0);
      const w = new THREE.Matrix4().makeTranslation(s.position.x, s.position.y, s.position.z);
      return {
        name: 'RED start-line box', world: w, inv: w.clone().invert(),
        local: new THREE.Box3(new THREE.Vector3(-80, 0, -80), new THREE.Vector3(80, 0, 80)),
        scl: new THREE.Vector3(1, 1, 1), surfY: s.position.y + 30,
      } as Plate;
    })()]
    : plates;
  // AUTHORED WATER DRESSING IS NOT AN INTRUDER, and conflating the two is how a
  // number like "125 instances in Victoria Harbour" hides what matters. A junk,
  // a sloop, a channel buoy and the foot of a quay wall are all SUPPOSED to be
  // in the water; a tower, a tree, a bush or a spectator is not. The owner's
  // requirement is about procedural scatter, so the two are counted separately
  // and the dressing list is printed so it can still be eyeballed.
  const DRESSING = /junk|sailboat|buoy|seawall|parklake$|parklake:/i;
  const intruders = new Map<string, number>();
  const dressing = new Map<string, number>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!mesh.isInstancedMesh || !mesh.count) return;
    if (WATERY.test(mesh.name)) return;
    const im = mesh as unknown as THREE.InstancedMesh;
    for (let i = 0; i < mesh.count; i++) {
      im.getMatrixAt(i, _m);
      if (_m.equals(IDENTITY)) continue;
      _p.setFromMatrixPosition(_m).applyMatrix4(mesh.matrixWorld);
      for (const pl of foots) {
        if (gapTo(pl, _p) > 0) continue;
        // Only count it if it stands where the water is, i.e. the GROUND under
        // it is at or below the surface. A prop on a bank inside the AABB but
        // above the waterline is on dry land.
        if (ground(_p.x, _p.z) > pl.surfY + 0.5) continue;
        const bin = DRESSING.test(mesh.name) ? dressing : intruders;
        bin.set(mesh.name, (bin.get(mesh.name) ?? 0) + 1);
        break;
      }
    }
  });
  const total = [...intruders.values()].reduce((a, b) => a + b, 0);
  const totalD = [...dressing.values()].reduce((a, b) => a + b, 0);
  console.log(`  SCATTER IN THE WATER: ${total} instances`
    + (total ? `\n        ${[...intruders.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join('\n        ')}` : ''));
  console.log(`  authored water dressing (expected): ${totalD} instances`
    + (totalD ? ` — ${[...dressing.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace(/^Prop:authored:/, '')} x${v}`).join(', ')}` : ''));
  console.log('');
  env.dispose();
}
