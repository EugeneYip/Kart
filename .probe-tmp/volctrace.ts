/**
 * SPIRAL TRACE — follow the karts that hit the wall, tick by tick, through one
 * named stretch of one circuit, and print the loop that produced the contact.
 *
 * `volcdiag.ts` says every volcano contact is: on the RIGHT barrier, 4.6–6.7 m
 * to the right of the driver's own line, not drifting, not in recovery, at the
 * speed the driver asked for, with the wall reflex already saturated. That is a
 * steady state, not an accident, so the useful question is what holds it there.
 * This prints the per-tick loop: where the driver is AIMING (bias, target lateral
 * from the centreline), where it IS, what steer it commanded, and what yaw rate it
 * actually got against the yaw rate the pursuit geometry demanded.
 *
 * The `demand vs actual` pair is the whole point: if demanded > actual the kart is
 * understeering (asking for more turn than the chassis gives), and no amount of
 * line authoring fixes it.
 *
 * usage: node src/dev/node-run.mjs .probe-tmp/volctrace.ts <track> <loArc> <hiArc> [seconds] [seed]
 */

import * as THREE from 'three';
import { loadTrack, makeField, makeCtx } from '@/dev/headless';
import { AIManager } from '@/ai/AIManager';
import { AIDriver, type DriverWorld } from '@/ai/AIDriver';
import { personalityById, personalityForKart } from '@/ai/AIPersonality';
import { createBandOutput, type CCClass } from '@/ai/Rubberband';
import { FIXED_DT } from '@/core/Config';
import { makeTuning } from '@/physics/Tuning';
import { createNearestResult } from '@/ai/RacingLine';
import type { Track } from '@/track/Track';
import { CHARACTERS } from '@/karts/Characters';

const GAME_ROSTER = CHARACTERS.slice(0, 12).map((c) => c.id);
const FIELD = 12;

const trackId = process.argv[3] ?? 'volcanoRush';
const LO = Number(process.argv[4] ?? 840);
const HI = Number(process.argv[5] ?? 1240);
const SECONDS = Number(process.argv[6] ?? 200);
const SEED = Number(process.argv[7] ?? 12345);

const track: Track = await loadTrack(trackId);
const cc: CCClass = 150;
const { physics, karts } = makeField(track, FIELD, cc);
for (let i = 0; i < FIELD; i++) physics.setTuning(i, makeTuning(GAME_ROSTER[i], cc));
for (let i = 0; i < FIELD; i++) {
  const st = track.getStartPosition(i);
  physics.place(i, st.position, st.quaternion);
}

const ai = new AIManager(track, { states: karts }, undefined, {});
ai.init();
ai.setPhysics(physics);
ai.setDifficulty(cc);
ai.setRaceStarted(true);
ai.newFieldSeed(SEED);
const line = ai.racingLine;
if (!line) throw new Error('no racing line');

const pPers = personalityById('clean') ?? personalityForKart(2);
const player = new AIDriver(0, pPers, ai.rubberband.profile());
player.setState(karts[0]);
player.setForm({ pace: 0.97, mistake: 1, error: 1, drift: 1 });
const neutral = createBandOutput();
const pWorld: DriverWorld = {
  line, walls: track, karts, hazards: [], hazardCount: 0, elapsed: 0,
  raceStarted: true, countdown: 0, playerProgress: 0, playerId: 0,
  lapLength: line.lapLength, fieldSize: FIELD, cc: ai.rubberband.profile(),
};

const L = track.lapLength;
const near = createNearestResult();
const _probe = new THREE.Vector3();
const _prevFwd: THREE.Vector3[] = [];
for (let i = 0; i < FIELD; i++) _prevFwd.push(new THREE.Vector3(0, 0, -1));

interface Row {
  t: number; kart: number; pers: string; arc: number;
  /** signed lateral from the CENTRELINE, + = right. */
  latC: number;
  /** where the driver is aiming, lateral from the centreline. */
  aimC: number;
  lineLat: number;
  latErr: number;
  variant: string;
  steer: number;
  /** yaw rate actually achieved this tick, rad/s (+ = right). */
  yawActual: number;
  /** yaw rate the pursuit geometry needs to hold this radius, rad/s. */
  yawDemand: number;
  speed: number;
  target: number;
  wallBias: number;
  avoidBias: number;
  grounded: boolean;
  drifting: boolean;
  boosting: boolean;
  driftDir: number;
  driftStage: number;
  mode: string;
  surface: number;
  /** clearance to the right barrier from where the kart is, metres. */
  clrR: number;
  hit: boolean;
  halfWidth: number;
  curv: number;
}
const rows: Row[] = [];

const ctx = makeCtx(FIXED_DT);
const steps = Math.round(SECONDS / FIXED_DT);
const order = new Array<number>(FIELD);
for (let i = 0; i < FIELD; i++) order[i] = i;
const rankNow = (): void => {
  order.sort((a, b) => karts[b].progress - karts[a].progress);
  for (let i = 0; i < FIELD; i++) karts[order[i]].racePosition = i + 1;
};
rankNow();

const wallRadius = new Array<number>(FIELD).fill(1);
const probeZ = new Array<number>(FIELD).fill(1);
for (let i = 0; i < FIELD; i++) {
  const tn = physics.tuningOf(i);
  wallRadius[i] = (tn?.halfExtents.x ?? 0.72) * 1.04;
  probeZ[i] = (tn?.halfExtents.z ?? 0.97) * 0.58;
}

const _r = new THREE.Vector3();

for (let s = 0; s < steps; s++) {
  const tNow = s * FIXED_DT;
  pWorld.elapsed = tNow;
  pWorld.playerProgress = karts[0].progress;
  physics.setControl(0, player.step(FIXED_DT, pWorld, neutral));

  ai.fixedUpdate(ctx);
  physics.fixedUpdate(ctx);
  (ctx as { elapsed: number }).elapsed += FIXED_DT;
  (ctx as { frame: number }).frame++;
  for (let i = 0; i < FIELD; i++) track.updateProgress(karts[i]);
  rankNow();

  if (s % 3 !== 0) {
    for (let i = 0; i < FIELD; i++) {
      const b = physics.getBody(i);
      if (b) _prevFwd[i].copy(b.forward);
    }
    continue;
  }

  for (let i = 1; i < FIELD; i++) {
    const st = karts[i];
    const arc = (st.progress - Math.floor(st.progress)) * L;
    if (arc < LO || arc > HI) continue;
    const d = ai.getDriver(i);
    const b = physics.getBody(i);
    if (!d || !b) continue;

    // Where are we, laterally, relative to the CENTRELINE?
    line.nearest(st.position, near, 'optimal');
    const smp = track.sampleAtDistance(near.distance);
    const curv = smp.curvature;

    // Clearance to the right barrier from the kart's own position: walk right
    // until `collideWalls` reports, using the physics' own probe radius.
    let clrR = 99;
    for (let m = 0; m <= 12; m += 0.25) {
      _r.copy(b.forward).cross(b.up).normalize();
      _probe.copy(b.position).addScaledVector(_r, m);
      const h = track.collideWalls(_probe, wallRadius[i]);
      if (h.hit && h.depth > 1e-4) { clrR = m; break; }
    }

    let hit = false;
    for (let p = 0; p < 2 && !hit; p++) {
      const sgn = p === 0 ? 1 : -1;
      _probe.copy(b.position).addScaledVector(b.forward, sgn * probeZ[i]);
      const h = track.collideWalls(_probe, wallRadius[i]);
      if (h.hit && h.depth > 1e-4) hit = true;
    }

    // Yaw rate actually achieved, from the change in forward heading about up.
    // `_prevFwd` is refreshed EVERY tick (including the ones we skip sampling),
    // so the interval is one FIXED_DT — not the sample stride. Dividing by the
    // stride here reported a third of the true yaw rate and made every kart on
    // the grid look like it was under-turning the corner by 0.23 rad/s.
    _r.copy(_prevFwd[i]).cross(b.forward);
    const yawActual = (_r.dot(b.up) / FIXED_DT) * -1;
    const sp = Math.abs(st.speed);
    const yawDemand = sp * Math.abs(curv);

    rows.push({
      t: tNow, kart: i, pers: d.personality.id, arc,
      latC: near.lateralFromCentre,
      aimC: near.lateralFromCentre - d.lateralError + d.debug.avoidBias,
      lineLat: near.lateralFromCentre - d.lateralError,
      latErr: d.lateralError,
      variant: d.debug.variant,
      steer: d.debug.steer,
      yawActual, yawDemand,
      speed: sp, target: d.debug.targetSpeed,
      wallBias: d.debug.wallBias, avoidBias: d.debug.avoidBias,
      grounded: st.grounded, drifting: st.drifting, boosting: st.boostTime > 0,
      driftDir: st.driftDirection, driftStage: st.driftStage, mode: d.currentMode,
      surface: st.surface, clrR, hit,
      halfWidth: near.halfWidth, curv,
    });
  }
  for (let i = 0; i < FIELD; i++) {
    const b = physics.getBody(i);
    if (b) _prevFwd[i].copy(b.forward);
  }
}

// ---------------------------------------------------------------------------

function pct(v: number[], f: number): number {
  if (!v.length) return NaN;
  const q = [...v].sort((a, b) => a - b);
  return q[Math.min(q.length - 1, Math.floor(f * q.length))];
}
function stat(name: string, v: number[]): void {
  if (!v.length) { console.log(`  ${name.padEnd(20)} (no samples)`); return; }
  console.log(
    `  ${name.padEnd(20)} p05 ${pct(v, 0.05).toFixed(2).padStart(7)} p25 ${pct(v, 0.25).toFixed(2).padStart(7)} ` +
      `med ${pct(v, 0.5).toFixed(2).padStart(7)} p75 ${pct(v, 0.75).toFixed(2).padStart(7)} ` +
      `p95 ${pct(v, 0.95).toFixed(2).padStart(7)} | mean ${(v.reduce((a, c) => a + c, 0) / v.length).toFixed(2)}`,
  );
}

console.log(`\n##### ${trackId} arc ${LO}..${HI} m, seed ${SEED}, ${SECONDS} s — ${rows.length} samples`);
stat('lat from centre', rows.map((r) => r.latC));
stat('line lat (target)', rows.map((r) => r.lineLat));
stat('lateralError', rows.map((r) => r.latErr));
stat('halfWidth', rows.map((r) => r.halfWidth));
stat('clearance R (m)', rows.map((r) => r.clrR));
stat('steer cmd', rows.map((r) => r.steer));
stat('yaw actual', rows.map((r) => r.yawActual));
stat('yaw demand', rows.map((r) => r.yawDemand));
stat('yaw actual-demand', rows.map((r) => r.yawActual - r.yawDemand));
stat('speed', rows.map((r) => r.speed));
stat('speed - target', rows.map((r) => r.speed - r.target));
stat('wallBias', rows.map((r) => r.wallBias));
const n = rows.length || 1;
console.log(
  `  grounded ${(rows.filter((r) => r.grounded).length / n * 100).toFixed(0)}%  ` +
    `drifting ${(rows.filter((r) => r.drifting).length / n * 100).toFixed(0)}%  ` +
    `boosting ${(rows.filter((r) => r.boosting).length / n * 100).toFixed(0)}%  ` +
    `in contact ${(rows.filter((r) => r.hit).length / n * 100).toFixed(1)}%  ` +
    `steer saturated |s|>0.95 ${(rows.filter((r) => Math.abs(r.steer) > 0.95).length / n * 100).toFixed(1)}%`,
);

// Per-kart, so one bad kart cannot hide behind ten good ones.
console.log('\nper-kart through the stretch:');
console.log('  id pers        n    medLatC  medErr  medClrR  medSteer  yawAct  yawDem  gap   hit%  sat%');
for (let i = 1; i < FIELD; i++) {
  const q = rows.filter((r) => r.kart === i);
  if (!q.length) continue;
  console.log(
    `  ${String(i).padStart(2)} ${q[0].pers.padEnd(11)} ${String(q.length).padStart(4)} ` +
      `${pct(q.map((r) => r.latC), 0.5).toFixed(2).padStart(8)} ` +
      `${pct(q.map((r) => r.latErr), 0.5).toFixed(2).padStart(7)} ` +
      `${pct(q.map((r) => r.clrR), 0.5).toFixed(2).padStart(8)} ` +
      `${pct(q.map((r) => r.steer), 0.5).toFixed(2).padStart(9)} ` +
      `${pct(q.map((r) => r.yawActual), 0.5).toFixed(3).padStart(7)} ` +
      `${pct(q.map((r) => r.yawDemand), 0.5).toFixed(3).padStart(7)} ` +
      `${pct(q.map((r) => r.yawActual - r.yawDemand), 0.5).toFixed(3).padStart(6)} ` +
      `${(q.filter((r) => r.hit).length / q.length * 100).toFixed(1).padStart(5)} ` +
      `${(q.filter((r) => Math.abs(r.steer) > 0.95).length / q.length * 100).toFixed(1).padStart(5)}`,
  );
}

// --- excursion anatomy ------------------------------------------------------
// An "excursion" is a run of samples whose lateral error exceeds 3 m. Reporting
// the state 2 s BEFORE it starts is the point: at the contact itself everyone is
// already at the wall, which tells you nothing about what put them there.
interface Exc { kart: number; pers: string; i0: number; i1: number; peak: number; hit: boolean }
const excs: Exc[] = [];
for (let i = 1; i < FIELD; i++) {
  const q = rows.filter((r) => r.kart === i);
  let s0 = -1;
  for (let j = 0; j < q.length; j++) {
    const big = Math.abs(q[j].latErr) > 3;
    if (big && s0 < 0) s0 = j;
    else if (!big && s0 >= 0) {
      const seg = q.slice(s0, j);
      excs.push({
        kart: i, pers: q[0].pers, i0: s0, i1: j,
        peak: Math.max(...seg.map((r) => Math.abs(r.latErr))),
        hit: seg.some((r) => r.hit),
      });
      s0 = -1;
    }
  }
}
const withHit = excs.filter((e) => e.hit);
console.log(
  `\nexcursions (|latErr| > 3 m) in the stretch: ${excs.length}, of which ${withHit.length} reach the barrier`,
);
const flags = (pred: (r: Row) => boolean, name: string): void => {
  // Measured over the 2 s of run-up BEFORE each excursion that ends in contact.
  let n = 0;
  let k = 0;
  for (const e of withHit) {
    const q = rows.filter((r) => r.kart === e.kart);
    for (let j = Math.max(0, e.i0 - 40); j < e.i0; j++) { n++; if (pred(q[j])) k++; }
  }
  console.log(`  run-up ${name.padEnd(24)} ${k}/${n} ${n ? ((k / n) * 100).toFixed(0) : 0}%`);
};
flags((r) => r.drifting, 'drifting');
flags((r) => r.boosting, 'boosting');
flags((r) => !r.grounded, 'airborne');
flags((r) => r.speed > r.target + 2, 'speed > target + 2');
flags((r) => r.speed > r.target + 5, 'speed > target + 5');
flags((r) => Math.abs(r.steer) > 0.95, 'steer saturated');
flags((r) => r.mode !== 'race', 'in recovery');

const byKart = new Map<number, number>();
for (const r of rows) if (r.hit) byKart.set(r.kart, (byKart.get(r.kart) ?? 0) + 1);
const worst = [...byKart.entries()].sort((a, b) => b[1] - a[1])[0];
if (worst) {
  const q = rows.filter((r) => r.kart === worst[0]);
  const e = withHit.find((x) => x.kart === worst[0]) ?? { i0: q.findIndex((r) => r.hit) };
  const from = Math.max(0, e.i0 - 70);
  console.log(`\nRAW trace kart ${worst[0]} (${q[0].pers}), ${worst[1]} contact samples — 3.5 s before its first excursion:`);
  console.log('     t   arc   latC  lineL  latErr  clrR  steer  yawAct yawDem  speed  tgt  wBias  var      md   g d b dS hit');
  for (const r of q.slice(from, from + 120)) {
    console.log(
      `${r.t.toFixed(1).padStart(6)} ${r.arc.toFixed(0).padStart(5)} ` +
        `${r.latC.toFixed(2).padStart(6)} ${r.lineLat.toFixed(2).padStart(6)} ` +
        `${r.latErr.toFixed(2).padStart(7)} ${r.clrR.toFixed(2).padStart(5)} ` +
        `${r.steer.toFixed(2).padStart(6)} ${r.yawActual.toFixed(3).padStart(7)} ` +
        `${r.yawDemand.toFixed(3).padStart(6)} ${r.speed.toFixed(1).padStart(6)} ` +
        `${r.target.toFixed(1).padStart(4)} ${r.wallBias.toFixed(1).padStart(6)} ` +
        `${r.variant.padEnd(8)} ${r.mode.padEnd(4)} ${r.grounded ? 'G' : '.'} ` +
        `${r.drifting ? (r.driftDir > 0 ? 'R' : 'L') : '.'} ` +
        `${r.boosting ? 'B' : '.'} ${r.driftStage} ${r.hit ? 'HIT' : ''}`,
    );
  }
}

ai.dispose();
physics.dispose();
