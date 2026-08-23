/**
 * Why `hopTime` cannot answer "was this departure the hop?" — the frame-by-frame
 * trace. Diagnostic only; the assertions live in the battery.
 *     node src/dev/node-run.mjs .probe-tmp/HOP-provenance-trace.ts
 */
import { FIXED_DT } from '@/core/Config';
import { PHYS } from '@/physics/KartPhysics';
import { DRIFT } from '@/physics/DriftSystem';
import { loadTrack, makeField, makeCtx, placeOnTrack } from '@/dev/headless';

const CTRL = (drift: boolean, pressed: boolean) => ({
  steer: 0, accel: 1, brake: 0, drift, driftPressed: pressed,
});

const track = await loadTrack('sunsetCoastline');
const { physics } = makeField(track, 1, 150, 'nova');
const ctx = makeCtx(FIXED_DT);
const step = (n: number) => {
  for (let i = 0; i < n; i++) { ctx.elapsed += FIXED_DT; ctx.frame++; physics.fixedUpdate(ctx); }
};
const t = physics.tuningOf(0)!;
placeOnTrack(physics, track, 0, 60, 0, t.maxSpeed * 0.6);
physics.setControl(0, CTRL(false, false));
step(300);

console.log(`hopMinAir ${DRIFT.hopMinAir}s  hopSpeed ${PHYS.hopSpeed}  fromHop window (0, 0.1)`);
console.log('f   grounded  hopTime   driftPhase  vUp     event');
physics.setControl(0, CTRL(true, true));
let prevG = physics.getBody(0)!.grounded;
for (let i = 1; i <= 12; i++) {
  step(1);
  physics.setControl(0, CTRL(true, false));
  const b = physics.getBody(0)!;
  const vUp = b.velocity.dot(b.up);
  const ev = prevG && !b.grounded ? '<-- justLeftGround: fromHop reads ' +
    (b.hopTime > 0 && b.hopTime < 0.1 ? 'TRUE' : 'FALSE') : '';
  console.log(
    `${String(i).padStart(2)}  ${b.grounded ? 'yes' : 'NO '}       ` +
    `${b.hopTime.toFixed(4)}    ${b.driftPhase}           ${vUp.toFixed(2).padStart(5)}   ${ev}`,
  );
  prevG = b.grounded;
}
