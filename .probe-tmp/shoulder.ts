/**
 * SHOULDER / BARRIER-CORRIDOR CENSUS, all circuits.
 *
 * `RacingLine.edgeMargin` is documented as "clearance kept from the road edge",
 * and the relaxation clamps the optimal line to `halfWidth - edgeMargin`. But the
 * thing a kart can HIT is not the road edge: `Track.collideWalls` puts the barrier
 * face at `halfWidth + kerb(0.7) + shoulder + 0.12`. So the clearance the constant
 * actually buys is `edgeMargin + 0.82 + shoulder` — and `shoulder` is authored
 * per-node, from 1.4 m to 8 m.
 *
 * This measures the consequence: for every circuit, the arc-weighted distribution
 * of line-to-barrier clearance, and how many metres of lap sit under a threshold
 * WHILE ALSO being a real corner. A tight corridor on a straight is harmless; a
 * tight corridor on a sustained corner is where a kart with any line error at all
 * ends up in the rail.
 *
 * usage: node src/dev/node-run.mjs .probe-tmp/shoulder.ts [thresholdM]
 */

import { loadTrack, TRACK_IDS } from '@/dev/headless';
import { RacingLine, createLineSample, type LineVariant } from '@/ai/RacingLine';
import { makeAttribs } from '@/track/TrackSpline';

const THRESH = Number(process.argv[3] ?? 6.0);
/** |curvature| above this counts as a corner (R < 100 m). */
const CORNER_K = 0.01;

const variants: LineVariant[] = ['optimal', 'inside', 'outside'];
const smp = createLineSample();
const attribs = makeAttribs();

console.log(
  `line-to-barrier corridor, threshold ${THRESH.toFixed(1)} m, corner = |k| > ${CORNER_K} (R < ${(1 / CORNER_K).toFixed(0)} m)\n`,
);
console.log(
  'circuit            shoulder min..max |  variant | clr min   p05   p25   med |  m<thr  m<thr&corner | worst run (m) @arc',
);

for (const id of TRACK_IDS) {
  const track = await loadTrack(id);
  const line = new RacingLine(track, { stations: 600, latAccel: 30, maxSpeed: 36 });
  line.build();
  const L = track.lapLength;
  const n = 600;
  const step = L / n;

  let shMin = 1e9;
  let shMax = -1e9;
  for (let i = 0; i < n; i++) {
    track.spline.attribsAtDistance((i / n) * L, attribs);
    shMin = Math.min(shMin, attribs.shoulderL, attribs.shoulderR);
    shMax = Math.max(shMax, attribs.shoulderL, attribs.shoulderR);
  }

  for (const v of variants) {
    const clr: number[] = [];
    let under = 0;
    let underCorner = 0;
    let run = 0;
    let bestRun = 0;
    let bestAt = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      line.sample(t, smp, v);
      track.spline.attribsAtDistance(t * L, attribs);
      const a = attribs;
      // Barrier faces, signed lateral from the centreline. `none` = no barrier.
      const faceR = a.wallR === 'none' ? 1e9 : a.halfWidth + 0.7 + a.shoulderR + 0.12;
      const faceL = a.wallL === 'none' ? -1e9 : -(a.halfWidth + 0.7 + a.shoulderL + 0.12);
      const c = Math.min(faceR - smp.lateral, smp.lateral - faceL);
      clr.push(c);
      const corner = Math.abs(smp.curvature) > CORNER_K;
      if (c < THRESH) {
        under += step;
        if (corner) {
          underCorner += step;
          run += step;
          if (run > bestRun) {
            bestRun = run;
            bestAt = t * L;
          }
        } else run = 0;
      } else run = 0;
    }
    clr.sort((x, y) => x - y);
    const q = (f: number): number => clr[Math.min(clr.length - 1, Math.floor(f * clr.length))];
    console.log(
      `${(v === 'optimal' ? id : '').padEnd(18)} ` +
        `${(v === 'optimal' ? `${shMin.toFixed(1)}..${shMax.toFixed(1)}` : '').padStart(13)} | ` +
        `${v.padEnd(7)} | ${q(0).toFixed(2).padStart(6)} ${q(0.05).toFixed(2).padStart(5)} ` +
        `${q(0.25).toFixed(2).padStart(5)} ${q(0.5).toFixed(2).padStart(5)} | ` +
        `${under.toFixed(0).padStart(5)} ${underCorner.toFixed(0).padStart(13)} | ` +
        `${bestRun.toFixed(0).padStart(9)} @${bestAt.toFixed(0)}`,
    );
  }
  console.log('');
}
