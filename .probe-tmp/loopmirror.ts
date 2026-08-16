/**
 * ============================================================================
 *  CLASSIFIER MIRROR TEST — can `scanLoops` tell the two failures apart?
 * ============================================================================
 *
 *  `pintest.ts` proved the SHIPPED contact counter is duration-blind in one
 *  direction: 21.83 s of unbroken scrape scored 1, the same as a kerb clip.
 *  This file tests the opposite direction on the LOOP classifier, which is the
 *  number the certification table quotes.
 *
 *  It drives `scanLoops` — the same function the race harness uses, not a copy
 *  — with hand-built episode lists, so the pass/fail is about the classifier
 *  and nothing else. Every case states what the ORIGINAL detector said and what
 *  the refined one must say.
 *
 *  A refined classifier that simply stopped detecting anything would pass every
 *  "must be zero" case. Cases D/E/F exist so that cannot happen: they must be
 *  non-zero, or this file fails.
 *
 *   node src/dev/node-run.mjs .probe-tmp/loopmirror.ts
 * ============================================================================
 */
import {
  scanLoops, mergeChatter, type Episode, type LoopKind,
  LOOP_N, LOOP_WINDOW, LOOP_ARC, EP_MERGE_GAP, GRIND_SECONDS, RECOVERY_MIN,
} from './loopdet';

const LAP = 1536;

/** Build one contact episode. `arc` defaults to a plausible spot in one corner. */
const ep = (t0: number, dur: number, arc: number): Episode => ({
  kart: 3, t0, dur, arc, mode: 'race', speed: 30, depth: 0.05,
});

interface Case {
  name: string;
  why: string;
  eps: Episode[];
  /** [start, end) spans in reverse/realign. */
  rec: Array<[number, number]>;
  expectLegacy: number;
  expectCycles: number;
  /** Optional: exact expected kinds, in order. */
  expectKinds?: LoopKind[];
}

const cases: Case[] = [
  // ---- MUST BE ZERO CYCLES -------------------------------------------------
  {
    name: 'A. chatter — the volcanoRush nova reading',
    why: '8 rising edges inside 0.2 s at 34 m/s: one scrape the probe re-triggered on.',
    eps: [
      ep(40.00, 0.02, 1051), ep(40.03, 0.02, 1052), ep(40.06, 0.03, 1053),
      ep(40.10, 0.02, 1054), ep(40.13, 0.03, 1055), ep(40.17, 0.02, 1056),
      ep(40.20, 0.02, 1057), ep(40.23, 0.04, 1058),
    ],
    rec: [],
    expectLegacy: 1,
    expectCycles: 0,
    expectKinds: [],   // merges to ONE touch — not even a cluster
  },
  {
    name: 'B. cornering brushes — the hongKongHarbour arc-240 reading',
    why: '3 separate short touches over 1.4 s in one corner, driver in `race` throughout.',
    eps: [ep(63.0, 0.05, 238), ep(63.7, 0.04, 250), ep(64.4, 0.05, 262)],
    rec: [],
    expectLegacy: 1,
    expectCycles: 0,
    expectKinds: ['brush'],
  },
  {
    name: 'C. brushes with a recovery that is NOT between them',
    why: 'A recovery 30 s later must not retro-label an earlier corner clip.',
    eps: [ep(10.0, 0.05, 300), ep(10.6, 0.05, 312), ep(11.2, 0.05, 324)],
    rec: [[40.0, 43.0]],
    expectLegacy: 1,
    expectCycles: 0,
    expectKinds: ['brush'],
  },
  {
    name: 'D. isolated touches, far apart',
    why: 'Below the count/window/arc test entirely. Must produce nothing at all.',
    eps: [ep(10, 0.1, 100), ep(30, 0.1, 700), ep(55, 0.1, 1300)],
    rec: [],
    expectLegacy: 0,
    expectCycles: 0,
    expectKinds: [],
  },
  {
    name: 'E. mode flicker, one tick of realign',
    why: `A ${(1 / 120).toFixed(4)} s blip is below RECOVERY_MIN=${RECOVERY_MIN} s: not a recovery attempt.`,
    eps: [ep(20.0, 0.05, 400), ep(21.0, 0.05, 412), ep(22.0, 0.05, 424)],
    rec: [[20.5, 20.5 + 1 / 120]],
    expectLegacy: 1,
    expectCycles: 0,
    expectKinds: ['brush'],
  },

  // ---- MUST BE NON-ZERO ----------------------------------------------------
  {
    name: 'F. THE DEFECT — hit, recover, hit again, three times',
    why: 'Contact, 1.2 s of reverse/realign, contact again, in one place. A limit cycle.',
    eps: [ep(50.0, 1.0, 600), ep(53.0, 1.1, 606), ep(56.5, 1.2, 612)],
    rec: [[51.2, 52.6], [54.2, 55.9]],
    expectLegacy: 1,
    expectCycles: 1,
    expectKinds: ['cycle'],
  },
  {
    name: 'G. recovery already running before the first contact',
    why: 'Kart is knocked off, enters recovery, then bounces the wall three times.',
    eps: [ep(80.0, 0.4, 900), ep(82.0, 0.5, 905), ep(84.0, 0.6, 910)],
    rec: [[79.0, 86.0]],
    expectLegacy: 1,
    expectCycles: 1,
    expectKinds: ['cycle'],
  },
  {
    name: 'H. GRIND — heavy repeated contact the AI never noticed',
    why: `No recovery at all, but ${GRIND_SECONDS}+ s on the barrier. Player-visible, still not a cycle.`,
    eps: [ep(100.0, 0.7, 200), ep(101.5, 0.8, 208), ep(103.5, 0.9, 216)],
    rec: [],
    expectLegacy: 1,
    expectCycles: 0,
    expectKinds: ['grind'],
  },
  {
    name: 'I. chatter INSIDE a real cycle still reads as a cycle',
    why: 'Merging must not destroy a genuine loop that happens to have noisy contacts.',
    eps: [
      ep(120.00, 0.30, 500), ep(120.35, 0.30, 501), // merges to one 0.65 s touch
      ep(123.00, 0.50, 505),
      ep(126.00, 0.50, 510),
    ],
    rec: [[121.0, 122.5], [124.0, 125.5]],
    expectLegacy: 1,
    expectCycles: 1,
    expectKinds: ['cycle'],
  },
];

console.log(
  'CLASSIFIER MIRROR TEST — scanLoops(), the same function the race harness calls\n' +
    `  cluster  = ${LOOP_N}+ touches within ${LOOP_WINDOW} s and ${LOOP_ARC} m\n` +
    `  merge    = contacts under ${EP_MERGE_GAP} s apart are one touch\n` +
    `  CYCLE    = cluster with >= ${RECOVERY_MIN} s of reverse/realign between two contacts\n` +
    `  GRIND    = cluster, no recovery, >= ${GRIND_SECONDS} s contact\n` +
    `  BRUSH    = cluster, no recovery, short contact\n`,
);

let failures = 0;
for (const c of cases) {
  const merged = mergeChatter(c.eps);
  const r = scanLoops(c.eps, c.rec, LAP);
  const cycles = r.clusters.filter((x) => x.kind === 'cycle').length;
  const kinds = r.clusters.map((x) => x.kind);
  const okLegacy = r.legacyLoops === c.expectLegacy;
  const okCycles = cycles === c.expectCycles;
  const okKinds = c.expectKinds === undefined || kinds.join(',') === c.expectKinds.join(',');
  const ok = okLegacy && okCycles && okKinds;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : '**FAIL**'}  ${c.name}`);
  console.log(`        ${c.why}`);
  console.log(
    `        ${c.eps.length} raw contacts -> ${merged.length} touches` +
      `   legacy ${r.legacyLoops} (want ${c.expectLegacy})` +
      `   cycles ${cycles} (want ${c.expectCycles})` +
      `   kinds [${kinds.join(',') || '-'}]` +
      (c.expectKinds ? ` (want [${c.expectKinds.join(',') || '-'}])` : ''),
  );
  for (const cl of r.clusters) {
    console.log(
      `          ${cl.kind.toUpperCase().padEnd(5)} t ${cl.t0.toFixed(2)}..${cl.t1.toFixed(2)}` +
        ` arc ${Math.round(cl.arcLo)}..${Math.round(cl.arcHi)} m  ${cl.episodes} touches (${cl.rawEpisodes} raw)` +
        ` contact ${cl.seconds.toFixed(2)} s  longest ${cl.longestContact.toFixed(2)} s` +
        `  failedRec ${cl.failedRecoveries}  recSec ${cl.recoverySeconds.toFixed(2)}`,
    );
  }
  console.log('');
}

// The anti-vacuity check: this file is worthless if nothing ever fires.
const totalCycles = cases.reduce(
  (s, c) => s + scanLoops(c.eps, c.rec, LAP).clusters.filter((x) => x.kind === 'cycle').length, 0,
);
const totalClusters = cases.reduce((s, c) => s + scanLoops(c.eps, c.rec, LAP).clusters.length, 0);
if (totalCycles === 0) {
  failures++;
  console.log('**FAIL**  vacuity: the classifier produced ZERO cycles across every case, ' +
    'including the ones built to be cycles. It detects nothing.');
}
if (totalClusters === 0) {
  failures++;
  console.log('**FAIL**  vacuity: the classifier produced ZERO clusters of any kind.');
}

console.log(
  `\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — ` +
    `${cases.length} cases, ${totalCycles} cycles and ${totalClusters} clusters fired in total`,
);
process.exitCode = failures === 0 ? 0 : 1;
