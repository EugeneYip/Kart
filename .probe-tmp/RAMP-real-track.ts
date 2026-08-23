/**
 * Does a genuine ramp on a REAL circuit still arm a trick after the hop fix?
 * The cove ramp on sunsetCoastline runs d≈1104 -> 1151.
 *     node src/dev/node-run.mjs .probe-tmp/RAMP-real-track.ts
 */
import { bus } from '@/core/EventBus';
import { FIXED_DT } from '@/core/Config';
import { loadTrack, makeField, makeCtx, placeOnTrack } from '@/dev/headless';

const track = await loadTrack('sunsetCoastline');
const { physics } = makeField(track, 1, 150, 'nova');
const ctx = makeCtx(FIXED_DT);
const step = (n: number) => {
  for (let i = 0; i < n; i++) { ctx.elapsed += FIXED_DT; ctx.frame++; physics.fixedUpdate(ctx); }
};
const t = physics.tuningOf(0)!;
placeOnTrack(physics, track, 0, 1085, 0, t.maxSpeed * 0.95);
// drift HELD but never pressed: no hop impulse, so the only launch is the ramp
physics.setControl(0, { steer: 0, accel: 1, brake: 0, drift: true, driftPressed: false });
step(300);

let trick = '', boost = 0, maxPitch = 0, air = 0;
const offT = bus.on('kart:trick', (e) => { trick = e.name; });
const offB = bus.on('kart:boost', (e) => { if (e.source === 'trick') boost = e.duration; });
for (let i = 0; i < 600; i++) {
  step(1);
  physics.setControl(0, { steer: 0, accel: 1, brake: 0, drift: true, driftPressed: false });
  const b = physics.getBody(0)!;
  if (!b.grounded) air += FIXED_DT;
  const fy = b.bodyQuat ? Math.asin(Math.max(-1, Math.min(1,
    2 * (b.bodyQuat.y * b.bodyQuat.z + b.bodyQuat.w * b.bodyQuat.x)))) : 0;
  maxPitch = Math.max(maxPitch, Math.abs((fy * 180) / Math.PI));
}
offT(); offB();
console.log(`cove ramp, drift held, no hop: airborne ${air.toFixed(3)}s  trick "${trick || 'none'}"  trick boost ${boost.toFixed(2)}s  maxPitch ${maxPitch.toFixed(1)}deg`);
