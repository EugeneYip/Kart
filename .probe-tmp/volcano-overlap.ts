/**
 * Is Volcano Rush's "backwards" arc-walk step a marker defect, or two decks
 * stacked in XZ? Find the self-overlaps of the centreline in the XZ plane and
 * report their vertical separation.
 */
import { loadTrack } from '@/dev/headless';

const track = await loadTrack('volcanoRush');
const L = track.lapLength;
const N = 220;

const pts: { x: number; y: number; z: number; d: number }[] = [];
for (let i = 0; i < N; i++) {
  const d = (i / N) * L;
  const s = track.sampleAtDistance(d);
  pts.push({ x: s.position.x, y: s.position.y, z: s.position.z, d });
}

console.log(`volcanoRush: lap ${L.toFixed(0)} m, ${N} centreline samples`);
console.log('XZ self-overlaps closer than 25 m but more than 150 m apart along the lap:');

let worst = { xz: Infinity, dy: 0, a: -1, b: -1, arc: 0 };
let count = 0;
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    const arc = Math.min(Math.abs(pts[j].d - pts[i].d), L - Math.abs(pts[j].d - pts[i].d));
    if (arc < 150) continue;
    const xz = Math.hypot(pts[j].x - pts[i].x, pts[j].z - pts[i].z);
    if (xz > 25) continue;
    count++;
    const dy = Math.abs(pts[j].y - pts[i].y);
    if (xz < worst.xz) worst = { xz, dy, a: i, b: j, arc };
  }
}
console.log(`  ${count} overlapping sample pairs`);
if (worst.a >= 0) {
  console.log(
    `  closest: vertex ${worst.a} (arc ${pts[worst.a].d.toFixed(0)} m, y ${pts[worst.a].y.toFixed(1)} m)`
    + `  vs vertex ${worst.b} (arc ${pts[worst.b].d.toFixed(0)} m, y ${pts[worst.b].y.toFixed(1)} m)`,
  );
  console.log(
    `           ${worst.xz.toFixed(2)} m apart in XZ, ${worst.dy.toFixed(2)} m apart vertically,`
    + ` ${worst.arc.toFixed(0)} m apart along the lap, ${worst.b - worst.a} ribbon vertices apart`,
  );
}

// Elevation range, to characterise the multi-level sections.
let lo = Infinity, hi = -Infinity;
for (const p of pts) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
console.log(`  centreline elevation ${lo.toFixed(1)} .. ${hi.toFixed(1)} m (range ${(hi - lo).toFixed(1)} m)`);
