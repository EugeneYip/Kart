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
const AZIMUTH_DEG = 34;
/** Camera elevation above the focus point, degrees. */
const ELEVATION_DEG = 9;
/** Vertical field of view. A long lens: this is a portrait, not a fisheye. */
const FOV_DEG = 26;
/**
 * How far below the head box the crop reaches, as a multiple of the head box
 * height. These rigs are small — a fox's whole torso is 0.228 m against a
 * 0.32 m head-and-beret — so 0.55 lands the bottom edge on the upper chest.
 * Anything past ~0.9 puts the hips in frame and stops being a bust.
 */
const SHOULDER_DROP = 0.55;
/** The crop never goes below this height in rig space (hips are at y = 0). */
const CROP_FLOOR = 0.02;
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
/** Expression every portrait wears. */
const PORTRAIT_EXPRESSION: FaceExpression = 'happy';
/** Supersample factor. Cheaper and cleaner than MSAA plus a resolve. */
const SUPERSAMPLE = 2;
/** Iterations of the distance solve. Converges to <0.5 % in three. */
const FIT_STEPS = 4;
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

    // Environment: a 1×4 vertical ramp (zenith → horizon → ground) used as an
    // equirect. No PMREM — that wants a live renderer, and a portrait does not
    // need a filtered probe to stop metal reading as a black hole.
    const env = new THREE.DataTexture(new Uint8Array([
      164, 196, 244, 255,   // zenith
      206, 216, 232, 255,   // upper horizon
      148, 138, 126, 255,   // lower horizon
      58, 50, 44, 255,      // ground
    ]), 1, 4, THREE.RGBAFormat);
    env.mapping = THREE.EquirectangularReflectionMapping;
    env.colorSpace = THREE.SRGBColorSpace;
    env.magFilter = THREE.LinearFilter;
    env.minFilter = THREE.LinearFilter;
    env.name = 'portrait-env';
    env.needsUpdate = true;
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
    const rig = new DriverRig(build, mats, face, `portrait:${subject.id}`, null);
    rig.setLod(0);
    rig.setExpression(PORTRAIT_EXPRESSION);
    // `snap` writes the pose with no easing — and ticks the blink timer, which is
    // why the atlas state is forced afterwards rather than before.
    rig.snap({ ...NEUTRAL_POSE, look: LOOK });
    face.setAtlasState({
      expr: Math.max(0, FACE_EXPRESSIONS.indexOf(PORTRAIT_EXPRESSION)),
      blink: false,
    });

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

    const az = AZIMUTH_DEG * (Math.PI / 180);
    const el = ELEVATION_DEG * (Math.PI / 180);
    // The driver faces -Z, so "in front of the face" is -Z. Offsetting to +X
    // puts the camera on the driver's right — the side `LOOK` turns toward.
    _dir.set(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      -Math.cos(az) * Math.cos(el),
    ).normalize();

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
   * (the headless fake renderer), which the caller turns into the flat
   * procedural fallback rather than a broken image.
   */
  render(subject: PortraitSubject, px = 220): {
    canvas: HTMLCanvasElement; framing: PortraitFraming;
  } | null {
    if (this.disposed) return null;
    const size = Math.round(clamp(px, 64, 512));
    const ss = size * SUPERSAMPLE;

    const p = this.prepare(subject);
    try {
      const pixels = this.readPixels(ss);
      if (!pixels) return null;
      const canvas = compose(pixels, ss, size, subject, p.framing);
      return canvas ? { canvas, framing: p.framing } : null;
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
//  Framing helpers
// ---------------------------------------------------------------------------

function worstOf(b: NdcBox): number {
  return Math.max(Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.y0), Math.abs(b.y1));
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

/** The procedural card behind the bust. Canvas 2D, like the rest of the UI art. */
function paintCard(
  g: CanvasRenderingContext2D, size: number,
  subject: PortraitSubject, framing: PortraitFraming,
): void {
  const a = hex(subject.colorA);
  const b = hex(subject.colorB);
  const glow = hex(subject.glow);

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
  const wash = g.createLinearGradient(0, 0, size * 0.35, size);
  wash.addColorStop(0, mix(a, '#ffffff', 0.30));
  wash.addColorStop(0.52, a);
  wash.addColorStop(0.86, mix(b, '#101725', 0.45));
  wash.addColorStop(1, '#0d1220');
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

function hex(v: number): string {
  return `#${_col.setHex(v).getHexString()}`;
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
