/**
 * How often does the planar reflection actually re-render?
 *
 * Measured in the browser with `EXT_disjoint_timer_query_webgl2`, driving frames
 * back-to-back on sunsetCoastline at ultra, the reflection was the single most
 * expensive item in the frame — 128.7 draw calls and 649 292 triangles, EVERY
 * frame, ahead of the main RenderPass. `Water.reflectInterval` now renders it
 * every Nth frame and keeps the target in between.
 *
 * This probe drives the real `Water` from a real `Environment` on the real
 * circuit and counts reflection passes by watching `setRenderTarget`. It does
 * not reimplement the cadence; it counts what the shipping code does.
 *
 * Three things have to hold, and each has a paired failure it must detect:
 *
 *   1. CADENCE   — at interval N, one render per N frames.
 *                  RED: force interval 1 and the count must double.
 *   2. PRIMED    — the very first frame must render, or the water samples an
 *                  empty target.
 *                  RED: a run whose first frame is skipped must be detected.
 *   3. CUT       — a camera jump must force a render out of turn, or a respawn
 *                  or results framing shows last place's mirror for a frame.
 *                  RED: a jump smaller than the threshold must NOT force one,
 *                  otherwise the check is just "always true".
 *
 * Note on the renderer: `fakeRenderer()` has no `getRenderTarget`, `xr`,
 * `clippingPlanes` or `shadowMap.autoUpdate`, and `renderReflection` reads all
 * four. Those are supplied here. That is the renderer surface, not the logic
 * under test — the cadence decision, the frustum test and the below-water test
 * are all the shipping ones.
 *
 * Run: node src/dev/node-run.mjs .probe-tmp/reflcadence.ts
 */
import * as THREE from 'three';
import { Environment } from '@/world/Environment';
import { fakeRenderer, loadTrack } from '@/dev/headless';
import { QUALITY_PRESETS } from '@/core/Config';
import type { FrameContext } from '@/core/Types';

interface Counter { renders: number }

function countingRenderer(): { renderer: THREE.WebGLRenderer; count: Counter } {
  const base = fakeRenderer() as unknown as Record<string, unknown>;
  const count: Counter = { renders: 0 };
  let target: unknown = null;
  base.getRenderTarget = (): unknown => target;
  base.setRenderTarget = (t: unknown): void => {
    target = t;
    // One non-null bind per reflection pass; the restore binds null.
    if (t) count.renders++;
  };
  base.clippingPlanes = [];
  base.xr = { enabled: false };
  (base.shadowMap as Record<string, unknown>).autoUpdate = true;
  return { renderer: base as unknown as THREE.WebGLRenderer, count };
}

let fail = 0;
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label.padEnd(44)} ${detail}`);
};

const ctx = { dt: 1 / 60, elapsed: 0, frame: 0, alpha: 0 } as unknown as FrameContext;

/**
 * Drive `frames` frames of the real `Water.update`, moving the camera by
 * `stepM` metres each frame. Returns how many reflection passes ran, and
 * whether the first frame was one of them.
 */
async function run(
  interval: number | null,
  frames: number,
  stepM: number,
): Promise<{ renders: number; firstFrame: boolean; wanted: boolean }> {
  const track = await loadTrack('sunsetCoastline');
  const scene = new THREE.Scene();
  const { renderer, count } = countingRenderer();
  const env = new Environment(scene, renderer, track, QUALITY_PRESETS.ultra);
  await env.init();
  const water = env.water;
  if (!water) throw new Error('no water on sunsetCoastline — probe is measuring nothing');

  // The game latches the camera from `onBeforeRender`, which needs a real draw.
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
  cam.position.set(0, water.level + 18, 0);
  cam.lookAt(0, water.level + 18, -100);
  cam.updateMatrixWorld(true);
  water.setCamera(cam);

  const priv = water as unknown as { reflectInterval: number; reflectionsOn: boolean };
  const wanted = priv.reflectionsOn;
  if (interval !== null) priv.reflectInterval = interval;

  let firstFrame = false;
  for (let i = 0; i < frames; i++) {
    const before = count.renders;
    cam.position.z -= stepM;
    cam.updateMatrixWorld(true);
    water.update(ctx);
    if (i === 0 && count.renders > before) firstFrame = true;
  }
  env.dispose();
  return { renders: count.renders, firstFrame, wanted };
}

console.log('sunsetCoastline, ultra, camera 18 m above the surface, 0.4 m/frame\n');

const FRAMES = 60;
const shipped = await run(null, FRAMES, 0.4);
check(shipped.wanted, 'reflections are on at ultra',
  shipped.wanted ? 'yes' : 'OFF — every number below is vacuous');

const every = await run(1, FRAMES, 0.4);
check(every.renders === FRAMES, 'interval 1 renders every frame',
  `${every.renders}/${FRAMES}`);

check(shipped.renders > 0 && shipped.renders < every.renders,
  'shipped interval renders fewer than every',
  `${shipped.renders} vs ${every.renders} over ${FRAMES} frames`);

const ratio = every.renders / Math.max(1, shipped.renders);
check(Math.abs(ratio - 2) < 0.12, 'shipped interval is 2 at ultra',
  `${shipped.renders}/${FRAMES} frames, ratio ${ratio.toFixed(2)}`);

check(shipped.firstFrame, 'first frame always renders (target primed)',
  shipped.firstFrame ? 'yes' : 'NO — frame 1 would sample an empty target');

// --- 3. camera cut --------------------------------------------------------
// Arrange the parity so the cadence would skip, then jump, and require a render.
{
  const track = await loadTrack('sunsetCoastline');
  const scene = new THREE.Scene();
  const { renderer, count } = countingRenderer();
  const env = new Environment(scene, renderer, track, QUALITY_PRESETS.ultra);
  await env.init();
  const water = env.water;
  if (!water) throw new Error('no water');
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
  cam.position.set(0, water.level + 18, 0);
  cam.lookAt(0, water.level + 18, -100);
  cam.updateMatrixWorld(true);
  water.setCamera(cam);

  // Settle onto a frame that renders, so the NEXT frame is a scheduled skip.
  let guard = 0;
  for (;;) {
    const before = count.renders;
    water.update(ctx);
    if (count.renders > before) break;
    if (++guard > 8) throw new Error('never rendered — cadence is stuck, probe is blind');
  }

  // (a) a small step must NOT force a render — otherwise the cut test is
  //     "always true" and proves nothing.
  const beforeSmall = count.renders;
  cam.position.z -= 0.4;
  cam.updateMatrixWorld(true);
  water.update(ctx);
  const smallForced = count.renders > beforeSmall;
  check(!smallForced, 'a 0.4 m step does NOT force a render',
    smallForced ? 'FORCED — the cut test cannot fail, so it proves nothing' : 'skipped, as scheduled');

  // (b) settle back onto a render, then jump 200 m and require one.
  guard = 0;
  for (;;) {
    const before = count.renders;
    water.update(ctx);
    if (count.renders > before) break;
    if (++guard > 8) throw new Error('cadence stuck');
  }
  const beforeCut = count.renders;
  cam.position.z -= 200;
  cam.updateMatrixWorld(true);
  water.update(ctx);
  check(count.renders > beforeCut, 'a 200 m camera cut forces a render',
    count.renders > beforeCut ? 'forced out of turn' : 'STALE — the mirror shows the old place');

  // (c) same for a rotation, independent of position.
  guard = 0;
  for (;;) {
    const before = count.renders;
    water.update(ctx);
    if (count.renders > before) break;
    if (++guard > 8) throw new Error('cadence stuck');
  }
  const beforeSpin = count.renders;
  cam.rotateY(Math.PI * 0.5);
  cam.updateMatrixWorld(true);
  water.update(ctx);
  check(count.renders > beforeSpin, 'a 90 deg camera cut forces a render',
    count.renders > beforeSpin ? 'forced out of turn' : 'STALE');

  env.dispose();
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
