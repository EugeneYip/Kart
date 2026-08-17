/**
 * Why does the brush arm produce N legacy loops but no clusters at all?
 *
 * Prints kart 5's raw contact timeline and what `mergeChatter` does to it, so
 * "the refined classifier found nothing" can be checked against "there was
 * nothing there but chatter" rather than assumed.
 *
 *   node src/dev/node-run.mjs .probe-tmp/brushdump.ts <track> <seed> <flags>
 *   flags: red | brush
 */
import { runLoopRace, mergeChatter, scanLoops, EP_MERGE_GAP } from './loopdet';

const trackId = process.argv[3] ?? 'hongKongHarbour';
const seed = Number(process.argv[4] ?? 12345);
const mode = process.argv[5] ?? 'brush';

const r = await runLoopRace({
  trackId,
  seed,
  targetLaps: 3,
  capSeconds: 260,
  keepEpisodes: true,
  red: mode === 'red',
  brush: mode === 'brush',
});

const mine = r.episodes.filter((e) => e.kart === 5).sort((a, b) => a.t0 - b.t0);
const touches = mergeChatter(mine);
console.log(
  `\n${trackId} seed ${seed} — ${mode.toUpperCase()} arm, kart 5 (${r.karts[5].character})\n` +
    `  raw contact episodes : ${mine.length}\n` +
    `  after merging <${EP_MERGE_GAP} s : ${touches.length} touches\n` +
    `  legacy loops         : ${r.legacyLoopCount}\n` +
    `  cycles/grinds/brushes: ${r.cycleCount}/${r.grindCount}/${r.brushCount}\n`,
);

console.log('RAW EPISODES (t0, dur, gap-to-previous-end, arc):');
let prevEnd = -99;
for (const e of mine) {
  const gap = prevEnd < 0 ? NaN : e.t0 - prevEnd;
  console.log(
    `  t ${e.t0.toFixed(3).padStart(8)}  dur ${e.dur.toFixed(3)}  ` +
      `gap ${(Number.isNaN(gap) ? '   -  ' : gap.toFixed(3).padStart(6))}` +
      `${gap < EP_MERGE_GAP ? ' MERGE' : '      '}  arc ${e.arc.toFixed(0).padStart(5)} m  mode ${e.mode}`,
  );
  prevEnd = e.t0 + e.dur;
}

console.log('\nMERGED TOUCHES (t0, dur, raw folded in, arc):');
for (const tt of touches) {
  console.log(
    `  t ${tt.t0.toFixed(3).padStart(8)}  dur ${tt.dur.toFixed(3)}  raw ${String(tt.raw).padStart(3)}  arc ${tt.arc.toFixed(0).padStart(5)} m`,
  );
}

// Why did each candidate window fail? Walk the merged touches and report the
// biggest run that satisfies the count test, and what stopped it.
const s = scanLoops(mine, [], r.lapLength);
console.log(`\nclusters from merged touches: ${s.clusters.length}`);
let best = 0;
let bestAt = -1;
for (let j = 0; j < touches.length; j++) {
  let k = j;
  while (
    k + 1 < touches.length &&
    touches[k + 1].t0 - touches[j].t0 <= 10 &&
    Math.abs(touches[k + 1].arc - touches[j].arc) <= 40
  ) k++;
  if (k - j + 1 > best) { best = k - j + 1; bestAt = j; }
}
console.log(
  `longest run of merged touches inside 10 s and 40 m: ${best}` +
    (bestAt >= 0 ? ` starting t ${touches[bestAt].t0.toFixed(2)} arc ${touches[bestAt].arc.toFixed(0)} m` : ''),
);
