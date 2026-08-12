/**
 * ============================================================================
 *  FOXY KART — RENDER PIPELINE
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
 *  BUT THE FRAME CONTAINS MORE PASSES THAN THIS FILE OWNS, and the multiplier
 *  AGENTS.md §5b warns about is the sum, not our share. Counted for real (see
 *  `scenePasses()`, which is what the perf HUD reports), at `high`/`ultra` on a
 *  circuit with water:
 *
 *    shadow cascade 0   world/Lighting   every frame
 *    shadow cascade 1   world/Lighting   every 2nd frame   (0.50/frame)
 *    shadow cascade 2   world/Lighting   every 3rd frame   (0.33/frame)
 *    water reflection   world/Water      every frame       <- see below
 *    RenderPass         here             every frame
 *    NormalPass         here             every frame when SSAO is on
 *    SubjectMask        here             player kart only, quarter res
 *
 *  = 5.83 renders of the scene graph per frame, which is the measured 3.15x on
 *  `renderer.info.render.triangles` (the shadow and reflection passes each draw a
 *  subset). Two of those are avoidable and neither is geometry:
 *
 *   - **NormalPass** is now disabled by the resolution budget below whenever the
 *     colour buffer is well over 1080p, which is the case the game is actually
 *     judged on. That is one whole scene pass plus the 3.13 ms AO resolve.
 *   - **the water reflection pass is never turned off.** `Water.setReflections()`
 *     exists, its doc comment says "lets the render pipeline turn the reflection
 *     pass off under load", and nothing has ever called it — the pipeline is not
 *     handed `Environment` or `Water`. It also is not gated on whether water is
 *     on screen: the 760 m disc is re-centred on the camera every frame, so the
 *     plane test always passes. Wiring that up needs one line in `Game.ts` and is
 *     in the report; it is worth a full scene pass per frame on coastal and neon.
 *
 *  Plus one thing that is NOT a scene render and NOT a full-screen pass: on
 *  frames that will actually blur, `renderSubjectMask()` draws the player kart's
 *  model — one object, 33 draw calls, unlit flat material — into a
 *  quarter-resolution RGBA8 target, so motion blur can keep the subject sharp.
 *  See SubjectMask.ts. It is deliberately outside the composer: the composer
 *  only knows about full-screen passes, and this needs the scene graph.
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
import { SubjectMask } from './effects/SubjectMask';
import { configure as configureTextures, stats as textureStats } from './TextureFactory';

/**
 * KartManager / Track are owned by other agents and are wired in from Game.
 * Accepted structurally so this file compiles no matter what shape those modules
 * settle on. The only thing read out of `karts` is the public
 * `getModel(0): THREE.Object3D` accessor, feature-detected by `SubjectMask`, so
 * that motion blur can keep the player's kart out of its own convolution.
 * Depth of field used to focus on the player kart, which turned out to be
 * exactly the wrong thing to do (see the DoF block in `build()`).
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
/**
 * Below this the motion-blur pass is skipped — the shader would no-op anyway.
 * 1.5e-4 UV is 0.29 px on a 1920-wide frame, i.e. sub-pixel.
 */
const MB_MIN_MOTION = 1.5e-4;

/**
 * Motion-blur tuning. These three numbers are the whole of the "everything
 * smears at speed" defect, so they are named and documented here as well as in
 * MotionBlurEffect.ts rather than buried as literals in `build()`.
 *
 * Measured on a `chase-boost` frame with a deterministic one-frame 38 m/s
 * forward camera step at 60 Hz, 1920 wide, blur length in pixels by depth:
 *
 *                              5 m     20 m    74 m    sky    player kart
 *   before (0.8 / 0.032)      22.4      6.1     1.6    0.0     ~17  <- the bug
 *   after  (0.3 / 0.008)       8.4      2.3     0.6    0.0      0.8
 *
 * The kart column is the one that mattered: it has *zero* screen-space velocity
 * and was being convolved harder than the scenery.
 */
const MB_CAMERA_STRENGTH = 0.3;
const MB_MAX_RADIUS = 0.008;
/** Fraction of the blur that survives on the masked player kart. */
const MB_MASK_KEEP = 0.1;

/**
 * ============================================================================
 *  THE RESOLUTION BUDGET — why the quality *tier* is not enough on its own
 * ============================================================================
 *  Every millisecond quoted in the header of this file was measured at
 *  1600x900 = 1.44 Mpixel. Nothing in the chain was ever sized against the
 *  buffer it actually runs on, and the buffer is not 1.44 Mpixel on the machine
 *  this game is judged on:
 *
 *    Engine boots with `setPixelRatio(min(devicePixelRatio, 2))`, and
 *    `detectTier()` hands an Apple M-series Mac the `ultra` preset. A Retina
 *    Mac reports devicePixelRatio 2, so a 1512x982 window becomes a
 *    **3024x1964 = 5.94 Mpixel** colour buffer — 4.1x the fill the numbers were
 *    taken at. Seven full-screen passes, two of them convolutions, all scale
 *    linearly with that: the ~17 ms post chain becomes ~70 ms, on its own,
 *    before the scene, the shadows or the reflection pass are drawn at all.
 *
 *  That is the arithmetic behind "lag is still severe", and no tier flag
 *  expresses it: `ultra` on a 1280x720 window and `ultra` on a Retina 16"
 *  differ by 6x in fill and not at all in settings.
 *
 *  So the expensive knobs are chosen from the **measured device pixel count**
 *  and only then capped by the tier. `POST_PIXEL_BUDGET` is the buffer size the
 *  chain's timings were taken at, rounded to 1080p; `costScale` is how many
 *  times over it we actually are. Every threshold below is expressed in
 *  multiples of that, so it stays correct on hardware nobody has tested on.
 *
 *  This deliberately does NOT touch `renderer.setPixelRatio` — Engine owns the
 *  backing store and fights anyone who writes it. See the report: the real fix
 *  is for Engine to derive the pixel ratio from a pixel budget instead of
 *  `min(dpr, 2)`, and this is what the pipeline can do without that.
 * ============================================================================
 */
const POST_PIXEL_BUDGET = 1920 * 1080;
/** Above this multiple of the budget, drop SSAO — and with it a scene pass. */
const COST_DROP_SSAO = 1.6;
/** Above this, halve the motion-blur tap count and shrink the DoF/AO buffers. */
const COST_CHEAP_KERNELS = 1.35;
/** Above this, SMAA drops to its cheapest preset. */
const COST_CHEAP_AA = 2.2;

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

  /** Quarter-res silhouette of the player kart, consumed by motion blur. */
  private subjectMask: SubjectMask | null = null;

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

  /** Last `costScale` the budget was applied at — see POST_PIXEL_BUDGET. */
  private appliedCost = -1;
  /** The DEV scene/presentation audits are once-per-session, not per rebuild. */
  private audited = false;

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
    this.wireKartLod();

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
        cameraStrength: MB_CAMERA_STRENGTH,
        maxRadius: MB_MAX_RADIUS,
      });
      this.motionBlur.setMaskKeep(MB_MASK_KEEP);
      // The subject mask is the reason the player's kart no longer smears.
      // Built lazily here so a tier rebuild re-attaches it, and only on tiers
      // that actually run the blur.
      if (!this.subjectMask) this.subjectMask = new SubjectMask(q.tier === 'low' ? 0.2 : 0.25);
      this.subjectMask.setSize(this.deviceWidth(), this.deviceHeight());
      this.motionBlur.setSubjectMask(this.subjectMask.texture);
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
    this.appliedCost = -1;
    this.applyResolutionBudget();
    this.verifyDepthBinds();
  }

  /**
   * Give `KartManager` the real camera to measure LOD distance from.
   *
   * `KartManager.setCamera()` exists, is documented ("Optional: gives LOD a real
   * camera instead of the player's kart") and **nothing had ever called it** —
   * `Game` wires `setVfx` and `setAudio` on the karts and not this. So all twelve
   * karts' LOD was being measured from *the player kart's own position*, which
   * makes the player's own distance identically 0 and biases every rival's by the
   * 7 m of chase-camera offset in the wrong direction. That is the sixth instance
   * of the authored-but-never-called pattern recorded in HANDOFF.md.
   *
   * It is done from here rather than reported as a `Game` change because the
   * pipeline is already handed both halves — `engine.camera` and `karts` — and
   * needs no new wiring to do it. Feature-detected, because `karts` is declared
   * structurally and may be null in a probe.
   */
  private wireKartLod(): void {
    const k = this.karts as { setCamera?: (c: THREE.Object3D) => void } | null;
    if (k && typeof k.setCamera === 'function') {
      try {
        k.setCamera(this.engine.camera);
      } catch (err) {
        console.warn('[Render] karts.setCamera failed; LOD will use the player kart', err);
      }
    }
  }

  /**
   * Size the expensive knobs against the buffer we are actually rendering into
   * rather than against the quality tier. See POST_PIXEL_BUDGET for the
   * arithmetic; the short version is that `ultra` on a Retina Mac is a 5.9
   * Mpixel buffer and every number in this file's header was measured at 1.44.
   *
   * Everything here is applied in place — no pass is constructed or destroyed and
   * the composer is not resized, so it is safe to call from `resize()`. Two knobs
   * recompile a pass (the motion-blur tap count and the SMAA preset), so the whole
   * thing is keyed on the resulting *decisions* rather than on the pixel count.
   */
  private applyResolutionBudget(): void {
    const q = this.engine.quality;
    const px = this.deviceWidth() * this.deviceHeight();
    const cost = px / POST_PIXEL_BUDGET;

    const cheapKernels = cost > COST_CHEAP_KERNELS;
    const wantSsao = q.ssao && cost <= COST_DROP_SSAO;
    const aa = cost > COST_CHEAP_AA ? SMAAPreset.LOW
      : (q.tier === 'ultra' && cost <= 1.15) ? SMAAPreset.HIGH
        : SMAAPreset.MEDIUM;

    // Key on the *decisions*, not on the pixel count. Engine's adaptive
    // resolution walks the pixel ratio in 10 % steps every 1.5 s, and two of the
    // knobs below (motion-blur taps, the SMAA preset) recompile a pass when they
    // change — so keying on `cost` itself would burn a shader compile on every
    // step of that ramp for a decision that had not actually changed.
    const key = (cheapKernels ? 1 : 0) | (wantSsao ? 2 : 0) | (aa << 2);
    if (key === this.appliedCost) return;
    this.appliedCost = key;

    // --- antialiasing: the second most expensive pass in the chain -----------
    // 5.36 ms at 1.44 Mpixel on the HIGH preset. At 5.9 Mpixel that is ~22 ms of
    // a 16.6 ms frame for edge quality on a moving image.
    if (this.smaa) this.smaa.applyPreset(aa);

    // --- motion blur: one dependent texture fetch per tap per pixel ---------
    if (this.motionBlur) {
      const base = q.tier === 'ultra' ? 14 : q.tier === 'high' ? 12 : 8;
      this.motionBlur.setTaps(cheapKernels ? Math.max(6, Math.round(base * 0.5)) : base);
    }

    // --- SSAO: this is the one that removes a whole SCENE pass ---------------
    // `NormalPass` re-renders the entire scene to get view normals. AGENTS.md
    // §5b: "if renderer.info.render.triangles is several times the triangle count
    // actually present in the scene graph, you have too many full-scene passes —
    // that is usually the real bug". Disabling the pair takes one full pass out of
    // the frame *and* removes the 3.13 ms AO resolve, and it is a pass toggle, so
    // it costs nothing to change and nothing to change back.
    if (this.ssaoPass) this.ssaoPass.enabled = wantSsao;
    if (this.normalPass) this.normalPass.enabled = wantSsao;
    // Sample count is deliberately left alone: `SSAOEffect.samples` is deprecated
    // in postprocessing 6.39 and its setter recompiles the resolve shader, so the
    // buffer size is the cheaper lever and the one that actually scales with fill.
    if (this.ssao && wantSsao) this.ssao.resolution.scale = cheapKernels ? 0.35 : 0.5;
    if (this.normalPass) this.normalPass.resolution.scale = cheapKernels ? 0.35 : 0.5;

    // --- depth of field + bloom pyramid -------------------------------------
    if (this.dof) this.dof.resolution.scale = cheapKernels ? 0.35 : 0.5;
    if (this.bloom) {
      this.bloom.mipmapBlurPass.levels = q.tier === 'low' ? 5 : cheapKernels ? 6 : 7;
    }

    if (import.meta.env.DEV) {
      console.info(
        `[Render] resolution budget: ${this.deviceWidth()}x${this.deviceHeight()}`
        + ` = ${(px / 1e6).toFixed(2)} Mpx (${cost.toFixed(2)}x budget) -> `
        + `ssao ${wantSsao ? 'on' : 'OFF (NormalPass scene pass removed)'}, `
        + `smaa preset ${aa}, mb taps ${this.motionBlur ? this.motionBlur.tapCount : 0}, `
        + `scene passes/frame: ${this.scenePasses().length}`,
      );
    }
  }

  /**
   * Every render of the scene graph this frame will contain, named.
   *
   * AGENTS.md §5b asks for the *list*, not the total, because a multiplier on
   * `renderer.info` only tells you that there are too many passes and not which.
   * Passes owned by other subsystems are included with their owner, because the
   * number that matters is the one for the whole frame.
   */
  scenePasses(): string[] {
    const q = this.engine.quality;
    const out: string[] = [];
    const cascades = Math.min(3, Math.max(1, q.cascadeCount | 0));
    out.push('shadow cascade 0 (world/Lighting, every frame)');
    if (cascades > 1) out.push('shadow cascade 1 (world/Lighting, every 2nd frame)');
    if (cascades > 2) out.push('shadow cascade 2 (world/Lighting, every 3rd frame)');
    if (q.tier === 'high' || q.tier === 'ultra') {
      out.push('water planar reflection (world/Water, every frame — NOT gated on visibility)');
    }
    out.push('RenderPass — main scene (render/RenderPipeline)');
    if (this.normalPass?.enabled) out.push('NormalPass — full scene, view normals for SSAO');
    if (this.motionPass?.enabled && this.subjectMask?.active) {
      out.push('SubjectMask — player kart subtree only, quarter res');
    }
    return out;
  }

  /**
   * Assert that nothing in this chain binds a depth texture that a plain
   * `sampler2D` may not read.
   *
   * There was a reported flood of
   *   GL_INVALID_OPERATION: Mismatch between texture format and sampler type
   * on *every* draw call in the frame, which Chrome eventually silences and
   * which never appears in a JS console reader because the browser's command
   * decoder emits it, not the page. Two review rounds argued about ownership
   * from indirect evidence.
   *
   * There is exactly one way a depth texture becomes illegal to read through
   * `sampler2D`, and it is worth naming so nobody has to rediscover it: setting
   * `compareFunction` makes three set `TEXTURE_COMPARE_MODE =
   * COMPARE_REF_TO_TEXTURE` on the texture object (WebGLTextures
   * .setTextureParameters), that is texture state rather than sampler state so
   * it is never cleared again, and from then on the texture *requires*
   * `sampler2DShadow`. postprocessing declares `sampler2D`. Every pass that
   * samples it then fails validation on every draw.
   *
   * Verified clean at the time of writing: all of this chain's depth textures
   * are DepthFormat + FloatType (DEPTH_COMPONENT32F), NEAREST/NEAREST,
   * compareFunction null. `__POST__.boundTextures()` prints the live values and
   * `__POST__.glValidate()` counts real GL errors per draw.
   */
  private verifyDepthBinds(): void {
    if (!import.meta.env.DEV) return;
    const seen = new Set<THREE.Texture>();
    for (const pass of this.composer.passes) {
      const tex = (pass as unknown as { getDepthTexture?: () => THREE.Texture | null })
        .getDepthTexture?.();
      if (!tex || seen.has(tex)) continue;
      seen.add(tex);
      const cmp = (tex as THREE.DepthTexture).compareFunction;
      if (cmp !== null && cmp !== undefined) {
        console.error(
          `[Render] ${tex.name || 'depth texture'} has compareFunction=${String(cmp)}. `
          + 'It is bound to a plain sampler2D and WILL fail validation on every '
          + 'draw of every pass that reads it. Clear compareFunction.',
        );
      }
    }
    // Once per session, not once per quality rebuild — these walk the scene.
    if (!this.audited) {
      this.audited = true;
      this.auditSceneSamplers();
      this.auditPresentation();
    }
  }

  /**
   * Scene-wide sampler/texture-type validator.
   *
   * `GL_INVALID_OPERATION: Mismatch between texture format and sampler type` has
   * been open since it was first reported (HANDOFF.md item 2) and has cost two
   * review rounds of arguing about ownership from indirect evidence, because the
   * message is emitted by Chrome's command decoder and never reaches a JS console
   * reader — so nobody could point at a file. It is a per-draw validation
   * failure, which makes the decoder crawl, so it is also a plausible share of
   * "lag is still severe".
   *
   * The message has exactly one cause: the GLSL sampler a program declares does
   * not match the texture bound to it. That is decidable *statically* from the
   * shader source plus the live uniform value, which is what this does. It walks
   * every material in the scene once and reports the offending
   * material + uniform + texture by name, for every subsystem, so the next person
   * to boot the game gets the answer instead of a suspect list.
   *
   * Two families are checked:
   *  - **`ShaderMaterial`** — parse `uniform <sampler…> <name>` out of the
   *    fragment and vertex source and compare against what `uniforms[name].value`
   *    actually is (2D / array / 3D / cube / depth-with-compare / integer format).
   *  - **built-in materials** — `envMap` is the dangerous one, because the
   *    sampler three declares for it is chosen from `texture.mapping`
   *    (`CubeUVReflectionMapping` → `sampler2D`, `Cube*Mapping` → `samplerCube`),
   *    so a cube texture with a CubeUV mapping fails on *every draw of every
   *    material in the scene* — which is precisely the reported symptom.
   */
  private auditSceneSamplers(): void {
    const DECL = /uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(sampler2DArray|sampler2DShadow|sampler3D|samplerCube|isampler2D|usampler2D|sampler2D)\s+([A-Za-z_]\w*)/g;
    type Kind = '2d' | 'array' | '3d' | 'cube';
    const kindOf = (t: THREE.Texture): Kind => {
      const x = t as unknown as {
        isDataArrayTexture?: boolean; isCompressedArrayTexture?: boolean;
        isData3DTexture?: boolean; isCompressed3DTexture?: boolean;
        isCubeTexture?: boolean;
      };
      if (x.isDataArrayTexture || x.isCompressedArrayTexture) return 'array';
      if (x.isData3DTexture || x.isCompressed3DTexture) return '3d';
      if (x.isCubeTexture) return 'cube';
      return '2d';
    };
    const INT_FORMATS = new Set<number>([
      THREE.RedIntegerFormat, THREE.RGIntegerFormat, THREE.RGBAIntegerFormat,
    ]);
    const problems: string[] = [];
    const seen = new Set<THREE.Material>();

    const checkTexture = (
      owner: string, uniform: string, want: Kind | 'shadow', t: THREE.Texture,
    ): void => {
      const got = kindOf(t);
      const name = t.name || '(unnamed)';
      if (want !== 'shadow' && got !== want) {
        problems.push(
          `${owner}.${uniform} declares sampler for '${want}' but '${name}' is a '${got}' texture`,
        );
      }
      const cmp = (t as THREE.DepthTexture).compareFunction;
      if (want === '2d' && cmp !== null && cmp !== undefined) {
        problems.push(
          `${owner}.${uniform} binds depth texture '${name}' with compareFunction=`
          + `${String(cmp)} to a plain sampler2D — it requires sampler2DShadow`,
        );
      }
      if (INT_FORMATS.has(t.format)) {
        problems.push(
          `${owner}.${uniform} binds '${name}' with an INTEGER format (${t.format}) `
          + 'to a float sampler — needs isampler/usampler',
        );
      }
    };

    const checkMaterial = (mat: THREE.Material, meshName: string): void => {
      if (seen.has(mat)) return;
      seen.add(mat);
      const label = `${mat.name || mat.type}${meshName ? ` on ${meshName}` : ''}`;
      const sm = mat as THREE.ShaderMaterial;
      if (sm.isShaderMaterial && sm.uniforms) {
        const src = `${sm.fragmentShader ?? ''}\n${sm.vertexShader ?? ''}`;
        DECL.lastIndex = 0;
        let m: RegExpExecArray | null = DECL.exec(src);
        while (m !== null) {
          const decl = m[1];
          const uname = m[2];
          const u = sm.uniforms[uname];
          const value = u ? (u.value as THREE.Texture | null | undefined) : undefined;
          if (value && (value as { isTexture?: boolean }).isTexture) {
            const want: Kind | 'shadow' = decl === 'sampler2DArray' ? 'array'
              : decl === 'sampler3D' ? '3d'
                : decl === 'samplerCube' ? 'cube'
                  : decl === 'sampler2DShadow' ? 'shadow' : '2d';
            checkTexture(label, uname, want, value);
          }
          m = DECL.exec(src);
        }
      }
      // Built-in slots. `envMap` is the only one whose sampler type is data-driven.
      const std = mat as THREE.MeshStandardMaterial;
      const env = std.envMap as THREE.Texture | null | undefined;
      if (env) {
        const cubeDeclared = env.mapping === THREE.CubeReflectionMapping
          || env.mapping === THREE.CubeRefractionMapping;
        checkTexture(label, 'envMap', cubeDeclared ? 'cube' : '2d', env);
      }
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
        'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap'] as const) {
        const t = (std as unknown as Record<string, THREE.Texture | null | undefined>)[slot];
        if (t && (t as { isTexture?: boolean }).isTexture) checkTexture(label, slot, '2d', t);
      }
    };

    const scene = this.engine.scene;
    const envTex = scene.environment;
    if (envTex) {
      const cubeDeclared = envTex.mapping === THREE.CubeReflectionMapping
        || envTex.mapping === THREE.CubeRefractionMapping;
      checkTexture('scene.environment', 'envMap', cubeDeclared ? 'cube' : '2d', envTex);
    }
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      if (Array.isArray(mat)) for (const mm of mat) checkMaterial(mm, mesh.name);
      else checkMaterial(mat, mesh.name);
    });

    if (problems.length === 0) {
      console.info(
        `[Render] sampler audit: ${seen.size} materials in the scene graph, `
        + '0 texture/sampler-type mismatches. If '
        + '"GL_INVALID_OPERATION: Mismatch between texture format and sampler type" '
        + 'still floods, it is NOT a scene material — re-check the post chain '
        + 'targets with __POST__.boundTextures() and the shadow maps.',
      );
      return;
    }
    console.error(
      `[Render] sampler audit found ${problems.length} texture/sampler-type `
      + 'mismatch(es). Each one fails WebGL validation on EVERY draw of the '
      + 'affected program:\n  - ' + problems.join('\n  - '),
    );
  }

  /**
   * One-shot report of everything that owns pixels on screen.
   *
   * Filed because a mid-race screenshot showed a ~200x115 picture-in-picture copy
   * of the whole game — scene *and* HUD — in the bottom-right corner, and nothing
   * in this repository draws one. The audit below is what distinguishes the three
   * possible causes without guessing:
   *
   *  - **a second canvas / a second Game instance** — would appear in the canvas
   *    list with its own rect;
   *  - **a partial GL viewport** (a render target's viewport left bound, so the
   *    composited frame lands in one corner of the default framebuffer) — would
   *    show as a viewport smaller than the drawing buffer;
   *  - **outside the page entirely** (the review pane compositing the page into a
   *    sub-region — see AGENTS.md §5 — or an OS/browser picture-in-picture
   *    window). Everything below is consistent and the copy contains the DOM HUD,
   *    which no WebGL pass in this engine can draw.
   *
   * That last point is the decisive one and is worth keeping: the HUD is DOM, so
   * a WebGL pass cannot reproduce it. An inset containing a HUD is therefore a
   * *document*-level duplicate, not a render-target composite.
   */
  private auditPresentation(): void {
    if (typeof document === 'undefined') return;
    const gl = this.engine.renderer.getContext();
    const vp = new THREE.Vector4();
    this.engine.renderer.getViewport(vp);
    const canvases = Array.from(document.querySelectorAll('canvas')).map((c, i) => {
      const r = c.getBoundingClientRect();
      return `#${i} ${c.className || '(no class)'} buffer=${c.width}x${c.height}`
        + ` css=${Math.round(r.width)}x${Math.round(r.height)}`
        + ` at (${Math.round(r.left)},${Math.round(r.top)})`
        + `${c === this.engine.canvas ? ' <- engine' : ''}`;
    });
    console.info(
      `[Render] presentation audit — drawingBuffer ${gl.drawingBufferWidth}x`
      + `${gl.drawingBufferHeight}, viewport ${vp.x},${vp.y} ${vp.z}x${vp.w}, `
      + `pixelRatio ${this.engine.renderer.getPixelRatio()}, composer `
      + `${this.width}x${this.height} CSS. ${canvases.length} canvas element(s):\n  `
      + canvases.join('\n  '),
    );
    if (vp.z < gl.drawingBufferWidth || vp.w < gl.drawingBufferHeight) {
      console.error(
        '[Render] the GL viewport is SMALLER than the drawing buffer. The '
        + 'composited frame will land in one corner of the canvas and the rest '
        + 'will hold whatever was there before — this is the picture-in-picture '
        + 'artifact. Something set a render target and did not restore it.',
      );
    }
    if (canvases.length > 1) {
      console.error(
        `[Render] ${canvases.length} canvases are in the document. Only one is `
        + 'the engine\'s. A second live canvas is the picture-in-picture inset.',
      );
    }
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
  getStats(): {
    passes: number; cpuMs: number; textureMs: number; textures: number;
    maskDrawCalls: number; motionBlurPx: number;
    /** Renders of the scene graph this frame — the number AGENTS.md §5b wants. */
    scenePasses: number; megapixels: number;
  } {
    // `motionBlurPx` is the peak blur length in pixels of the current backing
    // store, clamped exactly as the shader clamps it. Report this rather than a
    // bare `enabled` flag: the pass legitimately reads `enabled:false` at a
    // standstill (see MB_MIN_MOTION), which has misled two reviews into
    // believing motion blur was off at speed as well.
    const mb = this.motionBlur;
    const peak = mb ? Math.min(mb.peakMotion, MB_MAX_RADIUS) * this.deviceWidth() : 0;
    return {
      passes: this.composer ? this.composer.passes.filter((p) => p.enabled).length : 0,
      cpuMs: this.lastCpuMs,
      textureMs: textureStats.generatedMs,
      textures: textureStats.count,
      maskDrawCalls: this.subjectMask?.drawCalls ?? 0,
      motionBlurPx: Math.round(peak * 10) / 10,
      scenePasses: this.scenePasses().length,
      megapixels: Math.round((this.deviceWidth() * this.deviceHeight()) / 1e4) / 100,
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

  /**
   * `width`/`height` are CSS pixels — that is what `Engine.getSize()` returns and
   * what `EffectComposer.setSize()` expects, since the composer applies the
   * renderer's pixel ratio itself. Anything that needs to reason in real buffer
   * pixels (mask resolution, blur length in pixels) must go through these.
   */
  private deviceWidth(): number {
    return Math.max(1, Math.round(this.width * this.engine.renderer.getPixelRatio()));
  }

  private deviceHeight(): number {
    return Math.max(1, Math.round(this.height * this.engine.renderer.getPixelRatio()));
  }

  /**
   * Render the player-kart silhouette into the motion-blur subject mask.
   *
   * Public so the dev QA harness can force a mask refresh when it drives
   * `composer.render()` directly instead of going through this callback.
   */
  renderSubjectMask(): boolean {
    if (!this.subjectMask || !this.motionBlur) return false;
    const ok = this.subjectMask.render(this.engine.renderer, this.engine.camera, this.karts);
    // Never blur against a stale silhouette: if the subject vanished (results
    // camera, kart despawn) drop the define rather than protect the wrong pixels.
    if (ok !== this.motionBlur.hasSubjectMask) {
      this.motionBlur.setSubjectMask(ok ? this.subjectMask.texture : null);
    }
    return ok;
  }

  /** Installed on Engine via setRenderCallback. */
  render(dt: number): void {
    if (this.disposed) return;
    const t0 = performance.now();

    // The chase camera writes its solution during `update()`; its world matrix
    // is not refreshed until something renders with it. Do it here so the
    // reprojection below sees *this* frame's transform rather than last frame's.
    this.engine.camera.updateMatrixWorld();

    // Matrices must be fed every frame, enabled or not, or a re-enabled
    // motion blur pass would smear against an ancient camera transform.
    this.motionBlur?.setMatrices(this.engine.camera, dt);
    if (this.motionPass && this.motionBlur) {
      // The shader early-outs when the reprojected velocity is negligible, so a
      // static camera was already visually inert — but it still paid for a
      // full-screen pass every frame. Skip the pass outright instead.
      const on = this.engine.quality.motionBlur
        && this.motionBlur.peakMotion > MB_MIN_MOTION;
      this.motionPass.enabled = on;
      // Only pay for the silhouette on frames that will actually blur.
      if (on) this.renderSubjectMask();
      else if (this.subjectMask) this.subjectMask.drawCalls = 0;
    } else if (this.subjectMask) {
      // Tier without motion blur: the mask is never rendered, so don't let
      // getStats() keep reporting the last tier's cost.
      this.subjectMask.drawCalls = 0;
    }

    this.composer.render(dt);
    this.lastCpuMs = damp(this.lastCpuMs, performance.now() - t0, 0.25, dt);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (!this.composer) return;
    this.composer.setSize(this.width, this.height);
    this.subjectMask?.setSize(this.deviceWidth(), this.deviceHeight());
    // Engine changes the pixel ratio (adaptive resolution) by calling resize, so
    // this is where the real buffer size becomes known. Bucketed internally.
    this.applyResolutionBudget();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.teardownPasses();
    this.subjectMask?.dispose();
    this.subjectMask = null;
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
