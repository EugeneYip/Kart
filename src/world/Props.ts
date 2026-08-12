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
// The one thing the world dresser needs from the track layer: the volumes the
// road builds around itself (tunnel bores, bridge decks, anti-gravity tubes).
// Published module-level by `buildTrack()` because `Environment` constructs the
// dresser and never hands it a `Track`. See the ROAD VOLUMES block there.
import { ROAD_VOLUME_SHELL, roadVolumePenetration, roadVolumes } from '@/track/TrackBuilder';

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

/**
 * Grandstand geometry contract, shared with `Crowd`.
 *
 * Props builds the terrace and Crowd seats people on it, from two different
 * files, so every number that has to agree between the two lives here and
 * nowhere else. Local space for a stand: **+Z faces the road**, +X runs along
 * it, and y = 0 is the terrain height at the anchor.
 *
 *      y
 *      |            ______ rear wall
 *      |        ___|                     row r tread top  = ROW0 + r*ROW_H
 *      |    ___|  <- bench (BENCH_H above its tread)      + DECK_LIFT
 *      |   |____________ row 0 tread  (y = LIFT + ROW0)
 *      |   | barrier      (sponsor band on its front face, at +Z = FRONT_Z)
 *      |   :  ...... shaded void, columns + bracing ......
 *      +---:------------------------------------------------ z
 */
/** Row rise, metres. */
export const STAND_ROW_H = 0.78;
/** Row depth (tread + bench), metres. */
export const STAND_ROW_D = 1.15;
/**
 * Height of the seating deck above the terrain. This is what turns the stand
 * from a box sitting on the grass into a structure: everything below it is the
 * shaded void with the columns and cross-bracing in it.
 */
export const STAND_DECK_LIFT = 2.6;
/** Row 0's tread top, above the lift. */
export const STAND_ROW0 = 0.44;
/** Bench top above its own tread — a seated spectator's hips land here. */
export const STAND_BENCH_H = 0.3;
/** +Z of the barrier's front face, which carries the sponsor band. */
export const STAND_FRONT_Z = 1.35;
/** +Z of row 0's tread front edge (i.e. the back of the barrier). */
export const STAND_TREAD_F = 0.725;
/** Local Z of a spectator's feet in row `r`. */
export function standSeatZ(r: number): number { return -r * STAND_ROW_D + 0.15; }
/** Local Y of a spectator's feet in row `r`. */
export function standSeatY(r: number): number {
  return STAND_DECK_LIFT + STAND_ROW0 + r * STAND_ROW_H;
}
/** Stair aisles cut into the terrace. Main stands get more blocks. */
export function standAisleCount(main: boolean): number { return main ? 2 : 1; }
/**
 * Local X centres of those aisles. Props cuts steps here and Crowd seats nobody
 * here, so the two must agree exactly — hence one function, not two constants.
 */
export function standAisleXs(width: number, aisles: number): number[] {
  const n = Math.max(0, Math.min(5, Math.round(aisles)));
  const out: number[] = [];
  for (let a = 0; a < n; a++) out.push(((a + 1) / (n + 1) - 0.5) * (width - 6));
  return out;
}
/** Aisle half-width including its kerb cheeks. */
export const STAND_AISLE_HW = 0.95;

interface Anchor {
  x: number; y: number; z: number;
  /** Radians: 0 = facing -Z. Props face the road unless noted. */
  yaw: number;
  side: number;
  arc: number;
  scale: number;
  seed: number;
  /**
   * Set by the road-volume guard in `emit()`. An authored prop is emitted as
   * several passes (body, glow, cloth, metal, sign) over the **same** anchor
   * array, so the verdict has to live on the anchor: testing per pass would
   * reject a lamp post's mast and keep its lit head hanging in the tunnel.
   */
  blocked?: boolean;
  /**
   * Authored offset from the surface, metres — only set for authored anchors that
   * `collectAuthored()` re-seated. Kept so anything that re-seats the anchor
   * again (the road-volume push in `clearAuthored()`) preserves it instead of
   * planting a prop authored to hang below grade flat on the ground.
   */
  up?: number;
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
const _volDir = new THREE.Vector3();

type Shade = { top?: number; side?: number; bottom?: number };

/**
 * One point of a swept cross-section, in the local **ZY** plane. `hex`/`shade`
 * describe the face that *starts* at this point, so a single profile carries its
 * own material breakdown — concrete tread, coloured bench, dark soffit.
 */
interface ProfilePt {
  z: number;
  y: number;
  hex?: number;
  shade?: number;
}

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
    // WINDING. `quad()` derives its normal from the corner order, so the order
    // below is what decides whether a box faces out or in. It used to run the
    // other way round: every one of these six faces pointed *into* the box, so
    // with the default FrontSide material every box in this file was back-face
    // culled and what you actually saw was the far inside wall. That is why the
    // grandstand read as a plain white mass despite emitting nine tiers, and why
    // props generally read flat — all their near surfaces were being discarded.
    // Proven numerically: the signed volume of every closed primitive here was
    // negative. Do not "tidy" these orders without re-checking that.
    //
    // sides (darker toward the ground reads as contact shadow)
    this.quad(b0[0], b0[1], b0[2], t0[0], t0[1], t0[2], t1[0], t1[1], t1[2], b1[0], b1[1], b1[2], hex, ss, uvR);
    this.quad(b1[0], b1[1], b1[2], t1[0], t1[1], t1[2], t2[0], t2[1], t2[2], b2[0], b2[1], b2[2], hex, ss * 0.9, uvR);
    this.quad(b2[0], b2[1], b2[2], t2[0], t2[1], t2[2], t3[0], t3[1], t3[2], b3[0], b3[1], b3[2], hex, ss * 0.96, uvR);
    this.quad(b3[0], b3[1], b3[2], t3[0], t3[1], t3[2], t0[0], t0[1], t0[2], b0[0], b0[1], b0[2], hex, ss * 0.86, uvR);
    this.quad(t0[0], t0[1], t0[2], t3[0], t3[1], t3[2], t2[0], t2[1], t2[2], t1[0], t1[1], t1[2], hex, st, uvR);
    if (!opts.noBottom) {
      this.quad(b3[0], b3[1], b3[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], b2[0], b2[1], b2[2], hex, sb, uvR);
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
    // Winding, as in `box()`: outward-facing means CCW seen from outside.
    for (let i = 0; i < sides; i++) {
      const a = base + i * 2;
      this.I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    if (opts.capTop !== false && rt > 1e-4) {
      const cbase = this.vertexCount;
      this.vert(cx, cy + h, cz, 0, 1, 0, 0, 0, hex, st);
      for (let i = 0; i <= sides; i++) {
        const a = yaw + (i / sides) * Math.PI * 2;
        this.vert(cx + Math.cos(a) * rt, cy + h, cz + Math.sin(a) * rt, 0, 1, 0,
          Math.cos(a) * rt * this.uvScale, Math.sin(a) * rt * this.uvScale, hex, st);
      }
      for (let i = 0; i < sides; i++) this.I.push(cbase, cbase + i + 2, cbase + i + 1);
    }
    if (opts.capBottom) {
      const cbase = this.vertexCount;
      this.vert(cx, cy, cz, 0, -1, 0, 0, 0, hex, (sh.bottom ?? 0.6));
      for (let i = 0; i <= sides; i++) {
        const a = yaw + (i / sides) * Math.PI * 2;
        this.vert(cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r, 0, -1, 0, 0, 0, hex, (sh.bottom ?? 0.6));
      }
      for (let i = 0; i < sides; i++) this.I.push(cbase, cbase + i + 1, cbase + i + 2);
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
      this.I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
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
        this.I.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
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
        this.I.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
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
    // ------------------------------------------------------------------------
    // THE u AXIS. `pt()` lays the plate out along local +x with a +z face
    // normal. The only viewer of that front face stands at local +z looking down
    // -z, and in a right-handed frame with +y up that viewer sees local **+x on
    // their RIGHT** (it is the default three.js camera basis: a camera at +z
    // looking at the origin puts world +x to screen-right). Text therefore reads
    // left-to-right only when u INCREASES along local +x, i.e. `-hw -> uMin`.
    //
    // A previous pass swapped these two ranges on the strength of a runtime
    // u-mirror experiment and left `sponsorBoard` reading mirrored anyway, which
    // is the symptom you get from exactly this: the front face carried the
    // back face's range. They are back the right way round now. `flapAcross`
    // above always used the correct mapping — and nobody ever reported the mast
    // cloths as mirrored, which is the corroborating evidence.
    //
    // `flipY = true` on the canvas textures affects v only, never u, so it does
    // not enter into this. Do not "re-fix" this without re-deriving it: one
    // screenshot of `Prop:sponsorBoard` from the driving direction settles it.
    // ------------------------------------------------------------------------
    this.quad(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2],
      hex, shade, [uv[0], uv[3], uv[2], uv[1]]);
    if (!opts.single) {
      // Seen from behind, local +x is on the viewer's LEFT, so the back face
      // wants the mirrored range to read correctly from that side.
      this.quad(p1[0], p1[1], p1[2], p0[0], p0[1], p0[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2],
        hex, shade * 0.8, [uv[2], uv[3], uv[0], uv[1]]);
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
        // u runs uMin -> uMax as lx goes -w/2 -> +w/2, exactly as in `plate()`'s
        // front face — see the long note on the u axis there. A viewer of this
        // cloth's +z face sees local +x on their right, so u must grow with +x.
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

  /**
   * Sweep a cross-section along X between `x0` and `x1`.
   *
   * Segment `i` (`pts[i]` -> `pts[i+1]`) becomes one flat-shaded quad whose
   * outward normal works out to `(0, -dz, dy)`. In practice: walk the outline
   * **up** the road-facing faces, **backwards** (-z) along the up-facing ones,
   * **down** the rear faces and **forwards** along the undersides, and every
   * face points out of the solid. Reversing the walk inverts the whole part.
   *
   * This is the workhorse for the grandstand. A nine-row terrace with a
   * chamfered nosing on every step, a coloured bench per row and a dark soffit
   * underneath is ~66 quads as one profile; the same thing as boxes is ~30
   * boxes, 360 triangles, and has a hard 90° edge everywhere a step meets a
   * riser — which is exactly the tell that reads as amateur at 40 m.
   *
   * `caps` closes both ends with a fan from the profile's mean point, so it is
   * only valid for **convex** profiles (parapets, fascias, side walls). Never
   * for the terrace itself — a staircase outline fans into spaghetti.
   */
  extrudeX(
    pts: ProfilePt[],
    x0: number, x1: number,
    hex: number,
    opts: { shade?: number; caps?: boolean } = {},
  ): void {
    const gs = opts.shade ?? 1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      this.quad(
        x0, a.y, a.z, x1, a.y, a.z, x1, b.y, b.z, x0, b.y, b.z,
        a.hex ?? hex, (a.shade ?? 1) * gs,
      );
    }
    if (!opts.caps || pts.length < 3) return;
    let mz = 0, my = 0;
    for (const p of pts) { mz += p.z; my += p.y; }
    mz /= pts.length; my /= pts.length;
    for (let e = 0; e < 2; e++) {
      const x = e === 0 ? x0 : x1;
      const nx = e === 0 ? -1 : 1;
      // Ends of a swept part are almost always turned away from the key light.
      const es = gs * (e === 0 ? 0.88 : 0.94);
      const base = this.vertexCount;
      this.vert(x, my, mz, nx, 0, 0, mz * this.uvScale, my * this.uvScale, hex, es);
      for (const p of pts) {
        this.vert(x, p.y, p.z, nx, 0, 0, p.z * this.uvScale, p.y * this.uvScale,
          p.hex ?? hex, (p.shade ?? 1) * es);
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        // The -x cap keeps the profile's winding; +x reverses it.
        if (e === 0) this.I.push(base, base + 1 + i, base + 2 + i);
        else this.I.push(base, base + 2 + i, base + 1 + i);
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

/**
 * The eight trackside advertisers. `lines` is the wordmark: one entry is set as
 * a single wide line, two entries as a stacked lockup with the second line
 * smaller and tracked out.
 *
 * ---- P0d. The owner asked for their own two brands on the boards, *"not too
 * densely"*, replacing some APEX and SLIP cells. So APEX (cell 0) is now
 * **CAPY LAB** and SLIP (cell 5) is **TINY TRIP CLUB**, and `weight` makes them
 * genuinely sparse rather than one-in-eight — see `SPONSOR_PICK` below.
 *
 * "TINY TRIP CLUB" is 14 characters against NITRO's 5, and the cells are square
 * (2048x1024 over 4x2) stretched onto a 6.4 x 2.1 m board, so a single line at
 * the shared 0.42-of-cell size would run about 2.8x past the cell edge. It is
 * therefore set as a two-line lockup — TINY TRIP over CLUB — and every line goes
 * through `fitLine()`, which measures the glyphs and shrinks the size until it
 * fits the safe width. That means no future brand name can overflow either,
 * whatever its length.
 */
interface Sponsor {
  readonly lines: readonly [string] | readonly [string, string];
  readonly bg: string;
  readonly fg: string;
  /**
   * Relative frequency across the boards. 1 is a normal sponsor; the owner's two
   * brands sit at 0.4 so they read as "a couple of theirs among the others".
   */
  readonly weight: number;
}

const SPONSORS: readonly Sponsor[] = [
  { lines: ['CAPY', 'LAB'], bg: '#1d6f63', fg: '#f6efdd', weight: 0.4 },
  { lines: ['NITRO'], bg: '#141821', fg: '#ffd23f', weight: 1 },
  { lines: ['TURBO'], bg: '#0f6bd6', fg: '#ffffff', weight: 1 },
  { lines: ['GRIP'], bg: '#1f9e57', fg: '#0c1410', weight: 1 },
  { lines: ['VOLT'], bg: '#7a2ed6', fg: '#f2e9ff', weight: 1 },
  { lines: ['TINY TRIP', 'CLUB'], bg: '#e4573c', fg: '#fff4e2', weight: 0.4 },
  { lines: ['DRIFT'], bg: '#0d1b2a', fg: '#4fd6ff', weight: 1 },
  { lines: ['KART'], bg: '#f4f1e6', fg: '#c2192a', weight: 1 },
];

/**
 * Weighted cell lookup, 20 slots. `emit()` picks a cell from the anchor's uniform
 * `seed`, which spreads eight cells evenly at one-in-eight; with 58 sponsor
 * boards on a circuit that would be ~7 CAPY LABs and ~7 TINY TRIP CLUBs per lap,
 * which is not "not too densely". This table gives each owner brand 2 of 22
 * slots (9.1 %) and each generic sponsor 3 of 22 (13.6 %), so a 58-board circuit
 * carries about five of each — one every couple of hundred metres, never two in
 * the same view. The two owner cells sit at slots 1, 5, 9 and 13, so consecutive
 * seeds can never put them side by side either.
 */
const SPONSOR_PICK: readonly number[] = (() => {
  const out: number[] = [];
  // Interleaved rather than blocked, so consecutive seeds cannot land two owner
  // boards next to each other.
  const order = [1, 0, 2, 3, 6, 5, 4, 7];
  for (let pass = 0; pass < 3; pass++) {
    for (const cell of order) {
      if (pass === 2 && SPONSORS[cell].weight < 1) continue;
      out.push(cell);
    }
  }
  return out;
})();

const ATLAS_COLS = 4;
const ATLAS_ROWS = 2;

/**
 * Bake one sponsor cell straight into a plate's uvs.
 *
 * The per-instance `aAtlas` remap can only pick **one** cell per instance, which
 * is fine for a trackside board but useless for a grandstand: the whole point of
 * a sponsor band is that it reads as six different names in a row. Emitting the
 * cell per quad instead needs the uv convention spelled out:
 *
 *  1. **u** — `plate()`'s front face maps local `-hw -> uMin`, which is the plain
 *     ascending range this helper emits. Nothing to compensate for; see the long
 *     note on the u axis in `plate()` for why that is the correct direction.
 *  2. **v** — `canvasTexture()` leaves three's default `flipY = true` alone, so
 *     **v = 1 is the top of the drawn canvas** while `plate()` sends the
 *     geometry's top edge to the rect's *second* v. Upright text therefore needs
 *     the top v first in the rect, i.e. a descending v range — which is what
 *     `V_TOP_FIRST` does, and it is verified on screen (the small
 *     "APEX KART CHAMPIONSHIP" caption, drawn at 0.82 of the cell height, reads
 *     at the bottom of the board).
 */
const V_TOP_FIRST = true;

function atlasRect(cell: number, inset = 0.006): [number, number, number, number] {
  const n = ATLAS_COLS * ATLAS_ROWS;
  const i = ((Math.floor(cell) % n) + n) % n;
  const cx = i % ATLAS_COLS, cy = Math.floor(i / ATLAS_COLS);
  const u0 = cx / ATLAS_COLS + inset;
  const u1 = (cx + 1) / ATLAS_COLS - inset;
  // Canvas row `cy` (drawn top-down) lands in v = 1 - cy/rows downwards.
  const vTop = 1 - cy / ATLAS_ROWS - inset * 2;
  const vBot = 1 - (cy + 1) / ATLAS_ROWS + inset * 2;
  return V_TOP_FIRST ? [u0, vTop, u1, vBot] : [u0, vBot, u1, vTop];
}

/**
 * Set one line of a wordmark at the largest size that fits `maxWidth`.
 *
 * The existing sponsors are all one short word, so the atlas could hard-code a
 * font size. "TINY TRIP CLUB" cannot: at the shared 0.42-of-cell size it measures
 * roughly 2.8x the cell width. Measuring and shrinking is the only version of
 * this that survives the next brand name somebody adds.
 *
 * Returns the size actually used, so a caller stacking two lines can keep the
 * second line proportional to the first.
 */
function fitLine(
  ctx: CanvasRenderingContext2D, text: string, maxWidth: number,
  wantPx: number, weight: number, tracking = 0,
): number {
  let px = wantPx;
  const measure = (): number => {
    ctx.font = `${weight} ${Math.round(px)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    // `letterSpacing` is not universally available on 2D contexts, so tracking is
    // applied as an explicit per-gap allowance rather than trusted to the API.
    return ctx.measureText(text).width + tracking * px * Math.max(0, text.length - 1);
  };
  let wd = measure();
  // Ten halving-free steps: proportional shrink converges in one or two passes
  // for real text, and the loop is bounded so a pathological metric cannot hang.
  for (let k = 0; k < 10 && wd > maxWidth && px > 6; k++) {
    px *= Math.max(0.55, (maxWidth / wd) * 0.995);
    wd = measure();
  }
  return px;
}

/**
 * 4x2 atlas of sponsor boards. The cells are square (2048 x 1024 over 4 x 2) and
 * get stretched onto the 6.4 x 2.1 m `sponsorBoard` plate; that horizontal
 * stretch is longstanding and the wordmarks are drawn to look right through it.
 *
 * DO NOT "FIX" THE UVS from in here. Both axes are settled and verified on
 * screen — see the `V_TOP_FIRST` note above `atlasRect()` for v, and the long
 * note in `plate()` for u. HANDOFF.md section 0b records an earlier `u` swap that
 * was wrong and had to be reverted; the ascending range is correct.
 */
function makeSponsorAtlas(): THREE.CanvasTexture {
  return canvasTexture(2048, (ctx, w, h) => {
    const cw = w / 4, ch = h / 2;
    for (let i = 0; i < 8; i++) {
      const x = (i % 4) * cw, y = Math.floor(i / 4) * ch;
      const { lines, bg, fg } = SPONSORS[i];
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
      // Safe width: inside the 8 px inset and the 7 px keyline, with a margin.
      const safe = cw - 46;
      ctx.save();
      ctx.translate(x + cw * 0.5, y + ch * 0.5);
      ctx.transform(1, 0, -0.14, 1, 0, 0);
      if (lines.length === 1) {
        fitLine(ctx, lines[0], safe, ch * 0.42, 900);
        ctx.fillText(lines[0], 0, 0);
      } else {
        // Two-line lockup: the long line takes the width, the short line sits
        // under it a size down and tracked out, which is how a club wordmark is
        // set and keeps "CLUB" from looking like a truncation of the line above.
        const top = fitLine(ctx, lines[0], safe, ch * 0.34, 900);
        ctx.fillText(lines[0], 0, -top * 0.44);
        const botPx = fitLine(ctx, lines[1], safe * 0.82, top * 0.62, 700, 0.22);
        // Tracking has to be drawn glyph by glyph: the measurement above allowed
        // for it, so the string must actually carry it or the line reads narrow.
        const gap = botPx * 0.22;
        const glyphs = [...lines[1]];
        let total = -gap * (glyphs.length - 1);
        for (const g of glyphs) total += ctx.measureText(g).width;
        let gx = -(total + gap * (glyphs.length - 1)) * 0.5;
        for (const g of glyphs) {
          const gw = ctx.measureText(g).width;
          ctx.fillText(g, gx + gw * 0.5, top * 0.60);
          gx += gw + gap;
        }
      }
      ctx.restore();

      ctx.globalAlpha = 0.55;
      ctx.font = `600 ${Math.round(ch * 0.1)}px Helvetica, Arial, sans-serif`;
      ctx.fillText('FOXY KART CHAMPIONSHIP', x + cw * 0.5, y + ch * 0.82);
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
 * Perpendicular distance from an XZ point to the road centreline, plus the
 * half width there.
 *
 * `ctx.stations` is the resampled centreline at ~7 m spacing, so a nearest-
 * station search followed by a projection onto the two adjoining chords is
 * accurate to a few centimetres. This is deliberately NOT `field.roadDistanceAt`:
 * that is a baked texel grid (metres per texel), far too coarse to decide
 * whether a grandstand corner is over the asphalt.
 */
function roadClearance(
  st: PathStation[], x: number, z: number,
): { lat: number; halfWidth: number; cx: number; cz: number } {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < st.length; i++) {
    const dx = st[i].px - x, dz = st[i].pz - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) { bd = d2; bi = i; }
  }
  let best = Math.sqrt(bd);
  let hw = st[bi].halfWidth;
  // The nearest centreline point itself, so a caller that needs to push a prop
  // *away* from the road has the outward direction without repeating the search.
  let cx = st[bi].px, cz = st[bi].pz;
  const n = st.length;
  for (const j of [(bi - 1 + n) % n, bi]) {
    const a = st[j], b = st[(j + 1) % n];
    const ex = b.px - a.px, ez = b.pz - a.pz;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-6) continue;
    const t = clamp(((x - a.px) * ex + (z - a.pz) * ez) / len2, 0, 1);
    const px = a.px + ex * t, pz = a.pz + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      hw = a.halfWidth + (b.halfWidth - a.halfWidth) * t;
      cx = px; cz = pz;
    }
  }
  return { lat: best, halfWidth: hw, cx, cz };
}

/**
 * Lateral clearance a stand's structure must keep from the asphalt edge, metres.
 * Kerb (1.55) plus enough shoulder that the terrace never reads as overhanging
 * the racing surface. The anchor test alone is not enough: a 78 m stand anchored
 * 27 m out still swings its ends across a corner.
 */
const STAND_ROAD_CLEARANCE = 4.6;
/** Local +Z of the outermost road-facing structure (catch fence panels). */
const STAND_FRONT_REACH = 4.75;

/** True when every corner of the stand footprint clears the road. */
function standClearsRoad(
  st: PathStation[], x: number, z: number, yaw: number, width: number,
): boolean {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const hw = width * 0.5;
  for (const lx of [-hw, 0, hw]) {
    for (const lz of [-1.5, STAND_FRONT_REACH]) {
      // local +X -> (cos, 0, -sin); local +Z -> (sin, 0, cos)
      const wx = x + lx * ca + lz * sa;
      const wz = z - lx * sa + lz * ca;
      const c = roadClearance(st, wx, wz);
      if (c.lat < c.halfWidth + STAND_ROAD_CLEARANCE) return false;
    }
  }
  return true;
}

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
    const width = main ? 78 : 46;
    // Yaw: local +Z faces the road, local +-X runs along it (convention 1 — see
    // the PROP ORIENTATION block in Track.ts).
    const yaw = Math.atan2(-s.bx * side, -s.bz * side);
    // Walk the site outward until the whole footprint clears the road, rather
    // than testing the anchor alone. A 78 m terrace anchored 27 m out still puts
    // its far end over the asphalt wherever the centreline curves away.
    for (let extra = 0; extra <= 24; extra += 4) {
      const dist = s.halfWidth + 15 + extra;
      const x = s.px + s.bx * dist * side;
      const z = s.pz + s.bz * dist * side;
      if (field.roadDistanceAt(x, z) < s.halfWidth + 8) continue;
      const y = field.heightAt(x, z);
      if (y < ctx.waterLevel + 0.6) continue;
      if (field.slopeAt(x, z) > 0.55) continue;
      // 1.16x, not 1.0. `standParts` builds roof eaves and end walls past the
      // nominal `width` — measured, a 46 m stand emits a 53 m mesh — so testing
      // the nominal width let a stand's far end land 11 m inside the road on a
      // curve (`.probe-tmp/crowding.ts`: `grandstand:46x6` worst clearance
      // -11.0 m, 1.08 % of frame across 69 of 193 volcano stations). Same class
      // of bug as an authored `lat` that ignores its own recipe's width.
      if (!standClearsRoad(st, x, z, yaw, width * 1.16)) continue;
      for (const o of out) if (o.position.distanceTo(_v.set(x, y, z)) < 95) return false;
      out.push({
        position: new THREE.Vector3(x, y, z),
        yaw,
        width,
        rows: main ? 9 : 6,
        density,
        arc: s.s,
        main,
      });
      return true;
    }
    return false;
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
      // `d` above is measured on the STATION's frame; this is the check against
      // the real baked distance field, which is what catches an anchor that sits
      // on the inside of a bend where the road curves back toward it.
      //
      // The discount used to be `o.min * 0.6` — a silent 40 % write-off of the
      // clearance the caller asked for, which on a 12 m half-width section let a
      // pass declaring `min: 4` put its props 2.4 m from the tarmac. 0.9 keeps a
      // little slack for the field's bake resolution without handing back most of
      // the margin. Rejecting a few anchors is the right trade here: the whole
      // P0d complaint is that there is too much bulk close to the road.
      if (field.roadDistanceAt(x, z) < s.halfWidth + o.min * 0.9) continue;
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
  /** Companion pass on the metal material — trusses, bracing, railings. */
  metal?: THREE.BufferGeometry;
  /** Companion pass on the sponsor atlas, with cells baked into the uvs. */
  sign?: THREE.BufferGeometry;
  /**
   * Let the atlas pick a different cell PER INSTANCE instead of baking one cell
   * into the uvs. Use it when a type appears more than once in view and would
   * otherwise show the same advertisement on every copy (billboards, holo ads).
   * Author the geometry with a plain `[0,0,1,1]` uv range when you set this —
   * the instance attribute supplies the cell offset.
   */
  signCells?: number;
  /** Companion pass on the lit-window material — city blocks and towers. */
  windows?: THREE.BufferGeometry;
  cull?: number;
  shadow?: boolean;
}

/** Dimensions and dressing level for one grandstand geometry. */
interface StandBuild {
  width: number;
  rows: number;
  /** Cantilever roof on exposed trusses. Main stands only. */
  roofed: boolean;
  /** Stair aisles splitting the terrace into blocks. */
  aisles: number;
  /** Seat/trim palette and sponsor-cell offset, so stands aren't clones. */
  variant: number;
}

/** One grandstand, split by material. Three draw calls per distinct size. */
interface StandParts {
  body: THREE.BufferGeometry;
  steel: THREE.BufferGeometry;
  sign: THREE.BufferGeometry;
  /** Highest point, metres above the anchor. */
  top: number;
}

const CULL_NEAR = 320;
const CULL_MID = 620;
const CULL_FAR = 1600;

/**
 * Bounding radius, in metres, a prop needs before it earns a slot in the shadow
 * cascades at all. Below this a prop is a bollard or a cone and its shadow is a
 * smudge the ground's own sun march already implies.
 */
/**
 * ================== TUNNEL / BRIDGE / WALL-RIDE CLEARANCE ==================
 *
 * Playtest defect: buildings clipped through the tunnel wall and stood inside
 * the bore, on the racing line. The clearance test that existed projected every
 * footprint corner onto the spline and demanded `halfWidth + margin` of lateral
 * distance — good for a flat trackside, and it did take coastal from 19 road
 * violations to 0, but it is a purely two-dimensional test. A house outside the
 * tunnel's outer wall clears the road laterally *and* has its gable buried in
 * the rock: the old test cannot express the tunnel as a volume, so it passed.
 *
 * `TrackBuilder` now publishes the swept cross-sections it actually builds, and
 * the rule is applied at the only place every prop instance passes through —
 * `emit()`. Two behaviours, because the two kinds of prop want opposite things:
 *
 *   * **procedural dressing** (tyre walls, sponsor boards, catch fence, street
 *     lights, braziers) is *dropped*. A tunnel's lining is its barrier; a tyre
 *     stack inside the bore is set dressing that became an obstacle.
 *   * **authored props** are *pushed clear* first (see `clearAuthored()`), and
 *     only dropped if they cannot be seated within `AUTHORED_PUSH_LIMIT`. The
 *     track author asked for a village along that stretch; the fix is to stand
 *     it outside the hill, not to delete it.
 *
 * Vertical sampling matters: an anchor sits at the prop's base, and the base of
 * a 9 m street lamp can be below the springing line of the arch while the mast
 * is inside it, so the anchor is probed as a short column.
 */
const VOLUME_PROBE_FRACTIONS = [0.06, 0.3, 0.65, 1.0];
/** Metres an authored prop may be pushed sideways before it is dropped instead. */
const AUTHORED_PUSH_LIMIT = 16;

/**
 * Lateral clearance an authored building must keep beyond the asphalt edge.
 *
 * Deliberately far smaller than `STAND_ROAD_CLEARANCE` (4.6 m): a grandstand
 * terrace is meant to sit well back, whereas `alleyBlock` is explicitly authored
 * as an alley wall and the recipe comment calls it "the closest building to the
 * kart anywhere on the circuit". So this asks only that the wall be off the
 * tarmac, not that it retreat into a field — the minimum that fixes the defect
 * while preserving the intended tight-alley look.
 */
const AUTHORED_ROAD_CLEARANCE = 0.6;
/**
 * Intrusion below this is left alone. Tyre walls, brake boards and warning posts
 * are *authored* to sit on the kerb and measure 0.2-1.9 m over — that is
 * deliberate dressing, and a guard that shuffles it around is doing damage, not
 * repair. The defect this exists for measures 5.3 m.
 */
const AUTHORED_ROAD_SLACK = 2.0;

/**
 * Authored types that belong *in* the corridor and must never be pushed or
 * dropped: a tunnel portal frames the bore, a gantry straddles the road, a
 * bridge pylon holds the deck up. Keep in sync with `normaliseType()`.
 */
const CORRIDOR_PROPS = new Set([
  'startgantry', 'balloonarch', 'arch', 'tunnelportal', 'hoload',
  'bridgepylon', 'spiralpylon', 'monorailpylon', 'agpylon', 'energypylon',
]);

/**
 * ======================= RE-SEATING AUTHORED PROPS =========================
 *
 * `Track.getDecorationHints()` resolves every authored prop's Y from the ROAD
 * surface plane, because that is the only surface Track has: the heightfield is
 * baked *from* the centreline, so Track cannot ask it anything. For a prop
 * authored beyond the shoulder it clamps the lateral offset into the corridor and
 * evaluates the cross-section there, so the prop keeps its true lateral position
 * but takes a height from the corridor edge — it sinks wherever the ground rises
 * above the road and floats wherever the ground falls away. `towerBlock` at
 * lat 46 came out 5.9 m underground; on the other side of the same corner another
 * one hung 6.2 m in the air, the neon `skyscraper` run at lat 74 was 29 m under
 * on one flank and 27 m over on the other, and `arcologyTower` at lat -62 floated
 * 27 m — all of them seated on a plane extrapolated 60 m sideways.
 *
 * We DO have the heightfield, and `PropSurfaceHint` carries the terms of Track's
 * calculation rather than only its total, so the answer can be redone here
 * without losing the authored `up`. Five conditions, all of them necessary:
 *
 *  1. `|lat| > corridor` — the prop is outside the drawn road surface, which is
 *     exactly when Track's clamp fired and its answer became an extrapolation.
 *     Inside the corridor the prop stands on the road mesh and Track's height is
 *     the definition of that surface; re-seating it there would replace a correct
 *     answer with a bake residual.
 *  2. not a `CORRIDOR_PROPS` type. A gate, portal or pylon has a vertical
 *     relationship with the carriageway that the ground knows nothing about, and
 *     several are authored at lat 0 with a deliberate `up` (holoAd floats 11-13 m
 *     over the asphalt, bridgePylon/spiralPylon hang 12-22 m BELOW the deck).
 *     Belt and braces with (1) — a lat-0 prop can never trip (1) anyway — but
 *     `holoAd` also appears at lat -20, which would.
 *  3. not a `PLINTH_PROPS` type — see below.
 *  4. not `elevated`. On a bridge deck or inside a tunnel bore the road is a
 *     structure: at volcano t=0.565 the carriageway is 46.9 m up with the basin
 *     floor at 7.2 m. A prop authored beside a deck was authored in the deck's
 *     frame, so dropping it 40 m to natural ground would move it out of the
 *     composition entirely and usually out of sight. Deliberately unchanged.
 *     Without this gate an `obsidianSpire` beside the volcano helix falls 44 m.
 *  5. the ground is above water. Below the waterline the heightfield is a seabed,
 *     which is not a surface anything stands on — coastal's `sailboat` at lat -74
 *     would go 28 m down onto it and its `buoy` run 16 m, and neither is even
 *     visible from the circuit once it is under the sea. Same test the procedural
 *     scatterers make (`roadside()` refuses a wet anchor outright); here it means
 *     "leave Track's answer alone", which at least keeps the hull near the
 *     surface. Sea dressing wants the water plane, and nothing in this pass knows
 *     that, so it is left as it was found.
 *
 * There is no seam at the corridor edge, which is the reason this is safe: the
 * bake flattens the terrain onto the road plane out to `halfWidth + 2.2 m` and
 * blends back to natural ground over the following 30 m, so just outside the
 * corridor `heightAt()` *is* the road plane, and the two answers agree to
 * centimetres. Re-seating only starts to move a prop as the terrain genuinely
 * departs from the road.
 */

/**
 * Authored types that must keep the road datum even though they stand outside the
 * corridor, because their recipe already solves the cross-fall: `standParts()`
 * builds the terrace plinth down to -3.2 m for exactly that reason. A stand is
 * 25-46 m wide — wider than the blend ramp it straddles — so a single point
 * sample of the ramp is not a height it can stand on: seating its centre on the
 * ramp digs its road-facing terrace into the bank while the outboard end still
 * hangs over the fall. The corridor edge is the datum the terraces were drawn
 * from and the one the crowd is seated against. (`.probe-tmp/buried.ts` reaches
 * the same conclusion from the other side: `DESIGNED_SKIRT` measures these from
 * their origin instead of their lowest vertex.)
 */
const PLINTH_PROPS = new Set(['grandstand', 'crowdstand']);

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
  /** Instances the road-volume guard removed this build — reported once. */
  private volumeDrops = 0;
  private volumePushes = 0;
  /** Anchors the road-SURFACE guard moved off the asphalt — reported once. */
  private roadSurfacePushes = 0;
  private roadSurfaceWorst = 0;
  private roadSurfaceRefused = 0;
  private roadSurfaceTypes: string[] = [];
  /** Authored placements grouped by normalised type, minus any already claimed. */
  private authored = new Map<string, Anchor[]>();

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
    // Group the authored placements FIRST. A theme builder can then claim the
    // ones it already has geometry for (`takeAuthored`), folding them into an
    // existing InstancedMesh instead of adding a draw call for a second copy of
    // the same skyscraper.
    this.collectAuthored();
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
    if (this.volumeDrops || this.volumePushes) {
      console.info(
        `[Props] road-volume guard: ${this.volumePushes} authored props pushed clear, `
        + `${this.volumeDrops} instances dropped from `
        + `${roadVolumes.list.length} tunnel/bridge/anti-gravity sections`,
      );
    }
    if (this.roadSurfacePushes || this.roadSurfaceRefused) {
      // Loud on purpose: every line here is an authored `lat` that does not fit
      // its own recipe, and the real fix belongs in TrackDefs. See
      // `clearRoadSurface` for the measurement this came from. `refused` means the
      // prop is hemmed in — pushing it clear of one carriageway would put it on
      // another — so those can only be fixed by re-authoring.
      console.warn(
        `[Props] road-surface guard: ${this.roadSurfacePushes} authored props were standing on`
        + ` the drivable road and have been pushed clear`
        + ` (worst move ${this.roadSurfaceWorst.toFixed(2)} m): ${this.roadSurfaceTypes.join(', ')}`
        + `; ${this.roadSurfaceRefused} could NOT be pushed clear and are still on the road`
        + ' — the authored `lat` for these types is smaller than the recipe is wide.',
      );
    }
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
      /**
       * For atlas geometry that picks its own cells per quad (`atlasRect()`):
       * writes an identity sub-rect so the shader's remap passes baked uvs
       * through untouched. Mutually exclusive with `atlasCells`.
       */
      atlasBaked?: boolean;
      place?: (a: Anchor, i: number, m: THREE.Matrix4) => boolean;
      motion?: 'gull' | 'tram';
      /**
       * This prop belongs inside the road corridor (gantry, portal, arch, deck
       * pylon), so skip the tunnel / bridge / anti-gravity clearance test.
       */
      corridor?: boolean;
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
    // Local AABB, for the road-volume clearance test below.
    if (!geo.boundingBox) geo.computeBoundingBox();
    const localBox = geo.boundingBox;
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
    const atlasAttr = (o.atlasCells || o.atlasBaked) ? new Float32Array(anchors.length * 4) : null;
    const placed: Array<{ x: number; y: number; z: number }> = [];

    let n = 0;
    let blocked = 0;
    const bounds = new THREE.Box3();
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (o.corridor !== true && this.insideRoadVolume(a, localBox)) { blocked++; continue; }
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
        if (o.atlasCells) {
          const cells = o.atlasCells;
          // `atlasCells: 8` is always the sponsor atlas (there is exactly one
          // 8-cell atlas in the file), so it goes through the weighted lookup:
          // a uniform 1-in-8 would put ~7 CAPY LAB and ~7 TINY TRIP CLUB boards
          // on a 58-board lap, and the owner asked for these "not too densely".
          // See `SPONSOR_PICK`. Any other cell count keeps the plain uniform pick.
          const cell = cells === SPONSORS.length
            ? SPONSOR_PICK[Math.floor(a.seed * SPONSOR_PICK.length) % SPONSOR_PICK.length]
            : Math.floor(a.seed * cells) % cells;
          const cols = 4, rows = Math.max(1, Math.ceil(cells / cols));
          atlasAttr[n * 4] = (cell % cols) / cols;
          atlasAttr[n * 4 + 1] = Math.floor(cell / cols) / rows;
          atlasAttr[n * 4 + 2] = 1 / cols;
          atlasAttr[n * 4 + 3] = 1 / rows;
        } else {
          atlasAttr[n * 4 + 2] = 1;
          atlasAttr[n * 4 + 3] = 1;
        }
      }
      bounds.expandByPoint(_v.setFromMatrixPosition(_m));
      placed.push({ x: _v.x, y: _v.y, z: _v.z });
      n++;
    }
    if (blocked > 0) this.volumeDrops += blocked;
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

  /**
   * True when this prop occupies a tunnel bore / shell, a bridge deck box or an
   * anti-gravity tube. Memoised on the anchor so every companion pass (glow,
   * cloth, metal, sign) agrees — see the note on `Anchor.blocked`. The body pass
   * is always emitted first, so the memo is set from the full silhouette rather
   * than from a lamp head or a banner.
   */
  private insideRoadVolume(a: Anchor, bb: THREE.Box3 | null): boolean {
    if (a.blocked !== undefined) return a.blocked;
    if (roadVolumes.list.length === 0) { a.blocked = false; return false; }
    let hit = bb !== null && this.boxPenetration(a, bb, _volDir) > 0;
    if (!hit) {
      // Corners alone can straddle a volume — a ring or an arch has all eight
      // outside it. Probe the axis too, up the prop's own height.
      const top = Math.max(1.5, bb ? bb.max.y : 4) * a.scale;
      for (const f of VOLUME_PROBE_FRACTIONS) {
        if (roadVolumePenetration(a.x, a.y + top * f, a.z, ROAD_VOLUME_SHELL) > 0) {
          hit = true;
          break;
        }
      }
    }
    a.blocked = hit;
    return hit;
  }

  /**
   * Push authored anchors out of the road's own volumes using the prop's real
   * oriented bounding box, so a 6 m-wide townhouse is judged on its gable and
   * not on its origin. Lateral, because trackside dressing belongs beside the
   * road: raising a house over a tunnel would only trade one wrong answer for
   * another. Anything that cannot be seated inside `AUTHORED_PUSH_LIMIT` is
   * marked blocked and `emit()` drops it.
   *
   * Returns `[pushed, dropped]`.
   */
  private clearAuthored(anchors: Anchor[], geo: THREE.BufferGeometry): [number, number] {
    if (roadVolumes.list.length === 0) return [0, 0];
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return [0, 0];
    let pushed = 0, dropped = 0;
    const dir = new THREE.Vector3();
    for (const a of anchors) {
      let moved = 0;
      for (let iter = 0; iter < 8; iter++) {
        const pen = this.boxPenetration(a, bb, dir);
        if (pen <= 0) break;
        const stepOut = Math.min(pen + 0.3, AUTHORED_PUSH_LIMIT - moved);
        if (stepOut <= 0.01) { a.blocked = true; dropped++; break; }
        a.x += dir.x * stepOut;
        a.z += dir.z * stepOut;
        moved += stepOut;
        // Re-seat on the ground it has moved onto, else a pushed prop floats.
        // `a.up` keeps an authored below-grade offset (volcano's lavaFountain is
        // authored 6 m under the surface so it erupts out of it).
        a.y = this.field.heightAt(a.x, a.z) + (a.up ?? 0);
        if (iter === 7) { a.blocked = true; dropped++; }
      }
      if (moved > 0 && a.blocked !== true) { pushed++; a.blocked = false; }
    }
    return [pushed, dropped];
  }

  /**
   * ---------------------------------------------------------------------------
   *  D4 — KEEP AUTHORED BUILDINGS OFF THE ASPHALT
   * ---------------------------------------------------------------------------
   *  `clearAuthored` above only knows about the road's own *volumes* — tunnel
   *  bores, bridge decks, anti-gravity tubes. On open tarmac there is no volume
   *  to be inside of, so nothing stopped a building standing on the racing line.
   *
   *  Measured (`.probe-tmp/sightline.ts`, which walks every solid prop's eight
   *  world box corners against the drawn road edge):
   *
   *      circuit           instances reaching inside the road   worst reach
   *      sunsetCoastline                 0                        —
   *      neonMetropolis                 30 x alleyBlock          5.3 m
   *      volcanoRush                     5 (rock, warningPost)    0.3 m
   *
   *  Neon Metropolis authors `alleyBlock` at `lat: 10.5`, `mirror: true`, and the
   *  recipe randomises its own half width to `rng.range(4.5, 6.5)` plus a 0.4 m
   *  roof cap. So the near wall lands at 10.5 - 6.9 = 3.6 m from the centreline
   *  against a road half width of 7.5-8.5 m: the alley walls stand up to 5.3 m
   *  inside the drivable road. `lat` was authored as if it were clearance, but it
   *  is a *centre* offset, and no width of building fits at 10.5.
   *
   *  THE PROPER FIX IS IN `TrackDefs.ts` — `lat: 10.5` wants to be roughly 17 for
   *  that recipe, and that is the track owner's call, not this file's. This guard
   *  is the safety net: it reports the intrusion precisely and pushes the anchor
   *  out by the minimum needed, so the failure is loud and mitigated instead of
   *  silent. Corridor props (gantries, portals, arches, deck pylons) never reach
   *  here — `buildAuthored` only calls this inside its `if (!corridor)` branch.
   *
   *  Like `standClearsRoad`, this is an XZ test: it cannot tell a building beside
   *  a low road from one beneath a flyover. That is safe for the props that reach
   *  it, because everything authored to be above or below the road is a corridor
   *  prop and therefore exempt.
   *
   *  Returns the number of anchors moved.
   * ---------------------------------------------------------------------------
   */
  private clearRoadSurface(anchors: Anchor[], geo: THREE.BufferGeometry): number {
    const st = this.ctx.stations;
    if (!st.length) return 0;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return 0;
    let pushed = 0;
    for (const a of anchors) {
      if (a.blocked === true) continue;
      // GROUND-SEATED ANCHORS ONLY. `a.up` is defined exactly when
      // `collectAuthored` re-seated this anchor onto the heightfield, i.e. when it
      // is trackside dressing standing on the ground outside the corridor. Every
      // other case is authored relative to something this guard must not touch —
      // volcano's `lavaFountain` is at `lat: 0`, `up: -26`, deliberately under a
      // bridge deck, and an early revision of this guard shoved it 9.5 m sideways
      // and re-seated it on the basin floor. Reusing the existing condition
      // rather than inventing a second one is the point.
      let up = a.up;
      if (up === undefined) {
        // Not re-seated, so `y` is authored relative to something this code does
        // not know about, and re-seating after a push could be very wrong. Unless
        // the prop is ALREADY standing on the heightfield to within a few
        // centimetres — then the ground *is* what it stands on, re-seating is
        // provably right, and the only reason it was skipped upstream is that its
        // authored `lat` fell inside `surf.corridor`. Which is precisely the case
        // this guard exists for: half of Neon Metropolis's alley blocks are
        // authored at `lat: 10.5` against a corridor that is wider than that.
        const ground = this.field.heightAt(a.x, a.z);
        if (Math.abs(a.y - ground) > 0.25) continue;
        up = 0;
      }
      const over = this.roadOverhang(a, bb);
      if (over <= 0) continue;
      const c = roadClearance(st, a.x, a.z);
      let ox = a.x - c.cx, oz = a.z - c.cz;
      const len = Math.hypot(ox, oz);
      if (len < 1e-4) continue;   // exactly on the centreline: no outward to pick
      ox /= len; oz /= len;
      // ONE shot, not a loop. Iterating looked safer and was not: where two
      // branches of the spline run close in XZ (the volcano switchbacks, the neon
      // flyover), pushing away from the nearer branch moves the prop toward the
      // other, `roadClearance` flips to it, and the anchor ping-pongs outward to
      // the 16 m limit. A single measured step cannot do that, and the check
      // below refuses the move outright if it made things worse.
      const step = Math.min(over + 0.2, AUTHORED_PUSH_LIMIT);
      const ox0 = a.x, oz0 = a.z, oy0 = a.y;
      a.x += ox * step;
      a.z += oz * step;
      // Re-seat on the ground it has moved onto, exactly as `clearAuthored` does,
      // or a pushed building floats above (or sinks into) the new grade.
      a.y = this.field.heightAt(a.x, a.z) + up;
      if (this.roadOverhang(a, bb) >= over) {
        a.x = ox0; a.z = oz0; a.y = oy0;
        this.roadSurfaceRefused++;
        continue;
      }
      pushed++;
      this.roadSurfaceWorst = Math.max(this.roadSurfaceWorst, step);
    }
    return pushed;
  }

  /**
   * How far the worst corner of an anchor's OBB reaches past the road edge plus
   * `AUTHORED_ROAD_CLEARANCE`, in metres. Zero when it clears.
   *
   * Slack of `AUTHORED_ROAD_SLACK` is allowed before this reports anything:
   * tyre walls, brake boards and warning posts are authored to sit *on* the kerb
   * and measured at 0.2-0.3 m over, which is intentional dressing, not a defect.
   */
  private roadOverhang(a: Anchor, bb: THREE.Box3): number {
    const st = this.ctx.stations;
    const ca = Math.cos(a.yaw), sa = Math.sin(a.yaw);
    const s = a.scale;
    let worst = 0;
    for (let c = 0; c < 8; c++) {
      const lx = (c & 1 ? bb.max.x : bb.min.x) * s;
      const lz = (c & 4 ? bb.max.z : bb.min.z) * s;
      // Yaw about +Y: local +X -> (cos, 0, -sin), local +Z -> (sin, 0, cos).
      const wx = a.x + lx * ca + lz * sa;
      const wz = a.z - lx * sa + lz * ca;
      const rc = roadClearance(st, wx, wz);
      const over = rc.halfWidth + AUTHORED_ROAD_CLEARANCE - rc.lat;
      if (over > worst) worst = over;
    }
    return worst > AUTHORED_ROAD_SLACK ? worst : 0;
  }

  /** Worst road-volume penetration over the eight corners of an anchor's OBB. */
  private boxPenetration(a: Anchor, bb: THREE.Box3, dir: THREE.Vector3): number {
    const ca = Math.cos(a.yaw), sa = Math.sin(a.yaw);
    const s = a.scale;
    let worst = 0;
    for (let c = 0; c < 8; c++) {
      const lx = (c & 1 ? bb.max.x : bb.min.x) * s;
      const ly = (c & 2 ? bb.max.y : bb.min.y) * s;
      const lz = (c & 4 ? bb.max.z : bb.min.z) * s;
      // Yaw about +Y: local +X -> (cos, 0, -sin), local +Z -> (sin, 0, cos).
      const wx = a.x + lx * ca + lz * sa;
      const wz = a.z - lx * sa + lz * ca;
      const pen = roadVolumePenetration(wx, a.y + ly, wz, ROAD_VOLUME_SHELL, _volDir);
      if (pen > worst) { worst = pen; dir.copy(_volDir); }
    }
    return worst;
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
    // ORIENTATION. This structure is built along local +-X and has to arch ACROSS
    // the road, so its yaw must come from the **tangent** (local +X then lands on
    // the binormal — see the PROP ORIENTATION block in Track.ts). It used to be
    // derived from the binormal, which is exactly 90 degrees out: the deck ran
    // lengthwise down the centre of the carriageway and both truss towers stood
    // on the racing line, 14.7 m either side of the start line.
    const start = st[0];
    const hw = start.halfWidth;
    const gantryAnchor: Anchor[] = [{
      // Road height, not terrain height: this thing straddles the carriageway.
      x: start.px, y: start.py,
      z: start.pz, yaw: Math.atan2(start.tx, start.tz),
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
        // Base plinth wrapping the four legs' feet. Centred at its own half
        // height so the 0.7 m block stands ON the road: written as `0` it was
        // centred on the surface and only its top half showed, which is the same
        // centred-`box()` mistake that buried the marshal booth below.
        b.box(sx * legX, 0.35, 0, 1.5, 0.35, 1.5, 0x22262b, { shade: { top: 1.0 } });
      }
      // Deck spanning the road.
      b.box(0, 11.6, 0, legX + 1.6, 0.55, 1.3, 0x2b3138);
      for (let k = -6; k <= 6; k++) {
        b.tube(k * legX / 6.5, 11.2, -1.0, k * legX / 6.5, 11.2, 1.0, 0.06, 4, 0x3a424b);
      }
      b.box(0, 12.2, 0, legX + 1.0, 1.5, 0.35, 0xe9e6dd, { shade: { side: 1.05 } });
      this.emit('gantry', b.build('gantry'), this.matte, gantryAnchor,
        { cull: CULL_MID, corridor: true });
    }
    {
      // Lit "FINISH" strip + lamp bars on the deck.
      const b = this.builder();
      b.box(0, 12.2, 0.22, hw + 0.9, 0.62, 0.06, 0xff3b2f);
      for (let k = -5; k <= 5; k++) {
        b.box(k * (hw / 5.4), 11.15, 0, 0.55, 0.1, 0.5, 0xfff2c8);
      }
      this.emit('gantryLights', b.build('gantryLights'), this.glow, gantryAnchor,
        { cull: CULL_MID, bloom: true, shadow: false, corridor: true });
    }
    {
      // Sponsor banner hanging under the deck.
      const b = this.builder();
      b.banner(0, 11.2, -0.1, (hw + 1) * 2, 2.6, 0, 0xffffff, 5, [0, 0, 1, 1]);
      this.emit('gantryBanner', b.build('gantryBanner'), this.atlasSway, gantryAnchor,
        { cull: CULL_MID, atlasCells: 8, shadow: false, corridor: true });
    }

    // ---- sponsor boards ------------------------------------------------------
    {
      const anchors = roadside(ctx, rng, {
        spacing: 34, min: 3.5, max: 6.5, jitter: 0.25, limit: this.count(58),
        skipNearStands: this.stands,
      });
      const b = this.builder();
      // Board face + frame + feet, one merged geometry drawn with the atlas.
      // v TOP-FIRST — see the `V_TOP_FIRST` note above `atlasRect()`. `plate()`
      // sends the geometry's top edge to the rect's *first* v, and
      // `canvasTexture()` keeps three's `flipY = true` so v = 1 is the canvas
      // top. Passing an ascending v range here rendered the text upside down
      // (verified on screen: "CHAMPIONSHIP" appeared vertically mirrored).
      b.plate(0, 1.55, 0.06, 6.4, 2.1, 0, 0xffffff, { single: false, uvRect: [0.02, 0.94, 0.98, 0.06] });
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
          // 14, not 9. This is a fixed clearance tested against a road whose half
          // width reaches 12.5 m, so on the wide sections a 6.1 m panel passed the
          // test while standing over the tarmac: measured (`.probe-tmp/crowding.ts`)
          // `catchFence` / `fencePost` at -11.2 m clearance on volcano, present at
          // 90 of 193 stations. Same class of bug as an authored `lat` that ignores
          // its own recipe width — a constant standing in for a variable.
          if (this.field.roadDistanceAt(x, z) < 14) continue;
          anchors.push({
            x, y: this.field.heightAt(x, z), z,
            yaw: stand.yaw, side: 0, arc: stand.arc, scale: 1, seed: rng.next(),
          });
        }
      }
      const b = this.builder();
      // v top-first (see `atlasRect()` note) so the artwork isn't flipped.
      b.plate(0, 2.3, 0, 6.1, 4.2, 0, 0xdfe4ea, { single: true, uvRect: [0, 1, 1, 0] });
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
    // Stands of the same size share one geometry, so `planStands`' main +
    // secondary sizes cost six draws total however many corners get a stand.
    if (this.stands.length) {
      const groups = new Map<string, { spec: StandSpec; anchors: Anchor[] }>();
      for (let i = 0; i < this.stands.length; i++) {
        const st2 = this.stands[i];
        const key = `${Math.round(st2.width)}x${st2.rows}${st2.main ? 'm' : ''}`;
        let grp = groups.get(key);
        if (!grp) { grp = { spec: st2, anchors: [] }; groups.set(key, grp); }
        grp.anchors.push({
          x: st2.position.x, y: st2.position.y, z: st2.position.z, yaw: st2.yaw,
          side: 0, arc: st2.arc, scale: 1, seed: (i * 0.37) % 1,
        });
      }

      let vi = 0;
      for (const [key, grp] of groups) {
        const spec = grp.spec;
        const parts = this.standParts({
          width: spec.width,
          rows: spec.rows,
          roofed: spec.main,
          aisles: standAisleCount(spec.main),
          variant: spec.main ? 0 : 1 + (vi++ % 2),
        });
        this.emit(`grandstand:${key}`, parts.body, this.matte, grp.anchors, { cull: CULL_FAR });
        this.emit(`grandstandSteel:${key}`, parts.steel, this.metal, grp.anchors, { cull: CULL_MID });
        this.emit(`grandstandSign:${key}`, parts.sign, this.atlas, grp.anchors,
          { cull: CULL_MID, atlasBaked: true, shadow: false });

        // Cloth sponsor banners slung from the front truss, hanging into the
        // roof void above the back rows. Three separate cloths with baked cells
        // rather than one wide one: a 1:1 atlas cell stretched 30 m is mush.
        if (spec.main) {
          const bn = this.builder();
          const bwd = Math.min(9, spec.width * 0.13);
          for (let k = -1; k <= 1; k++) {
            bn.banner(k * bwd * 1.6, parts.top - 2.4, STAND_FRONT_Z - 1.1,
              bwd, 2.4, 0, 0xffffff, 3, atlasRect(k + 5));
          }
          this.emit('standBanner', bn.build('standBanner'), this.atlasSway, grp.anchors,
            { cull: CULL_MID, atlasBaked: true, shadow: false });
        }
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
      // =====================================================================
      // THE MARSHAL BOOTH WAS EXACTLY HALF UNDERGROUND.
      //
      // `box()` takes a CENTRE plus HALF-extents. `prism()`, two lines below in
      // the same recipe, takes a BASE plus a height. The booth body was written
      // `box(0, 0, 0, 1.3, 1.25, 1.1)` — which reads as "on the ground, 1.25
      // tall" and builds as "centred ON the ground": y = -1.25 … +1.25, so half
      // the 2.5 m box was under the surface and the roof cap sat at the ground
      // line. `roadside()` drops one of these 8–12 m beyond the road edge every
      // 210 m starting at arc 0, so every circuit has one beside the
      // start/finish line — measured at t = 0.020 (coastal), 0.015 (neon) and
      // 0.002 (volcano), 19–25 m to the driver's left. That is the "prop box
      // partially embedded in the ground near the start/finish line" a
      // playtester reported, and no anchor was at fault: the probe measures
      // `sink` (ground − origin) as 0.00 for every instance. The recipe buried
      // itself.
      //
      // Nothing else here moves, because everything else was already authored
      // for a booth standing ON y = 0 and 2.5 m tall: the window at 0.40…1.50,
      // the rear board at 1.25…2.25, the flag mast rising from 0. Only the body
      // and its roof cap were inconsistent.
      // =====================================================================
      const anchors = roadside(ctx, rng, { spacing: 210, min: 8, max: 12, limit: 10 });
      const b = this.builder();
      /** Booth height. Centre at H/2 so the base lands on y = 0, not the centre. */
      const H = 2.5;
      b.box(0, H * 0.5, 0, 1.3, H * 0.5, 1.1, 0xe6e3d8, { shade: { top: 1.05 } });
      b.box(0, H, 0, 1.5, 0.14, 1.3, 0xc0342c);           // roof cap, on the roof
      b.box(0, 0.95, 1.05, 1.0, 0.55, 0.06, 0x2a2f36);    // window, 0.40 … 1.50
      b.prism(1.1, 0, 0.9, 0.07, 3.4, 6, 0x9aa1a9, { capBottom: true });
      // Rear warning board, 1.25 … 2.25. At z = -1.0 it was 0.04 m INSIDE the
      // 2.2 m-deep body and only visible because the body used to be sunk; -1.05
      // stands it 0.01 m clear of the back wall, mirroring what the window plate
      // above already does on the front.
      b.box(0.7, 1.75, -1.05, 0.5, 0.5, 0.06, 0xf2c53d);
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
      /**
       * An arch has to straddle the road, so — like the gantry — its yaw comes
       * from the **tangent**, not the binormal (that was 90 degrees out: the arc
       * of balloons ran down the middle of the carriageway, and edge-on it read
       * as a bare torus floating beside the kart).
       *
       * Site choice also matters: sample forward from the nominal lap fraction
       * until the terrain is close to the road height. That rejects the two
       * places an arch must never go — over a jump gap (the coastal cove arch
       * used to hang in mid-air above the water at d~1159) and over an elevated
       * bridge or spiral deck.
       */
      const siteNear = (frac: number): PathStation => {
        const n0 = st.length;
        const i0 = Math.floor(n0 * frac);
        for (let k = 0; k < 40; k++) {
          const s = st[(i0 + k) % n0];
          if (Math.abs(s.py - this.field.heightAt(s.px, s.pz)) < 2.5) return s;
        }
        return st[i0];
      };
      const arches: Anchor[] = [siteNear(0.42), siteNear(0.72)].map((s) => ({
        x: s.px, y: s.py, z: s.pz,
        yaw: Math.atan2(s.tx, s.tz), side: 0, arc: s.s, scale: 1, seed: rng.next(),
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
        { cull: CULL_NEAR, shadow: false, corridor: true });
    }

    // ---- distance / turn signs ----------------------------------------------
    {
      const anchors = roadside(ctx, rng, { spacing: 95, min: 4, max: 6.5, limit: this.count(18) });
      const b = this.builder();
      b.prism(0, 0, 0, 0.08, 2.4, 6, 0x8f959d, { capBottom: true });
      // v top-first (see `atlasRect()` note) so the sign face isn't flipped.
      b.plate(0, 2.6, 0.05, 1.5, 1.0, 0, 0xffffff, { uvRect: [0.05, 0.9, 0.95, 0.1] });
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
      // The same centred-`box()` trap as `marshalPost` in buildRaceDressing, but
      // applied to the WHOLE hut: it was composed around its own middle rather
      // than its floor — body -1.35…+1.35, door -1.35…+0.95 (i.e. starting at
      // the floor), roof eaves at +1.30 (flush with the body top). With the
      // anchor on the sand that left the floor 1.35 m under grade and buried the
      // hut to its window sills, 36% of the silhouette. `y0` lifts the
      // composition bodily, so every internal relationship — and therefore the
      // silhouette — is unchanged; it just stops being sunk.
      const hh = 1.35;          // half height of the hut body
      const y0 = hh;            // lift that puts the floor on y = 0
      b.box(0, y0, 0, 1.9, hh, 1.7, walls, { shade: { top: 1.02, side: 1.0 } });
      // Pitched roof from two slanted quads. The eave beds 0.05 into the wall top.
      const rh = 1.05;
      const eave = y0 + 1.3;
      b.quad(-2.15, eave, -1.95, 0, eave + rh, -1.95, 0, eave + rh, 1.95, -2.15, eave, 1.95, 0xd7462f, 1.08);
      b.quad(0, eave + rh, -1.95, 2.15, eave, -1.95, 2.15, eave, 1.95, 0, eave + rh, 1.95, 0xc23c28, 0.94);
      b.box(0, y0 - 0.2, 1.75, 0.55, 1.15, 0.06, 0x2f5f8a);     // door, 0 … 2.30
      b.box(0, y0 + 0.35, -1.75, 0.42, 0.36, 0.06, 0x8fc4dd);   // rear window
      // Corner posts, now standing on the sand instead of buried to their caps.
      for (const sx of [-1, 1]) b.prism(sx * 1.6, 0, sx * 1.4, 0.11, 0.75, 5, 0x6b5334);
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
      // Fold the track's authored towers into this same InstancedMesh instead of
      // building a second copy of identical geometry — one draw call serves both.
      // This is what `takeAuthored` was written for; nothing had ever called it.
      // Appended AFTER the scale jitter above so an authored `scale: 1.6`
      // survives rather than being overwritten by it.
      anchors.push(...this.takeAuthored('skyscraper'));

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
      // The track authors a run of these down the start straight at lat 17.
      anchors.push(...this.takeAuthored('neonsign'));
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
      anchors.push(...this.takeAuthored('trafficlight'));
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
      // ---- P0d. `roadside()`'s `min` is the clearance of the ANCHOR, and says
      // nothing about how wide the thing standing on it is — the same mistake as
      // the authored `alleyBlock` at lat 10.5, one layer down. The shard cluster
      // is ~2.5 m in half-width and the scale went to 2.4, so at `min: 4` the far
      // shard of a big one reached 2 m INSIDE the tarmac. Measured
      // (`.probe-tmp/crowding.ts`): worst instance 7.9 m past the road edge,
      // 0.62 % of frame across 111 of 193 stations — present at more than half
      // the circuit. `min` now covers the widest body the scale can produce
      // (10 - 2.5*1.6 = 6 m of guaranteed verge) and the scale range is capped.
      const anchors = roadside(ctx, rng, {
        spacing: 19, min: 10, max: 44, sides: 2, limit: this.count(80),
        maxSlope: 0.85, faceRoad: false, skipNearStands: this.stands,
      });
      for (const a of anchors) a.scale = 0.55 + rng.next() * 1.05;
      // Volcano authors `obsidianSpire` twice (crater rim and the spiral) at
      // scale 1.4–1.6; this shard cluster is exactly that silhouette already.
      anchors.push(...this.takeAuthored('obsidianspire'));
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
  private collectAuthored(): void {
    const props = this.ctx.hints.props;
    if (!props || !props.length) return;
    const byType = this.authored;
    const unknown = new Set<string>();
    let reseated = 0;
    let worstReseat = 0;

    for (const p of props) {
      const key = normaliseType(p.type);
      if (!key) { unknown.add(p.type); continue; }
      // A track that authors its own stands on the start straight was, until
      // now, stacking 34 m authored stands inside the 78 m one `planStands`
      // places there — three intersecting stands in the most-photographed
      // frame in the game. The procedural one wins: it is the only one Crowd
      // seats people in.
      if ((key === 'grandstand' || key === 'crowdstand') && this.clashesWithStand(p.position)) {
        continue;
      }
      let list = byType.get(key);
      if (!list) { list = []; byType.set(key, list); }
      let yaw = 0;
      if (typeof p.rotation === 'number') yaw = p.rotation;
      else if (p.rotation && typeof (p.rotation as THREE.Euler).y === 'number') yaw = (p.rotation as THREE.Euler).y;
      let scale = 1;
      if (typeof p.scale === 'number') scale = p.scale;
      else if (p.scale && typeof (p.scale as THREE.Vector3).y === 'number') scale = (p.scale as THREE.Vector3).y;
      // See the RE-SEATING block above for why these five conditions and no
      // others. `up` is added back on top of the new surface so a prop authored
      // to hang below grade (volcano's `lavaFountain` at lat 44, `up: -6`) still
      // hangs the same distance below the ground it is now standing on.
      let y = p.position.y;
      const surf = p.surface;
      // `groundUp` stays undefined unless we re-seated: only then is the offset
      // known to be measured from the GROUND. Volcano's `lavaFountain` at lat 0
      // is `up: -26` under a bridge DECK, and handing that to `clearAuthored()`'s
      // push would bury it 26 m under the basin floor instead.
      let groundUp: number | undefined;
      if (
        surf !== undefined
        && Math.abs(surf.lat) > surf.corridor
        && !surf.elevated
        && !CORRIDOR_PROPS.has(key)
        && !PLINTH_PROPS.has(key)
      ) {
        // The ground, not the ground plus `up`: a prop authored to sit below
        // grade still needs the grade itself to be dry land.
        const ground = this.field.heightAt(p.position.x, p.position.z);
        if (ground >= this.ctx.waterLevel) {
          const seated = ground + surf.up;
          if (Math.abs(seated - y) > 1e-3) {
            worstReseat = Math.max(worstReseat, Math.abs(seated - y));
            reseated++;
            y = seated;
          }
          groundUp = surf.up;
        }
      }
      list.push({
        x: p.position.x, y, z: p.position.z,
        yaw, side: 0, arc: 0, scale: clamp(scale, 0.15, 12), seed: this.rng.next(),
        up: groundUp,
      });
    }

    if (unknown.size) {
      console.info('[Props] track requested prop types with no builder:', [...unknown].join(', '));
    }
    if (reseated) {
      console.info(
        `[Props] re-seated ${reseated} authored props onto the heightfield`
        + ` (outside the road corridor; worst correction ${worstReseat.toFixed(2)} m)`,
      );
    }
  }

  /**
   * Claim the authored anchors for `key` and remove them from the pending set,
   * so a theme builder can append them to an emit it is already making. Two
   * copies of the same skyscraper geometry is two draw calls for one silhouette;
   * this makes an authored landmark free.
   */
  private takeAuthored(key: string): Anchor[] {
    const list = this.authored.get(key);
    if (!list) return [];
    this.authored.delete(key);
    return list;
  }

  /** Build whatever authored types no theme builder claimed. */
  private buildAuthored(): void {
    for (const [key, anchors] of this.authored) {
      const spec = this.authoredSpec(key);
      if (!spec) continue;
      const corridor = CORRIDOR_PROPS.has(key);
      // Seat the whole group clear of the tunnel bore / bridge deck / wall-ride
      // BEFORE any pass is emitted, so body, glow, cloth, metal and sign all
      // land on the same resolved anchor. See the CLEARANCE block above.
      if (!corridor) {
        const [pushed, dropped] = this.clearAuthored(anchors, spec.geo);
        this.volumePushes += pushed;
        void dropped;
        // ...and off the drawn road surface. See `clearRoadSurface`: the volume
        // guard above cannot see open tarmac, so this is where a building
        // authored on the racing line gets caught.
        const off = this.clearRoadSurface(anchors, spec.geo);
        if (off > 0) {
          this.roadSurfacePushes += off;
          this.roadSurfaceTypes.push(`${key} x${off}`);
        }
      }
      const body = spec.mat ?? this.matte;
      this.emit(`authored:${key}`, spec.geo, body, anchors, {
        cull: spec.cull ?? CULL_MID,
        bloom: body === this.glow || body === this.glowSoft,
        shadow: spec.shadow !== false,
        corridor,
      });
      // Optional companion passes so one authored type can mix materials without
      // a multi-material mesh: an emissive lamp head, a cloth sail, a chain-link
      // panel. Each is still a single instanced draw.
      if (spec.glow) {
        this.emit(`authored:${key}:glow`, spec.glow, spec.softGlow ? this.glowSoft : this.glow,
          anchors, { cull: spec.cull ?? CULL_MID, bloom: true, shadow: false, corridor });
      }
      if (spec.cloth) {
        this.emit(`authored:${key}:cloth`, spec.cloth, this.matteSway, anchors,
          { cull: spec.cull ?? CULL_MID, shadow: false, corridor });
      }
      if (spec.metal) {
        this.emit(`authored:${key}:metal`, spec.metal, this.metal, anchors,
          { cull: spec.cull ?? CULL_MID, corridor });
      }
      if (spec.sign) {
        this.emit(`authored:${key}:sign`, spec.sign, this.atlas, anchors,
          spec.signCells
            ? { cull: spec.cull ?? CULL_MID, atlasCells: spec.signCells, shadow: false, corridor }
            : { cull: spec.cull ?? CULL_MID, atlasBaked: true, shadow: false, corridor });
      }
      if (spec.windows) {
        this.emit(`authored:${key}:windows`, spec.windows, this.windows, anchors,
          { cull: spec.cull ?? CULL_MID, bloom: true, shadow: false, corridor });
      }
    }
  }

  /** True if `p` lands inside a planned stand's footprint. */
  private clashesWithStand(p: { x: number; z: number }): boolean {
    for (const s of this.stands) {
      if (Math.hypot(s.position.x - p.x, s.position.z - p.z) < s.width * 0.6 + 12) return true;
    }
    return false;
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

      case 'grandstand': case 'crowdstand': {
        const main = key === 'grandstand';
        const parts = this.standParts({
          width: main ? 34 : 22,
          rows: main ? 8 : 5,
          roofed: main,
          aisles: 1,
          variant: main ? 2 : 1,
        });
        return {
          geo: parts.body, metal: parts.steel, sign: parts.sign,
          cull: main ? CULL_FAR : CULL_MID,
        };
      }

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

      /**
       * ===================================================================
       *  TUNNEL PORTAL — REBUILT (P0d)
       * ===================================================================
       *  Owner: *"For any track with tunnel structures, the entrance and exit
       *  aren't refined enough, causing poor visual structure."*
       *
       *  The old recipe was two jambs, a ten-stone arch and a keystone, and it
       *  did not enclose anything. Measured against the bore it is supposed to
       *  frame (`.probe-tmp/crowding.ts`, and `CROSS` in TrackBuilder for the
       *  bore sweep):
       *
       *    the bore    a half-ellipse, horizontal semi-axis
       *                `hw + kerbW + shoulder + 0.6` = 12.25 m (coastal t=0.408)
       *                to 13.75 m (volcano t=0.865), vertical semi-axis
       *                `tunnelH` 8.20 m, centred 0.50 m below the centreline,
       *                so its crown is 7.70 m above the road.
       *    the portal  jamb inner faces at +-12.25 m, arch SPRINGING at 7.14 m
       *                and crown at 12.60 m, total 15.25 m half-width, 13.56 m
       *                tall, 2.50 m deep.
       *
       *  Two consequences, both visible in the owner's screenshots:
       *
       *   1. The arch sprang from 7.14 m while the bore crown is at 7.70 m, and
       *      there was NO WALL between them — a 4.9 m band of empty air between
       *      the top of the hole you drive into and the underside of the stone
       *      arch. You looked *through* the frame at the hillside behind it.
       *      That is the "poor visual structure": a decorative arch parked in
       *      front of a hole, not a portal.
       *   2. At volcano t=0.805 the terrain is 10.36 m and the road 5.88 m, so
       *      4.48 m of the portal (33 % of its height) is inside the hillside.
       *      That part is CORRECT for a bore driven into rising ground — but it
       *      ate the jambs, which were the only thing below the arch, leaving
       *      2.7 m of stub under a 5.5 m void.
       *
       *  So: a real headwall with the arch opening cut in it, sized to the bore;
       *  a projecting ring around the opening (the lip); a cornice and dentil
       *  course at the top (the lintel); wing walls raking back into the cutting
       *  so the structure reads as retaining the slope rather than sitting on it;
       *  a splayed three-ring reveal so the mouth has depth; and an emissive
       *  cove + a run of lamps going in, so the opening reads as a lit tunnel
       *  instead of a black rectangle.
       *
       *  ORIENTATION. `Track.getDecorationHints().place()` yaws a lat-0 prop so
       *  local +Z follows the TANGENT. The entrance is authored at `yaw: 0` and
       *  the exit at `yaw: Math.PI`, so for both of them **local +Z points into
       *  the hill and local -Z is the face the driver sees.** Everything
       *  decorative therefore lives at negative z and everything structural
       *  reaches into positive z.
       *
       *  CLEARANCE. `tunnelportal` is in `CORRIDOR_PROPS`, so neither
       *  `clearAuthored` nor `clearRoadSurface` will fix a mistake here. The
       *  widest shoulder edge inside a bore on any circuit is
       *  `hw 10.0 + kerbW 1.55 + shoulder 1.6 = 13.15 m`, so nothing may come
       *  inside 13.4 m of the centreline below the springing. The reveal rings
       *  hold their horizontal radius at 13.60 m and get their depth read from
       *  the z stagger and a descending soffit instead of narrowing.
       */
      case 'tunnelportal': {
        const b = this.builder();
        const glow = this.builder();
        /** Opening semi-axes: the widest bore (13.75 x 8.20) plus clearance. */
        const R = 13.90, H = 8.45;
        /** Springing line: -(CROSS.crown + CROSS.shoulderDrop). */
        const Y0 = -0.50;
        /** Headwall: how far past the opening, how high, how far below the road. */
        const WING = 3.4, YT = Y0 + H + 2.6, YB = -3.2;
        const FACE = 0.62;            // half-thickness of the headwall slab
        const stone = 0x8d8375, light = 0xa79a88, dark = 0x6f665b;
        /** Height of the arch soffit at a given x, or Y0 outside the opening. */
        const arcY = (x: number): number => {
          const u = Math.abs(x) / R;
          return u >= 1 ? Y0 : Y0 + H * Math.sqrt(1 - u * u);
        };

        // ---- 1. headwall, as a column sweep with the arch cut out ----------
        // Sampled by ANGLE, not by x, so the slabs are narrow where the curve is
        // steep (at the springing) and wide where it is flat (at the crown). Each
        // slab's underside takes the HIGHER of its two edge heights, so the wall
        // can never encroach on the ellipse — the ring in step 2 hides the steps.
        const STEPS = 20;
        for (let i = 0; i < STEPS; i++) {
          const x0 = -Math.cos((i / STEPS) * Math.PI) * R;
          const x1 = -Math.cos(((i + 1) / STEPS) * Math.PI) * R;
          const yb = Math.max(arcY(x0), arcY(x1));
          if (YT - yb < 0.08) continue;
          b.box((x0 + x1) * 0.5, (yb + YT) * 0.5, 0,
            (x1 - x0) * 0.5, (YT - yb) * 0.5, FACE, i % 2 ? stone : 0x877d70,
            { shade: { top: 1.05, side: 1.0 } });
        }
        for (const sx of [-1, 1]) {
          b.box(sx * (R + WING * 0.5), (YB + YT) * 0.5, 0,
            WING * 0.5, (YT - YB) * 0.5, FACE, stone, { shade: { top: 1.05 } });
          // Splayed footing where the wall goes into the ground.
          b.box(sx * (R + WING * 0.5), YB + 1.1, 0, WING * 0.5 + 0.35, 1.4, FACE + 0.42,
            dark, { shade: { top: 1.12 } });
          // Impost band: the moulding a real arch springs from.
          b.box(sx * (R + WING * 0.5 + 0.1), Y0 + 2.3, -0.28,
            WING * 0.5 + 0.2, 0.34, FACE + 0.5, light, { shade: { top: 1.2 } });
        }

        // ---- 2. arch ring — the lip, proud of the face ---------------------
        const RING = 22;
        for (let i = 0; i <= RING; i++) {
          const a = (i / RING) * Math.PI;
          const cx = -Math.cos(a) * (R + 0.44);
          const cy = Y0 + Math.sin(a) * (H + 0.44);
          const key = Math.abs(i - RING * 0.5) < 0.51;
          b.box(cx, cy, -0.42, 0.62, 0.72, 0.42, key ? light : (i % 2 ? stone : dark),
            { yaw: 0, shade: { top: 1.18, side: 1.02 } });
        }
        // Keystone, projecting further than its neighbours.
        b.box(0, Y0 + H + 0.9, -0.72, 1.05, 1.15, 0.72, light, { shade: { top: 1.26 } });

        // ---- 3. cornice + dentil course — the lintel ----------------------
        for (let i = 0; i < 24; i++) {
          const x = -(R + WING) + ((i + 0.5) / 24) * (R + WING) * 2;
          b.box(x, YT - 1.15, -0.5, 0.34, 0.3, 0.5, dark, { shade: { top: 1.1 } });
        }
        b.box(0, YT - 0.4, -0.34, R + WING + 0.25, 0.42, FACE + 0.42, light,
          { shade: { top: 1.24 } });
        // Coping: a thin cap that overhangs both faces, so the wall has a top
        // edge instead of ending in mid-air.
        b.box(0, YT + 0.2, 0, R + WING + 0.5, 0.22, FACE + 0.62, stone,
          { shade: { top: 1.3 } });

        // ---- 4. wing walls raking back into the cutting -------------------
        // Three stepped blocks per side, dropping as they run into the slope: the
        // read is "this structure is holding a hillside back", which is the whole
        // difference between a portal and a decorative arch.
        for (const sx of [-1, 1]) {
          for (let k = 0; k < 3; k++) {
            const z0 = 0.6 + k * 3.1;
            const top = YT - 0.2 - k * 2.35;
            b.box(sx * (R + WING * 0.5 + 0.25 + k * 0.55), (Y0 - 1 + top) * 0.5, z0 + 1.55,
              WING * 0.42, (top - (Y0 - 1)) * 0.5, 1.55,
              k % 2 ? stone : 0x827868, { shade: { top: 1.08 } });
          }
        }

        // ---- 5. splayed reveal — three rings going in ---------------------
        // Horizontal radius held at 13.60 (see the CLEARANCE note); the depth
        // read comes from the z stagger plus a soffit that descends as it goes,
        // which from a driver's eye height is the strongest depth cue available.
        const REV: Array<[number, number, number]> = [
          [1.9, 0.25, 0.90], [4.6, 0.62, 0.72], [8.2, 1.05, 0.56],
        ];
        for (const [z, drop, tone] of REV) {
          for (let i = 1; i < 18; i++) {
            const a = (i / 18) * Math.PI;
            const cx = -Math.cos(a) * 13.60;
            const cy = Y0 + Math.sin(a) * (H - drop);
            const g = Math.round(0x6f * tone);
            b.box(cx, cy, z, 0.9, 0.5, 0.55,
              (g << 16) | (Math.round(0x66 * tone) << 8) | Math.round(0x5b * tone),
              { shade: { top: 1.06, side: 0.96 } });
          }
        }

        // ---- 6. interior lighting — the black-hole fix --------------------
        // Two devices, both emissive (and bloom-tagged by `buildAuthored`):
        //  * a cove strip washing the arch just inside the mouth, so the ring is
        //    lit from within and the opening reads as a lit volume;
        //  * four pairs of wall lamps marching 24 m into the bore, which is what
        //    actually eases the eye in — a receding row of lights reads as depth
        //    even when the lining beyond them is dark.
        // `Lighting.NIGHT_EMITTERS` has a `portallamp` class so these also seat
        // real point lights on any circuit whose preset wants artificial light.
        for (let i = 2; i < 17; i++) {
          const a = (i / 18) * Math.PI;
          glow.box(-Math.cos(a) * (R - 0.55), Y0 + Math.sin(a) * (H - 0.55), 0.85,
            0.52, 0.16, 0.3, 0xffb066);
        }
        for (const sx of [-1, 1]) {
          for (let k = 0; k < 4; k++) {
            const z = 3.4 + k * 6.4;
            const y = Y0 + 4.9;
            glow.box(sx * (R - 1.25), y, z, 0.14, 0.5, 0.8, 0xffc98a);
            // A short wash bar under each fitting: the pool of light on the
            // lining is what sells a lit tunnel, not the bulb.
            glow.box(sx * (R - 1.05), y - 1.5, z, 0.1, 0.9, 0.34, 0xff9a4e);
          }
          // Low guide strip along the haunch, running the length of the reveal.
          glow.box(sx * (R - 0.75), Y0 + 0.55, 12.5, 0.09, 0.14, 12.0, 0xff7a3a);
        }

        return {
          geo: b.build('tunnelPortal'),
          glow: glow.build('tunnelPortalGlow'),
          softGlow: true,
          cull: CULL_FAR,
        };
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
        // ---- P0d SLIMMED across the road. `d` is the ACROSS-ROAD half-extent
        // for a trackside prop (local +Z faces the road), and at 4.5-6.0 m plus
        // 0.35 m of eaves the house reached 6.35 m off its own centre. Authored
        // at lat 15 that left 1.1 m of verge, and `.probe-tmp/crowding.ts`
        // measured `authored:townhouse` + its window pass at **8.5 % of the whole
        // frame** — the biggest offender on Sunset Coastline, and the cause of
        // its five worst stations (38-41 % of frame each). `w` (along the road) is
        // untouched, so the terrace keeps its variety; it is just less deep
        // towards the carriageway. TrackDefs also moves it out and thins it.
        const b = this.builder();
        const w = rng.range(4.5, 6.5), d = rng.range(3.6, 4.6), storeys = 2 + rng.int(0, 1);
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

      // ---- city dressing ---------------------------------------------------
      // `skyscraper`, `neonSign` and `trafficLight` are deliberately absent:
      // `buildCity` already emits that geometry and now claims the authored
      // anchors with `takeAuthored`, so they cost no extra draw call.

      case 'towerblock': {
        // Mid-rise, deliberately shorter than the 46 m `skyscraper` so the
        // authored lat-46 run reads as a wall of city behind the taller
        // background towers rather than competing with them.
        const b = this.builder();
        b.uvScale = 0.3;
        const H = rng.range(17, 25), w = rng.range(6.5, 9), d = rng.range(6, 8.5);
        b.box(0, H * 0.5, 0, w, H * 0.5, d, rng.next() < 0.5 ? 0x565d66 : 0x4a5057,
          { shade: { top: 1.12 } });
        b.box(0, 1.1, 0, w + 0.4, 1.1, d + 0.4, 0x363b41, { shade: { top: 1.0 } });
        b.box(0, H + 0.3, 0, w + 0.3, 0.3, d + 0.3, 0x3d4249, { shade: { top: 1.16 } });
        // Roof clutter breaks the flat-top silhouette that says "box".
        b.box(w * 0.4, H + 1.3, d * 0.3, 1.1, 1.0, 1.1, 0x4a5057);
        b.prism(-w * 0.45, H + 0.6, -d * 0.35, 0.5, 1.7, 8, 0x2f343a, { taper: 0.85 });
        // Horizontal floor bands: the cheapest way to give a block scale.
        const floors = Math.floor(H / 3.1);
        for (let f = 1; f < floors; f++) {
          b.box(0, f * 3.1, 0, w + 0.12, 0.1, d + 0.12, 0x646b74);
        }
        const win = this.builder();
        let cell = 0;
        for (let f = 0; f < floors; f++) {
          const y = 2.2 + f * 3.1;
          if (y > H - 1.2) break;
          for (let s = 0; s < 4; s++) {
            const yaw = s * Math.PI * 0.5;
            const ca = Math.cos(yaw), sa = Math.sin(yaw);
            const half = s % 2 === 0 ? w : d;
            const out = (s % 2 === 0 ? d : w) + 0.06;
            for (let i = -1; i <= 1; i++) {
              win.cell = cell++;
              const off = i * half * 0.55;
              win.plate(ca * off + sa * out, y, sa * off - ca * out,
                half * 0.44, 1.5, yaw + Math.PI, 0xffd9a0, { single: true });
            }
          }
        }
        win.cell = 0;
        return { geo: b.build('towerBlock'), windows: win.build('towerBlockWindows'), cull: CULL_FAR };
      }

      case 'arcologytower': {
        // The one landmark on the circuit (authored once, scale 2.4). Tapered
        // stepped drum with a lit crown so it reads from anywhere on the lap.
        const b = this.builder();
        b.uvScale = 0.26;
        let y = 0, r = 11.5;
        for (let i = 0; i < 5; i++) {
          const seg = 8.5 - i * 0.6;
          b.prism(0, y, 0, r, seg, 8, i % 2 ? 0x3f4650 : 0x474e58,
            { taper: 0.9, capBottom: i === 0, shade: { top: 1.14 } });
          // Overhanging service deck at each setback — the read that says
          // "inhabited structure" instead of "tapered cone".
          b.prism(0, y + seg, 0, r * 0.94, 0.55, 8, 0x2e343c, { taper: 1.12 });
          y += seg + 0.55;
          r *= 0.84;
        }
        b.prism(0, y, 0, r * 0.5, 6.5, 8, 0x2a3038, { taper: 0.4 });
        b.prism(0, y + 6.5, 0, 0.3, 9, 6, 0x9aa1a9, { taper: 0.4 });
        const glow = this.builder();
        // Ring of crown lights + a beacon at the mast tip.
        let gy = 0, gr = 11.5;
        for (let i = 0; i < 5; i++) {
          const seg = 8.5 - i * 0.6;
          glow.torus(0, gy + seg + 0.3, 0, gr * 0.99, 0.16, 16, 5, 0x2ef0ff, 1);
          gy += seg + 0.55;
          gr *= 0.84;
        }
        glow.sphere(0, y + 15.8, 0, 0.55, 8, 6, 0xff3b6a);
        return {
          geo: b.build('arcologyTower'), glow: glow.build('arcologyGlow'),
          cull: CULL_FAR,
        };
      }

      case 'alleyblock': {
        // These form the alley walls and are the closest buildings to the kart
        // anywhere on the circuit, so they carry the most surface detail per
        // square metre of any city prop.
        //
        // ---- P0d SLIMMED, and the fire escape moved to the BACK.
        // `.probe-tmp/crowding.ts` measured this recipe at **13.8 % of the whole
        // frame** on Neon Metropolis (8.56 % body + 5.23 % steel) across 38 of
        // 194 chase stations — the largest figure for any prop on any circuit.
        // Two separate causes:
        //   * `d` is the ACROSS-ROAD half-extent (a trackside prop's local +Z
        //     faces the road), and at 3.6-5.0 m plus the 0.77 m canopy overhang
        //     the body reached 5.8 m off its own centre. Now 2.9-3.9 m.
        //   * the fire escape hung at `d + 1.09`, i.e. a metre FURTHER toward the
        //     road than the façade, which is why the steel pass alone filled
        //     5.2 % of frame. A fire escape belongs over the back alley anyway,
        //     so it is now on -Z, behind the building and out of the frame.
        // `w` (along the road) is also trimmed 4.5-6.5 -> 4.0-5.6 so the terrace
        // does not read as one continuous slab at the new wider spacing.
        const b = this.builder();
        b.uvScale = 0.5;
        const H = rng.range(8.5, 13), w = rng.range(4.0, 5.6), d = rng.range(2.9, 3.9);
        const brick = rng.next() < 0.5 ? 0x7a4f42 : 0x6b5a4e;
        b.box(0, H * 0.5, 0, w, H * 0.5, d, brick, { shade: { top: 1.1 } });
        // Ground-floor shopfront in a darker band, with a canopy over it.
        b.box(0, 1.5, 0, w + 0.08, 1.5, d + 0.08, 0x33383e);
        b.box(0, 3.15, d + 0.35, w * 0.9, 0.1, 0.42, 0x2b6f5c, { shade: { top: 1.2 } });
        b.box(0, H + 0.28, 0, w + 0.4, 0.28, d + 0.4, 0x50463c, { shade: { top: 1.15 } });
        // Fire escape: two landings and the diagonal runs between them, hung on
        // the back wall (-Z) so it adds silhouette without adding road-side bulk.
        const metal = this.builder();
        for (let l = 0; l < 2; l++) {
          const ly = 3.9 + l * 3.4;
          metal.box(w * 0.55, ly, -(d + 0.55), w * 0.42, 0.07, 0.55, 0x4a5158);
          metal.box(w * 0.55, ly + 0.5, -(d + 1.05), w * 0.42, 0.5, 0.04, 0x4a5158);
          metal.tube(w * 0.15, ly, -(d + 1.0), w * 0.95, ly + 3.4, -(d + 1.0), 0.05, 4, 0x4a5158);
        }
        metal.prism(-w * 0.6, H + 0.5, -d * 0.4, 0.34, 1.5, 6, 0x3d434a, { taper: 0.9 });
        const glow = this.builder();
        for (let i = -1; i <= 1; i += 2) {
          glow.plate(i * w * 0.45, 1.7, d + 0.14, 1.1, 1.5, 0, 0xffca6a, { single: true });
        }
        return {
          geo: b.build('alleyBlock'), metal: metal.build('alleyBlockSteel'),
          glow: glow.build('alleyBlockGlow'), softGlow: true, cull: CULL_MID,
        };
      }

      case 'hoload': {
        // Spans the road 11–13 m up (and once trackside at lat -20, up 4). The
        // anchor is already at display height, so this is built around the
        // origin with no supports — it is a hologram, it does not need legs.
        // Keyed `hoload` because normaliseType lower-cases "holoAd" and strips
        // non-letters; CORRIDOR_PROPS here and Track's SPANS_THE_ROAD already
        // spell it that way, so watch the letter order when editing this case.
        const b = this.builder();
        // Thin emitter rails top and bottom; the panel itself is the glow pass.
        for (const sy of [-1, 1]) b.box(0, sy * 2.5, 0, 7.5, 0.16, 0.22, 0x1c2026);
        for (const sx of [-1, 1]) b.box(sx * 7.5, 0, 0, 0.16, 2.5, 0.22, 0x1c2026);
        const sign = this.builder();
        // Plain 0..1 uvs + signCells: each holo ad in view shows a different
        // sponsor rather than eight copies of the same one.
        sign.plate(0, 0, 0, 14.6, 4.7, 0, 0xffffff, { uvRect: [0, 1, 1, 0] });
        const glow = this.builder();
        glow.plate(0, 0, -0.05, 14.6, 4.7, 0, 0x2ef0ff, { single: true });
        for (const sy of [-1, 1]) glow.box(0, sy * 2.5, 0, 7.4, 0.05, 0.1, 0x8bf6ff);
        return {
          geo: b.build('holoAd'), sign: sign.build('holoAdSign'), signCells: 8,
          glow: glow.build('holoAdGlow'), softGlow: true, cull: CULL_FAR, shadow: false,
        };
      }

      case 'billboard': {
        const b = this.builder();
        for (const sx of [-1, 1]) {
          b.prism(sx * 3.4, 0, 0, 0.24, 6.2, 8, 0x3d434a, { capBottom: true, taper: 0.8 });
          b.tube(sx * 3.4, 4.2, 0, sx * 3.4, 6.0, -1.3, 0.13, 5, 0x3d434a);
        }
        b.box(0, 8.3, 0.22, 4.6, 2.7, 0.16, 0x2b3036, { shade: { top: 1.1 } });
        const sign = this.builder();
        sign.plate(0, 8.3, 0.05, 8.8, 4.9, 0, 0xffffff, { single: true, uvRect: [0, 1, 1, 0] });
        const glow = this.builder();
        // Two floodlight cans on the gantry, throwing up at the face.
        for (const sx of [-1, 1]) glow.box(sx * 2.2, 5.7, -0.5, 0.3, 0.1, 0.18, 0xfff0c8);
        return {
          geo: b.build('billboard'), sign: sign.build('billboardSign'), signCells: 8,
          glow: glow.build('billboardGlow'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'energypylon': {
        const b = this.builder();
        const H = 12.5;
        b.box(0, 0.3, 0, 0.85, 0.3, 0.85, 0x2a2e34);
        // Four splayed legs meeting a shaft: a lattice read without the tri count.
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          b.tube(sx * 0.7, 0.5, sz * 0.7, sx * 0.22, H * 0.42, sz * 0.22, 0.09, 4, 0x6b727a);
        }
        b.prism(0, H * 0.42, 0, 0.3, H * 0.58, 6, 0x757c85, { taper: 0.72 });
        for (let i = 0; i < 3; i++) {
          const y = H * 0.5 + i * 1.5;
          b.box(0, y, 0, 1.7 - i * 0.35, 0.09, 0.16, 0x878e96);
        }
        const glow = this.builder();
        // The energy: a stack of rings up the shaft plus cross-arm terminals.
        for (let i = 0; i < 4; i++) {
          glow.torus(0, 3.2 + i * 2.4, 0, 0.42 - i * 0.05, 0.09, 12, 5, 0x39ff88, 1);
        }
        for (let i = 0; i < 3; i++) {
          const y = H * 0.5 + i * 1.5, x = 1.7 - i * 0.35;
          for (const sx of [-1, 1]) glow.sphere(sx * x, y, 0, 0.15, 7, 5, 0xd8ffe8);
        }
        return {
          geo: b.build('energyPylon'), glow: glow.build('energyPylonGlow'),
          cull: CULL_MID,
        };
      }

      case 'agpylon': {
        // Marks the anti-gravity stretch, authored both sides at lat 12. Reads
        // as the thing generating the effect: a split column with a floating
        // core between the halves.
        const b = this.builder();
        b.prism(0, 0, 0, 1.0, 1.1, 6, 0x2f353d, { capBottom: true, taper: 0.82 });
        b.prism(0, 1.1, 0, 0.62, 3.1, 6, 0x454d57, { taper: 0.9 });
        b.prism(0, 6.4, 0, 0.56, 2.4, 6, 0x454d57, { taper: 1.08 });
        b.prism(0, 8.8, 0, 0.66, 0.5, 6, 0x2f353d, { taper: 0.8 });
        const glow = this.builder();
        // The 1.9 m gap between the two halves is where the effect lives.
        glow.sphere(0, 5.35, 0, 0.72, 10, 7, 0x8b5cff, { squash: 0.82 });
        glow.torus(0, 4.4, 0, 0.78, 0.08, 14, 5, 0xc9a8ff, 1);
        glow.torus(0, 6.3, 0, 0.78, 0.08, 14, 5, 0xc9a8ff, 1);
        glow.torus(0, 1.25, 0, 0.66, 0.06, 12, 4, 0x8b5cff, 1);
        return { geo: b.build('agPylon'), glow: glow.build('agPylonGlow'), cull: CULL_MID };
      }

      case 'monorailpylon': {
        const b = this.builder();
        const H = 14;
        b.box(0, 0.45, 0, 1.5, 0.45, 1.5, 0x3a3f47, { shade: { top: 1.1 } });
        b.prism(0, 0.8, 0, 0.9, H - 0.8, 6, 0xb4b8bd, { taper: 0.66 });
        // Cantilever head carrying the beam off to one side.
        b.box(0, H + 0.5, -1.6, 0.75, 0.5, 2.6, 0xa8acb2, { shade: { top: 1.14 } });
        b.tube(0, H - 1.4, 0, 0, H + 0.3, -3.0, 0.18, 5, 0xa8acb2);
        // A stub of track: authored on a 0.011 step, so consecutive pylons very
        // nearly join their beams into one continuous guideway.
        b.box(0, H + 1.5, -3.2, 0.62, 0.62, 9.5, 0xd2d6da, { shade: { top: 1.2 } });
        b.box(0, H + 0.85, -3.2, 0.42, 0.14, 9.4, 0x8f959c);
        const glow = this.builder();
        for (const sz of [-1, 1]) glow.box(0.66, H + 1.5, -3.2 + sz * 4.2, 0.05, 0.1, 0.5, 0x2ef0ff);
        return {
          geo: b.build('monorailPylon'), glow: glow.build('monorailPylonGlow'),
          softGlow: true, cull: CULL_FAR,
        };
      }

      case 'bridgepylon': case 'spiralpylon': {
        // ---------------------------------------------------------------------
        // These are authored BELOW the carriageway (`up: -12` on the city
        // flyover, -22 on the volcano bridge, -18 on the spiral), i.e. the
        // anchor is the depth at which the author wanted the pylon to read.
        //
        // One geometry cannot bridge all three depths: sized to reach the deck
        // at -12 it would stand 10 m proud of the road at -22. So the shaft is
        // built with its CAPITAL AT THE ANCHOR and descends 46 m from there —
        // deep enough to meet the ground in all three places. The consequence
        // is an intentional gap between capital and deck underside, which is
        // invisible from the road (you cannot see under your own deck) and only
        // shows from a distant side-on view. Fixing it properly needs a
        // per-anchor height query, which `authoredSpec` has no access to.
        // ---------------------------------------------------------------------
        // ---- P0d SLIMMED (spiral only). This was the worst single prop in the
        // game: 4.42 % of frame across 90 of 193 stations on volcano and every
        // one of that circuit's over-40 % sightline stations. TrackDefs starts
        // the run later and halves the density; here the shaft and its helical
        // rib come in from a 2.06 m half-width to 1.53 m, which is still a
        // believable column for a 40 m corkscrew and a 26 % narrower silhouette.
        const spiral = key === 'spiralpylon';
        const b = this.builder();
        const D = 46;
        const r = spiral ? 0.95 : 1.7;
        b.prism(0, -D, 0, r * 1.5, D, spiral ? 8 : 6, spiral ? 0x6b5f56 : 0x8f959c,
          { taper: 0.62, capTop: false, capBottom: false });
        // Capital: a widening head so the column meets the deck with a shoulder
        // instead of a butt joint.
        b.prism(0, -1.4, 0, r, 1.4, spiral ? 8 : 6, spiral ? 0x7d7167 : 0xa8acb2,
          { taper: 1.35, capBottom: false });
        b.box(0, 0.15, 0, r * 1.45, 0.3, r * 1.45, spiral ? 0x8a7d72 : 0xb4b8bd,
          { shade: { top: 1.18 } });
        if (spiral) {
          // A helical rib: the prop is holding up a 40 m corkscrew, so say so.
          for (let i = 0; i < 26; i++) {
            const a0 = i * 0.62, a1 = (i + 1) * 0.62;
            const y0 = -D + i * 1.6, y1 = -D + (i + 1) * 1.6;
            const rr = 1.37;
            b.tube(Math.cos(a0) * rr, y0, Math.sin(a0) * rr,
              Math.cos(a1) * rr, y1, Math.sin(a1) * rr, 0.16, 4, 0x5f554d);
          }
        } else {
          // Straight bracing collars at intervals down the shaft.
          for (let i = 1; i < 6; i++) {
            b.box(0, -i * 7.2, 0, r * 1.25, 0.28, r * 1.25, 0x7a8088, { shade: { top: 1.1 } });
          }
        }
        return {
          geo: b.build(spiral ? 'spiralPylon' : 'bridgePylon'),
          cull: CULL_FAR,
        };
      }

      case 'ventstack': {
        // Alley-side industrial vent, authored at lat 10 on a 0.012 step.
        const b = this.builder();
        b.box(0, 0.5, 0, 1.15, 0.5, 0.9, 0x4a4f55, { shade: { top: 1.08 } });
        b.box(0, 1.15, 0, 0.95, 0.2, 0.75, 0x3a3f45);
        for (const sx of [-0.5, 0.5]) {
          const h = 2.6 + rng.range(0, 1.4);
          b.prism(sx, 1.3, 0, 0.3, h, 8, 0x6e757c, { taper: 0.94, capBottom: false });
          // Cowl: an inverted cone cap, the silhouette that says "extractor".
          b.prism(sx, 1.3 + h, 0, 0.44, 0.42, 8, 0x565c63, { taper: 0.5 });
          b.torus(sx, 1.3 + h * 0.5, 0, 0.33, 0.05, 8, 4, 0x565c63);
        }
        b.tube(-0.5, 2.1, 0, 0.5, 2.1, 0, 0.09, 5, 0x565c63);
        return { geo: b.build('ventStack'), cull: CULL_NEAR };
      }

      case 'barrelstack': {
        // Reuses the `barrel` read at authored scale: a leaning stack, never a
        // tidy pyramid — the whole point is that it looks abandoned.
        const b = this.builder();
        const cols: number[] = [0xd94f3d, 0x3f7a4a, 0x2f6fd0, 0xb8862a];
        const lay = (x: number, y: number, z: number, upright: boolean, hex: number) => {
          if (upright) {
            b.prism(x, y, z, 0.42, 1.05, 10, hex, { capBottom: true, bulge: 1 });
            b.torus(x, y + 0.28, z, 0.43, 0.045, 10, 4, 0xe8e4d8);
            b.torus(x, y + 0.78, z, 0.43, 0.045, 10, 4, 0xe8e4d8);
          } else {
            // On its side: a tube along X reads as a rolled barrel.
            b.tube(x - 0.52, y + 0.42, z, x + 0.52, y + 0.42, z, 0.42, 10, hex);
            for (const sx of [-0.25, 0.25]) {
              b.torus(x + sx, y + 0.42, z, 0.2, 0.05, 8, 4, 0xe8e4d8);
            }
          }
        };
        lay(-0.5, 0, -0.2, true, cols[0]);
        lay(0.52, 0, 0.1, true, cols[1]);
        lay(0.05, 0, 0.85, true, cols[2]);
        lay(0.0, 1.05, 0.3, true, cols[3]);
        lay(-0.7, 0, 0.95, false, cols[rng.int(0, 3)]);
        return { geo: b.build('barrelStack'), cull: CULL_NEAR };
      }

      // ---- volcano dressing ------------------------------------------------
      // `obsidianSpire` is absent on purpose: `buildVolcano`'s shard cluster is
      // that silhouette and now claims the authored anchors.

      case 'basaltcolumn': {
        // Giant's-Causeway hexagonal jointing: a cluster of flat-topped hex
        // prisms at different heights, which is what makes it read as basalt
        // rather than as generic rock.
        //
        // ---- P0d SLIMMED. The owner's screenshots of Volcano Rush show these
        // crowding both verges, and `.probe-tmp/crowding.ts` put the recipe at
        // 1.90 % of the whole frame across 50 of 193 chase stations. The cluster
        // spread (`d` up to 2.3 with `r` up to 1.15) made a 3.45 m half-width
        // body, and TrackDefs then placed 44 of them at lat +-17 / +-24 with a
        // 1.2 scale on the start straight. Both ends are fixed: the count and
        // offsets in TrackDefs, and the body here.
        //   spread   0.9-2.3  -> 0.8-1.7
        //   radius   0.7-1.15 -> 0.55-0.95   (half-width 3.45 -> 2.65 m)
        //   height   3.5-9.5  -> 3.2-7.4     stops them towering over the road
        // The lithology reads the same; there is just less of it in the way.
        const b = this.builder();
        const n = 4 + rng.int(0, 2);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + rng.range(-0.5, 0.5);
          const d = i === 0 ? 0 : rng.range(0.8, 1.7);
          const h = rng.range(3.2, 7.4);
          const r = rng.range(0.55, 0.95);
          const x = Math.cos(a) * d, z = Math.sin(a) * d;
          // Lifted off near-black: at 0x3f3a38 these read as silhouettes against
          // the orange sky rather than as rock. The volcanic key is a saturated
          // #ff7a45 grazing at 19 deg, so a vertical face catches ~5x the light
          // an up-facing road does — but only if the albedo is there to catch it.
          b.prism(x, -0.4, z, r, h, 6, i % 3 === 0 ? 0x574f4c : 0x635a56,
            { taper: 0.97, yaw: rng.range(0, 1.05), shade: { top: 1.24, side: 0.98 } });
          // Horizontal joints: basalt breaks into stacked segments.
          const joints = Math.floor(h / 2.2);
          for (let j = 1; j <= joints; j++) {
            b.prism(x, -0.4 + j * 2.2, z, r * 1.03, 0.1, 6, 0x3a3433, { yaw: rng.range(0, 1.05) });
          }
        }
        return { geo: b.build('basaltColumn'), cull: CULL_FAR };
      }

      case 'deadtree': {
        const b = this.builder();
        const h = rng.range(4.5, 7.5);
        b.prism(0, 0, 0, rng.range(0.26, 0.4), h, 7, 0x2e2622,
          { taper: 0.34, capBottom: false, shade: { side: 0.95 } });
        // Bare branches, thinner and steeper as they go up.
        const n = 4 + rng.int(0, 2);
        for (let i = 0; i < n; i++) {
          const a = rng.range(0, 6.28);
          const y = h * rng.range(0.4, 0.92);
          const len = rng.range(1.1, 2.4) * (1 - y / (h * 1.4));
          const tipY = y + rng.range(0.5, 1.5);
          b.tube(0, y, 0, Math.cos(a) * len, tipY, Math.sin(a) * len,
            rng.range(0.07, 0.13), 4, 0x352b26);
          // One fork per branch is enough to stop them reading as spikes.
          if (rng.next() < 0.6) {
            b.tube(Math.cos(a) * len, tipY, Math.sin(a) * len,
              Math.cos(a) * len * 1.5, tipY + rng.range(0.3, 0.9), Math.sin(a) * len * 1.5,
              0.05, 4, 0x352b26);
          }
        }
        return { geo: b.build('deadTree'), cull: CULL_MID };
      }

      case 'ashplume': {
        // Authored far out (lat -34 to 56) as a background silhouette. Stacked
        // squashed spheres, widening and paling with height so it reads as a
        // column of ash lit from above. No shadow — a shadow-casting cloud
        // looks like a rock.
        const b = this.builder();
        const H = rng.range(26, 40);
        const puffs = 9;
        for (let i = 0; i < puffs; i++) {
          const t = i / (puffs - 1);
          const y = t * H;
          const r = 2.6 + t * 7.5;
          // 0x4a4340 at the base to 0x9a9088 at the top: the vertical gradient
          // is doing all the work here.
          const g = Math.round(0x4a + t * (0x9a - 0x4a));
          const hex = (g << 16) | (Math.round(0x43 + t * (0x90 - 0x43)) << 8)
            | Math.round(0x40 + t * (0x88 - 0x40));
          for (let k = 0; k < 2; k++) {
            const a = rng.range(0, 6.28);
            const d = t * rng.range(0, 3.2);
            b.sphere(Math.cos(a) * d, y, Math.sin(a) * d, r * rng.range(0.7, 1.0),
              8, 6, hex, { squash: rng.range(0.6, 0.85) });
          }
        }
        return { geo: b.build('ashPlume'), cull: CULL_FAR, shadow: false };
      }

      case 'lavafountain': {
        // Authored deep in the chasm (`up: -26`) and on the crater rim, at
        // scale 1.6–2.2. Built upward from the anchor: vent, spout, arc of
        // thrown gobbets.
        const b = this.builder();
        b.prism(0, -0.6, 0, 3.2, 1.9, 9, 0x1d1517, { taper: 0.66, shade: { top: 0.82 } });
        b.prism(0, 1.3, 0, 2.1, 0.5, 9, 0x140e10, { taper: 0.86 });
        const glow = this.builder();
        // The spout: a tapering column, brightest at the throat.
        glow.prism(0, 1.5, 0, 1.7, 7.5, 9, 0xff7a1e, { taper: 0.22 });
        glow.prism(0, 1.4, 0, 1.9, 0.7, 9, 0xffd48a, { taper: 0.9 });
        // Gobbets on ballistic arcs, each with its own atlas cell so the
        // shader's per-cell flicker desynchronises them.
        for (let i = 0; i < 9; i++) {
          glow.cell = i;
          const a = (i / 9) * Math.PI * 2 + rng.range(-0.3, 0.3);
          const d = rng.range(1.6, 4.6);
          const y = rng.range(5.5, 11.5);
          glow.sphere(Math.cos(a) * d, y, Math.sin(a) * d, rng.range(0.28, 0.62),
            7, 5, i % 2 ? 0xffb04a : 0xff5e1e, { squash: rng.range(0.7, 1.1) });
        }
        glow.cell = 0;
        return {
          geo: b.build('lavaFountain'), glow: glow.build('lavaFountainGlow'),
          cull: CULL_FAR, shadow: false,
        };
      }

      case 'lavarock': {
        // Cooled crust with molten cracks showing through: the body is near
        // black and every bit of colour comes from the glow pass, which is what
        // makes it read as hot rather than as a red rock.
        const b = this.builder();
        const R = rng.range(1.3, 2.4);
        for (let i = 0; i < 4; i++) {
          const a = rng.range(0, 6.28);
          const d = i === 0 ? 0 : rng.range(0.3, 0.9);
          b.prism(Math.cos(a) * d, -0.3, Math.sin(a) * d, R * rng.range(0.55, 1.0),
            R * rng.range(0.7, 1.25), 7, i % 2 ? 0x1b1517 : 0x231a1b,
            { taper: rng.range(0.35, 0.7), yaw: rng.range(0, 3), shade: { top: 1.3 } });
        }
        const glow = this.builder();
        for (let i = 0; i < 5; i++) {
          const a = rng.range(0, 6.28);
          const y = rng.range(0.2, R * 0.95);
          glow.cell = i;
          // Thin plates wedged in the crevices between the prisms.
          glow.plate(Math.cos(a) * R * 0.62, y, Math.sin(a) * R * 0.62,
            rng.range(0.5, 1.1), rng.range(0.12, 0.28), a + Math.PI * 0.5,
            i % 2 ? 0xff6a1e : 0xffa347, { single: true });
        }
        glow.cell = 0;
        return {
          geo: b.build('lavaRock'), glow: glow.build('lavaRockGlow'),
          softGlow: true, cull: CULL_MID,
        };
      }

      case 'warningpost': {
        // Lines the lava-field shortcut at lat -11 on a 0.006 step, so this is
        // seen at close range and at speed: high-contrast diagonal hazard
        // stripes, nothing subtle.
        const b = this.builder();
        b.box(0, 0.12, 0, 0.3, 0.12, 0.3, 0x2a2e34, { shade: { top: 1.1 } });
        b.prism(0, 0.2, 0, 0.12, 2.05, 6, 0x1f2328, { capBottom: false });
        // Stripes as stacked collars: cheaper than a texture and it reads
        // correctly from every angle.
        for (let i = 0; i < 7; i++) {
          b.prism(0, 0.28 + i * 0.25, 0, 0.135, 0.25, 6,
            i % 2 ? 0xffc93a : 0x1f2328, { shade: { side: 1.05 } });
        }
        b.box(0, 2.35, 0, 0.46, 0.36, 0.05, 0xffc93a, { shade: { top: 1.0 } });
        b.plate(0, 2.35, 0.07, 0.3, 0.3, 0, 0x1f2328, { single: true, pitch: 0.78 });
        const glow = this.builder();
        glow.sphere(0, 2.68, 0, 0.09, 6, 4, 0xff6a2a);
        return {
          geo: b.build('warningPost'), glow: glow.build('warningPostGlow'),
          softGlow: true, cull: CULL_NEAR,
        };
      }

      default: return this.simpleAuthored(key);
    }
  }

  /**
   * The grandstand. This is the largest man-made silhouette on the start
   * straight, so it gets the most geometry of anything in this file.
   *
   * Three merged geometries come out, one per material, which is three draw
   * calls however many stands share the same dimensions:
   *
   *   `body`  — concrete: plinth, columns, terrace, side walls, aisles, towers
   *   `steel` — bracing, railings, roof trusses, purlins, roof panel
   *   `sign`  — sponsor band on the barrier + fascia panels, on the atlas
   *
   * Everything horizontal is swept with `extrudeX`, which means every step
   * nosing, every parapet top and the roof's leading edge carry a real chamfer
   * for two extra triangles each. Nothing here has a raw 90° edge on a face you
   * can see, and the soffit over the whole footprint is baked down to a quarter
   * brightness — the void under the deck is free depth.
   */
  private standParts(o: StandBuild): StandParts {
    const R = clamp(Math.round(o.rows), 3, 16);
    const W = clamp(o.width, 14, 140);
    const hw = W * 0.5;
    const rowH = STAND_ROW_H, rowD = STAND_ROW_D;
    const y0 = STAND_DECK_LIFT + STAND_ROW0;
    const bz = STAND_FRONT_Z, zF = STAND_TREAD_F;
    const yRow = (r: number): number => y0 + r * rowH;
    const zRowBack = (r: number): number => -r * rowD - 0.425;
    const yTop = yRow(R - 1);
    /** Barrier capping height: low enough that row 0's heads clear it. */
    const barrier = y0 + 0.9;
    const yWalk = yTop + rowH;
    const zWalk = zRowBack(R - 1) - 1.05;
    const yWall = yWalk + 1.45;
    const zWallB = zWalk - 0.78;
    const soffitF = STAND_DECK_LIFT - 0.05;
    const soffitB = yWalk - 0.62;
    const plinth = 0.25;
    // Roof geometry, hoisted so the fascia signage can find it.
    const zMast = zWalk - 0.34;
    const yMast = yWall + 0.16;
    const yRidge = yMast + 3.7;
    const zEave = bz - 0.2;
    const yEave = yRidge - 1.15;

    // Warm off-white concrete, not neutral grey: under the current darker-blue
    // fog and 6.5:1 key/fill a neutral grey stand reads as flat blue plastic.
    const CONCRETE = 0xe4dccc;
    const DECK = 0xd9d0be;
    const RISER = 0xb9ad9c;
    // Soffit colour x shade lands at ~0.15 linear against ~0.39 for the lit
    // treads: a 2.6:1 AO step, which reads as deep shade without going to black.
    // Measured, not guessed — pushing it further just made the void a hole.
    const SOFFIT = 0x8a8074;
    const PLINTH = 0x9a9284;
    const STEEL = 0xc3c9d1;
    const STEEL_D = 0x767d88;
    const TRIM = [0xd6402f, 0x2f6fd0, 0x2b3038][o.variant % 3];
    const SEATS = [
      [0x2f6fd0, 0xd93b2f, 0xf0eade],
      [0xd93b2f, 0xf2c53d, 0x2b3038],
      [0x2fa363, 0xf0eade, 0x2f6fd0],
    ][o.variant % 3];

    const b = this.builder();
    const s = this.builder();
    const g = this.builder();
    b.uvScale = 0.5;
    s.uvScale = 0.8;

    // ---- terrace ------------------------------------------------------------
    // One profile: barrier, then per row a tread, a chamfered bench and the
    // seat-back riser, then the rear walkway, the back wall and the soffit.
    const prof: ProfilePt[] = [
      { z: bz, y: soffitF, hex: CONCRETE, shade: 0.97 },
      { z: bz, y: barrier - 0.12, hex: CONCRETE, shade: 1.08 },
      { z: bz - 0.13, y: barrier, hex: DECK, shade: 1.2 },
      { z: zF + 0.13, y: barrier, hex: CONCRETE, shade: 0.9 },
      { z: zF, y: barrier - 0.12, hex: RISER, shade: 0.66 },
      { z: zF, y: y0, hex: DECK, shade: 1.0 },
    ];
    for (let r = 0; r < R; r++) {
      const yr = yRow(r);
      const zb = zRowBack(r);
      const seat = SEATS[(r + o.variant) % SEATS.length];
      const next = r < R - 1 ? yRow(r + 1) : yWalk;
      prof.push({ z: zb + 0.34, y: yr, hex: seat, shade: 0.98 });
      prof.push({ z: zb + 0.34, y: yr + STAND_BENCH_H - 0.1, hex: seat, shade: 1.16 });
      prof.push({ z: zb + 0.24, y: yr + STAND_BENCH_H, hex: seat, shade: 1.3 });
      prof.push({ z: zb, y: yr + STAND_BENCH_H, hex: RISER, shade: 0.76 });
      prof.push({ z: zb, y: next - 0.1, hex: CONCRETE, shade: 1.12 });
      prof.push({ z: zb - 0.1, y: next, hex: DECK, shade: r < R - 1 ? 1.0 : 1.06 });
    }
    prof.push({ z: zWalk, y: yWalk, hex: CONCRETE, shade: 0.95 });
    prof.push({ z: zWalk, y: yWall, hex: CONCRETE, shade: 1.1 });
    prof.push({ z: zWalk - 0.16, y: yWall + 0.16, hex: DECK, shade: 1.22 });
    prof.push({ z: zWallB + 0.16, y: yWall + 0.16, hex: CONCRETE, shade: 0.86 });
    prof.push({ z: zWallB, y: yWall, hex: RISER, shade: 0.7 });
    prof.push({ z: zWallB, y: soffitB, hex: SOFFIT, shade: 0.58 });
    prof.push({ z: bz, y: soffitF });
    b.extrudeX(prof, -hw, hw, CONCRETE);

    // ---- side walls ---------------------------------------------------------
    // A straight rake from the barrier top to the back wall top, which sits
    // above the seating and closes the terrace's open ends.
    const wall: ProfilePt[] = [
      { z: bz, y: soffitF, hex: CONCRETE, shade: 1.02 },
      // Chamfer the front-top corner: on the near side wall this is the corner
      // closest to the camera on the whole stand, and a razor edge there is the
      // single most obvious tell at 25 m.
      { z: bz, y: barrier - 0.14, hex: CONCRETE, shade: 1.06 },
      { z: bz - 0.16, y: barrier, hex: DECK, shade: 1.22 },
      { z: zWallB, y: yWall + 0.16, hex: CONCRETE, shade: 0.92 },
      { z: zWallB, y: soffitB, hex: SOFFIT, shade: 0.55 },
      { z: bz, y: soffitF, hex: CONCRETE, shade: 1.02 },
    ];
    b.extrudeX(wall, -hw - 0.44, -hw, CONCRETE, { caps: true, shade: 0.98 });
    b.extrudeX(wall, hw, hw + 0.44, CONCRETE, { caps: true, shade: 0.98 });

    // ---- plinth -------------------------------------------------------------
    // Also the slope skirt: `planStands` accepts sites up to ~30°, so a 78 m
    // footprint can be a metre out at the corners. Running well below grade is
    // cheaper than pretending the terrain is flat.
    b.extrudeX([
      { z: bz + 0.55, y: -3.2, hex: PLINTH, shade: 0.9 },
      { z: bz + 0.55, y: plinth - 0.16, hex: PLINTH, shade: 1.02 },
      { z: bz + 0.4, y: plinth, hex: PLINTH, shade: 0.5 },
      { z: zWallB - 0.6, y: plinth, hex: PLINTH, shade: 0.72 },
      { z: zWallB - 0.75, y: plinth - 0.16, hex: PLINTH, shade: 0.66 },
      { z: zWallB - 0.75, y: -3.2, hex: PLINTH, shade: 0.58 },
    ], -hw - 0.95, hw + 0.95, PLINTH, { caps: true });

    // ---- columns + cross-bracing under the deck -----------------------------
    const soffitAt = (z: number): number =>
      soffitF + (soffitB - soffitF) * clamp01((bz - z) / Math.max(0.01, bz - zWallB));
    const nCol = clamp(Math.round(W / 11) + 1, 3, 9);
    const colX = (i: number): number => (i / (nCol - 1) - 0.5) * (W - 2.2);
    const lines = o.roofed ? [0.06, 0.44, 0.82] : [0.1, 0.62];
    const lineZ = lines.map((f) => bz - f * (bz - zWallB));
    for (let l = 0; l < lineZ.length; l++) {
      const cz = lineZ[l];
      const top = soffitAt(cz);
      for (let i = 0; i < nCol; i++) {
        b.prism(colX(i), plinth, cz, 0.38, top - plinth, 6, PLINTH,
          { capTop: false, yaw: 0.26, shade: { side: 0.6 } });
      }
      // Full X-bracing on the front line where you can see it; a single
      // alternating diagonal deeper in, where it only has to read as depth.
      for (let i = 0; i + 1 < nCol; i++) {
        const xa = colX(i), xb = colX(i + 1);
        const yb = plinth + (top - plinth) * 0.92;
        s.tube(xa, plinth + 0.18, cz, xb, yb, cz, 0.075, 4, STEEL_D, 0.62);
        if (l === 0 || i % 2 === 0) {
          s.tube(xb, plinth + 0.18, cz, xa, yb, cz, 0.075, 4, STEEL_D, 0.58);
        }
      }
    }
    for (let i = 0; i < nCol; i += 2) {
      for (let l = 0; l + 1 < lineZ.length; l++) {
        const ya = soffitAt(lineZ[l]) - 0.5, yb = soffitAt(lineZ[l + 1]) - 0.5;
        s.tube(colX(i), ya, lineZ[l], colX(i), yb, lineZ[l + 1], 0.065, 4, STEEL_D, 0.55);
      }
    }

    // ---- aisles: stepped, with kerb cheeks and a handrail -------------------
    for (const ax of standAisleXs(W, o.aisles)) {
      const aw = STAND_AISLE_HW - 0.17;
      const ap: ProfilePt[] = [{ z: zF, y: y0 + 0.03, hex: DECK, shade: 1.1 }];
      for (let r = 1; r <= R; r++) {
        const zb = zRowBack(r - 1);
        const yn = r < R ? yRow(r) : yWalk;
        // The riser sits 3 cm in front of the bench it steps over, so the two
        // are never coplanar; the aisle tread clears the bench top by 0.5 m.
        ap.push({ z: zb + 0.37, y: yRow(r - 1) + 0.03, hex: RISER, shade: 0.84 });
        ap.push({ z: zb + 0.37, y: yn - 0.07, hex: CONCRETE, shade: 1.14 });
        ap.push({ z: zb + 0.27, y: yn + 0.03, hex: DECK, shade: 1.1 });
      }
      ap.push({ z: zWalk, y: yWalk + 0.03, hex: DECK, shade: 1.06 });
      b.extrudeX(ap, ax - aw, ax + aw, DECK);

      const cheek: ProfilePt[] = [
        { z: zF, y: y0 - 1.05, hex: RISER, shade: 0.78 },
        { z: zF, y: y0 + 0.37, hex: DECK, shade: 1.18 },
        { z: zWalk, y: yWalk + 0.37, hex: CONCRETE, shade: 0.96 },
        { z: zWalk, y: yWalk - 1.05, hex: SOFFIT, shade: 0.6 },
        { z: zF, y: y0 - 1.05, hex: RISER, shade: 0.78 },
      ];
      b.extrudeX(cheek, ax - aw - 0.14, ax - aw, RISER, { caps: true, shade: 0.96 });
      b.extrudeX(cheek, ax + aw, ax + aw + 0.14, RISER, { caps: true, shade: 0.96 });
      this.rakeRail(s, ax + aw + 0.07, zF, y0 + 0.37, zWalk, yWalk + 0.37, 0.72, 5, STEEL);
    }

    // ---- railings -----------------------------------------------------------
    this.railX(s, -hw + 0.5, hw - 0.5, barrier, (bz - 0.13 + zF + 0.13) * 0.5,
      0.52, 6.2, STEEL);
    // Rear walkway rail sits at the walkway's front edge, i.e. behind the last
    // bench, which is where a real stand stops people stepping off the top row.
    this.railX(s, -hw + 0.5, hw - 0.5, yWalk + 0.03, zWalk + 0.95, 0.62, 7.5, STEEL);

    // ---- stair towers -------------------------------------------------------
    for (const sx of [-1, 1]) {
      const tx = sx * (hw + 1.62);
      const tz = (bz + zWalk) * 0.5 + 1.4;
      b.prism(tx, plinth - 0.1, tz, 1.55, yWalk - plinth + 0.3, 8, CONCRETE,
        { capTop: false, yaw: Math.PI / 8, taper: 0.94, shade: { side: 0.94 } });
      b.extrudeX([
        { z: tz + 1.62, y: yWalk + 0.2, hex: DECK, shade: 1.0 },
        { z: tz + 1.62, y: yWalk + 0.46, hex: DECK, shade: 1.12 },
        { z: tz + 1.44, y: yWalk + 0.62, hex: TRIM, shade: 1.24 },
        { z: tz - 1.44, y: yWalk + 0.62, hex: TRIM, shade: 1.16 },
        { z: tz - 1.62, y: yWalk + 0.46, hex: DECK, shade: 0.92 },
        { z: tz - 1.62, y: yWalk + 0.2, hex: DECK, shade: 0.86 },
        // Closed: you look up at this slab from the track, so it needs a soffit.
        { z: tz + 1.62, y: yWalk + 0.2, hex: SOFFIT, shade: 0.5 },
      ], tx - 1.74, tx + 1.74, DECK, { caps: true });
      // Doorway, and a stair band climbing the road-facing face.
      b.plate(tx, plinth + 1.1, tz + 1.58, 1.25, 2.2, 0, 0x2b3038, { single: true });
      for (let k = 0; k < 5; k++) {
        b.box(tx, plinth + 0.6 + k * 1.5, tz + 1.6, 1.3, 0.09, 0.12, DECK,
          { shade: { top: 1.24 } });
      }
    }

    // ---- roof ---------------------------------------------------------------
    if (o.roofed) {
      const nT = clamp(Math.round(W / 18) + 1, 3, 6);
      const topY = (t: number): number => yRidge + (yEave - yRidge) * t;
      const botY = (t: number): number => (yRidge - 1.45) + ((yEave - 0.55) - (yRidge - 1.45)) * t;
      const chordZ = (t: number): number => zMast + (zEave - zMast) * t;
      for (let i = 0; i < nT; i++) {
        const x = (i / (nT - 1) - 0.5) * (W - 3.0);
        s.prism(x, yMast, zMast, 0.32, yRidge - yMast, 6, STEEL,
          { capTop: true, shade: { side: 0.96 } });
        s.tube(x, yRidge, zMast, x, yEave, zEave, 0.15, 5, STEEL, 1.04);
        s.tube(x, yRidge - 1.45, zMast, x, yEave - 0.55, zEave, 0.12, 5, STEEL, 0.86);
        // Warren web: alternating diagonals plus two verticals. This is the
        // detail that says "structure" rather than "slab on sticks".
        for (let k = 0; k < 5; k++) {
          const t0 = k / 5, t1 = (k + 1) / 5;
          const ya = k % 2 === 0 ? topY(t0) : botY(t0);
          const yb = k % 2 === 0 ? botY(t1) : topY(t1);
          s.tube(x, ya, chordZ(t0), x, yb, chordZ(t1), 0.07, 4, STEEL_D, 0.84);
        }
        for (const t of [0.4, 0.8]) {
          s.tube(x, topY(t), chordZ(t), x, botY(t), chordZ(t), 0.06, 4, STEEL_D, 0.76);
        }
      }
      // Purlins: the underside is what you see from the track, so it gets ribs.
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        s.tube(-hw - 0.6, topY(t) - 0.17, chordZ(t), hw + 0.6, topY(t) - 0.17, chordZ(t),
          0.09, 4, STEEL, 0.92);
      }
      s.extrudeX([
        { z: zEave, y: yEave - 0.62, hex: TRIM, shade: 1.0 },
        { z: zEave, y: yEave - 0.14, hex: TRIM, shade: 1.14 },
        { z: zEave - 0.16, y: yEave, hex: 0xf4eee0, shade: 1.22 },
        { z: zMast - 0.5, y: yRidge, hex: 0xe8e2d4, shade: 1.02 },
        { z: zMast - 0.5, y: yRidge - 0.34, hex: SOFFIT, shade: 0.44 },
        { z: zEave, y: yEave - 0.62, hex: TRIM, shade: 1.0 },
      ], -hw - 0.7, hw + 0.7, 0xf4eee0, { caps: true });
    }

    // ---- signage ------------------------------------------------------------
    // Sponsor band across the barrier's outer face, one atlas cell per board so
    // the run reads as different names instead of one logo stretched 78 m.
    const bandTop = barrier - 0.16, bandBot = soffitF + 0.1;
    const boards = clamp(Math.round(W / 4.2), 3, 24);
    for (let i = 0; i < boards; i++) {
      const bwd = W / boards;
      g.plate(-hw + (i + 0.5) * bwd, (bandTop + bandBot) * 0.5, bz + 0.03,
        bwd * 0.94, bandTop - bandBot, 0, 0xffffff,
        { single: true, uvRect: atlasRect(i * 3 + o.variant) });
    }
    if (o.roofed) {
      const nF = clamp(Math.round(W / 9), 2, 9);
      for (let i = 0; i < nF; i++) {
        g.plate(((i + 0.5) / nF - 0.5) * (W - 2.4), yEave - 0.38, zEave + 0.04,
          1.15, 0.5, 0, 0xffffff, { single: true, uvRect: atlasRect(i * 5 + 1) });
      }
    }

    const tag = `${R}x${Math.round(W)}${o.roofed ? 'r' : ''}`;
    return {
      body: b.build(`stand:${tag}`),
      steel: s.build(`standSteel:${tag}`),
      sign: g.build(`standSign:${tag}`),
      top: o.roofed ? yRidge : yWall + 0.16,
    };
  }

  /** Straight railing along X: two rails plus posts every `every` metres. */
  private railX(
    s: Builder, x0: number, x1: number, y: number, z: number,
    h: number, every: number, hex: number,
  ): void {
    const n = Math.max(2, Math.round((x1 - x0) / every) + 1);
    for (let i = 0; i < n; i++) {
      s.prism(x0 + (x1 - x0) * (i / (n - 1)), y, z, 0.05, h, 4, hex,
        { capTop: false, yaw: 0.7 });
    }
    s.tube(x0, y + h, z, x1, y + h, z, 0.05, 5, hex, 1.06);
    s.tube(x0, y + h * 0.55, z, x1, y + h * 0.55, z, 0.036, 4, hex, 0.92);
  }

  /** Railing following an aisle rake, in the plane x = const. */
  private rakeRail(
    s: Builder, x: number, za: number, ya: number, zb: number, yb: number,
    h: number, posts: number, hex: number,
  ): void {
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      s.prism(x, ya + (yb - ya) * t, za + (zb - za) * t, 0.05, h, 4, hex,
        { capTop: false, yaw: 0.7 });
    }
    s.tube(x, ya + h, za, x, yb + h, zb, 0.05, 5, hex, 1.06);
    s.tube(x, ya + h * 0.55, za, x, yb + h * 0.55, zb, 0.036, 4, hex, 0.92);
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

    // --- city dressing ---------------------------------------------------
    // Everything from here down was authored by TrackDefs and had NO alias, so
    // `collectAuthored` dropped it on the floor with one console.info. That cost
    // Neon Metropolis 17 of its 25 authored placements and Volcano 14 of 21 —
    // i.e. two of the three circuits were missing two thirds of their scenery,
    // which is most of why they read as bare next to the coastal track (0 lost).
    // Six of these keys were already listed in CORRIDOR_PROPS and `holoAd` in
    // Track's SPANS_THE_ROAD, so the placement plumbing was waiting for them.
    case 'skyscraper': case 'tower': return 'skyscraper';
    case 'towerblock': case 'apartmentblock': case 'block': return 'towerblock';
    case 'arcologytower': case 'arcology': case 'megatower': return 'arcologytower';
    case 'alleyblock': case 'alley': case 'backlot': return 'alleyblock';
    case 'neonsign': case 'neon': return 'neonsign';
    case 'hoload': case 'hologram': case 'holo': return 'hoload';
    case 'billboard': case 'hoarding': return 'billboard';
    case 'energypylon': case 'energymast': return 'energypylon';
    case 'agpylon': case 'antigravpylon': case 'agmast': return 'agpylon';
    case 'monorailpylon': case 'monorail': return 'monorailpylon';
    case 'bridgepylon': case 'flyoverpylon': case 'deckpylon': return 'bridgepylon';
    case 'spiralpylon': case 'helixpylon': return 'spiralpylon';
    case 'trafficlight': case 'signal': case 'stoplight': return 'trafficlight';
    case 'ventstack': case 'vent': case 'roofvent': case 'chimney': return 'ventstack';
    case 'barrelstack': case 'barrels': case 'drumstack': return 'barrelstack';

    // --- volcano dressing ------------------------------------------------
    case 'basaltcolumn': case 'basalt': case 'columncluster': return 'basaltcolumn';
    case 'deadtree': case 'burnttree': case 'snag': return 'deadtree';
    case 'ashplume': case 'ashcolumn': case 'smokeplume': return 'ashplume';
    case 'lavafountain': case 'lavaspout': case 'lavajet': return 'lavafountain';
    case 'lavarock': case 'magmarock': case 'emberrock': return 'lavarock';
    case 'obsidianspire': case 'obsidian': case 'glassspire': return 'obsidianspire';
    case 'warningpost': case 'hazardpost': case 'warningmarker': return 'warningpost';
    default: return null;
  }
}
