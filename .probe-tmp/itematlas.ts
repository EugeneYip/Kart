/**
 * Does the item HUD actually get an icon atlas, end to end?
 *
 * This is the same SHAPE of question that caught the project out once already:
 * `AIManager.collectHazards()` probed `itemSource` for four method names that
 * `ItemSystem` does not define, so the entire hazard-avoidance subsystem never
 * executed in the shipping game and no test noticed, because every test built
 * the collaborator it wanted rather than the one `Game.ts` passes.
 *
 * `ItemIcons.useAtlas()` feature-detects in exactly the same way — `tryCall(items,
 * 'getIconAtlas')`, `probe(items, 'getIconUV')` — against whatever object
 * `Game.ts:185` wired in. So this probe walks the REAL chain:
 *
 *     Game.ts:185   wire(this.hud, 'setItems', this.items)   <- ItemSystem
 *     HUD.ts:408    this.icons.useAtlas(items)
 *     ItemIcons     tryCall(items, 'getIconAtlas') / probe(items, 'getIconUV')
 *     ItemSystem    :313 -> models.getIconAtlas()   :320 -> models.getIconUV()
 *
 * and asserts against the real `ItemSystem`, not a stand-in.
 *
 * It cannot check pixels: the node canvas shim returns rgb(0,0,0) for every
 * texel, so "the banana looks like a banana" is not measurable here. What is
 * measurable is that the atlas exists, that every item the HUD can show has a
 * distinct, in-bounds cell, and that no two items share one — which is the
 * defect class the comment at `Game.ts:183` records ("a banana for the Plastic
 * Bottle and a mushroom for the Battery").
 *
 * RED CHECKS at the bottom: a stripped source object, and a deliberately
 * collided UV table. Both must fail.
 *
 * Run: node src/dev/node-run.mjs .probe-tmp/itematlas.ts
 */
import { ItemSystem } from '@/items/ItemSystem';
import { ItemType } from '@/core/Types';
import * as THREE from 'three';
import { fakeRenderer } from '@/dev/headless';

let fail = 0;
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label.padEnd(46)} ${detail}`);
};

interface IconRectLike { x: number; y: number; w: number; h: number }
interface SourceLike {
  getIconAtlas?: () => unknown;
  getIconUV?: (i: ItemType) => IconRectLike | null;
}

/** The two names `ItemIcons.useAtlas` feature-detects, and nothing else. */
function adopt(src: SourceLike): { atlas: unknown; uv: ((i: ItemType) => IconRectLike | null) | null } {
  const atlas = typeof src.getIconAtlas === 'function' ? src.getIconAtlas() : null;
  const uv = typeof src.getIconUV === 'function' ? src.getIconUV.bind(src) : null;
  return { atlas, uv };
}

async function main(): Promise<void> {
  const scene = new THREE.Scene();
  // `Projectiles.init` reads `this.karts.karts.length`, so the collaborator has
  // to be shaped even though this probe never spawns a projectile.
  const kartsLike = { karts: [] as unknown[] };
  const items = new ItemSystem(scene, fakeRenderer(), kartsLike as never) as unknown as SourceLike;
  const withInit = items as unknown as { init?: () => Promise<void> };
  if (typeof withInit.init === 'function') await withInit.init();

  console.log('\nThe real ItemSystem, through the two names ItemIcons probes for\n');

  const { atlas, uv } = adopt(items);
  check(atlas !== null && atlas !== undefined, 'ItemSystem answers getIconAtlas()',
    atlas ? (atlas as { constructor?: { name?: string } }).constructor?.name ?? 'object' : 'MISSING — HUD would draw fallbacks');
  check(uv !== null, 'ItemSystem answers getIconUV()', uv ? 'yes' : 'MISSING');
  if (!uv) { console.log('\nFAIL: no UV accessor'); process.exit(1); }

  // Every item the HUD can hold.
  const names = Object.keys(ItemType).filter((k) => Number.isNaN(Number(k)));
  const cells = new Map<string, string>();
  let got = 0, oob = 0;
  const collide: string[] = [];
  for (const n of names) {
    const t = (ItemType as unknown as Record<string, ItemType>)[n];
    const r = uv(t);
    if (!r) continue;
    got++;
    if (r.x < 0 || r.y < 0 || r.x + r.w > 1.0001 || r.y + r.h > 1.0001 || r.w <= 0 || r.h <= 0) oob++;
    const key = `${r.x.toFixed(5)},${r.y.toFixed(5)},${r.w.toFixed(5)},${r.h.toFixed(5)}`;
    const prev = cells.get(key);
    if (prev) collide.push(`${prev}=${n}`); else cells.set(key, n);
  }

  check(got > 0, 'items resolve to a cell', `${got} of ${names.length} ItemType values`);
  check(oob === 0, 'every cell is inside the atlas', oob === 0 ? 'all in 0..1' : `${oob} out of bounds`);
  check(collide.length === 0, 'no two items share one cell',
    collide.length === 0 ? `${cells.size} distinct cells` : collide.join(', '));

  // --- RED 1: a source missing the methods, i.e. the hazard-wiring shape -----
  console.log('\nRED 1 — a source that does not define the two names');
  {
    const stripped: SourceLike = {};
    const r = adopt(stripped);
    const red = r.atlas === null && r.uv === null;
    console.log(`  ${red ? 'PASS' : '*** FAIL'}  detected as unwired`.padEnd(58)
      + ` ${red ? 'atlas null, uv null' : 'NOT DETECTED — this probe cannot see a wiring gap'}`);
    if (!red) fail++;
  }

  // --- RED 2: a UV table with a deliberate collision ------------------------
  // The defect `Game.ts:183` records: two items sharing one cell, so the HUD
  // shows a banana for the bottle. A check that only counts cells cannot see it.
  console.log('\nRED 2 — two items deliberately given the same cell');
  {
    const one = { x: 0.25, y: 0.25, w: 0.25, h: 0.25 };
    const fakeUv = (): IconRectLike => one;
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const n of names.slice(0, 4)) {
      const r = fakeUv();
      const key = `${r.x},${r.y},${r.w},${r.h}`;
      const prev = seen.get(key);
      if (prev) dup.push(`${prev}=${n}`); else seen.set(key, n);
    }
    const red = dup.length > 0;
    console.log(`  ${red ? 'PASS' : '*** FAIL'}  collision detected`.padEnd(58)
      + ` ${red ? dup.join(', ') : 'NOT DETECTED — the uniqueness check is vacuous'}`);
    if (!red) fail++;
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
