/**
 * Driver for `loopdet.ts`.
 *
 *   node src/dev/node-run.mjs .probe-tmp/looprun.ts <tracks> <seeds> <laps> <flags>
 *
 * flags: comma list of  items,noitems,human,nohuman,displace,red,brush,detail
 *
 * `red` and `brush` are the two control arms. `red` must show CYCLES; `brush`
 * must show legacy loops and ZERO cycles. Run both after any change here.
 */
import {
  runLoopRace, printLoopReport, type LoopReport,
  LOOP_N, LOOP_WINDOW, LOOP_ARC, EP_MERGE_GAP, GRIND_SECONDS, RECOVERY_MIN,
} from './loopdet';
import { TRACK_IDS } from '@/dev/headless';
import type { CCClass } from '@/ai/Rubberband';

const tracksArg = process.argv[3] ?? 'ALL';
const tracks = tracksArg === 'ALL' ? [...TRACK_IDS] : tracksArg.split(',');
const seeds = (process.argv[4] ?? '12345,777,4242').split(',').map(Number);
const laps = Number(process.argv[5] ?? 3);
const flags = new Set((process.argv[6] ?? '').split(',').filter(Boolean));

const items = !flags.has('noitems');
const human = !flags.has('nohuman');
const displace = flags.has('displace');
const red = flags.has('red');
const brush = flags.has('brush');
const detail = flags.has('detail');
const quiet = flags.has('quiet');
const cc: CCClass = flags.has('cc200') ? 200 : flags.has('cc100') ? 100 : 150;
/** A mid-skill human is a rolling roadblock; `slow` models that. */
const playerPace = flags.has('slow') ? 0.8 : flags.has('veryslow') ? 0.65 : 0.97;
const playerGridSlot = flags.has('pole') ? 0 : 5;
const cap = Number(process.argv[7] ?? 400);
/**
 * `stale` = reproduce the SHIPPING sequence: the AIManager is built while the
 * previous circuit is loaded, then the track is swapped and only `resetRace()`
 * is called. `staleFrom=<id>` picks the previous circuit; default is the one
 * before this circuit in menu order, which is what a cup does.
 */
const staleFlag = [...flags].find((f) => f.startsWith('stale'));
const stale = staleFlag !== undefined;
const staleFrom = staleFlag && staleFlag.includes('=') ? staleFlag.split('=')[1] : undefined;
const prevOf = (id: string): string => {
  const i = TRACK_IDS.indexOf(id);
  return TRACK_IDS[(i - 1 + TRACK_IDS.length) % TRACK_IDS.length];
};

console.log(
  `LOOP DETECTOR — ${tracks.length} circuits x ${seeds.length} seeds, ${laps} laps, cap ${cap} s, ${cc}cc\n` +
    `items ${items ? 'ON' : 'off'}, human-in-pack ${human ? 'ON' : 'off'}, ` +
    `displacement ${displace ? 'ON' : 'off'}${red ? ', RED CONTROL (kart 5 driven into barrier, 2.2 s on / 1.8 s off)' : ''}` +
    `${brush ? ', BRUSH MIRROR (kart 5 flicked at barrier, 0.30 s on / 0.45 s off)' : ''}` +
    `${stale ? `, STALE-LINE sequence (AI built on ${staleFrom ?? 'the previous circuit'}, then track swapped)` : ''}\n` +
    `cluster  = ${LOOP_N}+ touches within ${LOOP_WINDOW} s and ${LOOP_ARC} m\n` +
    `  legacy = that test on RAW rising edges, no recovery required  <- the 0.17-0.83 number\n` +
    `  CYCLE  = same test on touches merged under ${EP_MERGE_GAP} s, AND >= ${RECOVERY_MIN} s of\n` +
    `           reverse/realign between two contacts (a recovery that failed)\n` +
    `  grind  = merged cluster, no recovery, but >= ${GRIND_SECONDS} s contact\n` +
    `  brush  = merged cluster, no recovery, short contact — a cornering clip\n`,
);

interface Row {
  track: string;
  runs: number;
  loops: number;
  cycles: number;
  grinds: number;
  brushes: number;
  cycleKarts: number;
  loopKarts: number;
  worstLoopEps: number;
  worstLoopWhere: string;
  worstCycleWhere: string;
  pins: number;
  stalls: number;
  contactSec: number;
  longest: number;
  episodes: number;
  noFinish: number;
  respawns: number;
  recEntries: number;
  offTrack: number;
  offEpisodes: number;
  bigOff: number;
  longestOff: number;
}

const rows: Row[] = [];
const allLoops: Array<{ track: string; seed: number; report: LoopReport }> = [];

for (const trackId of tracks) {
  const row: Row = {
    track: trackId, runs: 0, loops: 0, cycles: 0, grinds: 0, brushes: 0,
    cycleKarts: 0, loopKarts: 0, worstLoopEps: 0, worstLoopWhere: '-', worstCycleWhere: '-',
    pins: 0, stalls: 0, contactSec: 0, longest: 0, episodes: 0, noFinish: 0,
    respawns: 0, recEntries: 0, offTrack: 0, offEpisodes: 0, bigOff: 0, longestOff: 0,
  };
  for (const seed of seeds) {
    const r = await runLoopRace({
      trackId, seed, targetLaps: laps, capSeconds: cap, cc,
      items, humanPlayer: human, displace, red, brush, playerPace, playerGridSlot,
      staleLineFrom: stale ? (staleFrom ?? prevOf(trackId)) : undefined,
    });
    row.runs++;
    row.loops += r.legacyLoopCount;
    row.cycles += r.cycleCount;
    row.grinds += r.grindCount;
    row.brushes += r.brushCount;
    const lk = new Set(r.loops.map((l) => l.kart));
    row.loopKarts += lk.size;
    row.cycleKarts += new Set(r.loops.filter((l) => l.kind === 'cycle').map((l) => l.kart)).size;
    let worstCycle = 0;
    for (const l of r.loops) {
      if (l.episodes > row.worstLoopEps) {
        row.worstLoopEps = l.episodes;
        row.worstLoopWhere = `${l.character}@${Math.round(l.arcLo)}m s${seed}`;
      }
      if (l.kind === 'cycle' && l.episodes > worstCycle) {
        worstCycle = l.episodes;
        row.worstCycleWhere = `${l.character}@${Math.round(l.arcLo)}m s${seed}`;
      }
    }
    for (let i = 1; i < r.karts.length; i++) {
      const k = r.karts[i];
      row.pins += k.pins;
      row.stalls += k.stallEpisodes;
      row.contactSec += k.contactSeconds;
      row.episodes += k.episodes;
      row.longest = Math.max(row.longest, k.longestContact);
      row.respawns += k.respawns;
      row.recEntries += k.recoveryEntries;
      row.offTrack += k.offTrack;
      row.offEpisodes += k.offEpisodes;
      row.bigOff += k.bigOff;
      row.longestOff = Math.max(row.longestOff, k.longestOff);
      if (!k.finished) row.noFinish++;
    }
    if (detail || (r.loops.length > 0 && !quiet)) printLoopReport(r, `${trackId} seed ${seed}`);
    if (quiet) {
      const worst = r.karts.slice(1).reduce((a, b) => (b.contactSeconds > a.contactSeconds ? b : a));
      console.log(
        `  ${trackId.padEnd(16)} s${String(seed).padStart(6)}` +
          `  lgcy ${String(r.legacyLoopCount).padStart(3)}` +
          `  CYC ${String(r.cycleCount).padStart(3)}` +
          `  grd ${String(r.grindCount).padStart(3)}` +
          `  brsh ${String(r.brushCount).padStart(3)}` +
          `  eps ${String(r.karts.slice(1).reduce((s2, k) => s2 + k.episodes, 0)).padStart(4)}` +
          `  cSec ${r.karts.slice(1).reduce((s2, k) => s2 + k.contactSeconds, 0).toFixed(1).padStart(6)}` +
          `  pins ${String(r.karts.slice(1).reduce((s2, k) => s2 + k.pins, 0)).padStart(3)}` +
          `  stalls ${String(r.karts.slice(1).reduce((s2, k) => s2 + k.stallEpisodes, 0)).padStart(3)}` +
          `  noFin ${String(11 - r.aiFinished).padStart(2)}` +
          `  resp ${String(r.karts.slice(1).reduce((s2, k) => s2 + k.respawns, 0)).padStart(3)}` +
          `  offEp ${String(r.karts.slice(1).reduce((s2, k) => s2 + k.offEpisodes, 0)).padStart(3)}` +
          `  bigOff ${String(r.karts.slice(1).reduce((s2, k) => s2 + k.bigOff, 0)).padStart(3)}` +
          `  maxOff ${Math.max(...r.karts.slice(1).map((k) => k.longestOff)).toFixed(1)}s` +
          `  worst ${worst.character}/${worst.contactSeconds.toFixed(1)}s`,
      );
      const byKind = r.loops.slice().sort(
        (a, b) => (a.kind === 'cycle' ? -1 : 0) - (b.kind === 'cycle' ? -1 : 0) || b.episodes - a.episodes,
      );
      for (const l of byKind.slice(0, 6)) {
        const ms = Object.entries(l.modeSeconds).filter(([, v]) => v > 0)
          .map(([m, v]) => `${m} ${v.toFixed(1)}s`).join(', ');
        console.log(
          `        ${l.kind.toUpperCase().padEnd(5)} k${l.kart} ${l.character}/${l.personality} slot${l.gridSlot} t ${l.t0.toFixed(1)}-${l.t1.toFixed(1)}` +
            ` arc ${Math.round(l.arcLo)}-${Math.round(l.arcHi)} m  ${l.episodes} touches (${l.rawEpisodes} raw)/${l.seconds.toFixed(2)}s` +
            ` longest ${l.longestContact.toFixed(2)}s v${l.meanSpeed.toFixed(1)}` +
            ` failedRec ${l.failedRecoveries} recSec ${l.recoverySeconds.toFixed(2)}${l.respawned ? ' RESPAWN' : ''} [${ms}]`,
        );
      }
    }
    allLoops.push({ track: trackId, seed, report: r });
  }
  rows.push(row);
}

console.log(
  '\n\n================ SUMMARY (per race, AI field only) ================',
);
console.log(
  'circuit           runs  legacy  CYCLE  grind  brush cycKt loopKt worstLoop  where                    pins stalls  cSec longest  eps  noFin resp recEnt  offT offEp bigOff maxOff',
);
for (const r of rows) {
  const n = Math.max(1, r.runs);
  console.log(
    `${r.track.padEnd(17)} ${String(r.runs).padStart(4)} ` +
      `${(r.loops / n).toFixed(2).padStart(6)} ${(r.cycles / n).toFixed(2).padStart(6)} ` +
      `${(r.grinds / n).toFixed(2).padStart(6)} ${(r.brushes / n).toFixed(2).padStart(6)} ` +
      `${(r.cycleKarts / n).toFixed(2).padStart(5)} ${(r.loopKarts / n).toFixed(2).padStart(6)} ` +
      `${String(r.worstLoopEps).padStart(9)}  ${r.worstLoopWhere.padEnd(24)}` +
      `${(r.pins / n).toFixed(1).padStart(5)} ${(r.stalls / n).toFixed(1).padStart(6)} ` +
      `${(r.contactSec / n).toFixed(1).padStart(5)} ${r.longest.toFixed(1).padStart(7)} ` +
      `${(r.episodes / n).toFixed(1).padStart(5)} ${String(r.noFinish).padStart(5)} ` +
      `${(r.respawns / n).toFixed(1).padStart(4)} ${(r.recEntries / n).toFixed(1).padStart(6)} ` +
      `${(r.offTrack / n).toFixed(1).padStart(5)} ${(r.offEpisodes / n).toFixed(1).padStart(5)} ` +
      `${(r.bigOff / n).toFixed(1).padStart(6)} ${r.longestOff.toFixed(1).padStart(6)}`,
  );
}

// Global census: which racer, which circuit, which arc, which state.
interface Cell { n: number; eps: number; raw: number; secs: number; longest: number; failed: number; modes: Record<string, number> }
const censusOf = (kinds: ReadonlySet<string>): Map<string, Cell> => {
  const m = new Map<string, Cell>();
  for (const { track, report } of allLoops) {
    for (const l of report.loops) {
      if (!kinds.has(l.kind)) continue;
      const key = `${track}|${Math.round(l.arcLo / 40) * 40}|${l.character}`;
      const c = m.get(key) ?? { n: 0, eps: 0, raw: 0, secs: 0, longest: 0, failed: 0, modes: {} };
      c.n++;
      c.eps += l.episodes;
      c.raw += l.rawEpisodes;
      c.secs += l.seconds;
      c.failed += l.failedRecoveries;
      c.longest = Math.max(c.longest, l.longestContact);
      for (const [mm, v] of Object.entries(l.modeSeconds)) c.modes[mm] = (c.modes[mm] ?? 0) + v;
      m.set(key, c);
    }
  }
  return m;
};
const printCensus = (title: string, kinds: ReadonlySet<string>, emptyMsg: string): void => {
  const census = censusOf(kinds);
  if (!census.size) {
    console.log(`\n${title}: ${emptyMsg}`);
    return;
  }
  console.log(`\n${title}  (circuit | arc bucket 40 m | racer)`);
  const list = [...census.entries()].sort((a, b) => b[1].eps - a[1].eps);
  for (const [k, c] of list.slice(0, 40)) {
    const ms = Object.entries(c.modes)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([m, v]) => `${m} ${v.toFixed(0)}s`)
      .join(' ');
    console.log(
      `  ${k.padEnd(46)} n=${String(c.n).padStart(3)} touches=${String(c.eps).padStart(4)}` +
        ` (raw ${String(c.raw).padStart(4)}) contact=${c.secs.toFixed(2).padStart(6)}s` +
        ` longest=${c.longest.toFixed(2)}s failedRec=${String(c.failed).padStart(3)}  [${ms}]`,
    );
  }
};
printCensus(
  'FAILED-RECOVERY CYCLE CENSUS',
  new Set(['cycle']),
  'EMPTY — no NPC hit a barrier, failed a recovery and hit it again in any run.',
);
printCensus('GRIND CENSUS', new Set(['grind']), 'empty.');
printCensus('BRUSH CENSUS (not the reported defect)', new Set(['brush']), 'empty.');

const tot = (f: (r: LoopReport) => number): number => allLoops.reduce((s, a) => s + f(a.report), 0);
const races = Math.max(1, allLoops.length);
console.log(
  `\n================ VERDICT over ${allLoops.length} races ================\n` +
    `  legacy loops (raw edges, no recovery test) : ${tot((r) => r.legacyLoopCount)}` +
    `  (${(tot((r) => r.legacyLoopCount) / races).toFixed(2)} per race)\n` +
    `  FAILED-RECOVERY CYCLES                     : ${tot((r) => r.cycleCount)}` +
    `  (${(tot((r) => r.cycleCount) / races).toFixed(2)} per race)\n` +
    `  grinds (heavy, no recovery attempted)      : ${tot((r) => r.grindCount)}` +
    `  (${(tot((r) => r.grindCount) / races).toFixed(2)} per race)\n` +
    `  cornering brushes                          : ${tot((r) => r.brushCount)}` +
    `  (${(tot((r) => r.brushCount) / races).toFixed(2)} per race)\n` +
    `  pins (continuous contact >= 1.0 s)         : ${tot((r) => r.karts.slice(1).reduce((s, k) => s + k.pins, 0))}\n` +
    `  stalls (2.5 s of contact in any 8 s)       : ${tot((r) => r.karts.slice(1).reduce((s, k) => s + k.stallEpisodes, 0))}\n` +
    `  longest single contact, any kart, any race : ${Math.max(0, ...allLoops.map((a) => Math.max(0, ...a.report.karts.slice(1).map((k) => k.longestContact)))).toFixed(2)} s\n` +
    `  recovery entries / retries / respawns      : ${tot((r) => r.karts.slice(1).reduce((s, k) => s + k.recoveryEntries, 0))}` +
    ` / ${tot((r) => r.karts.slice(1).reduce((s, k) => s + k.recoveryRetries, 0))}` +
    ` / ${tot((r) => r.karts.slice(1).reduce((s, k) => s + k.respawns, 0))}`,
);
