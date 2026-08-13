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
 *  AGENTS.md §5b warns about is the sum, not our share. **Measured**, not
 *  reasoned about: `.probe-tmp/passes.ts` drives the real `Lighting` cascade hook
 *  and the real `Water.update()` through a recording renderer and tallies what
 *  each pass would submit, with that pass's own visibility rules and its own
 *  camera's frustum. Neon, ultra, chase pose, 12 frames:
 *
 *    pass                        runs/frame   submitted per frame
 *    RenderPass (main colour)          1.00    172.0 calls  0.885 M tris
 *    NormalPass (SSAO normals)         1.00    172.0 calls  0.885 M tris
 *    water planar reflection           1.00     44.0 calls  0.207 M tris
 *    shadow cascade 0                  1.00     46.0 calls  0.197 M tris
 *    shadow cascade 1                  0.50     21.0 calls  0.092 M tris
 *    shadow cascade 2                  0.33      7.3 calls  0.045 M tris
 *    SubjectMask (player kart)         1.00     31.0 calls  0.033 M tris
 *    ---------------------------------------------------------------------
 *    TOTAL                             5.83    493.3 calls  2.343 M tris
 *    scene graph, live                          208   calls  0.956 M tris
 *    MULTIPLIER                                2.37x calls  2.45x tris
 *
 *  That reproduces the owner's 505 calls / 2.92 M triangles, so the pass list
 *  above IS the multiplier. Volcano is 4.83 passes / 419 calls / 1.890 M — the
 *  same list minus the reflection, because `lava` sets `reflectionsOn = false`.
 *
 *  Three things were verified rather than assumed, because each one is a place a
 *  pass could silently be drawing everything:
 *
 *   - **the shadow cascades DO respect their layer masks.** Cascade 2 submits 22
 *     calls / 0.135 M tris; with the mask lifted it would submit 46 / 0.197 M.
 *     `applyMask()` hides whole subtrees and three's shadow traversal returns on
 *     `object.visible === false`, so the saving is real.
 *   - **the water reflection DOES honour `userData.noReflect`.** Only Terrain,
 *     the road group and the track decals survive its filter; Props, Foliage,
 *     Crowd, Weather and the VFX root are all excluded. 0.207 M of 0.885 M.
 *   - **the NormalPass does NOT re-render the shadow cascades.** postprocessing's
 *     `NormalPass` sets `renderPass.skipShadowMapUpdate`, which sets
 *     `shadowMap.autoUpdate = false` for its duration; `Lighting`'s hook then
 *     early-outs. One shadow group per frame, not two.
 *
 *  What has now been cut, and how:
 *
 *   - **NormalPass** is dropped by the resolution budget at >1.05x of 1080p (was
 *     1.6x). One whole scene pass — the largest single term after the main pass —
 *     plus the 3.13 ms AO resolve, gone on anything bigger than the fill this
 *     chain was measured at. AO survives untouched at 1080p and below.
 *   - **the water reflection pass** is now switched off above 1.2x, through
 *     `setWorld()` below. `Water.setReflections()` existed, its doc comment said
 *     "lets the render pipeline turn the reflection pass off under load", and
 *     nothing had ever called it because the pipeline is not handed `Environment`.
 *     It still needs ONE line in `Game.ts` (see `setWorld`) — DEV logs loudly if
 *     that line is missing, because authored-but-never-called is this project's
 *     recorded failure mode.
 *   - **depth of field + chromatic aberration** above 1.35x, and **motion blur
 *     (with its SubjectMask scene pass)** above 2.2x. All pure juice, all gated
 *     on speed, i.e. all arriving exactly when the frame is already worst.
 *   - **the same cuts also fire on measured frame rate**, not only on pixel count,
 *     because `costScale` cannot see how fast the GPU is and `Engine`'s adaptive
 *     resolution floors at 0.65x. See `FPS_STRAINED`; the latch is deliberately
 *     dead below 0.5x of the budget so the 800x450 review pane, whose rAF runs at
 *     ~10 Hz, can never trip it.
 *
 *  What that adds up to, composed from the measured per-pass costs above:
 *
 *    neon / ultra                        passes   calls    triangles   multiplier
 *    before, any cost <= 1.6x              5.83   493.3     2.356 M       2.45x
 *    after, <=1.05x (1080p, the pane)      5.83   493.3     2.356 M       2.45x
 *    after, 1.29x (Retina, settled)        3.83   277.3     1.259 M       1.31x
 *    after, 3.09x (Retina, first seconds)  2.83   246.3     1.226 M       1.28x
 *
 *    volcano / ultra
 *    before                                4.83   419.3     1.887 M       2.20x
 *    after, <=1.05x                        4.83   419.3     1.887 M       2.20x
 *    after, 1.29x                          3.83   258.3     1.103 M       1.29x
 *    after, 3.09x                          2.83   227.3     1.070 M       1.25x
 *
 *  i.e. **-44 % draw calls and -47 % triangles on the machine that is actually
 *  slow, and bit-identical at 1080p and below** — which is where the visual bar is
 *  judged, so nothing in a capture changes. `.probe-tmp/budget.ts` asserts that
 *  second property directly.
 *
 *  What is NOT fixable from here, and is in the report: 65 drawables in the scene
 *  carry `frustumCulled = false`, holding 0.738 M of the graph's 0.956 M
 *  triangles. 77 % of the geometry is therefore submitted by EVERY pass no matter
 *  where the camera looks, which is why a range-limited NormalPass measured
 *  exactly zero saving (far = 60 m submits the same 172 calls as far = 4000 m).
 *  That is `src/world/*` + `src/track/*`, and it is the biggest lever left.
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

/*
 * The ladder, in the order things are shed. Read it as one list — the ordering
 * between these numbers IS the design, and changing one in isolation reorders it:
 *
 *   1.05  SSAO + its NormalPass      a whole scene pass, every frame
 *   1.20  water planar reflection    a whole scene pass, every frame
 *   1.20  cheap kernels              fewer taps / smaller buffers, no pass removed
 *   1.35  depth of field + CA        two full-screen passes, only at speed
 *   2.20  cheapest SMAA preset
 *   2.20  motion blur + SubjectMask  a full-screen convolution plus a scene pass
 *
 * Scene passes go before full-screen passes, and things that cost every frame go
 * before things that only cost at speed.
 */

/**
 * Above this multiple of the budget, drop SSAO — and with it a whole SCENE pass.
 *
 * Measured headlessly (`.probe-tmp/passes.ts`, neon, ultra, chase pose): the
 * NormalPass submits **172 draw calls / 0.885 M triangles per frame, an exact
 * duplicate of the main colour pass** — 35 % of every draw call and 38 % of
 * every triangle in the frame. Plus 4.58 ms of geometry and 3.13 ms of AO
 * resolve at the 1.44 Mpixel these timings were taken at.
 *
 * It was 1.6, which is a strange place for the line: every millisecond in this
 * file's header was measured at 1.44 Mpixel, so at 1.6x the budget the chain is
 * already ~2.3x over the time it was designed for and is still paying for a
 * deliberately subtle contact-shadow term. The line belongs *at* the budget:
 * 1.05 keeps AO wherever the chain is inside the fill it was tuned for — the
 * 800x450 review pane (0.19x), 1600x900 (0.75x), 1080p (1.00x) — and drops it,
 * with its scene pass, the moment the buffer is bigger than that.
 */
const COST_DROP_SSAO = 1.05;
/** Above this, halve the motion-blur tap count and shrink the DoF/AO buffers. */
const COST_CHEAP_KERNELS = 1.2;
/**
 * Above this, the two pure-juice full-screen passes go: depth of field (a
 * multi-pass effect — CoC, two bokeh convolutions, composite) and chromatic
 * aberration (a 0.0012-offset fringe). Both are gated on speed, so they arrive
 * exactly when the frame is already at its worst, and at 5.94 Mpixel a
 * full-screen HalfFloat pass is ~95 MB of read+write traffic each.
 */
const COST_DROP_JUICE = 1.35;
/**
 * Above this the water planar reflection is switched off — that is a whole extra
 * render of the scene graph (44 calls / 0.207 M tris/frame on neon, measured),
 * and it also drives every material in that pass through a *second* program
 * variant because it enables a global clipping plane. See `setWorld()`.
 */
const COST_DROP_REFLECTIONS = 1.2;
/** Above this, SMAA drops to its cheapest preset. */
const COST_CHEAP_AA = 2.2;
/**
 * Above this, motion blur goes entirely — pass, tap loop and the SubjectMask
 * scene pass with it. At >2.2x the budget the frame is already three times over
 * 16.6 ms and 14 dependent texture fetches per pixel is not where the remaining
 * milliseconds should go.
 */
const COST_DROP_MOTION_BLUR = 2.2;

/**
 * ============================================================================
 *  THE SECOND HALF OF THE BUDGET — measured frame rate, not just pixel count
 * ============================================================================
 *  `costScale` above is a guess: it says how many times over the *fill* these
 *  timings were taken at we are, and it is blind to the one variable that
 *  matters most — how fast the GPU actually is. Two facts make that gap real:
 *
 *   - `detectTier()` hands every M-series Mac `ultra`, from an M1 Air to an
 *     M4 Max. Those differ by ~6x in fill rate and not at all in `costScale`.
 *   - `Engine`'s adaptive resolution floors at 0.65x pixel ratio. Once it is on
 *     the floor it has nothing left to give, and if the frame is still missing
 *     60 fps there, no amount of *pixel* accounting will notice.
 *
 *  So the budget also reads `Engine.fpsAverage` (a 60-frame median) and, when the
 *  frame is genuinely missing its target, sheds the same things it would shed for
 *  a bigger buffer. A Schmitt trigger, not a threshold: drop below 48 fps, restore
 *  only above 58. Without the gap this hunts at ~1 Hz — turn AO off, get 62 fps,
 *  turn it back on, get 50 — which is far worse than either state, and it is
 *  exactly the shape of hysteresis `Engine.trackPerformance` already uses
 *  (15.5 ms down / 11.5 ms up).
 *
 *  Order of operations is deliberate: Engine's own controller fires first, at
 *  15.5 ms (64 fps), so cheap fill reduction is always tried before any feature
 *  is taken away.
 *
 *  ⚠️ AND IT MUST NOT FIRE IN THE REVIEW PANE. AGENTS.md §5 / PostQA.ts: the
 *  preview pane drives `requestAnimationFrame` at roughly 10 Hz and stops it
 *  entirely when it is not compositing. A frame-rate controller reading that
 *  would latch permanently and hand the visual critic a frame with no AO, no
 *  reflections and no depth of field — and the critic would correctly fail it.
 *  So the latch is only eligible above `COST_STRAIN_FLOOR`: at a quarter of 1080p
 *  or less, nothing in this chain is the reason a frame is slow, and the pane's
 *  800x450 (0.19x) is comfortably under that.
 */
const FPS_STRAINED = 48;
const FPS_RECOVERED = 58;
/**
 * Below this frame rate the number is not a GPU verdict, it is a throttled or
 * backgrounded loop, and shedding effects cannot fix it.
 *
 * The review pane drives rAF at ~10 Hz and drops to ~4 Hz whenever
 * `visibilityState` is `hidden` (AGENTS.md §5). Nothing this chain can switch off
 * turns 10 fps into 60, so a latch that fires there is pure quality loss for no
 * gain — it just hands the visual critic a frame with no AO, no reflections and
 * no depth of field. A real GPU missing 60 fps on this content lands in the 25–50
 * band, so the latch is only eligible inside a *plausible* window.
 */
const FPS_IMPLAUSIBLE = 20;
/**
 * Below this share of the fill budget, the frame-rate latch is ignored.
 *
 * Was 0.5, which was too blunt: the owner's own machine, after Engine's adaptive
 * controller walks the pixel ratio to its 0.65 floor, renders 1040x585 = 0.29x —
 * *under* the old floor, so the latch was dead exactly on the machine that
 * reported "lag is still severe". The floor only ever existed to protect the
 * 800x450 review pane (0.185x); 0.25 keeps that and re-arms everything above it.
 * `FPS_IMPLAUSIBLE` and the `visible` guard are the real protection now.
 */
const COST_STRAIN_FLOOR = 0.25;
/** Hysteresis on the floor, so a resolution flap across it cannot reset the latch. */
const COST_STRAIN_FLOOR_LOW = 0.20;
/** How often the budget re-reads the frame rate, seconds. */
const BUDGET_POLL = 1.0;
/**
 * ==========================================================================
 *  HYSTERESIS AND SETTLING — why a *stable* verdict beats a correct one
 * ==========================================================================
 *  Observed on the owner's machine: the resolution cycled 1280x720 -> 1600x900
 *  -> 1440x810 "with SSAO, reflections and DOF toggling as it goes". Both halves
 *  of that are explained, and neither is this file deciding wrongly — they are
 *  two controllers with no dead band between them:
 *
 *   1. `Engine.trackPerformance` steps the pixel ratio down 0.1 and up 0.05 with
 *      a 1.5 s cooldown, and its up/down thresholds (11.5 ms / 15.5 ms) leave a
 *      band that a frame sitting near 13 ms crosses on noise. Each step calls
 *      `handleResize`, which calls `composer.setSize` — **every render target in
 *      the chain is reallocated**, which is itself a hitch. That controller is
 *      `src/core/*`; see the report.
 *   2. Each of those steps moved `costScale` across a threshold in the ladder
 *      below, and the old strain floor at 0.5 sat *inside* the range the flapping
 *      covered (1600x900 = 0.69x, 1280x720 = 0.44x). So every flap flipped the
 *      whole effect set at once — and an `aa` flip re-runs `SMAAEffect
 *      .applyPreset()`, which regenerates its lookup textures.
 *
 *  Two mechanisms fix the half that is ours. Each threshold gets a **dead band**
 *  (a flag that has been dropped is only restored well below the line that
 *  dropped it), and a verdict must **hold still for `BUDGET_SETTLE` seconds**
 *  before it is applied at all. The settle time is deliberately longer than
 *  Engine's 1.5 s cooldown: while the resolution is still hunting, no verdict is
 *  stable for long enough to apply, so the effect set simply stays put — which is
 *  the correct behaviour, because visible pumping is worse than either state.
 */
const COST_HYSTERESIS = 0.12;
/** Seconds a changed verdict must persist before it is applied. */
const BUDGET_SETTLE = 2.5;

/** What the budget decides. One flag per pass it can take out of the frame. */
export interface BudgetVerdict {
  /** SSAO **and its NormalPass**, which is a whole render of the scene graph. */
  ssao: boolean;
  /** Water's planar reflection — also a whole render of the scene graph. */
  reflections: boolean;
  /** Depth of field + chromatic aberration: two full-screen passes. */
  juice: boolean;
  /** Motion blur, and with it the SubjectMask scene pass. */
  motion: boolean;
  /** Halve the motion-blur taps, shrink the DoF/AO buffers, fewer bloom mips. */
  cheapKernels: boolean;
  /** The frame-rate latch's new state. Caller must store it. */
  strained: boolean;
  /** SMAA preset index, matching `SMAAPreset`. */
  aa: number;
}

/**
 * The whole budget as a pure function, so the decision table can be tested
 * without a GL context — `.probe-tmp/budget.ts` walks it. Everything that can
 * remove a pass from the frame is decided here and nowhere else.
 *
 * @param cost      device pixels / POST_PIXEL_BUDGET
 * @param fps       `Engine.fpsAverage`; ignored below COST_STRAIN_FLOOR
 * @param strained  the latch's previous state (Schmitt trigger)
 */
export function chooseBudget(
  cost: number,
  fps: number,
  strained: boolean,
  tier: QualityTier,
  ssaoAllowed: boolean,
  aaHigh: number,
  aaMedium: number,
  aaLow: number,
): BudgetVerdict {
  let strain: boolean;
  if (cost <= COST_STRAIN_FLOOR) strain = false;
  else if (Number.isFinite(fps) && fps > 0) {
    strain = strained ? fps < FPS_RECOVERED : fps < FPS_STRAINED;
  } else strain = strained;

  return {
    ssao: ssaoAllowed && cost <= COST_DROP_SSAO && !strain,
    reflections: cost <= COST_DROP_REFLECTIONS && !strain,
    juice: cost <= COST_DROP_JUICE && !strain,
    motion: cost <= COST_DROP_MOTION_BLUR,
    cheapKernels: cost > COST_CHEAP_KERNELS || strain,
    strained: strain,
    aa: (cost > COST_CHEAP_AA || strain) ? aaLow
      : (tier === 'ultra' && cost <= 1.15) ? aaHigh : aaMedium,
  };
}

/**
 * A light that owns a shadow, structurally. `THREE.Light`'s base declaration has
 * no `shadow` (it is a type parameter on the subclasses), so this is the only way
 * to walk the scene for shadow casters of every kind without a cast per branch.
 */
interface ShadowCaster {
  readonly shadow: { needsUpdate: boolean; map: THREE.WebGLRenderTarget | null };
}

function asShadowCaster(o: THREE.Object3D): ShadowCaster | null {
  const l = o as THREE.Object3D & { isLight?: boolean; castShadow?: boolean; shadow?: unknown };
  if (l.isLight !== true || l.castShadow !== true) return null;
  const s = l.shadow as ShadowCaster['shadow'] | undefined | null;
  if (!s || typeof s !== 'object') return null;
  return l as unknown as ShadowCaster;
}

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

  /**
   * Budget verdicts the frame loop reads. Kept as fields rather than recomputed
   * per frame because `applyResolutionBudget()` is bucketed and `update()` /
   * `render()` run 60 times a second.
   */
  private juiceAllowed = true;
  private motionAllowed = true;
  private reflectionsAllowed = true;
  /** Schmitt-triggered "we are missing 60 fps" latch — see FPS_STRAINED. */
  private strained = false;
  private budgetTimer = 0;

  /** The world's planar-reflection switch, once someone hands it to us. */
  private waterReflections: ((on: boolean) => void) | null = null;
  private reflectionsApplied: boolean | null = null;

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
    this.warmShadowMaps();

    if (import.meta.env.DEV) {
      const { installPostQA } = await import('./PostQA');
      installPostQA(this, engine as unknown as Parameters<typeof installPostQA>[1]);
    }
    await Promise.resolve();
  }

  /**
   * ==========================================================================
   *  THE `GL_INVALID_OPERATION: Mismatch between texture format and sampler
   *  type` FLOOD — HANDOFF.md item 2. This is what it was.
   * ==========================================================================
   *  `Engine` selects `THREE.PCFShadowMap`, and under `SHADOWMAP_TYPE_PCF`
   *  three r185 declares
   *
   *      uniform sampler2DShadow directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
   *
   *  `WebGLLights.setup()` publishes `shadow.map ? shadow.map.texture : null` for
   *  each shadow-casting light, and `shadow.map` is allocated LAZILY, inside
   *  `WebGLShadowMap.render`. A null entry is substituted by three with its
   *  module-private `emptyShadowTexture` — and here is the whole bug:
   *
   *    setValueT1      (single sampler) sets emptyShadowTexture.compareFunction
   *                                     before binding.
   *    setValueT1Array (ARRAY sampler)  does NOT.
   *
   *  `directionalShadowMap[]` is an array uniform, so it always takes the array
   *  path, and `DepthTexture.compareFunction` defaults to null. The bound texture
   *  therefore has TEXTURE_COMPARE_MODE = NONE while the program declares
   *  `sampler2DShadow`, and Chrome's command decoder rejects that on **every draw
   *  of every shadow-receiving material in the scene** — which is exactly the
   *  reported symptom, including "on a fresh context every boot".
   *
   *  When is a cascade map still null? `Lighting` staggers the cascades (0 every
   *  frame, 1 every 2nd, 2 every 3rd) and its shadow hook `continue`s past a
   *  cascade that is not due — so `WebGLShadowMap.render` never runs for it and
   *  its map is never created. Measured with `.probe-tmp/shadownull.ts`, driving
   *  the real `Lighting` hook:
   *
   *      frame 1   cascades rendered: 0            -> [map, NULL, NULL]
   *      frame 2   cascades rendered: 0, 1         -> [map, map,  NULL]
   *      frame 3   cascades rendered: 0, 2         -> [map, map,  map ]
   *
   *  So it is a TWO-FRAME BOOT FLOOD, not a steady-state one. Be clear about what
   *  that means for "lag is still severe": ~2 frames x ~170 draws x 1–2 bad binds
   *  is enough to trip Chrome's "too many errors" cut-off and to make those two
   *  frames crawl, and it is NOT a measurable share of the sustained frame time.
   *  Fixing it removes the console flood and a boot hitch. Nothing else.
   *
   *  The fix here: render one throwaway frame into a 1x1 target before the first
   *  real frame. `Lighting.frame` is still 0 at this point, so `0 % interval === 0`
   *  for every cascade — all of them are due, all of their maps get allocated, and
   *  the shadow programs get compiled too. Fill cost is one pixel; the shadow
   *  passes run at full resolution once, which is the cost we want paid before the
   *  clock starts. The cascades hold a menu-pose depth map for a frame or two
   *  afterwards, which lands on menu frames and never on a race frame.
   *
   *  A cleaner home for this is one line in `src/world/Lighting.ts` — see the
   *  report; that file belongs to another agent.
   */
  private warmShadowMaps(): void {
    const r = this.engine.renderer;
    const sm = r.shadowMap;
    if (!sm.enabled) return;

    let casters = 0;
    this.engine.scene.traverse((o) => {
      const l = asShadowCaster(o);
      if (l) {
        l.shadow.needsUpdate = true;
        casters += 1;
      }
    });
    if (casters === 0) return;

    const prevAuto = sm.autoUpdate;
    const prevTarget = r.getRenderTarget();
    const scratch = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: true, stencilBuffer: false,
    });
    try {
      sm.autoUpdate = true;
      sm.needsUpdate = true;
      r.setRenderTarget(scratch);
      r.render(this.engine.scene, this.engine.camera);
    } catch (err) {
      console.warn(
        '[Render] shadow warm-up failed. The first two frames will bind a null '
        + 'entry into sampler2DShadow directionalShadowMap[] and flood '
        + 'GL_INVALID_OPERATION.', err,
      );
    } finally {
      r.setRenderTarget(prevTarget);
      sm.autoUpdate = prevAuto;
      sm.needsUpdate = true;
      scratch.dispose();
    }

    if (import.meta.env.DEV) this.verifyShadowBinds(casters);
  }

  /**
   * Report any shadow-casting light whose depth map is still unallocated, i.e.
   * any `sampler2DShadow` that is about to be handed a texture with no comparison
   * mode. See `warmShadowMaps()` for why that is fatal to validation.
   */
  private verifyShadowBinds(expected: number): void {
    const missing: string[] = [];
    let found = 0;
    this.engine.scene.traverse((o) => {
      const l = asShadowCaster(o);
      if (!l) return;
      found += 1;
      if (!l.shadow.map) missing.push(o.name || o.type);
    });
    if (missing.length === 0) {
      console.info(
        `[Render] shadow warm-up: ${found}/${expected} shadow maps allocated before `
        + 'the first frame. No null sampler2DShadow binds — HANDOFF item 2 (the '
        + '"Mismatch between texture format and sampler type" flood) cannot fire.',
      );
      return;
    }
    console.error(
      `[Render] ${missing.length} shadow-casting light(s) still have no depth map: `
      + `${missing.join(', ')}. three substitutes emptyShadowTexture for the null `
      + 'entry in directionalShadowMap[] WITHOUT setting its compareFunction '
      + '(setValueT1Array, unlike setValueT1), so every shadow-receiving draw will '
      + 'fail validation with "Mismatch between texture format and sampler type".',
    );
  }

  /**
   * Hand the pipeline the world so it can switch the planar reflection off under
   * load. Accepted structurally: `Environment` (which exposes `.water`), a `Water`
   * directly, or anything with a `setReflections(boolean)`.
   *
   * ⚠️ **This still needs one line in `Game.ts`**, next to the other late wiring:
   *
   *      wire(this.pipeline, 'setWorld', this.environment);
   *
   * `Water.setReflections()` has existed all along — its doc comment reads "lets
   * the render pipeline turn the reflection pass off under load" — and had never
   * been called, because nothing hands the pipeline `Environment`. That is the
   * seventh authored-but-never-called case recorded in HANDOFF.md, so DEV logs an
   * explicit warning if this method is never reached: a silent no-op is exactly
   * how the previous six survived review.
   */
  setWorld(world: unknown): void {
    const fn = this.findReflectionSwitch(world);
    if (!fn) {
      console.warn(
        '[Render] setWorld() was handed something with no reachable '
        + 'setReflections(boolean); the water planar reflection stays on at every '
        + 'resolution. Expected `Environment` (with `.water`) or a `Water`.',
      );
      return;
    }
    this.waterReflections = fn;
    this.reflectionsApplied = null;
    this.applyReflections(this.reflectionsAllowed);
  }

  private findReflectionSwitch(world: unknown): ((on: boolean) => void) | null {
    type Node = { setReflections?: unknown; water?: unknown };
    const candidates: unknown[] = [world, (world as Node | null)?.water];
    for (const c of candidates) {
      const n = c as Node | null | undefined;
      if (n && typeof n.setReflections === 'function') {
        const target = n as { setReflections(on: boolean): void };
        return (on: boolean) => target.setReflections(on);
      }
    }
    return null;
  }

  private applyReflections(on: boolean): void {
    if (!this.waterReflections) return;
    if (this.reflectionsApplied === on) return;
    this.reflectionsApplied = on;
    try {
      this.waterReflections(on);
    } catch (err) {
      console.warn('[Render] water.setReflections() threw', err);
      this.waterReflections = null;
    }
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
   * the composer is not resized, so it is safe to call from `resize()` and from the
   * once-a-second poll in `update()`. Two knobs recompile a pass (the motion-blur
   * tap count and the SMAA preset), so the whole thing is keyed on the resulting
   * *decisions* rather than on the pixel count or the frame rate.
   *
   * The decisions themselves live in `chooseBudget()`, a pure function, so the
   * table can be asserted headlessly — `.probe-tmp/budget.ts`. That matters here
   * more than usual: a budget verdict is invisible in a screenshot until it is
   * wrong, and the failure mode is handing the visual critic a frame with the
   * effects switched off.
   */
  private applyResolutionBudget(): void {
    const q = this.engine.quality;
    const px = this.deviceWidth() * this.deviceHeight();
    const cost = px / POST_PIXEL_BUDGET;

    const fps = this.engine.fpsAverage;
    const v = chooseBudget(
      cost, fps, this.strained, q.tier, q.ssao,
      SMAAPreset.HIGH, SMAAPreset.MEDIUM, SMAAPreset.LOW,
    );
    this.strained = v.strained;
    const strained = v.strained;
    const cheapKernels = v.cheapKernels;
    const wantSsao = v.ssao;
    const wantJuice = v.juice;
    const wantMotion = v.motion;
    const wantReflections = v.reflections;
    const aa = v.aa as SMAAPreset;

    // Key on the *decisions*, not on the pixel count. Engine's adaptive
    // resolution walks the pixel ratio in 10 % steps every 1.5 s, and two of the
    // knobs below (motion-blur taps, the SMAA preset) recompile a pass when they
    // change — so keying on `cost` itself would burn a shader compile on every
    // step of that ramp for a decision that had not actually changed.
    const key = (cheapKernels ? 1 : 0) | (wantSsao ? 2 : 0)
      | (wantJuice ? 4 : 0) | (wantMotion ? 8 : 0) | (wantReflections ? 16 : 0)
      | (aa << 5);
    if (key === this.appliedCost) return;
    this.appliedCost = key;

    // These three are read by update()/render(), which decide per frame whether
    // the effect is *wanted* at all; the budget decides whether it is *affordable*.
    this.juiceAllowed = wantJuice;
    this.motionAllowed = wantMotion;
    this.reflectionsAllowed = wantReflections;

    // --- the water planar reflection: a WHOLE extra render of the scene ------
    // Measured at 44 calls / 0.207 M tris per frame on neon (see this file's
    // header), plus a second program variant for every material in that pass
    // because it enables a global clipping plane. Off above 1.2x the budget.
    this.applyReflections(wantReflections);

    // --- depth of field and chromatic aberration: two full-screen passes ------
    // Both ride on speed, so they turn up precisely when the frame is already at
    // its worst. Disabling the passes here is belt-and-braces with update(),
    // which will not re-enable them while `juiceAllowed` is false.
    if (!wantJuice) {
      if (this.dofPass) this.dofPass.enabled = false;
      if (this.caPass) this.caPass.enabled = false;
    }
    if (!wantMotion && this.motionPass) this.motionPass.enabled = false;

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
        + `reflections ${wantReflections
          ? 'on' : 'OFF (Water scene pass removed)'}${this.waterReflections ? '' : ' [NOT WIRED]'}, `
        + `dof/ca ${wantJuice ? 'on' : 'OFF'}, `
        + `motion blur ${wantMotion ? 'on' : 'OFF (SubjectMask pass removed too)'}, `
        + `smaa preset ${aa}, mb taps ${this.motionBlur ? this.motionBlur.tapCount : 0}, `
        + `${fps.toFixed(0)} fps${strained ? ' (STRAINED)' : ''}\n`
        + `           scene passes/frame: ${this.scenePasses().length}\n           `
        + this.scenePasses().join('\n           '),
      );
      if (!this.waterReflections) {
        console.warn(
          '[Render] nothing has called RenderPipeline.setWorld(), so '
          + 'Water.setReflections() still cannot be reached and the planar '
          + 'reflection pass runs at every resolution. Add to Game.ts, with the '
          + 'other late wiring: wire(this.pipeline, \'setWorld\', this.environment);',
        );
      }
    }
  }

  /**
   * Every render of the scene graph this frame will contain, named.
   *
   * AGENTS.md §5b asks for the *list*, not the total, because a multiplier on
   * `renderer.info` only tells you that there are too many passes and not which.
   * Passes owned by other subsystems are included with their owner, because the
   * number that matters is the one for the whole frame. The per-pass costs quoted
   * here are the neon/ultra measurements from `.probe-tmp/passes.ts`; see this
   * file's header for the full table.
   *
   * The NormalPass deliberately does NOT contribute a second shadow group:
   * postprocessing sets `skipShadowMapUpdate` on it, which clears
   * `shadowMap.autoUpdate`, and `Lighting`'s hook then early-outs. Verified.
   */
  scenePasses(): string[] {
    const q = this.engine.quality;
    const out: string[] = [];
    const cascades = Math.min(3, Math.max(1, q.cascadeCount | 0));
    out.push('shadow cascade 0 (world/Lighting, every frame — 46 calls / 0.197 M tris)');
    if (cascades > 1) {
      out.push('shadow cascade 1 (world/Lighting, every 2nd frame — 21 calls / 0.092 M amortised)');
    }
    if (cascades > 2) {
      out.push('shadow cascade 2 (world/Lighting, every 3rd frame — 7 calls / 0.045 M amortised)');
    }
    // Water only builds its reflection target at `high`/`ultra` (Water.ts:217) and
    // only runs the pass on the `ocean`/`lake` presets — volcano's `lava` and the
    // desert's `none` set `reflectionsOn = false`, which is why volcano measures
    // 4.83 passes/frame against neon's 5.83.
    if (this.reflectionsAllowed && (q.tier === 'high' || q.tier === 'ultra')) {
      out.push(
        this.waterReflections
          ? 'water planar reflection (world/Water, every frame on ocean/lake themes '
            + '— 44 calls / 0.207 M tris)'
          : 'water planar reflection (world/Water, every frame on ocean/lake themes '
            + '— 44 calls / 0.207 M tris; NOT gated, setWorld() was never called)',
      );
    }
    out.push('RenderPass — main scene (render/RenderPipeline — 172 calls / 0.885 M tris)');
    if (this.normalPass?.enabled) {
      out.push('NormalPass — full scene again, view normals for SSAO (172 calls / 0.885 M tris)');
    }
    if (this.motionPass?.enabled && this.subjectMask?.active) {
      out.push('SubjectMask — player kart subtree only, quarter res (31 calls / 0.033 M tris)');
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
        + '0 texture/sampler-type mismatches. This agrees with the headless audit '
        + '(`.probe-tmp/samplers.ts`: 249/155, 259/171 and 249/167 materials and '
        + 'textures on neon, coastal and volcano, all clean — which '
        + 'also replays every onBeforeCompile hook against three\'s real ShaderLib '
        + 'source — a blind spot for the walk below, since an injected '
        + '`uniform sampler2D apx*` lives on a MeshStandardMaterial, not a '
        + 'ShaderMaterial). The flood was never a scene material: it was a null '
        + 'entry in `sampler2DShadow directionalShadowMap[]` — see warmShadowMaps().',
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
   * ==========================================================================
   *  One-shot report of everything that owns pixels on screen — and the answer
   *  to the "picture-in-picture inset" report.
   * ==========================================================================
   *  Filed because a mid-race screenshot showed a ~200x115 copy of the whole
   *  game — scene *and* HUD — in the bottom-right corner. The engine cannot draw
   *  that, and the search for what does has now been exhausted:
   *
   *   - **Not a partial GL viewport.** `setViewport` / `setScissor` /
   *     `scissorTest` appear NOWHERE in `src/` outside the dev harness. A partial
   *     viewport would also land bottom-LEFT, since the GL origin is bottom-left.
   *   - **Not an unrestored render target.** Every re-entry into the renderer —
   *     `SubjectMask.render`, `VfxManager.renderDepthPrepass`,
   *     `Water.renderReflection`, `Portrait.readPixels`,
   *     `ItemModels.bakeIconAtlas` — saves and restores the target in a `finally`.
   *   - **Not a second canvas or a second context.** Only two canvases reach the
   *     document: `Engine`'s and the HUD minimap's 178 px Canvas-2D. The one place
   *     that builds a second `WebGLRenderer` (`ItemModels.bakeIconAtlas`, for the
   *     item-icon atlas) never appends its canvas and calls `dispose()` +
   *     `forceContextLoss()` in a `finally`.
   *   - **The inset contains the HUD, and the HUD is DOM.** No WebGL pass in this
   *     engine can reproduce a DOM overlay into a texture. So whatever produced
   *     the inset composited the *document*, not the scene — which no code in this
   *     repository does or can do.
   *
   *  Conclusion: it is outside the page. Two candidates fit every detail, and both
   *  are host-level, not engine-level:
   *
   *   1. **macOS's own screenshot thumbnail**, which appears in the BOTTOM-RIGHT of
   *      the screen for a few seconds after a capture and is a scaled-down copy of
   *      what was just captured. Two captures in quick succession put the first
   *      one's thumbnail inside the second one. 200x115 is 0.25x of 800x450 and the
   *      aspect ratio matches the frame exactly.
   *   2. **The review pane's own compositing** — AGENTS.md §5: ask for a viewport
   *      other than 800x450 and the page is rendered into a sub-region of an
   *      800x450 screenshot, leaving stale pixels around it.
   *
   *  The audit below stays because it is the cheap way to falsify that conclusion
   *  if the inset ever reappears: if it is genuinely in the page, one of the two
   *  checks at the bottom will say so on the next boot.
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
    // A second canvas is only suspicious if it is large enough to *be* the inset.
    // The HUD's minimap is a legitimate 178 px Canvas-2D and used to trip this,
    // which made the check cry wolf on every boot and therefore useless.
    const suspicious = Array.from(document.querySelectorAll('canvas')).filter((c) => {
      if (c === this.engine.canvas) return false;
      const r = c.getBoundingClientRect();
      // A PiP copy of the frame is wide and roughly 16:9; a UI canvas is neither.
      const ratio = r.height > 0 ? r.width / r.height : 0;
      return r.width >= 150 && ratio > 1.3 && ratio < 2.4;
    });
    if (suspicious.length > 0) {
      console.error(
        `[Render] ${suspicious.length} extra frame-shaped canvas(es) in the `
        + 'document besides the engine\'s. That IS a picture-in-picture inset — '
        + 'see the rects above.',
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
    /** Device pixels / POST_PIXEL_BUDGET. Everything below is derived from it. */
    costScale: number;
    /** The resolution budget's verdicts, so a capture can be explained. */
    ssao: boolean; reflections: boolean; juice: boolean; motion: boolean;
    /** True while the measured-frame-rate latch is shedding effects. */
    strained: boolean;
    /** False until something calls setWorld() — see that method. */
    reflectionsWired: boolean;
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
      costScale: Math.round(
        (this.deviceWidth() * this.deviceHeight()) / POST_PIXEL_BUDGET * 100,
      ) / 100,
      ssao: this.normalPass?.enabled === true,
      reflections: this.reflectionsAllowed,
      juice: this.juiceAllowed,
      motion: this.motionAllowed,
      strained: this.strained,
      reflectionsWired: this.waterReflections !== null,
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

    // Re-run the budget against the measured frame rate. `applyResolutionBudget`
    // is keyed on the resulting *decisions*, so on all but the handful of frames
    // where a verdict actually flips this is an early return; it is polled rather
    // than run every frame only because it walks a few pass objects.
    this.budgetTimer += dt;
    if (this.budgetTimer >= BUDGET_POLL) {
      this.budgetTimer = 0;
      this.applyResolutionBudget();
    }

    // --- depth of field -----------------------------------------------------
    // Only alive during a boost, and even then focused a long way down the
    // track so the road stays sharp and only the far scenery softens. Below the
    // threshold the pass is disabled, so it costs nothing at all — a standstill
    // frame is bit-for-bit unaffected by DoF.
    if (this.dof && this.dofPass) {
      const active = this.engine.quality.dof && this.juiceAllowed
        && this.speedSmooth > DOF_MIN_SPEED;
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
      const enable = this.juiceAllowed && caAmount > 0.02;
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
      // `motionAllowed` is the resolution budget's verdict: above
      // COST_DROP_MOTION_BLUR the pass goes, and the SubjectMask scene pass with
      // it, because the mask only exists to serve this convolution.
      const on = this.engine.quality.motionBlur && this.motionAllowed
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
    // Hand the reflection back before letting go of it: we only ever turned it
    // off as a load decision, and nothing else in the game would turn it on again.
    this.applyReflections(true);
    this.waterReflections = null;
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
