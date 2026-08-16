/**
 * ============================================================================
 *  SHOREPROFILE — the ground beside a named stretch of road, metre by metre
 * ============================================================================
 *  `basinfit.ts` rejected all 35 200 candidate 300 x 140 m plates on Boston and
 *  a bulk rejection count says nothing about why. This prints the raw section:
 *  the drawn road surface at a lap position, then the terrain height every few
 *  metres out to lat +-260 on both sides, so the available hollow (if any) can
 *  be read off directly rather than inferred from a fitter's verdict.
 *
 *  Run: node src/dev/node-run.mjs .probe-tmp/shoreprofile.ts <id> t0[,t1,...]
 *       [--tier=ultra] [--lat=260]
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import type { QualityTier } from '@/core/Types';

const ARGS = process.argv.slice(3);
const FLAGS = ARGS.filter((a) => a.startsWith('--'));
const POS = ARGS.filter((a) => !a.startsWith('--'));
const val = (n: string, d: string): string => (FLAGS.find((f) => f.startsWith(`--${n}=`)) ?? `--${n}=${d}`).slice(n.length + 3);
const TIER = val('tier', 'ultra') as QualityTier;
const MAXLAT = Number(val('lat', '260'));
const id = POS[0];
const TS = (POS[1] ?? '0.5').split(',').map(Number);

const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

const track = await loadTrack(id);
const scene = new THREE.Scene();
const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS[TIER]);
await env.init();
const field = env.field;
if (!field) throw new Error('no field');

for (const t of TS) {
  const s = track.sampleAt(t);
  const ax = new THREE.Vector3(s.tangent.x, 0, s.tangent.z).normalize();
  const bx = new THREE.Vector3(s.binormal.x, 0, s.binormal.z).normalize();
  // Drawn road surface across the corridor here.
  let edgeL = 0, edgeR = 0, roadLo = Infinity;
  for (let lat = -40; lat <= 40; lat += 0.5) {
    _p.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, 40);
    const hit = track.raycastGround(_p, _up, 90);
    if (!hit.hit) continue;
    roadLo = Math.min(roadLo, hit.point.y);
    if (lat < 0) edgeL = Math.min(edgeL, lat); else edgeR = Math.max(edgeR, lat);
  }
  console.log(`\n=== ${id} t=${t.toFixed(3)}  centreline y ${s.position.y.toFixed(2)}  `
    + `hw ${s.halfWidth.toFixed(1)}  drawn corridor ${edgeL.toFixed(1)}..${edgeR.toFixed(1)}  `
    + `lowest drawn point here ${roadLo.toFixed(2)} ===`);
  console.log('  lat    ground (at this station, and +-70 m along the road)');
  for (let lat = -MAXLAT; lat <= MAXLAT; lat += 10) {
    if (Math.abs(lat) < Math.max(-edgeL, edgeR)) continue;
    const parts: string[] = [];
    let lo = Infinity, hi = -Infinity;
    for (const a of [-70, -35, 0, 35, 70]) {
      const h = field.heightAt(
        s.position.x + bx.x * lat + ax.x * a,
        s.position.z + bx.z * lat + ax.z * a,
      );
      parts.push(h.toFixed(2).padStart(7));
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    const bar = hi < roadLo - 0.6 ? '  <- entirely below the road here' : '';
    console.log(`  ${String(lat).padStart(5)} ${parts.join('')}   span ${(hi - lo).toFixed(2)}${bar}`);
  }
}
env.dispose();
process.exit(0);
