/**
 * ============================================================================
 *  APEX KART — PHYSICS BENCH  (dev page, not shipped)
 * ============================================================================
 *  The browser half of the physics bench: a visible box-kart with four
 *  suspension-driven wheel markers, a chase camera, keyboard control via
 *  `@/core/Input`, and a live readout of every number that matters.
 *
 *  The `TestTrack`, the shared `PhysicsWorld` and the whole assertion suite
 *  live in `./physics-tests`, which has NO DOM dependency and therefore runs
 *  under plain Node:
 *
 *      node src/dev/node-run.mjs src/dev/physics-run.ts
 *
 *  They were one file until the suite turned out to be unrunnable headlessly —
 *  this page constructs a real `THREE.WebGLRenderer` at import time, so merely
 *  importing it needed a GPU. Keep the split: anything that touches `document`
 *  belongs here, anything that asserts a number belongs there.
 *
 *  `window.__PHYS__.report()` still runs the battery and returns plain text,
 *  and `T` still triggers it from the keyboard.
 * ============================================================================
 */

import * as THREE from 'three';
import { Engine } from '@/core/Engine';
import { Input } from '@/core/Input';
import { bus } from '@/core/EventBus';
import { DriftStage, SurfaceType, type FrameContext, type KartState } from '@/core/Types';
import { clamp, clamp01 } from '@/core/MathUtils';
import { makeTuning } from '@/physics/Tuning';
import type { PhysicsWorld } from '@/physics/PhysicsWorld';
import {
  CHARS,
  G,
  KART_COUNT,
  LAP,
  ROAD,
  TestTrack,
  WALL_HEIGHT,
  formatReport,
  geoAt,
  karts,
  physics,
  resetAll,
  resetPlayer,
  runAll,
  stepPhysics,
  track,
  wallInsetFor,
  type FullReport,
} from './physics-tests';

// ===========================================================================
//  SCENE
// ===========================================================================

const app = document.getElementById('app') as HTMLElement;
const hudEl = document.getElementById('hud') as HTMLElement;
const barsEl = document.getElementById('bars') as HTMLElement;
const resultsEl = document.getElementById('results') as HTMLElement;

const engine = new Engine(app, 'high');
engine.adaptiveResolution = false;
const input = new Input(engine.canvas);
input.init();

// --- lighting (functional, not art-directed — this page is a bench) --------
const scene = engine.scene;
scene.background = new THREE.Color(0x0a0d16);
scene.fog = new THREE.Fog(0x0a0d16, 180, 520);
const sun = new THREE.DirectionalLight(0xfff2df, 2.6);
sun.position.set(-60, 90, 40);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x8fb7ff, 0x2a2418, 0.85));

// --- track mesh ------------------------------------------------------------
function buildTrackMesh(): THREE.Mesh {
  const along = 480;
  const across = 15;
  const verts = new Float32Array(along * across * 3);
  const cols = new Float32Array(along * across * 3);
  const idx: number[] = [];
  const c = new THREE.Color();
  const p = new THREE.Vector3();

  for (let i = 0; i < along; i++) {
    const d = (i / (along - 1)) * LAP;
    const s = track.sampleAtDistance(d);
    p.copy(s.position);
    const bx = s.binormal.x;
    const bz = s.binormal.z;
    for (let j = 0; j < across; j++) {
      const u = (j / (across - 1) - 0.5) * 2 * (ROAD + 8);
      const x = p.x + bx * u;
      const z = p.z + bz * u;
      const y = track.heightAt(x, z);
      const o = (i * across + j) * 3;
      verts[o] = x;
      verts[o + 1] = Number.isFinite(y) ? y : 0;
      verts[o + 2] = z;

      const surf = track.surfaceAt(new THREE.Vector3(x, 0, z));
      if (Math.abs(u) > ROAD) c.setHex(0x2f4a24);
      else if (surf === SurfaceType.Boost) c.setHex(0xd8761f);
      else if (surf === SurfaceType.AntiGravity) c.setHex(0x3b2f6e);
      else c.setHex(0x33363d);
      // Faint lateral striping so motion and banking are legible.
      const stripe = j % 2 === 0 ? 1.0 : 0.9;
      const kerb = Math.abs(u) > ROAD - 1.1 && Math.abs(u) <= ROAD ? 1.9 : 1;
      cols[o] = c.r * stripe * kerb;
      cols[o + 1] = c.g * stripe * kerb * (kerb > 1 ? 0.45 : 1);
      cols[o + 2] = c.b * stripe * kerb * (kerb > 1 ? 0.45 : 1);
    }
  }
  for (let i = 0; i < along - 1; i++) {
    for (let j = 0; j < across - 1; j++) {
      const a = i * across + j;
      const b = a + 1;
      const cc = a + across;
      const dd = cc + 1;
      idx.push(a, cc, b, b, cc, dd);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.04 }),
  );
}

function buildWallMesh(): THREE.Mesh {
  const along = 420;
  const verts: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? 1 : -1;
    for (let i = 0; i < along; i++) {
      const d = (i / (along - 1)) * LAP;
      const s = track.sampleAtDistance(d);
      geoAt(s.position.x, s.position.z);
      const inset = wallInsetFor(G.region, G.cz);
      const x = s.position.x + s.binormal.x * inset * sgn;
      const z = s.position.z + s.binormal.z * inset * sgn;
      const y = track.heightAt(x, z);
      const y0 = Number.isFinite(y) ? y : 0;
      verts.push(x, y0, z, x, y0 + WALL_HEIGHT, z);
    }
    for (let i = 0; i < along - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    base += along * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: 0x9aa6bb,
      roughness: 0.6,
      metalness: 0.25,
      side: THREE.DoubleSide,
    }),
  );
}

const trackMesh = buildTrackMesh();
scene.add(trackMesh);
const wallMesh = buildWallMesh();
scene.add(wallMesh);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(700, 700),
  new THREE.MeshStandardMaterial({ color: 0x1b2a16, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.06;
scene.add(ground);

/** Flat-mode floor, swapped in for the scripted tests. */
const flatFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600, 30, 30),
  new THREE.MeshStandardMaterial({ color: 0x30343c, roughness: 0.85, wireframe: false }),
);
flatFloor.rotation.x = -Math.PI / 2;
flatFloor.visible = false;
scene.add(flatFloor);

// --- kart visuals ----------------------------------------------------------
const bodyGeo = new THREE.BoxGeometry(1, 1, 1);
const noseGeo = new THREE.BoxGeometry(0.5, 0.22, 0.5);
const wheelGeo = new THREE.CylinderGeometry(1, 1, 0.26, 16);
wheelGeo.rotateZ(Math.PI / 2);
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.75 });
const wheelMatAir = new THREE.MeshStandardMaterial({ color: 0xff4d4d, roughness: 0.6 });

interface KartVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  nose: THREE.Mesh;
  wheels: THREE.Mesh[];
}
const visuals: KartVisual[] = [];
const HUES = [0.55, 0.02, 0.12, 0.3, 0.45, 0.68, 0.78, 0.88, 0.62, 0.18, 0.35, 0.5];
for (let i = 0; i < KART_COUNT; i++) {
  const t = physics.tuningOf(i)!;
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(HUES[i % HUES.length], 0.75, i === 0 ? 0.55 : 0.4),
    roughness: 0.45,
    metalness: 0.3,
  });
  const body = new THREE.Mesh(bodyGeo, mat);
  body.scale.set(t.halfExtents.x * 2, t.halfExtents.y * 2, t.halfExtents.z * 2);
  group.add(body);
  const nose = new THREE.Mesh(noseGeo, new THREE.MeshStandardMaterial({ color: 0xffe6a0 }));
  nose.position.set(0, t.halfExtents.y * 0.6, -t.halfExtents.z);
  group.add(nose);
  const wheels: THREE.Mesh[] = [];
  for (let w = 0; w < 4; w++) {
    const m = new THREE.Mesh(wheelGeo, wheelMat);
    m.scale.setScalar(t.wheelRadius);
    group.add(m);
    wheels.push(m);
  }
  scene.add(group);
  visuals.push({ group, body, nose, wheels });
}

// ===========================================================================
//  DRIVING
// ===========================================================================

const camera = engine.camera;
const camPos = new THREE.Vector3(0, 8, 20);
const camTarget = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

let paused = false;
let charIndex = 0;

resetAll();

/** Dumb lane-follower so the AI karts move and collide. */
const aiScratch = new THREE.Vector3();
function driveAI(i: number): void {
  const b = physics.getBody(i);
  if (!b) return;
  const s = track.project(b.position);
  aiScratch.copy(track.racingLineAt(s.t, 14 + i * 0.7)).sub(b.position);
  const fwdErr = aiScratch.dot(b.forward);
  const sideErr = aiScratch.dot(b.right);
  const steer = clamp((sideErr / Math.max(4, Math.abs(fwdErr))) * -2.4, -1, 1);
  const wantDrift = Math.abs(steer) > 0.72 && b.forwardSpeed > 12;
  physics.setControl(i, {
    steer,
    accel: 1,
    brake: 0,
    drift: wantDrift,
    driftPressed: wantDrift && !b.ctrlDrift,
  });
}

// --- events (proof that the bus contract is honoured) ----------------------
const log: string[] = [];
function pushLog(s: string): void {
  log.unshift(s);
  if (log.length > 7) log.pop();
}
bus.on('kart:hop', (e) => e.kartId === 0 && pushLog('hop'));
bus.on('kart:driftStart', (e) => e.kartId === 0 && pushLog(`driftStart ${e.direction > 0 ? 'R' : 'L'}`));
bus.on('kart:driftTier', (e) => e.kartId === 0 && pushLog(`TIER ${e.tier}`));
bus.on('kart:driftRelease', (e) => e.kartId === 0 && pushLog(`release t${e.tier} ${e.boostTime.toFixed(2)}s`));
bus.on('kart:boost', (e) => e.kartId === 0 && pushLog(`boost ${e.source} ${e.duration.toFixed(2)}s`));
bus.on('kart:trick', (e) => e.kartId === 0 && pushLog(`TRICK ${e.name}`));
bus.on('kart:wallHit', (e) => e.kartId === 0 && pushLog(`wall ${e.impact.toFixed(1)} m/s`));
bus.on('kart:kartHit', (e) => (e.a === 0 || e.b === 0) && pushLog(`bump ${e.impact.toFixed(1)}`));
bus.on('kart:land', (e) => e.kartId === 0 && e.impact > 0 && pushLog(`land ${e.impact.toFixed(1)}`));
bus.on('kart:respawn', (e) => e.kartId === 0 && pushLog('RESPAWN'));
bus.on('kart:spinout', (e) => e.kartId === 0 && pushLog('SPINOUT'));

// --- harness subsystem ----------------------------------------------------
const harness = {
  fixedUpdate(): void {
    if (paused) return;
    for (let i = 1; i < KART_COUNT; i++) driveAI(i);
  },
  update(ctx: FrameContext): void {
    if (!paused) {
      const s = input.state;
      physics.setControl(0, {
        steer: s.steer,
        accel: s.accel,
        brake: s.brake,
        drift: s.drift,
        driftPressed: s.driftPressed,
      });
    }
    syncVisuals();
    updateCamera(ctx.dt);
    updateHud();
  },
};

function syncVisuals(): void {
  for (let i = 0; i < KART_COUNT; i++) {
    const st = karts[i];
    const t = physics.tuningOf(i)!;
    const v = visuals[i];
    v.group.position.copy(st.position);
    v.group.quaternion.copy(st.quaternion);
    v.body.scale.set(
      t.halfExtents.x * 2 * physics.visualShrinkOf(i),
      t.halfExtents.y * 2 * physics.visualScaleOf(i) * physics.visualShrinkOf(i),
      t.halfExtents.z * 2 * physics.visualShrinkOf(i),
    );
    for (let w = 0; w < 4; w++) {
      const off = t.wheelOffsets[w];
      // Compression 0 = fully extended (hangs low), 1 = bottomed out (tucked up).
      const drop = t.suspensionRest - st.suspension[w] * t.suspensionTravel;
      v.wheels[w].position.set(off.x, off.y - drop, off.z);
      v.wheels[w].rotation.x = st.wheelSpin[w];
      v.wheels[w].material = st.wheelGrounded[w] ? wheelMat : wheelMatAir;
      if (w < 2) v.wheels[w].rotation.y = st.steerAngle;
    }
  }
}

function updateCamera(dt: number): void {
  const st = karts[0];
  _v.set(0, 0, 1).applyQuaternion(st.groundQuaternion);
  _v2.set(0, 1, 0).applyQuaternion(st.groundQuaternion);
  const back = 8.5 + clamp01(Math.abs(st.speed) / 30) * 3.5;
  camTarget.copy(st.position).addScaledVector(_v, back).addScaledVector(_v2, 3.4);
  const k = 1 - Math.exp(-7 * dt);
  camPos.lerp(camTarget, k);
  camera.position.copy(camPos);
  _v.copy(st.position).addScaledVector(_v2, 1.0);
  camera.lookAt(_v);
}

function bar(label: string, v: number, color: string, text: string): string {
  const pct = Math.round(clamp01(v) * 100);
  return `<div class="row">${label} <span style="float:right">${text}</span><div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div></div>`;
}

const STAGE_NAMES = ['—', 'charge', 'BLUE', 'ORANGE', 'PURPLE'];
const SURF_NAMES = [
  'Road', 'OffRoad', 'Dirt', 'Grass', 'Sand', 'Water', 'Ice',
  'Metal', 'Wood', 'Boost', 'AntiGrav', 'Glider', 'Void',
];

function updateHud(): void {
  const st = karts[0];
  const b = physics.getBody(0)!;
  const t = b.tuning;
  const kmh = st.speed * 3.6;
  hudEl.innerHTML =
    `<b>${CHARS[charIndex % CHARS.length]}</b>  ${paused ? '[PAUSED]' : ''}\n` +
    `speed    ${st.speed.toFixed(2)} m/s  (${kmh.toFixed(0)} km/h)  cap ${t.maxSpeed.toFixed(1)}\n` +
    `drift    ${STAGE_NAMES[st.driftStage]}  charge ${(st.driftCharge * 100).toFixed(0)}%  dir ${st.driftDirection}\n` +
    `dAngle   ${((b.driftAngle * 180) / Math.PI).toFixed(1)}°   slip ${((st.speed !== 0 ? b.slipAngle : 0) * 180 / Math.PI).toFixed(1)}°\n` +
    `grip     ${b.gripFactor.toFixed(2)}   latAccel ${b.latAccelUsed.toFixed(1)} m/s²\n` +
    `boost    ${st.boostTime.toFixed(2)}s × ${st.boostStrength.toFixed(2)}\n` +
    `susp     ${st.suspension.map((v) => v.toFixed(2)).join(' ')}\n` +
    `ground   ${st.wheelGrounded.map((v) => (v ? '#' : '.')).join(' ')}  air ${st.airTime.toFixed(2)}s\n` +
    `pitch    ${((b.pitch * 180) / Math.PI).toFixed(1)}°  roll ${((b.roll * 180) / Math.PI).toFixed(1)}°  lean ${((b.driftLean * 180) / Math.PI).toFixed(1)}°\n` +
    `surface  ${SURF_NAMES[st.surface]}   yaw ${st.angularVelocity.toFixed(2)} rad/s\n` +
    `phys     ${physics.stepMs.toFixed(3)} ms/step (12 karts)  fps ${engine.fpsAverage.toFixed(0)}\n` +
    `\n${log.join('\n')}`;

  barsEl.innerHTML =
    bar('speed', Math.abs(st.speed) / 42, '#4fc3ff', `${st.speed.toFixed(1)}`) +
    bar('drift charge', st.driftCharge, ['#888', '#888', '#3aa0ff', '#ff9d2e', '#c964ff'][st.driftStage], STAGE_NAMES[st.driftStage]) +
    bar('boost', st.boostTime / 2, '#ffd45e', `${st.boostTime.toFixed(2)}`) +
    bar('rpm', st.rpm, '#ff6f91', st.rpm.toFixed(2)) +
    bar('FL', st.suspension[0], '#9be36b', st.suspension[0].toFixed(2)) +
    bar('FR', st.suspension[1], '#9be36b', st.suspension[1].toFixed(2)) +
    bar('RL', st.suspension[2], '#6bd8e3', st.suspension[2].toFixed(2)) +
    bar('RR', st.suspension[3], '#6bd8e3', st.suspension[3].toFixed(2));
}

engine.add(physics);
engine.add(input);
engine.add(harness);
engine.add({ update: () => input.endFrame() });
void engine.initAll().then(() => engine.start());

// --- extra keys -----------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') resetAll();
  else if (e.code === 'KeyP') paused = !paused;
  else if (e.code === 'KeyB') physics.applyBoost(0, 1.4, 1.0, 'item');
  else if (e.code === 'KeyK') physics.applyStun(0, 1.1, 'spin');
  else if (e.code === 'KeyL') physics.applyStun(0, 2.0, 'squash');
  else if (e.code === 'KeyC') {
    charIndex = (charIndex + 1) % CHARS.length;
    physics.setTuning(0, makeTuning(CHARS[charIndex], 150));
  } else if (e.code === 'Escape') resultsEl.classList.remove('on');
  else if (e.code === 'KeyT') {
    resultsEl.classList.add('on');
    resultsEl.innerHTML = 'running…';
    setTimeout(() => {
      const r = runAll(RUN_HOOKS);
      resultsEl.innerHTML = formatReport(r);
    }, 30);
  }
});

/**
 * Quiesce the page around a battery run: the render loop and the keyboard
 * control feed must both stop, or the suite's scripted inputs fight live ones.
 */
const RUN_HOOKS = {
  before: () => {
    wasPaused = paused;
    paused = true;
    engine.stop();
  },
  after: () => {
    paused = wasPaused;
    engine.start();
  },
};
let wasPaused = false;

// ===========================================================================
//  PROBE SURFACE
// ===========================================================================

declare global {
  interface Window {
    __PHYS__: {
      physics: PhysicsWorld;
      track: TestTrack;
      karts: KartState[];
      engine: Engine;
      runAll: () => FullReport;
      report: () => string;
      setPaused: (v: boolean) => void;
      step: (n: number) => void;
      reset: () => void;
    };
  }
}

window.__PHYS__ = {
  physics,
  track,
  karts,
  engine,
  runAll: () => runAll(RUN_HOOKS),
  report: () => {
    const r = runAll(RUN_HOOKS);
    return formatReport(r)
      .replace(/<[^>]+>/g, '')
      .trim();
  },
  setPaused: (v: boolean) => {
    paused = v;
  },
  step: stepPhysics,
  reset: resetAll,
};

// eslint-disable-next-line no-console
console.log('[physics bench] ready — window.__PHYS__ , press T for the assertion suite');
