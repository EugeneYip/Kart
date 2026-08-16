/**
 * MULTI-SEED A/B + PER-MECHANISM REGRESSION PROOF
 *
 * A 12-kart race is a chaotic system: two runs that differ by one tuning constant
 * diverge completely, so a single seed cannot distinguish "the fix worked" from
 * "the dice landed differently". Everything here is aggregated over several seeds.
 *
 * Every "off" configuration is produced by mutating the AI's own exported tuning
 * tables, so the shipped code carries no test hooks. Each one reintroduces exactly
 * one defect:
 *
 *   steer     `authoritySafety = 1.9` — the AI believes it has ~1.9x the yaw
 *             authority it has, which is the shipped bug measured in
 *             `.probe-tmp/yawcurve.ts` (ratio 1.5–2.3x across the roster).
 *   wall      wall reflex strengths and speed cut to zero — no term that steers
 *             away from a barrier, which is what the AI had.
 *   stuck     `arcMetres = -1` — the arc-progress test can never fire, leaving
 *             only the speed-based test, which is what the AI had.
 *   yawcap    `yawLimitIterations = 0` — the target speed is no longer capped by
 *             what the chassis can actually turn at.
 *   band      `composureSeconds` ~ 0 — composure is always 1, so the rubber band
 *             pushes a driver that is already failing, which is what it did.
 *   ALL       all five at once = the shipped behaviour.
 */

import { runWallRace, type WallReport } from './wallgrind';
import { STEER, WALL, RECOVER, SPEED, DRIFT } from '@/ai/AIDriver';
import { RUBBERBAND } from '@/ai/Rubberband';
void RUBBERBAND;

type Mut = Record<string, number>;
const steerT = STEER as unknown as Mut;
const wallT = WALL as unknown as Mut;
const recT = RECOVER as unknown as Mut;
const speedT = SPEED as unknown as Mut;
const bandT = RUBBERBAND as unknown as Mut;
const driftT = DRIFT as unknown as Mut;

const SAVED = {
  projectSeconds: DRIFT.projectSeconds,
  shoulderAllow: DRIFT.shoulderAllow,
  barrierPad: DRIFT.barrierPad,
  authoritySafety: STEER.authoritySafety,
  boostCornerDeadband: SPEED.boostCornerDeadband,
  leadStrength: WALL.leadStrength,
  nowStrength: WALL.nowStrength,
  speedCut: WALL.speedCut,
  arcMetres: RECOVER.arcMetres,
  yawLimitIterations: SPEED.yawLimitIterations,
  composureSeconds: RECOVER.composureSeconds,
  pinSeconds: WALL.pinSeconds,
  maxBias: WALL.maxBias,
  halfLife: WALL.halfLife,
};

function restore(): void {
  driftT.projectSeconds = SAVED.projectSeconds;
  driftT.shoulderAllow = SAVED.shoulderAllow;
  driftT.barrierPad = SAVED.barrierPad;
  steerT.authoritySafety = SAVED.authoritySafety;
  speedT.boostCornerDeadband = SAVED.boostCornerDeadband;
  wallT.leadStrength = SAVED.leadStrength;
  wallT.nowStrength = SAVED.nowStrength;
  wallT.speedCut = SAVED.speedCut;
  recT.arcMetres = SAVED.arcMetres;
  speedT.yawLimitIterations = SAVED.yawLimitIterations;
  recT.composureSeconds = SAVED.composureSeconds;
  wallT.pinSeconds = SAVED.pinSeconds;
  wallT.maxBias = SAVED.maxBias;
  wallT.halfLife = SAVED.halfLife;
}

const OFF: Record<string, () => void> = {
  /**
   * EXACT revert of the projected drift bail — the red control for it.
   *
   * All THREE constants have to go, not just `projectSeconds`. With only that
   * zeroed, `projected` collapses onto the kart's current lateral but `slideEdge`
   * is still `min(halfWidth + shoulderAllow, barrierHalf - barrierPad)`, which is
   * not `halfWidth`, so `roomAhead !== roomLeft` and the "off" config is a third
   * behaviour rather than the shipped-before one. Measured, that mistake reported
   * volcanoRush at 49.3 contacts when the true pre-fix figure is 77.0 — it was
   * quietly measuring a partly-fixed build and calling it the baseline.
   *
   * With all three at 0: `projected === latC`, and `slideEdge === min(halfWidth,
   * barrierHalf)` which is `halfWidth`, because `barrierHalf >= halfWidth` at
   * every station on every circuit (`.probe-tmp/barcheck.ts`, "inside the road:
   * 0"). So `roomAhead === roomLeft` and both new clauses are no-ops.
   */
  bailproj: () => {
    driftT.projectSeconds = 0;
    driftT.shoulderAllow = 0;
    driftT.barrierPad = 0;
  },
  /** Candidate tuning: gentler projection, flat road edge. */
  bailsoft: () => {
    driftT.projectSeconds = 0.3;
    driftT.shoulderAllow = 0;
    driftT.barrierPad = 0;
  },
  /** Candidate tuning: the shipped rule with the shoulder allowance eaten
   *  harder by the barrier clearance, which is the term that discriminates
   *  volcanoRush's 3.07 m spiral gap from sunset's 6.67 m. */
  bailtight: () => {
    driftT.barrierPad = 2.5;
  },
  steer: () => {
    steerT.authoritySafety = 1.9;
  },
  wall: () => {
    wallT.leadStrength = 0;
    wallT.nowStrength = 0;
    wallT.speedCut = 1;
    // `pinSeconds` too, or the reflex is still feeding a recovery trigger the
    // shipped code did not have, and "wall OFF" would not be the shipped code.
    wallT.pinSeconds = 1e9;
  },
  stuck: () => {
    recT.arcMetres = -1;
  },
  yawcap: () => {
    speedT.yawLimitIterations = 0;
  },
  /**
   * ⚠️ The window is `RECOVER.composureSeconds`, not `RUBBERBAND.composureSeconds`.
   * Mutating the latter — which is what the first version of this probe did — is a
   * no-op: nothing reads it. The tell was that "band OFF" came back bit-identical to
   * the control on all eight metrics, which is not what a behavioural change looks
   * like. The duplicate constant has since been deleted from Rubberband.ts.
   *
   * Note this is a LOWER BOUND on the mechanism: `AIDriver.composure` also returns 0
   * outright while the driver is in recovery, and no constant can switch that off, so
   * "band OFF" still withholds the band during recovery itself.
   */
  band: () => {
    recT.composureSeconds = 1e-9;
  },
  /**
   * Restores the unconditional "Boosting? Foot down." — a deadband larger than any
   * plausible overshoot means the corner branch can never be taken.
   */
  boost: () => {
    speedT.boostCornerDeadband = 1e9;
  },
  /**
   * Not a defect — a candidate tuning. The reflex as shipped is a strong, fast
   * term (4.6 m of push at a 0.1 s half-life) and a strong fast term inside a
   * closed loop is how you get an oscillation. This variant makes it a nudge:
   * half the authority, twice the time constant.
   */
  wallsoft: () => {
    wallT.nowStrength = 2.8;
    wallT.leadStrength = 2.2;
    wallT.maxBias = 3.4;
    wallT.halfLife = 0.2;
  },
};

interface Agg {
  runs: number;
  contacts: number;
  stuckEpisodes: number;
  kartsStuck: number;
  /** Karts that failed to complete a single lap. The unambiguous failure. */
  kartsNoLap: number;
  worstPerLap: number;
  medianPerLap: number;
  lapSpread: number;
  lapMin: number;
  lapMax: number;
  passes: number;
  passed: number;
  overtakes: number;
  offTrack: number;
}

function blank(): Agg {
  return {
    runs: 0, contacts: 0, stuckEpisodes: 0, kartsStuck: 0, kartsNoLap: 0,
    worstPerLap: 0, medianPerLap: 0, lapSpread: 0, lapMin: 0, lapMax: 0,
    passes: 0, passed: 0, overtakes: 0, offTrack: 0,
  };
}

function fold(a: Agg, r: WallReport): void {
  a.runs++;
  a.contacts += r.totalContacts;
  a.stuckEpisodes += r.totalStuck;
  a.kartsStuck += r.kartsEverStuck;
  const ai = r.karts.filter((k) => !k.isPlayer);
  a.kartsNoLap += ai.filter((k) => k.laps === 0).length;
  const perLap = ai.map((k) => (k.laps > 0 ? k.contacts / k.laps : k.contacts)).sort((x, y) => x - y);
  a.worstPerLap = Math.max(a.worstPerLap, perLap[perLap.length - 1] ?? 0);
  a.medianPerLap += perLap[perLap.length >> 1] ?? 0;
  a.lapSpread += r.lapSpread;
  a.lapMin += r.lapMin;
  a.lapMax += r.lapMax;
  a.passes += r.playerPasses;
  a.passed += r.playerPassed;
  a.overtakes += r.overtakes;
  a.offTrack += ai.reduce((s, k) => s + k.offTrack, 0);
}

function line(label: string, a: Agg): string {
  const n = Math.max(1, a.runs);
  return (
    `${label.padEnd(22)} ${String(a.runs).padStart(4)} ` +
    `${(a.contacts / n).toFixed(1).padStart(7)} ${(a.medianPerLap / n).toFixed(2).padStart(7)} ` +
    `${a.worstPerLap.toFixed(1).padStart(6)} | ` +
    `${(a.stuckEpisodes / n).toFixed(1).padStart(7)} ${(a.kartsStuck / n).toFixed(2).padStart(6)} ` +
    `${String(a.kartsNoLap).padStart(7)} | ` +
    `${(a.offTrack / n).toFixed(1).padStart(7)} | ` +
    `${(a.lapMin / n).toFixed(2).padStart(6)}..${(a.lapMax / n).toFixed(2).padStart(6)} ` +
    `${(a.lapSpread / n).toFixed(2).padStart(6)} | ` +
    `${(a.passes / n).toFixed(1).padStart(5)} ${(a.passed / n).toFixed(1).padStart(6)} ` +
    `${(a.overtakes / n).toFixed(1).padStart(6)}`
  );
}

const HEADER =
  'config                 runs contact med/lap  worst |   stuck kartsSt noLapAI |    offTr |   lap mean range spread | pass passed  ovtk';

const SECONDS = Number(process.argv[3] ?? 200);
const seeds = (process.argv[4] ?? '12345,777,4242').split(',').map(Number);
const tracks = (process.argv[5] ?? 'sunsetCoastline,neonMetropolis,volcanoRush').split(',');
const which = (process.argv[6] ?? 'FIXED,ALL,steer,wall,stuck,yawcap,band').split(',');
/** 'A' = pole config only (cheap, for the per-mechanism regressions); 'AF' adds
 *  the player-starts-last config, which is where the pass count comes from. */
const configs = process.argv[7] ?? 'AF';

console.log(
  `wall A/B: ${SECONDS} s, seeds ${seeds.join('/')}, tracks ${tracks.join('/')}\n` +
    `configs: ${which.join(' ')}\n`,
);

for (const cfg of which) {
  restore();
  // Explicit list, NOT Object.keys(OFF): `wallsoft` is a candidate tuning rather
  // than a defect, and because it runs after `wall` in key order it would re-enable
  // the reflex at reduced strength and quietly make "ALL OFF" not be ALL off.
  if (cfg === 'ALL')
    for (const k of ['steer', 'wall', 'stuck', 'yawcap', 'band', 'boost', 'bailproj']) OFF[k]();
  else if (cfg !== 'FIXED') {
    if (!OFF[cfg]) throw new Error(`unknown config ${cfg}`);
    OFF[cfg]();
  }

  const perTrack = new Map<string, Agg>();
  const total = blank();
  for (const trackId of tracks) {
    const a = perTrack.get(trackId) ?? blank();
    for (const seed of seeds) {
      // Config A (player mid-pace on pole) measures wall behaviour; config F
      // (player last, flat out) measures whether it is still passable.
      const rA = await runWallRace({ trackId, seconds: SECONDS, playerPace: 0.97, seed });
      fold(a, rA);
      fold(total, rA);
      if (configs === 'AF') {
        const rF = await runWallRace({
          trackId, seconds: SECONDS, playerPace: 1.0, playerGridSlot: 11, seed,
        });
        // Only the pass counters come from F; folding its wall numbers too would
        // double-count, and the two configs are not the same experiment.
        a.passes += rF.playerPasses;
        a.passed += rF.playerPassed;
        total.passes += rF.playerPasses;
        total.passed += rF.playerPassed;
      }
    }
    perTrack.set(trackId, a);
  }

  console.log(`\n### ${cfg === 'FIXED' ? 'FIXED (all mechanisms on)' : cfg === 'ALL' ? 'ALL OFF (= shipped behaviour)' : `${cfg} OFF`}`);
  console.log(HEADER);
  for (const [id, a] of perTrack) console.log(line(`  ${id}`, a));
  console.log(line('  TOTAL', total));
}
restore();
