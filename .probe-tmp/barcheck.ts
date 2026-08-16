/**
 * Sanity check on `RacingLine.debugBarrier()`: the measured centreline-to-barrier
 * distance must be >= halfWidth everywhere, and on volcanoRush's spiral it must
 * land near the authored 9.5 + 0.7 + 1.4 + 0.12 = 11.72 m.
 */
import { loadTrack, TRACK_IDS } from '@/dev/headless';
import { RacingLine } from '@/ai/RacingLine';

for (const id of TRACK_IDS) {
  const track = await loadTrack(id);
  const line = new RacingLine(track, { stations: 600 });
  line.build();
  const b = line.debugBarrier();
  const h = line.debugHalfWidths();
  const gap: number[] = [];
  let inf = 0;
  let bad = 0;
  for (let i = 0; i < 600; i++) {
    if (!Number.isFinite(b[i])) { inf++; continue; }
    if (b[i] < h[i] - 1e-6) bad++;
    gap.push(b[i] - h[i]);
  }
  gap.sort((x, y) => x - y);
  const q = (f: number) => gap[Math.min(gap.length - 1, Math.floor(f * gap.length))];
  console.log(
    `${id.padEnd(18)} barrier-minus-halfWidth  min ${q(0).toFixed(2)}  p25 ${q(0.25).toFixed(2)} ` +
      ` med ${q(0.5).toFixed(2)}  max ${q(0.999).toFixed(2)} | no barrier: ${inf} stations | ` +
      `inside the road: ${bad}`,
  );
  if (id === 'volcanoRush') {
    const s = Math.round((900 / track.lapLength) * 600);
    console.log(`   spiral station ${s} (arc ~900 m): halfWidth ${h[s].toFixed(2)}  barrier ${b[s].toFixed(2)}`);
  }
}
