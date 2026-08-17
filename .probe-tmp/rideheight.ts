/**
 * ============================================================================
 *  HOW HIGH DOES A KART ACTUALLY GET ABOVE THE ROAD?
 * ============================================================================
 *  The envelope audit's ceiling — `DRIVE_HEIGHT = 3.0 m` — is defended in
 *  `propfoot.ts` with "a kart is ~1.4 m tall, anything higher is scenery
 *  overhead". `.probe-tmp/kartsize.ts` confirms the 1.4: the tallest of the 72
 *  driver x chassis rigs is 1.400 m from the contact patch to the crown of the
 *  driver's head.
 *
 *  But a static height is only half the argument. A kart hops, it lands on its
 *  suspension, it gets thrown by a shell, and it leaves the road at every ramp
 *  and jump on the circuit. If the top of a kart routinely passes 2.5 m over
 *  the tarmac then "2.9 m of clearance" is not the comfortable margin it looks
 *  like. So MEASURE the dynamic part instead of asserting it away.
 *
 *  Method: a real 12-kart AI field with items on, the same construction
 *  `.probe-tmp/loopdet.ts` uses (`AIManager` + `AIDriver` for the player slot +
 *  `ItemSystem`), stepped at `FIXED_DT`. Every tick, every kart's body origin
 *  is seated on the DRAWN ROAD RIBBON — the same ground truth as the prop
 *  audit, not a centreline — and the rise above the kart's own resting ride
 *  height is accumulated.
 *
 *      top of the kart above the tarmac  =  1.400 m  +  rise(t)
 *
 *  where `rise` is measured, and 1.400 is the tallest rig. Reported per
 *  circuit as a whole-lap maximum, and again restricted to a window of arc
 *  around a named station — because the question that decides a finding is not
 *  "how high does a kart get on this circuit" (a ramp answers that) but "how
 *  high does a kart get UNDER THAT ARCH".
 *
 *  usage: node src/dev/node-run.mjs .probe-tmp/rideheight.ts <ids|all>
 *           [--seconds=90] [--arcs=<id>:<arc>,...] [--window=25]
 *           [--breakride]  sabotage arm: freeze the rise at 0. The arms that
 *                          say the measurement is live must go red.
 * ============================================================================
 */
import * as THREE from 'three';
import { loadTrack, makeField, makeCtx } from '@/dev/headless';
import { AIManager } from '@/ai/AIManager';
import { AIDriver, type DriverWorld } from '@/ai/AIDriver';
import { personalityById, personalityForKart } from '@/ai/AIPersonality';
import { createBandOutput } from '@/ai/Rubberband';
import { FIXED_DT } from '@/core/Config';
import { makeTuning } from '@/physics/Tuning';
import { CHARACTERS } from '@/karts/Characters';
import { ItemSystem } from '@/items/ItemSystem';
import { TRACK_ORDER } from '@/track/TrackDefs';
import { ribbonSoup, seat, Verdict, K_ROAD } from './ribbon';

const ARGS = process.argv.slice(3);
const ONLY = ARGS.filter((a) => !a.startsWith('--'));
const IDS: readonly string[] = (ONLY.length === 0 || ONLY[0] === 'all') ? TRACK_ORDER : ONLY;
const SECONDS = Number((ARGS.find((a) => a.startsWith('--seconds=')) ?? '--seconds=90').slice(10));
const WINDOW = Number((ARGS.find((a) => a.startsWith('--window=')) ?? '--window=25').slice(9));
const BREAK_RIDE = ARGS.includes('--breakride');
/** `<circuit>:<arc>` pairs — the stations a prop finding sits at. */
const ARCS = new Map<string, number[]>();
for (const a of (ARGS.find((x) => x.startsWith('--arcs=')) ?? '--arcs=').slice(7).split(',')) {
  if (!a) continue;
  const [id, arc] = a.split(':');
  if (!ARCS.has(id)) ARCS.set(id, []);
  ARCS.get(id)!.push(Number(arc));
}

const FIELD = 12;
const ROSTER = CHARACTERS.slice(0, 12).map((c) => c.id);
/** Tallest rig on the roster, measured by `.probe-tmp/kartsize.ts`. */
const KART_TOP = 1.400;

let fails = 0;

console.log(`\nKART RIDE HEIGHT OVER THE DRAWN ROAD — ${FIELD} karts, items on, `
  + `${SECONDS} s per circuit, ground truth = the road ribbon`
  + `${BREAK_RIDE ? '   [--breakride: rise frozen at 0]' : ''}\n`);

interface Out { id: string; lapMax: number; groundedMax: number; airTicks: number;
  ticks: number; rest: number; win: Array<{ arc: number; max: number; groundedMax: number; n: number }>; }
const outs: Out[] = [];

for (const id of IDS) {
  const track = await loadTrack(id);
  const soup = ribbonSoup(track);
  const { physics, karts } = makeField(track, FIELD, 150);
  const ai = new AIManager(track, { states: karts }, undefined, {});
  ai.init();
  for (let i = 0; i < FIELD; i++) physics.setTuning(i, makeTuning(ROSTER[i], 150));
  for (let i = 0; i < FIELD; i++) {
    const st = track.getStartPosition(i);
    physics.place(i, st.position, st.quaternion);
  }
  const scene = new THREE.Scene();
  const items = new ItemSystem(
    scene,
    track as unknown as ConstructorParameters<typeof ItemSystem>[1],
    { karts, player: karts[0] },
    physics as unknown as ConstructorParameters<typeof ItemSystem>[3],
    {},
  );
  await items.init();
  ai.setItems(items);
  ai.setPhysics(physics);
  ai.setDifficulty(150);
  ai.resetRace();
  ai.setRaceStarted(true);
  ai.newFieldSeed(20260816);
  const line = ai.racingLine;
  if (!line) throw new Error('no racing line');

  const pPers = personalityById('clean') ?? personalityForKart(2);
  const player = new AIDriver(0, pPers, ai.rubberband.profile());
  player.setState(karts[0]);
  player.enabled = true;
  player.setForm({ pace: 0.97, mistake: 1, error: 1, drift: 1 });
  const neutral = createBandOutput();
  const pWorld: DriverWorld = {
    line, walls: track, karts, hazards: [], hazardCount: 0, elapsed: 0,
    raceStarted: true, countdown: 0, playerProgress: 0, playerId: 0,
    lapLength: line.lapLength, fieldSize: FIELD, cc: ai.rubberband.profile(),
  };

  const ctx = makeCtx(FIXED_DT);
  const steps = Math.round(SECONDS / FIXED_DT);
  /** Per-kart resting body-origin height over the ribbon, learned on the fly. */
  const rest = new Array<number>(FIELD).fill(NaN);
  let lapMax = 0, groundedMax = 0, airTicks = 0, ticks = 0;
  const wins = (ARCS.get(id) ?? []).map((arc) => ({ arc, max: 0, groundedMax: 0, n: 0 }));

  for (let s = 0; s < steps; s++) {
    const t = s * FIXED_DT;
    pWorld.elapsed = t;
    pWorld.playerProgress = karts[0].progress;
    physics.setControl(0, player.step(FIXED_DT, pWorld, neutral));
    ai.fixedUpdate(ctx);
    items.fixedUpdate(ctx);
    physics.fixedUpdate(ctx);
    (ctx as { elapsed: number }).elapsed += FIXED_DT;
    (ctx as { frame: number }).frame++;
    if (t < 3) continue;                       // let the grid settle

    for (let i = 0; i < FIELD; i++) {
      const k = karts[i];
      const st = seat(soup, k.position.x, k.position.y, k.position.z, 1e9);
      if (st.kind !== K_ROAD || st.verdict === Verdict.NoRibbon || st.verdict === Verdict.UnderAll) continue;
      ticks++;
      // The resting ride height is the LOWEST grounded reading seen — a kart on
      // its bump stops. Using a mean would let a lap of small hops inflate the
      // baseline and quietly shrink every rise measured against it.
      if (k.grounded && (Number.isNaN(rest[i]) || st.above < rest[i])) rest[i] = st.above;
      if (Number.isNaN(rest[i])) continue;
      const rise = BREAK_RIDE ? 0 : Math.max(0, st.above - rest[i]);
      if (!k.grounded) airTicks++;
      if (rise > lapMax) lapMax = rise;
      if (k.grounded && rise > groundedMax) groundedMax = rise;
      // `KartState.progress` is written by `RaceState`, which this harness does
      // not run, so it stays 0 here — using it would silently put every sample
      // in the arc-0 window. Project the position instead.
      const arcNow = track.project(k.position).distance;
      for (const w of wins) {
        let d = Math.abs(arcNow - w.arc);
        d = Math.min(d, track.lapLength - d);
        if (d > WINDOW) continue;
        w.n++;
        if (rise > w.max) w.max = rise;
        if (k.grounded && rise > w.groundedMax) w.groundedMax = rise;
      }
    }
  }

  const restMean = rest.filter((r) => !Number.isNaN(r)).reduce((a, b) => a + b, 0)
    / Math.max(1, rest.filter((r) => !Number.isNaN(r)).length);
  outs.push({ id, lapMax, groundedMax, airTicks, ticks, rest: restMean, win: wins });
  console.log(`${id.padEnd(18)} rest ride height ${restMean.toFixed(3)} m  |  `
    + `max rise anywhere ${lapMax.toFixed(3)} m (top of kart ${(KART_TOP + lapMax).toFixed(2)} m)  |  `
    + `max rise while GROUNDED ${groundedMax.toFixed(3)} m (top ${(KART_TOP + groundedMax).toFixed(2)} m)  |  `
    + `${((airTicks / Math.max(1, ticks)) * 100).toFixed(1)} % of samples airborne`);
  for (const w of wins) {
    console.log(`      within ${WINDOW} m of arc ${w.arc}: ${w.n} kart-ticks, `
      + `max rise ${w.max.toFixed(3)} m -> TOP OF KART ${(KART_TOP + w.max).toFixed(2)} m above the road`
      + `  (grounded only ${(KART_TOP + w.groundedMax).toFixed(2)} m)`);
  }
  items.dispose?.();
}

// --- RED CHECKS ------------------------------------------------------------
// A ride-height probe that reports 0.000 everywhere would "prove" any clearance
// safe. Two arms make that impossible to miss.
console.log('\nRED CHECKS');
{
  const anyRise = outs.some((o) => o.lapMax > 0.05);
  console.log(`  ${anyRise ? 'PASS' : '*** FAIL'}  karts DO leave their resting ride height`.padEnd(58)
    + ` biggest rise ${Math.max(...outs.map((o) => o.lapMax)).toFixed(3)} m`
    + `${anyRise ? '' : ' — the measurement is dead'}`);
  if (!anyRise) fails++;

  const anyAir = outs.some((o) => o.airTicks > 0);
  console.log(`  ${anyAir ? 'PASS' : '*** FAIL'}  ...and they do go airborne in these runs`.padEnd(58)
    + ` ${outs.reduce((a, o) => a + o.airTicks, 0)} airborne kart-ticks of `
    + `${outs.reduce((a, o) => a + o.ticks, 0)}`);
  if (!anyAir) fails++;

  const enough = outs.every((o) => o.ticks > 10000);
  console.log(`  ${enough ? 'PASS' : '*** FAIL'}  every circuit was actually driven`.padEnd(58)
    + ` fewest kart-ticks on one circuit ${Math.min(...outs.map((o) => o.ticks))}`);
  if (!enough) fails++;

  const windowsHit = outs.every((o) => o.win.every((w) => w.n > 200));
  const allWins = outs.flatMap((o) => o.win);
  console.log(`  ${windowsHit ? 'PASS' : '*** FAIL'}  every named arc window was driven through`.padEnd(58)
    + ` ${allWins.length} window(s), fewest kart-ticks `
    + `${allWins.length ? Math.min(...allWins.map((w) => w.n)) : 'n/a — no --arcs given'}`);
  if (!windowsHit) fails++;
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
