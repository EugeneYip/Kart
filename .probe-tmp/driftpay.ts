/**
 * DID THE FIX STERILISE THE RACING?
 *
 * Cutting a drift short is cheap to do and easy to do too much of: a field that
 * never completes a slide earns no mini-turbos, and an AI with no mini-turbos is
 * slower, more uniform, and less fun to race even if it never touches a wall.
 * A contacts number on its own cannot tell those two outcomes apart.
 *
 * So this reports, with `DRIFT.projectSeconds` live and again with it set to 0
 * (which reverts the gate exactly), the things the fix could plausibly have
 * broken: mini-turbos earned, boost seconds, mean and best lap, the lap-time
 * spread that is the authored ability ladder, and overtakes.
 *
 * usage: node src/dev/node-run.mjs .probe-tmp/driftpay.ts [seconds] [tracks] [seeds]
 */

import { runWallRace, type WallReport } from './wallgrind';
import { DRIFT } from '@/ai/AIDriver';

const SECONDS = Number(process.argv[3] ?? 200);
const tracks = (process.argv[4] ?? 'volcanoRush,taipeiCircuit,sunsetCoastline').split(',');
const seeds = (process.argv[5] ?? '12345,777').split(',').map(Number);

const driftT = DRIFT as unknown as Record<string, number>;
const SAVED = DRIFT.projectSeconds;

interface Row {
  runs: number;
  miniTurbos: number;
  boostSeconds: number;
  drifts: number;
  contacts: number;
  meanLap: number;
  bestLap: number;
  lapSpread: number;
  overtakes: number;
  offTrack: number;
  topSpeed: number;
}
function blank(): Row {
  return {
    runs: 0, miniTurbos: 0, boostSeconds: 0, drifts: 0, contacts: 0, meanLap: 0,
    bestLap: 0, lapSpread: 0, overtakes: 0, offTrack: 0, topSpeed: 0,
  };
}
function fold(r: Row, w: WallReport): void {
  const ai = w.karts.filter((k) => !k.isPlayer);
  r.runs++;
  r.miniTurbos += ai.reduce((s, k) => s + k.miniTurbos, 0);
  r.boostSeconds += ai.reduce((s, k) => s + k.boostSeconds, 0);
  r.contacts += w.totalContacts;
  const laps = ai.filter((k) => k.meanLap > 0);
  r.meanLap += laps.length ? laps.reduce((s, k) => s + k.meanLap, 0) / laps.length : 0;
  const best = ai.filter((k) => k.bestLap > 0).map((k) => k.bestLap);
  r.bestLap += best.length ? Math.min(...best) : 0;
  r.lapSpread += w.lapSpread;
  r.overtakes += w.overtakes;
  r.offTrack += ai.reduce((s, k) => s + k.offTrack, 0);
  r.topSpeed += ai.reduce((s, k) => s + k.topSpeed, 0) / Math.max(1, ai.length);
}
function line(label: string, r: Row): string {
  const n = Math.max(1, r.runs);
  return (
    `${label.padEnd(28)} ${(r.miniTurbos / n).toFixed(1).padStart(7)} ` +
    `${(r.boostSeconds / n).toFixed(1).padStart(7)} ${(r.contacts / n).toFixed(1).padStart(8)} ` +
    `${(r.meanLap / n).toFixed(2).padStart(8)} ${(r.bestLap / n).toFixed(2).padStart(8)} ` +
    `${(r.lapSpread / n).toFixed(2).padStart(7)} ${(r.overtakes / n).toFixed(1).padStart(6)} ` +
    `${(r.offTrack / n).toFixed(1).padStart(7)} ${(r.topSpeed / n).toFixed(1).padStart(8)}`
  );
}

console.log(`drift payoff: ${SECONDS} s, seeds ${seeds.join('/')}\n`);
console.log(
  'circuit / config             miniT  boostS contacts  meanLap  bestLap  spread  ovtk  offTrk topSpeed',
);

for (const trackId of tracks) {
  for (const mode of ['live', 'reverted'] as const) {
    driftT.projectSeconds = mode === 'live' ? SAVED : 0;
    const r = blank();
    for (const seed of seeds) {
      fold(r, await runWallRace({ trackId, seconds: SECONDS, playerPace: 0.97, seed }));
    }
    console.log(line(`  ${trackId} ${mode}`, r));
  }
}
driftT.projectSeconds = SAVED;
