/**
 * DRIFT CENSUS, all circuits.
 *
 * `volctrace.ts` says 83 % of the volcano excursions that reach a barrier begin
 * with the driver drifting, and that a single drift through the spiral moves the
 * kart 9 m off its line and then the mini-turbo sweeps it 11 m back. The drift's
 * exit tests (`AIDriver.updateDrift`, case 'hold') cannot see any of that: they
 * test the corner ending, room to the DRIVABLE EDGE, a stun, a landing, the
 * physics dropping the slide, and a 1.6 s cap. None of them is "this slide is
 * taking me off my line".
 *
 * Before adding such a test, measure what it would cost everywhere else. For
 * every circuit this reports, over every drift every AI kart takes:
 *
 *   - how long the drift lasts and how much lateral error it accumulates
 *   - the distribution of |lateral error| across drifting ticks
 *   - what fraction of drifts would be cut short by a candidate bail threshold
 *   - how many drifts end within 1.5 s of a barrier contact
 *
 * A threshold worth shipping is one that is common on volcanoRush and rare
 * everywhere else. If it fires as often on taipei as on volcano it is not a fix,
 * it is a nerf.
 *
 * usage: node src/dev/node-run.mjs .probe-tmp/driftroom.ts [seconds] [tracks] [seeds]
 */

import * as THREE from 'three';
import { loadTrack, makeField, makeCtx } from '@/dev/headless';
import { AIManager } from '@/ai/AIManager';
import { AIDriver, type DriverWorld } from '@/ai/AIDriver';
import { personalityById, personalityForKart } from '@/ai/AIPersonality';
import { createBandOutput, type CCClass } from '@/ai/Rubberband';
import { FIXED_DT } from '@/core/Config';
import { makeTuning } from '@/physics/Tuning';
import type { Track } from '@/track/Track';
import { CHARACTERS } from '@/karts/Characters';
import { DRIFT } from '@/ai/AIDriver';

/**
 * Measure the PRE-FIX behaviour by default: with the projected bail live the
 * drifts it would have cut short no longer exist, so the census would report the
 * share of drifts the rule fires on as ~0 and prove nothing. `live` re-enables
 * it, which is the after-shot.
 */
if ((process.argv[6] ?? 'off') !== 'live') {
  (DRIFT as unknown as Record<string, number>).projectSeconds = 0;
}

const GAME_ROSTER = CHARACTERS.slice(0, 12).map((c) => c.id);
const FIELD = 12;

const SECONDS = Number(process.argv[3] ?? 200);
const tracks = (process.argv[4] ?? 'sunsetCoastline,neonMetropolis,volcanoRush,bostonHarbor,taipeiCircuit,tokyoNeon').split(',');
const seeds = (process.argv[5] ?? '12345,777').split(',').map(Number);
/**
 * Candidate bail rules, as seconds of LATERAL travel to project ahead.
 *
 * The rule under test: while drifting, project the kart's lateral position on
 * the road forward by T seconds at its current road-crossing rate, and bail if
 * that projection is outside `halfWidth - bailMargin`. A first pass tested a
 * flat |lateral error| threshold instead; it fired on 41 % of sunsetCoastline's
 * drifts at 4 m, which is a nerf, not a fix.
 */
const PROJECT_T = [0.25, 0.35, 0.45, 0.6];
const BAIL_MARGIN = 1.5;

interface Drift {
  track: string;
  kart: number;
  pers: string;
  seconds: number;
  /** Peak |lateral error| reached during the slide, metres. */
  peakErr: number;
  /** |lateral error| at the instant the slide started. */
  entryErr: number;
  /** Barrier contact during the slide or within 1.5 s of its release. */
  hitAfter: boolean;
  /** Seconds into the slide at which each projection rule would first fire. */
  crossed: number[];
  /** Peak |road-crossing rate| during the slide, m/s. */
  peakRate: number;
  arc: number;
}

const _probe = new THREE.Vector3();

async function run(trackId: string, seed: number): Promise<{ drifts: Drift[]; ticks: number[]; contacts: number }> {
  const cc: CCClass = 150;
  const track: Track = await loadTrack(trackId);
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
  ai.newFieldSeed(seed);
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
  const wallRadius = new Array<number>(FIELD).fill(1);
  const probeZ = new Array<number>(FIELD).fill(1);
  for (let i = 0; i < FIELD; i++) {
    const tn = physics.tuningOf(i);
    wallRadius[i] = (tn?.halfExtents.x ?? 0.72) * 1.04;
    probeZ[i] = (tn?.halfExtents.z ?? 0.97) * 0.58;
  }

  const drifts: Drift[] = [];
  const ticks: number[] = [];
  /** Previous lateral-from-centre per kart, for the road-crossing rate. */
  const prevLatC = new Array<number>(FIELD).fill(NaN);
  const rateSmooth = new Array<number>(FIELD).fill(0);
  const open = new Array<Drift | null>(FIELD).fill(null);
  const openUntil = new Array<number>(FIELD).fill(-1);
  const wasTouching = new Array<boolean>(FIELD).fill(false);
  let contacts = 0;

  const ctx = makeCtx(FIXED_DT);
  const steps = Math.round(SECONDS / FIXED_DT);
  const order = new Array<number>(FIELD);
  for (let i = 0; i < FIELD; i++) order[i] = i;
  const rankNow = (): void => {
    order.sort((a, b) => karts[b].progress - karts[a].progress);
    for (let i = 0; i < FIELD; i++) karts[order[i]].racePosition = i + 1;
  };
  rankNow();

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

    for (let i = 1; i < FIELD; i++) {
      const st = karts[i];
      const d = ai.getDriver(i);
      const b = physics.getBody(i);
      if (!d || !b) continue;

      let hit = false;
      for (let p = 0; p < 2 && !hit; p++) {
        const sgn = p === 0 ? 1 : -1;
        _probe.copy(b.position).addScaledVector(b.forward, sgn * probeZ[i]);
        const h = track.collideWalls(_probe, wallRadius[i]);
        if (h.hit && h.depth > 1e-4) hit = true;
      }
      if (hit && !wasTouching[i]) contacts++;
      wasTouching[i] = hit;

      const err = Math.abs(d.lateralError);

      // Road-crossing rate, m/s, from the same quantity the driver has in hand.
      // Smoothed over ~0.06 s: the raw per-tick difference on a 60 Hz sim is
      // noisy enough that an unsmoothed rule would fire on quantisation.
      const latC = d.latFromCentre;
      const raw = Number.isNaN(prevLatC[i]) ? 0 : (latC - prevLatC[i]) / FIXED_DT;
      prevLatC[i] = latC;
      rateSmooth[i] += (raw - rateSmooth[i]) * 0.25;
      const rate = rateSmooth[i];
      const edge = d.nearHalfWidth - BAIL_MARGIN;

      if (st.drifting) {
        ticks.push(err);
        let rec = open[i];
        if (!rec) {
          rec = {
            track: trackId, kart: i, pers: d.personality.id, seconds: 0,
            peakErr: err, entryErr: err, hitAfter: false,
            crossed: PROJECT_T.map(() => -1), peakRate: 0,
            arc: (st.progress - Math.floor(st.progress)) * L,
          };
          open[i] = rec;
        }
        rec.seconds += FIXED_DT;
        if (err > rec.peakErr) rec.peakErr = err;
        if (Math.abs(rate) > rec.peakRate) rec.peakRate = Math.abs(rate);
        for (let k = 0; k < PROJECT_T.length; k++) {
          if (rec.crossed[k] >= 0) continue;
          if (Math.abs(latC + rate * PROJECT_T[k]) > edge) rec.crossed[k] = rec.seconds;
        }
        if (hit) rec.hitAfter = true;
        // Keep the record open for 1.5 s past the release: the mini-turbo that
        // follows the slide is part of the same event and is where volcano's
        // contacts actually land.
        openUntil[i] = tNow + 1.5;
      } else if (open[i]) {
        if (hit) open[i]!.hitAfter = true;
        if (tNow > openUntil[i]) {
          drifts.push(open[i]!);
          open[i] = null;
        }
      }
    }
  }
  for (let i = 0; i < FIELD; i++) if (open[i]) drifts.push(open[i]!);

  ai.dispose();
  physics.dispose();
  return { drifts, ticks, contacts };
}

function pct(v: number[], f: number): number {
  if (!v.length) return NaN;
  const q = [...v].sort((a, b) => a - b);
  return q[Math.min(q.length - 1, Math.floor(f * q.length))];
}

console.log(`drift census: ${SECONDS} s, seeds ${seeds.join('/')}\n`);
console.log(
  'circuit           drifts  contacts | dur med  p95 |  peak|err| med  p90  p95   max | ' +
    'rate p50 p90  max | ending in contact | share of drifts the projected bail would cut, by T',
);
console.log(
  ''.padEnd(115) + PROJECT_T.map((c) => `${c}s`.padStart(7)).join(''),
);

for (const trackId of tracks) {
  const all: Drift[] = [];
  const allTicks: number[] = [];
  let contacts = 0;
  for (const seed of seeds) {
    const r = await run(trackId, seed);
    all.push(...r.drifts);
    allTicks.push(...r.ticks);
    contacts += r.contacts;
  }
  const n = all.length || 1;
  const hit = all.filter((d) => d.hitAfter).length;
  console.log(
    `${trackId.padEnd(17)} ${String(all.length).padStart(6)} ${String(contacts).padStart(9)} | ` +
      `${pct(all.map((d) => d.seconds), 0.5).toFixed(2).padStart(7)} ${pct(all.map((d) => d.seconds), 0.95).toFixed(2).padStart(4)} | ` +
      `${pct(all.map((d) => d.peakErr), 0.5).toFixed(1).padStart(13)} ${pct(all.map((d) => d.peakErr), 0.9).toFixed(1).padStart(4)} ` +
      `${pct(all.map((d) => d.peakErr), 0.95).toFixed(1).padStart(4)} ${Math.max(...all.map((d) => d.peakErr)).toFixed(1).padStart(5)} | ` +
      `${pct(all.map((d) => d.peakRate), 0.5).toFixed(1).padStart(7)} ${pct(all.map((d) => d.peakRate), 0.9).toFixed(1).padStart(4)} ` +
      `${Math.max(...all.map((d) => d.peakRate)).toFixed(1).padStart(5)} | ` +
      `${String(hit).padStart(6)} ${((hit / n) * 100).toFixed(1).padStart(6)}%   | ` +
      PROJECT_T.map((c, k) => {
        void c;
        return `${((all.filter((d) => d.crossed[k] >= 0).length / n) * 100).toFixed(0)}%`.padStart(7);
      }).join(''),
  );
  console.log(
    `${''.padEnd(17)} drifting-tick |err|: med ${pct(allTicks, 0.5).toFixed(2)} ` +
      `p75 ${pct(allTicks, 0.75).toFixed(2)} p90 ${pct(allTicks, 0.9).toFixed(2)} ` +
      `p99 ${pct(allTicks, 0.99).toFixed(2)}  (${allTicks.length} ticks)`,
  );
  // "Would cut" counts a rule that fires on the last tick of a slide the same as
  // one that fires on the first, which overstates the cost. Report HOW EARLY.
  console.log(
    `${''.padEnd(17)} would-cut fires at, as a fraction of the slide it cut: ` +
      PROJECT_T.map((T, k) => {
        const f = all.filter((d) => d.crossed[k] >= 0 && d.seconds > 0)
          .map((d) => d.crossed[k] / d.seconds);
        return `${T}s med ${f.length ? pct(f, 0.5).toFixed(2) : '-'}`;
      }).join('  '),
  );
}
