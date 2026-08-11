/**
 * ============================================================================
 *  APEX KART — HEADLESS TYPESCRIPT RUNNER
 * ============================================================================
 *  Runs any `src/**` TypeScript module under plain Node — no browser, no
 *  bundler, no dev server — so gameplay logic can be measured numerically from
 *  a terminal or in CI:
 *
 *      node src/dev/node-run.mjs src/dev/mechanics-probe.ts [args…]
 *
 *  Why this exists: three shipped mechanics (gliders, anti-gravity, ramp
 *  tricks) were authored, wired, and had *never once run*. None of them was
 *  visible in a screenshot, because a mechanic that never fires renders
 *  identically to one that does not exist. The only way to catch that class of
 *  bug is to simulate laps and count. This runner is what makes that cheap.
 *
 *  Three pieces make it work:
 *
 *   1. `module.registerHooks` resolves the project's `@/…` alias (and
 *      extensionless relative imports). Node's own
 *      `--experimental-transform-types` does the TypeScript, which matters:
 *      `SurfaceType` / `DriftStage` / `ItemType` are real `enum`s, so plain
 *      type *stripping* would delete them at runtime. The flag is added
 *      automatically by re-exec if you forget it.
 *
 *   2. A minimal 2D-canvas shim. `src/render/TextureFactory.ts` — and through
 *      it RoadMaterial and Decals — rasterises procedural textures via
 *      `document.createElement('canvas')`. None of that touches a physics
 *      number, so every draw call is a no-op and `getImageData` returns a
 *      zeroed buffer of the right size. Textures come out blank; the spline,
 *      the geometry and every `ITrackService` query are the real thing.
 *
 *   3. `src/dev/headless.ts` (a separate module — see the warning below) hands
 *      out a fake `WebGLRenderer` and loads a real `Track`.
 *
 *  ⚠️ DO NOT import anything from THIS file in a probe. This module holds a
 *  pending top-level `await import(entry)` for the whole life of the run, so a
 *  probe that imports it deadlocks the module graph — Node reports
 *  `ERR_UNSETTLED_TOP_LEVEL_AWAIT` (exit 13) with no output at all, which is a
 *  memorable half-hour. Helpers live in `src/dev/headless.ts` for exactly this
 *  reason.
 *
 *  NEVER import this from the shipped bundle. And if a module you are probing
 *  starts needing real pixels, shim it explicitly — do not trust a no-op.
 * ============================================================================
 */

import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
//  0. Re-exec with the flags we need, so the command line stays short
// ---------------------------------------------------------------------------

const NEEDED = ['--experimental-transform-types', '--no-warnings=ExperimentalWarning'];
if (!process.execArgv.includes(NEEDED[0])) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(
    process.execPath,
    [...NEEDED, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(r.status ?? 1);
}

const SRC = fileURLToPath(new URL('..', import.meta.url)); // <repo>/src/

// ---------------------------------------------------------------------------
//  1. Module resolution — '@/x' alias + extensionless relative imports
// ---------------------------------------------------------------------------

function resolveLocal(spec, parentURL) {
  let base;
  if (spec.startsWith('@/')) {
    base = path.join(SRC, spec.slice(2));
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    if (!parentURL || !parentURL.startsWith('file:')) return null;
    base = path.resolve(path.dirname(fileURLToPath(parentURL)), spec);
  } else {
    return null; // bare specifier — Node handles it (three, three-mesh-bvh, …)
  }
  const cands = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
  // '.js' written in source but '.ts' on disk (NodeNext-style imports)
  if (base.endsWith('.js')) cands.push(`${base.slice(0, -3)}.ts`);
  for (const c of cands) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

registerHooks({
  resolve(spec, ctx, next) {
    const hit = resolveLocal(spec, ctx.parentURL);
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    // GLSL imported by the render layer: hand the text back as a default export.
    if (url.startsWith('file:') && /\.(glsl|vert|frag)$/.test(url)) {
      const src = readFileSync(fileURLToPath(url), 'utf8');
      return {
        format: 'module',
        source: `export default ${JSON.stringify(src)};`,
        shortCircuit: true,
      };
    }
    return next(url, ctx);
  },
});

// ---------------------------------------------------------------------------
//  2. Canvas / DOM shim — enough for procedural texture generation to run
// ---------------------------------------------------------------------------

class FakeImageData {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
}

const GRADIENT = { addColorStop() {} };

function fakeCtx(canvas) {
  const target = {
    canvas,
    // Mutable state callers assign to, so property writes never throw.
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt',
    lineJoin: 'miter', miterLimit: 10, globalAlpha: 1,
    globalCompositeOperation: 'source-over', font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', shadowBlur: 0,
    shadowColor: 'transparent', shadowOffsetX: 0, shadowOffsetY: 0,
    filter: 'none', imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low', lineDashOffset: 0, direction: 'ltr',
    getImageData: (_x, _y, w, h) => new FakeImageData(Math.max(1, w | 0), Math.max(1, h | 0)),
    createImageData: (w, h) => new FakeImageData(Math.max(1, w | 0), Math.max(1, h | 0)),
    putImageData() {},
    measureText: (t) => {
      const w = String(t).length * 6;
      return {
        width: w,
        actualBoundingBoxLeft: 0, actualBoundingBoxRight: w,
        actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2,
      };
    },
    createLinearGradient: () => GRADIENT,
    createRadialGradient: () => GRADIENT,
    createConicGradient: () => GRADIENT,
    createPattern: () => null,
    getLineDash: () => [],
    isPointInPath: () => false,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  // Any other 2D-context method is a no-op.
  return new Proxy(target, {
    get: (o, k) => (k in o ? o[k] : () => undefined),
    set: (o, k, v) => ((o[k] = v), true),
    has: () => true,
  });
}

function makeCanvas(w = 300, h = 150) {
  const c = {
    width: w,
    height: h,
    style: {},
    _ctx: null,
    getContext(kind) {
      if (kind !== '2d') return null;
      if (!c._ctx) c._ctx = fakeCtx(c);
      return c._ctx;
    },
    toDataURL: () => 'data:,',
    addEventListener() {},
    removeEventListener() {},
  };
  return c;
}

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return makeCanvas();
      return { style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} };
    },
    createElementNS(_ns, tag) {
      return this.createElement(tag);
    },
    body: { appendChild() {}, style: {} },
    documentElement: { style: {} },
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    fonts: { add() {}, load: () => Promise.resolve(), ready: Promise.resolve() },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
  globalThis.devicePixelRatio = 1;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = FakeImageData;
if (typeof globalThis.HTMLCanvasElement === 'undefined') {
  globalThis.HTMLCanvasElement = class HTMLCanvasElement {};
}

// A canvas factory the helpers in `headless.ts` can reach without importing
// this module (see the deadlock warning at the top of the file).
globalThis.__AK_MAKE_CANVAS__ = makeCanvas;

// ---------------------------------------------------------------------------
//  Entry point
// ---------------------------------------------------------------------------

const entry = process.argv[2];
if (entry) {
  const abs = path.isAbsolute(entry) ? entry : path.resolve(process.cwd(), entry);
  await import(pathToFileURL(abs).href);
} else {
  console.error('usage: node src/dev/node-run.mjs <entry.ts> [args…]');
  process.exit(2);
}
