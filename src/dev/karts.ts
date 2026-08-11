/**
 * ============================================================================
 *  APEX KART — KARTS & CHARACTERS DEV HARNESS
 * ============================================================================
 *  Standalone bench for the karts agent. Depends on nothing another agent owns:
 *  the track and physics are local stubs, so the real `KartManager` animation
 *  layer runs against hand-driven `KartState`s.
 *
 *   - Studio three-point lighting + a PMREM environment so the clearcoat,
 *     chrome and glass read the same way they will in the game.
 *   - All twelve racers (= all six chassis, all ten drivers) on a row. Foxy and
 *     Capy lead the roster, so karts 0 and 1 are the two animal drivers.
 *   - Keys force drift / boost / stun / hop / finish so the pose blends and the
 *     squash spring can be inspected in isolation.
 *
 *  Delete once the real scene can host the karts.
 * ============================================================================
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  DriftStage, SurfaceType,
  type FrameContext, type GroundHit, type QualityTier,
} from '@/core/Types';
import { FIXED_DT, QUALITY_PRESETS } from '@/core/Config';
import { clamp, clamp01 } from '@/core/MathUtils';
import { KartManager } from '@/karts/KartManager';
import { BODY_NAMES } from '@/karts/KartBodies';
import { CHARACTERS } from '@/karts/Characters';

// ===========================================================================
//  Stubs
// ===========================================================================

const SPACING = 3.6;

class FlatTrack {
  getStartPosition(i: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    return {
      position: new THREE.Vector3((i - 5.5) * SPACING, 0.0, 0),
      quaternion: new THREE.Quaternion(),
    };
  }

  private hit: GroundHit = {
    hit: true,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    surface: SurfaceType.Road,
  };

  raycastGround(origin: THREE.Vector3, _up: THREE.Vector3, maxDist: number): GroundHit {
    this.hit.hit = origin.y <= maxDist;
    this.hit.point.set(origin.x, 0, origin.z);
    this.hit.distance = Math.max(0, origin.y);
    return this.hit;
  }
}

class StubPhysics {
  private scale = new Map<number, number>();
  private shrink = new Map<number, number>();
  private brake = new Map<number, number>();

  setTuning(): void { /* the harness reads tunings straight from Tuning.ts */ }
  visualScaleOf(id: number): number { return this.scale.get(id) ?? 1; }
  visualShrinkOf(id: number): number { return this.shrink.get(id) ?? 1; }
  getBody(id: number): { ctrlBrake: number } { return { ctrlBrake: this.brake.get(id) ?? 0 }; }
  setSquash(id: number, v: number): void { this.scale.set(id, v); }
  setShrink(id: number, v: number): void { this.shrink.set(id, v); }
  setBrake(id: number, v: number): void { this.brake.set(id, v); }
}

// ===========================================================================
//  Scene
// ===========================================================================

const app = document.getElementById('app') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
const portraitStrip = document.getElementById('portraits') as HTMLElement | null;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1120);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 500);
camera.position.set(2.6, 1.5, 3.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.45, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.12;

// --- environment ---------------------------------------------------------
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envScene = new RoomEnvironment();
const envRt = pmrem.fromScene(envScene, 0.03);
scene.environment = envRt.texture;
scene.environmentIntensity = 0.85;

// --- studio three-point lighting ----------------------------------------
const key = new THREE.DirectionalLight(0xfff2e0, 3.4);
key.position.set(4.5, 6.5, 5.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 60;
key.shadow.camera.left = -26;
key.shadow.camera.right = 26;
key.shadow.camera.top = 12;
key.shadow.camera.bottom = -6;
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.02;
scene.add(key);

const fill = new THREE.DirectionalLight(0x9fc4ff, 1.1);
fill.position.set(-6.0, 3.0, 3.5);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffd9a0, 2.6);
rim.position.set(-2.0, 3.2, -7.0);
scene.add(rim);

scene.add(new THREE.HemisphereLight(0x9fbfff, 0x2a2418, 0.55));

// --- studio floor --------------------------------------------------------
function floorTexture(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2d');
  g.fillStyle = '#3b4250';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 26000; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    const v = 40 + Math.random() * 60;
    g.fillStyle = `rgba(${v},${v + 4},${v + 10},0.28)`;
    g.fillRect(x, y, 2, 2);
  }
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    g.beginPath(); g.moveTo((i / 8) * s, 0); g.lineTo((i / 8) * s, s); g.stroke();
    g.beginPath(); g.moveTo(0, (i / 8) * s); g.lineTo(s, (i / 8) * s); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 24);
  t.anisotropy = 8;
  return t;
}
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.72, metalness: 0.05 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ===========================================================================
//  Karts
// ===========================================================================

const tier = ((new URLSearchParams(location.search).get('q') ?? 'ultra') as QualityTier);
const quality = { ...QUALITY_PRESETS[tier] };
const track = new FlatTrack();
const physics = new StubPhysics();
const karts = new KartManager(scene, renderer, track, physics, quality);

interface Forced {
  drift: boolean;
  boost: boolean;
  stun: boolean;
  squash: boolean;
  finish: boolean;
  ghost: boolean;
  roll: boolean;
}
const forced: Forced = {
  drift: false, boost: false, stun: false, squash: false,
  finish: false, ghost: false, roll: false,
};

let focus = 0;
let showAll = true;
let turntable = true;
let speed = 18;
let lodOverride = -1;
let wireframe = false;
let spin = 0;
let yaw = 0;
let t0 = performance.now();
let elapsed = 0;
let frame = 0;
let accumulator = 0;

const ctx = { dt: 0, fixedDt: FIXED_DT, elapsed: 0, frame: 0, alpha: 0 };

window.addEventListener('unhandledrejection', (e) => {
  console.error('[karts bench] unhandled rejection:', e.reason);
});
window.addEventListener('error', (e) => {
  console.error('[karts bench] error:', e.message, e.error);
});

let initMs = 0;
try {
  const t = performance.now();
  await karts.init();
  initMs = performance.now() - t;
  console.log(`[karts bench] init ${initMs.toFixed(0)} ms`);
} catch (err) {
  console.error('[karts bench] KartManager.init failed:', err);
  hud.textContent = `init failed: ${String(err)}`;
  throw err;
}
karts.setCamera(camera);

// The stub grid can't know each chassis' ride height, so settle every kart onto
// the floor now that the models exist.
for (const k of karts.karts) {
  const m = karts.modelOf(k.id);
  if (m) k.position.y = -m.restGroundY;
}

// ===========================================================================
//  Fake physics — write the fields the visual layer reads
// ===========================================================================

function driveStates(dt: number): void {
  yaw += turntable ? dt * 0.55 : 0;
  spin += (speed / 0.33) * dt;

  for (let i = 0; i < karts.karts.length; i++) {
    const k = karts.karts[i];
    const focused = i === focus;
    const active = showAll || focused;

    // Yaw: turntable rotation about the kart's own axis.
    const myYaw = turntable ? yaw + i * 0.0 : 0;
    const roll = forced.roll && (active) ? 0.10 : 0;
    const e = new THREE.Euler(0, myYaw, -roll, 'YXZ');
    k.groundQuaternion.setFromEuler(new THREE.Euler(0, myYaw, 0, 'YXZ'));
    k.quaternion.setFromEuler(e);

    k.speed = active ? speed : 0;
    k.speedRatio = clamp01(speed / 28);
    k.rpm = clamp01(0.15 + k.speedRatio * 0.8);
    k.angularVelocity = forced.roll && active ? -1.6 : 0;
    k.grounded = true;
    k.airTime = 0;
    k.surface = SurfaceType.Road;

    const steer = forced.drift && active ? 0.34 : (forced.roll && active ? 0.30 : Math.sin(elapsed * 0.9) * 0.10);
    k.steerAngle = steer;

    for (let w = 0; w < 4; w++) {
      const bump = Math.sin(elapsed * 3.1 + w * 1.7) * 0.05;
      k.suspension[w] = clamp(0.32 + bump + (forced.drift && active && w % 2 === 1 ? -0.08 : 0), 0, 1);
      k.wheelSpin[w] = spin;
      k.wheelGrounded[w] = true;
    }

    k.drifting = forced.drift && active;
    k.driftDirection = k.drifting ? 1 : 0;
    k.driftStage = k.drifting
      ? (elapsed % 6 < 2 ? DriftStage.Charging : elapsed % 6 < 4 ? DriftStage.Blue : DriftStage.Orange)
      : DriftStage.None;
    k.driftCharge = k.drifting ? (elapsed % 2) / 2 : 0;

    k.boostTime = forced.boost && active ? 1 : 0;
    k.boostStrength = k.boostTime > 0 ? 1 : 0;

    k.stunned = forced.stun && active;
    k.stunTime = k.stunned ? 1 : 0;
    k.invulnerable = forced.ghost && active;
    k.starTime = 0;
    k.finished = forced.finish && active;

    physics.setSquash(k.id, forced.squash && active ? 0.34 : 1);
    physics.setBrake(k.id, 0);
  }
  void dt;
}

// ===========================================================================
//  Cameras
// ===========================================================================

type Preset = 'front34' | 'rear34' | 'side' | 'chase' | 'top';
let preset: Preset = 'front34';

function applyPreset(): void {
  const target = new THREE.Vector3();
  if (showAll) {
    target.set(0, 0.5, 0);
  } else {
    karts.getModel(focus).getWorldPosition(target);
    target.y += 0.34;
  }
  const d = showAll ? 6.2 : 1;
  let fov = 34;
  switch (preset) {
    case 'front34':
      camera.position.set(target.x + 2.35 * d, target.y + 1.30 * d, target.z - 3.00 * d);
      break;
    case 'rear34':
      camera.position.set(target.x - 2.20 * d, target.y + 1.25 * d, target.z + 3.15 * d);
      break;
    case 'side':
      camera.position.set(target.x + 4.30 * d, target.y + 0.42 * d, target.z + 0.20 * d);
      break;
    case 'chase':
      // How players actually see it: low, close, wide.
      camera.position.set(target.x + 0.10 * d, target.y + 0.62 * d, target.z + 3.20 * d);
      fov = 58;
      break;
    case 'top':
      camera.position.set(target.x + 0.02 * d, target.y + 4.4 * d, target.z + 1.6 * d);
      break;
  }
  controls.target.copy(target);
  camera.fov = showAll ? 30 : fov;
  camera.updateProjectionMatrix();
  controls.update();
}

// ===========================================================================
//  Portrait strip — the select-screen busts, side by side
// ===========================================================================
//  `KartManager.renderPortrait(id, size)` is what `MenuSystem.buildArt()`
//  calls for every racer. A headless probe can prove the framing, the types and
//  the disposal, but it cannot rasterise, so this is where a human (or the
//  visual critic) actually looks at the ten portraits. Press P.
// ===========================================================================

let portraitsBuilt = false;

function buildPortraitStrip(): void {
  if (!portraitStrip || portraitsBuilt) return;
  portraitsBuilt = true;
  const t = performance.now();
  for (const c of CHARACTERS) {
    const fig = document.createElement('figure');
    const art = karts.renderPortrait(c.id, 220);
    if (art instanceof HTMLCanvasElement) {
      fig.appendChild(art);
    } else {
      const miss = document.createElement('div');
      miss.className = 'miss';
      miss.textContent = art === '' ? 'no portrait' : String(art).slice(0, 24);
      fig.appendChild(miss);
    }
    const cap = document.createElement('figcaption');
    cap.textContent = c.name;
    fig.appendChild(cap);
    const f = karts.portraitFraming(c.id);
    const ndc = document.createElement('div');
    ndc.className = 'ndc';
    ndc.textContent = f
      ? `${f.inFrame ? 'inFrame' : 'OUT OF FRAME'} worst ${f.worst.toFixed(2)} head ${f.headFill.toFixed(2)}`
      : 'no framing';
    fig.appendChild(ndc);
    portraitStrip.appendChild(fig);
  }
  console.log(`[karts bench] ten portraits in ${(performance.now() - t).toFixed(0)} ms`);
}

function togglePortraits(): void {
  if (!portraitStrip) return;
  buildPortraitStrip();
  portraitStrip.classList.toggle('on');
}

// ===========================================================================
//  Input
// ===========================================================================

function setWireframe(on: boolean): void {
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const m = o.material;
      if (Array.isArray(m)) return;
      const mm = m as THREE.Material & { wireframe?: boolean };
      if ('wireframe' in mm) mm.wireframe = on;
    }
  });
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === '[') { focus = (focus + karts.karts.length - 1) % karts.karts.length; showAll = false; applyPreset(); }
  else if (k === ']') { focus = (focus + 1) % karts.karts.length; showAll = false; applyPreset(); }
  else if (k === 'a') { showAll = !showAll; applyPreset(); }
  else if (k === 't') turntable = !turntable;
  else if (k === '1') { preset = 'front34'; applyPreset(); }
  else if (k === '2') { preset = 'rear34'; applyPreset(); }
  else if (k === '3') { preset = 'side'; applyPreset(); }
  else if (k === '4') { preset = 'chase'; applyPreset(); }
  else if (k === '5') { preset = 'top'; applyPreset(); }
  else if (k === 'd') forced.drift = !forced.drift;
  else if (k === 'b') forced.boost = !forced.boost;
  else if (k === 'x') forced.stun = !forced.stun;
  else if (k === 'z') forced.squash = !forced.squash;
  else if (k === 'f') forced.finish = !forced.finish;
  else if (k === 'g') forced.ghost = !forced.ghost;
  else if (k === 'r') forced.roll = !forced.roll;
  else if (k === 'h') bus_hop();
  else if (k === 'p') togglePortraits();
  else if (k === 'l') { lodOverride = lodOverride >= 2 ? -1 : lodOverride + 1; }
  else if (k === 'w') { wireframe = !wireframe; setWireframe(wireframe); }
  else if (k === ',') speed = Math.max(0, speed - 3);
  else if (k === '.') speed = Math.min(40, speed + 3);
});

async function bus_hop(): Promise<void> {
  const { bus } = await import('@/core/EventBus');
  const ids = showAll ? karts.karts.map((k) => k.id) : [focus];
  for (const id of ids) {
    bus.emit('kart:hop', { kartId: id, position: karts.karts[id].position });
    setTimeout(() => bus.emit('kart:land', {
      kartId: id, position: karts.karts[id].position, impact: 9,
    }), 320);
  }
}

// ===========================================================================
//  Loop
// ===========================================================================

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
applyPreset();

let stats = karts.stats();

function frameLoop(now: number): void {
  const dt = Math.min(0.1, (now - t0) / 1000);
  t0 = now;
  elapsed += dt;
  frame++;

  driveStates(dt);

  accumulator += dt;
  let steps = 0;
  ctx.dt = dt; ctx.elapsed = elapsed; ctx.frame = frame;
  while (accumulator >= FIXED_DT && steps < 8) {
    accumulator -= FIXED_DT;
    steps++;
    karts.fixedUpdate(ctx as FrameContext);
  }
  ctx.alpha = accumulator / FIXED_DT;
  karts.update(ctx as FrameContext);

  if (lodOverride >= 0) {
    for (const k of karts.karts) {
      karts.modelOf(k.id)?.setLod(lodOverride as 0 | 1 | 2);
    }
  }

  controls.update();
  renderer.render(scene, camera);

  if (frame % 10 === 0) {
    const ch = karts.characterOf(focus);
    const model = karts.modelOf(focus);
    const info = renderer.info;
    hud.textContent =
      `APEX KART — kart & character bench   [${tier}]\n` +
      `focus ${focus}  ${karts.getName(focus)}  ` +
      `(${ch ? BODY_NAMES[ch.bodyId] : '?'} / ${ch?.driverId ?? '?'})\n` +
      `lod ${model?.lodLevel ?? '-'}${lodOverride >= 0 ? ' (forced)' : ''}   ` +
      `tris/kart ${karts.trianglesOf(focus)}\n` +
      `cache: ${stats.assets.bodies} bodies, ${stats.assets.wheels} tyres, ` +
      `${stats.assets.drivers} drivers = ${stats.assets.tris} tris\n` +
      `init ${initMs.toFixed(0)} ms  ` +
      `(body ${stats.assets.ms.bodies} / tyre ${stats.assets.ms.wheels} / ` +
      `driver ${stats.assets.ms.drivers})\n` +
      `draws ${info.render.calls}  tris ${info.render.triangles}  ` +
      `speed ${speed.toFixed(0)} m/s  ${(1 / Math.max(dt, 1e-3)).toFixed(0)} fps\n` +
      `forced: ${Object.entries(forced).filter(([, v]) => v).map(([kk]) => kk).join(' ') || 'none'}`;
    stats = karts.stats();
  }
  renderer.info.reset();
  lastTick = now;
}

// Twelve agents share this browser, so this tab is frequently in the background
// where rAF is paused — which would leave the bench frozen mid-inspection.
// A slow interval keeps it stepping so screenshots and probes always work.
let lastTick = 0;
function raf(now: number): void {
  requestAnimationFrame(raf);
  frameLoop(now);
}
requestAnimationFrame(raf);
setInterval(() => {
  const now = performance.now();
  if (now - lastTick > 220) frameLoop(now);
}, 120);

interface DevWindow { __KARTS__?: unknown }
(window as unknown as DevWindow).__KARTS__ = {
  karts, scene, camera, renderer, forced,
  setPreset: (p: Preset) => { preset = p; applyPreset(); },
  setFocus: (i: number) => { focus = i; showAll = false; applyPreset(); },
  setAll: (v: boolean) => { showAll = v; applyPreset(); },
  setTurntable: (v: boolean) => { turntable = v; },
  setYaw: (v: number) => { yaw = v; },
  setSpeed: (v: number) => { speed = v; },
  setLod: (v: number) => { lodOverride = v; },
  stats: () => karts.stats(),
  // Portrait inspection for the visual pass: `portraits()` shows the strip,
  // `framings()` dumps the NDC numbers the headless probe asserts on.
  portraits: () => { togglePortraits(); },
  framings: () => CHARACTERS.map((c) => karts.portraitFraming(c.id)),
};
