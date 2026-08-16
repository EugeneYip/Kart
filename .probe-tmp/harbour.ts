/**
 * ============================================================================
 *  HARBOUR — can a city circuit carry a water plane, and at what level?
 * ============================================================================
 *  Supersedes `.probe-tmp/citywater.ts`, whose opening sentence ("Boston authors
 *  a water plane") is false against current source and whose flood check ran at
 *  `QUALITY_PRESETS.low` (the game ships `ultra`, and the tier changes the
 *  heightfield's metres-per-texel, hence its sampled minimum).
 *
 *  Four numbers per candidate level, and every one of them can go red:
 *
 *   1. DRIVABLE CLEARANCE. The minimum, over the whole DRAWN road surface
 *      (asphalt + kerb + shoulder, both sides, via the real `raycastGround`),
 *      of surfaceY - waterLevel. Negative means the player drives underwater.
 *      This is the assertion; `--red` proves it can fail.
 *   2. WET AREA. Square metres of baked heightfield below the plane, and the
 *      area of the LARGEST CONNECTED BODY. A harbour is one body of water, not
 *      0.1 % of the map scattered as puddles, and the old probe's single
 *      percentage could not tell those apart.
 *   3. SHORE STANDOFF. How far the nearest wet ground is from the asphalt edge.
 *   4. VISIBILITY. Whether `Water.init()` would even build a disc
 *      (`waterLevel >= field.minHeight - 3`), and how much of the largest body
 *      lies within sight of the racing line.
 *
 *  Run: node src/dev/node-run.mjs .probe-tmp/harbour.ts [ids...] [--tier=ultra]
 *       [--levels=a,b,c] [--red] [--hist]
 * ============================================================================
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import { TRACKS, TRACK_ORDER } from '@/track/TrackDefs';
import type { QualityTier } from '@/core/Types';

const ARGS = process.argv.slice(3);
const FLAGS = ARGS.filter((a) => a.startsWith('--'));
const ONLY = ARGS.filter((a) => !a.startsWith('--'));
const IDS = ONLY.length ? ONLY : TRACK_ORDER.slice();

function flag(name: string, dflt: string): string {
  const hit = FLAGS.find((f) => f.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const TIER = flag('tier', 'ultra') as QualityTier;
const RED = FLAGS.includes('--red');
const HIST = FLAGS.includes('--hist');
const LEVELS = flag('levels', '').length
  ? flag('levels', '').split(',').map(Number)
  : null;

if (!QUALITY_PRESETS[TIER]) throw new Error(`unknown tier ${TIER}`);

const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

interface Drivable { x: number; z: number; y: number; t: number; lat: number; }

/**
 * Every point of the DRAWN road surface, on a ~2 m x ~1.5 m lattice, taken from
 * `Track.raycastGround` so kerb crown and shoulder drop are included rather
 * than assumed. `raycastGround` returns `hit=false` outside the corridor and on
 * `TF.Gap`, so the set is exactly what the player can stand on.
 */
function drivableSurface(track: Awaited<ReturnType<typeof loadTrack>>): Drivable[] {
  const out: Drivable[] = [];
  const L = track.lapLength;
  for (let d = 0; d < L; d += 2) {
    const s = track.sampleAtDistance(d);
    // Widest possible corridor: halfWidth + kerb + the widest authored shoulder.
    // Overshooting is free — `raycastGround` rejects the misses.
    for (let lat = -34; lat <= 34; lat += 1.5) {
      _p.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, 40);
      const hit = track.raycastGround(_p, _up, 90);
      if (!hit.hit) continue;
      out.push({ x: hit.point.x, y: hit.point.y, z: hit.point.z, t: d / L, lat });
    }
  }
  return out;
}

/** Flood-fill the wet cells of a boolean grid; returns component sizes. */
function components(wet: Uint8Array, w: number, h: number): { sizes: number[]; label: Int32Array } {
  const label = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!wet[i] || label[i] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    stack.length = 0;
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const c = stack.pop() as number;
      n++;
      const cx = c % w, cy = (c / w) | 0;
      if (cx > 0 && wet[c - 1] && label[c - 1] < 0) { label[c - 1] = id; stack.push(c - 1); }
      if (cx < w - 1 && wet[c + 1] && label[c + 1] < 0) { label[c + 1] = id; stack.push(c + 1); }
      if (cy > 0 && wet[c - w] && label[c - w] < 0) { label[c - w] = id; stack.push(c - w); }
      if (cy < h - 1 && wet[c + w] && label[c + w] < 0) { label[c + w] = id; stack.push(c + w); }
    }
    sizes.push(n);
  }
  return { sizes, label };
}

console.log(`tier=${TIER}\n`);

for (const id of IDS) {
  const track = await loadTrack(id);
  const scene = new THREE.Scene();
  const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS[TIER]);
  await env.init();
  const field = env.field;
  if (!field) throw new Error(`${id}: no field`);
  const def = TRACKS[id];

  // ---- road + drawn surface -------------------------------------------------
  const surf = drivableSurface(track);
  let roadLo = Infinity, roadHi = -Infinity, loAt = 0;
  const L = track.lapLength;
  for (let d = 0; d < L; d += 2) {
    const y = track.sampleAtDistance(d).position.y;
    if (y < roadLo) { roadLo = y; loAt = d / L; }
    if (y > roadHi) roadHi = y;
  }
  let drawLo = Infinity;
  let drawLoAt: Drivable | null = null;
  let maxLat = 0;
  for (const s of surf) {
    if (s.y < drawLo) { drawLo = s.y; drawLoAt = s; }
    if (Math.abs(s.lat) > maxLat) maxLat = Math.abs(s.lat);
  }
  // How deep the drawn surface goes as a function of how much of it you give up.
  const ys = surf.map((s) => s.y).sort((a, b) => a - b);
  const pct = (q: number) => ys[Math.min(ys.length - 1, Math.floor(q * ys.length))];
  // Asphalt only (|lat| <= halfWidth at that station), the hardest floor of all.
  let asphaltLo = Infinity;
  for (const s of surf) {
    const g = track.sampleAtDistance(s.t * L);
    if (Math.abs(s.lat) <= g.halfWidth && s.y < asphaltLo) asphaltLo = s.y;
  }

  // ---- the heightfield ------------------------------------------------------
  // Sample on the field's own lattice so "wet area" is the area the water shader
  // will actually keep (it discards where the sampled terrain is above the plane).
  const STEP = 6;
  const half = field.extent * 0.5;
  const x0 = field.centreX - half, z0 = field.centreZ - half;
  const W = Math.floor(field.extent / STEP);
  const hgt = new Float32Array(W * W);
  let gLo = Infinity, gHi = -Infinity;
  for (let iz = 0; iz < W; iz++) {
    for (let ix = 0; ix < W; ix++) {
      const h = field.heightAt(x0 + ix * STEP, z0 + iz * STEP);
      hgt[iz * W + ix] = h;
      if (h < gLo) gLo = h;
      if (h > gHi) gHi = h;
    }
  }

  console.log(`=== ${id} (${def.name}) ===`);
  console.log(`  authored waterLevel ${def.waterLevel === null ? 'null' : def.waterLevel.toFixed(2)}`
    + `   field.minHeight ${field.minHeight.toFixed(2)}  maxHeight ${field.maxHeight.toFixed(2)}`
    + `   mpt ${field.metresPerTexel.toFixed(2)}  extent ${field.extent.toFixed(0)} m`);
  console.log(`  centreline y ${roadLo.toFixed(2)} .. ${roadHi.toFixed(2)} (lowest at t=${loAt.toFixed(3)})`
    + `   drawn surface low ${drawLo.toFixed(2)} over ${surf.length} samples`);
  console.log(`  lowest drawn point at t=${drawLoAt ? drawLoAt.t.toFixed(3) : '?'} `
    + `lat=${drawLoAt ? drawLoAt.lat.toFixed(1) : '?'} m; widest corridor reached ${maxLat.toFixed(1)} m; `
    + `asphalt-only low ${asphaltLo.toFixed(2)}`);
  console.log(`  drawn-surface height percentiles: `
    + `p0 ${pct(0).toFixed(2)}  p0.1 ${pct(0.001).toFixed(2)}  p1 ${pct(0.01).toFixed(2)}  `
    + `p5 ${pct(0.05).toFixed(2)}  p50 ${pct(0.5).toFixed(2)}`);
  console.log(`  sampled ground ${gLo.toFixed(2)} .. ${gHi.toFixed(2)} on a ${STEP} m lattice (${W}x${W})`);

  if (HIST) {
    const edges = [-4, -3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 2, 4];
    const parts: string[] = [];
    for (const e of edges) {
      let n = 0;
      for (let i = 0; i < hgt.length; i++) if (hgt[i] < e) n++;
      parts.push(`<${e}: ${(100 * n / hgt.length).toFixed(2)}%`);
    }
    console.log(`  cumulative ground: ${parts.join('  ')}`);
  }

  // ---- candidate levels -----------------------------------------------------
  const cands = LEVELS ?? (() => {
    const a: number[] = [];
    for (let v = Math.floor(gLo * 2) / 2; v <= Math.min(gHi, roadLo + 4); v += 0.25) a.push(+v.toFixed(2));
    if (def.waterLevel !== null && !a.includes(def.waterLevel)) a.push(def.waterLevel);
    return a.sort((p, q) => p - q);
  })();

  const cellArea = STEP * STEP;
  console.log('   level   disc?   wet area   largest body   %map   drivable clearance   shore standoff');
  let best: { wl: number; body: number } | null = null;
  for (const wl of cands) {
    const wet = new Uint8Array(W * W);
    let n = 0;
    for (let i = 0; i < hgt.length; i++) if (hgt[i] < wl) { wet[i] = 1; n++; }
    const { sizes, label } = components(wet, W, W);
    let biggest = 0, biggestId = -1;
    for (let k = 0; k < sizes.length; k++) if (sizes[k] > biggest) { biggest = sizes[k]; biggestId = k; }

    // Clearance over the drawn road surface.
    let clear = Infinity;
    for (const s of surf) { const c = s.y - wl; if (c < clear) clear = c; }

    // Nearest wet cell to the asphalt edge, over the largest body only.
    let standoff = Infinity;
    if (biggestId >= 0) {
      for (let iz = 0; iz < W; iz += 1) {
        for (let ix = 0; ix < W; ix += 1) {
          const i = iz * W + ix;
          if (label[i] !== biggestId) continue;
          _p.set(x0 + ix * STEP, hgt[i], z0 + iz * STEP);
          const g = track.project(_p);
          const lat = Math.abs(_p.clone().sub(g.position).dot(g.binormal));
          const off = lat - g.halfWidth;
          if (off < standoff) standoff = off;
        }
      }
    }

    const disc = wl >= field.minHeight - 3;
    const ok = clear > 0;
    console.log(`  ${wl.toFixed(2).padStart(6)}   ${disc ? 'yes' : 'NO '}   `
      + `${(n * cellArea / 1e3).toFixed(1).padStart(8)} km²e-3`
      + `   ${(biggest * cellArea / 1e3).toFixed(1).padStart(8)} km²e-3`
      + `   ${(100 * n / hgt.length).toFixed(2).padStart(5)}`
      + `   ${clear.toFixed(2).padStart(8)} m ${ok ? 'DRY ' : 'FLOODED'}`
      + `   ${Number.isFinite(standoff) ? `${standoff.toFixed(1)} m` : '-'}`);
    if (ok && disc && (!best || biggest > best.body)) best = { wl, body: biggest };
  }
  if (best) {
    console.log(`  -> best dry candidate ${best.wl.toFixed(2)} with a `
      + `${(best.body * cellArea).toFixed(0)} m² largest body`);
  } else {
    console.log('  -> NO candidate level is both visible and dry');
  }

  // ---- RED TEST: the clearance check must be able to fail --------------------
  if (RED) {
    const target = drawLo + 0.5; // deliberately above the lowest drivable point
    let clear = Infinity, drowned = 0;
    for (const s of surf) {
      const c = s.y - target;
      if (c < clear) clear = c;
      if (c <= 0) drowned++;
    }
    const verdict = clear > 0 ? 'DRY (BROKEN — the check cannot fail)' : 'FLOODED (check is live)';
    console.log(`  [RED] forcing waterLevel = drawnLow + 0.5 = ${target.toFixed(2)}: `
      + `clearance ${clear.toFixed(2)} m over ${surf.length} surface samples, `
      + `${drowned} of them underwater -> ${verdict}`);
    if (clear > 0) throw new Error(`${id}: RED test did not go red — the flood check is inert`);
  }

  console.log('');
  env.dispose();
}
process.exit(0);
