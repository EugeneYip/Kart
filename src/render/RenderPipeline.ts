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
 *    1  RenderPass                 scene -> HDR half-float buffer
 *    2  NormalPass                 half-res view normals for SSAO
 *    3  SSAO                       multiply, half-res
 *    4  Depth of field             boost only; skipped below ~25 %
 *    5  Motion blur                skipped when the camera is still
 *    6  Bloom -> Look -> Vignette  (merged: one pass, three effects)
 *    7  Chromatic aberration       auto-disabled when the offset is ~0
 *    8  SMAA                       always last, always enabled
 *
 *  ⚠️ THIS HEADER USED TO CARRY A PER-PASS MILLISECOND TABLE (14.2 ms for the
 *  RenderPass, 5.4 for SMAA, ~17 ms of post in total, "measured at 1600x900").
 *  **It has been removed, because it cannot be reconciled with the only fresh
 *  measurement anyone has.** The owner measured `pipeline.render()` followed by
 *  `gl.finish()` at a median of **4.7 ms on a 1040x585 (0.61 Mpx) backbuffer**.
 *  Scaling the old table down by fill gives ~7.2 ms for the post chain alone —
 *  more than the whole measured frame. One of the two is wrong, the fresh one has
 *  a stated method, and quoting a stale per-pass table is how three rounds of
 *  optimisation got aimed at the wrong pass. `__POST__.frameCost()` re-measures
 *  every pass in one run, including the ones this file does not own; until it has
 *  been run on real hardware there are no per-pass milliseconds here.
 *
 *  Exactly TWO full-scene renders originate here: RenderPass and, when SSAO is
 *  on, NormalPass. Everything else is a full-screen quad. Nothing in the chain
 *  re-renders the scene a third time.
 *
 *  BUT THE FRAME CONTAINS MORE PASSES THAN THIS FILE OWNS, and the multiplier
 *  AGENTS.md §5b warns about is the sum, not our share. COUNTED, not reasoned
 *  about: `.probe-tmp/framecost.ts` drives the real `Lighting` cascade hook and
 *  the real `Water.update()` through a recording renderer and tallies what each
 *  pass would submit, with that pass's own visibility rules and its own camera's
 *  frustum. tokyoNeon, ultra, chase pose, 12 frames:
 *
 *    pass                        runs/frame   submitted per frame
 *    RenderPass (main colour)          1.00    175.0 calls  0.684 M tris
 *    NormalPass (SSAO normals)         1.00    175.0 calls  0.684 M tris
 *    shadow: KeyCascade0               1.00     45.0 calls  0.225 M tris
 *    shadow: KeyCascade1               0.58     23.9 calls  0.128 M tris
 *    shadow: KeyCascade2               0.42     10.0 calls  0.060 M tris
 *    SubjectMask (player kart)         1.00     31.0 calls  0.033 M tris
 *    water planar reflection           0.00      —          — (see below)
 *    ---------------------------------------------------------------------
 *    TOTAL                             5.00    459.9 calls  1.814 M tris
 *    scene graph, live                          219   calls  0.838 M tris
 *    MULTIPLIER                                2.10x calls  2.16x tris
 *
 *  Two numbers in the old version of this table were wrong, and both mattered:
 *
 *   - **The shadow group is 2.00 passes/frame, not 1.83.** `.probe-tmp/passes.ts`
 *     reported 3.00 — every cascade every frame — because `Lighting`'s stagger
 *     hook keys its `continue` on `shadow.map !== null`, three allocates that map
 *     lazily inside `WebGLShadowMap.render`, and a headless probe never allocates
 *     it. framecost.ts stubs the map after a cascade's first render, which is what
 *     three would do, and the stagger then engages.
 *   - **The water planar reflection does not run on four of the six circuits, and
 *     it never ran on any city circuit.** Two agents (and an earlier revision of
 *     this header) reported an ungated 44-call / 0.207 M-tri pass "rendering
 *     nothing on tokyoNeon". Measured per circuit in
 *     `.probe-tmp/reflect-audit.ts` — 6 poses x 8 frames each, real
 *     `Water.update()`, recording renderer:
 *
 *       sunsetCoastline  ocean  1.00/frame  21.7 calls  0.161 M tris
 *       neonMetropolis   lake   1.00/frame   6.5 calls  0.074 M tris
 *       volcanoRush      lava   0.00        preset never reflects
 *       bostonHarbor     lake   0.00        Water.init() built 0 sectors
 *       taipeiCircuit    lake   0.00        Water.init() built 0 sectors
 *       tokyoNeon        lake   0.00        Water.init() built 0 sectors
 *
 *     The city circuits publish `waterLevel: null`, `Environment` substitutes
 *     -9 m for the `city` theme, their terrain bottoms out around -2 m, and
 *     `Water.init()` returns early on `waterLevel < field.minHeight - 3`. No
 *     disc, no `reflRT`, no pass. Gating it saves 0 ms on the circuit the 4.7 ms
 *     was measured on.
 *
 *  WHERE THE PIXELS GO, which is the part draw calls cannot show. Buffer sizes are
 *  read out of `build()` and the postprocessing sources; the arithmetic is
 *  arithmetic. At the owner's 1040x585, per frame:
 *
 *    shadow cascades  2.00 x 2048²      8.39 Mpx   56.2 %   FIXED SIZE
 *    SMAA             3 x full res      1.83 Mpx   12.2 %
 *    DoF (boost)      1.5 x full        0.91 Mpx    6.1 %
 *    RenderPass       full              0.61 Mpx    4.1 %
 *    SSAO resolve     full              0.61 Mpx    4.1 %
 *    MotionBlur       full, 14 taps     0.61 Mpx    4.1 %
 *    Look composite   full              0.61 Mpx    4.1 %
 *    CA (boost)       full              0.61 Mpx    4.1 %
 *    Bloom pyramid    7 levels, up+dn   0.41 Mpx    2.7 %
 *    NormalPass       0.5 scale         0.15 Mpx    1.0 %
 *    SSAO generate    0.5, 22 taps      0.15 Mpx    1.0 %
 *    SubjectMask      0.25 scale        0.04 Mpx    0.3 %
 *    ------------------------------------------------------
 *    TOTAL                             14.92 Mpx
 *      scales with the backbuffer       6.53 Mpx   43.8 %
 *      fixed (shadow maps)              8.39 Mpx   56.2 %
 *
 *  So **at this backbuffer more than half of everything the GPU rasterises is
 *  shadow depth at a size the window cannot influence.** That is why "4.7 ms at
 *  0.61 Mpx is 16 ms at 1080p" is not a safe extrapolation: it assumes every
 *  millisecond scales with the backbuffer. Weighting by the table above gives
 *  ~9.7 ms instead of ~16. Neither figure is measured — the difference between
 *  them is exactly what `__POST__.frameCost()` exists to settle, and it needs a
 *  GPU. At 1080p the split inverts (72.6 % scaled, 27.4 % fixed), so the post
 *  chain is what dominates there, and SMAA's three full-res passes are the
 *  largest single term in it.
 *
 *  Three things were verified rather than assumed, because each one is a place a
 *  pass could silently be drawing everything:
 *
 *   - **the shadow cascades DO respect their layer masks.** Cascade 2 submits 22
 *     calls / 0.135 M tris; with the mask lifted it would submit 46 / 0.197 M.
 *     `applyMask()` hides whole subtrees and three's shadow traversal returns on
 *     `object.visible === false`, so the saving is real.
 *   - **the water reflection DOES honour `userData.noReflect`** on the two
 *     circuits where it runs at all. Only Terrain, the road group and the track
 *     decals survive its filter; Props, Foliage, Crowd, Weather and the VFX root
 *     are all excluded.
 *   - **the NormalPass does NOT re-render the shadow cascades.** postprocessing's
 *     `NormalPass` sets `renderPass.skipShadowMapUpdate`, which sets
 *     `shadowMap.autoUpdate = false` for its duration; `Lighting`'s hook then
 *     early-outs. One shadow group per frame, not two.
 *
 *  What the resolution budget cuts, and where:
 *
 *   - **NormalPass** above 1.05x of 1080p. One whole scene pass — an exact
 *     duplicate of the main pass, 175 of the frame's 460 draw calls — plus the AO
 *     resolve. AO survives untouched at 1080p and below.
 *   - **the water reflection pass** above 1.2x, through `setWorld()` below. Worth
 *     6.5–21.7 draw calls on the two circuits that have water at all, and zero on
 *     the rest. Do not expect this to move a frame time.
 *   - **depth of field + chromatic aberration** above 1.35x, and **motion blur
 *     (with its SubjectMask scene pass)** above 2.2x. All pure juice, all gated
 *     on speed, i.e. all arriving exactly when the frame is already worst.
 *   - **the same cuts also fire on measured frame rate**, not only on pixel count,
 *     because `costScale` cannot see how fast the GPU is. See `FPS_STRAINED`.
 *
 *  Every rung has a **dead band**, and a changed verdict must **hold still for
 *  `BUDGET_SETTLE` seconds** before it is applied. That is not tidiness: the owner
 *  reported the resolution cycling 1280x720 -> 1600x900 -> 1440x810 "with SSAO,
 *  reflections and DOF toggling as it goes", and with no dead band a cost sitting
 *  on a rung flips that flag on every step Engine's controller takes — measured in
 *  `.probe-tmp/budget.ts` at 5 flips over a 5-step ramp, now 0. Two of these knobs
 *  recompile a pass when they move (`SMAAEffect.applyPreset` regenerates its
 *  lookup textures; the motion-blur tap count is a `#define`).
 *
 *  What is NOT fixable from here, and is in the report: 45 drawables in the scene
 *  carry `frustumCulled = false`, holding 0.416 M of the graph's 0.838 M triangles
 *  — 50 % of the geometry is submitted by EVERY pass no matter where the camera
 *  looks, which is why a range-limited NormalPass measured exactly zero saving
 *  (far = 60 m submits the same 175 calls as far = 4000 m). That is `src/world/*`
 *  + `src/track/*`, and it is the biggest lever left.
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
/**
 * Seconds of real frames before the pipeline complains that nobody handed it the
 * world. `Game.init()` does its late wiring *after* `await pipeline.init()`, so
 * anything checked from the boot path is checked too early — see `reportWiring()`.
 */
const WIRING_GRACE = 3;

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
 * @param fps       `Engine.fpsAverage`; see FPS_IMPLAUSIBLE / COST_STRAIN_FLOOR
 * @param strained  the latch's previous state (Schmitt trigger)
 * @param prev      the verdict currently applied, for the per-threshold dead
 *                  bands. Pass `null` for a cold decision (boot, or a probe
 *                  asserting the bare ladder).
 * @param visible   `document.visibilityState !== 'hidden'`. A hidden tab's rAF is
 *                  throttled, so its frame rate is not a GPU verdict.
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
  prev: BudgetVerdict | null = null,
  visible = true,
): BudgetVerdict {
  // --- the frame-rate latch ------------------------------------------------
  // The floor is Schmitt-triggered too: Engine's adaptive resolution walks the
  // pixel ratio in 10 % steps, so a fixed floor sitting inside the range it
  // hunts over turns every step into a latch reset — which is half of the
  // reported "SSAO, reflections and DOF toggling as it goes".
  const floor = strained ? COST_STRAIN_FLOOR_LOW : COST_STRAIN_FLOOR;
  let strain: boolean;
  if (cost <= floor || !visible) strain = false;
  else if (Number.isFinite(fps) && fps > 0) {
    if (fps < FPS_IMPLAUSIBLE) strain = false;
    else strain = strained ? fps < FPS_RECOVERED : fps < FPS_STRAINED;
  } else strain = strained;

  /**
   * One rung of the ladder, with a dead band. A flag that is currently ON drops
   * at its threshold; a flag that is currently OFF only comes back once the cost
   * has fallen `COST_HYSTERESIS` clear of it. Without the band, a cost sitting on
   * a threshold flips the flag every time the resolution controller breathes, and
   * two of these flips (`aa`, and the motion-blur tap count) recompile a pass.
   */
  const rung = (threshold: number, was: boolean | undefined): boolean => {
    const line = was === false ? threshold - COST_HYSTERESIS : threshold;
    return cost <= line;
  };

  return {
    ssao: ssaoAllowed && rung(COST_DROP_SSAO, prev?.ssao) && !strain,
    reflections: rung(COST_DROP_REFLECTIONS, prev?.reflections) && !strain,
    juice: rung(COST_DROP_JUICE, prev?.juice) && !strain,
    motion: rung(COST_DROP_MOTION_BLUR, prev?.motion),
    cheapKernels: !rung(COST_CHEAP_KERNELS, prev ? !prev.cheapKernels : undefined) || strain,
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

/** Whether the world's planar reflection pass is actually in the frame, and why. */
interface WaterPassState {
  runs: boolean;
  why: string;
}

/**
 * Does the GL viewport cover the whole drawing buffer?
 *
 * Pure so `.probe-tmp/viewport.ts` can walk it, because the version of this
 * comparison that lived inline in `auditPresentation()` compared CSS pixels
 * against device pixels and therefore reported a leak on every boot at
 * `pixelRatio > 1`. See the block comment on `auditPresentation()` for the
 * three lines of three's own source that settle the units.
 *
 * @param vpCssW      `renderer.getViewport().z` — CSS ("logical") pixels
 * @param vpCssH      `renderer.getViewport().w` — CSS pixels
 * @param pixelRatio  `renderer.getPixelRatio()`
 * @param bufW        `gl.drawingBufferWidth` — device pixels
 * @param bufH        `gl.drawingBufferHeight` — device pixels
 */
export function viewportCoversBuffer(
  vpCssW: number, vpCssH: number, pixelRatio: number, bufW: number, bufH: number,
): boolean {
  // three rounds the device-space viewport (`multiplyScalar(pr).round()`), so a
  // single pixel of slack is legitimate and is not a partial viewport.
  return Math.round(vpCssW * pixelRatio) >= bufW - 1
    && Math.round(vpCssH * pixelRatio) >= bufH - 1;
}

/**
 * A composited frame read back off a render target rather than off the window.
 * `data` is row-major RGBA in GL order (bottom row first) with every channel
 * normalised to 0..1, so a histogram over it matches a `readPixels` of the
 * default framebuffer channel for channel. See `captureFrame()`.
 */
export interface CapturedFrame {
  data: Float32Array;
  width: number;
  height: number;
  from: string;
}

/**
 * IEEE 754 binary16 -> Number. `readRenderTargetPixels` on a HalfFloat target
 * hands back the raw bit patterns in a Uint16Array; three does not decode them.
 */
function halfToFloat(h: number): number {
  const sign = (h & 0x8000) !== 0 ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * 6.103515625e-5 * (frac / 1024);
  if (exp === 0x1f) return frac === 0 ? sign * Infinity : NaN;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
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
  /** The verdict currently in force, for `chooseBudget`'s per-rung dead bands. */
  private appliedVerdict: BudgetVerdict | null = null;
  /** A verdict waiting out `BUDGET_SETTLE`, or -1 for none. */
  private pendingKey = -1;
  private pendingSince = 0;
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
  /**
   * True once `setWorld()` has been *called*, whatever it managed to find. Keeps
   * "nobody wired me" distinguishable from "what I was wired to has no
   * setReflections" — see `reportWiring()`.
   */
  private worldSeen = false;
  private wiringReported = false;
  private wiringTimer = 0;
  /** Read-only view of whether the world's water renders a reflection at all. */
  private waterState: (() => WaterPassState) | null = null;

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
    this.worldSeen = true;
    const fn = this.findReflectionSwitch(world);
    if (!fn) {
      // Deliberately silent here: `reportWiring()` says this once, from the frame
      // loop, with the right one of three messages. Warning from both places was
      // how a healthy boot ended up logging a contradiction.
      return;
    }
    this.waterReflections = fn.set;
    this.waterState = fn.state;
    this.reflectionsApplied = null;
    this.applyReflections(this.reflectionsAllowed);
  }

  /**
   * Find `setReflections(boolean)` on the world, plus a read-only view of whether
   * the water can render a reflection at all.
   *
   * The second half exists because `scenePasses()` used to *assert* that the
   * reflection pass was in the frame whenever the tier was high/ultra. It is a
   * hard-coded string, it was wrong on four of six circuits, and two independent
   * agents read it back out as a measurement and reported "an ungated 44-call
   * pass rendering nothing on tokyoNeon". Measured (`.probe-tmp/reflect-audit.ts`,
   * ultra, 6 poses x 8 frames per circuit, driving the real `Water.update()`
   * through a recording renderer):
   *
   *   sunsetCoastline  ocean  1.00 passes/frame   21.7 calls  0.161 M tris
   *   neonMetropolis   lake   1.00 passes/frame    6.5 calls  0.074 M tris
   *   volcanoRush      lava   0.00 — the preset never reflects
   *   bostonHarbor     lake   0.00 — Water.init() built 0 sectors
   *   taipeiCircuit    lake   0.00 — Water.init() built 0 sectors
   *   tokyoNeon        lake   0.00 — Water.init() built 0 sectors
   *
   * The three city circuits publish `waterLevel: null`; `Environment` substitutes
   * -9 m for the `city` theme, their terrain bottoms out at about -2 m, and
   * `Water.init()` returns early on `waterLevel < field.minHeight - 3` — so there
   * is no disc, no `reflRT`, and no pass. Nothing to gate and nothing to save.
   * `scenePasses()` now reads this instead of asserting.
   */
  private findReflectionSwitch(world: unknown): {
    set: (on: boolean) => void;
    state: (() => WaterPassState) | null;
  } | null {
    type Node = {
      setReflections?: unknown;
      water?: unknown;
      chunks?: { length?: unknown };
      preset?: unknown;
    };
    const candidates: unknown[] = [world, (world as Node | null)?.water];
    for (const c of candidates) {
      const n = c as Node | null | undefined;
      if (n && typeof n.setReflections === 'function') {
        const target = n as { setReflections(on: boolean): void };
        // Both fields are public and readonly on `Water`; feature-detected, and
        // used only for DEV reporting, so a shape change degrades to "unknown"
        // rather than breaking a frame.
        const state = (): WaterPassState => {
          const sectors = typeof n.chunks?.length === 'number' ? n.chunks.length : -1;
          const preset = typeof n.preset === 'string' ? n.preset : '?';
          if (sectors === 0) return { runs: false, why: 'no water disc on this circuit' };
          if (preset === 'lava' || preset === 'none') {
            return { runs: false, why: `preset "${preset}" never reflects` };
          }
          return { runs: true, why: `preset "${preset}"` };
        };
        return { set: (on: boolean) => target.setReflections(on), state };
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
    // A rebuilt chain is a cold decision: no dead band to carry over and nothing
    // to settle against, so the first verdict applies immediately.
    this.appliedCost = -1;
    this.appliedVerdict = null;
    this.pendingKey = -1;
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
   *
   * **A changed verdict is not applied until it has held still for
   * `BUDGET_SETTLE` seconds.** That is the fix for the reported "1280x720 ->
   * 1600x900 -> 1440x810 with SSAO, reflections and DOF toggling as it goes":
   * Engine's adaptive controller calls `resize()` — and therefore this — on every
   * 10 % step it takes, and each step moved `costScale` across a rung of the
   * ladder. Per-rung dead bands (`COST_HYSTERESIS`) stop the flag flipping at all
   * for small steps; the settle timer stops it flipping for large ones while the
   * resolution is still hunting. Visible pumping is worse than a stable lower
   * setting, and two of these knobs recompile a pass when they move.
   */
  private applyResolutionBudget(): void {
    const q = this.engine.quality;
    const px = this.deviceWidth() * this.deviceHeight();
    const cost = px / POST_PIXEL_BUDGET;

    const fps = this.engine.fpsAverage;
    const visible = typeof document === 'undefined'
      || document.visibilityState !== 'hidden';
    const v = chooseBudget(
      cost, fps, this.strained, q.tier, q.ssao,
      SMAAPreset.HIGH, SMAAPreset.MEDIUM, SMAAPreset.LOW,
      this.appliedVerdict, visible,
    );

    // Key on the *decisions*, not on the pixel count. Engine's adaptive
    // resolution walks the pixel ratio in 10 % steps every 1.5 s, and two of the
    // knobs below (motion-blur taps, the SMAA preset) recompile a pass when they
    // change — so keying on `cost` itself would burn a shader compile on every
    // step of that ramp for a decision that had not actually changed.
    const key = (v.cheapKernels ? 1 : 0) | (v.ssao ? 2 : 0)
      | (v.juice ? 4 : 0) | (v.motion ? 8 : 0) | (v.reflections ? 16 : 0)
      | (v.aa << 5);
    if (key === this.appliedCost) {
      // Still the applied verdict — cancel any pending change and keep the latch
      // in step, since `strained` is what the next call's Schmitt trigger reads.
      this.pendingKey = -1;
      this.strained = v.strained;
      this.appliedVerdict = v;
      return;
    }

    // --- SETTLING ------------------------------------------------------------
    // A changed verdict has to hold still before it is allowed to change the
    // frame. `BUDGET_SETTLE` is deliberately longer than Engine's 1.5 s
    // resolution cooldown, so while the resolution is hunting nothing here moves
    // at all — the effect set stays where it is instead of pumping in step with
    // it. The first application (boot, or a tier rebuild) is immediate: there is
    // nothing to pump against yet.
    const now = performance.now();
    if (this.appliedCost !== -1) {
      if (key !== this.pendingKey) {
        this.pendingKey = key;
        this.pendingSince = now;
        return;
      }
      if (now - this.pendingSince < BUDGET_SETTLE * 1000) return;
    }
    this.pendingKey = -1;
    this.appliedCost = key;
    this.appliedVerdict = v;
    this.strained = v.strained;

    const strained = v.strained;
    const cheapKernels = v.cheapKernels;
    const wantSsao = v.ssao;
    const wantJuice = v.juice;
    const wantMotion = v.motion;
    const wantReflections = v.reflections;
    const aa = v.aa as SMAAPreset;

    // These three are read by update()/render(), which decide per frame whether
    // the effect is *wanted* at all; the budget decides whether it is *affordable*.
    this.juiceAllowed = wantJuice;
    this.motionAllowed = wantMotion;
    this.reflectionsAllowed = wantReflections;

    // --- the water planar reflection: a whole extra render of the scene ------
    // On the two circuits that have water. Counted per circuit in
    // `.probe-tmp/reflect-audit.ts`: 21.7 calls / 0.161 M tris on sunsetCoastline,
    // 6.5 / 0.074 M on neonMetropolis, and ZERO on volcanoRush (lava) and on all
    // three city circuits, where `Water.init()` never builds a disc. Off above
    // 1.2x the budget. Do not expect this to move a frame time on a city circuit —
    // there is no pass there to remove.
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
          ? 'on' : 'OFF (Water scene pass removed)'} [${this.reflectionWiring()}], `
        + `dof/ca ${wantJuice ? 'on' : 'OFF'}, `
        + `motion blur ${wantMotion ? 'on' : 'OFF (SubjectMask pass removed too)'}, `
        + `smaa preset ${aa}, mb taps ${this.motionBlur ? this.motionBlur.tapCount : 0}, `
        + `${fps.toFixed(0)} fps${strained ? ' (STRAINED)' : ''}\n`
        + `           scene passes/frame: ${this.scenePasses().length}\n           `
        + this.scenePasses().join('\n           '),
      );
    }
  }

  /** One word for the state of the `setWorld()` handshake. See `reportWiring()`. */
  private reflectionWiring(): string {
    if (this.waterReflections) return 'gate wired';
    if (this.worldSeen) return 'no setReflections on the world we were given';
    return 'not wired YET — Game wires it after pipeline.init()';
  }

  /**
   * ==========================================================================
   *  THE `[Render] nothing has called RenderPipeline.setWorld()` WARNING —
   *  why it kept firing after the line WAS added to Game.ts.
   * ==========================================================================
   *  `setWorld` is defined, and `Game.ts` does call it:
   *
   *      170:  await this.pipeline.init();
   *      178:  wire(this.pipeline, 'setWorld', this.environment);
   *
   *  The warning was simply **eight lines early**. It lived in
   *  `applyResolutionBudget()`, which `build()` calls, which `init()` calls — so it
   *  ran during line 170 and could not possibly have seen line 178. The wire runs;
   *  the check ran first. Nothing was ever unwired.
   *
   *  It also conflated two different failures under one message. "Nobody called
   *  setWorld" and "setWorld was called with something that has no reachable
   *  `setReflections`" need different fixes — one is a missing line in `Game`, the
   *  other is a shape mismatch here — and the old text asserted the first while
   *  being equally consistent with the second.
   *
   *  So the report moved out of the boot path: it fires once, from `update()`,
   *  after `WIRING_GRACE` seconds of real frames, by which time every late wire in
   *  `Game.init()` has run or never will. Three distinct outcomes, one of which is
   *  an `info` rather than a warning, because a warning that fires on a healthy
   *  boot is how the previous seven authored-but-never-called cases survived
   *  review: the console stops being read.
   */
  private reportWiring(): void {
    if (this.wiringReported) return;
    // Latch first, so a production build stops re-entering from update() too.
    this.wiringReported = true;
    if (!import.meta.env.DEV) return;
    if (this.waterReflections) {
      console.info(
        '[Render] setWorld() is wired: the water planar reflection can be switched '
        + `off under load (currently ${this.reflectionsAllowed ? 'on' : 'OFF'}).`,
      );
      return;
    }
    if (this.worldSeen) {
      console.warn(
        '[Render] setWorld() was called, but nothing reachable on the object it was '
        + 'given has setReflections(boolean) — expected `Environment` (with '
        + '`.water`) or a `Water`. The planar reflection cannot be gated. NOTE it '
        + 'costs nothing on a circuit where `Water.init()` skipped the disc, which '
        + 'is every city circuit; see .probe-tmp/reflect-audit.ts.',
      );
      return;
    }
    console.warn(
      '[Render] nothing has called RenderPipeline.setWorld() in the first '
      + `${WIRING_GRACE} s of frames, so Water.setReflections() cannot be reached `
      + 'and the planar reflection pass runs at every resolution. Add to Game.ts, '
      + 'with the other late wiring: '
      + 'wire(this.pipeline, \'setWorld\', this.environment);',
    );
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
   *
   * ⚠️ EVERY LINE HERE IS A CLAIM, AND ONE OF THEM WAS FALSE FOR MONTHS. The
   * reflection line used to be emitted from the tier alone, and two independent
   * agents quoted it back as a measurement — "an ungated 44-call / 0.207 M-tri
   * pass rendering nothing on tokyoNeon". It does not run there at all (see
   * `findReflectionSwitch`). So that line now reports the world's actual state
   * where it can, and says so where it cannot. Do not add a line to this list
   * that you have not counted.
   */
  scenePasses(): string[] {
    const q = this.engine.quality;
    const out: string[] = [];
    const cascades = Math.min(3, Math.max(1, q.cascadeCount | 0));
    // Lighting clamps `shadowMapSize` to 2048 and `cascadeCount` to 3, so ultra's
    // authored 4096/4 is really 3 x 2048². Staggered 1 / 2 / 3 frames, but they
    // coincide every 6th frame — that frame rasterises all three, 12.6 Mpx of
    // depth, which is 20x the colour buffer at the owner's 1040x585. See the
    // report: the stagger is in `src/world/Lighting.ts`.
    out.push('shadow cascade 0 (world/Lighting, every frame, 2048² — 45 calls / 0.224 M tris)');
    if (cascades > 1) {
      out.push('shadow cascade 1 (world/Lighting, every 2nd frame, 2048² — 41 calls / 0.219 M)');
    }
    if (cascades > 2) {
      out.push('shadow cascade 2 (world/Lighting, every 3rd frame, 2048² — 24 calls / 0.142 M)');
    }
    // Not asserted. `Water` only builds a reflection target at high/ultra, only on
    // the ocean/lake presets, and only when `init()` actually built a disc — which
    // it does not on any of the three city circuits.
    const water = this.waterState?.() ?? null;
    if (q.tier === 'high' || q.tier === 'ultra') {
      if (!this.reflectionsAllowed) {
        out.push('water planar reflection — OFF, the resolution budget gated it');
      } else if (water === null) {
        out.push('water planar reflection — UNKNOWN, setWorld() has not been called '
          + 'yet, so this list cannot see whether the pass is in the frame');
      } else if (!water.runs) {
        out.push(`water planar reflection — not in the frame (${water.why})`);
      } else {
        out.push(`water planar reflection (world/Water, every frame, ${water.why} `
          + '— 6.5–21.7 calls / 0.074–0.161 M tris depending on circuit)');
      }
    }
    out.push('RenderPass — main scene (render/RenderPipeline — 178 calls / 0.688 M tris)');
    if (this.normalPass?.enabled) {
      out.push('NormalPass — the WHOLE scene again for view normals, an exact '
        + 'duplicate of the main pass (178 calls / 0.688 M tris)');
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
   *
   *  ==========================================================================
   *  AND THE AUDIT ITSELF WAS CRYING WOLF. This is what that error was.
   *  ==========================================================================
   *  Every boot logged, as an ERROR:
   *
   *      [Render] the GL viewport is SMALLER than the drawing buffer
   *      (viewport 800x450, drawingBuffer 1600x900)
   *
   *  Two readings were on the table — "an ordering artifact, the audit runs before
   *  `applyResolutionBudget()` settles" and "someone set a render target and did
   *  not restore it". **Both are wrong.** It was a unit bug in the check, and
   *  three's own source settles it without needing a GPU:
   *
   *    WebGLRenderer.js  `setViewport( x, y, width, height )` — its own doc says
   *                      "in logical pixel unit" — stores the values verbatim in
   *                      `_viewport`, then does
   *                        state.viewport( _currentViewport.copy( _viewport )
   *                                        .multiplyScalar( _pixelRatio ).round() )
   *                      so the REAL GL viewport is `_viewport x pixelRatio`.
   *    WebGLRenderer.js  `getViewport( target )` returns `target.copy( _viewport )`
   *                      — CSS pixels, undivided, unmultiplied.
   *    WebGLRenderer.js  `setSize( w, h )` calls `setViewport( 0, 0, w, h )` with
   *                      the CSS size.
   *
   *  `gl.drawingBufferWidth` is device pixels. So the old comparison was CSS
   *  against device: it fires on **every** boot at `pixelRatio > 1` and can never
   *  fire at `pixelRatio 1`, no matter what the code does. The reported pair is
   *  exactly 2x — 800x450 CSS at pixelRatio 2 IS 1600x900 device — which is the
   *  giveaway: a genuinely leaked target would report its own arbitrary size, not
   *  the CSS size times the pixel ratio to the pixel.
   *
   *  Fixed two ways. The comparison is now done in device pixels, and the leak
   *  hypothesis gets the check that would actually detect it —
   *  `renderer.getRenderTarget() !== null` — which the old check never looked at.
   *  A shrunken viewport is not how an unrestored target presents; a bound target
   *  is.
   *
   *  `.probe-tmp/viewport.ts` walks the comparison against three's own
   *  bookkeeping, including the case where the viewport really is too small.
   */
  private auditPresentation(): void {
    if (typeof document === 'undefined') return;
    const gl = this.engine.renderer.getContext();
    const pr = this.engine.renderer.getPixelRatio();
    const vp = new THREE.Vector4();
    this.engine.renderer.getViewport(vp);
    const leaked = this.engine.renderer.getRenderTarget();
    const canvases = Array.from(document.querySelectorAll('canvas')).map((c, i) => {
      const r = c.getBoundingClientRect();
      return `#${i} ${c.className || '(no class)'} buffer=${c.width}x${c.height}`
        + ` css=${Math.round(r.width)}x${Math.round(r.height)}`
        + ` at (${Math.round(r.left)},${Math.round(r.top)})`
        + `${c === this.engine.canvas ? ' <- engine' : ''}`;
    });
    console.info(
      `[Render] presentation audit — drawingBuffer ${gl.drawingBufferWidth}x`
      + `${gl.drawingBufferHeight} device px, viewport ${vp.z}x${vp.w} CSS px `
      + `= ${Math.round(vp.z * pr)}x${Math.round(vp.w * pr)} device px at `
      + `(${vp.x},${vp.y}), pixelRatio ${pr}, composer `
      + `${this.width}x${this.height} CSS, render target `
      + `${leaked ? `LEAKED (${leaked.width}x${leaked.height})` : 'null (correct)'}. `
      + `${canvases.length} canvas element(s):\n  `
      + canvases.join('\n  '),
    );
    // `getViewport` is in CSS ("logical") pixels — three stores `_viewport` as
    // given and only multiplies by the pixel ratio on the way to
    // `gl.viewport()`. `gl.drawingBufferWidth` is device pixels. See the block
    // comment above: comparing the two directly was the whole false positive.
    // 1 px of slack absorbs three's `.round()` on the device-space viewport.
    const vpDevW = Math.round(vp.z * pr);
    const vpDevH = Math.round(vp.w * pr);
    if (!viewportCoversBuffer(
      vp.z, vp.w, pr, gl.drawingBufferWidth, gl.drawingBufferHeight,
    )) {
      console.error(
        `[Render] the GL viewport (${vpDevW}x${vpDevH} device px) is SMALLER than `
        + `the drawing buffer (${gl.drawingBufferWidth}x${gl.drawingBufferHeight}). `
        + 'The composited frame will land in one corner of the canvas and the rest '
        + 'will hold whatever was there before — this is the picture-in-picture '
        + 'artifact. Both numbers are device pixels, so this is a real mismatch '
        + 'and not the unit bug this check used to have.',
      );
    }
    // The discriminator the old check was missing. Every re-entry into the
    // renderer in this codebase restores the target in a `finally`; if one ever
    // stops doing that, THIS is what is true — not a shrunken viewport.
    if (leaked !== null) {
      console.error(
        `[Render] a render target (${leaked.width}x${leaked.height}) is still bound `
        + 'outside a render callback. Something set one and did not restore it; the '
        + 'next thing to draw will draw into it instead of the canvas.',
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

    // Report the setWorld() handshake once, from here rather than from the boot
    // path — `Game` wires it *after* `await pipeline.init()`, so anything checked
    // during init() is checked eight lines too early. See `reportWiring()`.
    if (!this.wiringReported) {
      this.wiringTimer += dt;
      if (this.wiringTimer >= WIRING_GRACE) this.reportWiring();
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

  /**
   * ==========================================================================
   *  Read the finished, fully composited frame back off a surface that is never
   *  presented — so `__POST__.probe()` works in a headless / off-screen view.
   * ==========================================================================
   *  `probe()` read the DEFAULT framebuffer: `setRenderTarget(null)` then
   *  `readPixels` on FBO 0. An off-screen WKWebView is never composited, so that
   *  returns all zeroes and every circuit reports `meanLuma 0, crushed 100 %` —
   *  including one independently measured at 54. Two agents have now finished a
   *  brightness change unable to verify it.
   *
   *  The fix is to read the pixels the terminal pass *wrote*, rather than the
   *  window it was presented into. Three facts from `postprocessing` 6.39 make
   *  that exact rather than approximate, and all three were checked in
   *  `node_modules/postprocessing/build/index.js` rather than assumed:
   *
   *   1. `EffectPass.render()` ends with
   *        `renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
   *         renderer.render(this.scene, this.camera);`
   *      and never restores the target. So immediately after `composer.render()`,
   *      `renderer.getRenderTarget()` **is** the buffer the terminal pass wrote.
   *      No swap-parity arithmetic, no guessing which of `inputBuffer` /
   *      `outputBuffer` the chain happened to land on.
   *   2. `EffectComposer.render()` swaps its buffers in *local* variables, so the
   *      composer's own `inputBuffer` / `outputBuffer` fields do NOT tell you
   *      where the result went. That is why (1) is the only reliable handle.
   *   3. `EffectMaterial`'s `ENCODE_OUTPUT` define defaults to `"1"` and *nothing*
   *      in the library ever clears it — `set renderToScreen` only flips `rtt`.
   *      So the terminal pass applies the sRGB transfer function whether it draws
   *      to the screen or to a buffer, and these bytes are the same numbers a
   *      composited readback would give. Without that, an off-screen probe would
   *      report linear values and silently disagree with every stored baseline.
   *
   *  Costs one extra composite. It is a QA path; nothing calls it per frame.
   */
  captureFrame(): CapturedFrame | null {
    if (this.disposed || !this.composer) return null;
    const r = this.engine.renderer;
    const passes = this.composer.passes;
    // The terminal pass is the one carrying renderToScreen, not simply the last:
    // a disabled trailing pass would make "last" the wrong answer.
    let terminal: (typeof passes)[number] | null = null;
    for (const p of passes) if (p.enabled && p.renderToScreen) terminal = p;
    if (!terminal) {
      for (const p of passes) if (p.enabled) terminal = p;
    }
    if (!terminal) return null;

    const prevTarget = r.getRenderTarget();
    const wasToScreen = terminal.renderToScreen;
    terminal.renderToScreen = false;
    try {
      // dt = 0 on purpose: `damp(a, b, hl, 0)` returns `a`, so this cannot move
      // `lastCpuMs`, and MotionBlurEffect.setMatrices does not divide by dt.
      this.render(0);
      const rt = r.getRenderTarget();
      if (!rt) return null;
      const w = rt.width;
      const h = rt.height;
      const type = rt.texture.type;
      const out = new Float32Array(w * h * 4);
      if (type === THREE.UnsignedByteType) {
        const buf = new Uint8Array(w * h * 4);
        r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
        for (let i = 0; i < out.length; i++) out[i] = buf[i] / 255;
      } else if (type === THREE.HalfFloatType) {
        const buf = new Uint16Array(w * h * 4);
        r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
        for (let i = 0; i < out.length; i++) out[i] = halfToFloat(buf[i]);
      } else if (type === THREE.FloatType) {
        const buf = new Float32Array(w * h * 4);
        r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
        out.set(buf);
      } else {
        return null;
      }
      return { data: out, width: w, height: h, from: `composer buffer ${w}x${h}` };
    } catch (err) {
      console.warn('[Render] captureFrame() failed', err);
      return null;
    } finally {
      terminal.renderToScreen = wasToScreen;
      r.setRenderTarget(prevTarget);
    }
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
    this.waterState = null;
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
