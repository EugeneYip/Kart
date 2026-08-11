/**
 * ============================================================================
 *  APEX KART — SUBJECT MASK
 * ============================================================================
 *  A quarter-resolution white-on-black silhouette of the player's kart, used by
 *  MotionBlurEffect to keep the subject sharp.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  Camera-reprojection motion blur derives screen-space velocity from depth
 *  under the assumption that the world is static. That assumption holds for
 *  every pixel in a racing frame except one object: the player's kart, which
 *  the chase camera is rigidly bolted behind. Its true screen velocity is ~0,
 *  but it is the *closest* thing in frame, so reprojection reports the
 *  *largest* velocity of anything on screen and smears it worse than the
 *  scenery. See the header of MotionBlurEffect.ts for the alternatives that
 *  were considered and why this one won.
 *
 *  COST
 *  ----
 *  One render of a single kart model — ~15 draw calls, ~25 k triangles — at
 *  0.25x resolution (480x270 on a 1080p frame), with an unlit override material,
 *  no shadows, no environment, no post. The subtree contains no lights, so
 *  `WebGLShadowMap` finds an empty shadow array and does nothing. Everything
 *  else in the renderer's state is saved and restored around the call.
 *
 *  Note on `overrideMaterial`: three only honours `scene.overrideMaterial` when
 *  the render root `isScene`. We deliberately render the kart *in place* — a
 *  subtree of the live scene graph, so its world matrix is whatever the karts
 *  agent already computed this frame — which means the root is not a Scene and
 *  overrideMaterial is ignored. Hence the explicit swap-and-restore below.
 *  Reparenting the kart into a private Scene each frame was the alternative and
 *  it is worse: it fires add/remove events on another subsystem's objects and
 *  silently drops the parent group's transform.
 * ============================================================================
 */

import * as THREE from 'three';

/**
 * Structural view of `KartManager`. Only the one public accessor is used, so
 * this file never imports the karts subsystem and cannot drift with it.
 */
export interface SubjectSource {
  getModel?(kartId: number): THREE.Object3D | null | undefined;
}

/** Rebuild the mesh list this often (frames). Insurance against late additions. */
const RELIST_INTERVAL = 90;

export class SubjectMask {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly flat: THREE.MeshBasicMaterial;

  /** Meshes in the subject subtree, and their real materials while overridden. */
  private readonly meshes: THREE.Mesh[] = [];
  private readonly stashed: Array<THREE.Material | THREE.Material[]> = [];

  private subject: THREE.Object3D | null = null;
  private listAge = RELIST_INTERVAL;

  private readonly scale: number;
  private width = 1;
  private height = 1;

  /** Draw calls the last mask render issued. Reported by the perf HUD. */
  drawCalls = 0;
  /** True once a subject has been resolved and a mask actually rendered. */
  active = false;

  private readonly prevClear = new THREE.Color();

  constructor(scale = 0.25) {
    this.scale = Math.min(1, Math.max(0.1, scale));

    // Plain RGBA8, linear filter, no mipmaps, no depth *texture* — the depth
    // attachment is a renderbuffer that is never sampled. Deliberately the
    // most boring texture in the engine: it is bound into a `sampler2D` in the
    // motion-blur shader and must not be a format/sampler-type mismatch.
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });
    this.target.texture.name = 'SubjectMask';

    this.flat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: false,
      toneMapped: false,
      transparent: false,
      blending: THREE.NoBlending,
      depthTest: true,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    this.flat.name = 'SubjectMaskFlat';
  }

  get texture(): THREE.Texture { return this.target.texture; }

  setSize(width: number, height: number): void {
    const w = Math.max(32, Math.round(width * this.scale));
    const h = Math.max(18, Math.round(height * this.scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.setSize(w, h);
  }

  /** Resolve the player's kart model from whatever the pipeline was handed. */
  resolve(source: unknown): THREE.Object3D | null {
    const s = source as SubjectSource | null;
    if (!s || typeof s.getModel !== 'function') return null;
    let model: THREE.Object3D | null | undefined;
    try {
      model = s.getModel(0);
    } catch {
      return null;
    }
    if (!model || !(model as THREE.Object3D).isObject3D) return null;
    if (model !== this.subject) {
      this.subject = model;
      this.listAge = RELIST_INTERVAL;
    }
    return model;
  }

  private relist(root: THREE.Object3D): void {
    this.meshes.length = 0;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      // Meshes only. Points/Sprites/Lines would not render correctly under a
      // MeshBasicMaterial, and none of them contribute to the silhouette.
      if (m.isMesh && m.geometry) this.meshes.push(m);
    });
    this.listAge = 0;
  }

  /**
   * Render the silhouette. Returns false when there is no subject, in which
   * case the caller must clear the mask uniform rather than reuse a stale one.
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, source: unknown): boolean {
    const root = this.resolve(source);
    if (!root || this.width < 2) {
      this.active = false;
      this.drawCalls = 0;
      return false;
    }

    if (++this.listAge >= RELIST_INTERVAL) this.relist(root);
    if (this.meshes.length === 0) {
      this.active = false;
      this.drawCalls = 0;
      return false;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevAlpha = renderer.getClearAlpha();
    const prevCalls = renderer.info.render.calls;
    renderer.getClearColor(this.prevClear);

    // Swap in the flat material. `visible` is left alone: a hidden part of the
    // kart is hidden in the colour buffer too, so it must not be masked.
    this.stashed.length = 0;
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      this.stashed.push(m.material);
      m.material = this.flat;
    }

    renderer.setRenderTarget(this.target);
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(root, camera);

    for (let i = 0; i < this.meshes.length; i++) {
      this.meshes[i].material = this.stashed[i];
    }
    this.stashed.length = 0;

    renderer.setClearColor(this.prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    this.drawCalls = renderer.info.render.calls - prevCalls;
    this.active = true;
    return true;
  }

  dispose(): void {
    this.target.dispose();
    this.flat.dispose();
    this.meshes.length = 0;
    this.stashed.length = 0;
    this.subject = null;
    this.active = false;
  }
}
