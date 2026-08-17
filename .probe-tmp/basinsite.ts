/**
 * ============================================================================
 *  BASIN SITE — what surface height can a basin have here without drowning?
 * ============================================================================
 *  For a candidate basin authored as (t, lat, halfAlong, halfAcross) in the
 *  ROAD FRAME at `t` — which is exactly how the plate prop is posed — report:
 *
 *   * the resolved world rectangle;
 *   * the LOWEST DRAWN ROAD SURFACE anywhere inside that rectangle, and inside
 *     a 40 m ring around it. That is the number the water surface has to stay
 *     under. It is taken from `track.raycastGround`, i.e. the mesh the kart
 *     drives on, at 0.5 m lateral resolution — not from the centreline, which
 *     on a banked corner sits up to 1.8 m above its own outer shoulder;
 *   * natural ground across the whole lat sweep, so the far bank can be seen;
 *   * how much of the rectangle the CURRENT terrain already holds above a
 *     candidate surface.
 *
 *  RED (`--red`): shift the candidate rectangle 400 m sideways, where there is
 *  no road at all. "lowest road inside" must go from a number to `none`.
 *
 *  usage: node src/dev/node-run.mjs .probe-tmp/basinsite.ts <trackId>
 *             <t>:<lat>:<halfAlong>:<halfAcross>[:<surface>] ...  [--red]
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';

const ARGS = process.argv.slice(3);
const RED = ARGS.includes('--red');
const id = ARGS[0];
const specs = ARGS.slice(1).filter((a) => !a.startsWith('--'));

const track = await loadTrack(id);
const scene = new THREE.Scene();
const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS.ultra);
await env.init();
const field = env.field!;
const L = track.lapLength;
const _up = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();

console.log(`${id}: lap ${L.toFixed(0)} m   field ${field.minHeight.toFixed(2)} .. ${field.maxHeight.toFixed(2)}`);

for (const spec of specs) {
  const [ts, lats, has, hcs, surfs] = spec.split(':').map(Number);
  const smp = track.sampleAtDistance(ts * L);
  // CLONE IT. `sampleAtDistance` hands back a REUSED sample object, so
  // `smp.position` is a live reference that the 50 000-sample road scan below
  // overwrites. The first revision of this probe kept the reference and did its
  // lat sweep afterwards, which sampled the ground beside whatever station the
  // scan happened to finish on: it reported Boston's ground at the basin centre
  // as +7.10 m while the along-axis sweep, which uses the coordinates captured
  // here, correctly read the carved floor at -3.70 m in the same run. Two
  // numbers for one point is the only reason it was caught.
  const p0 = smp.position.clone();
  const roadYatT = p0.y;
  // Horizontal road frame at t: tangent along, binormal across.
  const tx = smp.tangent.x, tz = smp.tangent.z;
  const tl = Math.hypot(tx, tz) || 1;
  const ux = tx / tl, uz = tz / tl;          // along
  const vx = -uz, vz = ux;                    // across, +v = driver's right
  const cx = p0.x + vx * (RED ? lats + 400 : lats);
  const cz = p0.z + vz * (RED ? lats + 400 : lats);

  // inside test in the rectangle's own frame
  const inside = (x: number, z: number, padA = 0, padC = 0): boolean => {
    const dx = x - cx, dz = z - cz;
    return Math.abs(dx * ux + dz * uz) <= has + padA && Math.abs(dx * vx + dz * vz) <= hcs + padC;
  };

  let loIn = Infinity, loInAt = '', loRing = Infinity, loRingAt = '';
  let nIn = 0, nRing = 0;
  for (let d = 0; d < L; d += 2) {
    const s = track.sampleAtDistance(d);
    for (let lat = -26; lat <= 26; lat += 0.5) {
      _p.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, 40);
      const hit = track.raycastGround(_p, _up, 90);
      if (!hit.hit) continue;
      if (inside(hit.point.x, hit.point.z)) {
        nIn++;
        if (hit.point.y < loIn) { loIn = hit.point.y; loInAt = `t=${(d / L).toFixed(3)} lat ${lat}`; }
      } else if (inside(hit.point.x, hit.point.z, 40, 40)) {
        nRing++;
        if (hit.point.y < loRing) { loRing = hit.point.y; loRingAt = `t=${(d / L).toFixed(3)} lat ${lat}`; }
      }
    }
  }

  console.log(`\n  t=${ts} lat=${lats} half ${has} x ${hcs} m   centre (${cx.toFixed(1)}, ${cz.toFixed(1)})`
    + `   road y at t = ${roadYatT.toFixed(2)}`);
  console.log(`    drawn road INSIDE the rectangle : ${nIn} samples`
    + (nIn ? `, lowest ${loIn.toFixed(2)} m (${loInAt})` : ' — none'));
  console.log(`    drawn road in the 40 m RING     : ${nRing} samples`
    + (nRing ? `, lowest ${loRing.toFixed(2)} m (${loRingAt})` : ' — none'));

  // natural ground across lat, along the rectangle's centre line
  const sweep: string[] = [];
  const sgn = lats < 0 ? -1 : 1;   // sweep the side the basin is actually on
  for (const l of [0, 20, 30, 40, 60, 80, 100, 120, 150, 180, 220, 280, 340]) {
    const x = p0.x + vx * l * sgn, z = p0.z + vz * l * sgn;
    sweep.push(`${l * sgn}:${field.heightAt(x, z).toFixed(2)}`);
  }
  console.log(`    baked ground across lat (at t)  : ${sweep.join('  ')}`);

  // ends of the rectangle, along the road
  const ends: string[] = [];
  for (const a of [-has, -has / 2, 0, has / 2, has]) {
    const x = cx + ux * a, z = cz + uz * a;
    ends.push(`${a.toFixed(0)}:${field.heightAt(x, z).toFixed(2)}`);
  }
  console.log(`    baked ground along the axis     : ${ends.join('  ')}`);

  if (Number.isFinite(surfs)) {
    // WHERE THE WATER'S EDGE ACTUALLY LANDS, at 1 m resolution along the
    // rectangle's own across-axis at three stations along it. This is what
    // authored shore dressing — quay walls, moored hulls, buoys — has to be
    // placed against, and it is NOT the basin rim: inside about 50 m of the
    // centreline the road blend dominates the carve and lifts the ground back
    // toward the carriageway, so the waterline sits well outboard of the rim.
    for (const a of [-has * 0.6, 0, has * 0.6]) {
      let first = NaN, last = NaN;
      // walk out from the centreline on the basin's own side
      for (let l = 0; l <= 400; l++) {
        const x = p0.x + vx * l * sgn + ux * a, z = p0.z + vz * l * sgn + uz * a;
        if (field.heightAt(x, z) <= surfs) { if (Number.isNaN(first)) first = l * sgn; last = l * sgn; }
      }
      console.log(`    waterline at along ${a.toFixed(0).padStart(5)} m : `
        + (Number.isNaN(first) ? 'DRY — no ground below the surface on this line'
          : `lat ${first} .. ${last}  (${Math.abs(last - first)} m of water)`));
    }
    let above = 0, tot = 0;
    for (let a = -has; a <= has; a += 5) {
      for (let c = -hcs; c <= hcs; c += 5) {
        const x = cx + ux * a + vx * c, z = cz + uz * a + vz * c;
        tot++;
        if (field.heightAt(x, z) > surfs) above++;
      }
    }
    console.log(`    at surface ${surfs}: ${(100 * above / tot).toFixed(1)} % of the rectangle is`
      + ` currently ABOVE it (would need carving)`);
  }
}
env.dispose();
