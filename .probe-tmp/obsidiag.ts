/**
 * ============================================================================
 *  OBSIDIAN DIAGNOSIS — where did the boulder on volcano's centreline come from?
 * ============================================================================
 *  node src/dev/node-run.mjs .probe-tmp/obsidiag.ts volcanoRush
 *
 *  Correlates every emitted `Prop:obsidian` instance against the AUTHORED
 *  `obsidianSpire` placements the track hands Props, so "scatter or authored?"
 *  is answered by identity, not by inference from a nearest-station `t`.
 * ============================================================================
 */

import * as THREE from 'three';
import { Track } from '@/track/Track';
import { QUALITY_PRESETS } from '@/core/Config';
import { Environment } from '@/world/Environment';
import { fakeRenderer } from '@/dev/headless';
import type { PathStation, WorldContext } from '@/world/WorldTextures';

interface DecoProp {
  type: string;
  position: THREE.Vector3;
  scale?: number | THREE.Vector3;
  surface?: { lat: number; up: number; corridor: number; elevated: boolean };
}

function nearestRoad(st: readonly PathStation[], x: number, y: number, z: number, band: number) {
  const n = st.length;
  let bestLat = Infinity;
  let out: { lat: number; halfWidth: number; roadY: number; arc: number; tanBank: number } | null = null;
  for (let i = 0; i < n; i++) {
    const a = st[i], b = st[(i + 1) % n];
    const ex = b.px - a.px, ez = b.pz - a.pz;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-6) continue;
    let t = ((x - a.px) * ex + (z - a.pz) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.px + ex * t, pz = a.pz + ez * t;
    const lat = Math.hypot(x - px, z - pz);
    if (lat >= bestLat) continue;
    const roadY = a.py + (b.py - a.py) * t;
    if (Math.abs(y - roadY) > band) continue;
    bestLat = lat;
    const ds = b.s - a.s;
    out = {
      lat,
      halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t,
      roadY,
      arc: a.s + (ds > 0 ? ds : 0) * t,
      tanBank: a.tanBank + (b.tanBank - a.tanBank) * t,
    };
  }
  return out;
}

const id = process.argv[3] ?? 'volcanoRush';
const scene = new THREE.Scene();
const renderer = fakeRenderer();
const track = new Track(scene, renderer, QUALITY_PRESETS.low);
await track.loadTrack(id);
const env = new Environment(scene, renderer, track, QUALITY_PRESETS.low);
await env.init();

const ctx = (env as unknown as { ctx: WorldContext | null }).ctx;
if (!ctx) throw new Error('no ctx');
const st = ctx.stations;
const total = st[st.length - 1].s + (st[1].s - st[0].s);

// ---- authored placements the track published -------------------------------
const hints = ctx.hints as unknown as { props?: DecoProp[] };
const authored = (hints.props ?? []).filter((p) => /obsidian/i.test(p.type));
console.log('');
console.log(`AUTHORED obsidianSpire placements handed to Props: ${authored.length}`);
for (let i = 0; i < authored.length; i++) {
  const p = authored[i];
  const s = p.surface;
  const r = nearestRoad(st, p.position.x, p.position.y, p.position.z, 1e9);
  console.log(`  #${String(i).padStart(2)} xz=(${p.position.x.toFixed(1)}, ${p.position.z.toFixed(1)})`
    + ` y=${p.position.y.toFixed(1)}`
    + `  authored lat=${s ? s.lat.toFixed(1) : '?'} corridor=${s ? s.corridor.toFixed(1) : '?'}`
    + `  |  nearest road d=${r ? r.arc.toFixed(0) : '-'} t=${r ? (r.arc / total).toFixed(3) : '-'}`
    + ` lat=${r ? r.lat.toFixed(1) : '-'} halfW=${r ? r.halfWidth.toFixed(1) : '-'}`
    + ` inside=${r ? (r.halfWidth - r.lat).toFixed(1) : '-'}`
    + ` rise=${r ? (p.position.y - r.roadY).toFixed(1) : '-'}`);
}

// ---- emitted instances ------------------------------------------------------
const root = env.props?.group;
if (!root) throw new Error('no props');
const m = new THREE.Matrix4();
const pos = new THREE.Vector3();
const q = new THREE.Quaternion();
const sc = new THREE.Vector3();
root.traverse((o) => {
  const im = o as THREE.InstancedMesh;
  if (!im.isInstancedMesh || im.name !== 'Prop:obsidian') return;
  const bb = im.geometry.boundingBox ?? (im.geometry.computeBoundingBox(), im.geometry.boundingBox);
  console.log('');
  console.log(`EMITTED ${im.name}: ${im.count} instances`);
  console.log(`  local AABB  x[${bb!.min.x.toFixed(2)}, ${bb!.max.x.toFixed(2)}]`
    + ` y[${bb!.min.y.toFixed(2)}, ${bb!.max.y.toFixed(2)}]`
    + ` z[${bb!.min.z.toFixed(2)}, ${bb!.max.z.toFixed(2)}]`);
  for (let i = 0; i < im.count; i++) {
    im.getMatrixAt(i, m);
    m.decompose(pos, q, sc);
    const r = nearestRoad(st, pos.x, pos.y, pos.z, 6);
    const inside = r ? r.halfWidth - r.lat : -999;
    // Which authored placement, if any, is this instance?
    let match = -1, md = Infinity;
    for (let k = 0; k < authored.length; k++) {
      const d = Math.hypot(authored[k].position.x - pos.x, authored[k].position.z - pos.z);
      if (d < md) { md = d; match = k; }
    }
    const flag = inside > -3 ? '  <<<< NEAR/IN ROAD' : '';
    if (inside > -6 || md < 0.05) {
      console.log(`  #${String(i).padStart(2)} xz=(${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`
        + ` y=${pos.y.toFixed(1)} scale=${sc.x.toFixed(2)}`
        + `  anchorLat=${r ? r.lat.toFixed(1) : '-'} halfW=${r ? r.halfWidth.toFixed(1) : '-'}`
        + ` anchorInside=${inside.toFixed(1)}`
        + `  | authored#${match} at ${md.toFixed(2)} m${md < 0.05 ? ' == AUTHORED' : ' (scatter)'}`
        + flag);
    }
  }
});
console.log('');
