/**
 * ============================================================================
 *  HONG KONG + NEW YORK — the claims that are specific to these two circuits
 * ============================================================================
 *  Everything the shipping probes already assert is left to them. What is here
 *  is the set of claims that are NEW with these two circuits and that nothing
 *  else in `.probe-tmp` can express:
 *
 *   1. THE BRIDGE GATE IS ACTUALLY HOLLOW. `sightline.ts` proxies every prop by
 *      its oriented bounding box and excludes a name-matched HOLLOW set from the
 *      occlusion count. `brooklynTower` is in that set, and a name is not a
 *      measurement — so this walks the real triangles and reports the lowest
 *      piece of masonry over every lateral sample of the carriageway. If the
 *      arch opening is not clear, the exclusion is a lie and this goes red.
 *
 *   2. THE CABLE WEB LANDS ON THE DECK. The owner has reported floating bridge
 *      cables twice. Every cable vertex is bucketed by arc length, and each
 *      band that has cable in it must ALSO have cable within `SEAT_TOL` of the
 *      drawn road surface — i.e. the web is stitched to the deck all the way
 *      along, not just at one end.
 *
 *   3. ...AND STAYS OFF THE TARMAC. No cable vertex within `DECK_BAND` metres of
 *      the deck may be inside the drivable half-width.
 *
 *   4. THE COURSE SELECT SURVIVES THEM. Both ids reach `ui/Catalogue`'s TRACKS
 *      with a real tag, a real difficulty and a real sky colour. A course-select
 *      screen dying on an unknown track is something this project has shipped.
 *
 *   5. ONE CORRECT FLAG EACH, ON ITS OWN ATLAS CELL — the `citymeta.ts` claim,
 *      extended to the two new circuits and to the Hong Kong cell.
 *
 *  ---------------------------------------------------------------------------
 *  WHAT MAKES 1-3 NON-VACUOUS
 *  ---------------------------------------------------------------------------
 *  The ground truth for every height in 1-3 is the **drawn collision mesh**,
 *  read triangle by triangle, and NOT `deckFrameAt()` / `roadCross()` — which
 *  are the functions `brooklynCables` is built on. Grading a construction with
 *  its own template is the defect this project keeps shipping; here the two
 *  sides of every comparison come from different code.
 *
 *  Each assertion was shown to go RED by breaking the thing it measures; the
 *  reversions are listed in the report.
 *
 *  usage: node src/dev/node-run.mjs .probe-tmp/citynew.ts [ids...]
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import { TRACK_ORDER, TRACKS as CIRCUITS } from '@/track/TrackDefs';
import { TRACKS as MENU_TRACKS } from '@/ui/Catalogue';

const ONLY = process.argv.slice(3).filter((a) => !a.startsWith('--'));
const IDS = ONLY.length ? ONLY : ['hongKongHarbour', 'newYorkCircuit'];

/** Headroom a gate must leave over the whole carriageway, metres. */
const GATE_MIN = 8.0;
/** How close a cable band must come to the deck to count as seated. */
const SEAT_TOL = 0.6;
/** Cable within this of the deck is "low", and low cable must clear the tarmac. */
const DECK_BAND = 6.0;
/** Arc bucket width for the cable-seating scan. */
const BAND = 8;

let fails = 0;
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label.padEnd(44)} ${detail}`);
};

// ---------------------------------------------------------------------------
//  A triangle soup with an XZ bucket index, so a vertical ray is cheap.
// ---------------------------------------------------------------------------
class Soup {
  private tri: Float64Array;
  private n = 0;
  private cell = 6;
  private grid = new Map<number, number[]>();
  private scratch: number[] = [];

  constructor(cap: number) { this.tri = new Float64Array(cap * 9); }

  add(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    const i = this.n * 9;
    if (i + 9 > this.tri.length) return;
    this.tri[i] = a.x; this.tri[i + 1] = a.y; this.tri[i + 2] = a.z;
    this.tri[i + 3] = b.x; this.tri[i + 4] = b.y; this.tri[i + 5] = b.z;
    this.tri[i + 6] = c.x; this.tri[i + 7] = c.y; this.tri[i + 8] = c.z;
    const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x);
    const z0 = Math.min(a.z, b.z, c.z), z1 = Math.max(a.z, b.z, c.z);
    for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++) {
      for (let gz = Math.floor(z0 / this.cell); gz <= Math.floor(z1 / this.cell); gz++) {
        const k = gx * 73856093 ^ gz * 19349663;
        let l = this.grid.get(k);
        if (!l) { l = []; this.grid.set(k, l); }
        l.push(this.n);
      }
    }
    this.n++;
  }

  /** Every y at which a vertical line through (x, z) crosses the soup. */
  hits(x: number, z: number, out: number[] = this.scratch): number[] {
    out.length = 0;
    const k = Math.floor(x / this.cell) * 73856093 ^ Math.floor(z / this.cell) * 19349663;
    const list = this.grid.get(k);
    if (!list) return out;
    for (const t of list) {
      const i = t * 9;
      const ax = this.tri[i], ay = this.tri[i + 1], az = this.tri[i + 2];
      const bx = this.tri[i + 3], by = this.tri[i + 4], bz = this.tri[i + 5];
      const cx = this.tri[i + 6], cy = this.tri[i + 7], cz = this.tri[i + 8];
      // Barycentric in XZ.
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      out.push(u * ay + v * by + w * cy);
    }
    return out;
  }

  /** Highest hit at or below `yMax`, or null. */
  under(x: number, z: number, yMax: number, out: number[] = this.scratch): number | null {
    this.hits(x, z, out);
    let best: number | null = null;
    for (const y of out) if (y <= yMax && (best === null || y > best)) best = y;
    return best;
  }

  /** Lowest hit at or above `yMin`, or null. */
  over(x: number, z: number, yMin: number, out: number[] = this.scratch): number | null {
    this.hits(x, z, out);
    let best: number | null = null;
    for (const y of out) if (y >= yMin && (best === null || y < best)) best = y;
    return best;
  }
}

function soupOf(mesh: THREE.Mesh, matrices: THREE.Matrix4[], cap: number): Soup {
  const s = new Soup(cap);
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const count = idx ? idx.count : pos.count;
  for (const m of matrices) {
    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      s.add(a, b, c);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------

console.log('CITY SERIES — Hong Kong / New York specific assertions\n');

// ---- 4 + 5: registry and flags, no Environment needed ---------------------
const FLAG_OF: Record<string, string> = {
  hongKongHarbour: 'flagHK',
  newYorkCircuit: 'flagUSA',
};
for (const id of IDS) {
  console.log(`--- ${id}: metadata`);
  const def = CIRCUITS[id];
  check(!!def, 'registered in TrackDefs.TRACKS', def ? def.name : 'MISSING');
  if (!def) continue;
  check(TRACK_ORDER.includes(id), 'in TRACK_ORDER (cup order)', `index ${TRACK_ORDER.indexOf(id)}`);
  const card = MENU_TRACKS.find((t) => t.id === id);
  check(!!card, 'reaches ui/Catalogue TRACKS', card ? `"${card.name}"` : 'MISSING');
  if (card) {
    check(!!card.tag && card.tag.length > 0, 'course card has a tag', card.tag);
    check(card.difficulty >= 1 && card.difficulty <= 3, 'course card difficulty in range',
      String(card.difficulty));
    check(/^#[0-9a-f]{6}$/i.test(card.themeA), 'course card sky colour resolved', card.themeA);
    check(card.outline.length === def.nodes.length, 'course card outline is the centreline',
      `${card.outline.length} points`);
    check(card.lengthKm > 1.4 && card.lengthKm < 1.8, 'course card length plausible',
      `${card.lengthKm.toFixed(3)} km`);
  }
  check(def.weather === 'clear', "weather is 'clear' (no rain in the city series)",
    String(def.weather));
  check(def.laps === 3, 'laps === 3', String(def.laps));
  check(def.waterLevel === null, 'no global water plane', String(def.waterLevel));
  const want = FLAG_OF[id];
  const flags = def.props.filter((p) => /^flag(usa|roc|japan|hk)$/i.test(p.type));
  const kinds = new Set(flags.map((p) => p.type));
  check(kinds.size === 1 && kinds.has(want), 'exactly one national flag type, correct one',
    [...kinds].join(',') || 'NONE');
  // Placed masts, counting the `step`/`end`/`mirror` expansion.
  let masts = 0;
  for (const p of flags) {
    const n = p.step && p.end ? Math.floor((p.end - p.t) / p.step) + 1 : 1;
    masts += n * (p.mirror ? 2 : 1);
  }
  check(masts >= 12, 'the flag is flown, not just present', `${masts} masts`);
  console.log('');
}

// ---- 1-3: the bridge, measured against the drawn collision mesh ------------
for (const id of IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS.low);
  await env.init();
  const L = track.lapLength;

  const towers: THREE.InstancedMesh[] = [];
  const cables: THREE.InstancedMesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.InstancedMesh;
    if (!m.isInstancedMesh) return;
    if (/brooklyntower:metal/.test(m.name)) cables.push(m);
    else if (/brooklyntower$/.test(m.name)) towers.push(m);
  });
  if (!towers.length && !cables.length) { env.dispose(); continue; }

  console.log(`--- ${id}: the river crossing`);

  // ---- THE INDEPENDENT YARDSTICK ------------------------------------------
  // The DRAWN road ribbon, triangle by triangle: the asphalt, the kerbs, every
  // shoulder variant and the elevated deck's own surface. NOT `trackCollision`
  // — measured, that mesh is 10 576 triangles against the ribbon's 47 428 and
  // it stops at the kerb, so a girder standing on the SHOULDER (which is where
  // a bridge girder stands) has nothing under it as far as the collision hull
  // is concerned and every seating test came back vacuously "floating".
  //
  // Walls, guardrail posts, boost pads and decals are excluded: a barrier top
  // is not a surface anything is seated on, and counting it would make a
  // floating girder look 0.9 m better than it is.
  const ROAD_MESH = /^(roadSurface|roadKerbs|roadShoulder_|trackDeck)/;
  const road = new Soup(200000);
  let roadTris = 0;
  {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    track.roadGroup.updateMatrixWorld(true);
    track.roadGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !ROAD_MESH.test(mesh.name)) return;
      const g = mesh.geometry;
      const pos = g.getAttribute('position');
      const idx = g.getIndex();
      const count = idx ? idx.count : pos.count;
      for (let i = 0; i < count; i += 3) {
        const i0 = idx ? idx.getX(i) : i;
        const i1 = idx ? idx.getX(i + 1) : i + 1;
        const i2 = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
        road.add(a, b, c);
        roadTris++;
      }
    });
  }
  check(roadTris > 30000, 'the yardstick is the drawn ribbon, not the hull',
    `${roadTris} triangles`);
  const scratch: number[] = [];

  // ---- 1. gate clearance --------------------------------------------------
  {
    const m = new THREE.Matrix4();
    let worst = Infinity, worstAt = '';
    let samples = 0;
    for (const mesh of towers) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        const ox = m.elements[12], oz = m.elements[14];
        const soup = soupOf(mesh, [m.clone()], 4000);
        // Walk the carriageway cross-section at the tower's own arc length.
        let arc = 0, bd = Infinity;
        for (let d = 0; d < L; d += 1) {
          const s = track.sampleAtDistance(d);
          const dd = Math.hypot(s.position.x - ox, s.position.z - oz);
          if (dd < bd) { bd = dd; arc = d; }
        }
        const s = track.sampleAtDistance(arc);
        const hw = s.halfWidth;
        for (let k = -10; k <= 10; k++) {
          const lat = (k / 10) * hw;
          const px = s.position.x + s.binormal.x * lat;
          const pz = s.position.z + s.binormal.z * lat;
          const deck = road.under(px, pz, s.position.y + 4) ?? s.position.y;
          const low = soup.over(px, pz, deck + 0.2, scratch);
          samples++;
          const head = low === null ? Infinity : low - deck;
          if (head < worst) { worst = head; worstAt = `arc ${arc.toFixed(0)} lat ${lat.toFixed(1)}`; }
        }
      }
    }
    check(worst >= GATE_MIN,
      `arch opening clears the carriageway (>= ${GATE_MIN} m)`,
      `${samples} samples, worst headroom ${worst === Infinity ? 'open sky' : `${worst.toFixed(2)} m`} at ${worstAt}`);
  }

  // ---- 2 + 3. the cable web ------------------------------------------------
  {
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    // arc -> { any, seated, lowLat }
    const bands = new Map<number, { any: number; seated: number; worstGap: number; worstLat: number }>();
    let overTarmac = 0, worstOver = 0;
    let verts = 0;
    for (const mesh of cables) {
      const pos = mesh.geometry.getAttribute('position');
      for (let inst = 0; inst < mesh.count; inst++) {
        mesh.getMatrixAt(inst, m);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m);
          verts++;
          const deck = road.under(v.x, v.z, v.y + 0.8);
          if (deck === null) continue;
          const gap = v.y - deck;
          if (gap > 40) continue;               // tower-top half of the cable
          // Which station is this over, and how far off the centreline?
          let arc = 0, bd = Infinity, lat = 0, hw = 11;
          for (let d = 0; d < L; d += 2) {
            const s = track.sampleAtDistance(d);
            const dd = Math.hypot(s.position.x - v.x, s.position.z - v.z);
            if (dd < bd) {
              bd = dd; arc = d; hw = s.halfWidth;
              lat = (v.x - s.position.x) * s.binormal.x + (v.z - s.position.z) * s.binormal.z;
            }
          }
          const key = Math.round(arc / BAND);
          let e = bands.get(key);
          if (!e) { e = { any: 0, seated: 0, worstGap: Infinity, worstLat: 99 }; bands.set(key, e); }
          e.any++;
          if (Math.abs(gap) <= SEAT_TOL) e.seated++;
          if (gap < e.worstGap) e.worstGap = gap;
          if (gap <= DECK_BAND && Math.abs(lat) < hw) {
            const into = hw - Math.abs(lat);
            if (into > worstOver) worstOver = into;
            overTarmac++;
            if (Math.abs(lat) < e.worstLat) e.worstLat = Math.abs(lat);
          }
        }
      }
    }
    const all = [...bands.entries()].sort((a, b) => a[0] - b[0]);
    const unseated = all.filter(([, e]) => e.seated === 0);
    check(all.length >= 20, 'the cable web spans the deck (bands with cable in them)',
      `${all.length} bands of ${BAND} m, ${verts} vertices`);
    check(unseated.length === 0,
      'every cable band reaches the drawn deck',
      unseated.length === 0
        ? `worst band gap ${Math.max(...all.map(([, e]) => e.worstGap)).toFixed(3)} m`
        : `${unseated.length} floating bands, e.g. arc ${unseated[0][0] * BAND} at +${unseated[0][1].worstGap.toFixed(2)} m`);
    check(overTarmac === 0, 'no low cable over the drivable road',
      overTarmac === 0 ? '0 vertices' : `${overTarmac} vertices, worst ${worstOver.toFixed(2)} m inside`);
  }

  env.dispose();
  console.log('');
}

console.log(fails === 0 ? 'PASS: 0 assertions failed' : `*** ${fails} assertion(s) FAILED`);
process.exit(0);
