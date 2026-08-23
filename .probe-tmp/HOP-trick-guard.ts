/**
 * ============================================================================
 *  HOP-trick-guard — does the drift hop at 4.6 arm an air TRICK it should not?
 * ============================================================================
 *      node src/dev/node-run.mjs .probe-tmp/HOP-trick-guard.ts
 *
 *  WHY THIS EXISTS. A rendered check of the hop showed the chassis rotating far
 *  past level while airborne (measured -65.7 deg about the chassis X axis) and
 *  snapping back to 0 on touchdown. `DriftSystem.tricks()` composes exactly that
 *  rotation — `trickTime * 2*PI` about AXIS_X — so the suspicion was that the
 *  taller hop now arms a trick.
 *
 *  `tricks()` deliberately refuses to: `fromHop = hopTime > 0 && hopTime < 0.1`
 *  and the launch gate is `launch >= trickLaunchSpeed && !fromHop`. The worry is
 *  that the 0.1 s window was sized when the hop never left the ground at all, so
 *  a taller hop could cross `justLeftGround` on the far side of it.
 *
 *  A FIRST ATTEMPT AT THIS IN THE BROWSER WAS WORTHLESS and is why this file is
 *  headless: driving a real circuit, the kart leaves the ground on kerbs and
 *  crests, which arms tricks legitimately. `trickActive` read true even at
 *  hopSpeed 2.6, where the hop provably produces no air at all. Any measurement
 *  of this has to be on a settled kart on a flat straight, with the ONLY
 *  departure from the ground being the hop itself — hence the 300-tick settle
 *  and the `hopTime` attribution below.
 * ============================================================================
 */
import * as THREE from 'three';
import { FIXED_DT } from '@/core/Config';
import { PHYS } from '@/physics/KartPhysics';
import { DRIFT } from '@/physics/DriftSystem';
import { loadTrack, makeField, makeCtx, placeOnTrack, TRACK_IDS } from '@/dev/headless';

const CTRL = (steer: number, accel: number, drift: boolean, pressed: boolean) => ({
  steer, accel, brake: 0, drift, driftPressed: pressed,
});
const AXIS_F = new THREE.Vector3(0, 0, 1);
const deg = (r: number) => (r * 180) / Math.PI;
const pitchOf = (q: THREE.Quaternion): number =>
  deg(Math.asin(Math.max(-1, Math.min(1, AXIS_F.clone().applyQuaternion(q).y))));

const run = async (id: string, hopSpeed: number): Promise<string> => {
  PHYS.hopSpeed = hopSpeed;
  const track = await loadTrack(id);
  const { physics } = makeField(track, 1, 150, 'nova');
  const ctx = makeCtx(FIXED_DT);
  const step = (n: number) => {
    for (let i = 0; i < n; i++) { ctx.elapsed += FIXED_DT; ctx.frame++; physics.fixedUpdate(ctx); }
  };
  const t = physics.tuningOf(0)!;
  placeOnTrack(physics, track, 0, 60, 0, t.maxSpeed * 0.6);
  physics.setControl(0, CTRL(0, 1, false, false));
  step(300);                                   // settle — see HOP-real-track
  let b = physics.getBody(0)!;
  const boost0 = b.boostTime;
  physics.setControl(0, CTRL(0, 1, true, true));

  let leftAt = -1, hopTimeAtLeave = -1, launchAtLeave = -1;
  let trickArmed = false, trickActive = false, trickName: string | null = null;
  let maxAbsPitch = 0, air = 0, landedAt = -1, boostAtLand = -1;
  let prevGrounded = b.grounded;
  for (let i = 1; i <= 200; i++) {
    const vyBefore = physics.getBody(0)!.velocity.y;
    step(1);
    physics.setControl(0, CTRL(0, 1, true, false));
    b = physics.getBody(0)!;
    if (prevGrounded && !b.grounded) {
      leftAt = i; hopTimeAtLeave = b.hopTime; launchAtLeave = vyBefore;
    }
    if (!prevGrounded && b.grounded && landedAt < 0 && air > 0) {
      landedAt = i; boostAtLand = b.boostTime;
    }
    prevGrounded = b.grounded;
    if (b.trickArmed) trickArmed = true;
    if (b.trickActive) { trickActive = true; trickName = b.trickName; }
    maxAbsPitch = Math.max(maxAbsPitch, Math.abs(pitchOf(b.bodyQuat)));
    if (!b.grounded) air += FIXED_DT;
    else if (air > 0 && landedAt > 0) break;
  }
  const verdict = trickActive ? 'TRICK ARMED' : 'no trick';
  return `  ${id.padEnd(18)} hop ${String(hopSpeed).padEnd(4)} air ${air.toFixed(3)}s  leftAt f${String(leftAt).padEnd(3)}` +
    ` hopTime@leave ${hopTimeAtLeave.toFixed(4)}  launch ${launchAtLeave.toFixed(2)} m/s  ` +
    `armed=${trickArmed ? 1 : 0} active=${trickActive ? 1 : 0} ${String(trickName ?? '-').padEnd(9)} ` +
    `maxPitch ${maxAbsPitch.toFixed(1)}deg  boost ${boost0.toFixed(2)}->${boostAtLand.toFixed(2)}  ${verdict}`;
};

console.log(`fromHop window: hopTime in (0, 0.1); trickLaunchSpeed ${DRIFT.trickLaunchSpeed} m/s; trickMinAir ${DRIFT.trickMinAir}s`);
console.log('A hop must NOT arm a trick. Flat straight, settled 300 ticks, hop is the only departure.\n');
for (const id of TRACK_IDS) {
  console.log(await run(id, 2.6));
  console.log(await run(id, 4.6));
}
PHYS.hopSpeed = 4.6;
