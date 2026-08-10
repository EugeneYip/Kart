import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings, QualityTier } from './Types';
import { FIXED_DT, MAX_FRAME_DT, MAX_SUBSTEPS, QUALITY_PRESETS } from './Config';
import { bus } from './EventBus';
import { clamp } from './MathUtils';

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

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
   * Adaptive resolution: if we spend more than ~15 ms/frame for a sustained
   * window, drop internal resolution in 10 % steps down to 65 %; recover when
   * we're comfortably under 12 ms. Hysteresis + a 1.5 s cooldown stops it
   * oscillating visibly.
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
    if (this.ctx.elapsed - this.lastScaleChange < 1.5) return;

    if (median > 15.5 && this.targetScale > 0.65) {
      this.targetScale = Math.max(0.65, this.targetScale - 0.1);
      this.lastScaleChange = this.ctx.elapsed;
    } else if (median < 11.5 && this.targetScale < this.quality.renderScale) {
      this.targetScale = Math.min(this.quality.renderScale, this.targetScale + 0.05);
      this.lastScaleChange = this.ctx.elapsed;
    }

    if (Math.abs(this.currentScale - this.targetScale) > 0.001) {
      this.currentScale = this.targetScale;
      this.renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, 2) * this.currentScale,
      );
      this.handleResize();
    }
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
