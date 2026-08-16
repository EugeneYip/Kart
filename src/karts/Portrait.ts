/**
 * ============================================================================
 *  FOXY KART — CHARACTER PORTRAIT STUDIO
 * ============================================================================
 *  Renders a **real 3-D bust** of a racer to an offscreen buffer so the racer
 *  select screen can show the actual character instead of a flat glyph.
 *
 *  Why this file exists: `MenuSystem` has always feature-detected
 *  `KartManager.renderPortrait(id, size)` and fallen back to a procedural
 *  `characterPortrait()` when it was missing — which it always was. The visual
 *  critic's verdict on that fallback was that **all ten portraits are the same
 *  grey visor ellipse**, separated only by a background tint and a corner
 *  letter. The geometry to fix that has existed the whole time; only the framing
 *  and the lighting were missing. That is all this module is.
 *
 *  COMPOSITION — the rules the bust is framed by
 *  ---------------------------------------------
 *   1. **Headwear silhouette dominant.** `Driver.ts` states outright that at
 *      small size the headwear shape *is* the character, so the subject box is
 *      the head node — beret, ears, stalk, brim and all — and the shoulders are
 *      let in underneath by dropping that box's floor, never by zooming out
 *      until the whole rig fits.
 *   2. **Three-quarter view.** The camera sits ~34° off the driver's own axis
 *      and 9° above the focus point, and the head then turns ~11° back toward
 *      the lens. A dead-on portrait throws away the one feature that separates a
 *      fox from a capybara at 40 px: the snout profile.
 *   3. **A 26° lens.** Wide angles fatten a muzzle and splay a hat brim. This is
 *      a portrait, so it gets portrait glass.
 *   4. **Fit by measurement, not by guess.** The camera distance is solved
 *      iteratively against the projected corners of the subject box, so every
 *      racer — a 0.84-scale speedster and a 1.14-scale heavy — ends up filling
 *      the same fraction of the card. `framing()` returns those numbers so a
 *      headless probe can assert it, exactly like `CaptureHarness`'s
 *      `subject.inFrame`.
 *
 *  LIGHTING — its own rig, on purpose
 *  ----------------------------------
 *  The menu is up before the track's lighting exists, and even when it does the
 *  circuit's mood (night neon, volcano red) is the wrong light for a portrait.
 *  So the studio carries a three-point rig plus a hemisphere and a four-stop
 *  gradient environment, all aimed at the origin — the subject is *moved* so its
 *  focus point lands at the origin, which means every light keeps its default
 *  target and the rig is identical for all ten racers.
 *
 *  COST — what one portrait actually allocates
 *  -------------------------------------------
 *  No geometry, no materials, no textures, in the normal case.
 *  `PortraitSubject` carries the live racer's `DriverBuild` and `FaceMaterial`,
 *  so the studio instantiates `Object3D`s over buffers that already exist,
 *  renders, and throws the nodes away. Per *studio* it owns one render target,
 *  one camera, four lights and one 4-texel gradient texture, and `dispose()`
 *  releases them all. A borrowed face material is put back in the exact
 *  expression and blink state it was found in.
 *
 *  ⚠️ The first render pays for shader programs: three's program cache key
 *  includes the light-count hash, so this rig's handful of materials compile
 *  once even though the same material objects are already compiled for the
 *  game's light rig. It is a one-off at menu open, and `KartManager` caches the
 *  finished canvases so it never happens twice.
 *
 *  ⚠️⚠️ THE DEFECT THAT MADE ALL TEN CARDS BLANK — read before touching `env`.
 *  This studio's first revision assigned a **1×4** `DataTexture` ramp to
 *  `scene.environment` with a comment saying "no PMREM, a portrait does not need
 *  a filtered probe". three does not offer that choice: `WebGLCubeUVMaps.get()`
 *  runs `PMREMGenerator.fromEquirectangular()` on *any* equirect environment,
 *  and it sizes the cube from the source — `_setSize(image.width / 4)`, then
 *  `height = 4 * cubeSize`. A 1-px-wide source therefore produced a cube size of
 *  0.25 and a cubeUV target **1 px tall**, so `generateCubeUVSize()` emitted
 *  `#define CUBEUV_TEXEL_HEIGHT 1` — an *integer* literal, because `1.0 / 1`
 *  stringifies as `"1"`. GLSL ES 1.00 has no implicit int→float promotion, so
 *  `uv.y *= CUBEUV_TEXEL_HEIGHT;` failed to compile and **every material in the
 *  portrait scene lost its fragment shader**: skin, fur, cloth, plastic, chrome,
 *  glass, glow, paint and the face atlas. Nothing rasterised, the readback came
 *  back all zeroes, and `compose()` dutifully painted the card art under an
 *  empty bust — ten coloured gradients. The headless probe could not see it
 *  because a fake renderer has no shader compiler.
 *  So: the environment is **256×128** (cube size 64). The floor is 64 px wide —
 *  the cubeUV sampler hard-codes `cubeUV_minTileSize 16.0`, so a cube size under
 *  16 samples outside its own mip chain. And `render()` now *measures* the
 *  readback and refuses a blank one, so this class of failure degrades loudly to
 *  `MenuSystem`'s canvas-2D bust instead of shipping a gradient.
 * ============================================================================
 */

import * as THREE from 'three';
import type { QualitySettings } from '@/core/Types';
import { clamp, clamp01, lerp } from '@/core/MathUtils';
import {
  FACE_EXPRESSIONS, FaceMaterial,
  type FaceExpression, type FaceSpec, type KartMaterialSet, type PaintSpec,
} from './KartMaterials';
import { DriverRig, NEUTRAL_POSE, type DriverBuild, type DriverId } from './Driver';
import type { KartAssets } from './KartModel';

// ---------------------------------------------------------------------------
//  Framing constants
// ---------------------------------------------------------------------------

/** Camera azimuth off the driver's own forward axis, degrees. */
export const PORTRAIT_AZIMUTH_DEG = 34;
/** Camera elevation above the focus point, degrees. */
export const PORTRAIT_ELEVATION_DEG = 9;
/** Vertical field of view. A long lens: this is a portrait, not a fisheye. */
export const PORTRAIT_FOV_DEG = 26;

/**
 * The unit vector from the focus point to the camera, in the driver's own
 * space. **This is the only place the portrait's viewing direction exists.**
 *
 * ⚠️ IT WAS COPIED, AND THE COPY WAS 112.9° WRONG FOR THREE ROUNDS. An earlier
 * card probe re-derived this expression by hand, got the sign of the forward
 * axis wrong, and spent three review cycles photographing the back of every
 * driver's neck while reporting on their faces. A probe that measures the wrong
 * thing is worse than no probe, and the structural fix is that there is nothing
 * left to copy: `frameCamera` calls this, and so does anything checking it.
 *
 * The driver faces -Z, so "in front of the face" is -Z. Offsetting to +X puts
 * the camera on the driver's right — the side `LOOK` turns toward.
 */
export function portraitCameraDir(out: THREE.Vector3): THREE.Vector3 {
  const az = PORTRAIT_AZIMUTH_DEG * (Math.PI / 180);
  const el = PORTRAIT_ELEVATION_DEG * (Math.PI / 180);
  return out.set(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize();
}

const FOV_DEG = PORTRAIT_FOV_DEG;
/**
 * How far below the head box the crop reaches, as a multiple of the head box
 * height. These rigs are small — a fox's whole torso is 0.228 m against a
 * 0.32 m head-and-beret — so this lands the bottom edge on the upper chest.
 * Anything past ~0.9 puts the hips in frame and stops being a bust.
 *
 * Tightened from 0.55 once the render could actually be looked at: at 0.55 the
 * head-and-headwear box filled 55 % of the card and the faces were small, with
 * a band of chest and sleeve under them. 0.34 takes it to ~64 %, which is the
 * proportion an MK8 select icon uses.
 */
const SHOULDER_DROP = 0.34;
/** The crop never goes below this height in rig space (hips are at y = 0). */
const CROP_FLOOR = 0.02;
/**
 * How much wider than tall the fit box is allowed to get before the extra width
 * is ignored. 1.30 keeps the capybara's hat brim inside the card at 220 px while
 * bringing its head back to the same apparent size as the rest of the roster.
 */
const PORTRAIT_MAX_ASPECT = 1.30;
/**
 * Fraction of the half-frame the subject box's worst corner is fitted to. The
 * fit is solved, not guessed, so this is also the guaranteed `worst` NDC in the
 * framing report — 0.90 leaves a 5 % margin against the 0.95 in-frame limit.
 */
const FILL = 0.90;
/** Subject lift above frame centre, in fractions of the subject box height. */
const HEAD_RISE = 0.04;
/** Head yaw back toward the lens (`DriverPose.look`, + = look right). */
const LOOK = 0.22;
/**
 * Default card expression. Per-character override in `FaceSpec.portrait`.
 *
 * ⚠️ THIS USED TO BE THE ONLY ANSWER AND IT CLOSED A CHARACTER'S EYES. The
 * animal cell draws `happy` on a capybara as "eyes squeezed with joy" —
 * `lid = 1, squint = true` — so Capy, one of the two named characters, was the
 * only racer on the board with no eyes at all. A product shot is not a reaction
 * shot; which face a character wears for their portrait is a per-character
 * decision, so it lives with the character.
 */
const PORTRAIT_EXPRESSION: FaceExpression = 'happy';

/** The expression this racer's card wears. */
function portraitExpression(spec: FaceSpec): FaceExpression {
  return spec.portrait ?? PORTRAIT_EXPRESSION;
}
/** Supersample factor. Cheaper and cleaner than MSAA plus a resolve. */
const SUPERSAMPLE = 2;
/** Iterations of the distance solve. Converges to <0.5 % in three. */
const FIT_STEPS = 4;
/**
 * Equirect environment size. **Width must be ≥ 64** — see the PMREM note in the
 * file header. 256 gives a cube size of 64, which is what a real HDR probe of
 * this kind produces and leaves margin above the 16-px sampler floor.
 */
const ENV_W = 256;
const ENV_H = 128;
/**
 * Minimum fraction of the readback that must carry ink before a portrait is
 * believed. A framed bust covers 30–60 % of the card; anything under this is a
 * failed rasterisation, not a thin character.
 */
const MIN_INK = 0.02;
/**
 * Hand target for a portrait-only rig (nothing to borrow). A constant rather
 * than module scratch: `KartAssets.driverFor` quantises this into a cache key,
 * and a key that moved between calls would build a rig per portrait.
 */
const PORTRAIT_HAND_TARGET = new THREE.Vector3(0, 0.16, -0.30);

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

/** Everything the studio needs to know about one racer. */
export interface PortraitSubject {
  /** Character id, for cache keys and error messages. */
  id: string;
  driverId: DriverId;
  /** Material-set cache key. Use the racer's real one so nothing is rebuilt. */
  paintKey: string;
  paint: PaintSpec;
  faceSpec: FaceSpec;
  /**
   * The live racer's rig geometry. Supplying it makes a portrait cost zero
   * geometry; omitting it builds one (cached in `KartAssets`) on a portrait-only
   * key.
   */
  build?: DriverBuild | null;
  /**
   * The live racer's face material, borrowed for the duration of one render and
   * restored afterwards. Omit and the studio builds a cheap throwaway and
   * disposes it.
   */
  face?: FaceMaterial | null;
  /** Card art: primary paint, accent, emissive accent. */
  colorA: number;
  colorB: number;
  glow: number;
}

/** NDC bounds of a projected box. */
export interface NdcBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where the subject landed in the frame. Same discipline as the QA harness's
 * `subject.inFrame`: a portrait that framed the driver's knees is not a
 * portrait, and a number is the only way to know that without eyes on it.
 */
export interface PortraitFraming {
  id: string;
  /** Subject (head + shoulders) NDC bounds, from the projected box corners. */
  box: NdcBox;
  /** Head + headwear NDC bounds only. */
  head: NdcBox;
  /** Head centre in NDC — the card's rim halo is centred here. */
  headCentre: { x: number; y: number };
  /** True when every subject corner is in front of the lens and inside ±limit. */
  inFrame: boolean;
  /** Worst |ndc| over the subject box corners. */
  worst: number;
  /** Fraction of the frame height the head box occupies. */
  headFill: number;
  /** Camera distance to the focus point, metres. */
  distance: number;
  behind: boolean;
}

/** NDC bound a framing must stay inside — mirrors `CaptureHarness`'s 0.95. */
export const PORTRAIT_NDC_LIMIT = 0.95;

interface Prepared {
  rig: DriverRig;
  framing: PortraitFraming;
  /** Undo everything borrowed from the live game. */
  release(): void;
}

// Module-level scratch. Portraits are not a hot loop, but a per-corner
// allocation would still be silly.
const _box = new THREE.Box3();
const _head = new THREE.Box3();
const _size = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _col = new THREE.Color();

// ---------------------------------------------------------------------------

export class PortraitStudio {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly assets: KartAssets;
  private readonly quality: QualitySettings;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private env: THREE.DataTexture | null = null;
  private lights: THREE.Light[] = [];
  private target: THREE.WebGLRenderTarget | null = null;
  private targetSize = 0;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, assets: KartAssets, quality: QualitySettings) {
    this.renderer = renderer;
    this.assets = assets;
    this.quality = quality;

    this.scene = new THREE.Scene();
    this.scene.name = 'portrait-studio';
    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, 12);
    this.camera.name = 'portrait-camera';

    this.buildLights();
  }

  /** Live GPU resources this studio is holding — asserted by the probe. */
  stats(): { targets: number; lights: number; env: number; size: number } {
    return {
      targets: this.target ? 1 : 0,
      lights: this.lights.length,
      env: this.env ? 1 : 0,
      size: this.targetSize,
    };
  }

  // -------------------------------------------------------------------------
  //  Light rig
  // -------------------------------------------------------------------------

  /**
   * Three-point rig authored in the *subject's* space, which works because the
   * subject is always moved to the origin: key from front-camera-left and high,
   * fill from the shadow side at a third of the power and a cold tint, rim from
   * behind and above to cut the silhouette off the background. Plus a hemisphere
   * so the underside of a hat brim is not solid black, and a gradient
   * environment so chrome, glass and clearcoat have something to reflect.
   */
  private buildLights(): void {
    const key = new THREE.DirectionalLight(0xfff4e2, 3.1);
    key.position.set(-1.35, 1.60, -1.55);

    const fill = new THREE.DirectionalLight(0x9fc4ff, 1.05);
    fill.position.set(1.70, 0.45, -1.10);

    const rim = new THREE.DirectionalLight(0xffd9a0, 2.7);
    rim.position.set(0.55, 1.15, 1.85);

    const hemi = new THREE.HemisphereLight(0xa8c8ff, 0x33291d, 0.62);

    this.lights = [key, fill, rim, hemi];
    for (const l of this.lights) this.scene.add(l);

    const env = buildEnvironment(key.position, fill.position);
    this.env = env;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.9;
  }

  // -------------------------------------------------------------------------
  //  Rig + framing
  // -------------------------------------------------------------------------

  /**
   * Instantiate the rig, pose it, place the camera, and measure where the
   * subject landed. Every caller must invoke `release()` on the result.
   */
  private prepare(subject: PortraitSubject): Prepared {
    const lib = this.assets.lib;
    const mats: KartMaterialSet = lib.getSet(subject.paintKey, subject.paint);

    // Geometry: the live racer's rig when we were handed one, else a
    // portrait-only build. `driverFor` caches, so ten portraits build ten at
    // most, once, ever.
    const build = subject.build ?? this.assets.driverFor(
      subject.driverId, PORTRAIT_HAND_TARGET, 0.11, 1, 1,
    );

    // Face: borrow the live one and put it back, or build a cheap throwaway. The
    // borrow is what keeps a portrait free — a face atlas is a 1248×416 canvas.
    let ownFace: FaceMaterial | null = null;
    let restore: (() => void) | null = null;
    let face: FaceMaterial;
    if (subject.face) {
      face = subject.face;
      const before = face.atlasState;
      restore = () => { face.setAtlasState(before); };
    } else {
      // The face panel is a small part of the head even at portrait framing, so
      // the throwaway atlas does not need the full-tier cell size.
      ownFace = new FaceMaterial(
        subject.faceSpec, { ...this.quality, tier: 'low' }, lib.furNormal,
      );
      face = ownFace;
    }

    // Per-slot materials (`merged = null`): the portrait is the one place the
    // tiling fur / knit normal maps earn their draw calls, and the merged atlas
    // is the one thing that cannot carry them.
    const expression = portraitExpression(subject.faceSpec);
    const rig = new DriverRig(build, mats, face, `portrait:${subject.id}`, null);
    rig.setLod(0);
    rig.setExpression(expression);
    // `snap` writes the pose with no easing — and ticks the blink timer, which is
    // why the atlas state is forced afterwards rather than before.
    rig.snap({ ...NEUTRAL_POSE, look: LOOK });
    face.setAtlasState({
      expr: Math.max(0, FACE_EXPRESSIONS.indexOf(expression)),
      blink: false,
    });

    // Reduce the rig to a real bust: head + torso, nothing else.
    //
    // This is the one thing about this module that could only be found by LOOKING
    // at a render, which is why it was wrong for the whole of its first life.
    // `driverFor` poses the hands at a steering-wheel target, so at a
    // three-quarter framing both forearms swing forward and read as two dark
    // blobs under the chin; and Foxy's tail — mounted on `hips`, and the thing
    // `Driver.ts` says owns her silhouette from behind — swings into the top-left
    // corner as a stray orange mass with a cream tip. Both are right for a kart
    // seen from the chase camera and wrong for a select-screen icon.
    //
    //  - `rig.root` IS the hips node: everything on it except `torso` is the
    //    tail and the hip shells, all of it below or outside a bust.
    //  - The arm pivots are the torso's non-mesh children (`armL`/`armR`, each
    //    parenting a forearm); the torso's own body meshes are mesh children and
    //    stay.
    //
    // Visibility lives on this rig's own `Object3D`s, never on the borrowed
    // `DriverBuild` geometry, so the live racer on the grid is untouched.
    for (const child of rig.root.children) {
      if (child !== rig.torso) child.visible = false;
    }
    for (const child of rig.torso.children) {
      if (child !== rig.head && !(child as Partial<THREE.Mesh>).isMesh) child.visible = false;
    }

    this.scene.add(rig.root);
    rig.root.position.set(0, 0, 0);
    rig.root.updateMatrixWorld(true);

    const framing = this.frameCamera(subject.id, rig);

    return {
      rig,
      framing,
      release: () => {
        restore?.();
        rig.dispose();
        ownFace?.dispose();
      },
    };
  }

  /**
   * Place the camera so the head owns the frame with the shoulders under it,
   * then project both boxes and report where they landed.
   */
  private frameCamera(id: string, rig: DriverRig): PortraitFraming {
    // The head node carries the cranium, muzzle, ears, face panels and every
    // piece of headwear, so its box *is* the silhouette that has to dominate.
    _head.setFromObject(rig.head);
    if (_head.isEmpty()) _head.setFromObject(rig.root);
    _head.getSize(_size);
    const headH = Math.max(1e-4, _size.y);
    const halfW = Math.max(_size.x, _size.z) * 0.5;

    // Subject box: the head box with its floor dropped onto the chest, widened a
    // shade so a shoulder line is never clipped by a hair.
    _box.copy(_head);
    _box.min.y = Math.max(CROP_FLOOR, _head.min.y - headH * SHOULDER_DROP);
    _box.min.x -= halfW * 0.14;
    _box.max.x += halfW * 0.14;

    // A WIDE ACCESSORY MUST NOT SHRINK THE CHARACTER.
    //
    // The fit solves the camera distance against the *worst* NDC extent of this
    // box, so a subject that is much wider than it is tall fits by width and
    // wastes the vertical frame. Measured: the capybara's floppy bucket-hat brim
    // is 0.49 m across against a 0.32 m head height, which put the camera at
    // 2.24 units where every other driver sits at 1.14–1.48, and its head filled
    // 0.445 of the card against 0.51–0.66 for the rest. In the menu that reads as
    // "Capy is drawn smaller than everybody else", which is exactly the kind of
    // unevenness the roster is being judged on.
    //
    // So the fit box's horizontal and depth extents are clamped to a multiple of
    // its height. The brim is then allowed to run to (or just past) the frame
    // edge — which is what a portrait photographer does with a wide hat — while
    // the head keeps the same apparent size as everyone else's. `_head` is left
    // unclamped so the reported framing still describes the true silhouette.
    _box.getSize(_size);
    const fitH = Math.max(1e-4, _size.y);
    const maxHalf = fitH * PORTRAIT_MAX_ASPECT * 0.5;
    _box.getCenter(_c);
    if (_size.x * 0.5 > maxHalf) { _box.min.x = _c.x - maxHalf; _box.max.x = _c.x + maxHalf; }
    if (_size.z * 0.5 > maxHalf) { _box.min.z = _c.z - maxHalf; _box.max.z = _c.z + maxHalf; }

    _box.getSize(_size);
    const subjH = Math.max(1e-4, _size.y);

    // Move the rig so the focus point lands at the origin: the camera then looks
    // at (0,0,0) and every light keeps its default target. Sitting the box
    // centre slightly *below* the focus point is what lifts the head above the
    // middle of the card.
    _box.getCenter(_c);
    _v.set(-_c.x, -(_c.y - subjH * HEAD_RISE), -_c.z);
    rig.root.position.copy(_v);
    rig.root.updateMatrixWorld(true);
    _head.translate(_v);
    _box.translate(_v);

    // First guess from the bounding sphere, then solve. NDC scales as ~1/d, so
    // `d *= worst / FILL` converges in two or three passes — and solving beats
    // guessing because the ten rigs differ by 1.4× in scale and much more in
    // headwear volume.
    _box.getBoundingSphere(_sphere);
    const vFov = FOV_DEG * (Math.PI / 180);
    let dist = _sphere.radius / Math.max(0.05, Math.tan(vFov * 0.5) * FILL)
      + _sphere.center.length();

    portraitCameraDir(_dir);

    this.camera.aspect = 1;
    this.camera.up.set(0, 1, 0);

    this.placeCamera(dist);
    let box = this.projectBox(_box);
    for (let i = 0; i < FIT_STEPS; i++) {
      const w = worstOf(box);
      if (!Number.isFinite(w) || w <= 1e-4) break;
      const next = dist * (w / FILL);
      const settled = Math.abs(next - dist) < 1e-4;
      dist = next;
      this.placeCamera(dist);
      box = this.projectBox(_box);
      if (settled) break;
    }

    const head = this.projectBox(_head);
    const worst = worstOf(box);
    return {
      id,
      box: round4(box),
      head: round4(head),
      headCentre: {
        x: +((head.x0 + head.x1) * 0.5).toFixed(4),
        y: +((head.y0 + head.y1) * 0.5).toFixed(4),
      },
      inFrame: !box.behind && worst <= PORTRAIT_NDC_LIMIT,
      worst: +worst.toFixed(4),
      headFill: +((head.y1 - head.y0) * 0.5).toFixed(4),
      distance: +dist.toFixed(4),
      behind: box.behind,
    };
  }

  private placeCamera(dist: number): void {
    this.camera.position.copy(_dir).multiplyScalar(dist);
    this.camera.near = Math.max(0.01, dist * 0.25);
    this.camera.far = dist * 3 + 2;
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();
  }

  /** All eight corners of a box, projected to NDC. */
  private projectBox(box: THREE.Box3): NdcBox & { behind: boolean } {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let behind = false;
    for (let i = 0; i < 8; i++) {
      _v.set(
        (i & 1) ? box.max.x : box.min.x,
        (i & 2) ? box.max.y : box.min.y,
        (i & 4) ? box.max.z : box.min.z,
      );
      // Camera space first, so "behind the lens" is a real test rather than a
      // projected value that has silently wrapped.
      _c.copy(_v).applyMatrix4(this.camera.matrixWorldInverse);
      if (_c.z > -1e-4) behind = true;
      _v.project(this.camera);
      x0 = Math.min(x0, _v.x); x1 = Math.max(x1, _v.x);
      y0 = Math.min(y0, _v.y); y1 = Math.max(y1, _v.y);
    }
    return { x0, y0, x1, y1, behind };
  }

  // -------------------------------------------------------------------------
  //  Public API
  // -------------------------------------------------------------------------

  /**
   * Measure the framing without needing a GPU. This is why `prepare` is split
   * out: the headless probe can prove every racer's head is inside the frustum
   * with margin even though it cannot rasterise a single pixel.
   */
  framing(subject: PortraitSubject): PortraitFraming {
    const p = this.prepare(subject);
    try {
      return p.framing;
    } finally {
      p.release();
    }
  }

  /**
   * Render one bust. Returns `null` when this renderer cannot read pixels back
   * (the headless fake renderer) **or when the readback contains no character**,
   * which the caller turns into the canvas-2D fallback rather than a broken
   * image.
   *
   * The ink measurement is the whole reason this returns `null` rather than a
   * canvas: the shipped defect was a perfectly well-formed 220×220 canvas that
   * happened to contain nothing but the card gradient, and every layer above —
   * `KartManager.renderPortrait`, `MenuSystem.buildArt` — treated "a canvas came
   * back" as "it worked". A truthy return is now a claim about pixels.
   */
  render(subject: PortraitSubject, px = 220): {
    canvas: HTMLCanvasElement; framing: PortraitFraming; ink: number;
  } | null {
    if (this.disposed) return null;
    const size = Math.round(clamp(px, 64, 512));
    const ss = size * SUPERSAMPLE;

    const p = this.prepare(subject);
    try {
      const pixels = this.readPixels(ss);
      if (!pixels) {
        warnOnce('readback', `[PortraitStudio] "${subject.id}": this renderer cannot read `
          + 'pixels back, so every portrait will use the canvas-2D fallback.');
        return null;
      }
      const ink = inkOf(pixels);
      if (ink < MIN_INK) {
        warnOnce('blank', `[PortraitStudio] "${subject.id}": the offscreen render came back `
          + `empty (${(ink * 100).toFixed(2)} % ink, needs ${(MIN_INK * 100).toFixed(0)} %). `
          + 'Nothing rasterised — check the console for THREE.WebGLProgram shader errors, '
          + 'which is what a broken environment probe or an unsupported material looks like. '
          + 'Falling back to the canvas-2D bust for the whole roster.');
        return null;
      }
      const canvas = compose(pixels, ss, size, subject, p.framing);
      if (!canvas) {
        warnOnce('compose', `[PortraitStudio] "${subject.id}": no 2-D canvas context, `
          + 'so the bust cannot be composited.');
        return null;
      }
      return { canvas, framing: p.framing, ink };
    } finally {
      p.release();
    }
  }

  /** Render at `ss`×`ss` into the pooled target and read it back, or `null`. */
  private readPixels(ss: number): Uint8Array | null {
    const r = this.renderer as Partial<THREE.WebGLRenderer>;
    if (typeof r.readRenderTargetPixels !== 'function'
      || typeof r.setRenderTarget !== 'function'
      || typeof r.getRenderTarget !== 'function'
      || typeof r.render !== 'function') {
      return null;
    }

    if (!this.target || this.targetSize !== ss) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(ss, ss, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });
      // Ask for display-ready pixels: with an sRGB target three does the
      // linear→sRGB conversion in the shader, so the readback carries the same
      // tone-mapped colour the game shows instead of a dark, washed one.
      this.target.texture.colorSpace = THREE.SRGBColorSpace;
      this.target.texture.generateMipmaps = false;
      this.target.texture.name = 'portrait-rt';
      this.targetSize = ss;
    }

    const prevTarget = this.renderer.getRenderTarget();
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(_col);
    const prevColor = _col.getHex();

    try {
      this.renderer.setRenderTarget(this.target);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, this.camera);
      // Unbind before reading: that is what resolves a lazily-resolved colour
      // attachment into the texture `readRenderTargetPixels` samples.
      this.renderer.setRenderTarget(prevTarget);
      const buf = new Uint8Array(ss * ss * 4);
      this.renderer.readRenderTargetPixels(this.target, 0, 0, ss, ss, buf);
      return buf;
    } finally {
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(prevColor, prevAlpha);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target?.dispose();
    this.target = null;
    this.targetSize = 0;
    for (const l of this.lights) {
      l.removeFromParent();
      l.dispose();
    }
    this.lights.length = 0;
    this.scene.environment = null;
    this.env?.dispose();
    this.env = null;
    this.scene.clear();
    // A camera owns no GPU resource, but it does own a parent link.
    this.camera.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
//  Environment probe
// ---------------------------------------------------------------------------

/** Vertical ramp stops, `v` = 0 straight down, `v` = 1 straight up. */
const ENV_RAMP: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.00, 46, 39, 34],       // under the subject — a dark studio floor
  [0.34, 92, 82, 72],
  [0.47, 148, 138, 126],    // lower horizon
  [0.53, 206, 216, 232],    // upper horizon: the bright band metal picks up
  [1.00, 150, 184, 236],    // zenith
];

function rampAt(v: number): [number, number, number] {
  let i = 1;
  while (i < ENV_RAMP.length - 1 && ENV_RAMP[i][0] < v) i++;
  const a = ENV_RAMP[i - 1];
  const b = ENV_RAMP[i];
  const t = clamp01((v - a[0]) / Math.max(1e-5, b[0] - a[0]));
  return [lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
}

/**
 * The equirect probe: a vertical studio ramp plus a soft lobe for each of the
 * two front lights, so clearcoat and spectacle glass reflect a *shaped*
 * highlight rather than a flat band. Sized per `ENV_W`/`ENV_H` — see the header,
 * the size is load-bearing.
 *
 * `v` = 0 is straight down: three's `equirectUv()` is
 * `v = asin(dir.y) / PI + 0.5`, and a `DataTexture` is `flipY = false`, so row 0
 * of the buffer is the nadir. The first revision of this ramp had it upside down
 * as well as fatally small — the ground tone was at the zenith.
 */
function buildEnvironment(key: THREE.Vector3, fill: THREE.Vector3): THREE.DataTexture {
  const data = new Uint8Array(ENV_W * ENV_H * 4);

  // Light directions in equirect (u, v). Both lobes are warm/cool per their lamp.
  const lobes: Array<{ u: number; v: number; r: number; amp: number; tint: [number, number, number] }> = [];
  const push = (p: THREE.Vector3, r: number, amp: number, tint: [number, number, number]): void => {
    _v.copy(p).normalize();
    lobes.push({
      u: Math.atan2(_v.z, _v.x) / (Math.PI * 2) + 0.5,
      v: Math.asin(clamp(_v.y, -1, 1)) / Math.PI + 0.5,
      r, amp, tint,
    });
  };
  push(key, 0.20, 1.0, [255, 246, 228]);
  push(fill, 0.26, 0.42, [186, 214, 255]);

  for (let y = 0; y < ENV_H; y++) {
    const v = y / (ENV_H - 1);
    const base = rampAt(v);
    for (let x = 0; x < ENV_W; x++) {
      const u = x / ENV_W;
      let r = base[0], g = base[1], b = base[2];
      for (const L of lobes) {
        // Azimuth wraps, so take the shorter way round the sphere.
        let du = Math.abs(u - L.u);
        if (du > 0.5) du = 1 - du;
        const d = Math.hypot(du / L.r, (v - L.v) / (L.r * 0.8));
        if (d >= 1) continue;
        const k = (1 - d * d) * (1 - d * d) * L.amp;
        r = lerp(r, L.tint[0], k);
        g = lerp(g, L.tint[1], k);
        b = lerp(b, L.tint[2], k);
      }
      const i = (y * ENV_W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }

  const env = new THREE.DataTexture(data, ENV_W, ENV_H, THREE.RGBAFormat);
  env.mapping = THREE.EquirectangularReflectionMapping;
  env.colorSpace = THREE.SRGBColorSpace;
  env.magFilter = THREE.LinearFilter;
  env.minFilter = THREE.LinearFilter;
  env.wrapS = THREE.RepeatWrapping;
  env.name = 'portrait-env';
  env.needsUpdate = true;
  return env;
}

// ---------------------------------------------------------------------------
//  Framing helpers
// ---------------------------------------------------------------------------

function worstOf(b: NdcBox): number {
  return Math.max(Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.y0), Math.abs(b.y1));
}

/** Warned keys, so a broken portrait says so exactly once per page load. */
const _warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(message);
}

/**
 * Fraction of the readback carrying visible ink. Sampled on a stride: this runs
 * once per portrait on a 440×440 buffer and every fourth pixel is plenty to tell
 * "a rendered bust" from "an empty framebuffer".
 */
function inkOf(pixels: Uint8Array): number {
  let seen = 0;
  let lit = 0;
  for (let i = 3; i < pixels.length; i += 16) {
    seen++;
    if (pixels[i] > 8) lit++;
  }
  return seen === 0 ? 0 : lit / seen;
}

function round4(b: NdcBox): NdcBox {
  return {
    x0: +b.x0.toFixed(4), y0: +b.y0.toFixed(4),
    x1: +b.x1.toFixed(4), y1: +b.y1.toFixed(4),
  };
}

// ---------------------------------------------------------------------------
//  Canvas composite — the card art behind the bust
// ---------------------------------------------------------------------------

/**
 * Turn the raw RGBA readback into the finished portrait.
 *
 *  1. Un-premultiply. Anything transparent in the buffer (a spectacle lens, a
 *     tinted visor) left the framebuffer premultiplied against a clear alpha of
 *     zero; pasted into a canvas as-is it reads as a dark smear.
 *  2. Flip — GL row 0 is the bottom one.
 *  3. Downscale the supersampled buffer into the final canvas.
 *  4. Fade the bottom edge so the crop through the chest is a fade, not a cut.
 *  5. Paint the card art *underneath* with `destination-over`, so the 3-D bust
 *     is never touched by it.
 */
function compose(
  pixels: Uint8Array, ss: number, size: number,
  subject: PortraitSubject, framing: PortraitFraming,
): HTMLCanvasElement | null {
  const big = make2d(ss, ss);
  const out = make2d(size, size);
  if (!big || !out) return null;

  // --- 1 + 2 -------------------------------------------------------------
  const img = big.g.createImageData(ss, ss);
  const dst = img.data;
  const stride = ss * 4;
  for (let y = 0; y < ss; y++) {
    const src = (ss - 1 - y) * stride;
    const row = y * stride;
    for (let x = 0; x < stride; x += 4) {
      const a = pixels[src + x + 3];
      if (a === 0) continue; // ImageData starts zeroed
      if (a === 255) {
        dst[row + x] = pixels[src + x];
        dst[row + x + 1] = pixels[src + x + 1];
        dst[row + x + 2] = pixels[src + x + 2];
        dst[row + x + 3] = 255;
        continue;
      }
      const k = 255 / a;
      dst[row + x] = Math.min(255, pixels[src + x] * k);
      dst[row + x + 1] = Math.min(255, pixels[src + x + 1] * k);
      dst[row + x + 2] = Math.min(255, pixels[src + x + 2] * k);
      dst[row + x + 3] = a;
    }
  }
  big.g.putImageData(img, 0, 0);

  // --- 3 -----------------------------------------------------------------
  out.g.imageSmoothingEnabled = true;
  out.g.imageSmoothingQuality = 'high';
  out.g.drawImage(big.c, 0, 0, ss, ss, 0, 0, size, size);

  // --- 4: soften the crop ------------------------------------------------
  const fade = out.g.createLinearGradient(0, size * 0.80, 0, size);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  out.g.globalCompositeOperation = 'destination-out';
  out.g.fillStyle = fade;
  out.g.fillRect(0, size * 0.80, size, size * 0.20);

  // --- 5 -----------------------------------------------------------------
  out.g.globalCompositeOperation = 'destination-over';
  paintCard(out.g, size, subject, framing);
  out.g.globalCompositeOperation = 'source-over';

  return out.c;
}

// ---------------------------------------------------------------------------
//  Set-level colour discipline
// ---------------------------------------------------------------------------
/**
 * ⚠️ THE ROSTER PASSED ITS COLOUR GATE AND STILL LOOKED LIKE TEN STICKERS.
 *
 * `.probe-tmp/charqa.ts` has a deltaE FLOOR — every driver separates from their
 * own card. That is legibility, not a palette, and it is satisfied just as well
 * by ten unrelated colours as by a designed set. Measured in
 * `.probe-tmp/palette.ts`, the ten card grounds are:
 *
 *   - clustered in hue: five of them (Nova 38, Ember 50, Capy 53, Foxy 59,
 *     Torque 66 degrees) inside a 28-degree wedge of orange, then gaps of 82
 *     and 87 degrees elsewhere. An even ten-way split would be 36 degrees.
 *   - wild in chroma: 23 (Strata, a muddy slate) to 103 (Vex, neon violet).
 *   - wild in the accent: four near-white creams, two near-blacks, two golds,
 *     one slate blue, one dark purple, with no relationship to each other.
 *   - and the glow that lights the halo runs L 66 to 95, so Zephyr's card had
 *     a halo three times brighter than Foxy's for no authored reason.
 *
 * The hues live in `src/karts/Characters.ts`, which this agent does not own and
 * which is also the kart paint and the HUD colour — they are identity and they
 * should not move. What CAN be fixed here is everything else: the ten cards now
 * share one lighting model and one stage, and differ by hue, which is what
 * makes a set a set.
 *
 * Chroma is compressed toward the roster's midpoint rather than clamped, so the
 * ordering survives and nobody's colour is overruled; lightness is deliberately
 * NOT touched, because the deltaE floor between a driver's pelt and their card
 * is carried almost entirely by lightness and squeezing it would eat the gate.
 * `.probe-tmp/palette.ts` re-measures that floor against these exact functions.
 */
const CHROMA_TARGET = 62;
const CHROMA_PULL = 0.60;
/** Halo luminance every card is normalised to, and its chroma window. */
const HALO_L = 84;
const HALO_C = { min: 38, max: 66 };
/** The shared stage the whole roster stands on. */
const STAGE = '#0d1220';
const STAGE_LOW = '#141c2e';

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** sRGB hex -> CIE LCh(ab). */
function toLch(v: number): { L: number; C: number; h: number } {
  const r = srgbToLinear(((v >> 16) & 255) / 255);
  const g = srgbToLinear(((v >> 8) & 255) / 255);
  const b = srgbToLinear((v & 255) / 255);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = 116 * f(Y) - 16;
  const A = 500 * (f(X) - f(Y));
  const B = 200 * (f(Y) - f(Z));
  let h = Math.atan2(B, A) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { L, C: Math.hypot(A, B), h };
}

/** CIE LCh(ab) -> css hex. */
function fromLch(L: number, C: number, h: number): string {
  const rad = h * Math.PI / 180;
  const A = Math.cos(rad) * C;
  const B = Math.sin(rad) * C;
  const fy = (L + 16) / 116;
  const fx = fy + A / 500;
  const fz = fy - B / 200;
  const inv = (t: number): number => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  const to255 = (c: number): string => Math.round(clamp01(linearToSrgb(clamp01(c))) * 255)
    .toString(16).padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

/**
 * The racer's own hue, with its chroma pulled toward the roster midpoint.
 * Lightness untouched — see the note above.
 */
export function disciplinedGround(v: number): string {
  const c = toLch(v);
  return fromLch(c.L, CHROMA_TARGET + (c.C - CHROMA_TARGET) * CHROMA_PULL, c.h);
}

/** The racer's emissive accent, normalised to one halo strength for the set. */
export function disciplinedHalo(v: number): string {
  const c = toLch(v);
  // A near-neutral glow has no hue worth preserving; give it the cool studio
  // tint rather than amplifying whatever rounding produced its 3 degrees.
  if (c.C < 6) return fromLch(HALO_L, 14, 232);
  return fromLch(HALO_L, clamp(c.C, HALO_C.min, HALO_C.max), c.h);
}

/** The procedural card behind the bust. Canvas 2D, like the rest of the UI art. */
function paintCard(
  g: CanvasRenderingContext2D, size: number,
  subject: PortraitSubject, framing: PortraitFraming,
): void {
  const a = disciplinedGround(subject.colorA);
  const bRaw = toLch(subject.colorB);
  const glow = disciplinedHalo(subject.glow);

  // Head centre in canvas pixels — NDC y is up, canvas y is down.
  const hx = (framing.headCentre.x * 0.5 + 0.5) * size;
  const hy = (0.5 - framing.headCentre.y * 0.5) * size;

  // Ground shadow. The bust has no shadow-casting light, so it gets a painted
  // one — without it the head floats.
  const footY = size * 0.97;
  const shadow = g.createRadialGradient(size * 0.5, footY, 0, size * 0.5, footY, size * 0.44);
  shadow.addColorStop(0, 'rgba(0,0,0,0.55)');
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = shadow;
  g.fillRect(0, 0, size, size);

  // Rim halo behind the head, in the racer's emissive accent.
  const halo = g.createRadialGradient(hx, hy, size * 0.04, hx, hy, size * 0.46);
  halo.addColorStop(0, rgba(glow, 0.50));
  halo.addColorStop(0.45, rgba(glow, 0.15));
  halo.addColorStop(1, rgba(glow, 0));
  g.fillStyle = halo;
  g.fillRect(0, 0, size, size);

  // Radiating light bars — the MK8 select-screen tell. Struck from behind the
  // head so they read as light coming off the character.
  g.save();
  g.translate(hx, hy);
  for (let i = 0; i < 11; i++) {
    const th = (i / 11) * Math.PI * 2 + 0.35;
    const w = 0.055 + (i % 3) * 0.028;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(th - w) * size * 1.7, Math.sin(th - w) * size * 1.7);
    g.lineTo(Math.cos(th + w) * size * 1.7, Math.sin(th + w) * size * 1.7);
    g.closePath();
    g.fillStyle = rgba('#ffffff', i % 2 === 0 ? 0.055 : 0.028);
    g.fill();
  }
  g.restore();

  // Base wash: the racer's paint high, their accent low, dark at the very bottom
  // so the card has a floor for the shadow to sit on.
  //
  // THE TOP LIGHT AND THE FLOOR ARE THE SAME ON ALL TEN. They used to be
  // derived from each racer's own hexes, so the "light" was warm on one card
  // and cold on the next, and the floor ran from a near-white cream (Nova,
  // Pip, Strata, Foxy) to a near-black (Ember, Zephyr) — the single loudest
  // reason the board read as unrelated stickers rather than as one set. The
  // light is now one warm studio white and the floor is one deep stage tone,
  // carrying only a 30 % tint of the racer's accent HUE at a bounded chroma so
  // it still belongs to them.
  const floor = bRaw.C < 8
    ? STAGE_LOW
    : mix(STAGE_LOW, fromLch(38, Math.min(bRaw.C, 48), bRaw.h), 0.30);
  const wash = g.createLinearGradient(0, 0, size * 0.35, size);
  wash.addColorStop(0, mix(a, '#fff6e8', 0.28));
  wash.addColorStop(0.52, a);
  wash.addColorStop(0.86, floor);
  wash.addColorStop(1, STAGE);
  g.fillStyle = wash;
  g.fillRect(0, 0, size, size);

  // Vignette, so the card reads as lit rather than printed.
  const vig = g.createRadialGradient(
    size * 0.5, size * 0.42, size * 0.18, size * 0.5, size * 0.5, size * 0.80,
  );
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(4,7,14,0.60)');
  g.fillStyle = vig;
  g.fillRect(0, 0, size, size);

  // Stipple: a clean gradient is the single most obvious "made in a browser"
  // tell there is.
  const n = Math.round(size * size * 0.05);
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(255,255,255,${(0.012 + Math.random() * 0.03).toFixed(3)})`;
    g.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
}

// ---------------------------------------------------------------------------
//  Small 2D helpers
// ---------------------------------------------------------------------------

function make2d(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  return g ? { c, g } : null;
}

function rgba(css: string, alpha: number): string {
  _col.set(css);
  const r = Math.round(clamp01(_col.r) * 255);
  const gg = Math.round(clamp01(_col.g) * 255);
  const bb = Math.round(clamp01(_col.b) * 255);
  return `rgba(${r},${gg},${bb},${alpha.toFixed(3)})`;
}

function mix(x: string, y: string, t: number): string {
  const cx = new THREE.Color(x);
  const cy = new THREE.Color(y);
  return `#${cx.setRGB(
    lerp(cx.r, cy.r, t), lerp(cx.g, cy.g, t), lerp(cx.b, cy.b, t),
  ).getHexString()}`;
}
