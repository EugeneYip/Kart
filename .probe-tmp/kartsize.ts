/**
 * ============================================================================
 *  HOW TALL IS A KART, ACTUALLY?
 * ============================================================================
 *  `DRIVE_HEIGHT = 3.0` in the envelope audit is justified in a comment as
 *  "a kart is ~1.4 m tall". `AGENTS.md` says something different — "a kart is
 *  ~1.9 m long, ~1.4 m WIDE" — so the 1.4 in the audit may be the width with
 *  the axis relabelled. That would make the whole envelope argument rest on a
 *  transcription error, which is exactly the kind of thing the owner is right
 *  not to accept on a comment's word.
 *
 *  So measure it. Build the REAL rig — `KartModel`, the same class
 *  `KartManager.createVisual` instantiates — for every chassis on the roster
 *  crossed with every driver, and take the world-space bounding box with the
 *  model seated as it races. `restGroundY` is the offset `KartManager` applies
 *  to put the tyre contact patch on the road, so subtracting it gives height
 *  ABOVE THE TARMAC, which is the number the envelope needs.
 *
 *  Reported: overall extents, the tallest combination, and the tallest single
 *  part, so "what is the top of a kart" has a name attached to it.
 *
 *  usage: node src/dev/node-run.mjs .probe-tmp/kartsize.ts [--tier=ultra]
 * ============================================================================
 */
import * as THREE from 'three';
import { KartAssets, KartModel } from '@/karts/KartModel';
import { KART_BODY_IDS } from '@/karts/KartBodies';
import type { KartBodyId } from '@/karts/KartBodies';
import { CHARACTERS } from '@/karts/Characters';
import { faceSpecFor, DRIVERS } from '@/karts/Driver';
import { makeTuning } from '@/physics/Tuning';
import { QUALITY_PRESETS } from '@/core/Config';

const ARGS = process.argv.slice(3);
const TIER = (ARGS.find((a) => a.startsWith('--tier=')) ?? '--tier=ultra').slice(7) as
  'low' | 'medium' | 'high' | 'ultra';

const assets = new KartAssets(QUALITY_PRESETS[TIER]);
const box = new THREE.Box3();

interface Row { label: string; h: number; w: number; l: number; top: string; }
const rows: Row[] = [];

for (const ch of CHARACTERS) {
  for (const bodyId of KART_BODY_IDS as readonly KartBodyId[]) {
    const tuning = makeTuning(ch.id);
    const model = new KartModel(assets, {
      bodyId,
      tyreId: ch.tyreId,
      driverId: ch.driverId,
      tuning,
      paintKey: `probe:${ch.id}:${bodyId}`,
      paint: {
        color: ch.color, secondary: ch.secondaryColor, glow: ch.glowColor,
        cloth: DRIVERS[ch.driverId].suit, clothAlt: DRIVERS[ch.driverId].suitAlt,
        skin: DRIVERS[ch.driverId].skinColor, flake: ch.flake, matte: ch.matte,
      },
      faceSpec: faceSpecFor(ch.driverId),
      name: `probe:${ch.id}:${bodyId}`,
    });
    // Seat it exactly as `KartManager` does: `shadowHeight = -restGroundY`, i.e.
    // the rig's local y = `restGroundY` is the contact patch.
    model.root.position.set(0, -model.restGroundY, 0);
    model.root.updateMatrixWorld(true);
    box.makeEmpty();
    // The cast shadow is a ground quad, not part of the vehicle; excluding it
    // is the one judgement call here and it only ever LOWERS nothing (the quad
    // sits at the contact patch), so it cannot flatter the answer.
    let topName = '';
    let topY = -Infinity;
    const b2 = new THREE.Box3();
    model.root.traverse((o) => {
      const me = o as THREE.Mesh;
      if (!me.isMesh || !me.geometry) return;
      if (o === model.shadow) return;
      if (!me.geometry.boundingBox) me.geometry.computeBoundingBox();
      b2.copy(me.geometry.boundingBox!).applyMatrix4(me.matrixWorld);
      box.union(b2);
      if (b2.max.y > topY) { topY = b2.max.y; topName = o.name || me.type; }
    });
    rows.push({
      label: `${ch.id}/${bodyId}`,
      h: box.max.y, w: box.max.x - box.min.x, l: box.max.z - box.min.z,
      top: topName,
    });
    model.dispose?.();
  }
}

rows.sort((a, b) => b.h - a.h);
console.log(`\nKART RIG EXTENTS ABOVE THE CONTACT PATCH — tier ${TIER}, `
  + `${CHARACTERS.length} drivers x ${KART_BODY_IDS.length} chassis = ${rows.length} rigs\n`);
console.log('  tallest 8:');
for (const r of rows.slice(0, 8)) {
  console.log(`    ${r.label.padEnd(22)} height ${r.h.toFixed(3)} m   width ${r.w.toFixed(2)}   `
    + `length ${r.l.toFixed(2)}   top part: ${r.top}`);
}
console.log('  shortest 3:');
for (const r of rows.slice(-3)) {
  console.log(`    ${r.label.padEnd(22)} height ${r.h.toFixed(3)} m   width ${r.w.toFixed(2)}   length ${r.l.toFixed(2)}`);
}
const hs = rows.map((r) => r.h);
const ws = rows.map((r) => r.w);
const ls = rows.map((r) => r.l);
console.log(`\n  HEIGHT  min ${Math.min(...hs).toFixed(3)}  max ${Math.max(...hs).toFixed(3)}  `
  + `mean ${(hs.reduce((a, b) => a + b, 0) / hs.length).toFixed(3)}`);
console.log(`  WIDTH   min ${Math.min(...ws).toFixed(3)}  max ${Math.max(...ws).toFixed(3)}`);
console.log(`  LENGTH  min ${Math.min(...ls).toFixed(3)}  max ${Math.max(...ls).toFixed(3)}`);
console.log(`\n  AGENTS.md says "~1.9 m long, ~1.4 m wide". Measured length `
  + `${Math.max(...ls).toFixed(2)} m, width ${Math.max(...ws).toFixed(2)} m.`);
console.log(`  propfoot.ts's DRIVE_HEIGHT comment says "a kart is ~1.4 m tall". `
  + `Measured tallest ${Math.max(...hs).toFixed(2)} m.`);
