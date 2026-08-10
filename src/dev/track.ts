/**
 * Track bench — orbit, wireframe, driver-eye flythrough, and a raycast
 * benchmark, with no dependency on any other agent's subsystem.
 * Delete once Environment/Karts/Render are in and the real game boots.
 */

import * as THREE from 'three';
import { QUALITY_PRESETS } from '@/core/Config';
import type { QualityTier } from '@/core/Types';
import { Track } from '@/track/Track';
import { TRACK_ORDER } from '@/track/TrackDefs';

const hud = document.getElementById('hud') as HTMLDivElement;
const bench = document.getElementById('bench') as HTMLDivElement;
const keys = document.getElementById('keys') as HTMLDivElement;
keys.textContent =
  'drag orbit   wheel zoom   W wireframe   C collision mesh   K checkpoints\n' +
  'F flythrough (driver eye)   G top-down   1/2/3 circuit   B benchmark   V verify vs BVH\n' +
  'D toggle decals   [ ] flythrough speed';

const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1522);
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.2, 4000);

// ---- lighting (a stand-in for the real Lighting subsystem) -----------------
const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
sun.position.set(-260, 220, 180);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = -260; sc.right = 260; sc.top = 260; sc.bottom = -260; sc.near = 1; sc.far = 900;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xa9c8ff, 0x584a3c, 0.75));
const rim = new THREE.DirectionalLight(0x77b4ff, 0.9);
rim.position.set(220, 90, -240);
scene.add(rim);

// A cheap procedural env map so metals and the wet road have something to see.
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#8fc3ff');
  g.addColorStop(0.48, '#ffd9a8');
  g.addColorStop(0.52, '#4a3a2e');
  g.addColorStop(1, '#241c16');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.environment = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  pmrem.dispose();
}

// ---- track -----------------------------------------------------------------
const tier = (new URLSearchParams(location.search).get('q') as QualityTier) ?? 'ultra';
const quality = QUALITY_PRESETS[tier] ?? QUALITY_PRESETS.ultra;
const track = new Track(scene, renderer, quality);
(globalThis as Record<string, unknown>).__TRACK__ = track;

// ---- orbit -----------------------------------------------------------------
const orbit = { yaw: 0.7, pitch: 0.62, dist: 320, target: new THREE.Vector3() };
let dragging = false;
let lastX = 0;
let lastY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointerup', (e) => {
  dragging = false;
  renderer.domElement.releasePointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbit.yaw -= (e.clientX - lastX) * 0.005;
  orbit.pitch = Math.max(0.03, Math.min(1.5, orbit.pitch - (e.clientY - lastY) * 0.004));
  lastX = e.clientX; lastY = e.clientY;
});
renderer.domElement.addEventListener('wheel', (e) => {
  orbit.dist = Math.max(6, Math.min(1600, orbit.dist * (1 + Math.sign(e.deltaY) * 0.1)));
  e.preventDefault();
}, { passive: false });

// ---- state -----------------------------------------------------------------
const state = {
  wireframe: false,
  collision: false,
  checkpoints: false,
  decals: true,
  fly: false,
  topDown: false,
  flyD: 0,
  flySpeed: 26,
  trackIndex: 0,
};

const flyFrame = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w') { state.wireframe = !state.wireframe; track.setDebugVisible({ wireframe: state.wireframe }); }
  if (k === 'c') { state.collision = !state.collision; track.setDebugVisible({ collision: state.collision }); }
  if (k === 'k') { state.checkpoints = !state.checkpoints; track.setDebugVisible({ checkpoints: state.checkpoints }); }
  if (k === 'd') { state.decals = !state.decals; track.decals.mesh.visible = state.decals; track.materials.setRoadParams({ decal: state.decals ? 1 : 0 }); }
  if (k === 'f') { state.fly = !state.fly; state.topDown = false; }
  if (k === 'g') { state.topDown = !state.topDown; state.fly = false; }
  if (k === '[') state.flySpeed = Math.max(4, state.flySpeed - 6);
  if (k === ']') state.flySpeed = Math.min(70, state.flySpeed + 6);
  if (k === 'b') runBenchmark();
  if (k === 'v') runVerify();
  if (k === '1' || k === '2' || k === '3') {
    const i = Number(k) - 1;
    if (i < TRACK_ORDER.length && i !== state.trackIndex) {
      state.trackIndex = i;
      void reload(TRACK_ORDER[i]);
    }
  }
});

async function reload(id: string) {
  hud.textContent = `building ${id}…`;
  await track.loadTrack(id);
  track.setDebugVisible(state);
  frameCircuit();
}

function frameCircuit() {
  const b = new THREE.Box3().setFromObject(track.roadGroup);
  b.getCenter(orbit.target);
  orbit.dist = b.getSize(new THREE.Vector3()).length() * 0.62;
}

function runBenchmark() {
  track.benchmarkGround(2000); // warm the JIT
  const r = track.benchmarkGround(10000);
  const t0 = performance.now();
  const p = new THREE.Vector3();
  for (let i = 0; i < 10000; i++) {
    const s = track.sampleAtDistance((i * 5.7) % track.lapLength);
    p.copy(s.position).addScaledVector(s.binormal, ((i % 5) - 2) * 2);
    track.collideWalls(p, 1.05);
  }
  const wallMs = performance.now() - t0;
  const good = r.ms < 15;
  bench.innerHTML =
    `<b>raycastGround x10000</b>\n` +
    `  total   <span class="${good ? 'ok' : 'bad'}">${r.ms.toFixed(2)} ms</span>  (target &lt; 15)\n` +
    `  percall ${r.perCall.toFixed(3)} us\n` +
    `  hits    ${r.hits} / 10000\n\n` +
    `<b>collideWalls x10000</b>\n  total ${wallMs.toFixed(2)} ms\n\n` +
    `<b>geometry</b>\n` +
    `  ${track.stats.triangles | 0} tris, ${track.stats.vertices} verts\n` +
    `  ${track.stats.drawCalls} draw calls, ${track.stats.rings} rings\n` +
    `  ${track.stats.decals} decal quads\n` +
    `  build ${track.stats.ms.toFixed(1)} ms`;
}

function runVerify() {
  const v = track.verifyAgainstBvh(600);
  const good = v.max < 0.2;
  bench.innerHTML =
    `<b>analytic probe vs BVH</b>\n` +
    `  max err  <span class="${good ? 'ok' : 'warn'}">${v.max.toFixed(4)} m</span>\n` +
    `  mean err ${v.mean.toFixed(4)} m\n` +
    `  misses   ${v.misses}`;
}

// ---- loop ------------------------------------------------------------------
const clock = new THREE.Clock();
let frame = 0;
let fps = 0;

function tick() {
  const dt = Math.min(0.1, clock.getDelta());
  const elapsed = clock.elapsedTime;
  fps = fps * 0.92 + (1 / Math.max(1e-3, dt)) * 0.08;
  track.update({ dt, fixedDt: 1 / 120, elapsed, frame: frame++, alpha: 0 });

  if (state.fly) {
    state.flyD = (state.flyD + state.flySpeed * dt) % track.lapLength;
    track.cameraFrameAt(state.flyD, flyFrame);
    camera.position.copy(flyFrame.position);
    camera.quaternion.copy(flyFrame.quaternion);
    camera.fov = 72;
  } else if (state.topDown) {
    const b = new THREE.Box3().setFromObject(track.roadGroup);
    const c = b.getCenter(new THREE.Vector3());
    camera.position.set(c.x, c.y + b.getSize(new THREE.Vector3()).length() * 0.6, c.z + 0.01);
    camera.lookAt(c);
    camera.fov = 58;
  } else {
    const cp = Math.cos(orbit.pitch);
    camera.position.set(
      orbit.target.x + Math.sin(orbit.yaw) * cp * orbit.dist,
      orbit.target.y + Math.sin(orbit.pitch) * orbit.dist,
      orbit.target.z + Math.cos(orbit.yaw) * cp * orbit.dist,
    );
    camera.lookAt(orbit.target);
    camera.fov = 58;
  }
  camera.updateProjectionMatrix();

  sun.position.set(orbit.target.x - 260, 240, orbit.target.z + 180);
  sun.target.position.copy(orbit.target);
  sun.target.updateMatrixWorld();

  const s = track.sampleAtDistance(state.flyD);
  hud.textContent =
    `${track.trackName}\n` +
    `  length     ${track.lapLength.toFixed(0)} m   laps ${track.lapCount}\n` +
    `  fps        ${fps.toFixed(0)}\n` +
    `  fly at     ${state.flyD.toFixed(0)} m  (${(state.flySpeed * 3.6).toFixed(0)} km/h)\n` +
    `  halfWidth  ${s.halfWidth.toFixed(1)} m   bank ${(s.bank * 57.2958).toFixed(1)} deg\n` +
    `  curvature  ${s.curvature.toFixed(4)} 1/m  (R ${Math.abs(s.curvature) > 1e-4 ? (1 / Math.abs(s.curvature)).toFixed(0) : 'inf'} m)\n` +
    `  tris       ${track.stats.triangles | 0}   calls ${track.stats.drawCalls}\n` +
    `  wire ${state.wireframe ? 'ON' : 'off'}  coll ${state.collision ? 'ON' : 'off'}  cp ${state.checkpoints ? 'ON' : 'off'}  decals ${state.decals ? 'ON' : 'off'}`;

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

(async () => {
  await track.init();
  frameCircuit();
  runBenchmark();
  tick();
})();
