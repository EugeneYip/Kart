/**
 * ============================================================================
 *  FOXY KART — POST-CHAIN QA PROBE  (development only)
 * ============================================================================
 *  Installs `window.__POST__`, a set of measurement tools for the render
 *  pipeline. This exists because "the image looks washed out" is not something
 *  you can tune by eye through a screenshot pipeline — you need numbers.
 *
 *  The important one is `probe()`: it reads the finished frame back off the
 *  default framebuffer and reports a histogram summary. Those numbers are what
 *  proved the original chain shipped a frame whose darkest 1 % of pixels sat at
 *  0.41 luma (i.e. no shadows at all) with a mean saturation of 0.13 (i.e. very
 *  nearly greyscale), and they are what the current grade was tuned against.
 *
 *    __POST__.probe()             -> histogram summary of the current frame
 *    __POST__.passCost(name?)     -> ms/frame attributable to each post pass
 *    __POST__.toneMap(name)       -> A/B a tone-mapping operator live
 *    __POST__.exposure(v)         -> exposure trim
 *
 *  Tree-shaken out of production builds — the only import site is guarded by
 *  `import.meta.env.DEV`.
 * ============================================================================
 */

import type { RenderPipeline } from './RenderPipeline';
import type { GradePresetName, ToneMapName } from './effects/GradeEffect';

interface ProbeResult {
  meanLuma: number;
  stdLuma: number;
  meanSat: number;
  p1: number;
  p5: number;
  p50: number;
  p95: number;
  p99: number;
  blown: number;
  crushed: number;
}

interface EngineLike {
  renderer: {
    getContext(): WebGL2RenderingContext;
    setRenderTarget(t: null): void;
    info: { programs?: Array<{ name?: string; program?: WebGLProgram | null }> | null };
  };
}

// ---------------------------------------------------------------------------
//  GL validation probe
// ---------------------------------------------------------------------------

/**
 * Attribute every GL error to the draw call and shader program that caused it.
 *
 * This exists because of a reported flood of
 *
 *   GL_INVALID_OPERATION: Mismatch between texture format and sampler type
 *
 * that Chrome eventually silences, and which — being emitted by the browser's
 * command decoder rather than by JavaScript — does not appear in any console
 * reader an automated reviewer has access to. Two review rounds argued about
 * which subsystem owned it from indirect evidence. This makes it a measurement:
 * `gl.getError()` is called immediately after every draw, so an error can only
 * belong to the draw that just happened, and the currently bound program is
 * resolved back to its three.js material name.
 *
 * A validation failure per draw also makes Chrome's command decoder crawl, so a
 * non-empty result here is a performance finding as much as a correctness one.
 *
 * `getError()` forces a synchronous flush, so this is a diagnostic tool and
 * never something to leave running.
 */
const GL_ERROR_NAMES: Record<number, string> = {
  0x0500: 'INVALID_ENUM',
  0x0501: 'INVALID_VALUE',
  0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY',
  0x0506: 'INVALID_FRAMEBUFFER_OPERATION',
  0x9242: 'CONTEXT_LOST_WEBGL',
};

const DRAW_ENTRY_POINTS = [
  'drawElements',
  'drawElementsInstanced',
  'drawArrays',
  'drawArraysInstanced',
] as const;

interface GlValidateResult {
  frames: number;
  draws: number;
  errors: number;
  /** `entryPoint | ERROR_NAME | program` -> count. Empty object means clean. */
  byCause: Record<string, number>;
  pendingBefore: number;
}

async function glValidate(engine: EngineLike, frames: number): Promise<GlValidateResult> {
  const gl = engine.renderer.getContext();
  const programsOf = (): Array<{ name?: string; program?: WebGLProgram | null }> =>
    engine.renderer.info.programs ?? [];

  // Drain anything already queued so we only attribute errors we observed.
  let pendingBefore = 0;
  while (gl.getError() !== 0 && pendingBefore < 64) pendingBefore++;

  const byCause: Record<string, number> = {};
  let draws = 0;
  let errors = 0;

  type Ctx = Record<string, unknown>;
  const ctx = gl as unknown as Ctx;
  const original: Record<string, unknown> = {};

  const nameOfCurrentProgram = (): string => {
    const current = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    if (!current) return 'no-program';
    for (const p of programsOf()) if (p.program === current) return p.name ?? 'unnamed';
    // postprocessing builds its fullscreen materials outside three's cache.
    return 'fullscreen-pass';
  };

  for (const key of DRAW_ENTRY_POINTS) {
    const fn = ctx[key] as ((...a: unknown[]) => void) | undefined;
    if (typeof fn !== 'function') continue;
    original[key] = fn;
    const bound = fn.bind(gl);
    ctx[key] = (...args: unknown[]): void => {
      bound(...args);
      draws++;
      const e = gl.getError();
      if (e === 0) return;
      errors++;
      const cause = `${key} | ${GL_ERROR_NAMES[e] ?? e} | ${nameOfCurrentProgram()}`;
      byCause[cause] = (byCause[cause] ?? 0) + 1;
    };
  }

  let counted = 0;
  for (let i = 0; i < frames; i++) {
    await new Promise<void>((r) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; r(); } };
      requestAnimationFrame(finish);
      // rAF stops entirely when the preview pane is not compositing; without
      // this the probe would hang instead of reporting a short run.
      setTimeout(finish, 120);
    });
    counted++;
  }

  for (const key of DRAW_ENTRY_POINTS) {
    if (original[key]) ctx[key] = original[key];
  }

  return { frames: counted, draws, errors, byCause, pendingBefore };
}

// ---------------------------------------------------------------------------
//  Deterministic motion-blur A/B
// ---------------------------------------------------------------------------

/**
 * The canonical framings, duplicated from the QA harness's shot list.
 *
 * Duplicated on purpose: `__QA__.shot()` settles the simulation for a few
 * hundred milliseconds, and motion blur is a property of *one* camera step, so
 * anything that lets frames elapse between placing the camera and reading the
 * pixels measures a different thing each time. `mbFrame()` places the camera
 * and renders in the same JavaScript turn.
 */
const MB_FRAMINGS: Record<string, Record<string, number>> = {
  'chase-straight': { back: 7.5, up: 2.6, lookAhead: 14, fov: 62 },
  'chase-boost': { back: 6.5, up: 2.3, lookAhead: 16, fov: 74 },
  'driver-eye': { back: 3.5, up: 1.2, lookAhead: 30, lookUp: 0.4, fov: 66 },
  'kart-hero': { back: -3.0, up: 1.35, right: 3.2, lookAhead: 0, lookUp: 0.55, fov: 40 },
};

/**
 * Motion-blur constants, so one call can render the shipped look and the
 * pre-fix look at the *same* frame of the *same* race and the difference is
 * attributable to nothing else.
 *
 * `legacy` is what the critic reviewed: 0.035 max radius is 67 px of
 * convolution at 1920, and because the shader clamps the velocity rather than
 * scaling it, every pixel past the ceiling got the full 67 px.
 */
const MB_MODES = {
  shipped: { camera: 0.3, radial: 0.006, maxRadius: 0.008, mask: true },
  nomask: { camera: 0.3, radial: 0.006, maxRadius: 0.008, mask: false },
  legacy: { camera: 0.8, radial: 0.028, maxRadius: 0.032, mask: false },
  legacyMasked: { camera: 0.8, radial: 0.028, maxRadius: 0.032, mask: true },
  off: { camera: 0, radial: 0, maxRadius: 0.008, mask: false },
} as const;

export type MbMode = keyof typeof MB_MODES;

interface MbHarness {
  harness?: {
    takeCameraControl(): void;
    releaseCameraControl(): void;
    kartRelative(o: Record<string, number>): boolean;
    subjectInFrame(id?: number): { inFrame: boolean; ndc: [number, number]; distance: number };
  };
}

interface MbGame {
  engine: {
    camera: {
      position: { copy(v: unknown): unknown; addScaledVector(v: unknown, s: number): unknown; clone(): unknown };
      getWorldDirection(v: unknown): unknown;
      updateMatrixWorld(force?: boolean): void;
    };
    renderer: { setPixelRatio(v: number): void; domElement: { width: number } };
    adaptiveResolution: boolean;
    setRenderCallback(fn: (dt: number) => void): void;
  };
  race?: { state?: string; pause?(): void; resume?(): void; skipIntro?(): void };
  karts?: { player?: { position: { toArray(): number[] }; speed: number } };
  startRace?(o: Record<string, unknown>): Promise<void> | void;
  pipeline?: unknown;
}

interface MbFrameResult {
  mode: MbMode;
  shot: string;
  /** False means the capture is invalid — the subject is not in frame. */
  inFrame: boolean;
  ndc: [number, number];
  subjectDistanceM: number;
  maskOn: boolean;
  maskDrawCalls: number;
  cameraStrength: number;
  radialStrength: number;
  maxRadiusPx: number;
  /** Blur length in pixels of the current backing store, by view distance. */
  blurPxByDepth: Record<string, number>;
  kartPos: number[];
}

/**
 * Render exactly one deterministic motion-blurred frame and leave it on screen
 * to be screenshotted.
 *
 * The race is paused and the engine's render callback is replaced with a no-op,
 * so nothing overwrites the frame while a screenshot is taken and repeated
 * calls photograph the *same* moment of the *same* race — which is the only way
 * to A/B a temporal effect through a screenshot pipeline. Call
 * `__POST__.mbRelease()` afterwards to give the game back.
 *
 * The camera step is fabricated rather than observed: the camera is moved back
 * by `speedMs / 60` metres, fed to the reprojection as the previous frame, then
 * moved to where it belongs and fed again. The resulting blur is exactly what a
 * 60 Hz frame at `speedMs` would produce, whatever the pane's real frame rate.
 */
function mbFrame(
  pipeline: RenderPipeline,
  shot: string,
  speedMs: number,
  boost: number,
  mode: MbMode,
): MbFrameResult | { error: string } {
  const framing = MB_FRAMINGS[shot];
  if (!framing) return { error: `unknown framing "${shot}" (${Object.keys(MB_FRAMINGS).join(', ')})` };
  const qa = (globalThis as unknown as { __QA__?: MbHarness }).__QA__;
  const h = qa?.harness;
  const game = (globalThis as unknown as { __GAME__?: MbGame }).__GAME__;
  if (!h || !game) return { error: '__QA__ / __GAME__ not installed' };

  const p = pipeline as unknown as {
    motionBlur: {
      cameraStrength: number; radialStrength: number; speedIntensity: number;
      hasSubjectMask: boolean;
      uniforms: Map<string, { value: unknown }>;
      setSubjectMask(t: unknown): void;
      resetHistory(): void;
      setMatrices(cam: unknown, dt: number): void;
      reproject: { elements: number[] };
    } | null;
    motionPass: { enabled: boolean } | null;
    subjectMask: { texture: unknown } | null;
    renderSubjectMask(): boolean;
    composer: { render(dt: number): void };
    getStats(): { maskDrawCalls: number };
  };
  const mb = p.motionBlur;
  if (!mb) return { error: 'motion blur is not built on this quality tier' };

  const cfg = MB_MODES[mode];
  const dt = 1 / 60;

  game.race?.pause?.();

  mb.cameraStrength = cfg.camera;
  mb.radialStrength = cfg.radial;
  const params = mb.uniforms.get('mbParams')!.value as { x: number; y: number; z: number };
  params.z = cfg.maxRadius;
  if (cfg.mask && !mb.hasSubjectMask && p.subjectMask) mb.setSubjectMask(p.subjectMask.texture);
  if (!cfg.mask && mb.hasSubjectMask) mb.setSubjectMask(null);

  h.takeCameraControl();
  const cam = game.engine.camera;
  const fwd = cam.position.clone() as { copy(v: unknown): unknown };
  const home = cam.position.clone();

  /**
   * Draw the deterministic frame.
   *
   * Installed as the engine's render callback rather than drawn once, because a
   * WebGL canvas is presented at the compositor's convenience: drawing once and
   * then stubbing the render loop produced screenshots that were a capture
   * behind, which silently swapped the two halves of an A/B. Re-drawing the
   * identical frame every tick makes a stale screenshot impossible — the race is
   * paused, so every tick genuinely is the same frame.
   */
  const paint = (): void => {
    // Re-solve the framing every tick: it is the authoritative camera placement
    // and the race is paused, so it resolves to the same transform each time.
    h.kartRelative(framing);
    cam.updateMatrixWorld(true);
    (home as { copy(v: unknown): unknown }).copy(cam.position);
    cam.getWorldDirection(fwd);
    mb.resetHistory();
    mb.speedIntensity = boost;
    cam.position.addScaledVector(fwd, -speedMs * dt);
    cam.updateMatrixWorld(true);
    mb.setMatrices(cam, dt);
    cam.position.copy(home);
    cam.updateMatrixWorld(true);
    mb.setMatrices(cam, dt);
    if (p.motionPass) p.motionPass.enabled = true;
    if (mb.hasSubjectMask) p.renderSubjectMask();
    p.composer.render(dt);
  };

  paint();
  const subject = h.subjectInFrame(0);
  game.engine.setRenderCallback(paint);

  // Real buffer width, not CSS width: blur lengths are only meaningful in the
  // pixels the shader actually convolves.
  const width = game.engine.renderer.domElement.width;
  const camAny = cam as unknown as { near: number; far: number };
  const near = camAny.near;
  const far = camAny.far;
  const e = mb.reproject.elements;
  const blur: Record<string, number> = {};
  // Same maths as the fragment shader, on the CPU, at the kart's screen position.
  for (const zn of [0.94, 0.985, 0.996, 1.0]) {
    const x = 0;
    const y = -0.26;
    const px = e[0] * x + e[4] * y + e[8] * zn + e[12];
    const py = e[1] * x + e[5] * y + e[9] * zn + e[13];
    const pw0 = e[3] * x + e[7] * y + e[11] * zn + e[15];
    const pw = Math.abs(pw0) < 1e-6 ? 1e-6 : pw0;
    let vx = ((px / pw) * 0.5 + 0.5 - (x * 0.5 + 0.5)) * params.x;
    let vy = ((py / pw) * 0.5 + 0.5 - (y * 0.5 + 0.5)) * params.x;
    const r = Math.hypot(x * 0.5, y * 0.5);
    const t = Math.max(0, Math.min(1, (r - 0.1) / 0.52));
    const edge = t * t * (3 - 2 * t);
    vx += x * 0.5 * params.y * edge;
    vy += y * 0.5 * params.y * edge;
    const len = Math.min(Math.hypot(vx, vy), params.z);
    const dist = (2 * far * near) / (far + near - zn * (far - near));
    blur[`${dist < 1000 ? dist.toFixed(0) : 'sky'}m`] = Math.round(len * width * 10) / 10;
  }

  return {
    mode,
    shot,
    inFrame: subject.inFrame,
    ndc: subject.ndc,
    subjectDistanceM: subject.distance,
    maskOn: mb.hasSubjectMask,
    maskDrawCalls: p.getStats().maskDrawCalls,
    cameraStrength: mb.cameraStrength,
    radialStrength: mb.radialStrength,
    maxRadiusPx: Math.round(params.z * width * 10) / 10,
    blurPxByDepth: blur,
    kartPos: game.karts?.player?.position.toArray().map((n) => Math.round(n * 10) / 10) ?? [],
  };
}

/**
 * Everything the render chain binds into a sampler, with the properties that
 * decide whether the bind is legal. A depth texture with a comparison mode set
 * requires `sampler2DShadow`; bound to a plain `sampler2D` it fails validation
 * on every draw of that program — which is the mechanism behind the reported
 * flood, and the reason this dumps `compareFunction` for every target.
 */
function describeBoundTextures(pipeline: RenderPipeline): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  type Tex = {
    name?: string; format?: number; type?: number; internalFormat?: unknown;
    minFilter?: number; magFilter?: number; compareFunction?: unknown;
    isDepthTexture?: boolean; colorSpace?: string;
  };
  const add = (label: string, t: Tex | null | undefined): void => {
    if (!t) { out.push({ label, texture: 'none' }); return; }
    out.push({
      label,
      name: t.name || '(unnamed)',
      depth: !!t.isDepthTexture,
      format: t.format,
      type: t.type,
      internalFormat: t.internalFormat ?? null,
      minFilter: t.minFilter,
      magFilter: t.magFilter,
      // The one that bites. Must be null/undefined for a `sampler2D` bind.
      compareFunction: (t.compareFunction ?? null) as unknown,
      colorSpace: t.colorSpace,
    });
  };

  const c = pipeline.composer as unknown as {
    inputBuffer?: { texture?: Tex; depthTexture?: Tex };
    outputBuffer?: { texture?: Tex; depthTexture?: Tex };
    depthTexture?: Tex;
  };
  add('composer.inputBuffer.color', c.inputBuffer?.texture);
  add('composer.inputBuffer.depth', c.inputBuffer?.depthTexture);
  add('composer.outputBuffer.depth', c.outputBuffer?.depthTexture);

  const p = pipeline as unknown as {
    normalPass?: { texture?: Tex } | null;
    subjectMask?: { texture?: Tex } | null;
  };
  add('normalPass.texture', p.normalPass?.texture);
  add('subjectMask.texture', p.subjectMask?.texture);

  for (const pass of pipeline.composer.passes) {
    const dt = (pass as unknown as { getDepthTexture?: () => Tex | null }).getDepthTexture?.();
    if (dt) add(`${describe(pass)}.depthTexture`, dt);
  }
  return out;
}

/** Wait two frames, then read the composited frame back and summarise it. */
function probe(engine: EngineLike): Promise<ProbeResult> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const gl = engine.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      engine.renderer.setRenderTarget(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

      const step = 4;
      const lumas: number[] = [];
      let sumL = 0;
      let sumS = 0;
      let n = 0;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          const r = buf[i] / 255;
          const g = buf[i + 1] / 255;
          const b = buf[i + 2] / 255;
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          sumL += l;
          sumS += mx <= 1e-4 ? 0 : (mx - mn) / mx;
          lumas.push(l);
          n++;
        }
      }
      lumas.sort((a, b) => a - b);
      const q = (p: number): number => +lumas[Math.min(n - 1, Math.floor(n * p))].toFixed(4);
      const mean = sumL / n;
      let v = 0;
      for (const l of lumas) v += (l - mean) * (l - mean);
      resolve({
        meanLuma: +mean.toFixed(4),
        stdLuma: +Math.sqrt(v / n).toFixed(4),
        meanSat: +(sumS / n).toFixed(4),
        p1: q(0.01), p5: q(0.05), p50: q(0.5), p95: q(0.95), p99: q(0.99),
        blown: +(lumas.filter((l) => l > 0.98).length / n).toFixed(4),
        crushed: +(lumas.filter((l) => l < 0.02).length / n).toFixed(4),
      });
    }));
  });
}

/** Median frame time over `frames` presented frames. */
async function frameTime(frames: number): Promise<number> {
  const samples: number[] = [];
  let last = performance.now();
  for (let i = 0; i < frames; i++) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const now = performance.now();
    samples.push(now - last);
    last = now;
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

export function installPostQA(pipeline: RenderPipeline, engine: EngineLike): void {
  const api = {
    pipeline,
    probe: () => probe(engine),

    /**
     * Prove the presence or absence of the `Mismatch between texture format and
     * sampler type` flood. Returns `{ errors: 0, byCause: {} }` when clean, or
     * the exact draw entry point / error / material name when not.
     */
    glValidate: (frames = 30) => glValidate(engine, frames),

    /** Every texture the post chain binds, with its sampler-compatibility fields. */
    boundTextures: () => describeBoundTextures(pipeline),

    /**
     * Get the game into a photographable state: adaptive resolution off (it
     * desyncs the composer mid-measurement), a true 1920x1080 backing store (the
     * preview pane is only 1:1 at 800x450 CSS px), a race running, and the kart
     * up to speed. Idempotent.
     */
    async mbArm(pixelRatio = 2.4, driveFrames = 150): Promise<Record<string, unknown>> {
      const game = (globalThis as unknown as { __GAME__?: MbGame }).__GAME__;
      if (!game) return { error: '__GAME__ missing' };
      // A previous mbFrame() leaves the race paused and the render callback
      // stubbed. Without undoing that first, the drive loop below waits for a
      // kart that can never move and burns the whole call budget.
      this.mbRelease();
      game.engine.adaptiveResolution = false;
      game.engine.renderer.setPixelRatio(pixelRatio);
      globalThis.dispatchEvent(new Event('resize'));
      if (game.race?.state === 'idle' && game.startRace) {
        await game.startRace({});
        game.race.skipIntro?.();
      }
      globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
      // Wall-clock bounded: the preview pane runs rAF at ~10 Hz, so a frame
      // count alone would run for half a minute and get the call killed.
      const deadline = performance.now() + 9000;
      for (let i = 0; i < driveFrames; i++) {
        if (performance.now() > deadline) break;
        await new Promise<void>((r) => {
          let done = false;
          const fin = (): void => { if (!done) { done = true; r(); } };
          requestAnimationFrame(fin);
          setTimeout(fin, 60);
        });
        if ((game.karts?.player?.speed ?? 0) > 20 && i > 40) break;
      }
      return {
        raceState: game.race?.state,
        speedKmh: Math.round((game.karts?.player?.speed ?? 0) * 3.6),
        kartPos: game.karts?.player?.position.toArray().map((n) => Math.round(n * 10) / 10),
      };
    },

    /**
     * Render one deterministic motion-blurred frame and freeze it for a
     * screenshot. `mode` is one of shipped | nomask | legacy | legacyMasked | off.
     * ALWAYS check the returned `inFrame` before judging the image.
     */
    mbFrame: (shot = 'chase-boost', speedMs = 38, boost = 1, mode: MbMode = 'shipped') =>
      mbFrame(pipeline, shot, speedMs, boost, mode),

    /**
     * Arm a capture that survives a page reload.
     *
     * The dev server is shared by a dozen agents and every save triggers a Vite
     * full reload, which throws away any state a reviewer set up by hand — long
     * enough that a screenshot almost never lands on the frame it was set up
     * for. Stashing the request in `sessionStorage` means the *game* re-arms
     * itself on every boot: after this, any screenshot of the tab is the
     * requested deterministic frame, no timing required. Result lands in
     * `window.__MB__` and is logged.
     */
    mbAuto(shot = 'chase-boost', speedMs = 38, boost = 1, mode: MbMode = 'shipped', drive = 30): string {
      sessionStorage.setItem('__POST_MB_AUTO__', JSON.stringify({ shot, speedMs, boost, mode, drive }));
      return `armed: ${shot} @ ${speedMs} m/s, mode=${mode} (survives reload; __POST__.mbAutoOff() to stop)`;
    },

    mbAutoOff(): string {
      sessionStorage.removeItem('__POST_MB_AUTO__');
      return 'auto capture disarmed';
    },

    /** Hand the game back after mbFrame(). */
    mbRelease(): string {
      const game = (globalThis as unknown as { __GAME__?: MbGame }).__GAME__;
      const qa = (globalThis as unknown as { __QA__?: MbHarness }).__QA__;
      if (!game) return 'no game';
      game.engine.setRenderCallback((dt: number) => pipeline.render(dt));
      game.race?.resume?.();
      qa?.harness?.releaseCameraControl();
      return 'released';
    },

    /**
     * Per-pass cost. Measures median frame time with every pass on, then with
     * each pass individually disabled; the difference is that pass's share.
     * `emptyScene` swaps the RenderPass scene for an empty one first so the
     * scene's own cost stops dominating the measurement.
     */
    async passCost(frames = 40, emptyScene = false): Promise<Record<string, number>> {
      const composer = pipeline.composer;
      const rp = composer.passes[0] as unknown as { mainScene: unknown };
      const savedScene = rp.mainScene;
      if (emptyScene) {
        const THREE = await import('three');
        rp.mainScene = new THREE.Scene();
      }
      const out: Record<string, number> = {};
      await frameTime(20);
      const base = await frameTime(frames);
      out['ALL'] = +base.toFixed(2);

      for (const pass of composer.passes) {
        // The terminal pass carries renderToScreen; disabling it shows nothing.
        if (pass === composer.passes[composer.passes.length - 1]) continue;
        if (pass === composer.passes[0]) continue;
        if (!pass.enabled) continue;
        const label = describe(pass);
        pass.enabled = false;
        const t = await frameTime(frames);
        pass.enabled = true;
        out[label] = +(base - t).toFixed(2);
      }
      rp.mainScene = savedScene;
      return out;
    },

    /**
     * True per-pass GPU cost, in milliseconds, via
     * `EXT_disjoint_timer_query_webgl2`. Each pass's `render` is wrapped in a
     * TIME_ELAPSED query for a few frames; one pass at a time, because a context
     * may only have one active query.
     *
     * This is measured rather than inferred from frame rate on purpose: a hidden
     * or backgrounded tab has requestAnimationFrame throttled to a few Hz, which
     * makes every wall-clock frame-time measurement meaningless.
     */
    async gpuCost(
      framesPerPass = 5,
      onPartial?: (label: string, ms: number | string) => void,
    ): Promise<Record<string, number | string>> {
      const gl = engine.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as
        { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
      if (!ext) return { error: 'EXT_disjoint_timer_query_webgl2 unavailable' };

      const out: Record<string, number | string> = {};
      for (const pass of pipeline.composer.passes) {
        const label = describe(pass);
        if (!pass.enabled) { out[label] = 'disabled'; continue; }

        const target = pass as unknown as { render: (...a: unknown[]) => void };
        const orig = target.render.bind(pass);
        const queries: WebGLQuery[] = [];
        target.render = (...args: unknown[]): void => {
          const q = gl.createQuery();
          if (q === null) { orig(...args); return; }
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          orig(...args);
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          queries.push(q);
        };

        await settleFrames(framesPerPass);
        target.render = orig;
        // Give the GPU a couple of frames to retire the last queries.
        await settleFrames(2);

        const times: number[] = [];
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
        for (const q of queries) {
          if (!disjoint && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) === true) {
            times.push((gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6);
          }
          gl.deleteQuery(q);
        }
        if (disjoint || times.length === 0) {
          out[label] = 'no sample';
        } else {
          times.sort((a, b) => a - b);
          out[label] = +times[Math.floor(times.length / 2)].toFixed(3);
          // Spread tells us whether the number is trustworthy: a shared dev
          // machine with five other agents on it produces very torn samples.
          out[label + ' (min..max)'] = `${times[0].toFixed(3)}..${times[times.length - 1].toFixed(3)} n=${times.length}`;
        }
        onPartial?.(label, out[label]);
      }
      let total = 0;
      for (const [k, v] of Object.entries(out)) {
        if (typeof v === 'number' && !k.endsWith(')')) total += v;
      }
      out['TOTAL_post_ms'] = +total.toFixed(3);
      return out;
    },

    toneMap(name: ToneMapName): string {
      pipeline.setToneMap(name);
      return name;
    },

    /**
     * Calibrate all four grade presets against the *matching* sky/lighting
     * preset, which is the only way the numbers mean anything — measuring the
     * `night` grade under a daylight sky tells you nothing.
     *
     * Writes to sessionStorage after every preset, so a run torn apart by a dev
     * server reload still leaves usable data behind.
     */
    async autoCalibrate(shot = 'chase-straight'): Promise<unknown> {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.calib.status', 'running');
      const out: Record<string, unknown> = {};
      try {
        const { qa } = await bringUp(shot);
        const look = pipeline.gradeEffect.uniforms.get('gkLook')!.value as { x: number };
        // Overridable so a follow-up run can focus on one preset, or widen the
        // ladder, without another source edit and reload.
        const presets = readList('postqa.calib.presets', ['day', 'sunset', 'night', 'storm']) as GradePresetName[];
        const muls = readList('postqa.calib.muls', ['0.7', '0.85', '1.2', '1.45']).map(Number);
        out['sweep'] = { presets, muls };

        for (const preset of presets) {
          qa.setSky?.(preset);
          pipeline.setGradePreset(preset, 0);
          // Lighting presets cross-fade, so give them wall-clock time to land.
          await settleWall(1600);
          await applyShot(qa, shot);
          await settleWall(400);

          const base = look.x;
          const row: Record<string, unknown> = { presetExposure: base };
          row['at_shipped'] = await probe(engine);
          for (const mul of muls) {
            look.x = +(base * mul).toFixed(4);
            await settleFrames(2);
            row['exposure_' + look.x] = await probe(engine);
          }
          look.x = base;
          await settleFrames(2);
          out[preset] = row;
          store('postqa.calib.result', out);
          store('postqa.calib.status', 'partial:' + Object.keys(out).join(','));
        }

        qa.setSky?.('day');
        pipeline.setGradePreset('day', 0);
        await settleWall(600);
        out['stats'] = qa.stats?.() ?? null;
        store('postqa.calib.result', out);
        store('postqa.calib.status', 'done');
        return out;
      } catch (err) {
        store('postqa.calib.result', out);
        store('postqa.calib.status', 'error: ' + (err as Error).message);
        return { error: (err as Error).message, partial: out };
      }
    },

    /**
     * Exposure ladder on a locked camera. The one number that has to be
     * re-trimmed whenever world lighting changes, so it gets its own fast mode
     * with no shader recompiles.
     */
    async autoExposure(shot = 'chase-straight'): Promise<unknown> {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.exp.status', 'running');
      try {
        const qa = await waitFor(() => (globalThis as unknown as Record<string, QaLike | undefined>).__QA__, 60000);
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        if (!qa || !game) throw new Error('no __QA__/__GAME__');
        if (game.race?.state === 'idle') game.startRace?.({});
        game.menus?.hideAll?.();
        await waitFor(() => (game.race?.state === 'racing' ? true : undefined), 40000);
        game.menus?.hideAll?.();
        await applyShot(qa, shot);

        const look = pipeline.gradeEffect.uniforms.get('gkLook')!.value as { x: number; z: number };
        const shipped = { x: look.x, z: look.z };
        const out: Record<string, unknown> = { shot, shipped };
        // Ladder around the shipped value. Read `meanSat` and `stdLuma` as well
        // as `meanLuma`: on this scene both *fall* as exposure rises, because
        // more of the image lands in the AgX shoulder where it desaturates.
        for (const e of [0.6, 0.7, 0.85, 1.0, 1.2, 1.5]) {
          look.x = e;
          await settleFrames(2);
          out['exposure_' + e] = await probe(engine);
        }
        look.x = shipped.x;
        look.z = shipped.z;
        await settleFrames(2);
        out['stats'] = qa.stats?.() ?? null;
        store('postqa.exp.result', out);
        store('postqa.exp.status', 'done');
        return out;
      } catch (err) {
        store('postqa.exp.status', 'error: ' + (err as Error).message);
        return { error: (err as Error).message };
      }
    },

    /**
     * The full post-chain report: histogram of the shipped frame, per-pass GPU
     * cost, which passes are live, and the buffer format/size. Written to
     * sessionStorage so it survives the dev server's reloads.
     */
    async autoReport(shot = 'chase-straight'): Promise<unknown> {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.report.status', 'running');
      try {
        const qa = await waitFor(() => (globalThis as unknown as Record<string, QaLike | undefined>).__QA__, 60000);
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        if (!qa || !game) throw new Error('no __QA__/__GAME__');
        if (game.race?.state === 'idle') game.startRace?.({});
        game.menus?.hideAll?.();
        await waitFor(() => (game.race?.state === 'racing' ? true : undefined), 40000);
        game.menus?.hideAll?.();
        // Free-fly, so the chase camera cannot drift between measurements.
        qa.harness?.takeCameraControl?.();
        await applyShot(qa, shot);

        const buf = pipeline.composer.inputBuffer;
        const out = {
          shot,
          visibility: document.visibilityState,
          probe: await probe(engine),
          gpuMs: await api.gpuCost(6),
          passes: pipeline.composer.passes.map((p) => ({ n: describe(p), on: p.enabled })),
          buffer: {
            width: buf.width,
            height: buf.height,
            type: buf.texture.type,
            isHalfFloat: buf.texture.type === 1016,
          },
          toneMap: pipeline.toneMap,
          stats: qa.stats?.() ?? null,
        };
        store('postqa.report.result', out);
        store('postqa.report.status', 'done');
        return out;
      } catch (err) {
        store('postqa.report.status', 'error: ' + (err as Error).message);
        return { error: (err as Error).message };
      }
    },

    /**
     * Everything the look needs to be judged on, in one unattended run:
     * a reference probe with the grade bypassed (what plain three.js AgX would
     * have produced on this exact frame), an exposure ladder, a tone-mapping
     * operator comparison, and an on/off probe for each expensive effect.
     * Results land in sessionStorage under `postqa.sweep.result`.
     */
    async autoSweep(shot = 'chase-straight'): Promise<unknown> {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.sweep.status', 'running');
      try {
        const qa = await waitFor(() => (globalThis as unknown as Record<string, QaLike | undefined>).__QA__, 40000);
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        if (!qa || !game) throw new Error('no __QA__/__GAME__');
        if (game.race?.state === 'idle') game.startRace?.({});
        game.menus?.hideAll?.();
        await waitFor(() => (game.race?.state === 'racing' ? true : undefined), 40000);
        game.menus?.hideAll?.();
        await applyShot(qa, shot);

        const grade = pipeline.gradeEffect;
        const look = grade.uniforms.get('gkLook')!.value as { x: number; z: number; w: number };
        const range = grade.uniforms.get('gkRange')!.value as { x: number; y: number; z: number };
        const tone = grade.uniforms.get('gkTone')!.value as { x: number; y: number; w: number };
        const saved = {
          x: look.x, z: look.z, w: look.w,
          rx: range.x, ry: range.y, rz: range.z,
          tx: tone.x, ty: tone.y, tw: tone.w,
        };
        const out: Record<string, unknown> = { shot, preset: { ...saved } };

        // Reference: grade fully bypassed, plain AgX. The "before" column.
        look.x = 1; look.z = 1; look.w = 1;
        range.x = 0; range.y = 1; range.z = 1;
        tone.x = 1; tone.y = 0; tone.w = 0;
        out['REF_plainAgX_noGrade'] = await probe(engine);

        // Tone-mapping operators, still ungraded, so the operator is isolated.
        for (const tm of ['agx', 'aces', 'neutral'] as ToneMapName[]) {
          pipeline.setToneMap(tm);
          await settleFrames(3);
          out['REF_' + tm] = await probe(engine);
        }
        pipeline.setToneMap('agx-punchy');
        await settleFrames(3);
        out['REF_agxPunchy_noGrade'] = await probe(engine);

        // Restore the real grade, then walk exposure.
        look.x = saved.x; look.z = saved.z; look.w = saved.w;
        range.x = saved.rx; range.y = saved.ry; range.z = saved.rz;
        tone.x = saved.tx; tone.y = saved.ty; tone.w = saved.tw;
        for (const e of [0.9, 1.05, 1.2, 1.35, 1.5]) {
          look.x = e;
          await settleFrames(2);
          out['exposure_' + e] = await probe(engine);
        }
        look.x = saved.x;
        await settleFrames(2);
        out['GRADED_asShipped'] = await probe(engine);

        // Per-effect image contribution.
        for (const pass of pipeline.composer.passes) {
          const label = describe(pass);
          if (!pass.enabled) { out['off_' + label] = 'already disabled'; continue; }
          if (pass === pipeline.composer.passes[0]) continue;
          if (pass === pipeline.composer.passes[pipeline.composer.passes.length - 1]) continue;
          pass.enabled = false;
          await settleFrames(2);
          out['without_' + label] = await probe(engine);
          pass.enabled = true;
        }
        await settleFrames(2);

        out['stats'] = qa.stats?.() ?? null;
        store('postqa.sweep.result', out);
        store('postqa.sweep.status', 'done');
        return out;
      } catch (err) {
        store('postqa.sweep.status', 'error: ' + (err as Error).message);
        return { error: (err as Error).message };
      }
    },

    /**
     * Orientation test for the canvas-texture helpers, used to settle the
     * "canvas text renders mirrored" report.
     *
     * Builds a texture whose left half is RED and right half is BLUE (plus
     * "ABC"), puts it on a stock `PlaneGeometry` facing the camera, and reads
     * the framebuffer back to decide which side the red half landed on. A
     * correct helper + correct UVs puts canvas-left on screen-left.
     *
     * Also reports the track frame's handedness and which world side a positive
     * lateral offset corresponds to, because that — not the texture — is what
     * mirrors geometry built from the track frame.
     */
    async uvTest(): Promise<Record<string, unknown>> {
      const game = (globalThis as unknown as { __GAME__?: Record<string, unknown> }).__GAME__;
      if (!game) return { error: 'need window.__GAME__' };

      const [THREE, tf, wt] = await Promise.all([
        import('three'),
        import('./TextureFactory'),
        import('../world/WorldTextures').catch(() => null),
      ]);

      const draw = (ctx: CanvasRenderingContext2D, w: number, h: number): void => {
        ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, w / 2, h);          // canvas LEFT
        ctx.fillStyle = '#0000ff'; ctx.fillRect(w / 2, 0, w / 2, h);      // canvas RIGHT
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(h * 0.5)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('ABC', w / 2, h / 2);
      };

      const eng = game.engine as { camera: import('three').PerspectiveCamera; scene: import('three').Scene };
      const cam = eng.camera;
      const scene = eng.scene;
      const prev = scene.getObjectByName('__UVTEST__');
      if (prev) scene.remove(prev);

      const results: Record<string, unknown> = {};
      const variants: Array<[string, import('three').Texture]> = [
        ['render/TextureFactory.canvasTexture', tf.canvasTexture(512, 256, draw)],
      ];
      if (wt?.canvasTexture) {
        variants.push(['world/WorldTextures.canvasTexture', wt.canvasTexture(512, draw, { height: 256 })]);
      }

      for (const [label, tex] of variants) {
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(8, 4),
          new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false, depthTest: false }),
        );
        mesh.name = '__UVTEST__';
        mesh.renderOrder = 100000;
        // Parented to the camera, so a moving chase camera cannot leave it
        // behind between the setup and the read-back.
        mesh.position.set(0, 0, -5);
        cam.add(mesh);
        await settleFrames(3);
        results[label] = await readSides(engine);
        cam.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as import('three').Material).dispose();
        tex.dispose();
      }

      // Track frame handedness + which way a positive lateral offset points.
      const track = game.track as {
        sampleAt?: (t: number) => {
          position: import('three').Vector3; tangent: import('three').Vector3;
          normal: import('three').Vector3; binormal: import('three').Vector3;
        };
      } | undefined;
      if (typeof track?.sampleAt === 'function') {
        const s = track.sampleAt(0.1);
        const txn = new THREE.Vector3().crossVectors(s.tangent, s.normal);
        results['trackFrame'] = {
          // +1 => binormal == tangent x normal (right-handed as built)
          // -1 => binormal is the mirror of that
          sign_of_binormal_vs_tangentCrossNormal: +txn.dot(s.binormal).toFixed(3),
          binormalPointsDriverRight: +new THREE.Vector3()
            .crossVectors(s.tangent, new THREE.Vector3(0, 1, 0)).dot(s.binormal).toFixed(3),
          tangent: s.tangent.toArray().map((v) => +v.toFixed(3)),
          normal: s.normal.toArray().map((v) => +v.toFixed(3)),
          binormal: s.binormal.toArray().map((v) => +v.toFixed(3)),
        };

        // Does the field actually drive along +tangent? Anything that derives an
        // orientation from the track frame (road decals, trackside signage) is
        // mirrored end-for-end if the answer is no — regardless of which canvas
        // helper drew the texture.
        const karts = game.karts as {
          player?: { position?: import('three').Vector3; yaw?: number; speed?: number };
        } | undefined;
        const p = karts?.player;
        if (p?.position) {
          // Nearest spline sample to the kart, by brute-force scan.
          let bestT = 0;
          let bestD = Infinity;
          for (let i = 0; i < 400; i++) {
            const t = i / 400;
            const d = track.sampleAt(t).position.distanceToSquared(p.position);
            if (d < bestD) { bestD = d; bestT = t; }
          }
          const near = track.sampleAt(bestT);
          const info: Record<string, unknown> = { nearestT: +bestT.toFixed(4) };
          if (typeof p.yaw === 'number') {
            const fwd = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
            info['dot_kartYawFwd_tangent'] = +fwd.dot(near.tangent).toFixed(3);
            const fwdNeg = fwd.clone().negate();
            info['dot_negKartYawFwd_tangent'] = +fwdNeg.dot(near.tangent).toFixed(3);
          }
          results['driveDirection'] = info;
        }
      }
      await settleFrames(2);

      // Bisection: blit the LIVE atlases straight into a DOM overlay. This shows
      // the source canvas with no geometry, no UVs and no shader in the way, so
      // it separates "the texture was painted mirrored" from "the texture was
      // mapped mirrored".
      results['atlasOverlay'] = showAtlasOverlay(scene, [
        ['apx-decals', 14, 4, 4],   // Decals FINISH cell, 4x4 atlas
        ['prop-atlas', 0, 4, 2],    // Props sponsor board cell, 4x2 atlas
      ]);
      return results;
    },

    /**
     * Drive the game to a canonical framing and probe it, writing the result to
     * sessionStorage. Runs itself on load when `postqa.auto` is set, so a
     * measurement survives the Vite reloads that a shared dev server produces
     * constantly — poll `postqa.status` instead of holding an await open.
     */
    async autoRun(shot = 'chase-straight'): Promise<unknown> {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.status', 'running');
      try {
        const qa = await waitFor(() => (globalThis as unknown as Record<string, QaLike | undefined>).__QA__, 30000);
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        if (!qa || !game) throw new Error('no __QA__/__GAME__');
        if (game.race?.state === 'idle') game.startRace?.({});
        game.menus?.hideAll?.();
        await waitFor(() => (game.race?.state === 'racing' ? true : undefined), 30000);
        game.menus?.hideAll?.();
        // Apply the shot's framing but settle on a wall clock, not a frame
        // count: CaptureHarness settles for 60 frames, which is two minutes when
        // the scene is running at 0.5 fps.
        qa.harness?.setHudVisible?.(true);
        await applyShot(qa, shot);
        const p = await probe(engine);
        const result = { shot, probe: p, stats: qa.stats?.() ?? null, toneMap: pipeline.toneMap };
        store('postqa.result', result);
        store('postqa.status', 'done');
        return result;
      } catch (err) {
        store('postqa.status', 'error: ' + (err as Error).message);
        return { error: (err as Error).message };
      }
    },
    exposure(v: number): number {
      pipeline.setExposure(v);
      return v;
    },
    passes(): Array<{ name: string; enabled: boolean }> {
      return pipeline.composer.passes.map((p) => ({ name: describe(p), enabled: p.enabled }));
    },
    stats: () => pipeline.getStats(),
  };

  (globalThis as unknown as Record<string, unknown>).__POST__ = api;
  console.info(
    '[PostQA] window.__POST__ ready — probe() passCost() toneMap() exposure() passes() autoRun()'
    + ' glValidate() boundTextures() mbArm() mbFrame(shot,speed,boost,mode) mbRelease()',
  );

  let auto = '';
  try { auto = sessionStorage.getItem('postqa.auto') ?? ''; } catch { /* ignore */ }
  const shot = (() => { try { return sessionStorage.getItem('postqa.shot') ?? 'chase-straight'; } catch { return 'chase-straight'; } })();
  if (auto === '1') void api.autoRun(shot);
  else if (auto === 'sweep') void api.autoSweep(shot);
  else if (auto === 'report') void api.autoReport(shot);
  else if (auto === 'exposure') void api.autoExposure(shot);
  else if (auto === 'calib') void api.autoCalibrate(shot);
  else if (auto === 'gpu') {
    void (async () => {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.gpu.status', 'running');
      const partial: Record<string, unknown> = {};
      try {
        const { qa } = await bringUp(shot);
        const gl = engine.renderer.getContext();
        partial['timerAvailable'] = gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null;
        partial['visibility'] = document.visibilityState;
        store('postqa.gpu.result', partial);
        const res = await api.gpuCost(5, (label, ms) => {
          partial[label] = ms;
          store('postqa.gpu.result', partial);
        });
        Object.assign(partial, res);
        partial['stats'] = qa.stats?.() ?? null;
        partial['visibilityAtEnd'] = document.visibilityState;
        store('postqa.gpu.result', partial);
        store('postqa.gpu.status', 'done');
      } catch (err) {
        store('postqa.gpu.result', partial);
        store('postqa.gpu.status', 'error: ' + (err as Error).message);
      }
    })();
  }
  else if (auto === 'uv') {
    void (async () => {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.uv.status', 'running');
      try {
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        await waitFor(() => (globalThis as unknown as Record<string, unknown>).__QA__, 60000);
        if (game?.race?.state === 'idle') game.startRace?.({});
        game?.menus?.hideAll?.();
        await waitFor(() => (game?.race?.state === 'racing' ? true : undefined), 30000);
        store('postqa.uv.result', await api.uvTest());
        store('postqa.uv.status', 'done');
      } catch (err) {
        store('postqa.uv.status', 'error: ' + (err as Error).message);
      }
    })();
  }

  // Reload-surviving deterministic motion-blur capture. See api.mbAuto().
  let mbAuto = '';
  try { mbAuto = sessionStorage.getItem('__POST_MB_AUTO__') ?? ''; } catch { /* ignore */ }
  if (mbAuto) {
    void (async () => {
      try {
        const req = JSON.parse(mbAuto) as
          { shot: string; speedMs: number; boost: number; mode: MbMode; drive: number };
        await waitFor(() => (globalThis as unknown as Record<string, unknown>).__QA__, 90000);
        await api.mbArm(2.4, req.drive);
        const res = api.mbFrame(req.shot, req.speedMs, req.boost, req.mode);
        (globalThis as unknown as Record<string, unknown>).__MB__ = res;
        console.info('[PostQA] auto mbFrame ready:', JSON.stringify(res));
      } catch (err) {
        (globalThis as unknown as Record<string, unknown>).__MB__ = { error: (err as Error).message };
        console.warn('[PostQA] auto mbFrame failed', err);
      }
    })();
  }
}

/** Wait n presented frames. */
async function settleFrames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

/**
 * Settle for a wall-clock duration, but cap the frame count so a tab whose
 * requestAnimationFrame is throttled to ~0.5 Hz (which is what a hidden or
 * non-compositing pane gives you) cannot stall the run indefinitely.
 */
async function settleWall(ms: number, maxFrames = 90): Promise<void> {
  const end = Date.now() + ms;
  let frames = 0;
  while (Date.now() < end && frames < maxFrames) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    frames++;
  }
}

/**
 * Get the game to a stable, camera-locked gameplay frame: start the race, skip
 * the cinematic (it is rAF-throttled and can take minutes in a hidden tab),
 * hide the menus, and place the camera.
 */
async function bringUp(shot: string): Promise<{ qa: QaLike; game: GameLike }> {
  const qa = await waitFor(
    () => (globalThis as unknown as Record<string, QaLike | undefined>).__QA__,
    60000,
  );
  const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
  if (!qa || !game) throw new Error('no __QA__/__GAME__');
  if (game.race?.state === 'idle') game.startRace?.({});
  game.menus?.hideAll?.();
  game.race?.skipIntro?.();
  await waitFor(() => (game.race?.state === 'racing' ? true : undefined), 30000);
  game.menus?.hideAll?.();
  await applyShot(qa, shot);
  return { qa, game };
}

/**
 * Find named materials in the scene, crop one atlas cell out of each one's map
 * canvas, and blit them into a fixed DOM overlay at the top of the page.
 *
 * The point is to look at the *source* pixels. If text is already reversed here
 * then whatever painted the canvas is at fault; if it reads correctly here but
 * reversed in the world, the UVs or the quad orientation are at fault.
 */
function showAtlasOverlay(
  scene: import('three').Scene,
  want: Array<[string, number, number, number]>,
): string[] {
  const found: string[] = [];
  document.getElementById('__ATLASDBG__')?.remove();
  const host = document.createElement('div');
  host.id = '__ATLASDBG__';
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;display:flex;gap:8px;'
    + 'background:#000;padding:6px;font:12px monospace;color:#fff';

  const maps = new Map<string, HTMLCanvasElement>();
  scene.traverse((o) => {
    const mats = (o as { material?: unknown }).material;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const mat = m as { name?: string; map?: { image?: unknown } } | undefined;
      const img = mat?.map?.image;
      if (mat?.name && img instanceof HTMLCanvasElement && !maps.has(mat.name)) {
        maps.set(mat.name, img);
      }
    }
  });

  for (const [name, cell, cols, rows] of want) {
    const src = maps.get(name);
    const wrap = document.createElement('div');
    if (!src) {
      wrap.textContent = name + ': not found';
      host.appendChild(wrap);
      continue;
    }
    found.push(`${name} ${src.width}x${src.height}`);
    const cw = src.width / cols;
    const ch = src.height / rows;
    const sx = (cell % cols) * cw;
    const sy = Math.floor(cell / cols) * ch;
    const out = document.createElement('canvas');
    out.width = 360;
    out.height = Math.round(360 * (ch / cw));
    const c = out.getContext('2d');
    if (c) {
      c.fillStyle = '#222';
      c.fillRect(0, 0, out.width, out.height);
      c.drawImage(src, sx, sy, cw, ch, 0, 0, out.width, out.height);
    }
    out.style.cssText = 'border:1px solid #0f0;display:block';
    const label = document.createElement('div');
    label.textContent = `${name} cell ${cell}`;
    wrap.appendChild(label);
    wrap.appendChild(out);
    host.appendChild(wrap);
  }
  document.body.appendChild(host);
  return found;
}

/**
 * Read the finished frame and report the mean red/blue of its left and right
 * thirds. Used by `uvTest` to decide, without human eyes, which way round a
 * texture landed on screen.
 */
function readSides(engine: EngineLike): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const gl = engine.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      engine.renderer.setRenderTarget(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

      const band = (x0: number, x1: number): { r: number; b: number } => {
        let r = 0; let b = 0; let n = 0;
        const y0 = Math.floor(h * 0.4);
        const y1 = Math.floor(h * 0.6);
        for (let y = y0; y < y1; y += 2) {
          for (let x = Math.floor(w * x0); x < Math.floor(w * x1); x += 2) {
            const i = (y * w + x) * 4;
            r += buf[i]; b += buf[i + 2]; n++;
          }
        }
        return { r: +(r / n / 255).toFixed(3), b: +(b / n / 255).toFixed(3) };
      };
      const left = band(0.30, 0.45);
      const right = band(0.55, 0.70);
      const redIsLeft = left.r - left.b > right.r - right.b;
      resolve({
        screenLeft: left,
        screenRight: right,
        // The texture's red half is the CANVAS LEFT half.
        canvasLeftLandedOn: redIsLeft ? 'screen-LEFT (correct)' : 'screen-RIGHT (MIRRORED)',
        mirrored: !redIsLeft,
      });
    }));
  });
}

interface HarnessLike {
  releaseCameraControl?: () => void;
  takeCameraControl?: () => void;
  onTrack?: (t: number, opts?: Record<string, number>) => void;
  setHudVisible?: (v: boolean) => void;
}
interface QaLike {
  shot(name: string): Promise<Record<string, number | string>>;
  harness?: HarnessLike;
  stats?: () => Record<string, number | string>;
  /** Switches Sky *and* Lighting to a named preset. */
  setSky?: (preset: string) => void;
  gpuTimingAvailable?: () => boolean;
}

/** The camera framings we care about, without CaptureHarness's frame-count settle. */
const FRAMINGS: Record<string, { chase: boolean; t: number; opts: Record<string, number> }> = {
  'chase-straight': { chase: true, t: 0.08, opts: { back: 7.5, up: 2.6, lookAhead: 30 } },
  'chase-boost': { chase: true, t: 0.35, opts: { back: 6.5, up: 2.3, lookAhead: 40 } },
  'pack-battle': { chase: true, t: 0.5, opts: { back: 11, up: 4.2, lookAhead: 26 } },
  'scenery-vista': { chase: false, t: 0.62, opts: { back: 4, up: 24, side: 40, lookAhead: 10, fov: 55 } },
  'grid-wide': { chase: false, t: 0.985, opts: { back: -26, up: 13, lookAhead: 60, fov: 48 } },
};

async function applyShot(qa: QaLike, name: string): Promise<void> {
  const f = FRAMINGS[name];
  const h = qa.harness;
  if (f && h) {
    // Always end in free-fly. `onTrack` gives us the chase-like framing we want,
    // but leaving the camera in chase mode lets the controller move it between
    // successive probes — which silently invalidates any A/B comparison.
    h.takeCameraControl?.();
    h.onTrack?.(f.t, f.opts);
  } else {
    // Not one of ours (e.g. kart-hero needs the live kart) — fall back.
    await qa.shot(name);
    return;
  }
  // Wall-clock settle, capped, plus a couple of frames so the camera lands.
  const end = Date.now() + 1200;
  do {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  } while (Date.now() < end);
}
interface GameLike {
  race?: { state?: string; skipIntro?: () => void };
  menus?: { hideAll?: () => void };
  startRace?: (opts: Record<string, unknown>) => void;
}

/** Comma-separated sessionStorage override, falling back to a default list. */
function readList(key: string, fallback: string[]): string[] {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : fallback;
  } catch { return fallback; }
}

/** Poll `fn` until it returns something truthy, or give up after `ms`. */
async function waitFor<T>(fn: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await new Promise<void>((r) => setTimeout(r, 250));
  }
}

function describe(pass: { name?: string; effects?: Array<{ name: string }> }): string {
  const fx = pass.effects;
  if (fx && fx.length > 0) return fx.map((e) => e.name.replace('Effect', '')).join('+');
  return pass.name ?? 'Pass';
}
