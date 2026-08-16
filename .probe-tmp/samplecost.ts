/**
 * What the two extra smooth channels cost `sampleAtDistance`.
 *
 * `scalarAtParam` is 4 array loads, 3 multiply-adds and a clamp on a parameter
 * the caller has already solved for, so the claim is that adding two of them to
 * a call that already does an eval, a derivative, a second derivative, a
 * transported normal and two other channels is noise. This measures it against
 * the one thing in the file with a comparable shape.
 *
 * usage: node src/dev/node-run.mjs .probe-tmp/samplecost.ts [id] [iters]
 */
import { loadTrack } from '@/dev/headless';
import { makeAttribs, makeSample } from '@/track/TrackSpline';

const id = process.argv[3] ?? 'bostonHarbor';
const N = Number(process.argv[4] ?? 2_000_000);
const track = await loadTrack(id);
const spline = track.spline;
const L = track.lapLength;
const out = makeSample();
const at = makeAttribs();

const bench = (label: string, fn: (d: number) => void): number => {
  for (let i = 0; i < 200_000; i++) fn((i * 0.911) % L);   // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) fn((i * 0.911) % L);
  const ns = Number(process.hrtime.bigint() - t0) / N;
  console.log(`  ${label.padEnd(34)} ${ns.toFixed(1)} ns/call`);
  return ns;
};

console.log(`${id}: ${N.toLocaleString()} calls each\n`);
const full = bench('sampleAtDistance (with shoulders)', (d) => { spline.sampleAtDistance(d, out); });
const attr = bench('attribsAtDistance', (d) => { spline.attribsAtDistance(d, at); });
// Two `scalarAtParam` calls, isolated: `attribsAtDistance` does four of them
// plus one `paramAtDistance`, so half of (attribs - paramAtDistance) is a fair
// upper bound on what was added.
const par = bench('paramAtDistance only', (d) => { spline.nodeIndexAtDistance(d); });
const added = Math.max(0, (attr - par) / 2);
console.log(
  `\n  two extra scalarAtParam <= ${added.toFixed(1)} ns, i.e. <= ${(100 * added / full).toFixed(1)} % ` +
  `of a sampleAtDistance (${full.toFixed(1)} ns)`,
);
process.exit(0);
