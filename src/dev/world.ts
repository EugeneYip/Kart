/**
 * ============================================================================
 *  FOXY KART — WORLD LAB (dev harness)
 * ============================================================================
 *  Stands up Sky + Lighting + Environment with a stub track, so the whole world
 *  can be flown around, judged and screenshotted without waiting on Track,
 *  KartManager or RaceDirector.
 *
 *  The stub track deliberately implements the *real* contract
 *  (`getDecorationHints`, `sampleAt`, `project`) so this exercises the same code
 *  path the shipping game takes — not just Environment's fallback.
 *
 *  Delete once the game boots end to end.
 * ============================================================================
 */

import * as THREE from 'three';
import {
  BloomEffect, EffectComposer, EffectPass, RenderPass,
  SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode,
} from 'postprocessing';

import { QUALITY_PRESETS } from '@/core/Config';
import type { FrameContext, QualityTier, TrackSample } from '@/core/Types';
import { clamp, damp } from '@/core/MathUtils';

import { Sky, SKY_PRESETS, type SkyPresetName } from '@/world/Sky';
import { Lighting } from '@/world/Lighting';
import { Environment, demoCircuit } from '@/world/Environment';
import type { PathStation, WorldTheme } from '@/world/WorldTextures';

// ---------------------------------------------------------------------------
// Stub track
// ---------------------------------------------------------------------------

const THEMES: WorldTheme[] = ['coastal', 'city', 'volcano', 'meadow', 'desert', 'snow'];
const SKIES: SkyPresetName[] = ['day', 'sunset', 'night', 'storm', 'volcanic'];

const THEME_WATER: Record<WorldTheme, number> = {
  coastal: -3.5, city: -9, volcano: -14, meadow: -7, desert: -400, snow: -8,
};

/** Minimal stand-in for Track, driven by Environment's own demo circuit. */
class StubTrack {
  readonly stations: PathStation[];
  readonly lapLength: number;
  private theme: WorldTheme;
  private sky: SkyPresetName;
  private seed: number;
  private sample: TrackSample;

  constructor(theme: WorldTheme, sky: SkyPresetName, seed: number) {
    this.theme = theme;
    this.sky = sky;
    this.seed = seed;
    this.stations = demoCircuit(seed);
    const last = this.stations[this.stations.length - 1];
    this.lapLength = last.s + 7;
    this.sample = {
      position: new THREE.Vector3(),
      tangent: new THREE.Vector3(0, 0, -1),
      normal: new THREE.Vector3(0, 1, 0),
      binormal: new THREE.Vector3(1, 0, 0),
      halfWidth: 11,
      t: 0,
      distance: 0,
      curvature: 0,
      bank: 0,
    };
  }

  getDecorationHints() {
    return {
      theme: this.theme,
      skyPreset: this.sky,
      props: [],
      terrainSeed: this.seed,
      waterLevel: THEME_WATER[this.theme],
    };
  }

  sampleAt(t: number): TrackSample {
    const n = this.stations.length;
    const f = ((t % 1) + 1) % 1;
    const i = Math.min(n - 1, Math.floor(f * n));
    const st = this.stations[i];
    const s = this.sample;
    s.position.set(st.px, st.py, st.pz);
    s.tangent.set(st.tx, 0, st.tz).normalize();
    s.binormal.set(st.bx, 0, st.bz).normalize();
    s.normal.copy(s.binormal).cross(s.tangent).normalize();
    if (s.normal.y < 0) s.normal.negate();
    s.halfWidth = st.halfWidth;
    s.bank = Math.atan(st.tanBank);
    s.t = f;
    s.distance = st.s;
    return s;
  }

  sampleAtDistance(d: number): TrackSample {
    return this.sampleAt(d / this.lapLength);
  }

  project(p: THREE.Vector3): TrackSample {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.stations.length; i++) {
      const st = this.stations[i];
      const dx = st.px - p.x, dz = st.pz - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return this.sampleAt(best / this.stations.length);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const container = document.getElementById('app') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
const keysEl = document.getElementById('keys') as HTMLElement;
const bootEl = document.getElementById('boot') as HTMLElement;

const tier: QualityTier = (new URLSearchParams(location.search).get('tier') as QualityTier) || 'ultra';
const quality = { ...QUALITY_PRESETS[tier] };

const canvas = document.createElement('canvas');
canvas.tabIndex = 0;
container.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, alpha: false, stencil: false, depth: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;     // the composer does AgX
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, 1, 0.15, 4000);
camera.position.set(0, 26, 430);

let composer: EffectComposer | null = null;
let bloom: BloomEffect | null = null;

function buildComposer(): void {
  composer?.dispose();
  composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
  });
  composer.addPass(new RenderPass(scene, camera));
  bloom = new BloomEffect({
    intensity: 1.15,
    luminanceThreshold: 0.85,
    luminanceSmoothing: 0.28,
    mipmapBlur: true,
    radius: 0.72,
  });
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
  composer.addPass(new EffectPass(camera, bloom, tone, smaa));
  resize();
}

function resize(): void {
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  composer?.setSize(w, h);
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

let sky: Sky;
let lighting: Lighting;
let env: Environment | null = null;
let track: StubTrack;

let themeIndex = 0;
let skyIndex = 1;
let seed = 20260810;
let building = false;

const show = { terrain: true, water: true, foliage: true, props: true, crowd: true, weather: true };

async function buildWorld(): Promise<void> {
  building = true;
  bootEl.classList.remove('gone');
  bootEl.textContent = `BAKING ${THEMES[themeIndex].toUpperCase()}…`;
  await frame();

  env?.dispose();
  env = null;

  track = new StubTrack(THEMES[themeIndex], SKIES[skyIndex], seed);

  if (!sky) {
    sky = new Sky(scene, renderer);
    await sky.init();
    lighting = new Lighting(scene, renderer, camera, quality);
    await lighting.init();
    lighting.setSky(sky);
    buildComposer();
  }
  sky.currentCamera = camera;

  env = new Environment(scene, renderer, track, quality);
  await env.init();
  env.setCamera(camera);
  env.setSky(sky);
  env.setLighting(lighting);

  applyVisibility();
  bootEl.classList.add('gone');
  building = false;
}

function applyVisibility(): void {
  if (!env) return;
  if (env.terrain) env.terrain.group.visible = show.terrain;
  if (env.water) env.water.group.visible = show.water;
  if (env.foliage) env.foliage.group.visible = show.foliage;
  if (env.props) env.props.group.visible = show.props;
  if (env.crowd) env.crowd.group.visible = show.crowd;
  if (env.weather) env.weather.group.visible = show.weather;
}

/** rAF, but never stalls in a background tab. */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 24);
  });
}

// ---------------------------------------------------------------------------
// Free-fly camera
// ---------------------------------------------------------------------------

const keys = new Set<string>();
let yaw = Math.PI;
let pitch = -0.14;
let dragging = false;
const velocity = new THREE.Vector3();
const wish = new THREE.Vector3();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
  canvas.focus();
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= e.movementX * 0.0026;
  pitch = clamp(pitch - e.movementY * 0.0024, -1.45, 1.45);
});

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5));
    if (n >= 1 && n <= SKIES.length) {
      skyIndex = n - 1;
      lighting.setPreset(SKIES[skyIndex]);
    }
  }
  switch (e.code) {
    case 'KeyT': show.terrain = !show.terrain; applyVisibility(); break;
    case 'KeyF': show.foliage = !show.foliage; applyVisibility(); break;
    case 'KeyG': show.water = !show.water; applyVisibility(); break;
    case 'KeyP': show.props = !show.props; applyVisibility(); break;
    case 'KeyC': show.crowd = !show.crowd; applyVisibility(); break;
    case 'KeyR': show.weather = !show.weather; applyVisibility(); break;
    case 'KeyJ': env?.celebrate(); break;
    case 'KeyB': if (bloom) bloom.intensity = bloom.intensity > 0.01 ? 0 : 1.15; break;
    case 'BracketRight':
      if (!building) { themeIndex = (themeIndex + 1) % THEMES.length; void buildWorld(); }
      break;
    case 'BracketLeft':
      if (!building) { themeIndex = (themeIndex + THEMES.length - 1) % THEMES.length; void buildWorld(); }
      break;
    case 'KeyM': shot('eye'); break;
    case 'KeyN': shot('wide'); break;
    default: break;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

/** Snap the camera to a repeatable review pose. */
function shot(kind: 'eye' | 'wide' | 'shore' | 'stand', t = 0.02): void {
  if (!track) return;
  const s = track.sampleAt(t);
  const ahead = track.sampleAt(t + 0.03);
  switch (kind) {
    case 'eye': {
      // Driver eye height, on the racing line, looking down the road.
      camera.position.set(s.position.x, s.position.y + 1.2, s.position.z);
      yaw = Math.atan2(ahead.position.x - s.position.x, ahead.position.z - s.position.z) + Math.PI;
      pitch = -0.02;
      break;
    }
    case 'wide': {
      camera.position.set(s.position.x + 120, s.position.y + 74, s.position.z + 150);
      const dx = s.position.x - camera.position.x;
      const dz = s.position.z - camera.position.z;
      yaw = Math.atan2(dx, dz) + Math.PI;
      pitch = -0.30;
      break;
    }
    case 'shore': {
      const wl = env?.ctx?.waterLevel ?? -4;
      camera.position.set(s.position.x, wl + 5.5, s.position.z);
      yaw = Math.atan2(-s.binormal.x, -s.binormal.z) + Math.PI;
      pitch = -0.10;
      break;
    }
    case 'stand': {
      camera.position.set(s.position.x - 34, s.position.y + 9, s.position.z + 12);
      yaw = Math.atan2(34, -12) + Math.PI;
      pitch = -0.12;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

const ctx: FrameContext & { dt: number; elapsed: number; frame: number } = {
  dt: 0, fixedDt: 1 / 120, elapsed: 0, frame: 0, alpha: 0,
};

let last = performance.now();
let frameMs = 16;
let gpuCalls = 0;
let tris = 0;
let hudTimer = 0;

function tick(now: number): void {
  requestAnimationFrame(tick);
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(raw, 0.1);
  (ctx as { dt: number }).dt = dt;
  (ctx as { elapsed: number }).elapsed += dt;
  (ctx as { frame: number }).frame++;

  // --- camera ---
  const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5.5 : 1;
  const slow = keys.has('AltLeft') ? 0.16 : 1;
  const speed = 34 * boost * slow;
  fwd.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).normalize();
  right.set(fwd.z, 0, -fwd.x).normalize();
  wish.set(0, 0, 0);
  if (keys.has('KeyW')) wish.sub(fwd);
  if (keys.has('KeyS')) wish.add(fwd);
  if (keys.has('KeyA')) wish.sub(right);
  if (keys.has('KeyD')) wish.add(right);
  if (keys.has('KeyQ')) wish.y -= 1;
  if (keys.has('KeyE')) wish.y += 1;
  if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
  velocity.x = damp(velocity.x, wish.x, 0.09, dt);
  velocity.y = damp(velocity.y, wish.y, 0.09, dt);
  velocity.z = damp(velocity.z, wish.z, 0.09, dt);
  camera.position.addScaledVector(velocity, dt);

  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw + Math.PI, 0, 'YXZ'));
  camera.updateMatrixWorld();

  // The player-proximity effects (grass bend, crowd focus) follow the camera.
  env?.setPlayerPosition(camera.position);

  // --- world ---
  if (!building) {
    sky?.update(ctx);
    lighting?.update(ctx);
    env?.update(ctx);
  }

  renderer.info.reset();
  composer?.render(dt);
  gpuCalls = renderer.info.render.calls;
  tris = renderer.info.render.triangles;

  frameMs = damp(frameMs, raw * 1000, 0.25, dt);
  hudTimer += dt;
  if (hudTimer > 0.12) {
    hudTimer = 0;
    updateHud();
  }
}

function updateHud(): void {
  const e = env;
  const p = SKY_PRESETS[SKIES[skyIndex]];
  hud.innerHTML =
    `<b>FOXY KART · WORLD LAB</b>\n` +
    `theme    <span class="k">${THEMES[themeIndex]}</span>   sky <span class="k">${SKIES[skyIndex]}</span>\n` +
    `tier     <span class="k">${tier}</span>   sun ${p.sunElevation.toFixed(0)}°\n` +
    `<hr>` +
    `frame    <span class="k">${frameMs.toFixed(2)} ms</span>  (${(1000 / Math.max(frameMs, 0.01)).toFixed(0)} fps)\n` +
    `draws    <span class="k">${gpuCalls}</span>   tris <span class="k">${(tris / 1000).toFixed(0)}k</span>\n` +
    `env draws<span class="k"> ${e ? e.drawCalls : 0}</span>\n` +
    `<hr>` +
    `terrain  ${flag(show.terrain)}   water   ${flag(show.water)}\n` +
    `foliage  ${flag(show.foliage)} <span class="d">${e?.foliage ? e.foliage.drawCalls : 0}</span>` +
    `   props ${flag(show.props)} <span class="d">${e?.props ? e.props.drawCalls : 0}</span>\n` +
    `crowd    ${flag(show.crowd)} <span class="d">${e?.crowd ? e.crowd.count : 0}</span>` +
    `   wx    ${flag(show.weather)} <span class="d">${e?.weather ? e.weather.preset : '-'}</span>\n` +
    `props    <span class="d">${e?.props ? e.props.instanceCount + ' inst / ' + (e.props.triangles / 1000).toFixed(0) + 'k tri' : '-'}</span>\n` +
    `water    <span class="d">${e?.water ? e.water.preset : '-'}</span>   wet <span class="d">${(e?.weather?.wetness ?? 0).toFixed(2)}</span>\n` +
    `cam      <span class="d">${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(0)}</span>`;

  keysEl.innerHTML =
    `<span>WASD/QE</span> fly   <span>shift</span> fast  <span>alt</span> slow\n` +
    `<span>drag</span> look\n` +
    `<span>1-5</span> sky: day sunset night storm volcanic\n` +
    `<span>[ ]</span> cycle theme\n` +
    `<span>T</span> terrain <span>G</span> water <span>F</span> foliage\n` +
    `<span>P</span> props <span>C</span> crowd <span>R</span> weather\n` +
    `<span>B</span> bloom <span>J</span> crowd wave\n` +
    `<span>M</span> driver-eye shot <span>N</span> wide shot`;
}

function flag(v: boolean): string {
  return v ? '<span class="k">on </span>' : '<span class="d">off</span>';
}

// ---------------------------------------------------------------------------
// Probe surface for automated review
// ---------------------------------------------------------------------------

interface WorldLab {
  env: () => Environment | null;
  sky: () => Sky;
  camera: THREE.PerspectiveCamera;
  themes: WorldTheme[];
  skies: SkyPresetName[];
  setSky: (name: SkyPresetName) => void;
  setTheme: (name: WorldTheme) => Promise<void>;
  shot: (kind: 'eye' | 'wide' | 'shore' | 'stand', t?: number) => void;
  layers: typeof show;
  applyVisibility: () => void;
  stats: () => { frameMs: number; draws: number; tris: number; envDraws: number };
  settle: (frames?: number) => Promise<void>;
  building: () => boolean;
}

const lab: WorldLab = {
  env: () => env,
  sky: () => sky,
  camera,
  themes: THEMES,
  skies: SKIES,
  setSky: (name) => {
    skyIndex = Math.max(0, SKIES.indexOf(name));
    lighting.setPreset(name);
  },
  setTheme: async (name) => {
    const i = THEMES.indexOf(name);
    if (i < 0) return;
    themeIndex = i;
    await buildWorld();
  },
  shot,
  layers: show,
  applyVisibility,
  stats: () => ({ frameMs, draws: gpuCalls, tris, envDraws: env ? env.drawCalls : 0 }),
  settle: async (frames = 12) => { for (let i = 0; i < frames; i++) await frame(); },
  building: () => building,
};
(window as unknown as { __WORLD__: WorldLab }).__WORLD__ = lab;

void (async () => {
  await buildWorld();
  shot('wide');
  requestAnimationFrame(tick);
})();
