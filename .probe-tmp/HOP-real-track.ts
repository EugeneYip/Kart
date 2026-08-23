/**
 * ============================================================================
 *  HOP-real-track — does the drift hop leave the ground on the REAL Track?
 * ============================================================================
 *      node src/dev/node-run.mjs .probe-tmp/HOP-real-track.ts
 *
 *  Every `hop air time` number in the physics battery is taken on `TestTrack`
 *  in `flat` mode. That is the one measurement in the battery where the bench
 *  and the shipped game could plausibly disagree, because the bench has its own
 *  `raycastGround` — and a defect in exactly that function is what hid this bug
 *  for as long as it was hidden (see PROJECT_STATE §4.1). So this re-asks the
 *  question through `src/track/Track.ts`, on all eight circuits.
 *
 *  RESULT, 2026-08-23:
 *    hopSpeed 2.6 — air 0.000 s on all eight, minGroundedWheels 4 on seven of
 *                   them (1 on neonMetropolis, one wheel over a bump). The hop
 *                   never left the ground in the shipped game either.
 *    hopSpeed 4.6 — air 0.242–0.300 s, rise 0.34–0.41 m, minGroundedWheels 0 on
 *                   all eight. Inside the battery's 0.22–0.40 s on every circuit,
 *                   and it brackets the bench's 0.283 s.
 *
 *  TWO TRAPS, both of which produce a confident wrong answer:
 *
 *   • SETTLE THE KART FIRST. `placeOnTrack` drops it from a 0.55 m lift. At 40
 *     ticks the springs still read 0.362/0.314 — mid-drop — and the hop fires
 *     into a chassis that is already moving: air came out at 0.050–0.058 s, a
 *     fifth of the real figure, on every circuit. 300 ticks settles to
 *     0.264/0.271 and the numbers agree with the bench.
 *   • READ AIR TIME, NOT RISE. At 60 m in, real circuits have real elevation, so
 *     `rise` includes the ground moving underneath: it reads 1.589 m on
 *     neonMetropolis and 1.314 m on volcanoRush at a hopSpeed that produces NO
 *     air at all. `minGroundedWheels` is the honest corroboration.
 * ============================================================================
 */

// Does the drift hop leave the ground on the REAL Track (not TestTrack)?
import { FIXED_DT } from '@/core/Config';
import { PHYS } from '@/physics/KartPhysics';
import { loadTrack, makeField, makeCtx, placeOnTrack, TRACK_IDS } from '@/dev/headless';

const CTRL = (steer: number, accel: number, drift: boolean, pressed: boolean) => ({
  steer, accel, brake: 0, drift, driftPressed: pressed,
});

const run = async (id: string, hopSpeed: number): Promise<string> => {
  PHYS.hopSpeed = hopSpeed;
  const track = await loadTrack(id);
  const { physics } = makeField(track, 1, 150, 'nova');
  const ctx = makeCtx(FIXED_DT);
  const step = (n: number) => {
    for (let i = 0; i < n; i++) { ctx.elapsed += FIXED_DT; ctx.frame++; physics.fixedUpdate(ctx); }
  };
  // A flat-ish straight: 60 m in, on the centreline, at 60 % of top speed.
  const t = physics.tuningOf(0)!;
  placeOnTrack(physics, track, 0, 60, 0, t.maxSpeed * 0.6);
  physics.setControl(0, CTRL(0, 1, false, false));
  // Settle properly. 40 ticks was NOT enough: the springs still read 0.362/0.314
  // (mid-drop from the 0.55 m placement lift) and the hop then fired into a
  // chassis that was already moving, halving the air time.
  step(300);
  let b = physics.getBody(0)!;
  const y0 = b.position.y;
  const pre = b.wheels.map((w) => w.springLen.toFixed(3)).join(' ');
  physics.setControl(0, CTRL(0, 1, true, true));
  let air = 0, minG = 4, peak = -1e9;
  for (let i = 0; i < 200; i++) {
    step(1);
    physics.setControl(0, CTRL(0, 1, true, false));
    b = physics.getBody(0)!;
    peak = Math.max(peak, b.position.y);
    minG = Math.min(minG, b.groundedWheels);
    if (!b.grounded) air += FIXED_DT;
    else if (air > 0) break;
  }
  return `  ${id.padEnd(18)} hopSpeed ${String(hopSpeed).padEnd(4)} air ${air.toFixed(3)} s  rise ${(peak - y0).toFixed(3)} m  minGroundedWheels ${minG}  preHopSprings [${pre}]`;
};

console.log(`Real Track (src/track/Track.ts), circuits: ${TRACK_IDS.join(', ')}`);
console.log('Design intent: DriftSystem §1 "the kart is genuinely airborne"; battery expects 0.22–0.40 s.\n');
for (const id of TRACK_IDS) {
  console.log(await run(id, 2.6));
  console.log(await run(id, 4.6));
}
PHYS.hopSpeed = 4.6;
