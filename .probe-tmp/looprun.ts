/**
 * Driver for `loopdet.ts`.
 *
 *   node src/dev/node-run.mjs .probe-tmp/looprun.ts <tracks> <seeds> <laps> <flags>
 *
 * flags: comma list of  items,noitems,human,nohuman,displace,red,detail
 */
import { runLoopRace, printLoopReport, type LoopReport, LOOP_N, LOOP_WINDOW, LOOP_ARC } from './loopdet';
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
    `displacement ${displace ? 'ON' : 'off'}${red ? ', RED CONTROL (kart 5 driven into barrier)' : ''}` +
    `${stale ? `, STALE-LINE sequence (AI built on ${staleFrom ?? 'the previous circuit'}, then track swapped)` : ''}\n` +
    `loop = ${LOOP_N}+ contacts within ${LOOP_WINDOW} s and ${LOOP_ARC} m\n`,
);

interface Row {
  track: string;
  runs: number;
  loops: number;
  loopKarts: number;
  worstLoopEps: number;
  worstLoopWhere: string;
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
    track: trackId, runs: 0, loops: 0, loopKarts: 0, worstLoopEps: 0, worstLoopWhere: '-',
    pins: 0, stalls: 0, contactSec: 0, longest: 0, episodes: 0, noFinish: 0,
    respawns: 0, recEntries: 0, offTrack: 0, offEpisodes: 0, bigOff: 0, longestOff: 0,
  };
  for (const seed of seeds) {
    const r = await runLoopRace({
      trackId, seed, targetLaps: laps, capSeconds: cap, cc,
      items, humanPlayer: human, displace, red, playerPace, playerGridSlot,
      staleLineFrom: stale ? (staleFrom ?? prevOf(trackId)) : undefined,
    });
    row.runs++;
    row.loops += r.loops.length;
    const lk = new Set(r.loops.map((l) => l.kart));
    row.loopKarts += lk.size;
    for (const l of r.loops) {
      if (l.episodes > row.worstLoopEps) {
        row.worstLoopEps = l.episodes;
        row.worstLoopWhere = `${l.character}@${Math.round(l.arcLo)}m s${seed}`;
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
        `  ${trackId.padEnd(16)} s${String(seed).padStart(6)}  loops ${String(r.loops.length).padStart(3)}` +
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
      for (const l of r.loops.slice().sort((a, b) => b.episodes - a.episodes).slice(0, 4)) {
        const ms = Object.entries(l.modeSeconds).filter(([, v]) => v > 0)
          .map(([m, v]) => `${m} ${v.toFixed(1)}s`).join(', ');
        console.log(
          `        LOOP k${l.kart} ${l.character}/${l.personality} slot${l.gridSlot} t ${l.t0.toFixed(1)}-${l.t1.toFixed(1)}` +
            ` arc ${Math.round(l.arcLo)}-${Math.round(l.arcHi)} m  ${l.episodes} hits/${l.seconds.toFixed(1)}s` +
            ` v${l.meanSpeed.toFixed(1)} rec${l.recoveryEntries}${l.respawned ? ' RESPAWN' : ''} [${ms}]`,
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
  'circuit           runs  LOOPS loopKt worstLoop  where                    pins stalls  cSec longest  eps  noFin resp recEnt  offT offEp bigOff maxOff',
);
for (const r of rows) {
  const n = Math.max(1, r.runs);
  console.log(
    `${r.track.padEnd(17)} ${String(r.runs).padStart(4)} ` +
      `${(r.loops / n).toFixed(2).padStart(6)} ${(r.loopKarts / n).toFixed(2).padStart(6)} ` +
      `${String(r.worstLoopEps).padStart(9)}  ${r.worstLoopWhere.padEnd(24)}` +
      `${(r.pins / n).toFixed(1).padStart(5)} ${(r.stalls / n).toFixed(1).padStart(6)} ` +
      `${(r.contactSec / n).toFixed(1).padStart(5)} ${r.longest.toFixed(1).padStart(7)} ` +
      `${(r.episodes / n).toFixed(1).padStart(5)} ${String(r.noFinish).padStart(5)} ` +
      `${(r.respawns / n).toFixed(1).padStart(4)} ${(r.recEntries / n).toFixed(1).padStart(6)} ` +
      `${(r.offTrack / n).toFixed(1).padStart(5)} ${(r.offEpisodes / n).toFixed(1).padStart(5)} ` +
      `${(r.bigOff / n).toFixed(1).padStart(6)} ${r.longestOff.toFixed(1).padStart(6)}`,
  );
}

// Global loop census: which racer, which circuit, which arc, which state.
const census = new Map<string, { n: number; eps: number; secs: number; modes: Record<string, number> }>();
for (const { track, report } of allLoops) {
  for (const l of report.loops) {
    const key = `${track}|${Math.round(l.arcLo / 40) * 40}|${l.character}`;
    const c = census.get(key) ?? { n: 0, eps: 0, secs: 0, modes: {} };
    c.n++;
    c.eps += l.episodes;
    c.secs += l.seconds;
    for (const [m, v] of Object.entries(l.modeSeconds)) c.modes[m] = (c.modes[m] ?? 0) + v;
    census.set(key, c);
  }
}
if (census.size) {
  console.log('\nLOOP CENSUS  (circuit | arc bucket 40 m | racer)  -> occurrences, contacts, contact-seconds, mode mix');
  const list = [...census.entries()].sort((a, b) => b[1].eps - a[1].eps);
  for (const [k, c] of list.slice(0, 40)) {
    const ms = Object.entries(c.modes)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([m, v]) => `${m} ${v.toFixed(0)}s`)
      .join(' ');
    console.log(`  ${k.padEnd(46)} n=${String(c.n).padStart(3)} hits=${String(c.eps).padStart(4)} contact=${c.secs.toFixed(1).padStart(6)}s  [${ms}]`);
  }
} else {
  console.log('\nLOOP CENSUS: empty — no loop matched the detector in any run.');
}
