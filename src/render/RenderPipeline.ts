/**
 * ============================================================================
 *  APEX KART — RENDER PIPELINE
 * ============================================================================
 *  Owns the post-processing chain and is the only thing that touches the
 *  EffectComposer. Everything is HalfFloat so bloom and AgX have real HDR
 *  headroom.
 *
 *  Pass order (each line is one full-screen pass unless noted):
 *
 *    1  RenderPass                 scene -> HDR half-float buffer     14.2 ms
 *    2  NormalPass                 half-res view normals for SSAO      4.6 ms
 *    3  SSAO                       multiply, half-res                 3.1 ms
 *    4  Depth of field             boost only; skipped below ~25 %     0
 *    5  Motion blur                skipped when the camera is still    0
 *    6  Bloom -> Look -> Vignette  (merged: one pass, three effects)   3.6 ms
 *    7  Chromatic aberration       auto-disabled when the offset is ~0 0
 *    8  SMAA                       always last, always enabled         5.4 ms
 *
 *  Milliseconds are medians measured with EXT_disjoint_timer_query_webgl2 at
 *  1600x900 on the ultra tier — see `PostQA.gpuCost()`. Post-only total ~17 ms
 *  after removing DepthDownsamplingPass (was ~22 ms).
 *
 *  Exactly TWO full-scene renders originate here: RenderPass and, when SSAO is
 *  on, NormalPass. Everything else is a full-screen quad. Nothing in the chain
 *  re-renders the scene a third time.
 *
 *  Why the split: postprocessing refuses to merge two convolution effects into
 *  one pass, and bloom/CA/SMAA each sample the *pass input*, so merging them
 *  would make bloom fringe green and CA ignore the grade. The merged pass is
 *  the effects that legitimately chain on the running colour.
 *
 *  Tone mapping lives inside GradeEffect rather than a separate
 *  ToneMappingEffect — see the header of GradeEffect.ts for why (three's AgX
 *  omits the look transform, which is exactly what made the frame milky).
 *
 *  The chain is rebuilt (not mutated) when the quality tier changes, because
 *  postprocessing only marks the array's last pass as `renderToScreen`.
 * ============================================================================
 */

import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  NormalPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  SSAOEffect,
  VignetteEffect,
  VignetteTechnique,
} from 'postprocessing';

import type { Engine } from '@/core/Engine';
import type { FrameContext, ISubsystem, QualityTier } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { clamp01, damp } from '@/core/MathUtils';

import {
  GradeEffect,
  type GradePresetName,
  type ToneMapName,
  disposeGradeLuts,
} from './effects/GradeEffect';
import { MotionBlurEffect } from './effects/MotionBlurEffect';
import { configure as configureTextures, stats as textureStats } from './TextureFactory';

/**
 * KartManager / Track are owned by other agents and are wired in from Game.
 * Accepted structurally so this file compiles no matter what shape those modules
 * settle on. The pipeline no longer reads anything out of them — depth of field
 * used to focus on the player kart, which turned out to be exactly the wrong
 * thing to do (see the DoF block in `build()`).
 */
export type KartSource = unknown;
export type TrackSource = unknown;

// ---------------------------------------------------------------------------

const CA_MAX = 0.0012;

/**
 * Below this speed intensity the depth-of-field pass is switched off outright.
 * DoF that focuses on the kart at a standstill blurs the road the player is
 * actually looking at, which is both wrong and not free.
 */
const DOF_MIN_SPEED = 0.25;
/** Peak bokeh radius during a full boost. Deliberately gentle. */
const DOF_BOKEH = 1.15;
/** Below this the motion-blur pass is skipped — the shader would no-op anyway. */
const MB_MIN_MOTION = 1.5e-4;

export class RenderPipeline implements ISubsystem {
  private readonly engine: Engine;
  private readonly karts: KartSource;
  private readonly track: TrackSource;

  composer!: EffectComposer;

  // --- passes ---
  private renderPass!: RenderPass;
  private normalPass: NormalPass | null = null;
  private ssaoPass: EffectPass | null = null;
  private dofPass: EffectPass | null = null;
  private motionPass: EffectPass | null = null;
  private lookPass!: EffectPass;
  private caPass: EffectPass | null = null;
  private smaaPass!: EffectPass;

  // --- effects ---
  private ssao: SSAOEffect | null = null;
  private dof: DepthOfFieldEffect | null = null;
  private motionBlur: MotionBlurEffect | null = null;
  private bloom!: BloomEffect;
  private grade!: GradeEffect;
  private vignette!: VignetteEffect;
  private ca: ChromaticAberrationEffect | null = null;
  private smaa!: SMAAEffect;

  // --- state ---
  private width = 1;
  private height = 1;
  private builtTier: QualityTier | null = null;
  private initialised = false;
  private speedTarget = 0;
  private speedSmooth = 0;
  private disposed = false;
  private toneMapName: ToneMapName = 'agx-punchy';
  private exposureTrim = 1;
  private readonly caOffset = new THREE.Vector2();
  private unsubscribe: Array<() => void> = [];

  /** Wall-clock milliseconds the last composer.render() took (CPU side). */
  lastCpuMs = 0;

  constructor(engine: Engine, karts?: KartSource, track?: TrackSource) {
    this.engine = engine;
    this.karts = karts ?? null;
    this.track = track ?? null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    // Game constructs the pipeline, awaits init(), *and* registers it as a
    // subsystem — so Engine.initAll() calls this a second time. Idempotent.
    if (this.initialised) return;
    this.initialised = true;

    const { engine } = this;
    const size = engine.getSize();
    this.width = size.width;
    this.height = size.height;

    // Hand the shared texture library the tier's budget before anyone asks it
    // for a material.
    configureTextures({
      anisotropy: engine.quality.anisotropy,
      maxSize: engine.quality.tier === 'low' ? 1024 : 2048,
    });

    this.composer = new EffectComposer(engine.renderer, {
      frameBufferType: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      multisampling: 0,
    });
    this.composer.autoRenderToScreen = true;

    this.build();

    this.unsubscribe.push(
      bus.on('quality:change', () => this.rebuildForQuality()),
      bus.on('camera:shake', ({ amount, seconds }) => this.addShake(amount, seconds)),
    );

    // Compile everything now so the first lap doesn't hitch.
    engine.renderer.compile(engine.scene, engine.camera);

    if (import.meta.env.DEV) {
      const { installPostQA } = await import('./PostQA');
      installPostQA(this, engine as unknown as Parameters<typeof installPostQA>[1]);
    }
    await Promise.resolve();
  }

  /** Construct the pass list for the current quality tier. */
  private build(): void {
    const { engine } = this;
    const q = engine.quality;
    const scene = engine.scene;
    const camera = engine.camera;
    const composer = this.composer;

    composer.removeAllPasses();

    // 1 ----------------------------------------------------------------- scene
    this.renderPass = new RenderPass(scene, camera);
    composer.addPass(this.renderPass);

    // 2/3/4 ------------------------------------------------------------- SSAO
    if (q.ssao) {
      // Half-res normals. This is the one extra *scene* render in the chain, so
      // it is worth cutting its fill cost; SSAO consumes it at 0.5 scale anyway
      // and the depth-aware upsample reads full-res depth for the edges.
      this.normalPass = new NormalPass(scene, camera, { resolutionScale: 0.5 });
      composer.addPass(this.normalPass);

      // DepthDownsamplingPass used to run here on high/ultra to feed SSAO's
      // depth-aware upsampling. Removed after measuring it with
      // EXT_disjoint_timer_query_webgl2 on a 1600x900 ultra frame:
      //
      //   RenderPass (whole scene)      14.22 ms
      //   NormalPass                     4.58 ms
      //   DepthDownsamplingPass          5.04 ms   <- this
      //   SSAO resolve                   3.13 ms
      //   Bloom+Grade+Vignette           3.57 ms
      //   SMAA                           5.36 ms
      //
      // 5 ms — 15 % of a 33 ms frame, and a third of the whole SSAO group — to
      // sharpen the edges of a half-resolution ambient occlusion term that is
      // deliberately subtle. It bought less than it cost. SSAO now upsamples
      // bilinearly, which softens AO silhouettes very slightly; re-enable this
      // pass if AO edge quality ever becomes the complaint.
      const normalDepthBuffer: THREE.Texture | undefined = undefined;

      // Tuned against dark haloing: world-space thresholds fade the effect out
      // over distance and reject samples that belong to a different surface, so
      // silhouettes don't get an outline.
      //
      // ---------------------------------------------------------------------
      //  luminanceInfluence MUST STAY AT (or very near) ZERO. This is why AO
      //  was completely invisible before.
      //
      //  The SSAO resolve shader does, unconditionally:
      //      float l = luminance(inputColor.rgb);
      //      ao = mix(ao, 0.0, l * luminanceInfluence);
      //
      //  `inputColor` here is the *scene-referred HDR* buffer, because SSAO
      //  correctly runs before tone mapping. Its luminance is routinely 1–4,
      //  not 0–1. `mix` does not clamp, so any pixel with linear luminance
      //  above 1/luminanceInfluence gets its occlusion driven straight through
      //  zero and clamped away. At 0.62 that is everything brighter than 1.6 —
      //  i.e. every lit surface in a daylight track. Measured on a gameplay
      //  frame: disabling the whole SSAO pass changed mean luma by 0.0002 and
      //  mean saturation by 0.0001. It was pure cost for no image.
      // ---------------------------------------------------------------------
      this.ssao = new SSAOEffect(camera, this.normalPass.texture, {
        blendFunction: BlendFunction.MULTIPLY,
        distanceScaling: true,
        depthAwareUpsampling: normalDepthBuffer !== undefined,
        normalDepthBuffer,
        samples: q.tier === 'ultra' ? 22 : q.tier === 'high' ? 16 : 11,
        rings: q.tier === 'ultra' ? 7 : 5,
        luminanceInfluence: 0.0,
        // Screen-relative radius; with distanceScaling on this works out to
        // roughly 0.7 m of world-space reach at the chase camera's distance.
        radius: 0.1,
        minRadiusScale: 0.4,
        // Strong enough to actually read as contact shadow under the karts and
        // where props meet the ground, which is the whole point of having it.
        intensity: 1.85,
        bias: 0.025,
        fade: 0.02,
        // Fade out far geometry entirely — that's where halos come from.
        worldDistanceThreshold: 70,
        worldDistanceFalloff: 28,
        // Ignore occluders that aren't within ~1.2 m of the receiver.
        worldProximityThreshold: 1.2,
        worldProximityFalloff: 0.4,
        // Half-res AO. With depth-aware upsampling on (high/ultra) the edges are
        // recovered from full-res depth, so this is nearly free quality.
        resolutionScale: 0.5,
        // Cool, not black: AO in daylight is sky-lit ambient being blocked, so
        // the residue should read blue-grey rather than as a smudge of soot.
        color: new THREE.Color(0x121a2b),
      });
      this.ssaoPass = new EffectPass(camera, this.ssao);
      composer.addPass(this.ssaoPass);
    }

    // 5 ------------------------------------------------------------------ DoF
    // In postprocessing 6.39 `focusDistance` / `focusRange` are BOTH in world
    // units (the `world*` aliases are deprecated no-ops), and the CoC is
    // `smoothstep(0, focusRange, abs(depth - focusDistance))`. Focusing on the
    // player kart — 6 m away — therefore blurred the entire road ahead, which
    // is the one thing the player is looking at. Focus goes far down the track
    // instead, and the pass only exists during a boost.
    if (q.dof) {
      this.dof = new DepthOfFieldEffect(camera, {
        blendFunction: BlendFunction.NORMAL,
        focusDistance: 42,
        focusRange: 70,
        bokehScale: DOF_BOKEH,
        resolutionScale: 0.5,
      });
      this.dof.target = null;
      this.dofPass = new EffectPass(camera, this.dof);
      this.dofPass.enabled = false; // switched on by speed intensity
      composer.addPass(this.dofPass);
    }

    // 6 ---------------------------------------------------------- motion blur
    if (q.motionBlur) {
      this.motionBlur = new MotionBlurEffect({
        taps: q.tier === 'ultra' ? 14 : q.tier === 'high' ? 12 : 8,
        cameraStrength: 0.8,
        maxRadius: 0.032,
      });
      this.motionPass = new EffectPass(camera, this.motionBlur);
      composer.addPass(this.motionPass);
    }

    // 7 --------------------------------------------------- bloom / look / vig
    const preset = (this.grade?.presetName ?? 'day') as GradePresetName;
    this.grade = new GradeEffect(preset, this.toneMapName);
    if (this.exposureTrim !== 1) this.grade.setExposureTrim(this.exposureTrim);

    // luminanceSmoothing was 0.3, which put the knee at 0.55 — half the
    // mid-tones leaked into the bloom pyramid and, with 8 mip levels and ADD
    // blending, smeared a flat white veil over the whole frame. Measured: it
    // lifted the darkest 1 % of the image from 0.359 to 0.414 luma. A tight
    // knee and a smaller pyramid keep the glow on things that are genuinely
    // bright (sun, sky, boost flame, chrome) instead of on everything.
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.1,
      intensity: this.grade.preset.bloomIntensity,
      radius: 0.62,
      levels: q.tier === 'low' ? 5 : 7,
    });
    // The buffer is HDR: SCREEN saturates above 1, ADD is what physically
    // happens and lets the tone map roll the highlight off afterwards.
    this.bloom.blendMode.blendFunction = BlendFunction.ADD;
    if (!q.bloom) this.bloom.blendMode.opacity.value = 0;

    this.vignette = new VignetteEffect({
      technique: VignetteTechnique.DEFAULT,
      offset: this.grade.preset.vignetteOffset,
      darkness: this.grade.preset.vignetteDarkness,
    });

    this.lookPass = new EffectPass(camera, this.bloom, this.grade, this.vignette);
    composer.addPass(this.lookPass);

    // 8 -------------------------------------------------- chromatic aberration
    this.ca = new ChromaticAberrationEffect({
      blendFunction: BlendFunction.NORMAL,
      offset: this.caOffset,
      radialModulation: true,
      modulationOffset: 0.15,
    });
    this.caPass = new EffectPass(camera, this.ca);
    this.caPass.enabled = false; // switched on by speed intensity
    composer.addPass(this.caPass);

    // 9 ----------------------------------------------------------------- SMAA
    // Always the terminal pass — postprocessing only flags the array's last
    // entry as renderToScreen, so this one must never be disabled.
    // SMAA measured 5.36 ms/frame — the second most expensive thing in the
    // chain after the scene itself. HIGH is reserved for ultra; MEDIUM is
    // visually very close on a moving image and meaningfully cheaper.
    this.smaa = new SMAAEffect({
      preset: q.tier === 'ultra' ? SMAAPreset.HIGH : SMAAPreset.MEDIUM,
    });
    this.smaaPass = new EffectPass(camera, this.smaa);
    composer.addPass(this.smaaPass);

    this.builtTier = q.tier;
    this.composer.setSize(this.width, this.height);
  }

  private teardownPasses(): void {
    this.ssao?.dispose();
    this.dof?.dispose();
    this.motionBlur?.dispose();
    this.bloom?.dispose();
    this.grade?.dispose();
    this.vignette?.dispose();
    this.ca?.dispose();
    this.smaa?.dispose();

    for (const p of [
      this.renderPass, this.normalPass, this.ssaoPass,
      this.dofPass, this.motionPass, this.lookPass, this.caPass, this.smaaPass,
    ]) {
      p?.dispose();
    }

    this.normalPass = null;
    this.ssaoPass = null;
    this.dofPass = null;
    this.motionPass = null;
    this.caPass = null;
    this.ssao = null;
    this.dof = null;
    this.motionBlur = null;
    this.ca = null;
  }

  private rebuildForQuality(): void {
    if (this.disposed) return;
    if (this.builtTier === this.engine.quality.tier) return;
    const keepPreset = this.grade.presetName;
    this.teardownPasses();
    this.build();
    this.grade.setPreset(keepPreset, 0);
    configureTextures({
      anisotropy: this.engine.quality.anisotropy,
      maxSize: this.engine.quality.tier === 'low' ? 1024 : 2048,
    });
  }

  // -------------------------------------------------------------------------
  // Public controls
  // -------------------------------------------------------------------------

  /** 0..1 — how hard the speed/boost effects push. VFX drives this. */
  setSpeedIntensity(v: number): void {
    this.speedTarget = clamp01(v);
  }

  flash(color: THREE.ColorRepresentation, amount: number, seconds: number): void {
    this.grade?.flashScreen(color, amount, seconds);
  }

  addShake(amount: number, seconds: number): void {
    this.grade?.addShake(amount, seconds);
  }

  setGradePreset(name: GradePresetName, seconds = 0.8): void {
    if (!this.grade) return;
    this.grade.setPreset(name, seconds);
    const p = this.grade.preset;
    this.vignette.offset = p.vignetteOffset;
    this.vignette.darkness = p.vignetteDarkness;
    if (this.engine.quality.bloom) this.bloom.intensity = p.bloomIntensity;
  }

  /** Swap the tone-mapping operator. Survives quality rebuilds. */
  setToneMap(name: ToneMapName): void {
    this.toneMapName = name;
    this.grade?.setToneMap(name);
  }

  get toneMap(): ToneMapName { return this.toneMapName; }

  /** The look effect. Exposed for the dev QA probe; not part of the game API. */
  get gradeEffect(): GradeEffect { return this.grade; }

  /** Global exposure trim on top of the preset's own exposure. 1 = neutral. */
  setExposure(v: number): void {
    this.exposureTrim = Math.max(0.05, v);
    this.grade?.setExposureTrim(this.exposureTrim);
  }

  /** Skip the motion-blur history for one frame — use after a camera cut. */
  resetTemporal(): void {
    this.motionBlur?.resetHistory();
  }

  /** Debug read-out for the perf HUD. */
  getStats(): { passes: number; cpuMs: number; textureMs: number; textures: number } {
    return {
      passes: this.composer ? this.composer.passes.filter((p) => p.enabled).length : 0,
      cpuMs: this.lastCpuMs,
      textureMs: textureStats.generatedMs,
      textures: textureStats.count,
    };
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** ISubsystem — runs before render(); keeps per-frame maths out of draw. */
  update(ctx: FrameContext): void {
    const dt = ctx.dt;
    this.speedSmooth = damp(this.speedSmooth, this.speedTarget, 0.09, dt);
    this.grade.advance(dt);

    // --- depth of field -----------------------------------------------------
    // Only alive during a boost, and even then focused a long way down the
    // track so the road stays sharp and only the far scenery softens. Below the
    // threshold the pass is disabled, so it costs nothing at all — a standstill
    // frame is bit-for-bit unaffected by DoF.
    if (this.dof && this.dofPass) {
      const active = this.engine.quality.dof && this.speedSmooth > DOF_MIN_SPEED;
      this.dofPass.enabled = active;
      if (active) {
        const t = clamp01((this.speedSmooth - DOF_MIN_SPEED) / (1 - DOF_MIN_SPEED));
        const coc = this.dof.circleOfConfusionMaterial;
        // Push focus further out the faster we go; keep a wide in-focus band.
        coc.focusDistance = 38 + t * 26;
        coc.focusRange = 62 + t * 30;
        this.dof.bokehScale = DOF_BOKEH * t;
      }
    }

    // --- chromatic aberration ramps with boost only -------------------------
    const caAmount = Math.pow(this.speedSmooth, 2.2);
    if (this.caPass) {
      const enable = caAmount > 0.02;
      this.caPass.enabled = enable;
      if (enable) this.caOffset.set(CA_MAX * caAmount, CA_MAX * caAmount * 0.45);
    }

    // --- speed pushes vignette + blur ---------------------------------------
    if (this.motionBlur) this.motionBlur.speedIntensity = this.speedSmooth;
    const vp = this.grade.preset;
    this.vignette.darkness = vp.vignetteDarkness + this.speedSmooth * 0.14;
    this.vignette.offset = vp.vignetteOffset - this.speedSmooth * 0.05;
  }

  /** Installed on Engine via setRenderCallback. */
  render(dt: number): void {
    if (this.disposed) return;
    const t0 = performance.now();

    // Matrices must be fed every frame, enabled or not, or a re-enabled
    // motion blur pass would smear against an ancient camera transform.
    this.motionBlur?.setMatrices(this.engine.camera, dt);
    if (this.motionPass && this.motionBlur) {
      // The shader early-outs when the reprojected velocity is negligible, so a
      // static camera was already visually inert — but it still paid for a
      // full-screen pass every frame. Skip the pass outright instead.
      this.motionPass.enabled = this.engine.quality.motionBlur
        && this.motionBlur.peakMotion > MB_MIN_MOTION;
    }

    this.composer.render(dt);
    this.lastCpuMs = damp(this.lastCpuMs, performance.now() - t0, 0.25, dt);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (!this.composer) return;
    this.composer.setSize(this.width, this.height);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.teardownPasses();
    disposeGradeLuts();
    this.composer?.dispose();
    // Held only to keep Game's constructor call shape stable; nothing in the
    // post chain reads the scene graph any more.
    void this.track;
    void this.karts;
  }
}

/** Re-exported so other subsystems can name a theme without importing effects. */
export type { GradePresetName };
