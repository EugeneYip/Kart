/**
 * ============================================================================
 *  DECALS — skid marks and scorch
 * ============================================================================
 *  A pooled ring buffer of projected quads in a single geometry. Skid marks are
 *  laid as *segments* between the previous and current wheel contact point, so
 *  they form a continuous unbroken stripe through a drift instead of a dotted
 *  line. Everything fades in the shader from a per-quad birth stamp, which means
 *  a decal costs zero CPU after the frame it was laid.
 *
 *  This is one of the cheapest ways to make a track feel raced-on: after a lap
 *  the corners are black with rubber and the off-road shortcuts are scuffed.
 *
 *  (Note: `src/track/Decals.ts` is a different, track-owned module. This one is
 *  purely dynamic race grime.)
 * ============================================================================
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '@/core/Config';
import { SurfaceType, type KartState } from '@/core/Types';
import { clamp01 } from '@/core/MathUtils';
import { fbm2, ihash2, ridged2 } from './sprites/Noise';
import { socketPos, type KartSource, type SocketName, type VfxContext } from './ParticleSystem';

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const U_LOCAL = new THREE.Vector3(0, 1, 0);

const REAR: SocketName[] = ['wheelRL', 'wheelRR'];
const REAR_OFF: Array<[number, number, number]> = [[-0.60, -0.26, 0.62], [0.60, -0.26, 0.62]];

/** Atlas cells: 0 = tyre streak, 1 = scorch blotch. */
const CELL_SKID = 0;
const CELL_SCORCH = 1;

const SKID_LIFE = 12.0;
const SCORCH_LIFE = 26.0;

interface KartSkid {
  /** Previous contact point per rear wheel, and whether it is valid. */
  px: Float32Array; py: Float32Array; pz: Float32Array; ok: Uint8Array;
}

function buildDecalTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size * 2;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[Vfx] 2D context unavailable for decals');
  const img = ctx.createImageData(size * 2, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size * 2; x++) {
      const cell = x < size ? 0 : 1;
      const u = ((x % size) + 0.5) / size;
      let a = 0;
      if (cell === CELL_SKID) {
        // A tyre stripe: hard-ish edges across U, tread grooves along V,
        // heavy grain so it never reads as a clean rectangle.
        const across = 1 - Math.min(1, Math.abs(u - 0.5) / 0.5);
        const body = Math.pow(across, 0.42);
        const grooves = 0.72 + 0.28 * Math.abs(Math.sin(u * Math.PI * 5.5));
        const grain = 0.55 + 0.45 * fbm2(u * 7, v * 22, 4242, 4);
        const patchy = 0.6 + 0.4 * ridged2(u * 3.5, v * 9, 771, 3);
        a = body * grooves * grain * patchy;
        // Chew the long edges so segments blend into each other.
        a *= 0.85 + 0.15 * Math.sin(v * 40 + ihash2(y, 3, 91) * 6.28);
      } else {
        const dx = (u - 0.5) * 2;
        const dy = (v - 0.5) * 2;
        const r = Math.sqrt(dx * dx + dy * dy);
        const th = Math.atan2(dy, dx);
        const lobes = 0.62 + 0.14 * Math.sin(th * 3 + 1.1) + 0.09 * Math.sin(th * 6 - 0.4);
        const edge = 1 - clamp01((r - (lobes - 0.18)) / 0.36);
        const soot = 0.45 + 0.55 * fbm2(u * 5, v * 5, 9001, 5);
        a = clamp01(edge) * soot;
        a *= 0.9 + 0.1 * ridged2(u * 11, v * 11, 313, 3);
      }
      const i = (y * size * 2 + x) << 2;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.max(0, Math.min(255, (a * 255) | 0));
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  // V tiles so a long skid segment repeats its tread grain instead of smearing.
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.name = 'vfx-decal-atlas';
  return tex;
}

const DECAL_VERT = /* glsl */ `
precision highp float;
attribute vec3 aPos;
attribute vec2 aUv;
attribute vec4 aData;    // birth, life, alpha, unused
attribute vec3 aTint;
uniform float uTime;
varying vec2 vUv;
varying vec3 vTint;
varying float vAlpha;
void main() {
  vUv = aUv;
  vTint = aTint;
  float age = (uTime - aData.x) / max(0.001, aData.y);
  // Hold, then fade out over the last 65 % of life.
  float f = 1.0 - smoothstep(0.35, 1.0, age);
  vAlpha = (age < 0.0 || age > 1.0) ? 0.0 : f * aData.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(aPos, 1.0);
}
`;

const DECAL_FRAG = /* glsl */ `
precision highp float;
#include <common>
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vTint;
varying float vAlpha;
void main() {
  if (vAlpha <= 0.002) discard;
  float a = texture2D(uMap, vUv).a * vAlpha;
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vTint, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}
`;

export class Decals {
  private ctx: VfxContext;
  private src: KartSource;

  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private tex: THREE.CanvasTexture;

  private aPos: THREE.BufferAttribute;
  private aUv: THREE.BufferAttribute;
  private aData: THREE.BufferAttribute;
  private aTint: THREE.BufferAttribute;

  private capacity: number;
  private head = 0;
  private used = 0;
  private dirtyLo = Number.MAX_SAFE_INTEGER;
  private dirtyHi = -1;

  private skids = new Map<number, KartSkid>();

  constructor(ctx: VfxContext, src: KartSource) {
    this.ctx = ctx;
    this.src = src;
    const tier = ctx.quality.tier;
    this.capacity = tier === 'low' ? 260 : tier === 'medium' ? 620 : 1200;

    this.tex = buildDecalTexture(tier === 'low' ? 128 : 256);

    const verts = this.capacity * 4;
    this.geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.aUv = new THREE.BufferAttribute(new Float32Array(verts * 2), 2);
    this.aData = new THREE.BufferAttribute(new Float32Array(verts * 4), 4);
    this.aTint = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    for (const a of [this.aPos, this.aUv, this.aData, this.aTint]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aUv', this.aUv);
    this.geo.setAttribute('aData', this.aData);
    this.geo.setAttribute('aTint', this.aTint);

    const idx = new Uint32Array(this.capacity * 6);
    for (let q = 0; q < this.capacity; q++) {
      const b = q * 4;
      idx[q * 6] = b; idx[q * 6 + 1] = b + 1; idx[q * 6 + 2] = b + 2;
      idx[q * 6 + 3] = b; idx[q * 6 + 4] = b + 2; idx[q * 6 + 5] = b + 3;
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: this.tex },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -6,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'vfx-decals';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = RENDER_ORDER.DECAL;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    ctx.root.add(this.mesh);
  }

  // -------------------------------------------------------------------------

  /** Push one quad. Corners are given in world space, counter-clockwise. */
  private quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    cell: number, life: number, alpha: number,
    tr: number, tg: number, tb: number,
    uRepeat: number,
  ): void {
    const q = this.head;
    this.head = (q + 1) % this.capacity;
    if (q + 1 > this.used) this.used = q + 1;
    if (q < this.dirtyLo) this.dirtyLo = q;
    if (q > this.dirtyHi) this.dirtyHi = q;

    const v = q * 4;
    const p = this.aPos.array as Float32Array;
    const u = this.aUv.array as Float32Array;
    const dt = this.aData.array as Float32Array;
    const tn = this.aTint.array as Float32Array;

    p[v * 3] = ax; p[v * 3 + 1] = ay; p[v * 3 + 2] = az;
    p[v * 3 + 3] = bx; p[v * 3 + 4] = by; p[v * 3 + 5] = bz;
    p[v * 3 + 6] = cx; p[v * 3 + 7] = cy; p[v * 3 + 8] = cz;
    p[v * 3 + 9] = dx; p[v * 3 + 10] = dy; p[v * 3 + 11] = dz;

    const u0 = cell * 0.5;
    const u1 = u0 + 0.5;
    u[v * 2] = u0; u[v * 2 + 1] = 0;
    u[v * 2 + 2] = u1; u[v * 2 + 3] = 0;
    u[v * 2 + 4] = u1; u[v * 2 + 5] = uRepeat;
    u[v * 2 + 6] = u0; u[v * 2 + 7] = uRepeat;

    const birth = this.ctx.time;
    for (let i = 0; i < 4; i++) {
      dt[(v + i) * 4] = birth;
      dt[(v + i) * 4 + 1] = life;
      dt[(v + i) * 4 + 2] = alpha;
      dt[(v + i) * 4 + 3] = 0;
      tn[(v + i) * 3] = tr;
      tn[(v + i) * 3 + 1] = tg;
      tn[(v + i) * 3 + 2] = tb;
    }
  }

  /** A flat, ground-aligned blotch (scorch, oil, ink on the road). */
  splat(
    pos: THREE.Vector3, normal: THREE.Vector3, size: number,
    life: number, alpha: number, r: number, g: number, b: number,
  ): void {
    tmpUp.copy(normal).normalize();
    tmpDir.set(1, 0, 0);
    if (Math.abs(tmpUp.x) > 0.9) tmpDir.set(0, 0, 1);
    tmpRight.crossVectors(tmpUp, tmpDir).normalize();
    tmpDir.crossVectors(tmpRight, tmpUp).normalize();
    const ang = Math.random() * Math.PI * 2;
    const ca = Math.cos(ang) * size * 0.5;
    const sa = Math.sin(ang) * size * 0.5;
    // Rotated basis in the ground plane.
    const ex = tmpRight.x * ca + tmpDir.x * sa;
    const ey = tmpRight.y * ca + tmpDir.y * sa;
    const ez = tmpRight.z * ca + tmpDir.z * sa;
    const fx = -tmpRight.x * sa + tmpDir.x * ca;
    const fy = -tmpRight.y * sa + tmpDir.y * ca;
    const fz = -tmpRight.z * sa + tmpDir.z * ca;
    const ox = pos.x + tmpUp.x * 0.025;
    const oy = pos.y + tmpUp.y * 0.025;
    const oz = pos.z + tmpUp.z * 0.025;
    this.quad(
      ox - ex - fx, oy - ey - fy, oz - ez - fz,
      ox + ex - fx, oy + ey - fy, oz + ez - fz,
      ox + ex + fx, oy + ey + fy, oz + ez + fz,
      ox - ex + fx, oy - ey + fy, oz - ez + fz,
      CELL_SCORCH, life, alpha, r, g, b, 1,
    );
  }

  scorch(pos: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    this.splat(pos, normal, size, SCORCH_LIFE, 0.85, 0.035, 0.030, 0.028);
    this.splat(pos, normal, size * 1.7, SCORCH_LIFE * 0.8, 0.28, 0.09, 0.075, 0.06);
  }

  // -------------------------------------------------------------------------

  private surfaceTint(s: SurfaceType, out: THREE.Color): number {
    switch (s) {
      case SurfaceType.Road:
      case SurfaceType.Boost:
      case SurfaceType.Metal:
      case SurfaceType.AntiGravity:
        out.setRGB(0.028, 0.028, 0.032); return 0.62;
      case SurfaceType.Wood:
        out.setRGB(0.055, 0.040, 0.028); return 0.5;
      case SurfaceType.Dirt:
      case SurfaceType.OffRoad:
        out.setRGB(0.19, 0.135, 0.085); return 0.42;
      case SurfaceType.Sand:
        out.setRGB(0.33, 0.26, 0.15); return 0.32;
      case SurfaceType.Grass:
        out.setRGB(0.075, 0.10, 0.045); return 0.36;
      case SurfaceType.Ice:
        out.setRGB(0.55, 0.66, 0.78); return 0.22;
      default:
        return 0;
    }
  }

  private tintColor = new THREE.Color();

  update(): void {
    this.mat.uniforms.uTime.value = this.ctx.time;
    const karts = this.src.karts;
    if (karts) {
      for (let i = 0; i < karts.length; i++) this.layKart(karts[i]);
    }
    this.flush();
    this.geo.setDrawRange(0, this.used * 6);
  }

  private layKart(k: KartState): void {
    let s = this.skids.get(k.id);
    if (!s) {
      s = { px: new Float32Array(2), py: new Float32Array(2), pz: new Float32Array(2), ok: new Uint8Array(2) };
      this.skids.set(k.id, s);
    }

    const dist = this.ctx.camera.position.distanceTo(k.position);
    if (dist > 90 || !k.grounded) { s.ok[0] = 0; s.ok[1] = 0; return; }

    tmpUp.copy(U_LOCAL).applyQuaternion(k.quaternion);
    const lateral = Math.abs(k.velocity.dot(tmpRight.set(1, 0, 0).applyQuaternion(k.quaternion)));
    const speed = Math.abs(k.speed);
    const marking = speed > 3 && (k.drifting || k.stunned || lateral > 2.6 || k.boostTime > 0.01);
    if (!marking) { s.ok[0] = 0; s.ok[1] = 0; return; }

    const alphaBase = this.surfaceTint(k.surface, this.tintColor);
    if (alphaBase <= 0) { s.ok[0] = 0; s.ok[1] = 0; return; }
    const heat = clamp01((k.drifting ? 0.6 : 0.25) + lateral * 0.06);

    for (let w = 0; w < 2; w++) {
      socketPos(this.src, k, REAR[w], REAR_OFF[w][0], REAR_OFF[w][1], REAR_OFF[w][2], tmpA);
      tmpA.addScaledVector(tmpUp, -0.30);
      if (!s.ok[w]) {
        s.px[w] = tmpA.x; s.py[w] = tmpA.y; s.pz[w] = tmpA.z; s.ok[w] = 1;
        continue;
      }
      const dx = tmpA.x - s.px[w];
      const dy = tmpA.y - s.py[w];
      const dz = tmpA.z - s.pz[w];
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.42) continue;
      if (len > 6) { s.px[w] = tmpA.x; s.py[w] = tmpA.y; s.pz[w] = tmpA.z; continue; }

      // Segment direction and its ground-plane perpendicular.
      tmpDir.set(dx / len, dy / len, dz / len);
      tmpRight.crossVectors(tmpUp, tmpDir).normalize().multiplyScalar(0.115);
      const nx = tmpUp.x * 0.02, ny = tmpUp.y * 0.02, nz = tmpUp.z * 0.02;

      this.quad(
        s.px[w] - tmpRight.x + nx, s.py[w] - tmpRight.y + ny, s.pz[w] - tmpRight.z + nz,
        s.px[w] + tmpRight.x + nx, s.py[w] + tmpRight.y + ny, s.pz[w] + tmpRight.z + nz,
        tmpA.x + tmpRight.x + nx, tmpA.y + tmpRight.y + ny, tmpA.z + tmpRight.z + nz,
        tmpA.x - tmpRight.x + nx, tmpA.y - tmpRight.y + ny, tmpA.z - tmpRight.z + nz,
        CELL_SKID, SKID_LIFE, alphaBase * heat,
        this.tintColor.r, this.tintColor.g, this.tintColor.b,
        Math.max(0.35, len * 0.9),
      );
      s.px[w] = tmpA.x; s.py[w] = tmpA.y; s.pz[w] = tmpA.z;
    }
  }

  private flush(): void {
    if (this.dirtyHi < this.dirtyLo) return;
    const lo = this.dirtyLo * 4;
    const n = (this.dirtyHi - this.dirtyLo + 1) * 4;
    const up = (a: THREE.BufferAttribute, items: number) => {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * items, n * items);
      a.needsUpdate = true;
    };
    up(this.aPos, 3); up(this.aUv, 2); up(this.aData, 4); up(this.aTint, 3);
    this.dirtyLo = Number.MAX_SAFE_INTEGER;
    this.dirtyHi = -1;
  }

  get count(): number { return this.used; }

  clear(): void {
    (this.aData.array as Float32Array).fill(0);
    this.aData.clearUpdateRanges();
    this.aData.needsUpdate = true;
    this.head = 0;
    this.used = 0;
    this.skids.clear();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
    this.skids.clear();
  }
}
