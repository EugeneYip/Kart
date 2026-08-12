/**
 * ============================================================================
 *  VFX MANAGER — the whole effects layer behind one facade
 * ============================================================================
 *  Owns the sprite atlas, the LUTs, the particle engine and every effect
 *  module. Subscribes to the event bus and drives everything per frame.
 *
 *  Nothing outside this file needs to know a particle system exists: gameplay
 *  code calls `burst('explosion', p)` / `screenShake` / `flash`, the camera
 *  reads `shakeOffset` / `shakeRotation` / `desiredFovBoost`, and the post
 *  chain gets `setSpeedIntensity` forwarded to it.
 *
 *  Kart access is deliberately structural (`KartSource`): VFX must not depend
 *  on KartManager's internals, and it keeps working whether or not that module
 *  exposes `getSocket()` — see `socketPos()` for the fallback.
 *
 *  BUDGET: everything here is instanced (particles = 2 draw calls, flames = 1,
 *  trails = 1, decals = 1, overlay = 1) and the only per-frame CPU work is
 *  spawn writes plus a partial buffer upload. Emission rates are scaled by
 *  `throttle`, which drops as the pool fills, so a 12-kart pile-up degrades
 *  gracefully instead of blowing the frame budget.
 * ============================================================================
 */

import * as THREE from 'three';
import { SURFACES } from '@/core/Config';
import { bus } from '@/core/EventBus';
import { clamp01, damp, remap, smoothstep } from '@/core/MathUtils';
import {
  DriftStage, ItemType,
  type FrameContext, type ISubsystem, type IVfxService,
  type KartState, type QualitySettings, type SurfaceProperties, type SurfaceType,
} from '@/core/Types';

import { buildCurveTexture, buildRampTexture, buildSpriteAtlas, RAMP_ROWS } from './sprites/Atlas';
import { ParticleSystem, type KartSource, type VfxContext } from './ParticleSystem';
import { BoostFlame } from './BoostFlame';
import { Decals } from './Decals';
import { DriftSparks } from './DriftSparks';
import { ImpactEffects } from './ImpactEffects';
import { SpeedLines } from './SpeedLines';
import { SurfaceParticles } from './SurfaceParticles';
import { Trails } from './Trails';

/**
 * The slice of RenderPipeline this module uses. Structural on purpose — the
 * pipeline is another agent's file and is wired in late via `setPipeline`.
 */
export interface RenderPipelineLike {
  setSpeedIntensity?(v: number): void;
  flash?(color: THREE.ColorRepresentation, amount: number, seconds: number): void;
  addShake?(amount: number, seconds: number): void;
  /**
   * Optional: the pipeline's own full-resolution scene depth, as a texture that
   * is legal to read through a plain `sampler2D` (no comparison mode, NEAREST
   * filtered). If the pipeline provides this, soft particles come for FREE —
   * see `resolveDepthSource()`.
   *
   * ⚠️ **`RenderPipeline` deliberately does NOT implement this, and it should
   * stay that way.** The only depth texture the post chain owns is the one
   * attached to `EffectComposer`'s input buffer, and the particles draw *inside*
   * the RenderPass that writes it. Binding it would be a framebuffer/texture
   * feedback loop — undefined results, plus
   * `GL_INVALID_OPERATION: Feedback loop formed between Framebuffer and active
   * Texture` on every particle draw, which is a *different* error from the
   * sampler-type flood but just as loud. Anyone tempted to wire this needs a
   * depth copy first, and a copy is a full-screen pass, which is most of what the
   * prepass below already costs.
   */
  sceneDepthTexture?(): THREE.Texture | null;
}

interface ShakeImpulse {
  amp: number;
  left: number;
  dur: number;
  freq: number;
}

const SHAKE_SLOTS = 8;
const MAX_SHAKE_OFFSET = 0.30;   // metres
const MAX_SHAKE_ROT = 0.055;     // radians

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class VfxManager implements IVfxService, ISubsystem {
  // --- read by ChaseCamera (feature-detected there, so they must always exist)
  readonly shakeOffset = new THREE.Vector3();
  readonly shakeRotation = new THREE.Euler();

  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly src: KartSource;
  private readonly quality: QualitySettings;

  readonly root: THREE.Group;

  private particles!: ParticleSystem;
  private drift!: DriftSparks;
  private flames!: BoostFlame;
  private surface!: SurfaceParticles;
  private trails!: Trails;
  private decals!: Decals;
  private impacts!: ImpactEffects;
  private overlay!: SpeedLines;

  private atlasTex: THREE.Texture | null = null;
  private rampTex: THREE.DataTexture | null = null;
  private curveTex: THREE.DataTexture | null = null;

  private ctx!: VfxContext;
  private pipeline: RenderPipelineLike | null = null;
  private unsubscribe: Array<() => void> = [];
  private initialised = false;
  private disposed = false;

  // --- shake ---
  private shakes: ShakeImpulse[] = [];
  private trauma = 0;
  private rumble = 0;
  private shakePhase = 0;

  // --- speed ---
  private speedAuto = 0;
  private speedOverride = 0;
  private speedOverrideLeft = 0;

  // --- depth prepass (soft particles against geometry) ---
  private depthRT: THREE.WebGLRenderTarget | null = null;
  private depthMat: THREE.MeshBasicMaterial | null = null;
  private depthEnabled = false;
  private depthFailed = false;

  private bufWidth = 1920;
  private bufHeight = 1080;

  /** Rolling CPU cost of update(), milliseconds. */
  cpuMs = 0;

  private warned = new Set<string>();

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    karts: KartSource,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.src = karts;
    this.quality = quality;

    this.root = new THREE.Group();
    this.root.name = 'vfx';
    this.root.matrixAutoUpdate = false;
    this.root.frustumCulled = false;
    scene.add(this.root);

    for (let i = 0; i < SHAKE_SLOTS; i++) {
      this.shakes.push({ amp: 0, left: 0, dur: 1, freq: 24 });
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Idempotent: Game awaits this, then Engine.initAll() calls it again. */
  async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;

    this.atlasTex = buildSpriteAtlas(this.quality);
    // Yield so a 16-cell canvas atlas doesn't stall the boot progress bar.
    await Promise.resolve();
    this.rampTex = buildRampTexture();
    this.curveTex = buildCurveTexture();
    await Promise.resolve();

    this.particles = new ParticleSystem(
      this.root, this.camera, this.quality,
      this.atlasTex, this.rampTex, this.curveTex,
    );

    const self = this;
    this.ctx = {
      scene: this.scene,
      camera: this.camera,
      quality: this.quality,
      particles: this.particles,
      root: this.root,
      time: 0,
      dt: 1 / 60,
      throttle: 1,
      shake(amount: number, seconds: number) { self.screenShake(amount, seconds); },
      flash(color: THREE.ColorRepresentation, amount: number, seconds: number) {
        self.flash(color, amount, seconds);
      },
    };

    this.overlay = new SpeedLines(this.ctx);
    this.decals = new Decals(this.ctx, this.src);
    this.surface = new SurfaceParticles(this.ctx, this.src);
    this.drift = new DriftSparks(this.ctx, this.src);
    this.flames = new BoostFlame(this.ctx, this.src, this.rampTex, RAMP_ROWS);
    this.trails = new Trails(this.ctx, this.src, this.rampTex, RAMP_ROWS);
    this.impacts = new ImpactEffects(this.ctx, this.src, this.surface, this.decals, this.overlay);

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.bufWidth = Math.max(1, size.x);
    this.bufHeight = Math.max(1, size.y);
    this.overlay.resize(this.bufWidth, this.bufHeight);

    // Depth-buffer soft particles are OFF by default on every tier, including
    // ultra. `renderDepthPrepass()` re-renders the WHOLE scene a second time
    // (full traversal, full draw-call submission — measured at hundreds of
    // extra calls and millions of extra triangles per frame) purely to soften
    // particle edges, and that is nowhere near worth it: the analytic ground
    // fade already handles the case that actually matters — dust and smoke
    // intersecting the road — exactly, for free, and on every tier. What the
    // depth pass adds on top is softening against *vertical* geometry, which
    // is both rarer and far less noticeable.
    //
    // The effect can come back for free the moment the render pipeline exposes
    // its own depth via `RenderPipelineLike.sceneDepthTexture()`; see
    // `resolveDepthSource()`, which prefers that path automatically. Until
    // then `setDepthPrepass(true)` still works for A/B experiments.
    this.setDepthPrepass(false);

    this.subscribe();

    // Warm the shaders so the first drift doesn't hitch.
    this.renderer.compile(this.scene, this.camera);
  }

  setPipeline(p: RenderPipelineLike | null): void {
    this.pipeline = p;
  }

  // =========================================================================
  // IVfxService
  // =========================================================================

  /**
   * Named one-shot. Unknown ids fall back to a generic impact so a caller
   * inventing a name never produces a silent nothing.
   *
   *   explosion bigExplosion impact hit sparks shellBreak greenShell redShell
   *   bananaSplat banana slip spinout squash respawn dust smoke surfacePuff
   *   land wallHit kartHit itemBox coin star starPop starHit rainbow
   *   bulletLaunch lightning ink squid boost boostPop driftTier trick
   *   confetti lap finish countdown go ghost flash
   */
  burst(id: string, position: THREE.Vector3, normal?: THREE.Vector3, scale = 1): void {
    if (!this.initialised || this.disposed) return;
    const n = normal ?? null;
    const s = scale > 0 ? scale : 1;

    switch (id) {
      case 'explosion': this.impacts.explosion(position, n, s); break;
      case 'bigExplosion': this.impacts.explosion(position, n, s * 1.6); break;

      case 'impact':
      case 'hit': this.impacts.impact(position, n, s); break;
      case 'sparks': this.impacts.sparks(position, n, s); break;

      case 'shellBreak': this.impacts.shellBreak(position, n, s, 0xbfe8ff); break;
      case 'greenShell': this.impacts.shellBreak(position, n, s, 0x8cff6a); break;
      case 'redShell': this.impacts.shellBreak(position, n, s, 0xff5a44); break;

      case 'banana':
      case 'bananaSplat': this.impacts.bananaSplat(position, n, s); break;
      case 'slip': this.impacts.slip(position, s); break;
      case 'spinout': this.impacts.spinout(position, s); break;
      case 'squash': this.impacts.squash(position, s); break;
      case 'respawn':
      case 'ghost': this.impacts.respawn(position, s); break;

      case 'dust': this.impacts.dust(position, n, s); break;
      case 'smoke': this.impacts.smoke(position, s); break;
      case 'surfacePuff':
        this.surface.puff(this.playerSurfaceFamily(), position, n ?? UP, s);
        break;

      case 'land': this.impacts.land(position, clamp01(s), this.playerSurfaceFamily(), false); break;
      case 'wallHit': this.impacts.wallHit(position, n ?? UP, clamp01(s), false); break;
      case 'kartHit': this.impacts.kartHit(position, n, clamp01(s), false); break;

      case 'itemBox': this.impacts.itemBox(position, s); break;
      case 'coin': this.impacts.coin(position, s); break;
      case 'star':
      case 'starHit': this.impacts.starHit(position, s); break;
      case 'starPop': this.impacts.starPop(position, s); break;
      case 'bulletLaunch': this.impacts.bulletLaunch(position, n, s); break;
      case 'lightning': this.impacts.lightning(position, s, -1); break;
      case 'ink':
      case 'squid': this.impacts.ink(position, s, false); break;

      case 'boost':
      case 'boostPop': {
        tmpA.set(0, 0, -1);
        const k = this.playerKart();
        if (k) tmpA.set(0, 0, -1).applyQuaternion(k.quaternion);
        this.flames.popAt(position, n ?? tmpA, s >= 1.3 ? 'ultra' : 'mushroom', s);
        break;
      }
      case 'driftTier': this.drift.tierBurstAt(position, Math.round(s), null, 1); break;

      case 'trick': this.impacts.trick(position, s); break;
      case 'confetti':
      case 'lap':
      case 'finish': this.impacts.confetti(position, s); break;
      case 'countdown': this.impacts.countdownFlare(position, 1); break;
      case 'go': this.impacts.countdownFlare(position, 0); break;
      case 'flash': this.flash(0xffffff, clamp01(s), 0.18); break;

      default:
        if (!this.warned.has(id)) {
          this.warned.add(id);
          console.warn(`[Vfx] unknown burst id "${id}" — using generic impact`);
        }
        this.impacts.impact(position, n, s);
        break;
    }
  }

  screenShake(amount: number, seconds: number): void {
    const amp = clamp01(amount);
    if (amp <= 0.001 || seconds <= 0) return;

    // Take the slot with the least energy left; a big hit always lands.
    let worst = 0;
    let worstEnergy = Infinity;
    for (let i = 0; i < SHAKE_SLOTS; i++) {
      const s = this.shakes[i];
      const e = s.amp * s.left;
      if (e < worstEnergy) { worstEnergy = e; worst = i; }
    }
    const slot = this.shakes[worst];
    if (amp * seconds < worstEnergy) return;
    slot.amp = amp;
    slot.dur = Math.max(0.03, seconds);
    slot.left = slot.dur;
    // Short sharp hits rattle faster than long rumbles.
    slot.freq = 34 - Math.min(18, seconds * 22);

    // RenderPipeline subscribes to this event and applies its own image-space
    // shake, so emitting is the forwarding — calling addShake() as well would
    // double it.
    bus.emit('camera:shake', { amount: amp, seconds });
  }

  setSpeedIntensity(v: number): void {
    this.speedOverride = clamp01(v);
    this.speedOverrideLeft = 0.5;
  }

  flash(color: THREE.ColorRepresentation, amount: number, seconds: number): void {
    if (!this.initialised || this.disposed) return;
    const amt = clamp01(amount);
    if (amt <= 0.002) return;
    if (this.pipeline?.flash) {
      this.pipeline.flash(color, amt, seconds);
      // Half strength in-scene as well: it lands before bloom, so it flares.
      this.overlay.flash(color, amt * 0.5, seconds);
    } else {
      this.overlay.flash(color, amt, seconds);
    }
  }

  /** Degrees of extra FOV the chase camera should adopt. */
  get desiredFovBoost(): number {
    return this.initialised ? this.overlay.fovBoost : 0;
  }

  // =========================================================================
  // Frame
  // =========================================================================

  update(ctx: FrameContext): void {
    if (!this.initialised || this.disposed) return;
    const t0 = performance.now();
    const dt = ctx.dt > 0.1 ? 0.1 : ctx.dt;

    const c = this.ctx;
    c.time = ctx.elapsed;
    c.dt = dt;

    // --- spawn throttle ----------------------------------------------------
    // Back off emission as the pool fills so long effects (smoke columns) are
    // never starved by short ones (dust).
    const load = this.particles.alive / Math.max(1, this.particles.capacity);
    c.throttle = load < 0.6 ? 1 : clamp01(1 - (load - 0.6) / 0.35);

    // --- world effects -----------------------------------------------------
    this.surface.update();
    this.drift.update();
    this.flames.update();
    this.trails.update();
    this.decals.update();
    this.impacts.update();

    // --- screen effects ----------------------------------------------------
    this.updateSpeed(dt);
    this.overlay.update();
    this.pipeline?.setSpeedIntensity?.(this.overlay.intensity);

    // --- simulate + upload -------------------------------------------------
    this.particles.update(c.time, dt);

    this.updateShake(dt);
    this.resolveDepthSource();

    this.cpuMs = damp(this.cpuMs, performance.now() - t0, 0.25, dt);
  }

  private updateSpeed(dt: number): void {
    const k = this.playerKart();
    let base = 0;
    let boost = 0;

    if (k) {
      // Streaks only start to appear near the top of the speed range.
      base = smoothstep(remap(clamp01(k.speedRatio), 0.70, 1.02, 0, 1));
      if (k.boostTime > 0) {
        boost = clamp01(0.55 + 0.45 * Math.min(1.6, k.boostStrength || 1));
      }
      if (k.starTime > 0) boost = Math.max(boost, 0.45);

      // Continuous rumble from the surface under the wheels.
      const props: SurfaceProperties | undefined = SURFACES[k.surface];
      const rough = props ? props.roughness : 0;
      const speedF = clamp01(Math.abs(k.speed) / 22);
      let target = rough * speedF * 0.42;
      if (k.boostTime > 0) target += 0.05;
      if (!k.grounded) target = 0;
      this.rumble = damp(this.rumble, target, 0.08, dt);
    } else {
      this.rumble = damp(this.rumble, 0, 0.08, dt);
    }

    // Plain top speed only hints at streaks; boost is what makes them bite.
    // (MK8 barely shows lines at full speed and buries the screen on a mushroom.)
    this.speedAuto = Math.max(base * 0.5, boost * 0.9);

    if (this.speedOverrideLeft > 0) {
      this.speedOverrideLeft -= dt;
      this.overlay.set(Math.max(this.speedAuto, this.speedOverride), boost);
    } else {
      this.overlay.set(this.speedAuto, boost);
    }
  }

  /**
   * Trauma-driven shake. Impulses sum, decay quadratically (so a hit lands hard
   * and settles softly), and drive an offset + a rotation on three different
   * frequencies so it never reads as a single sine wave.
   */
  private updateShake(dt: number): void {
    let trauma = this.rumble;
    let freq = 22;
    let weight = this.rumble;

    for (let i = 0; i < SHAKE_SLOTS; i++) {
      const s = this.shakes[i];
      if (s.left <= 0) continue;
      s.left -= dt;
      if (s.left <= 0) { s.left = 0; s.amp = 0; continue; }
      const k = s.left / s.dur;
      const e = s.amp * k * k;
      trauma += e;
      freq += s.freq * e;
      weight += e;
    }
    if (weight > 1e-4) freq = freq / weight * 0.5 + 11;

    this.trauma = trauma > 1.4 ? 1.4 : trauma;
    this.shakePhase += dt * freq;

    const p = this.shakePhase;
    const a = this.trauma;
    if (a < 1e-4) {
      this.shakeOffset.set(0, 0, 0);
      this.shakeRotation.set(0, 0, 0);
      return;
    }

    // Three incommensurable frequencies per axis — no visible periodicity.
    const ox = Math.sin(p * 1.00) * 0.6 + Math.sin(p * 2.31 + 1.7) * 0.3 + Math.sin(p * 4.77) * 0.1;
    const oy = Math.sin(p * 1.27 + 2.1) * 0.6 + Math.sin(p * 2.93) * 0.3 + Math.sin(p * 5.31 + 0.4) * 0.1;
    const oz = Math.sin(p * 0.83 + 4.2) * 0.6 + Math.sin(p * 2.11 + 3.3) * 0.3;

    const amp = a * a;
    this.shakeOffset.set(
      ox * amp * MAX_SHAKE_OFFSET,
      oy * amp * MAX_SHAKE_OFFSET * 0.75,
      oz * amp * MAX_SHAKE_OFFSET * 0.4,
    );
    this.shakeRotation.set(
      oy * amp * MAX_SHAKE_ROT * 0.7,
      ox * amp * MAX_SHAKE_ROT * 0.5,
      oz * amp * MAX_SHAKE_ROT,
    );
  }

  // =========================================================================
  // Soft particles against scene geometry
  // =========================================================================

  /**
   * Half-resolution depth-only prepass. The particle shader fades against it,
   * so smoke dissolves into walls and karts instead of slicing through them.
   *
   * It runs from `update()`, which means it sees the camera one frame late (the
   * chase camera updates after VFX). That is a uniform depth bias of a few
   * centimetres of camera travel, invisible in the fade — and far cheaper than
   * re-entering the renderer mid-frame.
   *
   * ---------------------------------------------------------------------------
   *  CLEARED: this is NOT the `GL_INVALID_OPERATION: Mismatch between texture
   *  format and sampler type` flood.
   * ---------------------------------------------------------------------------
   *  HANDOFF.md item 2 / P0e-E5 named the `DepthTexture` handed to
   *  `ParticleSystem.setDepthTexture()` — the lines just below — as the prime
   *  suspect. Three independent reasons it cannot be, all checkable without a
   *  browser:
   *
   *   1. **It never runs.** `init()` calls `setDepthPrepass(false)` on every
   *      tier, so `depthEnabled` is false, `depthRT` is null, and
   *      `resolveDepthSource()` takes the `setDepthTexture(null, 1, 1)` branch.
   *      A null `sampler2D` uniform is bound to three's `emptyTexture`, which is
   *      a perfectly legal RGBA 2-D texture.
   *   2. **The texture it would build is valid anyway.** DepthFormat +
   *      UnsignedIntType (DEPTH_COMPONENT24), NEAREST/NEAREST, `compareFunction`
   *      explicitly null. `renderDepthPrepass()` re-checks `compareFunction`
   *      after the render and falls back to the analytic ground fade rather than
   *      binding anything questionable — which is the fallback HANDOFF asks for.
   *   3. **A full static audit of the live scene finds nothing.**
   *      `.probe-tmp/samplers.ts` builds Lighting + Track + Environment + Karts +
   *      VFX + Items and compares every GLSL sampler declaration against the
   *      texture actually bound to it — including every `onBeforeCompile`-injected
   *      `uniform sampler2D`, replayed against three's real ShaderLib source.
   *      All three circuits: 249/155, 259/171 and 249/167 materials and textures
   *      on neon, coastal and volcano. **0 mismatches.**
   *
   *  What it actually was: a null entry in `sampler2DShadow
   *  directionalShadowMap[]` during the first two frames of every boot. See
   *  `RenderPipeline.warmShadowMaps()` for the mechanism and the fix.
   */
  setDepthPrepass(enabled: boolean): void {
    if (this.depthFailed) return;
    if (enabled === this.depthEnabled) return;
    this.depthEnabled = enabled;

    if (!enabled) {
      this.particles?.setDepthTexture(null, 1, 1);
      this.disposeDepthRT();
      return;
    }
    this.buildDepthRT();
  }

  get depthPrepassEnabled(): boolean { return this.depthEnabled && this.depthRT !== null; }

  private buildDepthRT(): void {
    this.disposeDepthRT();
    const w = Math.max(2, Math.floor(this.bufWidth * 0.5));
    const h = Math.max(2, Math.floor(this.bufHeight * 0.5));
    try {
      // The particle shader reads this through a plain `sampler2D`, so the
      // texture must satisfy three things or every draw of that program fails
      // WebGL validation with
      //   GL_INVALID_OPERATION: Mismatch between texture format and sampler
      //   type (signed/unsigned/float/shadow)
      //   1. a depth format/type pair that is self-consistent. DepthFormat +
      //      UnsignedIntType is DEPTH_COMPONENT24, which samples as float
      //      through `sampler2D` — verified valid on this GL backend.
      //   2. NEAREST min/mag. A depth attachment is not linearly filterable.
      //   3. NO comparison mode. This is the one that actually bites: three
      //      sets TEXTURE_COMPARE_MODE=COMPARE_REF_TO_TEXTURE whenever
      //      `compareFunction` is non-null (WebGLTextures.setTextureParameters)
      //      and never clears it again, and a compare-mode depth texture
      //      REQUIRES `sampler2DShadow`. Keep it explicitly null.
      const depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      depthTexture.format = THREE.DepthFormat;
      depthTexture.compareFunction = null;
      depthTexture.minFilter = THREE.NearestFilter;
      depthTexture.magFilter = THREE.NearestFilter;
      depthTexture.generateMipmaps = false;
      depthTexture.name = 'vfx-scene-depth';
      this.depthRT = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: true,
        stencilBuffer: false,
        depthTexture,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
      });
      this.depthRT.texture.name = 'vfx-depth-prepass';
      // Colour is never read; skip the shading entirely.
      this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    } catch (err) {
      console.warn('[Vfx] depth prepass unavailable, using analytic ground fade only', err);
      this.depthFailed = true;
      this.depthEnabled = false;
      this.disposeDepthRT();
    }
  }

  private disposeDepthRT(): void {
    this.depthRT?.depthTexture?.dispose();
    this.depthRT?.dispose();
    this.depthRT = null;
    this.depthMat?.dispose();
    this.depthMat = null;
  }

  /**
   * Choose where the soft-particle depth fade reads from, cheapest first:
   *
   *   1. the render pipeline's own scene depth — FREE, nothing extra rendered
   *   2. our own half-res depth prepass — only when explicitly enabled, and it
   *      costs a whole extra scene render
   *   3. nothing — the analytic ground fade in the vertex shader carries it,
   *      which is the default and is what actually matters visually
   */
  private resolveDepthSource(): void {
    const fromPipeline = this.pipeline?.sceneDepthTexture?.() ?? null;
    if (fromPipeline) {
      // Same rule as our own depth texture: a comparison mode would make this
      // illegal to read through the shader's plain `sampler2D`. `compareFunction`
      // only exists on DepthTexture, so probe it structurally — a plain colour
      // texture (no such field) is fine to sample.
      const cmp = (fromPipeline as { compareFunction?: unknown }).compareFunction;
      if (cmp === null || cmp === undefined) {
        this.particles.setDepthTexture(fromPipeline, this.bufWidth, this.bufHeight);
        return;
      }
      if (!this.warned.has('pipeline-depth-compare')) {
        this.warned.add('pipeline-depth-compare');
        console.warn(
          '[Vfx] pipeline scene depth has a comparison mode set and cannot be '
          + 'sampled as sampler2D; falling back to the analytic ground fade.',
        );
      }
    }

    if (this.depthEnabled) {
      this.renderDepthPrepass();
      return;
    }

    this.particles.setDepthTexture(null, 1, 1);
  }

  private renderDepthPrepass(): void {
    const rt = this.depthRT;
    if (!this.depthEnabled || !rt || !this.depthMat) return;
    // Only pay for it when there is actually something to fade.
    if (this.particles.alive < 24) {
      this.particles.setDepthTexture(null, 1, 1);
      return;
    }

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.shadowMap.autoUpdate;
    const prevNeeds = r.shadowMap.needsUpdate;
    const prevOverride = this.scene.overrideMaterial;
    const prevVisible = this.root.visible;

    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = false;
    this.scene.overrideMaterial = this.depthMat;
    this.root.visible = false;

    try {
      r.setRenderTarget(rt);
      r.render(this.scene, this.camera);
      // Bind the texture that is *actually* this target's depth attachment, and
      // only while it is still legal to read through a plain `sampler2D`. If
      // anything ever puts a comparison mode on it, sampling it as `sampler2D`
      // would fail validation on every particle draw — so drop the depth fade
      // and keep the analytic ground fade rather than flooding the driver.
      const depthTex = rt.depthTexture;
      if (depthTex && depthTex.compareFunction === null) {
        this.particles.setDepthTexture(depthTex, this.bufWidth, this.bufHeight);
      } else {
        this.particles.setDepthTexture(null, 1, 1);
        this.depthFailed = true;
        this.depthEnabled = false;
        if (!this.warned.has('depth-compare')) {
          this.warned.add('depth-compare');
          console.warn(
            '[Vfx] scene depth texture is not sampler2D-compatible; soft-particle '
            + 'depth fade disabled (analytic ground fade still active).',
          );
        }
      }
    } catch (err) {
      console.warn('[Vfx] depth prepass failed, disabling', err);
      this.depthFailed = true;
      this.depthEnabled = false;
      this.particles.setDepthTexture(null, 1, 1);
    } finally {
      this.scene.overrideMaterial = prevOverride;
      this.root.visible = prevVisible;
      r.shadowMap.autoUpdate = prevAuto;
      r.shadowMap.needsUpdate = prevNeeds;
      r.setRenderTarget(prevTarget);
    }
  }

  // =========================================================================
  // Events
  // =========================================================================

  private kartById(id: number): KartState | null {
    const karts = this.src.karts;
    if (!karts) return null;
    for (let i = 0; i < karts.length; i++) if (karts[i].id === id) return karts[i];
    return null;
  }

  private playerKart(): KartState | null {
    const p = this.src.player;
    if (p) return p;
    const karts = this.src.karts;
    if (!karts) return null;
    for (let i = 0; i < karts.length; i++) if (karts[i].isPlayer) return karts[i];
    return null;
  }

  private isPlayer(kartId: number): boolean {
    const k = this.kartById(kartId);
    return k ? k.isPlayer : false;
  }

  private familyOf(surface: SurfaceType): SurfaceProperties['particle'] {
    const props: SurfaceProperties | undefined = SURFACES[surface];
    return props ? props.particle : 'dust';
  }

  private playerSurfaceFamily(): SurfaceProperties['particle'] {
    const k = this.playerKart();
    const fam = k ? this.familyOf(k.surface) : 'dust';
    return fam === 'none' ? 'dust' : fam;
  }

  /** A point roughly in front of the player, for camera-facing flourishes. */
  private focusPoint(out: THREE.Vector3): THREE.Vector3 {
    const k = this.playerKart();
    if (k) {
      out.set(0, 1.6, -6).applyQuaternion(k.quaternion).add(k.position);
      return out;
    }
    return out.set(0, 0, -10).applyQuaternion(this.camera.quaternion).add(this.camera.position);
  }

  private subscribe(): void {
    const on = <T>(fn: () => () => void): void => { this.unsubscribe.push(fn()); void (0 as unknown as T); };
    void on;

    this.unsubscribe.push(
      // --- karts ----------------------------------------------------------
      bus.on('kart:hop', ({ kartId, position }) => {
        const fam = this.familyOf(this.kartById(kartId)?.surface ?? 0);
        if (fam !== 'none') this.surface.puff(fam, position, UP, 0.45);
      }),

      bus.on('kart:land', ({ kartId, position, impact }) => {
        const k = this.kartById(kartId);
        this.impacts.land(
          position, clamp01(impact), this.familyOf(k?.surface ?? 0), k?.isPlayer ?? false,
        );
      }),

      bus.on('kart:driftTier', ({ kartId, tier, position }) => {
        const k = this.kartById(kartId);
        // The event may carry a DriftStage (2..4) or a 1-based tier — both map
        // onto the 0-based blue/orange/purple index.
        const t = tier >= DriftStage.Blue ? tier - DriftStage.Blue : tier - 1;
        const idx = t < 0 ? 0 : t > 2 ? 2 : t;
        if (k) this.drift.tierBurst(k, idx);
        else this.drift.tierBurstAt(position, idx, null, 1);
        this.flash(
          idx === 0 ? 0x9fd8ff : idx === 1 ? 0xffc266 : 0xdca0ff,
          k?.isPlayer ? 0.05 + idx * 0.03 : 0, 0.14,
        );
      }),

      bus.on('kart:boost', ({ kartId, duration, source }) => {
        const k = this.kartById(kartId);
        if (!k) return;
        this.flames.onBoost(k, duration, source);
        if (k.isPlayer) {
          const big = duration >= 1.2 || source === 'start' || source === 'pad';
          this.overlay.impactFrame(big ? 0.75 : 0.35);
        }
      }),

      bus.on('kart:trick', ({ kartId }) => {
        const k = this.kartById(kartId);
        if (k) this.impacts.trick(k.position, 1);
      }),

      bus.on('kart:spinout', ({ position }) => this.impacts.spinout(position, 1)),

      bus.on('kart:squash', ({ kartId }) => {
        const k = this.kartById(kartId);
        if (k) this.impacts.squash(k.position, 1);
      }),

      bus.on('kart:respawn', ({ kartId }) => {
        const k = this.kartById(kartId);
        if (k) this.impacts.respawn(k.position, 1);
      }),

      bus.on('kart:wallHit', ({ kartId, position, impact, normal }) => {
        this.impacts.wallHit(position, normal, clamp01(impact), this.isPlayer(kartId));
      }),

      bus.on('kart:kartHit', ({ a, b, impact, position }) => {
        const ka = this.kartById(a);
        const kb = this.kartById(b);
        let n: THREE.Vector3 | null = null;
        if (ka && kb) {
          tmpB.copy(kb.position).sub(ka.position);
          if (tmpB.lengthSq() > 1e-5) n = tmpB.normalize();
        }
        this.impacts.kartHit(
          position, n, clamp01(impact),
          (ka?.isPlayer ?? false) || (kb?.isPlayer ?? false),
        );
      }),

      bus.on('kart:surfaceChange', ({ kartId, to }) => {
        const k = this.kartById(kartId);
        if (!k) return;
        const fam = this.familyOf(to as SurfaceType);
        if (fam === 'none') return;
        tmpA.copy(k.position).y -= 0.32;
        this.surface.puff(fam, tmpA, UP, 0.7);
      }),

      // --- items ----------------------------------------------------------
      bus.on('item:box', ({ position }) => this.impacts.itemBox(position, 1)),

      bus.on('item:used', ({ kartId, item }) => {
        const k = this.kartById(kartId);
        if (!k) return;
        if (item === ItemType.Star) this.impacts.starPop(k.position, 1.3);
        else if (item === ItemType.Lightning) this.impacts.trick(k.position, 1.2);
        else if (item === ItemType.Coin) this.impacts.coin(k.position, 0.8);
      }),

      bus.on('item:hit', ({ targetId, item, point }) => {
        const k = this.kartById(targetId);
        this.impacts.itemHit(item, point ?? k?.position ?? tmpA.set(0, 0, 0),
          k?.isPlayer ?? false, targetId);
      }),

      // --- race flow ------------------------------------------------------
      bus.on('race:countdown', ({ count }) => {
        this.impacts.countdownFlare(this.focusPoint(tmpA), count);
      }),

      bus.on('race:start', ({ rocketStart }) => {
        this.impacts.countdownFlare(this.focusPoint(tmpA), 0);
        if (rocketStart) {
          const k = this.playerKart();
          if (k) {
            tmpB.set(0, 0, -1).applyQuaternion(k.quaternion);
            this.flames.popAt(k.position, tmpB, 'ultra', 1.2);
          }
        }
      }),

      bus.on('race:lap', ({ kartId, isBest }) => {
        const k = this.kartById(kartId);
        if (!k || !k.isPlayer) return;
        this.impacts.confetti(k.position, isBest ? 1.2 : 0.8);
        if (isBest) this.flash(0xfff0a0, 0.16, 0.22);
      }),

      bus.on('race:finish', ({ kartId, position }) => {
        const k = this.kartById(kartId);
        if (!k || !k.isPlayer) return;
        this.impacts.confetti(k.position, position <= 3 ? 1.6 : 1.0);
        this.flash(0xffffff, 0.3, 0.3);
      }),

      bus.on('quality:change', () => {
        // The pools are sized at init, so there is nothing to rebuild here.
        //
        // This deliberately does NOT re-enable the depth prepass on ultra. It
        // used to (`setDepthPrepass(tier === 'ultra')`), which quietly undid the
        // decision documented at the end of init(): the prepass re-renders the
        // ENTIRE scene a second time every frame purely to soften particle
        // edges, and it is also the prime suspect for the
        // `GL_INVALID_OPERATION: Mismatch between texture format and sampler
        // type` flood (binding a depth attachment to a plain sampler2D). Any
        // quality change — including the automatic ones — would silently switch
        // both costs back on. The analytic ground fade covers the case that
        // matters, and `setDepthPrepass(true)` still exists for A/B runs.
      }),
    );
  }

  // =========================================================================
  // Housekeeping
  // =========================================================================

  resize(width: number, height: number): void {
    if (!this.initialised) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.bufWidth = Math.max(1, Math.round(size.x) || width);
    this.bufHeight = Math.max(1, Math.round(size.y) || height);
    this.overlay.resize(this.bufWidth, this.bufHeight);
    if (this.depthEnabled) this.buildDepthRT();
  }

  /** Race restart: drop every live effect without rebuilding anything. */
  clear(): void {
    if (!this.initialised) return;
    this.particles.clear();
    this.trails.clear();
    this.decals.clear();
    this.impacts.clear();
    this.overlay.clear();
    for (const s of this.shakes) { s.amp = 0; s.left = 0; }
    this.trauma = 0;
    this.rumble = 0;
    this.shakeOffset.set(0, 0, 0);
    this.shakeRotation.set(0, 0, 0);
  }

  /** Debug read-out for the perf HUD and the dev harness. */
  getStats(): {
    particles: number; gpu: number; cpu: number; capacity: number;
    decals: number; ribbons: number; cpuMs: number; throttle: number;
    depthPrepass: boolean;
  } {
    if (!this.initialised) {
      return {
        particles: 0, gpu: 0, cpu: 0, capacity: 0, decals: 0,
        ribbons: 0, cpuMs: 0, throttle: 1, depthPrepass: false,
      };
    }
    return {
      particles: this.particles.alive,
      gpu: this.particles.aliveGpu,
      cpu: this.particles.aliveCpu,
      capacity: this.particles.capacity,
      decals: this.decals.count,
      ribbons: this.trails.activeCount,
      cpuMs: this.cpuMs,
      throttle: this.ctx.throttle,
      depthPrepass: this.depthPrepassEnabled,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];

    this.impacts?.dispose();
    this.overlay?.dispose();
    this.trails?.dispose();
    this.flames?.dispose();
    this.drift?.dispose();
    this.surface?.dispose();
    this.decals?.dispose();
    this.particles?.dispose();

    this.disposeDepthRT();
    this.atlasTex?.dispose();
    this.rampTex?.dispose();
    this.curveTex?.dispose();
    this.atlasTex = null;
    this.rampTex = null;
    this.curveTex = null;

    this.root.removeFromParent();
  }
}
