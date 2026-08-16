/**
 * `Environment.resampleArcLength()` accumulates `Math.hypot(dx, dz)` — the
 * HORIZONTAL chord — and calls the result "true accumulated arc length".
 * `PathStation.s` is documented as "arc length from the start line, metres".
 * On a circuit that climbs, those are different numbers.
 *
 * This measures the gap: station i was sampled at spline arc
 * `(i / count) * lapLength`, so the drift is `s[i]` minus that.
 *
 * usage: node src/dev/node-run.mjs .probe-tmp/arcdrift.ts
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack, TRACK_IDS } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';

console.log('circuit            spline L   ctx L    worst drift   at arc   grade-worst station');
for (const id of TRACK_IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS.low);
  await env.init();
  const ctx = env.ctx;
  if (!ctx) continue;
  const st = ctx.stations;
  const n = st.length;
  let worst = 0, at = 0;
  for (let i = 0; i < n; i++) {
    const want = (i / n) * track.lapLength;
    const d = st[i].s - want;
    if (Math.abs(d) > Math.abs(worst)) { worst = d; at = want; }
  }
  console.log(
    `${id.padEnd(18)} ${track.lapLength.toFixed(1).padStart(8)} ${ctx.lapLength.toFixed(1).padStart(8)} ` +
    `${worst.toFixed(2).padStart(11)} m ${at.toFixed(0).padStart(8)}`,
  );
  env.dispose();
}
process.exit(0);
