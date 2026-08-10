/**
 * ============================================================================
 *  APEX KART — MATERIAL LAB (dev harness)
 * ============================================================================
 *  Standalone page that shows every PbrSet in the library under three-point
 *  lighting plus a generated environment probe, and a 260 m asphalt plane
 *  viewed at a grazing angle so tiling and anisotropic filtering can be judged.
 *
 *  Runs the real RenderPipeline, so it also validates the post chain.
 *
 *    drag        orbit
 *    wheel       zoom
 *    1 2 3 4     grade preset: day / sunset / night / storm
 *    G           toggle grazing-angle road view
 *    F           flash        S  shake        B  speed intensity sweep
 *    P           cycle post passes off/on
 * ============================================================================
 */

import * as THREE from 'three';
import { Engine } from '@/core/Engine';
import type { FrameContext } from '@/core/Types';
import { RenderPipeline } from '@/render/RenderPipeline';
import type { GradePresetName } from '@/render/effects/GradeEffect';
import { standardFromPbr, triplanarMaterial, emissiveGlow } from '@/render/MaterialFactory';
import * as TF from '@/render/TextureFactory';

// ---------------------------------------------------------------------------
// Scene furniture
// ---------------------------------------------------------------------------

const hud = document.getElementById('hud') as HTMLDivElement;
const container = document.getElementById('app') as HTMLDivElement;

const engine = new Engine(container, 'ultra');
engine.adaptiveResolution = false;
const scene = engine.scene;
const camera = engine.camera;

scene.background = new THREE.Color(0x0a0f1a);
scene.fog = new THREE.Fog(0x0a0f1a, 90, 420);

/** Procedural equirect sky → PMREM probe. No network, no HDRI file. */
function buildEnvironment(): THREE.Texture {
  const w = 256;
  const h = 128;
  const data = new Uint8Array(w * h * 4);
  const top = new THREE.Color(0x4a7fd0);
  const horizon = new THREE.Color(0xd8e4f2);
  const ground = new THREE.Color(0x2a2620);
  const sun = new THREE.Color(0xfff3d8);
  const c = new THREE.Color();
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    // v = 0 is the top of an equirect map.
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      if (v < 0.5) {
        const t = Math.pow(1 - v * 2, 0.75);
        c.copy(horizon).lerp(top, t);
        // Soft sun disc + halo, up and to the left.
        const du = Math.min(Math.abs(u - 0.28), 1 - Math.abs(u - 0.28));
        const dv = v - 0.2;
        const d = Math.sqrt(du * du * 4 + dv * dv * 4);
        const halo = Math.exp(-d * 6) * 0.9 + Math.exp(-d * 26) * 2.4;
        c.lerp(sun, Math.min(1, halo));
      } else {
        const t = Math.pow((v - 0.5) * 2, 0.6);
        c.copy(horizon).lerp(ground, t);
      }
      const p = (y * w + x) * 4;
      data[p] = c.r * 255;
      data[p + 1] = c.g * 255;
      data[p + 2] = c.b * 255;
      data[p + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(engine.renderer);
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return rt.texture;
}

const envMap = buildEnvironment();
scene.environment = envMap;
scene.environmentIntensity = 0.85;

// --- three-point lighting -------------------------------------------------
const key = new THREE.DirectionalLight(0xfff0d6, 3.1);
key.position.set(-26, 34, 20);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 140;
key.shadow.camera.left = -34;
key.shadow.camera.right = 34;
key.shadow.camera.top = 26;
key.shadow.camera.bottom = -26;
key.shadow.bias = -0.0006;
key.shadow.radius = 3;
scene.add(key);

const fill = new THREE.DirectionalLight(0x9dc2ff, 0.85);
fill.position.set(24, 12, 26);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffd0a8, 1.5);
rim.position.set(6, 9, -34);
scene.add(rim);

scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x2b2620, 0.35));

// ---------------------------------------------------------------------------
// Material grid
// ---------------------------------------------------------------------------

interface Entry {
  label: string;
  set?: TF.PbrSet;
  material?: THREE.Material;
  /** Tiling on the sphere / plate. */
  repeat?: number;
  triplanar?: boolean;
}

const t0 = performance.now();

const entries: Entry[] = [
  { label: 'asphalt clean', set: TF.makeAsphalt(2048, 'clean'), repeat: 1 },
  { label: 'asphalt worn', set: TF.makeAsphalt(2048, 'worn'), repeat: 1 },
  { label: 'asphalt wet', set: TF.makeAsphalt(2048, 'wet'), repeat: 1 },
  { label: 'concrete', set: TF.makeConcrete(1024), repeat: 1 },
  { label: 'grass', set: TF.makeGrass(1024), repeat: 2 },
  { label: 'sand', set: TF.makeSand(1024), repeat: 1 },
  { label: 'dirt', set: TF.makeDirt(1024), repeat: 1 },
  { label: 'rock (triplanar)', set: TF.makeRock(1024), triplanar: true },
  { label: 'wood plank', set: TF.makeWoodPlank(1024), repeat: 1 },
  { label: 'metal bare', set: TF.makeMetalPanel(1024), repeat: 1 },
  { label: 'metal painted', set: TF.makeMetalPanel(1024, { painted: true, color: 0xd8322c }), repeat: 1 },
  { label: 'brick', set: TF.makeBrick(1024), repeat: 1 },
  { label: 'cobblestone', set: TF.makeCobblestone(1024), repeat: 1 },
  { label: 'tile floor', set: TF.makeTileFloor(1024), repeat: 1 },
  { label: 'snow', set: TF.makeSnow(1024), repeat: 1 },
  { label: 'rubber tread', set: TF.makeRubber(1024), repeat: 1 },
  { label: 'tyre sidewall', set: TF.makeTyreSidewall(512), repeat: 1 },
  { label: 'car paint red', material: TF.makeCarPaint(0xd21f2b) },
  { label: 'car paint blue', material: TF.makeCarPaint(0x1f5ed2) },
  { label: 'car paint lime', material: TF.makeCarPaint(0x9ad41f) },
  { label: 'emissive glow', material: emissiveGlow(0x39e0ff, 3.4) },
];

const genMs = performance.now() - t0;

// --- label sprites (dev-only, drawn straight to a canvas) ------------------
function labelTexture(text: string): THREE.CanvasTexture {
  const w = 512;
  const h = 96;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.font = 'bold 46px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(text, w / 2 + 2, h / 2 + 3);
  ctx.fillStyle = '#e9f2ff';
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const sphereGeo = new THREE.SphereGeometry(1.05, 96, 64);
const plateGeo = new THREE.BoxGeometry(2.1, 0.18, 2.1, 1, 1, 1);
const labelGeo = new THREE.PlaneGeometry(2.4, 0.45);

const grid = new THREE.Group();
scene.add(grid);

const COLS = 7;
const SPACING_X = 3.4;
const SPACING_Z = 4.4;

const disposables: Array<{ dispose(): void }> = [sphereGeo, plateGeo, labelGeo];

entries.forEach((entry, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = (col - (COLS - 1) / 2) * SPACING_X;
  const z = row * SPACING_Z - 4;

  let mat: THREE.Material;
  if (entry.material) {
    mat = entry.material;
  } else if (entry.set && entry.triplanar) {
    mat = triplanarMaterial(entry.set, 1.6, { sharpness: 5 });
  } else if (entry.set) {
    mat = standardFromPbr(entry.set, { repeat: entry.repeat ?? 1, anisotropy: 16 });
  } else {
    mat = new THREE.MeshStandardMaterial();
  }

  const sphere = new THREE.Mesh(sphereGeo, mat);
  sphere.position.set(x, 1.35, z);
  sphere.castShadow = true;
  sphere.receiveShadow = true;
  grid.add(sphere);

  // A flat plate next to each sphere: flat surfaces expose tiling seams that a
  // sphere hides, and show the grazing-angle behaviour of the normal map.
  const plateMat = entry.set
    ? (entry.triplanar
      ? triplanarMaterial(entry.set, 1.6, { sharpness: 5 })
      : standardFromPbr(entry.set, { repeat: (entry.repeat ?? 1) * 2, anisotropy: 16 }))
    : mat;
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.set(x, 0.09, z + 1.75);
  plate.rotation.x = -0.42;
  plate.castShadow = true;
  plate.receiveShadow = true;
  grid.add(plate);

  const labelTex = labelTexture(entry.label);
  disposables.push(labelTex);
  const label = new THREE.Mesh(
    labelGeo,
    new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  label.position.set(x, 0.02, z + 2.75);
  label.rotation.x = -Math.PI / 2;
  grid.add(label);
});

// --- ground: the big asphalt plane ----------------------------------------
const roadSet = TF.makeAsphalt(2048, 'clean');
const roadMat = standardFromPbr(roadSet, { repeat: 44, anisotropy: 16, name: 'lab-road' });
const road = new THREE.Mesh(new THREE.PlaneGeometry(260, 260, 1, 1), roadMat);
road.rotation.x = -Math.PI / 2;
road.position.y = -0.02;
road.receiveShadow = true;
scene.add(road);
disposables.push(road.geometry);

// Painted lane lines, so the grazing-angle view has a reference for aliasing.
const lineTex = TF.canvasTexture(512, 512, (ctx, w, h) => {
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f2f4f0';
  for (let i = 0; i < 4; i++) ctx.fillRect(w * 0.47, h * (i / 4) + h * 0.03, w * 0.06, h * 0.14);
});
lineTex.repeat.set(1, 60);
const lineMat = new THREE.MeshStandardMaterial({
  map: lineTex, transparent: true, roughness: 0.7, metalness: 0,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const lines = new THREE.Mesh(new THREE.PlaneGeometry(6, 240), lineMat);
lines.rotation.x = -Math.PI / 2;
lines.position.set(0, 0.001, -60);
scene.add(lines);
disposables.push(lines.geometry, lineMat, lineTex);

// ---------------------------------------------------------------------------
// Camera rig
// ---------------------------------------------------------------------------

const orbit = { yaw: 0.35, pitch: 0.42, dist: 20, target: new THREE.Vector3(0, 1.2, 2) };
let grazing = false;
let dragging = false;
let lastX = 0;
let lastY = 0;

container.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
});
container.addEventListener('pointerup', () => { dragging = false; });
container.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbit.yaw -= (e.clientX - lastX) * 0.005;
  orbit.pitch = Math.max(-0.02, Math.min(1.35, orbit.pitch - (e.clientY - lastY) * 0.004));
  lastX = e.clientX;
  lastY = e.clientY;
});
container.addEventListener('wheel', (e) => {
  orbit.dist = Math.max(3.5, Math.min(90, orbit.dist * (1 + Math.sign(e.deltaY) * 0.08)));
  e.preventDefault();
}, { passive: false });

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const pipeline = new RenderPipeline(engine, null, null);

let speedSweep = false;
let speed = 0;
let presetName: GradePresetName = 'day';
let postMode = 0; // 0 = full chain, 1 = no grade tweaks, 2 = raw

const PRESETS: GradePresetName[] = ['day', 'sunset', 'night', 'storm'];

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k >= '1' && k <= '4') {
    presetName = PRESETS[Number(k) - 1];
    pipeline.setGradePreset(presetName);
  } else if (k === 'g') {
    grazing = !grazing;
    if (grazing) {
      orbit.pitch = 0.035;
      orbit.dist = 26;
      orbit.target.set(0, 0.55, -30);
      orbit.yaw = 0;
    } else {
      orbit.pitch = 0.42;
      orbit.dist = 20;
      orbit.target.set(0, 1.2, 2);
    }
  } else if (k === 'f') {
    pipeline.flash(0xfff2c0, 0.85, 0.5);
  } else if (k === 's') {
    pipeline.addShake(0.7, 0.55);
  } else if (k === 'b') {
    speedSweep = !speedSweep;
    if (!speedSweep) { speed = 0; pipeline.setSpeedIntensity(0); }
  } else if (k === 'p') {
    postMode = (postMode + 1) % 3;
    const passes = pipeline.composer.passes;
    // Never disable the terminal pass — postprocessing only marks the last
    // pass as renderToScreen.
    for (let i = 1; i < passes.length - 1; i++) {
      passes[i].enabled = postMode === 0 ? true : postMode === 1 ? i >= passes.length - 3 : false;
    }
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let frames = 0;
let hudTimer = 0;
let gpuAcc = 0;

const rig = {
  update(ctx: FrameContext): void {
    if (speedSweep) {
      speed = (Math.sin(ctx.elapsed * 0.6) * 0.5 + 0.5);
      pipeline.setSpeedIntensity(speed);
    }
    const cp = Math.cos(orbit.pitch);
    camera.position.set(
      orbit.target.x + Math.sin(orbit.yaw) * cp * orbit.dist,
      orbit.target.y + Math.sin(orbit.pitch) * orbit.dist,
      orbit.target.z + Math.cos(orbit.yaw) * cp * orbit.dist,
    );
    camera.lookAt(orbit.target);

    frames++;
    hudTimer += ctx.dt;
    gpuAcc += ctx.dt;
    if (hudTimer > 0.33) {
      const st = pipeline.getStats();
      const info = engine.renderer.info;
      hud.innerHTML = [
        '<b>APEX KART — MATERIAL LAB</b>',
        '<hr>',
        `fps <span class="k">${(frames / gpuAcc).toFixed(0)}</span>` +
          `  frame <span class="k">${(1000 * gpuAcc / frames).toFixed(2)} ms</span>`,
        `post cpu <span class="k">${st.cpuMs.toFixed(2)} ms</span>  passes <span class="k">${st.passes}</span>`,
        `draws <span class="k">${info.render.calls}</span>  tris <span class="k">${(info.render.triangles / 1000).toFixed(0)}k</span>`,
        '<hr>',
        `textures <span class="k">${st.textures}</span> in <span class="k">${st.textureMs.toFixed(0)} ms</span>` +
          `  <span class="d">(wall ${genMs.toFixed(0)} ms)</span>`,
        `grade <span class="k">${presetName}</span>  speed <span class="k">${speed.toFixed(2)}</span>` +
          `  post <span class="k">${['full', 'look only', 'off'][postMode]}</span>`,
        '<hr>',
        '<span class="d">drag orbit · wheel zoom · 1-4 grade</span>',
        '<span class="d">G grazing road · F flash · S shake · B speed · P post</span>',
      ].join('<br>');
      frames = 0;
      gpuAcc = 0;
      hudTimer = 0;
    }
  },
};

async function boot(): Promise<void> {
  await pipeline.init();
  engine.setRenderCallback((dt) => pipeline.render(dt));
  engine.add(rig);
  engine.add(pipeline);
  engine.start();

  const w = globalThis as Record<string, unknown>;
  w.__LAB__ = { engine, pipeline, scene, camera, TF, entries, genMs, disposables };
  console.info(`[Material Lab] ${entries.length} materials generated in ${genMs.toFixed(0)} ms`);
}

void boot();
