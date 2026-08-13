import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings, QualityTier } from './Types';
import { FIXED_DT, MAX_FRAME_DT, MAX_SUBSTEPS, QUALITY_PRESETS } from './Config';
import { bus } from './EventBus';
import { clamp } from './MathUtils';

// ---------------------------------------------------------------------------
//  Adaptive resolution tuning. See `trackPerformance` for why each exists.
// ---------------------------------------------------------------------------

/**
 * Step DOWN above this median frame time, sustained for `SLOW_HOLD`.
 *
 * 16.6 ms is the real 60 fps budget. The old value was 15.5, which shed
 * resolution while the frame was still inside budget.
 */
const SLOW_MS = 16.6;
/** Step UP below this median, sustained for `FAST_HOLD`. */
const FAST_MS = 10.5;
/**
 * The dead band is therefore 10.5-16.6 ms, replacing 11.5-15.5. Widened at both
 * ends: a frame near 13 ms used to cross the old band on noise alone, and each
 * crossing reallocated every render target in the post chain.
 */
const SLOW_HOLD = 1.0;
/** Asymmetric on purpose: drop quickly, recover reluctantly. */
const FAST_HOLD = 4.0;
/** Must stay under RenderPipeline's 2.5 s effect settle. */
const SCALE_COOLDOWN = 2.0;
const SCALE_FLOOR = 0.65;
/** Direction changes tolerated before the ceiling is nailed for the session. */
const MAX_REVERSALS = 3;

/**
 * Engine owns the renderer, the scene, the camera and the frame loop.
 *
 * It runs a fixed-timestep accumulator for physics with render interpolation,
 * so handling is deterministic at any refresh rate. Subsystems register once
 * and get `fixedUpdate` (120 Hz) and `update` (display rate) called for them.
 *
 * The post-processing chain lives in RenderPipeline and is installed via
 * `setRenderCallback`. Until then Engine falls back to a direct render.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  quality: QualitySettings;

  private subsystems: ISubsystem[] = [];
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private rafId = 0;

  private ctx: {
    dt: number; fixedDt: number; elapsed: number; frame: number; alpha: number;
  } = { dt: 0, fixedDt: FIXED_DT, elapsed: 0, frame: 0, alpha: 0 };

  /** Installed by RenderPipeline. Receives (dt) and must draw the frame. */
  private renderCallback: ((dt: number) => void) | null = null;
  private resizeCallbacks: Array<(w: number, h: number) => void> = [];

  // --- adaptive resolution ---
  private frameTimes: number[] = [];
  private currentScale = 1;
  private targetScale = 1;
  private lastScaleChange = 0;
  /**
   * The pixel ratio that lands on the fill budget at this CSS size, BEFORE the
   * adaptive scale multiplies it. The adaptive path used to recompute the ratio as
   * `min(devicePixelRatio, 2) * currentScale`, which silently discarded the `fit`
   * term the constructor had worked out — see `trackPerformance`.
   */
  private baseRatio = 1;
  /** Ratio actually handed to the renderer, so a sub-visible change can be skipped. */
  private appliedRatio = 1;
  /**
   * When each verdict first became true, or -1. A verdict has to HOLD for its own
   * window before it moves anything; a single slow frame is noise, not a trend.
   */
  private slowSince = -1;
  private fastSince = -1;
  /** Sign of the last scale change, and how many times the controller has reversed. */
  private lastDir = 0;
  private reversals = 0;
  /** Upper bound on `targetScale`. Ratchets DOWN when the controller oscillates. */
  private maxScale = 1;
  adaptiveResolution = true;

  /** Rolling average frame time in ms, for the debug HUD. */
  fpsAverage = 60;

  private resizeObserver: ResizeObserver | null = null;
  private readonly container: HTMLElement;

  constructor(container: HTMLElement, tier: QualityTier = 'ultra') {
    this.quality = { ...QUALITY_PRESETS[tier] };
    this.container = container;

    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false, // handled by the post chain (SMAA/TAA)
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      logarithmicDepthBuffer: false,
    });

    // Pixel ratio is capped by a PIXEL BUDGET, not just by devicePixelRatio.
    //
    // This used to be `min(devicePixelRatio, 2)`, which on a Retina 16"
    // (1512x982 CSS) asks for a 3024x1964 = 5.94 Mpx buffer. The post chain's
    // ~17 ms was measured at 1.44 Mpx, so that is 3.09x the fill it was designed
    // for — roughly 80 ms/frame before a single triangle of geometry. Adaptive
    // resolution does claw it back, but it takes ~6 s to ramp and floors at
    // 1.29x, so the first seconds of every race were unplayable and the steady
    // state was still over budget. This was the largest single cause of the
    // owner's "lag is still severe".
    //
    // `fit` is the ratio that lands on a 1920x1080-equivalent fill for whatever
    // CSS size we actually got; we take the smaller of that and the display's
    // own ratio, and never go below 1.
    const cssW = container.clientWidth || window.innerWidth || 1920;
    const cssH = container.clientHeight || window.innerHeight || 1080;
    const fit = Math.sqrt((1920 * 1080) / Math.max(1, cssW * cssH));
    this.baseRatio = Math.max(1, Math.min(Math.min(window.devicePixelRatio, 2), fit));
    this.appliedRatio = this.baseRatio;
    this.renderer.setPixelRatio(this.baseRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Tone mapping lives in the post chain (RenderPipeline's GradeEffect), which
    // applies AgX plus the look transform three.js omits. This setting only
    // takes effect when drawing straight to the default framebuffer, i.e. the
    // no-post fallback path in `loop()` — it is deliberately kept in sync with
    // the pipeline so that fallback doesn't look wildly different.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.renderer.shadowMap.enabled = true;
    // PCF, not VSM. VSM makes `WebGLShadowMap.renderObject` draw every shadow
    // *receiver* into the depth map as well as every caster, which dragged ~900
    // objects (all terrain chunks, the whole crowd) into all cascades and cost
    // two extra full-screen blurs each. PCF is a hardware sampler2DShadow tap:
    // cheaper and far easier to bias. Note PCFSoftShadowMap is deprecated in
    // r185 and silently downgrades to this with a console warning.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;

    this.camera = new THREE.PerspectiveCamera(65, 1, 0.15, 4000);
    this.camera.position.set(0, 4, 10);

    this.currentScale = this.quality.renderScale;
    this.targetScale = this.quality.renderScale;
    this.maxScale = this.quality.renderScale;

    window.addEventListener('resize', this.handleResize);

    // A `window` resize event is not guaranteed. An embedded preview pane, a
    // devtools split, or any container-driven layout change can resize the
    // canvas without the window itself changing — which left the composer
    // rendering into a fraction of the canvas (a black L-shaped border).
    // Observe the element we actually draw into instead.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(container);
    }

    this.handleResize();

    // Context-loss resilience — a black canvas is the worst possible failure.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[Engine] WebGL context lost');
      this.stop();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[Engine] WebGL context restored');
      this.start();
    });
  }

  // -------------------------------------------------------------------------

  add(system: ISubsystem): void { this.subsystems.push(system); }

  remove(system: ISubsystem): void {
    const i = this.subsystems.indexOf(system);
    if (i >= 0) this.subsystems.splice(i, 1);
  }

  setRenderCallback(fn: (dt: number) => void): void { this.renderCallback = fn; }

  onResize(fn: (w: number, h: number) => void): void {
    this.resizeCallbacks.push(fn);
    const size = this.getSize();
    fn(size.width, size.height);
  }

  getSize(): { width: number; height: number } {
    // Measure the container we draw into, not the window. They agree for the
    // default full-screen layout, but the container is correct when the canvas
    // is embedded, letterboxed, or resized by something other than the window.
    const r = this.container?.getBoundingClientRect();
    const w = r && r.width > 0 ? r.width : window.innerWidth;
    const h = r && r.height > 0 ? r.height : window.innerHeight;
    return {
      width: Math.max(1, Math.floor(w)),
      height: Math.max(1, Math.floor(h)),
    };
  }

  setQuality(tier: QualityTier): void {
    this.quality = { ...QUALITY_PRESETS[tier] };
    this.targetScale = this.quality.renderScale;
    // A deliberate quality change re-opens the ceiling: the reversal ratchet is a
    // response to THIS tier's cost, so it must not outlive the tier that earned it.
    this.maxScale = this.quality.renderScale;
    this.reversals = 0;
    this.lastDir = 0;
    this.slowSince = -1;
    this.fastSince = -1;
    this.renderer.shadowMap.needsUpdate = true;
    bus.emit('quality:change', { tier });
    this.handleResize();
  }

  private handleResize = (): void => {
    const { width, height } = this.getSize();
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    for (const fn of this.resizeCallbacks) fn(width, height);
    for (const s of this.subsystems) s.resize?.(width, height);
  };

  // -------------------------------------------------------------------------

  async initAll(): Promise<void> {
    for (const s of this.subsystems) {
      if (s.init) await s.init();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private loop = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = clamp(rawDt, 0, MAX_FRAME_DT);

    this.ctx.dt = dt;
    this.ctx.elapsed += dt;
    this.ctx.frame++;

    // --- fixed-step physics -------------------------------------------------
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.accumulator -= FIXED_DT;
      steps++;
      for (const s of this.subsystems) s.fixedUpdate?.(this.ctx as FrameContext);
    }
    // Bleed off any leftover backlog so we don't spiral after a stall.
    if (this.accumulator > FIXED_DT * MAX_SUBSTEPS) this.accumulator = 0;
    this.ctx.alpha = this.accumulator / FIXED_DT;

    // --- variable-step visuals ---------------------------------------------
    for (const s of this.subsystems) s.update?.(this.ctx as FrameContext);

    // --- draw ---------------------------------------------------------------
    this.renderer.info.reset();
    if (this.renderCallback) this.renderCallback(dt);
    else this.renderer.render(this.scene, this.camera);

    this.trackPerformance(rawDt);
  };

  /**
   * Adaptive resolution.
   *
   * ==========================================================================
   *  THE BUG THIS USED TO HAVE: the first "we're slow" step made the frame
   *  2.3x MORE EXPENSIVE, and the controller could never get back.
   * ==========================================================================
   *  The constructor works out `fit`, the ratio that lands on a 1920x1080
   *  equivalent fill for whatever CSS size we got, and applies it. This method
   *  then recomputed the ratio from scratch as
   *
   *      min(devicePixelRatio, 2) * currentScale
   *
   *  which DROPS `fit` entirely. On a Retina 16" (1512x982 CSS, dpr 2):
   *
   *      boot           ratio 1.181  ->  2.07 Mpx   (exactly the budget)
   *      step to 0.90   ratio 1.800  ->  4.81 Mpx   (2.3x WORSE)
   *      step to 0.80   ratio 1.600  ->  3.80 Mpx
   *      step to 0.70   ratio 1.400  ->  2.91 Mpx
   *      step to 0.65   ratio 1.300  ->  2.51 Mpx   floor, still 1.21x budget
   *
   *  So detecting slowness made things worse for four consecutive steps and then
   *  settled permanently above budget, unable to return to the boot value. And
   *  recovery walked toward `renderScale = 1`, i.e. ratio 2.0 and 5.94 Mpx — the
   *  original oversized-backbuffer bug, reintroduced by the fix for it. The old
   *  comment in the constructor claiming adaptive resolution "does claw it back"
   *  was simply wrong.
   *
   *  The scale is now a multiplier on `baseRatio`, never on the raw display ratio.
   *
   * ==========================================================================
   *  AND IT LIMIT-CYCLED, which is worse than sitting at a lower resolution
   * ==========================================================================
   *  Observed: 1280x720 -> 1600x900 -> 1440x810 with SSAO, reflections and DOF
   *  toggling as it went. Two causes, both addressed:
   *
   *   - The old thresholds (11.5 / 15.5 ms) leave a 4 ms band that a frame
   *     sitting near 13 ms crosses on noise alone, and a single median reading
   *     was enough to act on. A verdict must now HOLD for its own window.
   *   - Every transition calls `handleResize` -> `composer.setSize`, which
   *     reallocates every render target in the chain (composer double buffer,
   *     7 bloom mips, SMAA edges + weights, SSAO, NormalPass, DoF, SubjectMask).
   *     The correction was itself a hitch, so correcting twice as often made the
   *     stutter worse rather than better.
   *
   *  Asymmetric on purpose: drop quickly when we are over budget, recover
   *  reluctantly. The reversal ratchet then caps the ceiling for the session
   *  after three direction changes, so a machine that genuinely sits on the
   *  boundary converges instead of hunting forever.
   */
  private trackPerformance(rawDt: number): void {
    const ms = rawDt * 1000;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    if (this.frameTimes.length < 30) return;

    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.fpsAverage = 1000 / Math.max(0.001, median);

    if (!this.adaptiveResolution) return;

    const now = this.ctx.elapsed;

    // Sustained-window bookkeeping. Cleared the moment the verdict stops holding,
    // so a 1.0 s window means one continuous second, not one second in total.
    if (median > SLOW_MS) { if (this.slowSince < 0) this.slowSince = now; } else this.slowSince = -1;
    if (median < FAST_MS) { if (this.fastSince < 0) this.fastSince = now; } else this.fastSince = -1;

    // Must stay BELOW RenderPipeline's own 2.5 s effect-settle, so the effect
    // ladder never moves while the resolution is still hunting.
    if (now - this.lastScaleChange < SCALE_COOLDOWN) return;

    let dir = 0;
    if (this.slowSince >= 0 && now - this.slowSince >= SLOW_HOLD && this.targetScale > SCALE_FLOOR) {
      dir = -1;
    } else if (this.fastSince >= 0 && now - this.fastSince >= FAST_HOLD && this.targetScale < this.maxScale) {
      dir = 1;
    }
    if (dir === 0) return;

    if (this.lastDir !== 0 && dir !== this.lastDir) {
      this.reversals++;
      // Third reversal: this machine is on the boundary. Nail the ceiling to
      // where we are so it stops oscillating for the rest of the session.
      if (this.reversals >= MAX_REVERSALS) this.maxScale = this.currentScale;
    }
    this.lastDir = dir;

    this.targetScale = dir < 0
      ? Math.max(SCALE_FLOOR, this.targetScale - 0.10)
      : Math.min(this.maxScale, this.targetScale + 0.05);
    this.lastScaleChange = now;
    this.slowSince = -1;
    this.fastSince = -1;

    if (Math.abs(this.currentScale - this.targetScale) <= 0.001) return;
    this.currentScale = this.targetScale;

    const ratio = this.baseRatio * this.currentScale;
    // A change too small to see is not worth reallocating the whole chain for.
    if (Math.abs(ratio - this.appliedRatio) < 0.05) return;
    this.appliedRatio = ratio;
    // No `max(1, ...)` here: dropping below 1 is the entire point of the scale.
    this.renderer.setPixelRatio(ratio);
    this.handleResize();
  }

  get frameContext(): FrameContext { return this.ctx as FrameContext; }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const s of this.subsystems) s.dispose?.();
    this.subsystems.length = 0;
    this.renderer.dispose();
  }
}
