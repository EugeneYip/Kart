/**
 * Checksum of every drawn road vertex, plus the four smooth channels sampled on
 * a fine grid. Used to prove `scalars4` is bit-equivalent to four
 * `scalarAtParam` calls: the number must not move across that refactor.
 *
 * usage: node src/dev/node-run.mjs .probe-tmp/geohash.ts [ids...]
 */
import * as THREE from 'three';
import { loadTrack, TRACK_IDS } from '@/dev/headless';
import { makeAttribs } from '@/track/TrackSpline';

const IDS = process.argv.slice(3).length ? process.argv.slice(3) : TRACK_IDS;
const at = makeAttribs();
for (const id of IDS) {
  const track = await loadTrack(id);
  let h = 2166136261 >>> 0;
  const mix = (v: number): void => {
    const q = Math.round(v * 1e6) | 0;
    h = Math.imul(h ^ (q & 0xffff), 16777619) >>> 0;
    h = Math.imul(h ^ (q >>> 16), 16777619) >>> 0;
  };
  const v = new THREE.Vector3();
  track.roadGroup.updateMatrixWorld(true);
  let verts = 0;
  track.roadGroup.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      mix(v.x); mix(v.y); mix(v.z); verts++;
    }
  });
  let ch = 2166136261 >>> 0;
  const mixc = (val: number): void => {
    const q = Math.round(val * 1e9) | 0;
    ch = Math.imul(ch ^ (q & 0xffff), 16777619) >>> 0;
    ch = Math.imul(ch ^ (q >>> 16), 16777619) >>> 0;
  };
  for (let k = 0; k < 40000; k++) {
    const d = (k / 40000) * track.lapLength;
    track.spline.attribsAtDistance(d, at);
    mixc(at.halfWidth); mixc(at.bank); mixc(at.shoulderL); mixc(at.shoulderR);
    const s = track.sampleAtDistance(d);
    mixc(s.halfWidth); mixc(s.bank); mixc(s.shoulderL); mixc(s.shoulderR);
  }
  console.log(`${id.padEnd(18)} geom ${h.toString(16).padStart(8, '0')} (${verts} verts)  channels ${ch.toString(16).padStart(8, '0')}`);
}
process.exit(0);
