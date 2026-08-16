/**
 * One cross-section, both bakes: drawn ribbon height vs terrain height across
 * the carriageway, with the shoulders published and with them stripped.
 *
 * usage: node src/dev/node-run.mjs .probe-tmp/proudcut.ts <id> <arc>
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { TerrainField, type PathStation } from '@/world/WorldTextures';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import { makeAttribs } from '@/track/TrackSpline';

const id = process.argv[3] ?? 'volcanoRush';
const arc = Number(process.argv[4] ?? 248);
const track = await loadTrack(id);
const scene = new THREE.Scene();
const env = new Environment(scene, fakeRenderer(), track, QUALITY_PRESETS.low);
await env.init();
const ctx = env.ctx!;
const f0 = ctx.field;
const stripped: PathStation[] = ctx.stations.map((s) => {
  const c: PathStation = { ...s };
  delete c.shoulderL; delete c.shoulderR;
  return c;
});
const f1 = new TerrainField({
  seed: f0.seed, extent: f0.extent, res: f0.res, centreX: f0.centreX, centreZ: f0.centreZ,
  stations: stripped, theme: f0.theme, waterLevel: f0.waterLevel, amplitude: f0.amplitude,
}, null);

const tris: number[] = [];
track.roadGroup.updateMatrixWorld(true);
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
track.roadGroup.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh || !/^(roadSurface|roadKerbs|roadShoulder_|trackDeck)/.test(m.name)) return;
  const pos = m.geometry.getAttribute('position');
  const idx = m.geometry.getIndex();
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
    b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
    c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
    tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
});
const nearestHit = (x: number, z: number, yRef: number): number | null => {
  let best: number | null = null, bd = 1.5;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    const dd = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(dd) < 1e-9) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / dd;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / dd;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const y = u * ay + v * by + w * cy;
    if (Math.abs(y - yRef) < bd) { bd = Math.abs(y - yRef); best = y; }
  }
  return best;
};

const at = makeAttribs();
track.spline.attribsAtDistance(arc, at);
const s = track.sampleAtDistance(arc);
console.log(`${id} arc ${arc}: hw ${at.halfWidth.toFixed(2)} shL ${at.shoulderL.toFixed(2)} ` +
  `shR ${at.shoulderR.toFixed(2)} flags 0x${at.flags.toString(16)} bank ${(at.bank * 57.3).toFixed(1)}deg`);
console.log('   lat     ribbonY   terr(real)  d(real)   terr(sh=3)  d(sh=3)');
for (let u = -26; u <= 26; u += 1) {
  const px = s.position.x + s.binormal.x * u;
  const pz = s.position.z + s.binormal.z * u;
  const yRef = s.position.y + s.binormal.y * u;
  const rib = nearestHit(px, pz, yRef);
  const g0 = f0.heightAt(px, pz), g1 = f1.heightAt(px, pz);
  console.log(
    `${u.toFixed(1).padStart(7)} ${rib === null ? '      -' : rib.toFixed(2).padStart(11)}` +
    ` ${g0.toFixed(2).padStart(11)} ${rib === null ? '     -' : (g0 - rib).toFixed(2).padStart(8)}` +
    ` ${g1.toFixed(2).padStart(11)} ${rib === null ? '     -' : (g1 - rib).toFixed(2).padStart(8)}`,
  );
}
process.exit(0);
