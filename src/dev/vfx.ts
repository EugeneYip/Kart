/**
 * ============================================================================
 *  FOXY KART — VFX DEV HARNESS
 * ============================================================================
 *  A dark stage with a textured deck, a guardrail, some pillars and a stand-in
 *  kart, so the VFX layer can be built and judged without waiting on the track,
 *  kart or render agents. Depends on nothing outside `@/core` and `@/vfx`.
 *
 *  The kart drives for real (steer / accel / drift charge / boost), which means
 *  DriftSparks, SurfaceParticles, BoostFlame, Trails and Decals are all driven
 *  from a genuine KartState rather than being poked directly. Sockets are real
 *  Object3D nodes on the chassis, so `getSocket()` is exercised too.
 *
 *  Delete once the real scene can host the VFX layer.
 * ============================================================================
 */

import * as THREE from 'three';
import {
  DriftStage, SurfaceType,
  type FrameContext, type ItemType, type KartState,
} from '@/core/Types';
import { FIXED_DT, QUALITY_PRESETS, SURFACES } from '@/core/Config';
import { bus } from '@/core/EventBus';
import { clamp, clamp01 } from '@/core/MathUtils';
import { VfxManager } from '@/vfx/VfxManager';

// Twelve agents are editing this repo at once, and Vite broadcasts a full page
// reload to every client whenever any of them saves a non-HMR-able module. That
// wipes a capture mid-inspection, so this page opts out: throwing inside the
// hook aborts the reload before `location.reload()`. Reload by hand instead.
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', () => {
    throw new Error('[vfx harness] full reload suppressed');
  });
}

// ===========================================================================
//  Stand-in kart
// ===========================================================================

const SOCKET_OFFSETS: Record<string, [number, number, number]> = {
  exhaustL: [-0.42, -0.02, 0.86],
  exhaustR: [0.42, -0.02, 0.86],
  wheelFL: [-0.60, -0.26, -0.62],
  wheelFR: [0.60, -0.26, -0.62],
  wheelRL: [-0.60, -0.26, 0.62],
  wheelRR: [0.60, -0.26, 0.62],
  rearCentre: [0, 0.0, 0.9],
  itemMount: [0, 0.35, -0.2],
  driverHead: [0, 0.62, 0.05],
};

function makeKart(id: number, isPlayer: boolean): KartState {
  return {
    id, isPlayer,
    position: new THREE.Vector3(0, 0.42, 0),
    quaternion: new THREE.Quaternion(),
    groundQuaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    speed: 0, speedRatio: 0, angularVelocity: 0,
    steerAngle: 0,
    suspension: [0.5, 0.5, 0.5, 0.5],
    wheelSpin: [0, 0, 0, 0],
    wheelGrounded: [true, true, true, true],
    grounded: true, airTime: 0, surface: SurfaceType.Road,
    drifting: false, driftStage: DriftStage.None, driftDirection: 0, driftCharge: 0,
    boostTime: 0, boostStrength: 1,
    hopping: false, stunned: false, stunTime: 0, invulnerable: false, starTime: 0,
    gliding: false, antiGravity: false,
    lap: 1, progress: 0, racePosition: 1, finished: false, finishTime: 0, lapTimes: [],
    rpm: 0, heldItem: null as ItemType | null, itemCount: 0,
  };
}

class KartStub {
  readonly karts: KartState[] = [];
  readonly player: KartState;
  readonly group = new THREE.Group();
  private sockets = new Map<string, THREE.Object3D>();
  /** Second kart, parked, so kart-vs-kart effects have a target. */
  readonly other: KartState;

  constructor(scene: THREE.Scene) {
    this.player = makeKart(0, true);
    this.other = makeKart(1, false);
    this.other.position.set(9, 0.42, -6);
    this.karts.push(this.player, this.other);

    scene.add(this.group);
    for (const name of Object.keys(SOCKET_OFFSETS)) {
      const o = new THREE.Object3D();
      const [x, y, z] = SOCKET_OFFSETS[name];
      o.position.set(x, y, z);
      this.group.add(o);
      this.sockets.set(name, o);
    }
  }

  /** Only the player has real sockets; the parked kart falls back to offsets. */
  getSocket(kartId: number, name: string): THREE.Object3D | null {
    if (kartId !== 0) return null;
    return this.sockets.get(name) ?? null;
  }

  syncTransform(): void {
    this.group.position.copy(this.player.position);
    this.group.quaternion.copy(this.player.quaternion);
    this.group.updateMatrixWorld(true);
  }
}

// ===========================================================================
//  Stage
// ===========================================================================

function deckTexture(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2d context');
  g.fillStyle = '#2a2c31';
  g.fillRect(0, 0, s, s);
  // Aggregate speckle so the soft-particle fade has detail to sit against.
  for (let i = 0; i < 26000; i++) {
    const v = 24 + Math.random() * 70;
    g.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.25 + Math.random() * 0.5})`;
    const r = Math.random() * 2.4 + 0.4;
    g.beginPath();
    g.arc(Math.random() * s, Math.random() * s, r, 0, 6.283);
    g.fill();
  }
  // A lane stripe to judge decals and ground fades against a hard edge.
  g.fillStyle = 'rgba(236,238,245,0.86)';
  g.fillRect(s * 0.5 - 5, 0, 10, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  tex.anisotropy = 8;
  return tex;
}

const app = document.getElementById('app') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
const keysEl = document.getElementById('keys') as HTMLElement;
const lastEl = document.getElementById('last') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070a12);
scene.fog = new THREE.Fog(0x070a12, 60, 220);

const camera = new THREE.PerspectiveCamera(62, 1, 0.15, 2000);

const deck = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ map: deckTexture(), roughness: 0.82, metalness: 0.04 }),
);
deck.rotation.x = -Math.PI / 2;
deck.receiveShadow = true;
scene.add(deck);

// Guardrail + pillars: geometry for particles to fade against.
const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa3b2, roughness: 0.42, metalness: 0.7 });
const rail = new THREE.Mesh(new THREE.BoxGeometry(60, 1.1, 0.5), railMat);
rail.position.set(0, 0.75, -14);
rail.castShadow = true;
rail.receiveShadow = true;
scene.add(rail);

const pillarMat = new THREE.MeshStandardMaterial({ color: 0x5b6472, roughness: 0.7, metalness: 0.15 });
for (let i = -2; i <= 2; i++) {
  const p = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 6, 16), pillarMat);
  p.position.set(i * 9, 3, -16.5);
  p.castShadow = true;
  scene.add(p);
}

scene.add(new THREE.HemisphereLight(0x6c8ec0, 0x14161c, 0.55));
const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
sun.position.set(-24, 34, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
scene.add(sun);

// The stand-in chassis: readable silhouette, obvious facing.
const karts = new KartStub(scene);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd8452f, roughness: 0.35, metalness: 0.35 });
const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.62, 1.9), bodyMat);
body.position.y = 0.05;
body.castShadow = true;
karts.group.add(body);
const nose = new THREE.Mesh(
  new THREE.ConeGeometry(0.34, 0.7, 12),
  new THREE.MeshStandardMaterial({ color: 0x2b3a52, roughness: 0.4, metalness: 0.5 }),
);
nose.rotation.x = -Math.PI / 2;
nose.position.set(0, 0.06, -1.15);
nose.castShadow = true;
karts.group.add(nose);
for (const n of ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR']) {
  const w = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, 0.26, 14),
    new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.85 }),
  );
  w.rotation.z = Math.PI / 2;
  const o = karts.getSocket(0, n);
  if (o) { w.position.copy(o.position); w.position.y += 0.06; }
  w.castShadow = true;
  karts.group.add(w);
}
const otherBody = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.62, 1.9),
  new THREE.MeshStandardMaterial({ color: 0x2f7fd8, roughness: 0.35, metalness: 0.35 }));
otherBody.position.copy(karts.other.position);
otherBody.castShadow = true;
scene.add(otherBody);

// ===========================================================================
//  VFX
// ===========================================================================

const quality = { ...QUALITY_PRESETS.ultra };
const vfx = new VfxManager(scene, renderer, camera, karts, quality);

// ===========================================================================
//  Input
// ===========================================================================

const down = new Set<string>();
/** V cycles 1 → 0.15 → 0.03 so effect shape can be inspected frame by frame. */
const TIME_SCALES = [1, 0.15, 0.03];
let timeIdx = 0;
let camMode = 0;
let camYaw = 0;
let camPitch = 0.30;
let camDist = 11;
let dragging = false;
let effectScale = 1;
let surfaceIdx = 0;
let starMode = false;
let agMode = false;

const SURFACE_CYCLE: SurfaceType[] = [
  SurfaceType.Road, SurfaceType.Dirt, SurfaceType.Grass, SurfaceType.Sand,
  SurfaceType.Water, SurfaceType.Ice, SurfaceType.Metal, SurfaceType.OffRoad,
];

function note(s: string): void { lastEl.textContent = s; }

/** World point 6 m in front of the kart — where most one-shots are fired. */
const fireAt = new THREE.Vector3();
function firePoint(height = 0.6): THREE.Vector3 {
  fireAt.set(0, height, -6).applyQuaternion(karts.player.quaternion).add(karts.player.position);
  fireAt.y = height;
  return fireAt;
}

const tmpN = new THREE.Vector3();

const ACTIONS: Record<string, () => void> = {
  digit1: () => { vfx.burst('explosion', firePoint(1.0), undefined, effectScale); note('explosion'); },
  digit2: () => { vfx.burst('bigExplosion', firePoint(1.2), undefined, effectScale); note('bigExplosion (blue shell)'); },
  digit3: () => { vfx.burst('impact', firePoint(0.9), undefined, effectScale); note('impact'); },
  digit4: () => { vfx.burst('sparks', firePoint(0.5), undefined, effectScale); note('sparks'); },
  digit5: () => { vfx.burst('shellBreak', firePoint(0.6), undefined, effectScale); note('shellBreak'); },
  digit6: () => { vfx.burst('bananaSplat', firePoint(0.08), undefined, effectScale); note('bananaSplat'); },
  digit7: () => { vfx.burst('itemBox', firePoint(1.1), undefined, effectScale); note('itemBox shatter'); },
  digit8: () => { vfx.burst('coin', firePoint(1.0), undefined, effectScale); note('coin'); },
  digit9: () => { vfx.burst('starPop', karts.player.position, undefined, effectScale); note('starPop'); },
  digit0: () => {
    bus.emit('item:hit', {
      targetId: 0, sourceId: 1, item: 10 as ItemType, point: karts.player.position.clone(),
    });
    note('lightning (via item:hit)');
  },

  keyq: () => {
    tmpN.set(0, 0, 1);
    bus.emit('kart:wallHit', {
      kartId: 0, position: new THREE.Vector3(karts.player.position.x, 0.7, -13.6),
      impact: 0.85 * effectScale, normal: tmpN.clone(),
    });
    note('kart:wallHit');
  },
  keye: () => {
    bus.emit('kart:kartHit', {
      a: 0, b: 1, impact: 0.8 * effectScale,
      position: karts.player.position.clone().lerp(karts.other.position, 0.5),
    });
    note('kart:kartHit');
  },
  keyr: () => {
    bus.emit('kart:land', {
      kartId: 0, position: new THREE.Vector3(karts.player.position.x, 0.02, karts.player.position.z),
      impact: 0.9 * effectScale,
    });
    note('kart:land');
  },
  keyt: () => { bus.emit('kart:trick', { kartId: 0, name: 'spin' }); note('kart:trick'); },
  keyy: () => { vfx.burst('confetti', karts.player.position, undefined, effectScale); note('confetti'); },
  keyu: () => { vfx.burst('ink', firePoint(0.6), undefined, effectScale); vfx.burst('flash', firePoint(0.6), undefined, 0.0); note('ink (screen splat + deck splat)'); },
  keyi: () => { vfx.burst('bulletLaunch', karts.player.position, undefined, effectScale); note('bulletLaunch'); },
  keyo: () => { bus.emit('kart:respawn', { kartId: 0 }); note('kart:respawn'); },
  keyp: () => { bus.emit('kart:squash', { kartId: 0 }); note('kart:squash'); },

  keyg: () => { bus.emit('race:countdown', { count: 3 }); note('race:countdown'); },
  keyh: () => { bus.emit('race:start', { rocketStart: true }); note('race:start (GO + rocket)'); },
  keyj: () => { bus.emit('kart:spinout', { kartId: 0, position: karts.player.position.clone() }); note('kart:spinout'); },
  keyk: () => { vfx.burst('slip', karts.player.position, undefined, effectScale); note('banana slip'); },
  keyl: () => { vfx.burst('boostPop', karts.player.position, undefined, 1.4); note('boostPop'); },

  keyn: () => { bus.emit('kart:driftTier', { kartId: 0, tier: 2, position: karts.player.position.clone() }); note('driftTier BLUE'); },
  keym: () => { bus.emit('kart:driftTier', { kartId: 0, tier: 3, position: karts.player.position.clone() }); note('driftTier ORANGE'); },
  comma: () => { bus.emit('kart:driftTier', { kartId: 0, tier: 4, position: karts.player.position.clone() }); note('driftTier PURPLE'); },

  keyf: () => { vfx.flash(0xffffff, 1.0, 0.3); note('flash'); },
  keyb: () => {
    surfaceIdx = (surfaceIdx + 1) % SURFACE_CYCLE.length;
    const s = SURFACE_CYCLE[surfaceIdx];
    const prev = karts.player.surface;
    karts.player.surface = s;
    bus.emit('kart:surfaceChange', { kartId: 0, from: prev, to: s });
    note(`surface → ${SurfaceType[s]} (${SURFACES[s].particle})`);
  },
  keyv: () => {
    timeIdx = (timeIdx + 1) % TIME_SCALES.length;
    note(timeIdx === 0 ? 'realtime' : `SLOW MOTION ${TIME_SCALES[timeIdx]}x`);
  },
  keyc: () => {
    const on = !vfx.depthPrepassEnabled;
    vfx.setDepthPrepass(on);
    note(`depth prepass ${on ? 'ON' : 'OFF'}`);
  },
  keyx: () => { camMode = (camMode + 1) % 3; note(['chase', 'low + wide', 'top-down'][camMode]); },
  keyz: () => { vfx.clear(); note('cleared'); },
  bracketleft: () => { effectScale = Math.max(0.3, effectScale - 0.2); note(`scale ${effectScale.toFixed(1)}`); },
  bracketright: () => { effectScale = Math.min(3, effectScale + 0.2); note(`scale ${effectScale.toFixed(1)}`); },
  period: () => { starMode = !starMode; note(`star power ${starMode ? 'ON' : 'OFF'}`); },
  slash: () => { agMode = !agMode; note(`anti-gravity ${agMode ? 'ON' : 'OFF'}`); },
};

window.addEventListener('keydown', (e) => {
  const code = e.code.toLowerCase();
  if (!down.has(code)) {
    const fn = ACTIONS[code];
    if (fn) { fn(); e.preventDefault(); }
  }
  down.add(code);
  if (code === 'space') e.preventDefault();
});
window.addEventListener('keyup', (e) => down.delete(e.code.toLowerCase()));
renderer.domElement.addEventListener('pointerdown', () => { dragging = true; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  camYaw -= e.movementX * 0.005;
  camPitch = clamp(camPitch + e.movementY * 0.004, -0.25, 1.2);
});
renderer.domElement.addEventListener('wheel', (e) => {
  camDist = clamp(camDist + e.deltaY * 0.02, 3.5, 60);
  e.preventDefault();
}, { passive: false });

keysEl.innerHTML = [
  '<b>drive</b>  W/S accel·brake   A/D steer   SHIFT drift   SPACE boost',
  '<b>blasts</b> 1 explosion  2 blue-shell  3 impact  4 sparks  5 shell  6 banana',
  '<b>items</b>  7 item-box  8 coin  9 star  0 lightning  U ink  I bullet',
  '<b>hits</b>   Q wall  E kart  R land  J spinout  K slip  P squash  O respawn',
  '<b>race</b>   G countdown  H GO  Y confetti  T trick  L boost-pop  F flash',
  '<b>drift</b>  N blue  M orange  , purple',
  '<b>stage</b>  B surface  . star-power  / anti-grav  [ ] scale  X camera',
  '<b>debug</b>  V slow-mo  C depth-prepass  Z clear   drag/wheel = orbit',
].join('\n');

// ===========================================================================
//  Loop
// ===========================================================================

const ctx = { dt: 1 / 60, fixedDt: FIXED_DT, elapsed: 0, frame: 0, alpha: 0 };
let last = performance.now();
let frameMs = 16;
let vfxMs = 0;
let driftHeld = 0;
let boostQueued = false;

const HALF = new THREE.Quaternion();
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();

function driveKart(dt: number): void {
  const k = karts.player;
  const accel = (down.has('keyw') ? 1 : 0) - (down.has('keys') ? 1 : 0);
  const steer = (down.has('keya') ? 1 : 0) - (down.has('keyd') ? 1 : 0);
  const wantDrift = down.has('shiftleft') || down.has('shiftright');

  // Speed
  const maxSpeed = 28 * (SURFACES[k.surface]?.speedMul ?? 1) * (k.boostTime > 0 ? 1.45 : 1);
  const target = accel > 0 ? maxSpeed : accel < 0 ? -6 : 0;
  const rate = accel !== 0 ? 16 : 9;
  k.speed += clamp(target - k.speed, -rate * dt * 3, rate * dt);
  k.speedRatio = clamp01(Math.abs(k.speed) / 28);
  k.rpm = clamp01(0.15 + k.speedRatio * 0.85);

  // Drift state machine — mirrors the real tier timings closely enough to
  // judge the escalation visually.
  if (wantDrift && Math.abs(k.speed) > 6) {
    if (!k.drifting) {
      k.drifting = true;
      k.driftDirection = steer !== 0 ? Math.sign(steer) : 1;
      driftHeld = 0;
      bus.emit('kart:driftStart', { kartId: 0, direction: k.driftDirection });
    }
    driftHeld += dt;
    const tiers = [0.55, 1.4, 2.5];
    const prev = k.driftStage;
    k.driftStage = driftHeld > tiers[2] ? DriftStage.Purple
      : driftHeld > tiers[1] ? DriftStage.Orange
        : driftHeld > tiers[0] ? DriftStage.Blue : DriftStage.Charging;
    k.driftCharge = clamp01(driftHeld / tiers[2]);
    if (k.driftStage > prev && k.driftStage >= DriftStage.Blue) {
      bus.emit('kart:driftTier', {
        kartId: 0, tier: k.driftStage, position: k.position.clone(),
      });
    }
  } else if (k.drifting) {
    const tier = k.driftStage;
    k.drifting = false;
    k.driftStage = DriftStage.None;
    k.driftCharge = 0;
    if (tier >= DriftStage.Blue) {
      const dur = tier === DriftStage.Purple ? 1.9 : tier === DriftStage.Orange ? 1.3 : 0.8;
      k.boostTime = dur;
      k.boostStrength = tier === DriftStage.Purple ? 1.6 : tier === DriftStage.Orange ? 1.3 : 1.0;
      bus.emit('kart:driftRelease', { kartId: 0, tier, boostTime: dur });
      bus.emit('kart:boost', { kartId: 0, duration: dur, source: 'drift' });
    }
    k.driftDirection = 0;
  }

  if (down.has('space') && !boostQueued) {
    boostQueued = true;
    k.boostTime = Math.max(k.boostTime, 1.6);
    k.boostStrength = 1.5;
    bus.emit('kart:boost', { kartId: 0, duration: 1.6, source: 'pad' });
  }
  if (!down.has('space')) boostQueued = false;
  if (k.boostTime > 0) k.boostTime = Math.max(0, k.boostTime - dt);

  k.starTime = starMode ? 5 : 0;
  k.antiGravity = agMode;

  // Yaw
  const grip = SURFACES[k.surface]?.grip ?? 1;
  const turn = (k.drifting ? 2.4 : 1.7) * grip * clamp01(Math.abs(k.speed) / 10);
  k.angularVelocity = steer * turn + (k.drifting ? k.driftDirection * 0.55 : 0);
  HALF.setFromAxisAngle(new THREE.Vector3(0, 1, 0), k.angularVelocity * dt);
  k.quaternion.multiply(HALF);
  k.groundQuaternion.copy(k.quaternion);
  k.steerAngle = steer * 0.5;

  // Integrate. Drifting slides the body sideways so slip-driven spray kicks in.
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(k.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(k.quaternion);
  k.velocity.copy(fwd).multiplyScalar(k.speed);
  if (k.drifting) k.velocity.addScaledVector(right, -k.driftDirection * Math.abs(k.speed) * 0.34);
  k.position.addScaledVector(k.velocity, dt);
  k.position.y = 0.42;
  // Keep it on the pad.
  k.position.x = clamp(k.position.x, -90, 90);
  k.position.z = clamp(k.position.z, -12.5, 90);

  for (let w = 0; w < 4; w++) {
    k.wheelSpin[w] += (k.speed / 0.32) * dt;
    k.suspension[w] = 0.5 + Math.sin(ctx.elapsed * 9 + w) * 0.04;
  }
  karts.syncTransform();
}

function updateCamera(dt: number): void {
  const k = karts.player;
  camTarget.copy(k.position).y += 0.9;
  if (camMode === 0) {
    const yaw = camYaw + Math.atan2(
      -(new THREE.Vector3(0, 0, -1).applyQuaternion(k.quaternion).x),
      -(new THREE.Vector3(0, 0, -1).applyQuaternion(k.quaternion).z),
    );
    camPos.set(Math.sin(yaw) * camDist, camDist * (0.28 + camPitch), Math.cos(yaw) * camDist).add(camTarget);
  } else if (camMode === 1) {
    camPos.set(Math.sin(camYaw) * camDist, 0.9, Math.cos(camYaw) * camDist).add(camTarget);
  } else {
    camPos.copy(camTarget).add(new THREE.Vector3(0, camDist * 1.4, 0.001));
  }
  camera.position.lerp(camPos, 1 - Math.pow(0.0001, dt));
  camera.lookAt(camTarget);
  // Shake published by the VFX layer, applied exactly as ChaseCamera does.
  camera.position.add(vfx.shakeOffset);
  camera.rotateX(vfx.shakeRotation.x);
  camera.rotateY(vfx.shakeRotation.y);
  camera.rotateZ(vfx.shakeRotation.z);
  camera.fov = 62 + vfx.desiredFovBoost;
  camera.updateProjectionMatrix();
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  vfx.resize(w, h);
}
window.addEventListener('resize', resize);

function stepOnce(dt: number): void {
  ctx.dt = dt;
  ctx.elapsed += dt;
  ctx.frame++;

  driveKart(dt);
  const t0 = performance.now();
  vfx.update(ctx as FrameContext);
  vfxMs = vfxMs * 0.9 + (performance.now() - t0) * 0.1;
  updateCamera(dt);

  renderer.info.reset();
  renderer.render(scene, camera);

  const s = vfx.getStats();
  const k = karts.player;
  hud.textContent = [
    `frame     ${frameMs.toFixed(2)} ms   (${(1000 / frameMs).toFixed(0)} fps)`,
    `vfx cpu   ${vfxMs.toFixed(3)} ms    smoothed ${s.cpuMs.toFixed(3)} ms`,
    `particles ${s.particles} / ${s.capacity}   gpu ${s.gpu}  cpu ${s.cpu}`,
    `throttle  ${s.throttle.toFixed(2)}   ribbons ${s.ribbons}   decals ${s.decals}`,
    `draws     ${renderer.info.render.calls}   tris ${renderer.info.render.triangles}`,
    `depth pre ${s.depthPrepass ? 'ON (half-res)' : 'off'}   time x${TIME_SCALES[timeIdx]}`,
    '',
    `speed     ${k.speed.toFixed(1)} m/s  ratio ${k.speedRatio.toFixed(2)}`,
    `drift     ${DriftStage[k.driftStage]}  dir ${k.driftDirection}  charge ${k.driftCharge.toFixed(2)}`,
    `boost     ${k.boostTime.toFixed(2)} s x${k.boostStrength.toFixed(1)}`,
    `surface   ${SurfaceType[k.surface]} → ${SURFACES[k.surface].particle}`,
    `fov boost ${vfx.desiredFovBoost.toFixed(2)}   shake ${vfx.shakeOffset.length().toFixed(3)}`,
  ].join('\n');
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frameMs = frameMs * 0.9 + rawDt * 1000 * 0.1;
  stepOnce(rawDt * TIME_SCALES[timeIdx]);
}

async function boot(): Promise<void> {
  await vfx.init();
  resize();
  note('VFX HARNESS — press 1 for an explosion');
  requestAnimationFrame(frame);
}

void boot();

/**
 * Scripted capture: reset the stage, fire one effect, advance a fixed number of
 * 1/120 s steps, then freeze. Lets a screenshot land on an exact moment of an
 * animation instead of whatever the wall clock happened to give us.
 */
interface ShotOpts {
  yaw?: number; pitch?: number; dist?: number; mode?: number;
  steps?: number; drive?: number;
  fire?: (h: unknown) => void;
}
function shot(opts: ShotOpts = {}): unknown {
  // Vite's HMR overlay is project-wide; other agents' broken modules would
  // otherwise cover the harness.
  document.querySelectorAll('vite-error-overlay').forEach((e) => e.remove());
  vfx.clear();
  timeIdx = 2;
  TIME_SCALES[2] = 0;
  karts.player.position.set(0, 0.42, 0);
  karts.player.quaternion.identity();
  karts.player.speed = 0;
  camYaw = opts.yaw ?? 0.85;
  camPitch = opts.pitch ?? 0.22;
  camDist = opts.dist ?? 13;
  camMode = opts.mode ?? 1;
  stepOnce(0);
  camera.position.copy(camPos);
  camera.lookAt(camTarget);
  opts.fire?.(exposed);
  TIME_SCALES[2] = 1 / 120;
  for (let i = 0; i < (opts.steps ?? 10); i++) stepOnce(1 / 120);
  TIME_SCALES[2] = 0;
  document.querySelectorAll('vite-error-overlay').forEach((e) => e.remove());
  return vfx.getStats();
}

// Expose for probing / scripted capture from the browser tool.
const exposed = {
  vfx, karts, scene, renderer, camera, ctx, shot, down,
  /** Hold/release virtual keys, so scripted capture drives the real input path. */
  hold: (...codes: string[]) => { for (const c of codes) down.add(c.toLowerCase()); },
  release: (...codes: string[]) => { for (const c of codes) down.delete(c.toLowerCase()); },
  setTime: (v: number) => { TIME_SCALES[timeIdx] = v; },
  freeze: () => { timeIdx = 2; TIME_SCALES[2] = 0; },
  setTimeIdx: (i: number) => { timeIdx = clamp(i | 0, 0, 2); },
  cam: (yaw: number, pitch: number, dist: number, mode: number) => {
    camYaw = yaw; camPitch = pitch; camDist = dist; camMode = mode;
  },
  step: (n = 1) => { for (let i = 0; i < n; i++) stepOnce(1 / 60); },
  note,
};
(window as unknown as Record<string, unknown>).__VFX__ = exposed;
