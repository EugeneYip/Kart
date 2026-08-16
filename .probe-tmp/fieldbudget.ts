/**
 * §5b field budget: the 12-kart grid's real triangle count, split by category.
 * node src/dev/node-run.mjs .probe-tmp/fieldbudget.ts [low|ultra]
 */
import * as THREE from 'three';
import { QUALITY_PRESETS } from '@/core/Config';
import { setSegmentScale, buildKartBody, frameFromTuning } from '@/karts/KartBodies';
import { buildWheel } from '@/karts/Wheels';
import { buildDriver, disposeDriverBuild } from '@/karts/Driver';
import { CHARACTERS, CHARACTER_BY_ID } from '@/karts/Characters';
import { NEAR_RIVAL_COUNT, MID_RIVAL_COUNT } from '@/karts/KartModel';
import { makeTuning } from '@/physics/Tuning';

/** `KartManager.startRace()`: `Math.max(1, RACE ? 12 : 12)`. */
const GRID = 12;

// argv[2] is the entry path handed to node-run.mjs, so the tier is argv[3].
const tier = (process.argv[3] === 'low' ? 'low' : 'ultra') as 'low' | 'ultra';
const quality = QUALITY_PRESETS[tier];
setSegmentScale(tier === 'ultra' ? 0.78 : 0.42);

function tris(g: THREE.BufferGeometry): number {
  const i = g.getIndex();
  return (i ? i.count : g.attributes.position.count) / 3;
}

// ---- THE FIELD WAS 14 KARTS ------------------------------------------------
// This used to be `[...CHARACTERS, CHARACTERS[0], CHARACTERS[1]]`, which was
// right when the roster was ten and the grid twelve. The roster is twelve now,
// so that expression silently measured a **14-kart field** and every total below
// it was ~17 % too high. Nothing failed; the numbers were just wrong.
//
// Now it mirrors `KartManager.buildRoster`: distinct-first, and only pad if the
// roster is genuinely short of the grid. The assertion underneath is the part
// that matters — a probe that cannot notice it is measuring the wrong number of
// karts is the same class of defect this file exists to catch.
const player = CHARACTER_BY_ID[CHARACTERS[0].id];
const rest = CHARACTERS.filter((c) => c.id !== player.id);
const field = [player];
for (let i = 0; field.length < GRID; i++) field.push(rest[i % rest.length]);

if (field.length !== GRID) {
  throw new Error(`field is ${field.length} karts, grid is ${GRID} — probe is measuring the wrong race`);
}
console.log(`\n=== FIELD BUDGET — tier ${tier} (${field.length} karts, near LOD) ===`);
console.log(`roster ${CHARACTERS.length}, grid ${GRID}`
  + `${CHARACTERS.length < GRID ? `  (${GRID - CHARACTERS.length} repeated)` : '  (all distinct)'}`);
console.log('char      body   wheels  driver   total  calls');
let sumBody = 0, sumWheel = 0, sumDriver = 0, sumCalls = 0;
// What the game actually draws. Buckets come from the real constants in
// `KartModel.ts` rather than being retyped: the player takes LOD 0, then
// `rivalRank <= NEAR_RIVAL_COUNT` is LOD 1, `<= MID_RIVAL_COUNT` is LOD 2, and
// everything past that is the single-buffer far LOD — see `assignLods`.
// §5b is measured on the real game, so this, not the all-near worst case, is
// the number that has to fit.
const NEAR_END = 1 + NEAR_RIVAL_COUNT;   // player + near rivals
const MID_END = 1 + MID_RIVAL_COUNT;     // ...through the mid rivals
let shipTris = 0, shipDriverTris = 0;
let rank = 0;
for (const c of field) {
  const tuning = makeTuning(c.id, 150);
  const frame = frameFromTuning(tuning);
  const body = buildKartBody(c.bodyId, frame, quality);
  const wheel = buildWheel(c.tyreId, frame.wheelRadius, frame.wheelWidth, quality);
  const drv = buildDriver(c.driverId, {
    quality, wheelRadius: 0.10, gripSpread: 1, scale: body.driver.scale,
  });
  let bt = 0;
  for (const g of body.near) bt += tris(g.geometry);
  let wt = 0;
  for (const g of [...wheel.spin, ...wheel.fixed]) wt += tris(g.geometry);
  wt *= 4;
  let dt = 0;
  for (const g of drv.near) dt += tris(g.geometry);
  const calls = body.near.length + (wheel.spin.length + wheel.fixed.length) * 4 + drv.nearMerged.length + 2;
  sumBody += bt; sumWheel += wt; sumDriver += dt; sumCalls += calls;

  // Shipped LOD ladder.
  let bMid = 0, bFar = 0, dMid = 0;
  for (const g of body.mid) bMid += tris(g.geometry);
  for (const g of body.far) bFar += tris(g.geometry);
  for (const g of drv.mid) dMid += tris(g.geometry);
  if (rank < NEAR_END) { shipTris += bt + wt + dt; shipDriverTris += dt; }
  else if (rank < MID_END) { shipTris += bMid + wt * 0.6 + dMid; shipDriverTris += dMid; }
  else { shipTris += bFar + wt * 0.35; }
  rank += 1;
  console.log(
    `${c.id.padEnd(9)} ${String(Math.round(bt)).padStart(5)} ${String(Math.round(wt)).padStart(8)}`
    + ` ${String(Math.round(dt)).padStart(7)} ${String(Math.round(bt + wt + dt)).padStart(7)}`
    + ` ${String(calls).padStart(6)}`,
  );
  for (const list of [body.near, body.mid, body.far]) for (const g of list) g.geometry.dispose();
  disposeDriverBuild(drv);
}
const total = sumBody + sumWheel + sumDriver;
console.log(`\nTOTALS  bodies ${Math.round(sumBody)}  wheels ${Math.round(sumWheel)}  drivers ${Math.round(sumDriver)}`);
console.log(`FIELD   ${Math.round(total)} tris   (budget 300000, headroom ${Math.round(300000 - total)})`);
console.log(`drivers are ${(sumDriver / total * 100).toFixed(1)}% of the field`);
console.log(`SHIPPED LOD LADDER (1 hero + ${NEAR_RIVAL_COUNT} near, `
  + `${MID_END - NEAR_END} mid, ${GRID - MID_END} far): ${Math.round(shipTris)} tris`);
console.log(`  of which drivers: ${Math.round(shipDriverTris)} (${(shipDriverTris / shipTris * 100).toFixed(1)}%)`);
console.log(`  headroom against 300k: ${Math.round(300000 - shipTris)}`);
console.log(`worst-case draw calls if every kart drew at near LOD: ${sumCalls} (budget 120)`);
console.log('');
console.log('WHICH NUMBER §5b CAPS. The closing note here used to say the all-near');
console.log('figure "is the one §5b caps", which contradicts the shipped-ladder framing');
console.log('above it and only stayed harmless while the all-near total sat under 300k.');
console.log('At twelve characters it does not: all-near is now over budget while the');
console.log('shipped ladder has ~100k of headroom, so the two readings finally disagree');
console.log('about whether the field passes.');
console.log('`assignLods` is RANK-based, not distance-based: the player takes LOD 0 and');
console.log(`only ${NEAR_RIVAL_COUNT} rivals can ever hold LOD 1, whatever the camera does. So all-near`);
console.log('is unreachable by construction and the SHIPPED LADDER is the real number.');
console.log('The all-near total is kept as a ceiling, not as a pass/fail gate.');
