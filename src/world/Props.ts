/**
 * ============================================================================
 *  APEX KART — PROPS
 * ============================================================================
 *  Everything man-made in the world: the race dressing that reads as "this is a
 *  circuit" (gantry, sponsor boards, tyre walls, catch fencing, grandstands,
 *  floodlights, balloon arches, marshal posts) plus a per-theme set of scenery
 *  (coastal / city / volcano).
 *
 *  ARCHITECTURE
 *  ------------
 *  Nothing here is a Mesh. Every prop type is built once into a *single* merged,
 *  vertex-coloured, fake-AO-shaded geometry by `Builder`, then drawn as one
 *  InstancedMesh. Eight shared materials cover every prop, so a full city dress
 *  costs ~30 draw calls rather than ~3000.
 *
 *  Animation is in the vertex shader wherever it possibly can be: cloth sway,
 *  balloon bob, neon flicker, per-window lit/unlit and flicker are all derived
 *  from a per-instance phase and a per-vertex cell id, so `update()` writes
 *  exactly four uniforms per frame and allocates nothing. Only the seagull flock
 *  and the cable trams — a few dozen matrices — touch the CPU.
 *
 *  Distance culling also lives in the vertex shader: each instance carries its
 *  own cull radius in `aCull` and collapses to zero size beyond it, so a lap's
 *  worth of dressing never rasterises more than the part you can see.
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings } from '@/core/Types';
import { LAYERS, RENDER_ORDER } from '@/core/Config';
import { Rng, clamp, clamp01 } from '@/core/MathUtils';
import { SHADOW_LAYER } from './Lighting';
import {
  InstanceChunks, canvasTexture, makeDetailNormal,
  type PathStation, type TerrainField, type WorldContext, type WorldTheme,
} from './WorldTextures';

// ===========================================================================
// Public placement types
// ===========================================================================

/** A grandstand: Props builds the structure, Crowd fills the seats. */
export interface StandSpec {
  position: THREE.Vector3;
  /** Facing, radians: the stand looks along -Z rotated by this. */
  yaw: number;
  /** Metres along the road the stand covers. */
  width: number;
  rows: number;
  /** 0..1 how full it is — highest at the start/finish line. */
  density: number;
  /** Arc length of the anchor, for the travelling crowd wave. */
  arc: number;
  /** True for the main straight stand (gets a roof and a big banner). */
  main: boolean;
}

interface Anchor {
  x: number; y: number; z: number;
  /** Radians: 0 = facing -Z. Props face the road unless noted. */
  yaw: number;
  side: number;
  arc: number;
  scale: number;
  seed: number;
}

// ===========================================================================
// Geometry builder
// ===========================================================================

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _euler = new THREE.Euler();
const _axisY = new THREE.Vector3(0, 1, 0);

type Shade = { top?: number; side?: number; bottom?: number };

/**
 * Accumulates flat-shaded, vertex-coloured geometry.
 *
 * `shade` multipliers are baked per face — a cheap directional AO that gives
 * low-poly props the chamfered, art-directed look MK8 gets from real lighting,
 * for zero runtime cost. `flap` marks vertices the wind may move; `cell` tags
 * repeated features (windows, banner panels) so the shader can vary them.
 */
class Builder {
  private P: number[] = [];
  private N: number[] = [];
  private U: number[] = [];
  private C: number[] = [];
  private F: number[] = [];
  private E: number[] = [];
  private I: number[] = [];

  /** 0 = rigid, 1 = free end of a cloth / balloon tether. */
  flap = 0;
  /** Feature index, for per-window randomisation. */
  cell = 0;
  /** World metres → uv tiles for the shared detail normal. */
  uvScale = 0.6;
  /** Per-vertex colour jitter, keeps large flats from looking printed. */
  jitter = 0.035;

  constructor(private rng: Rng) {}

  get vertexCount(): number { return this.P.length / 3; }

  private vert(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    hex: number, shade: number,
  ): void {
    this.P.push(x, y, z);
    this.N.push(nx, ny, nz);
    this.U.push(u, v);
    _c.setHex(hex);
    const j = 1 + (this.rng.next() - 0.5) * this.jitter * 2;
    this.C.push(
      Math.max(0, _c.r * shade * j),
      Math.max(0, _c.g * shade * j),
      Math.max(0, _c.b * shade * j),
    );
    this.F.push(this.flap);
    this.E.push(this.cell);
  }

  /** Quad in CCW order. `uvw`/`uvh` are the world-space extents for tiling. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    hex: number, shade = 1,
    uvRect?: [number, number, number, number],
  ): void {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;

    const w = Math.hypot(bx - ax, by - ay, bz - az) * this.uvScale;
    const h = Math.hypot(dx - ax, dy - ay, dz - az) * this.uvScale;
    const r = uvRect ?? [0, 0, w, h];

    const base = this.vertexCount;
    this.vert(ax, ay, az, nx, ny, nz, r[0], r[1], hex, shade);
    this.vert(bx, by, bz, nx, ny, nz, r[2], r[1], hex, shade);
    this.vert(cx, cy, cz, nx, ny, nz, r[2], r[3], hex, shade);
    this.vert(dx, dy, dz, nx, ny, nz, r[0], r[3], hex, shade);
    this.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Axis-aligned box, optionally yawed and tapered toward the top. */
  box(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    hex: number,
    opts: { yaw?: number; taper?: number; shade?: Shade; noBottom?: boolean; uvRect?: [number, number, number, number] } = {},
  ): void {
    const yaw = opts.yaw ?? 0;
    const tp = opts.taper ?? 1;
    const sh = opts.shade ?? {};
    const st = sh.top ?? 1.06;
    const ss = sh.side ?? 1.0;
    const sb = sh.bottom ?? 0.62;
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const pt = (lx: number, ly: number, lz: number): [number, number, number] => [
      cx + lx * ca - lz * sa, cy + ly, cz + lx * sa + lz * ca,
    ];
    const bx = hx, bz = hz, tx = hx * tp, tz = hz * tp;
    const b0 = pt(-bx, -hy, -bz), b1 = pt(bx, -hy, -bz), b2 = pt(bx, -hy, bz), b3 = pt(-bx, -hy, bz);
    const t0 = pt(-tx, hy, -tz), t1 = pt(tx, hy, -tz), t2 = pt(tx, hy, tz), t3 = pt(-tx, hy, tz);
    const uvR = opts.uvRect;
    // sides (darker toward the ground reads as contact shadow)
    this.quad(b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], t1[0], t1[1], t1[2], t0[0], t0[1], t0[2], hex, ss, uvR);
    this.quad(b1[0], b1[1], b1[2], b2[0], b2[1], b2[2], t2[0], t2[1], t2[2], t1[0], t1[1], t1[2], hex, ss * 0.9, uvR);
    this.quad(b2[0], b2[1], b2[2], b3[0], b3[1], b3[2], t3[0], t3[1], t3[2], t2[0], t2[1], t2[2], hex, ss * 0.96, uvR);
    this.quad(b3[0], b3[1], b3[2], b0[0], b0[1], b0[2], t0[0], t0[1], t0[2], t3[0], t3[1], t3[2], hex, ss * 0.86, uvR);
    this.quad(t0[0], t0[1], t0[2], t1[0], t1[1], t1[2], t2[0], t2[1], t2[2], t3[0], t3[1], t3[2], hex, st, uvR);
    if (!opts.noBottom) {
      this.quad(b3[0], b3[1], b3[2], b2[0], b2[1], b2[2], b1[0], b1[1], b1[2], b0[0], b0[1], b0[2], hex, sb, uvR);
    }
  }

  /** Prism / cylinder / cone about +Y. `taper` 0 makes a cone. */
  prism(
    cx: number, cy: number, cz: number,
    r: number, h: number, sides: number, hex: number,
    opts: { taper?: number; yaw?: number; capTop?: boolean; capBottom?: boolean; shade?: Shade; bulge?: number } = {},
  ): void {
    const tp = opts.taper ?? 1;
    const yaw = opts.yaw ?? 0;
    const sh = opts.shade ?? {};
    const ss = sh.side ?? 1;
    const st = sh.top ?? 1.1;
    const bulge = opts.bulge ?? 0;
    const rt = r * tp;
    const base = this.vertexCount;
    for (let i = 0; i <= sides; i++) {
      const a = yaw + (i / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Facet shading: faces pointing away from +X/+Z get a touch darker.
      const facet = ss * (0.90 + 0.14 * (ca * 0.55 + sa * 0.35 + 1) * 0.5);
      const u = (i / sides) * r * 6 * this.uvScale;
      this.vert(cx + ca * r, cy, cz + sa * r, ca, bulge * 0.4, sa, u, 0, hex, facet * 0.82);
      this.vert(cx + ca * rt, cy + h, cz + sa * rt, ca, bulge * 0.4, sa, u, h * this.uvScale, hex, facet);
    }
    for (let i = 0; i < sides; i++) {
      const a = base + i * 2;
      this.I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    if (opts.capTop !== false && rt > 1e-4) {
      const cbase = this.vertexCount;
      this.vert(cx, cy + h, cz, 0, 1, 0, 0, 0, hex, st);
      for (let i = 0; i <= sides; i++) {
        const a = yaw + (i / sides) * Math.PI * 2;
        this.vert(cx + Math.cos(a) * rt, cy + h, cz + Math.sin(a) * rt, 0, 1, 0,
          Math.cos(a) * rt * this.uvScale, Math.sin(a) * rt * this.uvScale, hex, st);
      }
      for (let i = 0; i < sides; i++) this.I.push(cbase, cbase + i + 1, cbase + i + 2);
    }
    if (opts.capBottom) {
      const cbase = this.vertexCount;
      this.vert(cx, cy, cz, 0, -1, 0, 0, 0, hex, (sh.bottom ?? 0.6));
      for (let i = 0; i <= sides; i++) {
        const a = yaw + (i / sides) * Math.PI * 2;
        this.vert(cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r, 0, -1, 0, 0, 0, hex, (sh.bottom ?? 0.6));
      }
      for (let i = 0; i < sides; i++) this.I.push(cbase, cbase + i + 2, cbase + i + 1);
    }
  }

  /** Cylinder between two arbitrary points — beams, cables, arch members. */
  tube(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    r: number, sides: number, hex: number, shade = 1,
  ): void {
    _v.set(x1 - x0, y1 - y0, z1 - z0);
    const len = _v.length();
    if (len < 1e-5) return;
    _v.divideScalar(len);
    // Build in local space then rotate: cheaper than a full frame per vertex.
    _q.setFromUnitVectors(_axisY, _v);
    const base = this.vertexCount;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
      const facet = shade * (0.88 + 0.16 * (Math.cos(a) + 1) * 0.5);
      for (let k = 0; k < 2; k++) {
        _v2.set(lx, k === 0 ? 0 : len, lz).applyQuaternion(_q);
        _s.set(lx, 0, lz).applyQuaternion(_q).normalize();
        this.vert(x0 + _v2.x, y0 + _v2.y, z0 + _v2.z, _s.x, _s.y, _s.z,
          (i / sides) * r * 6, k * len * this.uvScale, hex, facet);
      }
    }
    for (let i = 0; i < sides; i++) {
      const a = base + i * 2;
      this.I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  /** Low-poly UV sphere; `squash` < 1 flattens it. */
  sphere(
    cx: number, cy: number, cz: number, r: number,
    seg: number, rings: number, hex: number,
    opts: { squash?: number; shade?: number } = {},
  ): void {
    const sq = opts.squash ?? 1;
    const sh = opts.shade ?? 1;
    const base = this.vertexCount;
    for (let j = 0; j <= rings; j++) {
      const phi = (j / rings) * Math.PI;
      const sy = Math.cos(phi), sr = Math.sin(phi);
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const nx = Math.cos(th) * sr, nz = Math.sin(th) * sr;
        // Top-lit gradient baked in — reads as soft ambient occlusion.
        const shade = sh * (0.78 + 0.30 * clamp01(sy * 0.5 + 0.6));
        this.vert(cx + nx * r, cy + sy * r * sq, cz + nz * r,
          nx, sy / Math.max(sq, 0.2), nz, i / seg * 2, j / rings * 2, hex, shade);
      }
    }
    const stride = seg + 1;
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * stride + i;
        this.I.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
      }
    }
  }

  /** Torus about +Y — tyres, balloon-arch rings. */
  torus(
    cx: number, cy: number, cz: number, R: number, r: number,
    segs: number, sides: number, hex: number, shade = 1,
  ): void {
    const base = this.vertexCount;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let j = 0; j <= sides; j++) {
        const b = (j / sides) * Math.PI * 2;
        const cb = Math.cos(b), sb = Math.sin(b);
        const nx = ca * cb, ny = sb, nz = sa * cb;
        this.vert(cx + ca * (R + r * cb), cy + r * sb, cz + sa * (R + r * cb),
          nx, ny, nz, i / segs * 4, j / sides, hex, shade * (0.74 + 0.32 * clamp01(sb * 0.5 + 0.6)));
      }
    }
    const stride = sides + 1;
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < sides; j++) {
        const a = base + i * stride + j;
        this.I.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
      }
    }
  }

  /** Upright plate (billboard, flag, sign face). Double-sided by default. */
  plate(
    cx: number, cy: number, cz: number,
    w: number, h: number, yaw: number, hex: number,
    opts: { uvRect?: [number, number, number, number]; single?: boolean; pitch?: number; shade?: number; flapAcross?: boolean } = {},
  ): void {
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const pitch = opts.pitch ?? 0;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const hw = w * 0.5, hh = h * 0.5;
    const shade = opts.shade ?? 1;
    const uv = opts.uvRect ?? [0, 0, 1, 1];
    const pt = (lx: number, ly: number): [number, number, number] => {
      const y = ly * cp;
      const z = ly * sp;
      return [cx + lx * ca - z * sa, cy + y, cz + lx * sa + z * ca];
    };
    const flapSave = this.flap;
    const p0 = pt(-hw, -hh), p1 = pt(hw, -hh), p2 = pt(hw, hh), p3 = pt(-hw, hh);
    if (opts.flapAcross) {
      // Cloth hung from a mast: the far edge moves, the mast edge doesn't.
      const base = this.vertexCount;
      this.flap = 0;
      this.vert(p0[0], p0[1], p0[2], 0, 0, 1, uv[0], uv[3], hex, shade);
      this.flap = flapSave;
      this.vert(p1[0], p1[1], p1[2], 0, 0, 1, uv[2], uv[3], hex, shade);
      this.vert(p2[0], p2[1], p2[2], 0, 0, 1, uv[2], uv[1], hex, shade);
      this.flap = 0;
      this.vert(p3[0], p3[1], p3[2], 0, 0, 1, uv[0], uv[1], hex, shade);
      this.flap = flapSave;
      this.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
      return;
    }
    // The u range is swapped relative to the naive mapping, and this is not a
    // typo. `pt()` lays the plate out along local +x with a +z face normal, so
    // a viewer looking at the front face (from +z, down -z) sees +x running to
    // their LEFT. Mapping uMin->-hw would therefore render all text mirrored.
    // Verified empirically: trackside boards read "TORQUE"/"EMBER" correctly
    // with this mapping and read reversed with the axes the other way round.
    // The back face gets the un-swapped range so double-sided signs read
    // correctly from behind too.
    this.quad(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2],
      hex, shade, [uv[2], uv[3], uv[0], uv[1]]);
    if (!opts.single) {
      this.quad(p1[0], p1[1], p1[2], p0[0], p0[1], p0[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2],
        hex, shade * 0.8, [uv[0], uv[3], uv[2], uv[1]]);
    }
  }

  /** Hanging cloth with vertical segments so the wind wave has something to bend. */
  banner(
    cx: number, cy: number, cz: number,
    w: number, h: number, yaw: number, hex: number,
    segs = 4, uvRect?: [number, number, number, number],
  ): void {
    const uv = uvRect ?? [0, 0, 1, 1];
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const base = this.vertexCount;
    const stride = segs + 1;
    for (let j = 0; j <= segs; j++) {
      const fy = j / segs;            // 0 = top (anchored), 1 = bottom
      this.flap = fy * fy;
      for (let i = 0; i <= segs; i++) {
        const fx = i / segs;
        const lx = (fx - 0.5) * w;
        const y = cy - fy * h;
        this.vert(cx + lx * ca, y, cz + lx * sa, 0, 0, 1,
          uv[0] + (uv[2] - uv[0]) * fx, uv[1] + (uv[3] - uv[1]) * fy, hex, 1);
      }
    }
    this.flap = 0;
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = base + j * stride + i;
        this.I.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
      }
    }
  }

  build(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aFlap', new THREE.Float32BufferAttribute(this.F, 1));
    g.setAttribute('aCell', new THREE.Float32BufferAttribute(this.E, 1));
    g.setIndex(this.I);
    g.computeBoundingSphere();
    g.name = name;
    return g;
  }
}

// ===========================================================================
// Shared instancing shader patch
// ===========================================================================

interface PropUniforms extends Record<string, THREE.IUniform> {
  uTime: THREE.IUniform<number>;
  uWindDir: THREE.IUniform<THREE.Vector2>;
  uWind: THREE.IUniform<number>;
  uCamXZ: THREE.IUniform<THREE.Vector2>;
}

type PatchOpts = {
  /** Cloth / balloon motion driven by aFlap. */
  sway?: number;
  /** Bob up and down (balloons). */
  bob?: number;
  /** Per-instance atlas sub-rect from aAtlas. */
  atlas?: boolean;
  /** Per-window lit/unlit + flicker written into vLit. */
  windows?: boolean;
  /** Multiply emissive by the vertex colour (and vLit if windows). */
  emissiveVertexColor?: boolean;
};

/**
 * Injects instanced distance culling plus the per-prop animation into a stock
 * MeshStandardMaterial. Doing it here rather than in bespoke ShaderMaterials
 * means props still get real shadows, IBL and the patched height fog for free.
 */
function patchProp(
  mat: THREE.MeshStandardMaterial,
  u: PropUniforms,
  opts: PatchOpts = {},
): THREE.MeshStandardMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uWindDir = u.uWindDir;
    shader.uniforms.uWind = u.uWind;
    shader.uniforms.uCamXZ = u.uCamXZ;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute float aFlap;
        attribute float aCell;
        attribute float aPhase;
        attribute float aCull;
        ${opts.atlas ? 'attribute vec4 aAtlas;' : ''}
        uniform float uTime;
        uniform vec2 uWindDir;
        uniform float uWind;
        uniform vec2 uCamXZ;
        ${opts.windows ? 'varying float vLit;' : ''}
        float apxHash(float n){ return fract(sin(n * 91.3458) * 47453.5453); }
      `)
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vec2 apxOrigin = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        float apxDist = length(apxOrigin - uCamXZ);
        float apxVisible = step(apxDist, aCull);
        ${opts.sway ? `
        {
          float ph = aPhase * 6.2831;
          float g = sin(uTime * 2.3 + ph + apxOrigin.x * 0.07)
                  + 0.45 * sin(uTime * 5.1 + ph * 1.7);
          float amp = aFlap * uWind * ${opts.sway.toFixed(3)};
          transformed.x += uWindDir.x * g * amp;
          transformed.z += uWindDir.y * g * amp;
          transformed.y -= abs(g) * amp * 0.25;
        }` : ''}
        ${opts.bob ? `
        {
          float ph = aPhase * 6.2831;
          transformed.y += sin(uTime * 1.35 + ph) * aFlap * ${opts.bob.toFixed(3)};
          transformed.x += cos(uTime * 0.9 + ph * 1.3) * aFlap * ${(opts.bob * 0.5).toFixed(3)};
        }` : ''}
        transformed *= apxVisible;
        ${opts.windows ? `
        {
          float h = apxHash(aCell * 3.13 + aPhase * 57.7);
          float lit = step(0.42, h);
          // A few windows flicker; most are steady.
          float fl = step(0.94, h);
          float blink = mix(1.0, 0.35 + 0.65 * step(0.5, fract(uTime * (0.7 + h) + h * 10.0)), fl);
          vLit = lit * blink * (0.55 + 0.75 * apxHash(aCell * 7.71 + aPhase * 11.3));
        }` : ''}
      `);

    if (opts.atlas) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>', /* glsl */ `
        #include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = aAtlas.xy + fract(vMapUv) * aAtlas.zw;
        #endif
      `);
    }

    // NOTE: three declares `vColor` as a **vec4** in the fragment shader whenever
    // USE_COLOR is on (see ShaderChunk.color_pars_fragment), regardless of whether
    // the geometry attribute is 3- or 4-component. `emissive` is a vec3, so a bare
    // `emissive * vColor` is a hard compile error — which is what used to kill
    // prop-glow / prop-glow-soft and leave every glowing prop as untextured grey.
    // `.rgb` swizzles fine on vec3 and vec4 alike, so always go through it.
    if (opts.windows) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vLit;')
        .replace(
          'vec3 totalEmissiveRadiance = emissive;',
          'vec3 totalEmissiveRadiance = emissive * vColor.rgb * vLit;',
        );
    } else if (opts.emissiveVertexColor) {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec3 totalEmissiveRadiance = emissive;',
        'vec3 totalEmissiveRadiance = emissive * vColor.rgb;',
      );
    }
  };
  // Force a distinct program even when two materials look identical.
  mat.customProgramCacheKey = () =>
    `apxprop|${opts.sway ?? 0}|${opts.bob ?? 0}|${opts.atlas ? 1 : 0}|${opts.windows ? 1 : 0}|${opts.emissiveVertexColor ? 1 : 0}`;
  return mat;
}

// ===========================================================================
// Textures
// ===========================================================================

const SPONSORS: Array<[string, string, string]> = [
  ['APEX', '#e8332a', '#ffffff'],
  ['NITRO', '#141821', '#ffd23f'],
  ['TURBO', '#0f6bd6', '#ffffff'],
  ['GRIP', '#1f9e57', '#0c1410'],
  ['VOLT', '#7a2ed6', '#f2e9ff'],
  ['SLIP', '#ff7a18', '#22160b'],
  ['DRIFT', '#0d1b2a', '#4fd6ff'],
  ['KART', '#f4f1e6', '#c2192a'],
];

/** 4x2 atlas of sponsor boards, 2:1 cells to match a real trackside board. */
function makeSponsorAtlas(): THREE.CanvasTexture {
  return canvasTexture(2048, (ctx, w, h) => {
    const cw = w / 4, ch = h / 2;
    for (let i = 0; i < 8; i++) {
      const x = (i % 4) * cw, y = Math.floor(i / 4) * ch;
      const [text, bg, fg] = SPONSORS[i];
      const grad = ctx.createLinearGradient(x, y, x, y + ch);
      grad.addColorStop(0, bg);
      grad.addColorStop(1, shade(bg, 0.72));
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, cw, ch);

      // Diagonal speed flashes.
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, cw, ch); ctx.clip();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = fg;
      for (let k = -2; k < 8; k++) {
        ctx.beginPath();
        ctx.moveTo(x + k * 40, y + ch);
        ctx.lineTo(x + k * 40 + 26, y + ch);
        ctx.lineTo(x + k * 40 + 74, y);
        ctx.lineTo(x + k * 40 + 48, y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      ctx.strokeStyle = shade(fg, 0.9);
      ctx.lineWidth = 7;
      ctx.strokeRect(x + 8, y + 8, cw - 16, ch - 16);

      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${Math.round(ch * 0.42)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      ctx.save();
      ctx.translate(x + cw * 0.5, y + ch * 0.5);
      ctx.transform(1, 0, -0.14, 1, 0, 0);
      ctx.fillText(text, 0, 0);
      ctx.restore();

      ctx.globalAlpha = 0.55;
      ctx.font = `600 ${Math.round(ch * 0.1)}px Helvetica, Arial, sans-serif`;
      ctx.fillText('APEX KART CHAMPIONSHIP', x + cw * 0.5, y + ch * 0.82);
      ctx.globalAlpha = 1;
    }
  }, { srgb: true, height: 1024 });
}

/** Chain-link alpha for catch fencing. */
function makeFenceAlpha(): THREE.CanvasTexture {
  const t = canvasTexture(256, (ctx, w, h) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#c8ccd2';
    ctx.lineWidth = 3.5;
    const step = 32;
    for (let i = -h; i < w + h; i += step) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(i, h); ctx.lineTo(i + h, 0); ctx.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function shade(hex: string, mul: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * mul));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * mul));
  const b = Math.min(255, Math.round((n & 255) * mul));
  return `rgb(${r},${g},${b})`;
}

// ===========================================================================
// Placement helpers
// ===========================================================================

/**
 * Pick grandstand sites: the start/finish straight first, then the outside of
 * the biggest corners, which is where a real circuit puts its seating.
 */
export function planStands(ctx: WorldContext, limit = 8): StandSpec[] {
  const st = ctx.stations;
  const out: StandSpec[] = [];
  if (st.length < 20) return out;
  const field = ctx.field;

  // Curvature per station (used to rank corners).
  const n = st.length;
  const curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = st[(i - 3 + n) % n], b = st[i], c = st[(i + 3) % n];
    const ax = b.px - a.px, az = b.pz - a.pz;
    const cx = c.px - b.px, cz = c.pz - b.pz;
    const cross = ax * cz - az * cx;
    const la = Math.hypot(ax, az) || 1, lc = Math.hypot(cx, cz) || 1;
    curv[i] = cross / (la * lc);
  }

  const place = (i: number, side: number, density: number, main: boolean): boolean => {
    const s = st[i];
    const dist = s.halfWidth + 15;
    const x = s.px + s.bx * dist * side;
    const z = s.pz + s.bz * dist * side;
    if (field.roadDistanceAt(x, z) < s.halfWidth + 8) return false;
    const y = field.heightAt(x, z);
    if (y < ctx.waterLevel + 0.6) return false;
    if (field.slopeAt(x, z) > 0.55) return false;
    for (const o of out) if (o.position.distanceTo(_v.set(x, y, z)) < 95) return false;
    const yaw = Math.atan2(-s.bx * side, -s.bz * side);
    out.push({
      position: new THREE.Vector3(x, y, z),
      yaw,
      width: main ? 78 : 46,
      rows: main ? 9 : 6,
      density,
      arc: s.s,
      main,
    });
    return true;
  };

  // Main stand on the left of the start line, a smaller one opposite.
  place(2, -1, 1.0, true);
  place(4, 1, 0.8, false);

  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => Math.abs(curv[b]) - Math.abs(curv[a]));
  for (const i of order) {
    if (out.length >= limit) break;
    // Outside of the corner: opposite the turn direction.
    place(i, curv[i] > 0 ? -1 : 1, 0.5 + Math.random() * 0.3, false);
  }
  return out;
}

/** Anchors marching along the road at a fixed spacing. */
function roadside(
  ctx: WorldContext, rng: Rng,
  o: {
    spacing: number; min: number; max: number; sides?: number;
    jitter?: number; maxSlope?: number; startArc?: number; limit?: number;
    faceRoad?: boolean; skipNearStands?: StandSpec[];
  },
): Anchor[] {
  const out: Anchor[] = [];
  const st = ctx.stations;
  if (!st.length) return out;
  const field = ctx.field;
  const total = st[st.length - 1].s;
  const jitter = o.jitter ?? 0.35;
  const maxSlope = o.maxSlope ?? 0.55;
  const limit = o.limit ?? 4000;
  const stepIdx = Math.max(1, Math.round(o.spacing / Math.max(1, total / st.length)));

  let flip = 1;
  for (let i = Math.round((o.startArc ?? 0) / Math.max(1, total / st.length)); i < st.length && out.length < limit; i += stepIdx) {
    const s = st[i];
    const sides = o.sides ?? 1;
    for (let k = 0; k < (sides === 2 ? 2 : 1); k++) {
      const side = sides === 2 ? (k === 0 ? -1 : 1) : (flip = -flip);
      const d = s.halfWidth + o.min + rng.next() * (o.max - o.min);
      const along = (rng.next() - 0.5) * o.spacing * jitter;
      const x = s.px + s.bx * d * side + s.tx * along;
      const z = s.pz + s.bz * d * side + s.tz * along;
      if (field.roadDistanceAt(x, z) < s.halfWidth + o.min * 0.6) continue;
      const y = field.heightAt(x, z);
      if (y < ctx.waterLevel + 0.35) continue;
      if (field.slopeAt(x, z) > maxSlope) continue;
      if (o.skipNearStands) {
        let blocked = false;
        for (const stand of o.skipNearStands) {
          if (Math.hypot(stand.position.x - x, stand.position.z - z) < stand.width * 0.55) { blocked = true; break; }
        }
        if (blocked) continue;
      }
      // Face the road (i.e. inward).
      const yaw = o.faceRoad === false
        ? rng.next() * Math.PI * 2
        : Math.atan2(-s.bx * side, -s.bz * side);
      out.push({ x, y, z, yaw, side, arc: s.s, scale: 1, seed: rng.next() });
    }
  }
  return out;
}

/** Random anchors in an annulus around the circuit — city blocks, rock fields. */
function annulus(
  ctx: WorldContext, rng: Rng,
  o: { count: number; min: number; max: number; minRoadDist: number; maxSlope?: number; dry?: boolean },
): Anchor[] {
  const out: Anchor[] = [];
  const field = ctx.field;
  const maxSlope = o.maxSlope ?? 0.7;
  const tries = o.count * 14;
  for (let i = 0; i < tries && out.length < o.count; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = o.min + Math.sqrt(rng.next()) * (o.max - o.min);
    const x = field.centreX + Math.cos(a) * r;
    const z = field.centreZ + Math.sin(a) * r;
    if (Math.abs(x - field.centreX) > field.extent * 0.47) continue;
    if (Math.abs(z - field.centreZ) > field.extent * 0.47) continue;
    if (field.roadDistanceAt(x, z) < o.minRoadDist) continue;
    const y = field.heightAt(x, z);
    if (o.dry !== false && y < ctx.waterLevel + 0.5) continue;
    if (field.slopeAt(x, z) > maxSlope) continue;
    let clash = false;
    for (const p of out) if (Math.hypot(p.x - x, p.z - z) < 34) { clash = true; break; }
    if (clash) continue;
    out.push({ x, y, z, yaw: rng.next() * Math.PI * 2, side: 0, arc: 0, scale: 1, seed: rng.next() });
  }
  return out;
}

/** Anchors just below the waterline — jetties, moored boats, shore rocks. */
function shoreline(ctx: WorldContext, rng: Rng, count: number, band: [number, number]): Anchor[] {
  const out: Anchor[] = [];
  const field = ctx.field;
  const wl = ctx.waterLevel;
  const half = field.extent * 0.46;
  const tries = count * 60;
  for (let i = 0; i < tries && out.length < count; i++) {
    const x = field.centreX + (rng.next() * 2 - 1) * half;
    const z = field.centreZ + (rng.next() * 2 - 1) * half;
    const y = field.heightAt(x, z);
    if (y < wl + band[0] || y > wl + band[1]) continue;
    if (field.roadDistanceAt(x, z) < 22) continue;
    let clash = false;
    for (const p of out) if (Math.hypot(p.x - x, p.z - z) < 42) { clash = true; break; }
    if (clash) continue;
    // Face out to sea: downhill from here.
    field.normalAt(x, z, _v);
    const yaw = Math.atan2(-_v.x, -_v.z);
    out.push({ x, y, z, yaw, side: 0, arc: 0, scale: 1, seed: rng.next() });
  }
  return out;
}

// ===========================================================================

interface PropMesh {
  mesh: THREE.InstancedMesh;
  /** CPU-animated props keep their base transforms here. */
  motion?: 'gull' | 'tram';
  data?: Float32Array;
  /** Per-chunk visible-set culling, for static props only. */
  chunks?: InstanceChunks | null;
}

/**
 * Below this many instances a prop type is a landmark (one gantry, one
 * lighthouse) and the existing tight bounding sphere already culls it fine.
 */
const CHUNK_MIN_INSTANCES = 12;

/**
 * One authored prop type. `geo` is the opaque body; `glow` and `cloth` are
 * optional companion meshes emitted with the emissive and the wind-swayed cloth
 * material, so a lamp post can have a lit head and a sailboat can have sails
 * without a multi-material mesh.
 */
interface AuthoredSpec {
  geo: THREE.BufferGeometry;
  /** Body material; defaults to `matte`. */
  mat?: THREE.MeshStandardMaterial;
  glow?: THREE.BufferGeometry;
  /** Use the dimmer `glowSoft` for the glow part (windows, buoy lamps). */
  softGlow?: boolean;
  cloth?: THREE.BufferGeometry;
  cull?: number;
  shadow?: boolean;
}

const CULL_NEAR = 320;
const CULL_MID = 620;
const CULL_FAR = 1600;

/**
 * Bounding radius, in metres, a prop needs before it earns a slot in the shadow
 * cascades at all. Below this a prop is a bollard or a cone and its shadow is a
 * smudge the ground's own sun march already implies.
 */
const SHADOW_MIN_RADIUS = 0.95;

/**
 * Shadow cascade tiers by bounding radius. Anything at or above `FAR` is a
 * silhouette at distance (grandstands, gantries, masts, buildings) and stays
 * untagged so it reaches every cascade.
 */
const SHADOW_TIER_MID = 1.9;
const SHADOW_TIER_FAR = 8.5;

export class Props implements ISubsystem {
  readonly group = new THREE.Group();
  camera: THREE.PerspectiveCamera | null = null;

  private scene: THREE.Scene;
  private ctx: WorldContext;
  private quality: QualitySettings;
  private field: TerrainField;
  private theme: WorldTheme;
  private stands: StandSpec[];
  private rng: Rng;
  private density: number;

  private meshes: PropMesh[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];

  private u: PropUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.86, 0.51) },
    uWind: { value: 0.24 },
    uCamXZ: { value: new THREE.Vector2() },
  };

  private matte!: THREE.MeshStandardMaterial;
  private matteSway!: THREE.MeshStandardMaterial;
  private metal!: THREE.MeshStandardMaterial;
  private glow!: THREE.MeshStandardMaterial;
  private glowSoft!: THREE.MeshStandardMaterial;
  private windows!: THREE.MeshStandardMaterial;
  private atlas!: THREE.MeshStandardMaterial;
  private atlasSway!: THREE.MeshStandardMaterial;
  private fence!: THREE.MeshStandardMaterial;

  private time = 0;

  constructor(
    scene: THREE.Scene,
    _renderer: THREE.WebGLRenderer,
    ctx: WorldContext,
    quality: QualitySettings,
    stands: StandSpec[] = [],
  ) {
    this.scene = scene;
    this.ctx = ctx;
    this.quality = quality;
    this.field = ctx.field;
    this.theme = ctx.theme;
    this.stands = stands;
    this.rng = new Rng((ctx.hints.terrainSeed ^ 0x9e3779b9) >>> 0 || 7);
    this.density = clamp(quality.foliageDensity * 0.55 + 0.45, 0.35, 1);
  }

  async init(): Promise<void> {
    this.group.name = 'Props';
    this.scene.add(this.group);

    this.buildMaterials();
    this.buildRaceDressing();
    switch (this.theme) {
      case 'coastal': this.buildCoastal(); break;
      case 'city': this.buildCity(); break;
      case 'volcano': this.buildVolcano(); break;
      case 'snow': this.buildAlpine(); break;
      case 'desert': this.buildDesert(); break;
      default: this.buildPastoral(); break;
    }
    this.buildAuthored();
  }

  // =========================================================================
  // MATERIALS
  // =========================================================================

  private buildMaterials(): void {
    const detail = makeDetailNormal(this.quality.tier === 'low' ? 128 : 256);
    detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
    this.textures.push(detail);

    const base = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({
        vertexColors: true,
        normalMap: detail,
        normalScale: new THREE.Vector2(0.55, 0.55),
        ...o,
      });
      this.materials.push(m);
      return m;
    };

    this.matte = patchProp(base({ name: 'prop-matte', roughness: 0.86, metalness: 0.02 }), this.u);
    this.matteSway = patchProp(
      base({ name: 'prop-cloth', roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide }),
      this.u, { sway: 0.55 },
    );
    this.metal = patchProp(
      base({ name: 'prop-metal', roughness: 0.34, metalness: 0.85, envMapIntensity: 1.15 }),
      this.u,
    );
    this.glow = patchProp(
      base({ name: 'prop-glow', roughness: 0.4, metalness: 0.0, emissive: 0xffffff, emissiveIntensity: 3.4 }),
      this.u, { emissiveVertexColor: true },
    );
    this.glowSoft = patchProp(
      base({ name: 'prop-glow-soft', roughness: 0.5, metalness: 0.0, emissive: 0xffffff, emissiveIntensity: 1.35 }),
      this.u, { emissiveVertexColor: true, bob: 0.22 },
    );
    this.windows = patchProp(
      base({
        name: 'prop-windows', roughness: 0.16, metalness: 0.55,
        emissive: 0xffffff, emissiveIntensity: 2.6, envMapIntensity: 1.4,
      }),
      this.u, { windows: true },
    );

    const sponsor = makeSponsorAtlas();
    sponsor.anisotropy = this.quality.anisotropy;
    this.textures.push(sponsor);
    this.atlas = patchProp(
      base({ name: 'prop-atlas', map: sponsor, roughness: 0.66, metalness: 0.05 }),
      this.u, { atlas: true },
    );
    this.atlasSway = patchProp(
      base({ name: 'prop-atlas-cloth', map: sponsor, roughness: 0.9, side: THREE.DoubleSide }),
      this.u, { atlas: true, sway: 0.5 },
    );

    const fenceAlpha = makeFenceAlpha();
    fenceAlpha.repeat.set(6, 2);
    this.textures.push(fenceAlpha);
    this.fence = patchProp(
      base({
        name: 'prop-fence', alphaMap: fenceAlpha, alphaTest: 0.42,
        roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide,
      }),
      this.u,
    );
  }

  // =========================================================================
  // INSTANCING
  // =========================================================================

  /**
   * Create the InstancedMesh for a prop type. `place` fills a transform per
   * anchor; returning false skips that instance.
   */
  private emit(
    name: string,
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    anchors: Anchor[],
    o: {
      cull?: number;
      bloom?: boolean;
      shadow?: boolean;
      atlasCells?: number;
      place?: (a: Anchor, i: number, m: THREE.Matrix4) => boolean;
      motion?: 'gull' | 'tram';
    } = {},
  ): THREE.InstancedMesh | null {
    if (!anchors.length) { geo.dispose(); return null; }
    const mesh = new THREE.InstancedMesh(geo, material, anchors.length);
    mesh.name = `Prop:${name}`;
    // Shadow casting is opt-in by *size*, not just by flag. A fence post, a
    // bollard or a flag pole is submitted into every shadow cascade for a
    // contact shadow two pixels wide that the terrain's own sun march already
    // suggests; only props big enough to throw a readable shadow pay for one.
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const radius = geo.boundingSphere?.radius ?? 0;
    mesh.castShadow = o.shadow !== false && radius >= SHADOW_MIN_RADIUS;
    mesh.receiveShadow = o.shadow !== false;
    // Opt into Lighting's cascade masks (see SHADOW_LAYER there). A tyre stack
    // does not need to be in the 240 m cascade; a grandstand does. `enable`, not
    // `set` — `set` would clear layer 0 and hide the prop from the main camera.
    if (mesh.castShadow) {
      if (radius < SHADOW_TIER_MID) mesh.layers.enable(SHADOW_LAYER.NEAR_ONLY);
      else if (radius < SHADOW_TIER_FAR) mesh.layers.enable(SHADOW_LAYER.MID_ONLY);
    }
    mesh.renderOrder = RENDER_ORDER.PROPS;
    mesh.instanceMatrix.setUsage(o.motion ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);

    const cull = o.cull ?? CULL_NEAR;
    const phase = new Float32Array(anchors.length);
    const cullAttr = new Float32Array(anchors.length);
    const atlasAttr = o.atlasCells ? new Float32Array(anchors.length * 4) : null;
    const placed: Array<{ x: number; y: number; z: number }> = [];

    let n = 0;
    const bounds = new THREE.Box3();
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      _m.identity();
      if (o.place) {
        if (!o.place(a, i, _m)) continue;
      } else {
        _q.setFromAxisAngle(_axisY, a.yaw);
        _m.compose(_v.set(a.x, a.y, a.z), _q, _s.setScalar(a.scale));
      }
      mesh.setMatrixAt(n, _m);
      phase[n] = a.seed;
      cullAttr[n] = cull;
      if (atlasAttr) {
        const cells = o.atlasCells as number;
        const cell = Math.floor(a.seed * cells) % cells;
        const cols = 4, rows = Math.max(1, Math.ceil(cells / cols));
        atlasAttr[n * 4] = (cell % cols) / cols;
        atlasAttr[n * 4 + 1] = Math.floor(cell / cols) / rows;
        atlasAttr[n * 4 + 2] = 1 / cols;
        atlasAttr[n * 4 + 3] = 1 / rows;
      }
      bounds.expandByPoint(_v.setFromMatrixPosition(_m));
      placed.push({ x: _v.x, y: _v.y, z: _v.z });
      n++;
    }
    if (n === 0) { mesh.dispose(); geo.dispose(); return null; }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;

    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geo.setAttribute('aCull', new THREE.InstancedBufferAttribute(cullAttr, 1));
    if (atlasAttr) geo.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(atlasAttr, 4));

    // Per-cluster frustum culling: a tight sphere means props bunched in one
    // place (the gantry, the stands, a lighthouse) drop out when behind you.
    bounds.getCenter(_v);
    const spread = bounds.getSize(_v2).length() * 0.5;
    mesh.boundingSphere = new THREE.Sphere(_v.clone(), spread + Math.max(radius, 4) * 1.6);
    mesh.frustumCulled = true;

    if (o.bloom) mesh.layers.enable(LAYERS.BLOOM);
    this.group.add(mesh);

    // Chunk-cull anything static and numerous. Shadow casters get distance-only
    // culling — a grandstand just off the left edge of the frame still throws its
    // shadow across the road, so it must stay in the draw set.
    let chunks: InstanceChunks | null = null;
    if (!o.motion && n >= CHUNK_MIN_INSTANCES) {
      chunks = new InstanceChunks(mesh, placed, cull, 110, !mesh.castShadow)
        .track(geo.getAttribute('aPhase') as THREE.InstancedBufferAttribute)
        .track(geo.getAttribute('aCull') as THREE.InstancedBufferAttribute);
      if (atlasAttr) chunks.track(geo.getAttribute('aAtlas') as THREE.InstancedBufferAttribute);
      mesh.frustumCulled = false;
    }

    this.meshes.push({ mesh, motion: o.motion, chunks });
    return mesh;
  }

  private builder(): Builder {
    return new Builder(this.rng);
  }

  private count(base: number): number {
    return Math.max(1, Math.round(base * this.density));
  }

  // =========================================================================
  // RACE DRESSING (every theme)
  // =========================================================================

  private buildRaceDressing(): void {
    const ctx = this.ctx;
    const st = ctx.stations;
    if (!st.length) return;
    const rng = this.rng;

    // ---- start / finish gantry ------------------------------------------------
    const start = st[0];
    const hw = start.halfWidth;
    const gantryAnchor: Anchor[] = [{
      x: start.px, y: this.field.heightAt(start.px, start.pz),
      z: start.pz, yaw: Math.atan2(start.bx, start.bz),
      side: 0, arc: 0, scale: 1, seed: 0.5,
    }];

    {
      const b = this.builder();
      const legX = hw + 2.2;
      for (const sx of [-1, 1]) {
        // Truss tower: four legs plus cross-braces.
        for (const dx of [-0.8, 0.8]) {
          for (const dz of [-0.8, 0.8]) {
            b.prism(sx * legX + dx, 0, dz, 0.16, 11.5, 6, 0x2b3138, { capBottom: true });
          }
        }
        for (let k = 0; k < 6; k++) {
          const y = 1.4 + k * 1.8;
          b.tube(sx * legX - 0.8, y, -0.8, sx * legX + 0.8, y + 1.2, 0.8, 0.075, 4, 0x3a424b);
          b.tube(sx * legX + 0.8, y, -0.8, sx * legX - 0.8, y + 1.2, 0.8, 0.075, 4, 0x3a424b);
          b.box(sx * legX, y, 0, 0.95, 0.06, 0.95, 0x353d45, { noBottom: true });
        }
        b.box(sx * legX, 0, 0, 1.5, 0.35, 1.5, 0x22262b, { shade: { top: 1.0 } });
      }
      // Deck spanning the road.
      b.box(0, 11.6, 0, legX + 1.6, 0.55, 1.3, 0x2b3138);
      for (let k = -6; k <= 6; k++) {
        b.tube(k * legX / 6.5, 11.2, -1.0, k * legX / 6.5, 11.2, 1.0, 0.06, 4, 0x3a424b);
      }
      b.box(0, 12.2, 0, legX + 1.0, 1.5, 0.35, 0xe9e6dd, { shade: { side: 1.05 } });
      this.emit('gantry', b.build('gantry'), this.matte, gantryAnchor, { cull: CULL_MID });
    }
    {
      // Lit "FINISH" strip + lamp bars on the deck.
      const b = this.builder();
      b.box(0, 12.2, 0.22, hw + 0.9, 0.62, 0.06, 0xff3b2f);
      for (let k = -5; k <= 5; k++) {
        b.box(k * (hw / 5.4), 11.15, 0, 0.55, 0.1, 0.5, 0xfff2c8);
      }
      this.emit('gantryLights', b.build('gantryLights'), this.glow, gantryAnchor,
        { cull: CULL_MID, bloom: true, shadow: false });
    }
    {
      // Sponsor banner hanging under the deck.
      const b = this.builder();
      b.banner(0, 11.2, -0.1, (hw + 1) * 2, 2.6, 0, 0xffffff, 5, [0, 0, 1, 1]);
      this.emit('gantryBanner', b.build('gantryBanner'), this.atlasSway, gantryAnchor,
        { cull: CULL_MID, atlasCells: 8, shadow: false });
    }

    // ---- sponsor boards ------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, {
        spacing: 34, min: 3.5, max: 6.5, jitter: 0.25, limit: this.count(58),
        skipNearStands: this.stands,
      });
      const b = this.builder();
      // Board face + frame + feet, one merged geometry drawn with the atlas.
      b.plate(0, 1.55, 0.06, 6.4, 2.1, 0, 0xffffff, { single: false, uvRect: [0.02, 0.06, 0.98, 0.94] });
      this.emit('sponsorBoard', b.build('sponsorBoard'), this.atlas, anchors,
        { cull: CULL_NEAR, atlasCells: 8, shadow: true });

      const f = this.builder();
      f.box(0, 1.55, -0.02, 3.28, 1.14, 0.05, 0x1b1f24);
      for (const sx of [-1, 1]) {
        f.prism(sx * 2.7, 0, -0.1, 0.1, 1.6, 6, 0x30363d, { capBottom: true });
        f.tube(sx * 2.7, 1.4, -0.1, sx * 2.7, 0.35, -1.25, 0.07, 4, 0x30363d);
      }
      this.emit('boardFrame', f.build('boardFrame'), this.metal, anchors, { cull: CULL_NEAR });
    }

    // ---- tyre walls ----------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, {
        spacing: 11, min: 1.0, max: 1.9, jitter: 0.15, limit: this.count(120),
        skipNearStands: this.stands,
      });
      const b = this.builder();
      const tyreCols = [0x14161a, 0x1a1d22, 0x101215];
      for (let row = 0; row < 3; row++) {
        for (let k = 0; k < 3; k++) {
          const y = 0.34 + row * 0.62;
          const x = (k - 1) * 1.32 + (row % 2 ? 0.66 : 0);
          b.torus(x, y, 0, 0.44, 0.19, 10, 6, tyreCols[(row + k) % 3], 1 - row * 0.06);
        }
      }
      // Painted top rail ties the stack together.
      b.box(0, 2.24, 0, 2.3, 0.11, 0.42, row3Colour(rng));
      this.emit('tyreWall', b.build('tyreWall'), this.matte, anchors, { cull: 260 });
    }

    // ---- catch fencing -------------------------------------------------------
    {
      // Panels march along each stand's local X, pushed toward the road (its
      // local +Z, which is the direction the seating faces).
      const anchors: Anchor[] = [];
      for (const stand of this.stands) {
        const segs = Math.max(2, Math.floor(stand.width / 6));
        const ca = Math.cos(stand.yaw), sa = Math.sin(stand.yaw);
        for (let i = 0; i <= segs; i++) {
          const off = (i / segs - 0.5) * stand.width;
          const x = stand.position.x + ca * off + sa * 4.5;
          const z = stand.position.z - sa * off + ca * 4.5;
          if (this.field.roadDistanceAt(x, z) < 9) continue;
          anchors.push({
            x, y: this.field.heightAt(x, z), z,
            yaw: stand.yaw, side: 0, arc: stand.arc, scale: 1, seed: rng.next(),
          });
        }
      }
      const b = this.builder();
      b.plate(0, 2.3, 0, 6.1, 4.2, 0, 0xdfe4ea, { single: true, uvRect: [0, 0, 1, 1] });
      this.emit('catchFence', b.build('catchFence'), this.fence, anchors,
        { cull: CULL_NEAR, shadow: false });
      const p = this.builder();
      for (const off of [-3.05, 3.05]) {
        p.prism(off, 0, 0, 0.09, 4.5, 6, 0x878f98, { capBottom: true });
      }
      p.tube(-3.05, 4.4, 0, 3.05, 4.4, 0, 0.06, 5, 0x878f98);
      this.emit('fencePost', p.build('fencePost'), this.metal, anchors, { cull: CULL_NEAR });
    }

    // ---- grandstands ---------------------------------------------------------
    if (this.stands.length) {
      const standAnchors: Anchor[] = this.stands.map((s, i) => ({
        x: s.position.x, y: s.position.y, z: s.position.z, yaw: s.yaw,
        side: 0, arc: s.arc, scale: 1, seed: (i * 0.37) % 1,
      }));
      const b = this.builder();
      // Terraced seating: each row a step deeper and higher.
      const rows = 9, rowH = 0.78, rowD = 1.15, width = 78;
      for (let r = 0; r < rows; r++) {
        const y = r * rowH;
        const z = -r * rowD;
        b.box(0, y + 0.18, z, width * 0.5, 0.18, rowD * 0.5, r % 2 ? 0x8b9199 : 0x7d838b,
          { shade: { top: 1.12, side: 0.86 } });
        b.box(0, y + 0.52, z - rowD * 0.42, width * 0.5, 0.34, 0.1,
          [0x2f6fd0, 0xd93b2f, 0xf0c542, 0x2fa363][r % 4], { shade: { top: 1.1 } });
      }
      // Side walls + back.
      for (const sx of [-1, 1]) {
        b.box(sx * width * 0.5, rows * rowH * 0.5, -rows * rowD * 0.5,
          0.3, rows * rowH * 0.5, rows * rowD * 0.5, 0x5c6169, { shade: { side: 0.92 } });
      }
      b.box(0, rows * rowH * 0.5 + 0.4, -rows * rowD - 0.4,
        width * 0.5 + 0.3, rows * rowH * 0.5 + 0.4, 0.35, 0x494e55);
      // Stair aisles.
      for (const ax of [-0.55, 0, 0.55]) {
        for (let r = 0; r < rows; r++) {
          b.box(ax * width * 0.5, r * rowH + 0.38, -r * rowD, 1.1, 0.06, rowD * 0.5, 0xb9bec6,
            { shade: { top: 1.16 } });
        }
      }
      this.emit('grandstand', b.build('grandstand'), this.matte, standAnchors, { cull: CULL_MID });

      // Cantilever roof + banner on the main stand only.
      const mainAnchors = standAnchors.filter((_, i) => this.stands[i].main);
      if (mainAnchors.length) {
        const r = this.builder();
        const rows2 = 9, width2 = 78;
        const topY = rows2 * 0.78 + 3.4;
        for (let k = -4; k <= 4; k++) {
          const x = (k / 4) * width2 * 0.48;
          r.tube(x, rows2 * 0.78, -rows2 * 1.15, x, topY, -rows2 * 1.15, 0.16, 6, 0x6a7079);
          r.tube(x, topY, -rows2 * 1.15, x, topY - 0.9, 2.2, 0.13, 6, 0x6a7079);
        }
        r.box(0, topY - 0.35, -rows2 * 1.15 * 0.5 + 1.0, width2 * 0.5 + 1.2, 0.16, rows2 * 1.15 * 0.5 + 1.6,
          0xc9ced6, { shade: { top: 1.2, bottom: 0.5 } });
        this.emit('standRoof', r.build('standRoof'), this.metal, mainAnchors, { cull: CULL_MID });

        const bn = this.builder();
        bn.banner(0, topY - 0.6, 2.0, 26, 2.4, 0, 0xffffff, 5, [0, 0, 1, 1]);
        this.emit('standBanner', bn.build('standBanner'), this.atlasSway, mainAnchors,
          { cull: CULL_MID, atlasCells: 8, shadow: false });
      }
    }

    // ---- checkered flags + marshal posts -------------------------------------
    {
      const anchors = roadside(ctx, rng, { spacing: 150, min: 4, max: 7, sides: 2, limit: 16 });
      const b = this.builder();
      b.prism(0, 0, 0, 0.07, 5.2, 6, 0xd8dce2, { capBottom: true });
      this.emit('flagPole', b.build('flagPole'), this.metal, anchors, { cull: CULL_NEAR });

      const f = this.builder();
      // Checkerboard from 4x3 quads, alternating colour, flapping outward.
      const cols = 5, rowsF = 4, cw = 0.42, chh = 0.34;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rowsF; j++) {
          f.flap = ((i + 0.5) / cols) ** 1.6;
          const x = 0.1 + i * cw;
          const y = 5.05 - j * chh;
          const col = (i + j) % 2 ? 0xf4f2ec : 0x14171b;
          f.quad(x, y, 0, x + cw, y, 0, x + cw, y - chh, 0, x, y - chh, 0, col, 1.05);
        }
      }
      f.flap = 0;
      this.emit('checkerFlag', f.build('checkerFlag'), this.matteSway, anchors,
        { cull: CULL_NEAR, shadow: false });
    }
    {
      const anchors = roadside(ctx, rng, { spacing: 210, min: 8, max: 12, limit: 10 });
      const b = this.builder();
      b.box(0, 0, 0, 1.3, 1.25, 1.1, 0xe6e3d8, { shade: { top: 1.05 } });
      b.box(0, 1.25, 0, 1.5, 0.14, 1.3, 0xc0342c);
      b.box(0, 0.95, 1.05, 1.0, 0.55, 0.06, 0x2a2f36);
      b.prism(1.1, 0, 0.9, 0.07, 3.4, 6, 0x9aa1a9, { capBottom: true });
      b.box(0.7, 1.75, -1.0, 0.5, 0.5, 0.06, 0xf2c53d);
      this.emit('marshalPost', b.build('marshalPost'), this.matte, anchors, { cull: CULL_NEAR });
    }

    // ---- floodlights ---------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, { spacing: 165, min: 14, max: 26, sides: 2, limit: this.count(14) });
      const b = this.builder();
      const H = 22;
      for (const dx of [-0.62, 0.62]) {
        for (const dz of [-0.62, 0.62]) {
          b.prism(dx, 0, dz, 0.11, H, 6, 0x6f757e, { capBottom: true, taper: 0.45 });
        }
      }
      for (let k = 0; k < 9; k++) {
        const y = 1.8 + k * 2.2;
        const w = 0.62 * (1 - (y / H) * 0.55);
        b.tube(-w, y, -w, w, y + 1.4, w, 0.05, 4, 0x7d848d);
        b.tube(w, y, -w, -w, y + 1.4, w, 0.05, 4, 0x7d848d);
      }
      b.box(0, H, 0, 1.9, 0.16, 1.0, 0x4c525a);
      this.emit('floodMast', b.build('floodMast'), this.metal, anchors, { cull: CULL_FAR });

      const l = this.builder();
      for (let k = 0; k < 6; k++) {
        const x = (k % 3 - 1) * 1.15;
        const y = 22.5 + Math.floor(k / 3) * 0.85;
        l.box(x, y, 0.18, 0.5, 0.36, 0.1, 0xfff6dd);
        l.prism(x, y - 0.36, 0.0, 0.42, 0.3, 6, 0x2a2e34, { taper: 1.25 });
      }
      this.emit('floodHead', l.build('floodHead'), this.glow, anchors,
        { cull: CULL_FAR, bloom: true, shadow: false });
    }

    // ---- balloon arch --------------------------------------------------------
    {
      const st0 = st[Math.floor(st.length * 0.42)];
      const arches: Anchor[] = [st0, st[Math.floor(st.length * 0.72)]].map((s) => ({
        x: s.px, y: this.field.heightAt(s.px, s.pz), z: s.pz,
        yaw: Math.atan2(s.bx, s.bz), side: 0, arc: s.s, scale: 1, seed: rng.next(),
      }));
      const b = this.builder();
      const span = hw + 3;
      const cols = [0xff4a3d, 0xffd23f, 0x3fa9ff, 0x5ee06a, 0xff7be0];
      const N = 34;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const x = (t * 2 - 1) * span;
        const y = Math.sin(t * Math.PI) * (span * 0.62) + 0.4;
        // Free-floating balloons bob; the tethered ends don't.
        b.flap = Math.sin(t * Math.PI);
        const r = 0.42 + (i % 3) * 0.05;
        b.sphere(x, y, 0, r, 8, 6, cols[i % cols.length], { squash: 1.12 });
        b.prism(x, y - r - 0.12, 0, 0.05, 0.14, 4, cols[i % cols.length], { taper: 0.2 });
      }
      b.flap = 0;
      this.emit('balloonArch', b.build('balloonArch'), this.glowSoft, arches,
        { cull: CULL_NEAR, shadow: false });
    }

    // ---- distance / turn signs ----------------------------------------------
    {
      const anchors = roadside(ctx, rng, { spacing: 95, min: 4, max: 6.5, limit: this.count(18) });
      const b = this.builder();
      b.prism(0, 0, 0, 0.08, 2.4, 6, 0x8f959d, { capBottom: true });
      b.plate(0, 2.6, 0.05, 1.5, 1.0, 0, 0xffffff, { uvRect: [0.05, 0.1, 0.95, 0.9] });
      this.emit('roadSign', b.build('roadSign'), this.atlas, anchors,
        { cull: 200, atlasCells: 8 });
    }
  }

  // =========================================================================
  // COASTAL
  // =========================================================================

  private buildCoastal(): void {
    const ctx = this.ctx, rng = this.rng;

    // ---- beach huts ----------------------------------------------------------
    {
      const anchors = shoreline(ctx, rng, this.count(20), [1.2, 5.5]);
      const b = this.builder();
      const walls = 0xf2ece0;
      b.box(0, 0, 0, 1.9, 1.35, 1.7, walls, { shade: { top: 1.02, side: 1.0 } });
      // Pitched roof from two slanted quads.
      const rh = 1.05;
      b.quad(-2.15, 1.3, -1.95, 0, 1.3 + rh, -1.95, 0, 1.3 + rh, 1.95, -2.15, 1.3, 1.95, 0xd7462f, 1.08);
      b.quad(0, 1.3 + rh, -1.95, 2.15, 1.3, -1.95, 2.15, 1.3, 1.95, 0, 1.3 + rh, 1.95, 0xc23c28, 0.94);
      b.box(0, -0.2, 1.75, 0.55, 1.15, 0.06, 0x2f5f8a);
      b.box(0, 0.35, -1.75, 0.42, 0.36, 0.06, 0x8fc4dd);
      for (const sx of [-1, 1]) b.prism(sx * 1.6, -0.7, sx * 1.4, 0.11, 0.75, 5, 0x6b5334);
      this.emit('beachHut', b.build('beachHut'), this.matte, anchors, { cull: CULL_MID });
    }

    // ---- parasols ------------------------------------------------------------
    {
      const anchors = shoreline(ctx, rng, this.count(34), [0.4, 3.2]);
      const b = this.builder();
      b.prism(0, 0, 0, 0.055, 2.35, 6, 0xe8e2d4, { capBottom: true });
      const cols = [0xf05a4a, 0xf6d047, 0x49b8e8, 0xf7f3e8];
      const seg = 10;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        const R = 1.6;
        b.flap = 0.35;
        b.quad(
          0, 2.5, 0,
          Math.cos(a0) * R, 2.05, Math.sin(a0) * R,
          Math.cos(a1) * R, 2.05, Math.sin(a1) * R,
          0, 2.5, 0,
          cols[i % cols.length], 1.12,
        );
        b.flap = 0;
      }
      this.emit('parasol', b.build('parasol'), this.matteSway, anchors, { cull: 220 });
    }

    // ---- jetties + moored boats ---------------------------------------------
    {
      const anchors = shoreline(ctx, rng, this.count(7), [-0.4, 1.4]);
      const b = this.builder();
      const len = 26;
      for (let i = 0; i < 11; i++) {
        const z = -i * (len / 10);
        for (const sx of [-1.5, 1.5]) {
          b.prism(sx, -3.2, z, 0.16, 4.0, 6, 0x5d4630, { capBottom: false });
        }
      }
      for (let i = 0; i < 34; i++) {
        b.box(0, 0.78, -i * (len / 33), 1.85, 0.07, len / 66, i % 3 ? 0x9a7a4f : 0x8d6f47,
          { shade: { top: 1.1, side: 0.8 } });
      }
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          b.prism(sx * 1.75, 0.8, -i * (len / 5.5), 0.07, 0.95, 5, 0x6b5334, { capBottom: false });
        }
        b.tube(sx * 1.75, 1.68, 0, sx * 1.75, 1.68, -len, 0.05, 4, 0xb8a98c);
      }
      this.emit('jetty', b.build('jetty'), this.matte, anchors, { cull: CULL_MID });
    }
    {
      const anchors = shoreline(ctx, rng, this.count(10), [-1.6, 0.2]);
      const b = this.builder();
      // Hull: tapered box with a raised prow.
      const hull = [0xe8e4d8, 0x2f6fa8, 0xd94f3d, 0xf2c94c];
      b.box(0, 0.25, 0, 1.05, 0.5, 3.0, hull[0], { taper: 1.12, shade: { top: 1.06 } });
      b.quad(-1.15, 0.75, -3.0, 1.15, 0.75, -3.0, 0, 0.55, -4.1, 0, 0.55, -4.1, 0x2f6fa8, 1.0);
      b.box(0, 0.62, 0.4, 0.92, 0.12, 2.3, 0x8d6f47, { shade: { top: 1.14 } });
      b.box(0, 0.95, 1.6, 0.72, 0.42, 0.7, 0xf4f0e4);
      b.prism(0, 0.7, -0.4, 0.055, 4.2, 5, 0xe6e2d6);
      b.flap = 0.8;
      b.plate(0.7, 2.6, -0.4, 1.4, 2.6, Math.PI * 0.5, 0xf6f3ea, { single: false });
      b.flap = 0;
      this.emit('boat', b.build('boat'), this.matteSway, anchors, { cull: CULL_MID });
    }

    // ---- lighthouse ----------------------------------------------------------
    {
      const cand = shoreline(ctx, rng, 6, [2.5, 14]);
      const anchors = cand.slice(0, 1);
      if (anchors.length) {
        const b = this.builder();
        b.prism(0, 0, 0, 5.4, 1.6, 12, 0x8d8578, { taper: 0.82, capBottom: false });
        // Red/white banded tower.
        for (let i = 0; i < 7; i++) {
          const y = 1.4 + i * 3.0;
          const r = 3.5 - i * 0.28;
          b.prism(0, y, 0, r, 3.05, 14, i % 2 ? 0xd6402f : 0xf2eee2,
            { taper: (3.5 - (i + 1) * 0.28) / r, capBottom: false });
        }
        b.prism(0, 22.4, 0, 2.4, 0.5, 14, 0x3a4048, { taper: 1.15 });
        b.prism(0, 22.9, 0, 2.75, 0.25, 14, 0x2c3238);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          b.prism(Math.cos(a) * 2.0, 23.1, Math.sin(a) * 2.0, 0.09, 2.6, 5, 0x3a4048);
        }
        b.prism(0, 25.7, 0, 2.5, 0.35, 14, 0x2c3238, { taper: 0.7 });
        b.prism(0, 26.05, 0, 1.75, 2.0, 14, 0xd6402f, { taper: 0.06 });
        this.emit('lighthouse', b.build('lighthouse'), this.matte, anchors, { cull: CULL_FAR });

        const l = this.builder();
        l.prism(0, 23.3, 0, 1.55, 2.1, 12, 0xfff3cc);
        this.emit('lighthouseLamp', l.build('lighthouseLamp'), this.glow, anchors,
          { cull: CULL_FAR, bloom: true, shadow: false });
      }
    }

    // ---- cliff rocks ---------------------------------------------------------
    this.buildRocks(this.count(46), 0x8a8578, 0x6f6a5e, 1.0);

    // ---- seagulls ------------------------------------------------------------
    {
      const n = this.count(38);
      const anchors: Anchor[] = [];
      for (let i = 0; i < n; i++) {
        anchors.push({ x: 0, y: 0, z: 0, yaw: 0, side: 0, arc: 0, scale: 1, seed: rng.next() });
      }
      const b = this.builder();
      b.uvScale = 2;
      b.box(0, 0, 0, 0.09, 0.08, 0.28, 0xf4f2ec, { taper: 0.6 });
      b.box(0, 0.03, -0.28, 0.055, 0.05, 0.09, 0xf6f4ee);
      b.box(0, 0.03, -0.4, 0.03, 0.025, 0.06, 0xf2a13a);
      // Wings: swept quads, tips flap via aFlap.
      for (const sx of [-1, 1]) {
        b.flap = 0.35;
        b.quad(0, 0.02, 0.06, sx * 0.62, 0.14, -0.02, sx * 0.6, 0.13, 0.12, 0, 0.02, 0.16, 0xf8f6f0, 1.1);
        b.flap = 0;
      }
      b.box(0, 0.0, 0.28, 0.07, 0.02, 0.1, 0x3a3d42, { taper: 0.4 });
      const mesh = this.emit('seagull', b.build('seagull'), this.matteSway, anchors,
        { cull: 420, shadow: false, motion: 'gull' });
      if (mesh) {
        // Flock state: centre angle, radius, altitude, angular speed, phase.
        const data = new Float32Array(mesh.count * 5);
        for (let i = 0; i < mesh.count; i++) {
          data[i * 5] = rng.next() * Math.PI * 2;
          data[i * 5 + 1] = 90 + rng.next() * 380;
          data[i * 5 + 2] = Math.max(ctx.waterLevel + 6, 14) + rng.next() * 34;
          data[i * 5 + 3] = (0.045 + rng.next() * 0.05) * (rng.next() < 0.5 ? -1 : 1);
          data[i * 5 + 4] = rng.next() * 6.28;
        }
        this.meshes[this.meshes.length - 1].data = data;
      }
    }
  }

  // =========================================================================
  // CITY
  // =========================================================================

  private buildCity(): void {
    const ctx = this.ctx, rng = this.rng;

    // ---- skyscrapers ---------------------------------------------------------
    {
      const anchors = annulus(ctx, rng, {
        count: this.count(52), min: 90, max: 620, minRoadDist: 58, maxSlope: 0.42,
      });
      for (const a of anchors) a.scale = 0.7 + rng.next() * 1.5;

      const b = this.builder();
      b.uvScale = 0.22;
      const H = 46;
      const facade = 0x50565f;
      // Setback massing: three stacked blocks, each smaller than the last.
      b.box(0, 0, 0, 9.5, H * 0.5, 9.5, facade, { shade: { side: 1.0, top: 1.1 } });
      b.box(0, H * 0.5, 0, 7.6, H * 0.28, 7.6, 0x585f68);
      b.box(0, H * 0.5 + H * 0.56, 0, 5.6, H * 0.13, 5.6, 0x4a5058);
      // Crown + mast.
      b.box(0, H * 0.5 + H * 0.82, 0, 3.0, 1.2, 3.0, 0x3d4249);
      b.prism(0, H * 0.5 + H * 0.82 + 1.2, 0, 0.16, 7.5, 6, 0x9aa1a9, { taper: 0.35 });
      // Ground-floor plinth and canopy.
      b.box(0, -H * 0.5, 0, 10.4, 2.2, 10.4, 0x33383e, { shade: { top: 1.0 } });
      b.box(0, -H * 0.5 + 2.4, 0, 10.9, 0.16, 10.9, 0x2b3036);
      // Vertical mullions to break the silhouette.
      for (let i = -4; i <= 4; i++) {
        b.box(i * 2.35, 0, 9.55, 0.16, H * 0.5, 0.1, 0x676e77);
        b.box(9.55, 0, i * 2.35, 0.1, H * 0.5, 0.16, 0x676e77);
        b.box(i * 2.35, 0, -9.55, 0.16, H * 0.5, 0.1, 0x676e77);
        b.box(-9.55, 0, i * 2.35, 0.1, H * 0.5, 0.16, 0x676e77);
      }
      this.emit('skyscraper', b.build('skyscraper'), this.matte, anchors,
        { cull: CULL_FAR, place: (a, _i, m) => {
          _q.setFromAxisAngle(_axisY, a.yaw);
          _s.set(0.75 + a.seed * 0.7, a.scale, 0.75 + (1 - a.seed) * 0.7);
          m.compose(_v.set(a.x, a.y + 46 * 0.5 * a.scale, a.z), _q, _s);
          return true;
        } });

      // Window grid — one quad per window, lit state hashed per (cell, instance).
      const w = this.builder();
      w.uvScale = 1;
      let cell = 0;
      const floors = 22, perSide = 7;
      for (let f = 0; f < floors; f++) {
        const y = -H * 0.5 + 2.9 + f * ((H - 4) / floors);
        for (let s = 0; s < 4; s++) {
          const yaw = s * Math.PI * 0.5;
          for (let i = 0; i < perSide; i++) {
            w.cell = cell++;
            const off = (i - (perSide - 1) * 0.5) * 2.35;
            const ca = Math.cos(yaw), sa = Math.sin(yaw);
            const px = ca * off + sa * 9.62;
            const pz = sa * off - ca * 9.62;
            w.plate(px, y, pz, 1.75, 1.35, yaw + Math.PI, 0xffd9a0, { single: true });
          }
        }
      }
      w.cell = 0;
      this.emit('skyscraperWindows', w.build('windows'), this.windows, anchors,
        { cull: CULL_FAR, bloom: true, shadow: false, place: (a, _i, m) => {
          _q.setFromAxisAngle(_axisY, a.yaw);
          _s.set(0.75 + a.seed * 0.7, a.scale, 0.75 + (1 - a.seed) * 0.7);
          m.compose(_v.set(a.x, a.y + 46 * 0.5 * a.scale, a.z), _q, _s);
          return true;
        } });
    }

    // ---- neon signs ----------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, { spacing: 46, min: 9, max: 22, sides: 2, limit: this.count(30) });
      const b = this.builder();
      b.prism(0, 0, 0, 0.13, 8.5, 6, 0x22262b, { capBottom: true });
      b.box(0, 8.6, 0, 1.5, 1.6, 0.16, 0x171a1e);
      this.emit('neonFrame', b.build('neonFrame'), this.metal, anchors, { cull: 340 });

      const g = this.builder();
      const neonCols = [0xff2e88, 0x2ef0ff, 0xffe23a, 0x8b5cff, 0x39ff88];
      for (let i = 0; i < 5; i++) {
        const col = neonCols[i];
        // A ring plus two bars — reads as a sign at speed and blooms hard.
        g.cell = i;
        g.torus(0, 9.1, 0.12, 0.62, 0.075, 14, 5, col, 1);
        g.box(0, 8.1, 0.12, 0.85, 0.06, 0.05, col);
        g.box(0, 7.85, 0.12, 0.6, 0.05, 0.05, col);
      }
      g.cell = 0;
      this.emit('neonSign', g.build('neonSign'), this.glow, anchors,
        { cull: 340, bloom: true, shadow: false });
    }

    // ---- streetlights --------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, { spacing: 27, min: 2.6, max: 4.0, sides: 2, limit: this.count(70) });
      const b = this.builder();
      b.prism(0, 0, 0, 0.13, 8.2, 8, 0x3d434a, { capBottom: true, taper: 0.62 });
      b.tube(0, 8.1, 0, 0, 8.9, -2.0, 0.09, 6, 0x3d434a);
      b.box(0, 8.75, -2.4, 0.32, 0.12, 0.62, 0x2c3137, { taper: 0.8 });
      this.emit('streetlight', b.build('streetlight'), this.metal, anchors, { cull: 300 });

      const l = this.builder();
      l.box(0, 8.62, -2.4, 0.28, 0.06, 0.55, 0xffe2b0);
      this.emit('streetlightLamp', l.build('streetlightLamp'), this.glow, anchors,
        { cull: 300, bloom: true, shadow: false });
    }

    // ---- traffic lights ------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, { spacing: 120, min: 3.2, max: 5, sides: 2, limit: this.count(12) });
      const b = this.builder();
      b.prism(0, 0, 0, 0.11, 4.2, 8, 0x2c3137, { capBottom: true });
      b.box(0, 4.6, 0, 0.24, 0.62, 0.2, 0x1d2126);
      b.box(0, 5.3, 0, 0.3, 0.08, 0.26, 0x1d2126);
      this.emit('trafficLight', b.build('trafficLight'), this.metal, anchors, { cull: 220 });
      const g = this.builder();
      g.cell = 0; g.sphere(0, 4.86, 0.2, 0.09, 7, 5, 0xff3b2f);
      g.cell = 1; g.sphere(0, 4.6, 0.2, 0.09, 7, 5, 0xffc93a);
      g.cell = 2; g.sphere(0, 4.34, 0.2, 0.09, 7, 5, 0x3fe06a);
      g.cell = 0;
      this.emit('trafficLightLamps', g.build('trafficLamps'), this.glow, anchors,
        { cull: 220, bloom: true, shadow: false });
    }

    // ---- parked cars ---------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, {
        spacing: 22, min: 7, max: 15, sides: 2, limit: this.count(44), skipNearStands: this.stands,
      });
      const paints = [0xc9302c, 0x2f6fd0, 0xe8e6df, 0x2b2f35, 0xd8b13a, 0x2f9e6b];
      const b = this.builder();
      b.uvScale = 1.2;
      b.box(0, 0.52, 0, 0.9, 0.34, 2.15, 0xdedbd4, { taper: 0.96, shade: { top: 1.05 } });
      b.box(0, 0.95, -0.1, 0.78, 0.3, 1.15, 0xcfccc5, { taper: 0.82, shade: { top: 1.12 } });
      b.box(0, 0.2, 0, 0.94, 0.16, 2.2, 0x1b1e22);
      for (const sx of [-1, 1]) for (const sz of [-1.42, 1.42]) {
        b.prism(sx * 0.88, 0.02, sz, 0.31, 0.2, 8, 0x14171a, { yaw: Math.PI * 0.5 });
      }
      b.box(0, 0.62, 2.2, 0.6, 0.1, 0.05, 0xf6efd8);
      b.box(0, 0.62, -2.2, 0.6, 0.1, 0.05, 0xd6402f);
      this.emit('parkedCar', b.build('parkedCar'), this.matte, anchors, {
        cull: 260,
        place: (a, i, m) => {
          _q.setFromAxisAngle(_axisY, a.yaw + Math.PI * 0.5 + (a.seed - 0.5) * 0.1);
          _m.identity();
          m.compose(_v.set(a.x, a.y, a.z), _q, _s.setScalar(1));
          void i;
          return true;
        },
      });
      // Recolour per instance via instanceColor — one extra buffer, no extra draw.
      const last = this.meshes[this.meshes.length - 1];
      if (last && last.mesh.name === 'Prop:parkedCar') {
        const m = last.mesh;
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.count * 3), 3);
        for (let i = 0; i < m.count; i++) {
          _c.setHex(paints[i % paints.length]);
          m.setColorAt(i, _c);
        }
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }

    // ---- cable tram ----------------------------------------------------------
    {
      const st = ctx.stations;
      if (st.length > 40) {
        const anchors: Anchor[] = [];
        for (let i = 0; i < 3; i++) {
          anchors.push({ x: 0, y: 0, z: 0, yaw: 0, side: 0, arc: 0, scale: 1, seed: i / 3 });
        }
        const b = this.builder();
        b.uvScale = 0.8;
        b.box(0, 0, 0, 1.5, 1.15, 3.4, 0xd8402f, { taper: 0.94, shade: { top: 1.08 } });
        b.box(0, 1.2, 0, 1.6, 0.12, 3.5, 0xf0ece0);
        b.box(0, 1.45, 0, 0.22, 0.3, 0.22, 0x2c3137);
        b.tube(0, 1.7, 0, 0, 3.6, 0.4, 0.05, 4, 0x9aa1a9);
        for (const sz of [-1, 1]) {
          b.box(0, 0.25, sz * 3.45, 1.35, 0.7, 0.08, 0x8fc4dd);
        }
        this.emit('tram', b.build('tram'), this.matte, anchors,
          { cull: CULL_MID, motion: 'tram' });
        const entry = this.meshes[this.meshes.length - 1];
        if (entry) {
          const data = new Float32Array(3 * 5);
          for (let i = 0; i < 3; i++) {
            data[i * 5] = (i / 3) * ctx.lapLength;      // arc position
            data[i * 5 + 1] = 9.5 + i * 1.5;            // height above ground
            data[i * 5 + 2] = 24 + i * 6;               // lateral offset
            data[i * 5 + 3] = 11 + i * 2.5;             // speed m/s
            data[i * 5 + 4] = i % 2 === 0 ? 1 : -1;     // side
          }
          entry.data = data;
        }
      }
    }

    this.buildRocks(this.count(14), 0x6f747c, 0x565b63, 0.8);
  }

  // =========================================================================
  // VOLCANO
  // =========================================================================

  private buildVolcano(): void {
    const ctx = this.ctx, rng = this.rng;

    // ---- obsidian formations -------------------------------------------------
    {
      const anchors = roadside(ctx, rng, {
        spacing: 19, min: 4, max: 40, sides: 2, limit: this.count(80),
        maxSlope: 0.85, faceRoad: false, skipNearStands: this.stands,
      });
      for (const a of anchors) a.scale = 0.6 + rng.next() * 1.8;
      const b = this.builder();
      // Shard cluster: sharp, glassy, angled crystals.
      for (let i = 0; i < 6; i++) {
        const a = rng.next() * Math.PI * 2;
        const d = rng.next() * 1.5;
        const h = 1.6 + rng.next() * 3.4;
        b.prism(Math.cos(a) * d, -0.3, Math.sin(a) * d, 0.42 + rng.next() * 0.4, h, 5,
          i % 2 ? 0x1b1620 : 0x241c26,
          { taper: 0.08 + rng.next() * 0.16, yaw: rng.next() * 3, shade: { top: 1.5, side: 1.0 } });
      }
      this.emit('obsidian', b.build('obsidian'), this.matte, anchors, { cull: 360 });
    }

    // ---- lava falls ----------------------------------------------------------
    {
      const anchors = annulus(ctx, rng, {
        count: this.count(9), min: 130, max: 520, minRoadDist: 45, maxSlope: 2.5, dry: false,
      });
      const b = this.builder();
      b.box(0, 0, 0, 3.6, 1.2, 3.2, 0x1a1214, { taper: 1.4 });
      for (let i = 0; i < 5; i++) {
        b.box((i - 2) * 1.2, -12 + i * 0.4, 0.4, 0.55 + rng.next() * 0.4, 12, 0.4, 0x2a1a18,
          { taper: 0.7 });
      }
      this.emit('lavaFallRock', b.build('lavaFallRock'), this.matte, anchors, { cull: CULL_MID });

      const g = this.builder();
      for (let i = 0; i < 5; i++) {
        const x = (i - 2) * 1.2;
        g.cell = i;
        g.box(x, -12 + i * 0.4, 0.62, 0.4 + rng.next() * 0.3, 12, 0.16, 0xff6a1e, { taper: 0.85 });
        g.box(x, 0.9, 0.62, 0.5, 0.4, 0.3, 0xffd48a);
      }
      g.cell = 0;
      this.emit('lavaFall', g.build('lavaFall'), this.glow, anchors,
        { cull: CULL_MID, bloom: true, shadow: false });
    }

    // ---- ember vents ---------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, {
        spacing: 33, min: 6, max: 34, sides: 2, limit: this.count(34), faceRoad: false,
      });
      const b = this.builder();
      b.prism(0, -0.4, 0, 1.5, 1.0, 7, 0x201618, { taper: 0.62, shade: { top: 0.8 } });
      b.prism(0, 0.5, 0, 0.9, 0.25, 7, 0x160f11, { taper: 0.7 });
      this.emit('emberVent', b.build('emberVent'), this.matte, anchors, { cull: 300 });
      const g = this.builder();
      g.prism(0, 0.55, 0, 0.78, 0.22, 7, 0xff7a2a, { taper: 0.55 });
      this.emit('emberVentGlow', g.build('emberVentGlow'), this.glowSoft, anchors,
        { cull: 300, bloom: true, shadow: false });
    }

    // ---- stone pillars + ruins ----------------------------------------------
    {
      const anchors = roadside(ctx, rng, {
        spacing: 44, min: 8, max: 26, sides: 2, limit: this.count(30), faceRoad: false,
      });
      for (const a of anchors) a.scale = 0.8 + rng.next() * 0.9;
      const b = this.builder();
      b.prism(0, 0, 0, 1.5, 0.6, 8, 0x53483f, { taper: 0.82 });
      b.prism(0, 0.6, 0, 1.15, 8.5, 12, 0x6b5f52, { taper: 0.86, capBottom: false });
      // Fluting.
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        b.prism(Math.cos(a) * 1.1, 0.6, Math.sin(a) * 1.1, 0.12, 8.4, 4, 0x60544a, { capBottom: false });
      }
      b.prism(0, 9.1, 0, 1.35, 0.75, 8, 0x6b5f52, { taper: 1.08 });
      b.box(0, 9.85, 0, 1.65, 0.3, 1.65, 0x74685a);
      this.emit('stonePillar', b.build('stonePillar'), this.matte, anchors, { cull: CULL_MID });
    }
    {
      const anchors = annulus(ctx, rng, {
        count: this.count(16), min: 80, max: 460, minRoadDist: 40, maxSlope: 0.6,
      });
      const b = this.builder();
      b.box(0, 0, 0, 7.5, 0.5, 6.0, 0x5b5044, { shade: { top: 1.1 } });
      // Broken walls at varying heights.
      const heights = [4.2, 2.1, 5.6, 1.4, 3.3];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        b.box(Math.cos(a) * 5.5, 0.5, Math.sin(a) * 4.4, 1.6, heights[i] * 0.5, 0.55,
          i % 2 ? 0x655a4d : 0x5b5044, { yaw: a, taper: 0.9 });
      }
      for (const sx of [-1, 1]) {
        b.prism(sx * 3.2, 0.5, -3.6, 0.55, 4.6 + sx * 0.8, 8, 0x6b5f52, { taper: 0.9 });
      }
      this.emit('ruin', b.build('ruin'), this.matte, anchors, { cull: CULL_MID });
    }

    // ---- braziers ------------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, { spacing: 38, min: 3.5, max: 5.5, sides: 2, limit: this.count(40) });
      const b = this.builder();
      b.prism(0, 0, 0, 0.42, 0.25, 8, 0x2c2520, { taper: 0.7 });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        b.tube(Math.cos(a) * 0.3, 0.2, Math.sin(a) * 0.3, 0, 1.5, 0, 0.07, 4, 0x3a322b);
      }
      b.prism(0, 1.45, 0, 0.5, 0.5, 8, 0x3a322b, { taper: 1.5, capTop: false });
      this.emit('brazier', b.build('brazier'), this.metal, anchors, { cull: 260 });

      const g = this.builder();
      g.flap = 1;
      g.prism(0, 1.85, 0, 0.5, 1.15, 7, 0xff8a2a, { taper: 0.1 });
      g.prism(0, 1.9, 0, 0.28, 0.85, 6, 0xffe0a0, { taper: 0.08 });
      g.flap = 0;
      this.emit('brazierFlame', g.build('brazierFlame'), this.glowSoft, anchors,
        { cull: 260, bloom: true, shadow: false });
    }

    this.buildRocks(this.count(60), 0x2a2022, 0x181215, 1.2);
  }

  // =========================================================================
  // OTHER THEMES — light dressing so nothing looks bare
  // =========================================================================

  private buildPastoral(): void {
    const ctx = this.ctx, rng = this.rng;
    // Fence lines + hay bales + barn.
    {
      const anchors = roadside(ctx, rng, {
        spacing: 9, min: 16, max: 44, sides: 2, limit: this.count(90), faceRoad: false,
      });
      const b = this.builder();
      for (const sx of [-1, 1]) b.prism(sx * 2.2, 0, 0, 0.09, 1.3, 5, 0x7a6244, { capBottom: true });
      b.box(0, 1.0, 0, 2.3, 0.07, 0.05, 0x8d7350);
      b.box(0, 0.62, 0, 2.3, 0.07, 0.05, 0x8d7350);
      this.emit('woodFence', b.build('woodFence'), this.matte, anchors, { cull: 240 });
    }
    {
      const anchors = annulus(ctx, rng, { count: this.count(34), min: 60, max: 480, minRoadDist: 28 });
      const b = this.builder();
      b.prism(0, 0, 0, 0.95, 1.6, 12, 0xc9a95e, { yaw: Math.PI * 0.5, taper: 1 });
      this.emit('hayBale', b.build('hayBale'), this.matte, anchors, {
        cull: 300,
        place: (a, _i, m) => {
          _euler.set(Math.PI * 0.5, a.yaw, 0);
          _q.setFromEuler(_euler);
          m.compose(_v.set(a.x, a.y + 0.95, a.z), _q, _s.setScalar(1));
          return true;
        },
      });
    }
    this.buildBarns(this.count(7));
    this.buildRocks(this.count(30), 0x8a8578, 0x6f6a5e, 0.9);
  }

  private buildAlpine(): void {
    const ctx = this.ctx, rng = this.rng;
    this.buildBarns(this.count(9));
    {
      const anchors = roadside(ctx, rng, { spacing: 15, min: 2.4, max: 3.6, sides: 2, limit: this.count(90) });
      const b = this.builder();
      b.prism(0, 0, 0, 0.1, 2.6, 6, 0xd9502f, { capBottom: true });
      for (let i = 0; i < 4; i++) b.box(0, 0.5 + i * 0.6, 0, 0.12, 0.22, 0.12, 0xf4f1e8);
      this.emit('snowPole', b.build('snowPole'), this.matte, anchors, { cull: 260 });
    }
    this.buildRocks(this.count(44), 0x7d8490, 0x5c626d, 1.0);
  }

  private buildDesert(): void {
    const ctx = this.ctx, rng = this.rng;
    {
      const anchors = roadside(ctx, rng, {
        spacing: 26, min: 6, max: 40, sides: 2, limit: this.count(40), faceRoad: false,
      });
      const b = this.builder();
      // Weathered timber water tower.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.78;
        b.prism(Math.cos(a) * 1.6, 0, Math.sin(a) * 1.6, 0.12, 5.2, 5, 0x6b5334, { capBottom: true });
      }
      b.prism(0, 5.2, 0, 2.1, 2.6, 10, 0x8a6f47, { taper: 0.94 });
      b.prism(0, 7.8, 0, 2.3, 1.1, 10, 0x5c4a30, { taper: 0.05 });
      this.emit('waterTower', b.build('waterTower'), this.matte, anchors, { cull: CULL_MID });
    }
    this.buildRocks(this.count(70), 0xa3784c, 0x7d5a38, 1.4);
  }

  private buildBarns(count: number): void {
    const anchors = annulus(this.ctx, this.rng, { count, min: 70, max: 500, minRoadDist: 34, maxSlope: 0.34 });
    const b = this.builder();
    b.uvScale = 0.45;
    b.box(0, 0, 0, 6.5, 3.2, 4.6, 0xa8442f, { shade: { top: 1.0 } });
    const rh = 2.6;
    b.quad(-7.0, 3.1, -5.0, 0, 3.1 + rh, -5.0, 0, 3.1 + rh, 5.0, -7.0, 3.1, 5.0, 0x53585f, 1.1);
    b.quad(0, 3.1 + rh, -5.0, 7.0, 3.1, -5.0, 7.0, 3.1, 5.0, 0, 3.1 + rh, 5.0, 0x484d54, 0.92);
    b.box(0, 0.4, 4.65, 1.5, 2.4, 0.08, 0xe4dccb);
    b.box(0, 4.2, 4.6, 0.7, 0.7, 0.08, 0xe4dccb);
    for (const sx of [-1, 1]) b.box(sx * 4.2, 0, 4.62, 0.12, 3.1, 0.06, 0xe4dccb);
    b.prism(6.9, 3.1, 0, 0.9, 4.5, 10, 0xb0b6be, { taper: 0.9 });
    b.prism(6.9, 7.6, 0, 1.0, 0.9, 10, 0x53585f, { taper: 0.1 });
    this.emit('barn', b.build('barn'), this.matte, anchors, { cull: CULL_MID });
  }

  /** Rock clusters — the cheapest way to stop terrain looking like a bedsheet. */
  private buildRocks(count: number, hexA: number, hexB: number, size: number): void {
    const rng = this.rng;
    const anchors = annulus(this.ctx, rng, {
      count, min: 40, max: this.field.extent * 0.44, minRoadDist: 17, maxSlope: 1.4,
    });
    // Add a band close to the road so the verges have structure too.
    for (const a of roadside(this.ctx, rng, {
      spacing: 17, min: 5, max: 30, sides: 2, limit: Math.round(count * 0.7),
      faceRoad: false, maxSlope: 1.1,
    })) anchors.push(a);
    for (const a of anchors) a.scale = (0.55 + rng.next() * 1.7) * size;

    const b = this.builder();
    b.jitter = 0.09;
    for (let i = 0; i < 4; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = rng.next() * 1.3;
      const r = 0.7 + rng.next() * 0.9;
      b.sphere(Math.cos(a) * d, -r * 0.35 + rng.next() * 0.2, Math.sin(a) * d, r, 7, 4,
        i % 2 ? hexA : hexB, { squash: 0.62 + rng.next() * 0.3 });
    }
    this.emit('rock', b.build('rock'), this.matte, anchors, { cull: 380 });
  }

  // =========================================================================
  // AUTHORED PROPS FROM THE TRACK
  // =========================================================================

  /**
   * Track may hand us explicit placements. Map the ones we understand onto the
   * catalogue; anything unknown is reported once and skipped (a wrong prop in
   * the wrong place is worse than no prop).
   */
  private buildAuthored(): void {
    const props = this.ctx.hints.props;
    if (!props || !props.length) return;
    const byType = new Map<string, Anchor[]>();
    const unknown = new Set<string>();

    for (const p of props) {
      const key = normaliseType(p.type);
      if (!key) { unknown.add(p.type); continue; }
      let list = byType.get(key);
      if (!list) { list = []; byType.set(key, list); }
      let yaw = 0;
      if (typeof p.rotation === 'number') yaw = p.rotation;
      else if (p.rotation && typeof (p.rotation as THREE.Euler).y === 'number') yaw = (p.rotation as THREE.Euler).y;
      let scale = 1;
      if (typeof p.scale === 'number') scale = p.scale;
      else if (p.scale && typeof (p.scale as THREE.Vector3).y === 'number') scale = (p.scale as THREE.Vector3).y;
      list.push({
        x: p.position.x, y: p.position.y, z: p.position.z,
        yaw, side: 0, arc: 0, scale: clamp(scale, 0.15, 12), seed: this.rng.next(),
      });
    }

    if (unknown.size) {
      console.info('[Props] track requested prop types with no builder:', [...unknown].join(', '));
    }

    for (const [key, anchors] of byType) {
      const spec = this.authoredSpec(key);
      if (!spec) continue;
      const body = spec.mat ?? this.matte;
      this.emit(`authored:${key}`, spec.geo, body, anchors, {
        cull: spec.cull ?? CULL_MID,
        bloom: body === this.glow || body === this.glowSoft,
        shadow: spec.shadow !== false,
      });
      // Optional companion passes so one authored type can mix materials without
      // a multi-material mesh: an emissive lamp head, a cloth sail, a chain-link
      // panel. Each is still a single instanced draw.
      if (spec.glow) {
        this.emit(`authored:${key}:glow`, spec.glow, spec.softGlow ? this.glowSoft : this.glow,
          anchors, { cull: spec.cull ?? CULL_MID, bloom: true, shadow: false });
      }
      if (spec.cloth) {
        this.emit(`authored:${key}:cloth`, spec.cloth, this.matteSway, anchors,
          { cull: spec.cull ?? CULL_MID, shadow: false });
      }
    }
  }

  /**
   * Geometry recipes for every prop type a track can name.
   *
   * Track authors place these by name in `getDecorationHints().props`; anything
   * without a recipe here used to be silently dropped, which is how the coastal
   * circuit ended up missing its start gantry, its grandstands and its palms.
   * Each recipe returns one instanced body plus, optionally, an emissive part
   * and a cloth part so a single authored type can span three materials.
   */
  private authoredSpec(key: string): AuthoredSpec | null {
    const rng = this.rng;
    switch (key) {
      // ---- race infrastructure -------------------------------------------
      case 'startgantry': {
        const b = this.builder();
        const H = 9.4, halfSpan = 13.5;
        for (const sx of [-1, 1]) {
          // Tapered A-frame legs with a base plinth and a diagonal brace.
          b.box(sx * halfSpan, 0.35, 0, 1.5, 0.35, 1.5, 0x3a3f47, { shade: { top: 1.12 } });
          b.prism(sx * halfSpan, 0.7, 0, 0.85, H - 0.7, 6, 0xd8dade, { taper: 0.62 });
          b.tube(sx * halfSpan, H * 0.42, 0, sx * (halfSpan - 2.6), H, 0, 0.16, 5, 0xb8bcc4);
        }
        // Deep box truss with visible diagonals — reads as steel, not a plank.
        b.box(0, H + 0.55, 0, halfSpan, 0.22, 0.55, 0xe6e8ec);
        b.box(0, H + 1.85, 0, halfSpan, 0.22, 0.55, 0xe6e8ec);
        for (let i = -6; i <= 6; i++) {
          const x = (i / 6) * (halfSpan - 0.6);
          b.tube(x, H + 0.7, 0, x + (i % 2 ? 1.8 : -1.8), H + 1.75, 0, 0.075, 4, 0xc9cdd4);
        }
        b.box(0, H + 2.6, 0, halfSpan * 0.72, 0.6, 0.3, 0x1d222b, { shade: { top: 1.2 } });
        const glow = this.builder();
        // Signal lights along the underside, plus the lit start board.
        for (let i = -4; i <= 4; i++) {
          glow.sphere((i / 4) * (halfSpan - 1.4), H + 0.2, 0.2, 0.19, 6, 4,
            i === 0 ? 0xffe9a8 : 0xff3b2e);
        }
        glow.plate(0, H + 2.6, 0.34, halfSpan * 1.3, 0.9, 0, 0x7fe4ff, { single: true });
        const cloth = this.builder();
        cloth.flap = 1;
        for (const sx of [-1, 1]) {
          cloth.banner(sx * (halfSpan - 4.2), H - 0.1, 0.4, 3.0, 4.4, 0, sx > 0 ? 0xe8332a : 0x0f6bd6, 4);
        }
        return { geo: b.build('startGantry'), glow: glow.build('startGantryGlow'),
          cloth: cloth.build('startGantryCloth'), cull: CULL_FAR };
      }

      case 'grandstand': return { geo: this.standGeometry(true), cull: CULL_FAR };
      case 'crowdstand': return { geo: this.standGeometry(false), cull: CULL_MID };

      case 'balloonarch': {
        const b = this.builder();
        const R = 11, palette = [0xff4d4d, 0xffd23f, 0x4db8ff, 0x5ddc7a, 0xc06bff];
        // Balloons threaded on an arc, alternating size so the arc reads as
        // hand-tied rather than extruded.
        for (let i = 0; i <= 22; i++) {
          const t = i / 22;
          const a = Math.PI * t;
          const r = 0.62 + (i % 3 === 0 ? 0.22 : 0);
          b.sphere(Math.cos(a) * R, Math.sin(a) * R * 0.82 + 0.4, (i % 2 ? 0.3 : -0.3),
            r, 7, 5, palette[i % palette.length], { squash: 1.12 });
        }
        for (const sx of [-1, 1]) b.box(sx * R, 0.3, 0, 0.9, 0.3, 0.9, 0x3a3f47);
        return { geo: b.build('balloonArch'), mat: this.glowSoft, cull: CULL_FAR, shadow: false };
      }

      case 'tunnelportal': {
        const b = this.builder();
        const w = 13, h = 8.5, t = 1.5;
        for (const sx of [-1, 1]) b.box(sx * (w + t * 0.5), h * 0.42, 0, t, h * 0.42, 2.2, 0x8d8375);
        // Stepped arch ring: 9 voussoirs rotated about the springing line.
        for (let i = 0; i <= 9; i++) {
          const a = Math.PI * (i / 9);
          b.box(Math.cos(a) * (w + t * 0.5), h * 0.84 + Math.sin(a) * (w * 0.42), 0,
            t * 0.62, 0.85, 2.2, i === 4 ? 0xa79a88 : 0x8d8375, { yaw: 0, shade: { top: 1.14 } });
        }
        b.box(0, h * 0.84 + w * 0.44, 0, w * 0.34, 0.7, 2.5, 0xa79a88);
        return { geo: b.build('tunnelPortal'), cull: CULL_FAR };
      }

      case 'brakeboard': {
        const b = this.builder();
        for (const sx of [-1, 1]) b.prism(sx * 1.5, 0, 0, 0.11, 2.6, 6, 0x9aa0a8);
        b.box(0, 2.05, 0, 1.75, 0.95, 0.09, 0xf2f4f6, { shade: { top: 1.0 } });
        // Three orange chevrons painted straight into the vertex colour.
        for (let i = 0; i < 3; i++) {
          b.plate(-0.95 + i * 0.95, 2.05, 0.11, 0.62, 1.5, 0, 0xff6a1e, { single: true, pitch: 0.62 });
        }
        return { geo: b.build('brakeBoard'), cull: 320 };
      }

      case 'signchevron': {
        const b = this.builder();
        b.prism(0, 0, 0, 0.085, 1.5, 6, 0x9aa0a8);
        b.box(0, 1.62, 0, 0.62, 0.52, 0.07, 0x1b7fd4);
        b.plate(0, 1.62, 0.09, 0.5, 0.72, 0, 0xffffff, { single: true, pitch: 0.7 });
        return { geo: b.build('signChevron'), cull: 260 };
      }

      case 'tyrestack': {
        const b = this.builder();
        const n = 4 + rng.int(0, 2);
        for (let i = 0; i < n; i++) {
          // Each tyre nudged off-axis: a perfect column reads as a CAD part.
          b.torus(rng.range(-0.05, 0.05), 0.22 + i * 0.42, rng.range(-0.05, 0.05),
            0.52, 0.2, 10, 5, i % 2 ? 0x23262b : 0x1b1e22);
        }
        b.plate(0, 0.24 + n * 0.42, 0, 1.05, 1.05, rng.range(0, 3), 0xe8e4d8, { single: true, pitch: Math.PI * 0.5 });
        return { geo: b.build('tyreStack'), cull: 300 };
      }

      case 'flagpole': {
        const b = this.builder();
        b.box(0, 0.22, 0, 0.42, 0.22, 0.42, 0x3a3f47);
        b.prism(0, 0.4, 0, 0.09, 7.2, 6, 0xd8dade, { taper: 0.7 });
        b.sphere(0, 7.75, 0, 0.14, 6, 4, 0xffd23f);
        const cloth = this.builder();
        cloth.flap = 1;
        cloth.plate(1.3, 6.3, 0, 2.6, 1.6, rng.range(0, 6.28), 0xe8332a, { flapAcross: true });
        return { geo: b.build('flagPole'), cloth: cloth.build('flagPoleCloth'), cull: CULL_MID };
      }

      case 'streetlamp': {
        const b = this.builder();
        b.box(0, 0.18, 0, 0.34, 0.18, 0.34, 0x2a2e34);
        b.prism(0, 0.3, 0, 0.11, 5.4, 6, 0x3d434b, { taper: 0.72 });
        b.tube(0, 5.55, 0, 0.95, 6.05, 0, 0.09, 5, 0x3d434b);
        b.box(1.05, 5.95, 0, 0.34, 0.1, 0.22, 0x2a2e34);
        const glow = this.builder();
        glow.sphere(1.05, 5.82, 0, 0.2, 7, 4, 0xffe6b0, { squash: 0.6 });
        return { geo: b.build('streetLamp'), glow: glow.build('streetLampGlow'), cull: 340 };
      }

      // ---- coastal dressing -----------------------------------------------
      case 'palm': return { geo: this.palmGeometry(rng.range(7.5, 10.5)), cull: CULL_MID };
      case 'palmcluster': {
        const b = this.builder();
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + rng.range(-0.4, 0.4);
          const d = i === 0 ? 0 : rng.range(1.4, 2.8);
          this.palmInto(b, rng.range(6.2, 10.8), Math.cos(a) * d, Math.sin(a) * d, rng.range(0, 6.28));
        }
        return { geo: b.build('palmCluster'), cull: CULL_MID };
      }

      case 'beachumbrella': {
        const b = this.builder();
        b.prism(0, 0, 0, 0.055, 2.35, 6, 0xd8cfc0);
        // Alternating canopy gores, each a triangle-ish plate pitched outward.
        const cols = [0xff5f52, 0xf7f3ea];
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          b.plate(Math.cos(a) * 1.05, 2.15, Math.sin(a) * 1.05, 1.0, 1.5,
            a + Math.PI * 0.5, cols[i % 2], { pitch: 1.16 });
        }
        b.sphere(0, 2.5, 0, 0.1, 6, 4, 0xd8cfc0);
        return { geo: b.build('beachUmbrella'), cull: 220, shadow: false };
      }

      case 'lifeguardtower': {
        const b = this.builder();
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          b.prism(sx * 1.15, 0, sz * 1.15, 0.11, 2.5, 5, 0xc9a97a);
          b.tube(sx * 1.15, 0.6, sz * 1.15, 0, 2.3, 0, 0.06, 4, 0xb08f60);
        }
        b.box(0, 2.62, 0, 1.45, 0.12, 1.45, 0xd8bd8e, { shade: { top: 1.14 } });
        b.box(0, 3.35, -1.3, 1.45, 0.62, 0.12, 0xf2f4f6);
        for (const sx of [-1, 1]) b.box(sx * 1.35, 3.35, 0, 0.12, 0.62, 1.45, 0xf2f4f6);
        // Shallow gabled roof.
        for (const sz of [-1, 1]) b.plate(0, 4.35, sz * 0.78, 3.2, 1.75, 0, 0xe8332a, { pitch: sz * 0.42, single: true });
        for (const sx of [-1, 1]) b.prism(sx * 1.3, 3.9, 1.3, 0.09, 0.9, 4, 0xd8bd8e);
        return { geo: b.build('lifeguardTower'), cull: CULL_MID };
      }

      case 'buoy': {
        const b = this.builder();
        b.prism(0, 0, 0, 0.52, 1.05, 8, 0xff6a1e, { taper: 0.55, capBottom: true });
        b.torus(0, 0.42, 0, 0.55, 0.07, 8, 4, 0x1b1e22);
        b.prism(0, 1.05, 0, 0.09, 0.75, 4, 0x9aa0a8);
        const glow = this.builder();
        glow.sphere(0, 1.9, 0, 0.15, 6, 4, 0xffe07a);
        return { geo: b.build('buoy'), glow: glow.build('buoyGlow'), softGlow: true,
          cull: 420, shadow: false };
      }

      case 'sailboat': {
        const b = this.builder();
        // Hull: two tapered blocks and a transom, so the sheer line curves.
        b.box(0, 0.42, 0, 2.5, 0.42, 0.85, 0xf2f4f6, { taper: 0.72, shade: { top: 1.1 } });
        b.box(1.9, 0.5, 0, 0.85, 0.34, 0.5, 0xf2f4f6, { taper: 0.34 });
        b.box(0, 0.86, 0, 1.9, 0.07, 0.72, 0x9d7b4f, { shade: { top: 1.16 } });
        b.box(-1.3, 1.05, 0, 0.6, 0.24, 0.5, 0xdfe3e8);
        b.prism(0.15, 0.9, 0, 0.075, 5.6, 5, 0xd8dade, { taper: 0.6 });
        const cloth = this.builder();
        cloth.flap = 1;
        cloth.plate(-0.85, 3.5, 0, 2.1, 4.6, Math.PI * 0.5, 0xf7f3ea, { flapAcross: true });
        cloth.plate(1.15, 2.6, 0, 1.5, 2.9, Math.PI * 0.5, 0xffd23f, { flapAcross: true });
        return { geo: b.build('sailboat'), cloth: cloth.build('sailboatCloth'), cull: CULL_FAR };
      }

      case 'seawall': {
        const b = this.builder();
        b.box(0, 0.9, 0, 6, 0.9, 0.75, 0x8d8375, { taper: 0.86, shade: { top: 1.1 } });
        b.box(0, 1.92, 0, 6.2, 0.16, 0.95, 0xa79a88, { shade: { top: 1.18 } });
        // Pilasters break the run so a repeated wall doesn't read as one extrusion.
        for (let i = -2; i <= 2; i++) b.box(i * 2.6, 1.0, 0, 0.34, 1.0, 0.92, 0x9a9082);
        return { geo: b.build('seaWall'), cull: CULL_MID };
      }

      // ---- landscape ------------------------------------------------------
      case 'pine': {
        const b = this.builder();
        const h = rng.range(9, 13);
        b.prism(0, 0, 0, 0.3, h * 0.34, 6, 0x5a4130, { taper: 0.6 });
        for (let i = 0; i < 4; i++) {
          const t = i / 3;
          b.prism(0, h * 0.24 + t * h * 0.6, 0, h * (0.145 - t * 0.075) + 0.35,
            h * 0.34, 7, i === 3 ? 0x22492a : 0x2b5733, { taper: 0.12, capBottom: true });
        }
        return { geo: b.build('pine'), cull: CULL_FAR };
      }

      case 'cypress': {
        const b = this.builder();
        const h = rng.range(8, 12.5);
        b.prism(0, 0, 0, 0.22, h * 0.2, 5, 0x50412f, { taper: 0.7 });
        b.prism(0, h * 0.1, 0, h * 0.085, h * 0.62, 7, 0x2c4a2c, { taper: 0.5, capBottom: true });
        b.prism(0, h * 0.66, 0, h * 0.05, h * 0.36, 6, 0x27432a, { taper: 0.1, capBottom: true });
        return { geo: b.build('cypress'), cull: CULL_FAR };
      }

      case 'rockspire': {
        const b = this.builder();
        const h = rng.range(5.5, 11);
        let y = 0, r = rng.range(1.5, 2.6);
        // Stacked, shrinking, randomly-rotated prisms: a believable weathered stack.
        for (let i = 0; i < 4; i++) {
          const seg = h * rng.range(0.18, 0.32);
          b.prism(rng.range(-0.3, 0.3), y, rng.range(-0.3, 0.3), r, seg, 6,
            i > 2 ? 0x6f6455 : 0x7d7263, { taper: rng.range(0.6, 0.86), yaw: rng.range(0, 6.28) });
          y += seg * 0.92;
          r *= rng.range(0.62, 0.82);
        }
        return { geo: b.build('rockSpire'), cull: CULL_FAR };
      }

      case 'planter': {
        const b = this.builder();
        b.prism(0, 0, 0, 0.78, 0.72, 8, 0xb8ab96, { taper: 1.22, capBottom: true });
        b.torus(0, 0.7, 0, 0.9, 0.08, 8, 4, 0xc9bda8);
        b.prism(0, 0.66, 0, 0.8, 0.1, 8, 0x4a3a26);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          b.sphere(Math.cos(a) * 0.32, 0.98 + rng.range(-0.08, 0.12), Math.sin(a) * 0.32,
            rng.range(0.34, 0.48), 7, 5, i % 2 ? 0x5f8f3c : 0x4c7a31, { squash: 0.78 });
        }
        return { geo: b.build('planter'), cull: 200 };
      }

      case 'townhouse': {
        const b = this.builder();
        const w = rng.range(4.5, 6.5), d = rng.range(4.5, 6), storeys = 2 + rng.int(0, 1);
        const h = storeys * 3.1;
        b.box(0, h * 0.5, 0, w, h * 0.5, d, rng.next() < 0.5 ? 0xd8c9b0 : 0xc0a894,
          { shade: { top: 1.08 } });
        b.box(0, 0.18, 0, w + 0.18, 0.18, d + 0.18, 0x8d8375);
        // Eaves + hipped roof.
        b.box(0, h + 0.16, 0, w + 0.35, 0.16, d + 0.35, 0x9a8e7c, { shade: { top: 1.14 } });
        b.box(0, h + 1.3, 0, w * 0.9, 1.05, d * 0.9, 0x8a4133, { taper: 0.28, shade: { top: 1.2 } });
        b.box(w * 0.28, h + 1.9, d * 0.2, 0.34, 0.8, 0.34, 0xa89a86);
        const glow = this.builder();
        // Lit windows are emissive-by-vertex-colour, so unlit panes stay dark.
        for (let s = 0; s < storeys; s++) {
          for (let i = -1; i <= 1; i++) {
            const lit = rng.next() < 0.55;
            const col = lit ? 0xffdf9e : 0x1a1c22;
            glow.plate(i * (w * 0.52), 1.7 + s * 3.1, d + 0.02, 0.8, 1.35, 0, col, { single: true });
            glow.plate(i * (w * 0.52), 1.7 + s * 3.1, -d - 0.02, 0.8, 1.35, Math.PI, col, { single: true });
          }
        }
        return { geo: b.build('townHouse'), glow: glow.build('townHouseGlow'),
          softGlow: true, cull: CULL_FAR };
      }

      default: return this.simpleAuthored(key);
    }
  }

  /** Tiered seating, with or without a roof and a back wall. */
  private standGeometry(roofed: boolean): THREE.BufferGeometry {
    const b = this.builder();
    const w = roofed ? 26 : 17;
    const rows = roofed ? 9 : 6;
    // Warm off-white concrete, not neutral grey: under the current darker-blue
    // fog and 6.5:1 key/fill a neutral grey stand reads as flat blue plastic.
    const CONCRETE = 0xe4dccc;
    const RISER = 0xb2a696;
    const SEAT = [0xe8332a, 0xf2b52a, 0x1b7fd4];
    // Terraces: each row a step back and up, with a darker riser face and a
    // coloured seat block band — MK8 stands are never one material.
    for (let r = 0; r < rows; r++) {
      const y = 0.55 + r * 0.62;
      const z = -r * 0.92;
      b.box(0, y - 0.31, z, w * 0.5, 0.31, 0.46, CONCRETE, { shade: { top: 1.12 } });
      b.box(0, y + 0.1, z - 0.46, w * 0.5, 0.2, 0.46, RISER);
      // Seat colour blocked in thirds along the row, offset per tier so the whole
      // bank reads as a pattern rather than stripes.
      for (let k = -1; k <= 1; k++) {
        b.box(k * (w / 3), y + 0.06, z + 0.02, w / 6.6, 0.06, 0.4,
          SEAT[(r + k + 3) % 3], { shade: { top: 1.2 } });
      }
    }
    // Side walls close the silhouette.
    for (const sx of [-1, 1]) {
      b.box(sx * w * 0.5, rows * 0.31, -rows * 0.46, 0.32, rows * 0.31, rows * 0.46, 0xf0e8d8);
    }
    b.box(0, 0.22, 0.6, w * 0.5 + 0.4, 0.22, 1.0, 0x9b9384, { shade: { top: 1.06 } });
    if (roofed) {
      const top = rows * 0.62 + 3.6;
      for (let i = -3; i <= 3; i++) {
        b.prism(i * (w / 7), rows * 0.62, -rows * 0.92, 0.22, 3.6, 5, 0xd8d0c0);
        b.tube(i * (w / 7), top - 0.2, -rows * 0.92, i * (w / 7), top - 1.1, 1.4, 0.11, 4, 0xc4baa8);
      }
      // Roof: warm underside, brighter top, plus a red fascia so the leading edge
      // catches the key light the way MK8's stand roofs do.
      b.box(0, top, -rows * 0.46, w * 0.52, 0.18, rows * 0.5 + 1.2, 0xf4eee0,
        { shade: { top: 1.18, bottom: 0.62 } });
      b.box(0, top - 0.22, rows * 0.04 + 1.2, w * 0.52, 0.24, 0.16, 0xe8332a,
        { shade: { top: 1.2 } });
      b.box(0, top + 0.42, -rows * 0.92 - 0.2, w * 0.46, 0.42, 0.16, 0x232833);
    } else {
      for (const sx of [-1, 1]) b.box(sx * w * 0.5, rows * 0.62 + 0.5, -rows * 0.92, 0.16, 0.5, 0.16, 0xd8d0c0);
    }
    return b.build(roofed ? 'grandstand' : 'crowdStand');
  }

  /** A single palm, at the origin. */
  private palmGeometry(height: number): THREE.BufferGeometry {
    const b = this.builder();
    this.palmInto(b, height, 0, 0, this.rng.range(0, 6.28));
    return b.build('palm');
  }

  /** Palm trunk + fronds written into an existing builder, so clusters share one mesh. */
  private palmInto(b: Builder, h: number, ox: number, oz: number, yaw: number): void {
    const rng = this.rng;
    const lean = rng.range(-0.06, 0.06);
    // Segmented trunk: each ring nudged along the lean so it curves.
    const rings = 6;
    for (let i = 0; i < rings; i++) {
      const t = i / rings;
      const seg = h / rings;
      b.prism(ox + lean * h * t * t, t * h, oz + lean * h * t * t * 0.4,
        0.24 - t * 0.11, seg * 1.04, 7, i % 2 ? 0x9a7b52 : 0x8a6c46, { taper: 0.92, yaw: yaw + t });
    }
    const tipX = ox + lean * h, tipZ = oz + lean * h * 0.4;
    b.box(tipX, h + 0.1, tipZ, 0.2, 0.16, 0.2, 0x7a5f3e);
    for (let i = 0; i < 9; i++) {
      const a = yaw + (i / 9) * Math.PI * 2 + rng.range(-0.16, 0.16);
      const len = rng.range(2.4, 3.5);
      // Two plates per frond, the outer one drooping harder — cheap arc.
      b.plate(tipX + Math.cos(a) * len * 0.28, h + 0.12, tipZ + Math.sin(a) * len * 0.28,
        len * 0.6, 0.75, a + Math.PI * 0.5, 0x3f7a2c, { pitch: -0.22 });
      b.plate(tipX + Math.cos(a) * len * 0.74, h - len * 0.2, tipZ + Math.sin(a) * len * 0.74,
        len * 0.55, 0.6, a + Math.PI * 0.5, 0x2f6323, { pitch: -0.72 });
    }
    for (let i = 0; i < 4; i++) {
      const a = yaw + rng.range(0, 6.28);
      b.sphere(tipX + Math.cos(a) * 0.34, h - 0.28, tipZ + Math.sin(a) * 0.34, 0.16, 6, 4, 0x8a6f2a);
    }
  }

  private simpleAuthored(key: string): AuthoredSpec | null {
    const geo = this.authoredGeometry(key);
    if (!geo) return null;
    const glowing = key === 'lamp' || key === 'torch';
    return { geo, mat: glowing ? this.glow : this.matte, cull: CULL_MID, shadow: !glowing };
  }

  private authoredGeometry(key: string): THREE.BufferGeometry | null {
    const b = this.builder();
    switch (key) {
      case 'crate':
        b.box(0, 0.55, 0, 0.55, 0.55, 0.55, 0x8d6f47, { shade: { top: 1.1 } });
        for (const sy of [-0.45, 0.45]) b.box(0, 0.55 + sy, 0, 0.58, 0.06, 0.58, 0x6b5334);
        return b.build('crate');
      case 'barrel':
        b.prism(0, 0, 0, 0.42, 1.05, 10, 0xd94f3d, { capBottom: true, bulge: 1 });
        b.torus(0, 0.28, 0, 0.43, 0.045, 10, 4, 0xe8e4d8);
        b.torus(0, 0.78, 0, 0.43, 0.045, 10, 4, 0xe8e4d8);
        return b.build('barrel');
      case 'cone':
        b.box(0, 0.04, 0, 0.34, 0.04, 0.34, 0x2a2e34);
        b.prism(0, 0.06, 0, 0.24, 0.72, 6, 0xff6a1e, { taper: 0.12 });
        return b.build('cone');
      case 'lamp':
        b.sphere(0, 0.4, 0, 0.38, 8, 6, 0xfff0c8);
        return b.build('lamp');
      case 'torch':
        b.prism(0, 1.2, 0, 0.22, 0.8, 6, 0xff8a2a, { taper: 0.1 });
        return b.build('torch');
      case 'pillar':
        b.prism(0, 0, 0, 0.9, 6.5, 10, 0x6b5f52, { taper: 0.88, capBottom: false });
        b.box(0, 6.6, 0, 1.2, 0.3, 1.2, 0x74685a);
        return b.build('pillar');
      case 'arch':
        for (const sx of [-1, 1]) b.box(sx * 4.5, 0, 0, 0.7, 4.5, 0.7, 0x6b5f52);
        b.box(0, 4.6, 0, 5.2, 0.55, 0.8, 0x74685a);
        return b.build('arch');
      default:
        return null;
    }
  }

  // =========================================================================
  // FRAME
  // =========================================================================

  setCamera(camera: THREE.PerspectiveCamera): void {
    if (camera && camera.isPerspectiveCamera) this.camera = camera;
  }

  setWind(strength: number, dirRadians: number): void {
    this.u.uWind.value = strength;
    this.u.uWindDir.value.set(Math.cos(dirRadians), Math.sin(dirRadians)).normalize();
  }

  update(ctx: FrameContext): void {
    this.time += ctx.dt;
    this.u.uTime.value = this.time;
    if (this.camera) this.u.uCamXZ.value.set(this.camera.position.x, this.camera.position.z);

    const cam = this.camera;
    for (const entry of this.meshes) {
      if (entry.motion === 'gull') this.updateGulls(entry, ctx);
      else if (entry.motion === 'tram') this.updateTrams(entry, ctx);
      else if (entry.chunks && cam) entry.chunks.cullTo(cam);
    }
  }

  /** Lazy circling flock with banking — enough to read as alive at distance. */
  private updateGulls(entry: PropMesh, ctx: FrameContext): void {
    const { mesh, data } = entry;
    if (!data) return;
    const cx = this.field.centreX, cz = this.field.centreZ;
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 5;
      data[o] += data[o + 3] * ctx.dt;
      const ang = data[o];
      const rad = data[o + 1];
      const bob = Math.sin(this.time * 0.7 + data[o + 4]) * 1.8;
      const x = cx + Math.cos(ang) * rad;
      const z = cz + Math.sin(ang) * rad;
      const y = data[o + 2] + bob;
      const heading = ang + (data[o + 3] > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
      _euler.set(Math.sin(this.time * 1.4 + data[o + 4]) * 0.12, heading, data[o + 3] > 0 ? -0.35 : 0.35);
      _q.setFromEuler(_euler);
      _m.compose(_v.set(x, y, z), _q, _s.setScalar(1.6));
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // Flocks roam, so the tight cluster bound no longer applies.
    mesh.frustumCulled = false;
  }

  /** Trams run parallel to the circuit on an elevated line. */
  private updateTrams(entry: PropMesh, ctx: FrameContext): void {
    const { mesh, data } = entry;
    if (!data) return;
    const st = this.ctx.stations;
    if (!st.length) return;
    const total = st[st.length - 1].s || 1;
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 5;
      data[o] = (data[o] + data[o + 3] * ctx.dt) % total;
      const idx = clamp(Math.round((data[o] / total) * st.length), 0, st.length - 1);
      const s = st[idx];
      const side = data[o + 4];
      const off = data[o + 2];
      const x = s.px + s.bx * off * side;
      const z = s.pz + s.bz * off * side;
      const y = this.field.heightAt(x, z) + data[o + 1] + Math.sin(this.time * 0.8 + i) * 0.12;
      _q.setFromAxisAngle(_axisY, Math.atan2(s.tx, s.tz));
      _m.compose(_v.set(x, y, z), _q, _s.setScalar(1));
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
  }

  get drawCalls(): number { return this.meshes.length; }

  get instanceCount(): number {
    let n = 0;
    for (const m of this.meshes) n += m.mesh.count;
    return n;
  }

  get triangles(): number {
    let n = 0;
    for (const m of this.meshes) {
      const idx = m.mesh.geometry.getIndex();
      n += ((idx ? idx.count : m.mesh.geometry.attributes.position.count) / 3) * m.mesh.count;
    }
    return Math.round(n);
  }

  dispose(): void {
    for (const entry of this.meshes) {
      entry.mesh.geometry.dispose();
      entry.mesh.dispose();
    }
    this.meshes.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    this.scene.remove(this.group);
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------

function row3Colour(rng: Rng): number {
  const cols = [0xd6402f, 0x2f6fd0, 0xf2c53d, 0xe8e4d8];
  return cols[Math.floor(rng.next() * cols.length) % cols.length];
}

/** Alias table for prop names Track might use. */
function normaliseType(type: string): string | null {
  const t = type.toLowerCase().replace(/[^a-z]/g, '');
  switch (t) {
    // --- generic set dressing ---
    case 'crate': case 'box': case 'cargo': return 'crate';
    case 'barrel': case 'drum': return 'barrel';
    case 'cone': case 'trafficcone': case 'pylon': return 'cone';
    case 'lamp': case 'light': case 'lantern': case 'glow': return 'lamp';
    case 'torch': case 'flame': case 'brazier': return 'torch';
    case 'pillar': case 'column': case 'post': return 'pillar';
    case 'arch': case 'gate': case 'gateway': return 'arch';

    // --- race infrastructure ---
    case 'startgantry': case 'gantry': case 'startline': case 'finishgantry':
      return 'startgantry';
    case 'grandstand': case 'stand': case 'maingrandstand': return 'grandstand';
    case 'crowdstand': case 'terrace': case 'bleacher': case 'bleachers':
      return 'crowdstand';
    case 'balloonarch': case 'balloons': case 'balloongate': return 'balloonarch';
    case 'tunnelportal': case 'portal': case 'tunnel': return 'tunnelportal';
    case 'brakeboard': case 'distanceboard': case 'brakemarker': return 'brakeboard';
    case 'signchevron': case 'chevron': case 'chevronsign': case 'cornersign':
      return 'signchevron';
    case 'tyrestack': case 'tirestack': case 'tyres': case 'tires': return 'tyrestack';
    case 'flagpole': case 'flag': case 'flagmast': return 'flagpole';
    case 'streetlamp': case 'streetlight': case 'lamppost': return 'streetlamp';

    // --- coastal dressing ---
    case 'palm': case 'palmtree': return 'palm';
    case 'palmcluster': case 'palmgrove': case 'palms': return 'palmcluster';
    case 'beachumbrella': case 'parasol': case 'umbrella': return 'beachumbrella';
    case 'lifeguardtower': case 'lifeguard': case 'lifeguardhut':
      return 'lifeguardtower';
    case 'buoy': case 'marker': case 'seabuoy': return 'buoy';
    case 'sailboat': case 'boat': case 'yacht': case 'dinghy': return 'sailboat';
    case 'seawall': case 'harbourwall': case 'harborwall': case 'quay': return 'seawall';

    // --- landscape ---
    case 'pine': case 'conifer': case 'fir': case 'spruce': return 'pine';
    case 'cypress': case 'poplar': return 'cypress';
    case 'rockspire': case 'spire': case 'rockstack': case 'boulder':
      return 'rockspire';
    case 'planter': case 'flowerbed': case 'plantpot': return 'planter';
    case 'townhouse': case 'house': case 'building': case 'villa': return 'townhouse';
    default: return null;
  }
}
