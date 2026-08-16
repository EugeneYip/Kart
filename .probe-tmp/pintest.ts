/**
 * IS THE SHIPPED CONTACT COUNTER DURATION-BLIND?
 *
 * `wallgrind.ts` counts a wall contact on the RISING EDGE:
 *
 *     if (hitNow) { if (!touching[i]) { touching[i] = true; rep[i].contacts++; } }
 *
 * and `wallab.ts` reports the sum of those as `totalContacts` — the 24.8 -> 2.2
 * headline. The claim under test: a kart held against a barrier for many seconds
 * scores the same as one that clips it for a single tick.
 *
 * No AI. One kart, placed on the road, steered into the barrier at full throttle
 * and held there. Counted BOTH ways side by side.
 */
import * as THREE from 'three';
import { loadTrack, makeField, makeCtx, placeOnTrack } from '@/dev/headless';
import { FIXED_DT } from '@/core/Config';
import { makeTuning } from '@/physics/Tuning';

const trackId = process.argv[3] ?? 'sunsetCoastline';
const track = await loadTrack(trackId);
const { physics, karts } = makeField(track, 1, 150);
physics.setTuning(0, makeTuning('nova', 150));
void karts;

const t = physics.tuningOf(0);
const radius = (t?.halfExtents.x ?? 0.72) * 1.04;
const probeZ = (t?.halfExtents.z ?? 0.97) * 0.58;
const _p = new THREE.Vector3();

// Start at 60 % of the road width toward the right barrier, at speed.
placeOnTrack(physics, track, 0, 200, 6, 20);

const ctx = makeCtx(FIXED_DT);
const SECONDS = 25;
const steps = Math.round(SECONDS / FIXED_DT);

let risingEdges = 0;
let contactSeconds = 0;
let longest = 0;
let run = 0;
let touching = false;

for (let s = 0; s < steps; s++) {
  // Steer hard right and hold the throttle — pin against the right barrier.
  physics.setControl(0, { steer: 0.55, accel: 1, brake: 0, drift: false, driftPressed: false });
  physics.fixedUpdate(ctx);
  (ctx as { elapsed: number }).elapsed += FIXED_DT;

  const b = physics.getBody(0);
  if (!b) break;
  let hit = false;
  for (let p = 0; p < 2 && !hit; p++) {
    _p.copy(b.position).addScaledVector(b.forward, (p === 0 ? 1 : -1) * probeZ);
    const h = track.collideWalls(_p, radius);
    if (h.hit && h.depth > 1e-4) hit = true;
  }
  if (hit) {
    contactSeconds += FIXED_DT;
    if (!touching) {
      touching = true;
      run = 0;
      risingEdges++;
    }
    run += FIXED_DT;
    if (run > longest) longest = run;
  } else if (touching) {
    touching = false;
    run = 0;
  }
}

console.log(
  `\n${trackId}: ${SECONDS} s of a kart steered into the barrier at full throttle\n` +
    `  rising-edge contacts (what wallab.ts reports) : ${risingEdges}\n` +
    `  seconds actually in contact                   : ${contactSeconds.toFixed(2)}\n` +
    `  longest single continuous contact             : ${longest.toFixed(2)} s\n` +
    `  contacts the owner would SEE                  : one uninterrupted scrape\n`,
);
physics.dispose();
