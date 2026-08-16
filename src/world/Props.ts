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
// The single definition of "how dark is this circuit", owned by Sky. Consumed,
// never written — see `nightFactorFor` for why the argument is the decoration
// hint rather than the live `worldRegistry.sky`.
import { SKY_PRESETS, skyNightFactor } from './Sky';
import {
  InstanceChunks, canvasTexture, makeDetailNormal, roadVerge, worldRegistry,
  type PathStation, type RoadVerge, type TerrainField, type WorldContext, type WorldTheme,
} from './WorldTextures';
// The shared procedural texture library (AGENTS.md section 4). Only the two
// primitives the facade sets need: a Sobel height->normal and a float->greyscale
// upload, so the facade albedo / roughness / normal stay exactly registered.
import { floatToTexture, heightToNormal, makeRock } from '@/render/TextureFactory';
// The one thing the world dresser needs from the track layer: the volumes the
// road builds around itself (tunnel bores, bridge decks, anti-gravity tubes).
// Published module-level by `buildTrack()` because `Environment` constructs the
// dresser and never hands it a `Track`. See the ROAD VOLUMES block there.
import {
  CROSS, ROAD_VOLUME_SHELL, roadVolumePenetration, roadVolumes,
} from '@/track/TrackBuilder';

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
   * Set by the carriageway guard in `emit()`. Memoised for exactly the reason
   * `blocked` is: the companion passes (glow, cloth, metal, sign) share the
   * anchor array with the body, and the body is emitted first, so the verdict
   * has to come from the full silhouette. Without this, a shard cluster would be
   * dropped and its glow left standing on the racing line.
   */
  onRoad?: boolean;
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
// The carriageway guard keeps its own scratch. `emit()`'s `o.place` callbacks
// compose into `_m` and freely use `_v` / `_q` / `_s` while doing it, so the
// guard cannot borrow those without clobbering a transform mid-build.
const _roadV = new THREE.Vector3();
const _roadQ = new THREE.Quaternion();
const _roadS = new THREE.Vector3();
const _roadM = new THREE.Matrix4();
const _roadDir = new THREE.Vector3();
/** Eight world-space box corners, xyz interleaved. */
const _roadCorners = new Float64Array(24);

/**
 * One resolved cross-section of the DRAWN carriageway, in world space — the
 * surface a prop that straddles the road has to meet. See `deckFrameAt`.
 */
interface DeckFrame {
  /** Centreline at road-surface level. */
  p: THREE.Vector3;
  /** Unit BANKED binormal (driver's right), so `p + b*lat` follows the camber. */
  b: THREE.Vector3;
  /** Unit surface normal, carrying both bank and grade. */
  n: THREE.Vector3;
  hw: number;
  shL: number;
  shR: number;
  ok: boolean;
}

const _deck: DeckFrame = {
  p: new THREE.Vector3(), b: new THREE.Vector3(1, 0, 0), n: new THREE.Vector3(0, 1, 0),
  hw: 11, shL: 3, shR: 3, ok: false,
};

/**
 * Shoulder width assumed when a `PathStation` does not publish one. Same value
 * and same reasoning as `WorldTextures.SH_FALLBACK`: guessing too WIDE puts a
 * prop on ground that is not there, too NARROW puts it slightly inboard where
 * there is certainly surface, so err narrow.
 *
 * This is now genuinely a fallback. It used to be the ONLY path: no producer
 * published a shoulder, so every station on every circuit resolved to 3 m —
 * which is how a bridge girder ended up 1.5 m outboard of the deck it stands
 * on. `Environment.stationFrom()` publishes the authored value now, and the
 * only producer that still lands here is `demoCircuit()`, the invented circuit
 * used when a track cannot answer at all.
 */
const SH_FALLBACK = 3;

/**
 * A zero-length frame, used once at the end of `init()` to pose the CPU-animated
 * props (see `poseMotionProps`). `dt = 0` advances no animation state, so the
 * transform written is exactly the one `update()` would write on its first call.
 */
const POSE_FRAME: FrameContext = { dt: 0, fixedDt: 0, elapsed: 0, frame: 0, alpha: 0 };

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
      // ---- THE BACK FACE READ MIRRORED. -----------------------------------
      // The intent below was right and the arithmetic double-negated it. Seen
      // from local -Z the viewer's right IS local -x, so the back face does want
      // u to run the other way along +x — but the corner order is ALREADY
      // reversed here (p1 first, not p0), and `quad()` assigns its rect relative
      // to the corner order it is given: `a -> (r0,r1)`, `b -> (r2,r1)`. Reversing
      // the corners AND reversing the range cancels out, so the back face was
      // emitted with u ascending along +x exactly like the front face, i.e.
      // mirrored. Passing the SAME range as the front face is what mirrors it,
      // because `a` is now the +x corner.
      //
      // The invariant to check, and the one `.probe-tmp/mirror.ts` asserts per
      // triangle: `cross(du/dp, dv/dp)` must point the same way as the winding
      // normal. Front face: du/dp = +x, dv/dp = +y, cross = +Z = its normal. Back
      // face with this range: du/dp = -x, dv/dp = +y, cross = -Z = its normal.
      // Both pass; the old range gave the back face cross = +Z against a -Z
      // normal. That is view-independent and therefore testable headlessly.
      this.quad(p1[0], p1[1], p1[2], p0[0], p0[1], p0[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2],
        hex, shade * 0.8, [uv[0], uv[3], uv[2], uv[1]]);
    }
  }

  /**
   * Hanging cloth with vertical segments so the wind wave has something to bend.
   *
   * ---- WHY `double` EXISTS, AND WHY THE START-LINE BANNERS WERE MIRRORED ----
   * This emits ONE sheet, wound and uv'd to be read from local +Z. That is right
   * for a `standBanner`, because a grandstand is yawed by convention 1 (local +Z
   * points AT the road — see the PROP ORIENTATION block in Track.ts) so the +Z
   * sheet faces the driver.
   *
   * It is exactly wrong for anything yawed by convention 2. A gate — gantry,
   * arch, portal — is yawed so local **+Z follows the TANGENT**, i.e. down-track,
   * *away* from a driver approaching it; `tunnelportal`'s recipe says so in as
   * many words ("local -Z is the face the driver sees"). The two start-line
   * banners had only a +Z sheet, and `prop-atlas-cloth` is `DoubleSide`, so the
   * approaching driver was shown the BACK of that sheet and read every wordmark
   * and the caption under it in mirror image. Nothing was wrong with the atlas,
   * the u axis or the caption draw — the identical `banner()` call on the
   * grandstand read correctly in the same frame, which is the proof.
   *
   * `double` adds a second sheet `gap` metres toward -Z with the winding AND the
   * u direction both reversed, so each side reads correctly from its own side and
   * neither depends on which way the prop happens to be yawed. Real trackside
   * banners are printed both sides anyway. Cost is 2x the sheet's triangles on a
   * handful of instances.
   */
  banner(
    cx: number, cy: number, cz: number,
    w: number, h: number, yaw: number, hex: number,
    segs = 4, uvRect?: [number, number, number, number],
    opts: { double?: boolean; gap?: number; wave?: number } = {},
  ): void {
    const uv = uvRect ?? [0, 0, 1, 1];
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    // In-plane axes are U = (ca, 0, sa) and world +Y, so the sheet's outward
    // normal is U x Y = (-sa, 0, ca) — which is (0,0,1) at yaw 0, matching the
    // literal that used to be written here, but is correct at every other yaw too.
    const nx = -sa, nz = ca;
    const gap = opts.gap ?? 0.016;
    /**
     * Rest-pose slack along the sheet normal, metres — see `mastCloth.wave` for
     * why a cloth needs a shape it is not animated into. Here the anchored edge
     * is the TOP, so the belly grows downward as `fy^1.4` and undulates across
     * the span: a hung banner bows between its fixings and lifts at the hem.
     */
    const wave = opts.wave ?? 0;
    const sheet = (side: 1 | -1): void => {
      const base = this.vertexCount;
      const stride = segs + 1;
      const ox = side < 0 ? -nx * gap : 0;
      const oz = side < 0 ? -nz * gap : 0;
      for (let j = 0; j <= segs; j++) {
        const fy = j / segs;            // 0 = top (anchored), 1 = bottom
        this.flap = fy * fy;
        for (let i = 0; i <= segs; i++) {
          const fx = i / segs;
          const lx = (fx - 0.5) * w;
          const y = cy - fy * h;
          // Slack, plus its two derivatives, so the shading follows the shape
          // instead of staying flat-sheet — the section 0 failure.
          const th = Math.PI * 1.45 * fx + 0.7 * fy;
          const fyw = fy ** 1.4;
          const d = wave * fyw * Math.sin(th);
          const dFx = wave * fyw * Math.cos(th) * Math.PI * 1.45;
          const dFy = wave * (fy <= 0 ? 0 : 1.4 * fy ** 0.4) * Math.sin(th)
            + wave * fyw * Math.cos(th) * 0.7;
          // t1 = U*w + N*dFx (along +x), t2 = -Y*h + N*dFy; normal = t2 x t1.
          const t1x = ca * w + nx * dFx, t1z = sa * w + nz * dFx;
          const t2x = nx * dFy, t2y = -h, t2z = nz * dFy;
          let vnx = t2y * t1z;
          let vny = t2z * t1x - t2x * t1z;
          let vnz = -t2y * t1x;
          const vl = Math.hypot(vnx, vny, vnz) || 1;
          vnx = (vnx / vl) * side; vny = (vny / vl) * side; vnz = (vnz / vl) * side;
          // u runs uMin -> uMax as lx goes -w/2 -> +w/2 on the +Z sheet, exactly
          // as in `plate()`'s front face — see the long note on the u axis there.
          // A viewer of that face sees local +x on their right, so u must grow
          // with +x. The -Z sheet's viewer sees +x on their LEFT, so its u runs
          // the other way; `1 - fx` is that mirror.
          const fu = side > 0 ? fx : 1 - fx;
          this.vert(cx + lx * ca + ox + nx * d, y, cz + lx * sa + oz + nz * d,
            vnx, vny, vnz,
            uv[0] + (uv[2] - uv[0]) * fu, uv[1] + (uv[3] - uv[1]) * fy, hex, 1);
        }
      }
      this.flap = 0;
      for (let j = 0; j < segs; j++) {
        for (let i = 0; i < segs; i++) {
          const a = base + j * stride + i;
          if (side > 0) this.I.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
          else this.I.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
        }
      }
    };
    sheet(1);
    if (opts.double) sheet(-1);
  }

  /**
   * Cloth bent onto a MAST: anchored along its left edge, free at the right.
   *
   * The national flags used `plate(..., { flapAcross: true })`, which emits four
   * vertices and two triangles with `aFlap` = 0 at the mast edge and 1 at the free
   * edge. The sway shader displaces each vertex by `aFlap · g`, and with no
   * interior vertices there is nothing between 0 and 1 — so the whole panel
   * translated as one rigid board. A 2.7 x 1.8 m flat quad swinging stiffly reads
   * as a painted signboard, not cloth, which is what the owner was asking about
   * when they asked whether the flags were properly there. (They were present and
   * double-sided; they just could not ripple.)
   *
   * Same construction as `banner()`, with the anchor rotated 90 degrees: `aFlap`
   * grades along X instead of Y, squared so the motion stays near the free edge
   * rather than shearing the whole panel, and a couple of rows in Y so the wave
   * has a diagonal to run along. 36 triangles instead of 2, on a handful of
   * instances per circuit.
   */
  mastCloth(
    cx: number, cy: number, cz: number,
    w: number, h: number, yaw: number, hex: number,
    cols = 6, rows = 3, uvRect?: [number, number, number, number],
    opts: {
      double?: boolean; gap?: number; bow?: number;
      /**
       * Depth of the REST-POSE ripple along the sheet normal, metres.
       *
       * ---- WHY A FLAG NEEDS SHAPE IT IS NOT ANIMATED INTO -------------------
       * The wave in `patchProp` is a sine of `uTime`, so twice a cycle it passes
       * through zero and the flag is drawn EXACTLY as authored. Authored flat,
       * that is a rectangle, twice a second, and the eye reads the rectangle
       * rather than the motion. Measured on `flagusa` before this existed: max
       * deviation from the panel's own best-fit plane was 0.4 % of its height —
       * a plane to within 7 mm over 2.7 m. That, and not a frozen uniform, is
       * the owner's *"visually appearing stiff like panels"*: `uTime` was
       * advancing the whole time (verified over 240 frames of the real
       * `Environment.update`, `.probe-tmp/flagmotion.ts`).
       *
       * The ripple is a travelling crease baked into the geometry: it grows as
       * `fx^1.6` so the hoist stays flat against the mast, and it is skewed down
       * the panel by `WAVE_SKEW` so the crease runs diagonally instead of
       * standing as a vertical corrugation.
       */
      wave?: number;
      /** How far the fly end hangs under its own weight, metres. */
      sag?: number;
      /**
       * Per-cell colour. When present each cell gets its own four vertices
       * instead of sharing them, which is what a checkerboard needs; the surface
       * and the normals are the same functions either way, so a checkered flag
       * and a plain one cannot end up different shapes.
       */
      cellHex?: (i: number, j: number) => number;
    } = {},
  ): void {
    const uv = uvRect ?? [0, 0, 1, 1];
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    // See `banner()`: the sheet's outward normal is U x Y = (-sa, 0, ca). This
    // used to be written as the literal (0, 0, 1), which is only correct at
    // yaw 0 — and `flagpole` builds its pennant at `rng.range(0, 6.28)`, so every
    // roadside pennant in the game was lit off a normal up to 180 degrees out.
    const nx = -sa, nz = ca;
    const gap = opts.gap ?? 0.014;
    /**
     * Camber, metres. A sail is not a flat sheet: it bellies away from the chord,
     * deepest around a third of the way aft. `sin(pi * fx) ** 1.35` is that
     * profile with the maximum pulled forward, and it is applied along the sheet's
     * own normal so it works at any yaw.
     */
    const bow = opts.bow ?? 0;
    const wave = opts.wave ?? 0;
    const sag = opts.sag ?? 0;
    /** Ripples across the fly, in half-cycles. */
    const WAVE_K = 1.65;
    /** ...leaned down the panel, so the crease is diagonal, not a corrugation. */
    const WAVE_SKEW = 0.85;
    const cell = opts.cellHex;

    /** Offset along the sheet normal, and its two partial derivatives. */
    const shape = (fx: number, fy: number): [number, number, number, number, number, number] => {
      const A = Math.sin(Math.PI * fx) ** 1.35;
      const B = Math.sin(Math.PI * (0.15 + fy * 0.7));
      const dA = fx <= 0 || fx >= 1 ? 0
        : 1.35 * Math.sin(Math.PI * fx) ** 0.35 * Math.PI * Math.cos(Math.PI * fx);
      const th = Math.PI * WAVE_K * fx + WAVE_SKEW * fy;
      const fx16 = fx ** 1.6;
      const d = bow * A * B + wave * fx16 * Math.sin(th);
      const dFx = bow * dA * B
        + wave * (1.6 * (fx <= 0 ? 0 : fx ** 0.6) * Math.sin(th)
          + fx16 * Math.cos(th) * Math.PI * WAVE_K);
      const dFy = bow * A * 0.7 * Math.PI * Math.cos(Math.PI * (0.15 + fy * 0.7))
        + wave * fx16 * Math.cos(th) * WAVE_SKEW;
      // Droop: nothing at the hoist, most at the fly's bottom corner.
      const wgt = 0.45 + 0.55 * fy;
      const sD = sag * fx ** 1.8 * wgt;
      const sFx = sag * 1.8 * (fx <= 0 ? 0 : fx ** 0.8) * wgt;
      const sFy = sag * fx ** 1.8 * 0.55;
      return [d, dFx, dFy, sD, sFx, sFy];
    };

    /** One vertex of the surface, with its analytic normal. */
    const put = (fx: number, fy: number, side: 1 | -1, hexAt: number): void => {
      // Squared along the length so the hoist stays put and the fly end moves,
      // with a small extra lift toward the bottom corner — that asymmetry is
      // what stops the ripple looking like a flat pendulum.
      this.flap = fx * fx * (0.82 + 0.18 * fy);
      const [d, dFx, dFy, sD, sFx, sFy] = shape(fx, fy);
      const off = (side < 0 ? -gap : 0) + d;
      // The rest shape has to reach the NORMALS as well as the positions, or a
      // rippled flag is shaded as the flat sheet it no longer is — which is the
      // section 0 failure this replaced in the first place. Surface is
      //   p(fx,fy) = C + U*fx*w - Y*(fy*h + s) + N*d
      // so t1 = U*w + N*dFx - Y*sFx and t2 = N*dFy - Y*(h + sFy), and `t2 x t1`
      // is the outward normal. With d = s = 0 it reduces to (-sa, 0, ca), i.e.
      // the flat sheet's normal — which is the check that the general cross
      // product below did not silently invert anything.
      const t1x = ca * w + nx * dFx, t1y = -sFx, t1z = sa * w + nz * dFx;
      const t2x = nx * dFy, t2y = -(h + sFy), t2z = nz * dFy;
      let vnx = t2y * t1z - t2z * t1y;
      let vny = t2z * t1x - t2x * t1z;
      let vnz = t2x * t1y - t2y * t1x;
      const vl = Math.hypot(vnx, vny, vnz) || 1;
      vnx = (vnx / vl) * side; vny = (vny / vl) * side; vnz = (vnz / vl) * side;
      // u grows with local +x on the +Z sheet, matching `plate()`'s front face
      // — see the u-axis note there. The -Z sheet mirrors it, exactly as
      // `banner()` does and for the same reason.
      const fu = side > 0 ? fx : 1 - fx;
      const lx = fx * w;
      this.vert(cx + lx * ca + nx * off, cy - (fy * h + sD), cz + lx * sa + nz * off,
        vnx, vny, vnz,
        uv[0] + (uv[2] - uv[0]) * fu, uv[1] + (uv[3] - uv[1]) * fy, hexAt, 1);
    };

    const sheet = (side: 1 | -1): void => {
      if (cell) {
        // Unshared cells, for a checkerboard.
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const base = this.vertexCount;
            const hx = cell(i, j);
            put(i / cols, j / rows, side, hx);
            put((i + 1) / cols, j / rows, side, hx);
            put(i / cols, (j + 1) / rows, side, hx);
            put((i + 1) / cols, (j + 1) / rows, side, hx);
            if (side > 0) this.I.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
            else this.I.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
          }
        }
        this.flap = 0;
        return;
      }
      const base = this.vertexCount;
      const stride = cols + 1;
      for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) put(i / cols, j / rows, side, hex);
      }
      this.flap = 0;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const a = base + j * stride + i;
          if (side > 0) this.I.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
          else this.I.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
        }
      }
    };
    sheet(1);
    if (opts.double) sheet(-1);
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
  /**
   * Hash threshold above which a window pane counts as LIT, so the same window
   * geometry can be 25 % lit at dusk and 72 % lit at midnight. Used to be the
   * constant 0.42 baked into the shader, which is how a `skyPreset: 'day'`
   * circuit ended up with 68 towers full of `#ffffff` windows at midday.
   */
  uWinLit: THREE.IUniform<number>;
}

type PatchOpts = {
  /** Cloth / balloon motion driven by aFlap. */
  sway?: number;
  /**
   * Out-of-plane VERTICAL component of the cloth wave, metres per unit of `amp`.
   *
   * Without it the sway block moves a cloth in one horizontal direction only, so
   * however finely the panel is subdivided it reads as corrugated card sliding
   * sideways. Measured on `flagusa` before this existed: the fly edge's whole
   * peak-to-peak excursion was 0.229 m on a 2.7 x 1.8 m flag, all of it in a
   * single plane.
   */
  curl?: number;
  /** Bob up and down (balloons). */
  bob?: number;
  /** Per-instance atlas sub-rect from aAtlas. */
  atlas?: boolean;
  /** Per-window lit/unlit + flicker written into vLit. */
  windows?: boolean;
  /** Multiply emissive by the vertex colour (and vLit if windows). */
  emissiveVertexColor?: boolean;
  /**
   * DAYLIGHT GLASS. Same `windows` hash, but it modulates the DIFFUSE instead of
   * the emissive, so a pane reads as a lighter or darker sheet of glass in a
   * reflective curtain wall rather than as a light source. This is the material a
   * `skyPreset: 'day'` circuit gets; `windows` is for dusk and night.
   */
  litDiffuse?: boolean;
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
    shader.uniforms.uWinLit = u.uWinLit;

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
        uniform float uWinLit;
        ${opts.windows || opts.litDiffuse ? 'varying float vLit;' : ''}
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
          // The -aFlap terms are what make the wave TRAVEL. Without them g varied
          // only with time and the instance origin, so every vertex of a cloth
          // moved in lockstep and the panel translated rigidly no matter how
          // finely it was subdivided -- a flag read as a swinging signboard. The
          // phase now lags with distance from the anchor, which turns the same
          // displacement into a ripple running out to the free edge. Cloths whose
          // aFlap is only ever 0 or 1 (banner end rows, balloons) see a constant
          // phase offset and are visually unchanged.
          float g = sin(uTime * 2.3 + ph + apxOrigin.x * 0.07 - aFlap * 2.6)
                  + 0.45 * sin(uTime * 5.1 + ph * 1.7 - aFlap * 4.1);
          float amp = aFlap * uWind * ${opts.sway.toFixed(3)};
          // ---- THE FLUTTER RUNS ACROSS THE CLOTH'S OWN FACE. ----------------
          // NOTE FOR EDITORS: this whole block is inside a JS template literal.
          // A backtick in a comment here ENDS THE STRING, and the file then fails
          // to parse in a way that points at the GLSL rather than at the quote.
          // It used to displace by uWindDir directly: a WORLD direction applied in
          // OBJECT space, so how much of it was visible depended on the angle
          // between the wind and the sheet. A cloth edge-on to the wind got its
          // whole displacement along its own span, which is a stretch, not a
          // flutter, and looks like nothing at all. Two live cases:
          //   the roadside pennant is built at a random builder yaw, so its face
          //   direction is a per-instance lottery and some barely moved;
          //   THEME_WIND gives snow a direction of 3.3 rad, whose sine is -0.16,
          //   which would freeze every cloth on such a circuit to a sixth of its
          //   amplitude. No shipping circuit is snow today. That is luck.
          // objectNormal is in scope here: three fills it in beginnormal_vertex,
          // which runs before begin_vertex. Flattening it into XZ and flipping it
          // to agree with the wind gives BOTH sheets of a doubled cloth the SAME
          // world displacement (normal +Z with sign +1, and normal -Z with sign
          // -1, are the same vector), so the two layers cannot peel apart.
          vec3 apxFace = vec3(objectNormal.x, 0.0, objectNormal.z);
          float apxFl = length(apxFace);
          vec3 apxWind = vec3(uWindDir.x, 0.0, uWindDir.y);
          apxFace = apxFl > 1e-4 ? apxFace / apxFl : apxWind;
          apxFace *= dot(apxWind, apxFace) >= 0.0 ? 1.0 : -1.0;
          transformed.x += apxFace.x * g * amp;
          transformed.z += apxFace.z * g * amp;
          transformed.y -= abs(g) * amp * 0.25;${opts.curl ? `
          // A flag does not swing in a plane: the fly end lifts and drops out of
          // phase with the sideways ripple, which is what turns a corrugated
          // sheet into cloth. Same aFlap taper, so the hoist stays pinned.
          float gy = sin(uTime * 1.910 + ph * 1.310 + apxOrigin.x * 0.070 - aFlap * 3.770);
          transformed.y += gy * amp * ${opts.curl.toFixed(3)};` : ''}
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
          float lit = step(uWinLit, h);
          // A few windows flicker; most are steady.
          float fl = step(0.94, h);
          float blink = mix(1.0, 0.35 + 0.65 * step(0.5, fract(uTime * (0.7 + h) + h * 10.0)), fl);
          vLit = lit * blink * (0.55 + 0.75 * apxHash(aCell * 7.71 + aPhase * 11.3));
        }` : ''}
        ${opts.litDiffuse ? `
        {
          // No emissive term at all: this is the per-pane VALUE variation that
          // makes a daylight curtain wall read as glass. Same hash as the night
          // material so a pane that is lit after dark is the bright pane by day.
          float h = apxHash(aCell * 3.13 + aPhase * 57.7);
          vLit = 0.45 + 0.9 * h;
        }` : ''}
      `);

    if (opts.atlas) {
      // ---- `fract()` COLLAPSED EVERY HAND-WRITTEN 0..1 CELL RECT. ------------
      // `fract(1.0)` is 0.0. Three text-bearing recipes authored their cell rect
      // as literal `[0,0,1,1]` / `[0,1,1,0]` (gantryBanner, holoAdSign,
      // billboardSign) rather than through `atlasRect()`, which insets by 0.006.
      // Both ends of both axes therefore mapped to the SAME value — the panel's
      // whole uv range degenerated to one point and every one of those panels
      // rendered as a single flat texel of a sponsor cell. That is the "large flat
      // red panel" reported over the volcano circuit: `billboard`'s 8.8 x 4.9 m
      // face reduced to the corner colour of whatever cell its seed picked.
      // `clamp` cannot do that; the callers now inset with `CELL_FULL` as well, so
      // a linear filter cannot reach into the neighbouring cell either.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>', /* glsl */ `
        #include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = aAtlas.xy + clamp(vMapUv, 0.0, 1.0) * aAtlas.zw;
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
    } else if (opts.litDiffuse) {
      // `<color_fragment>` is where three folds vColor into diffuseColor, so this
      // lands after it and before lighting — a straight albedo modulation.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vLit;')
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\ndiffuseColor.rgb *= vLit;',
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
    `apxprop|${opts.sway ?? 0}|${opts.bob ?? 0}|${opts.atlas ? 1 : 0}|${opts.windows ? 1 : 0}`
    + `|${opts.emissiveVertexColor ? 1 : 0}|${opts.litDiffuse ? 1 : 0}`;
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

export const SPONSORS: readonly Sponsor[] = [
  { lines: ['CAPY', 'LAB'], bg: '#1d6f63', fg: '#f6efdd', weight: 0.4 },
  { lines: ['NITRO'], bg: '#141821', fg: '#ffd23f', weight: 1 },
  { lines: ['TURBO'], bg: '#0f6bd6', fg: '#ffffff', weight: 1 },
  { lines: ['GRIP'], bg: '#1f9e57', fg: '#0c1410', weight: 1 },
  { lines: ['VOLT'], bg: '#7a2ed6', fg: '#f2e9ff', weight: 1 },
  { lines: ['TINY TRIP', 'CLUB'], bg: '#e4573c', fg: '#fff4e2', weight: 0.4 },
  { lines: ['DRIFT'], bg: '#0d1b2a', fg: '#4fd6ff', weight: 1 },
  // ---- P0e. The owner asked for the two start-line banners to read CAPY LAB and
  // FOXY KART. CAPY LAB is cell 0 already; this cell was the anonymous wordmark
  // "KART", which is the championship's own name with the first word missing —
  // every board on every circuit already carries "FOXY KART CHAMPIONSHIP" as its
  // caption. Setting it as the two-line lockup the other multi-word brands use
  // costs nothing (`sponsorCellPlan` + `fitLine` already size two-line cells) and
  // turns a meaningless board into the game's own brand.
  { lines: ['FOXY', 'KART'], bg: '#f4f1e6', fg: '#c2192a', weight: 1 },
];

/**
 * A whole atlas cell in CELL-LOCAL uv, for the `atlasCells` / `signCells` path
 * where the SHADER supplies the cell offset and the geometry only says "all of
 * it". v top-first, exactly like `atlasRect()`; inset by the same 0.006 so a
 * linear filter cannot reach the neighbouring cell and — the reason this constant
 * exists at all — so no coordinate is ever exactly 0 or 1. See the `clamp` note
 * in `patchProp`: the three recipes that hand-wrote `[0,0,1,1]` or `[0,1,1,0]`
 * had their uv range collapsed to a single texel by the `fract()` this replaced.
 */
const CELL_FULL: [number, number, number, number] = [0.006, 0.994, 0.994, 0.006];

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
export const SPONSOR_PICK: readonly number[] = (() => {
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
    ctx.font = sponsorFont(px, weight);
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

/** One font string, so measuring and drawing can never disagree. */
function sponsorFont(px: number, weight: number): string {
  return `${weight} ${Math.round(px)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
}

/** One line of a wordmark, sized and measured exactly as it will be drawn. */
export interface SponsorCellLine {
  readonly text: string;
  readonly px: number;
  readonly weight: number;
  /** Extra advance per inter-glyph gap, px. Already folded into `width`. */
  readonly tracking: number;
  /** Baseline offset from the cell centre, px. */
  readonly dy: number;
  /** Total advance width of the run as drawn, px. */
  readonly width: number;
}

/**
 * The drawing plan for one sponsor cell.
 *
 * `makeSponsorAtlas` executes this rather than sizing text inline, so the
 * overflow question — does "TINY TRIP CLUB" fit a 2:1 cell? — is answerable
 * without rasterising. `.probe-tmp/sponsors.ts` asserts `width <= safe` for
 * every line of every brand off exactly the plan that ships.
 */
export interface SponsorCellPlan {
  readonly cell: number;
  /** The wordmark with its lines joined, e.g. `TINY TRIP CLUB`. */
  readonly brand: string;
  /** Width every line must fit inside, px. */
  readonly safe: number;
  readonly lines: readonly SponsorCellLine[];
}

/**
 * Advance width of a run as it will actually be drawn: a single `fillText` for
 * an untracked line, a glyph-by-glyph walk for a tracked one. Those differ by
 * kerning, so each is measured the way it is drawn.
 */
function runWidth(
  ctx: CanvasRenderingContext2D, text: string, px: number,
  weight: number, tracking: number,
): number {
  ctx.font = sponsorFont(px, weight);
  if (tracking <= 0) return ctx.measureText(text).width;
  const glyphs = [...text];
  let w = 0;
  for (const g of glyphs) w += ctx.measureText(g).width;
  return w + tracking * px * Math.max(0, glyphs.length - 1);
}

export function sponsorCellPlan(
  ctx: CanvasRenderingContext2D, cell: number, cw: number, ch: number,
): SponsorCellPlan {
  const n = ATLAS_COLS * ATLAS_ROWS;
  const i = ((Math.floor(cell) % n) + n) % n;
  const { lines } = SPONSORS[i];
  // Safe width: inside the 8 px inset and the 7 px keyline, with a margin.
  const safe = cw - 46;
  const out: SponsorCellLine[] = [];
  if (lines.length === 1) {
    const px = fitLine(ctx, lines[0], safe, ch * 0.42, 900);
    out.push({
      text: lines[0], px, weight: 900, tracking: 0, dy: 0,
      width: runWidth(ctx, lines[0], px, 900, 0),
    });
  } else {
    // Two-line lockup: the long line takes the width, the short line sits under
    // it a size down and tracked out, which is how a club wordmark is set and
    // keeps "CLUB" from looking like a truncation of the line above.
    const top = fitLine(ctx, lines[0], safe, ch * 0.34, 900);
    out.push({
      text: lines[0], px: top, weight: 900, tracking: 0, dy: -top * 0.44,
      width: runWidth(ctx, lines[0], top, 900, 0),
    });
    // 0.78 of the first line, not 0.62. The first line is the one that had to
    // shrink to fit — "TINY TRIP" lands at 90 px of a 512 px cell — and deriving
    // the second line from it compounded the shrink: "CLUB" came out at 56 px
    // filling 40 % of a cell it had all the room in the world in. Sizing it as a
    // subordinate line of the lockup and letting `fitLine` clip it back if it
    // ever does run wide reads as a wordmark and stays legible at racing speed.
    const botPx = fitLine(ctx, lines[1], safe * 0.82, top * 0.78, 700, 0.22);
    out.push({
      text: lines[1], px: botPx, weight: 700, tracking: 0.22, dy: top * 0.60,
      width: runWidth(ctx, lines[1], botPx, 700, 0.22),
    });
  }
  return { cell: i, brand: lines.join(' '), safe, lines: out };
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
      const { bg, fg } = SPONSORS[i];
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
      ctx.save();
      ctx.translate(x + cw * 0.5, y + ch * 0.5);
      ctx.transform(1, 0, -0.14, 1, 0, 0);
      // Sized by `sponsorCellPlan` rather than inline, so what the overflow
      // probe measures is what gets drawn.
      for (const ln of sponsorCellPlan(ctx, i, cw, ch).lines) {
        ctx.font = sponsorFont(ln.px, ln.weight);
        if (ln.tracking <= 0) {
          ctx.fillText(ln.text, 0, ln.dy);
          continue;
        }
        // Tracking has to be drawn glyph by glyph: the plan's width allowed for
        // it, so the string must actually carry it or the line reads narrow.
        //
        // The run to centre is the glyph widths PLUS the gaps between them. The
        // previous arithmetic subtracted the gaps and then added them straight
        // back, so it centred the glyph widths alone and pushed the whole line
        // right by half the total tracking — 71 px of a 512 px cell for "CLUB".
        const gap = ln.tracking * ln.px;
        let gx = -ln.width * 0.5;
        for (const g of [...ln.text]) {
          const gw = ctx.measureText(g).width;
          ctx.fillText(g, gx + gw * 0.5, ln.dy);
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

/**
 * ===========================================================================
 *  NATIONAL FLAGS — a second ATLAS, not a second cloth system
 * ===========================================================================
 *  The city circuits each carry one national flag on a plaza mast. The mast and
 *  the cloth are the existing `flagpole` machinery verbatim: a `plate()` with
 *  `flapAcross`, animated by the shared `uWind` uniform. The only new thing is
 *  where the cloth's colour comes from — a baked atlas cell instead of a solid
 *  hex, exactly the way `standBanner` and `screenTower` take sponsor cells.
 *
 *  This atlas is deliberately laid out on the SAME 4x2 cell grid as the sponsor
 *  atlas, so `atlasRect()` applies to it unchanged. Nothing about `plate()`'s uv
 *  ranges, `V_TOP_FIRST` or `atlasRect()` is touched — see the notes on all
 *  three; that question is settled and this reuses the settled answer.
 *
 *  The canvas is 1536 x 512, not square: a cell is then 384 x 256, which is the
 *  3:2 proportion a national flag actually has, and `flagMast()` authors its
 *  cloth 2.7 x 1.8 m to match. `atlasRect()` never sees pixels — only uv — so a
 *  non-square canvas costs it nothing.
 */
const FLAG_USA = 0;
const FLAG_ROC = 1;
const FLAG_JAPAN = 2;
/**
 * Cell 3 used to hold a black/white chequer, drawn only so that no cell of the
 * atlas was ever blank. Nothing read it: `flagMast` is the atlas's only consumer
 * and it was called with 0, 1 and 2, so cells 3-7 were dead pixels. Cell 3 is now
 * the Hong Kong SAR flag; the four pennants at 4-7 still cover the rest.
 */
const FLAG_HK = 3;

function makeFlagAtlas(): THREE.CanvasTexture {
  return canvasTexture(1536, (ctx, w, h) => {
    const cw = w / ATLAS_COLS, ch = h / ATLAS_ROWS;
    const at = (i: number): [number, number] => [
      (i % ATLAS_COLS) * cw, Math.floor(i / ATLAS_COLS) * ch,
    ];
    /** Soft vertical folds + a top-down light gradient, so cloth is not print. */
    const cloth = (x: number, y: number): void => {
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, cw, ch); ctx.clip();
      for (let k = 0; k < 7; k++) {
        const fx = x + (k + 0.5) * (cw / 7);
        const g = ctx.createLinearGradient(fx - cw / 14, 0, fx + cw / 14, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.16)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.10)');
        g.addColorStop(1, 'rgba(0,0,0,0.16)');
        ctx.fillStyle = g;
        ctx.fillRect(fx - cw / 14, y, cw / 7, ch);
      }
      const v = ctx.createLinearGradient(0, y, 0, y + ch);
      v.addColorStop(0, 'rgba(255,255,255,0.10)');
      v.addColorStop(1, 'rgba(0,0,0,0.14)');
      ctx.fillStyle = v;
      ctx.fillRect(x, y, cw, ch);
      ctx.restore();
    };
    /** A `points`-pointed star of radius `r`. */
    const star = (cx: number, cy: number, r: number, points = 5): void => {
      ctx.beginPath();
      for (let i = 0; i < points * 2; i++) {
        const a = (i / (points * 2)) * Math.PI * 2 - Math.PI * 0.5;
        const rr = i % 2 ? r * 0.42 : r;
        if (i === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
    };

    // ---- cell 0: the Stars and Stripes ------------------------------------
    {
      const [x, y] = at(FLAG_USA);
      ctx.fillStyle = '#b31942';
      ctx.fillRect(x, y, cw, ch);
      ctx.fillStyle = '#ffffff';
      for (let i = 1; i < 13; i += 2) ctx.fillRect(x, y + (i * ch) / 13, cw, ch / 13);
      const canW = cw * 0.4, canH = (ch * 7) / 13;
      ctx.fillStyle = '#0a3161';
      ctx.fillRect(x, y, canW, canH);
      ctx.fillStyle = '#ffffff';
      // 5 x 4 offset star grid: at 154 px of canton, 50 stars would be mush.
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          const odd = r % 2;
          if (odd && c === 4) continue;
          star(x + canW * ((c + (odd ? 0.82 : 0.32)) / 5), y + canH * ((r + 0.5) / 5),
            canH * 0.075);
        }
      }
      cloth(x, y);
    }

    // ---- cell 1: the Republic of China ------------------------------------
    {
      const [x, y] = at(FLAG_ROC);
      ctx.fillStyle = '#fe0000';
      ctx.fillRect(x, y, cw, ch);
      ctx.fillStyle = '#000095';
      ctx.fillRect(x, y, cw * 0.5, ch * 0.5);
      const sx = x + cw * 0.25, sy = y + ch * 0.25, sr = ch * 0.19;
      ctx.fillStyle = '#ffffff';
      // Twelve rays, then the disc, then the blue centre.
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(a) * sr, sy + Math.sin(a) * sr);
        ctx.lineTo(sx + Math.cos(a - 0.13) * sr * 0.44, sy + Math.sin(a - 0.13) * sr * 0.44);
        ctx.lineTo(sx + Math.cos(a + 0.13) * sr * 0.44, sy + Math.sin(a + 0.13) * sr * 0.44);
        ctx.closePath();
        ctx.fill();
      }
      ctx.beginPath(); ctx.arc(sx, sy, sr * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000095';
      ctx.beginPath(); ctx.arc(sx, sy, sr * 0.33, 0, Math.PI * 2); ctx.fill();
      cloth(x, y);
    }

    // ---- cell 2: Japan ----------------------------------------------------
    {
      const [x, y] = at(FLAG_JAPAN);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, cw, ch);
      ctx.fillStyle = '#bc002d';
      ctx.beginPath();
      ctx.arc(x + cw * 0.5, y + ch * 0.5, ch * 0.3, 0, Math.PI * 2);
      ctx.fill();
      cloth(x, y);
    }

    // ---- cell 3: the Hong Kong SAR --------------------------------------
    // Red field with a white five-petal Bauhinia blakeana. The petals all bend
    // the SAME way, which is what makes the flower read as a pinwheel rather
    // than as a daisy — get that wrong and it is a generic five-pointed blob.
    // Each petal carries a red five-pointed star and a red stamen stroke.
    {
      const [x, y] = at(FLAG_HK);
      ctx.fillStyle = '#de2910';
      ctx.fillRect(x, y, cw, ch);
      const fx = x + cw * 0.5, fy = y + ch * 0.5, R = ch * 0.355;
      for (let i = 0; i < 5; i++) {
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate((i / 5) * Math.PI * 2 - Math.PI * 0.5);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(R * 0.40, -R * 0.20, R * 0.94, -R * 0.32, R * 1.00, R * 0.01);
        ctx.bezierCurveTo(R * 1.04, R * 0.36, R * 0.44, R * 0.32, 0, 0);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#de2910';
        star(R * 0.66, R * 0.01, R * 0.145);
        ctx.strokeStyle = '#de2910';
        ctx.lineWidth = Math.max(1, R * 0.05);
        ctx.beginPath();
        ctx.moveTo(R * 0.20, R * 0.05);
        ctx.lineTo(R * 0.56, R * 0.09);
        ctx.stroke();
        ctx.restore();
      }
      cloth(x, y);
    }
    const pennant: Array<[string, string]> = [
      ['#d8402f', '#f2c53d'], ['#0f6bd6', '#f6efdd'],
      ['#1d6f63', '#ffd23f'], ['#7a2ed6', '#4fd6ff'],
    ];
    for (let i = 0; i < 4; i++) {
      const [x, y] = at(4 + i);
      const [a, bb] = pennant[i];
      ctx.fillStyle = a;
      ctx.fillRect(x, y, cw, ch);
      ctx.fillStyle = bb;
      ctx.beginPath();
      ctx.moveTo(x, y + ch);
      ctx.lineTo(x + cw, y);
      ctx.lineTo(x + cw, y + ch);
      ctx.closePath();
      ctx.fill();
      cloth(x, y);
    }
  }, { srgb: true, height: 512 });
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

// ===========================================================================
// Building facades
// ===========================================================================

/**
 * ===========================================================================
 *  WHY THE CITY BUILDINGS NEEDED THEIR OWN MATERIAL
 * ===========================================================================
 *  `this.matte` is `vertexColors` + a shared detail normal and **no `map` and no
 *  `roughnessMap` at all**. On a bollard or a tyre stack that is fine — the
 *  silhouette carries it. On a 46 m tower it is exactly the AGENTS.md section 0
 *  instant-fail: a solid flat colour across the largest surface in the frame.
 *  Measured on the rejected build, the four vertex colours `0x50565f /
 *  0x585f68 / 0x4a5058 / 0x33383e` covered 68 towers on Boston and 78 on Tokyo.
 *
 *  So the three city vocabularies get a real PBR facade set: albedo, roughness
 *  and a normal map built from the same height field, tiling at a fixed WORLD
 *  size so bricks are brick-sized on a brownstone and mullion-sized on a curtain
 *  wall rather than "coarse enough to count the repeats".
 *
 *  ---------------------------------------------------------------------------
 *  ALBEDO IS NEUTRAL ON PURPOSE
 *  ---------------------------------------------------------------------------
 *  Every prop material here is `vertexColors: true`, and `map` MULTIPLIES the
 *  vertex colour. So the albedo is authored around 1.0 with only a small warm/cool
 *  split between material and joint (brick warm, mortar cool; glass cool, mullion
 *  neutral). One facade set therefore serves brick red, limestone cream and glass
 *  blue-grey from the same texture, driven by the recipe's own vertex colours —
 *  three hues for one texture and one draw call each.
 *
 *  ---------------------------------------------------------------------------
 *  NO CANVAS, NO `getImageData`
 *  ---------------------------------------------------------------------------
 *  Albedo, roughness and height are evaluated per texel from one shared layout
 *  function into typed arrays. That keeps the three maps exactly registered with
 *  each other (a mortar line is dark, rough AND recessed at the same texel), and
 *  it runs identically under the node probe harness, which has no real 2D canvas
 *  readback. `heightToNormal` is TextureFactory's shared Sobel (AGENTS.md 4).
 * ===========================================================================
 */
type FacadeKind = 'masonry' | 'tile' | 'curtain';

interface FacadeSet {
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
  normalMap: THREE.Texture;
  /** World metres covered by one uv tile. Recipes set `uvScale = 1 / this`. */
  tileMetres: number;
}

/**
 * Cheap deterministic hash for per-brick / per-pane variation.
 *
 * Integer mixing, not `fract(sin(...))`: this runs up to twice per texel over a
 * whole facade set, and two `Math.sin` calls per texel put ~300 ms of `Math.sin`
 * into `Environment.init()` — which `RaceDirector.beginRace()` runs *during the
 * countdown*. `Math.imul` mixing measures about 8x faster here for a hash whose
 * only job is to look uncorrelated.
 */
function fhash(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * One texel of a facade. Returns albedo multipliers, roughness and height so all
 * three maps come out of a single description of the surface.
 *
 * `u` runs across the facade and `v` up it, both in [0,1) over one tile. A tile
 * is TWO STOREYS tall for `masonry` and `tile` and two structural bays for
 * `curtain`, which is what keeps `tileMetres` honest against the recipes.
 */
function facadeTexel(
  kind: FacadeKind, u: number, v: number,
): { r: number; g: number; b: number; rough: number; h: number } {
  if (kind === 'masonry') {
    // 2 storeys per tile. Storey: 0.18 stone band, then the window band.
    const storey = v < 0.5 ? v * 2 : (v - 0.5) * 2;   // 0..1 within the storey
    const bay = u * 4;                                 // 4 bays across
    const bayF = bay - Math.floor(bay);
    // ---- limestone banding: sill course and a wider lintel course
    const band = storey < 0.14 || (storey > 0.86 && storey < 0.995);
    // ---- punched window opening, with a reveal so the normal has depth
    const winY = storey > 0.24 && storey < 0.80;
    const winX = bayF > 0.24 && bayF < 0.76;
    const revealY = storey > 0.20 && storey < 0.84;
    const revealX = bayF > 0.20 && bayF < 0.80;
    if (winY && winX) {
      // Recessed glazing: dark, smooth, deep. Two lights per sash.
      const mullion = Math.abs(bayF - 0.5) < 0.022 || Math.abs(storey - 0.52) < 0.016;
      if (mullion) return { r: 0.9, g: 0.9, b: 0.88, rough: 0.62, h: 0.62 };
      const sheen = 0.28 + 0.30 * (1 - storey);
      return { r: sheen * 0.92, g: sheen * 0.98, b: sheen * 1.12, rough: 0.16, h: 0.30 };
    }
    if (revealY && revealX) {
      // The reveal itself — stone, in shadow, stepped back from the wall face.
      return { r: 0.74, g: 0.73, b: 0.71, rough: 0.72, h: 0.72 };
    }
    if (band) {
      // Ashlar limestone: horizontal joints only, much larger than the brick.
      const joint = Math.abs(((v * 2) % 0.5) / 0.5 - 0.5) > 0.487;
      return joint
        ? { r: 0.80, g: 0.81, b: 0.83, rough: 0.86, h: 0.55 }
        : { r: 1.14, g: 1.12, b: 1.07, rough: 0.66, h: 0.95 };
    }
    // ---- brick bond. 12 courses per storey => a 0.26 m course at tileMetres 6.2,
    // and a stretcher twice as wide, offset half a brick on alternate courses.
    const course = Math.floor(v * 24);
    const cf = v * 24 - course;
    const off = course % 2 === 0 ? 0 : 0.5;
    const brick = (u * 16 + off);
    const bf = brick - Math.floor(brick);
    const mortar = cf < 0.13 || bf < 0.09;
    if (mortar) return { r: 0.83, g: 0.85, b: 0.87, rough: 0.93, h: 0.34 };
    const vary = 0.86 + 0.30 * fhash(Math.floor(brick), course);
    return { r: vary * 1.06, g: vary * 0.965, b: vary * 0.92, rough: 0.80 + 0.1 * vary, h: 0.82 };
  }

  if (kind === 'tile') {
    // Dense mid-rise: tiled spandrels, a balcony slab per storey, AC boxes and a
    // service riser. 2 storeys per tile, 3 bays.
    const storey = v < 0.5 ? v * 2 : (v - 0.5) * 2;
    const bay = u * 3;
    const bayF = bay - Math.floor(bay);
    if (storey < 0.11) {
      // Balcony slab: proud of the wall, top-lit, and the darkest line under it.
      const lip = storey < 0.035;
      return lip
        ? { r: 0.70, g: 0.70, b: 0.71, rough: 0.80, h: 0.42 }
        : { r: 1.18, g: 1.17, b: 1.14, rough: 0.70, h: 1.0 };
    }
    if (storey > 0.24 && storey < 0.74 && bayF > 0.14 && bayF < 0.86) {
      // Sliding glazing behind the balcony, with a frame.
      const frame = bayF < 0.19 || bayF > 0.81 || Math.abs(bayF - 0.5) < 0.02
        || storey < 0.28 || storey > 0.70;
      if (frame) return { r: 0.96, g: 0.96, b: 0.94, rough: 0.5, h: 0.58 };
      const sheen = 0.30 + 0.26 * (1 - storey);
      return { r: sheen * 0.9, g: sheen * 1.0, b: sheen * 1.1, rough: 0.18, h: 0.36 };
    }
    // An air-conditioning box on roughly one bay in three.
    const acHash = fhash(Math.floor(bay), Math.floor(v * 2) + 3);
    if (acHash > 0.66 && storey > 0.13 && storey < 0.23 && bayF > 0.58 && bayF < 0.9) {
      return { r: 1.05, g: 1.05, b: 1.03, rough: 0.55, h: 1.0 };
    }
    // 0.45 m glazed wall tile with a grout grid — the Taipei read.
    const tx = u * 14, ty = v * 28;
    const grout = (tx - Math.floor(tx)) < 0.10 || (ty - Math.floor(ty)) < 0.10;
    if (grout) return { r: 0.86, g: 0.86, b: 0.85, rough: 0.88, h: 0.40 };
    const vary = 0.92 + 0.18 * fhash(Math.floor(tx), Math.floor(ty));
    return { r: vary, g: vary * 1.005, b: vary * 1.02, rough: 0.42, h: 0.78 };
  }

  // ---- curtain: dark glass between raised mullions, spandrel band per floor.
  const bay = u * 3;                    // 3 structural bays per tile
  const bayF = bay - Math.floor(bay);
  const floorV = v * 2;                 // 2 floors per tile
  const fF = floorV - Math.floor(floorV);
  const mullion = bayF < 0.055 || bayF > 0.945;
  const transom = fF < 0.05;
  if (mullion || transom) {
    // Anodised aluminium: brighter than the glass, proud of it, and the thing
    // that stops 118 m of curtain wall reading as one painted rectangle.
    return { r: 1.16, g: 1.17, b: 1.20, rough: 0.34, h: 1.0 };
  }
  if (fF < 0.30) {
    // Opaque spandrel over the floor slab — the horizontal rhythm.
    const grain = 0.94 + 0.10 * fhash(Math.floor(bay), Math.floor(floorV * 6));
    return { r: grain * 0.80, g: grain * 0.82, b: grain * 0.86, rough: 0.56, h: 0.70 };
  }
  // Vision glass: a vertical sky gradient per pane plus a per-pane tint step.
  const pane = 0.82 + 0.34 * fhash(Math.floor(bay), Math.floor(floorV));
  const grad = 0.72 + 0.55 * (1 - (fF - 0.30) / 0.70);
  const g = pane * grad;
  return { r: g * 0.84, g: g * 0.94, b: g * 1.16, rough: 0.09, h: 0.5 };
}

/** Build the albedo / roughness / normal set for one facade vocabulary. */
function makeFacade(kind: FacadeKind, size: number): FacadeSet {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    // v = 0 at the BOTTOM of the tile. Canvas/DataTexture rows run top-down, and
    // `finalize` does not flip a DataTexture, so invert here — otherwise every
    // window sill ends up as a lintel and the balcony slabs hang from the ceiling.
    const v = 1 - (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const t = facadeTexel(kind, u, v);
      const i = y * size + x;
      const p = i * 4;
      albedo[p] = Math.min(255, Math.round(t.r * 235));
      albedo[p + 1] = Math.min(255, Math.round(t.g * 235));
      albedo[p + 2] = Math.min(255, Math.round(t.b * 235));
      albedo[p + 3] = 255;
      rough[i] = t.rough;
      height[i] = t.h;
    }
  }
  const map = new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.needsUpdate = true;

  const roughnessMap = floatToTexture(rough, size, size);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  const normalMap = heightToNormal(height, size, size, kind === 'curtain' ? 1.5 : 2.6);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;

  // Masonry and tile are authored two storeys to a tile at a 3.1 m storey;
  // `curtain` is two floors of a 3.6 m curtain-wall module.
  return { map, roughnessMap, normalMap, tileMetres: kind === 'curtain' ? 7.2 : 6.2 };
}

/** Blend two packed hex colours, `t` = 0 gives `a`. */
function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
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

  const standRng = new Rng(((ctx.hints.terrainSeed | 0) ^ 0x57a4d5) >>> 0 || 1);

  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => Math.abs(curv[b]) - Math.abs(curv[a]));
  for (const i of order) {
    if (out.length >= limit) break;
    // Outside of the corner: opposite the turn direction.
    // `Math.random()` here made stand and crowd counts NON-REPRODUCIBLE between
    // runs of the same circuit — Crowd came out 1818 / 1816 / 1751 / 1721 across
    // four identical builds, which silently invalidates any before/after
    // measurement anyone takes of this subsystem. Seeded from the circuit's own
    // `terrainSeed`, offset so it cannot phase-lock with the terrain scatter that
    // shares that seed.
    place(i, curv[i] > 0 ? -1 : 1, 0.5 + standRng.next() * 0.3, false);
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
  /**
   * Drive `cloth` with the FLAG amplitude instead of the general one. Set it for
   * anything bent onto a mast; leave it for awnings, sails and canopies, which
   * are stayed at more than one edge and do not sweep.
   */
  clothMast?: boolean;
  /**
   * Companion pass on the SPONSOR ATLAS cloth material — a hanging banner with
   * real artwork on it, swaying like `cloth` but textured like `sign`.
   *
   * This exists because `Prop:authored:startgantry`'s two hanging banners were
   * `map: false, roughnessMap: false` flat saturated red and blue on `matteSway`
   * — a section 0 violation directly over the start line on ALL SIX circuits,
   * i.e. at the exact spot the owner has reported a defect five playtests running.
   * Author it with a baked `atlasRect()` uv range, exactly like `standBanner`,
   * which has always done it this way.
   */
  clothSign?: THREE.BufferGeometry;
  /**
   * Companion pass on the FLAG atlas cloth material. Same `plate(flapAcross)`
   * geometry as `cloth`, drawn with the flag texture instead of a solid colour;
   * author it with a baked `atlasRect()` uv range. See `makeFlagAtlas`.
   */
  flag?: THREE.BufferGeometry;
  /** Companion pass on the metal material — trusses, bracing, railings. */
  metal?: THREE.BufferGeometry;
  /**
   * PER-INSTANCE metal pass: the geometry is rebuilt for every anchor, so it can
   * be authored against the road THAT anchor actually stands on.
   *
   * ---- WHY THIS EXISTS ------------------------------------------------------
   * Everything else in this file shares one geometry across every instance, which
   * is right for a lamp post and wrong for anything that has to MEET the
   * carriageway at a point away from its own anchor. `bridgearch`'s stay fan
   * reaches 27 m fore and aft and lands 12.6 m out to each side, and over that
   * box the road is not a plane and not straight:
   *
   *   bank      the deck at Boston's two towers is superelevated 5.2 deg and
   *             7.8 deg, so the deck edge is 0.98 m ABOVE the anchor plane on one
   *             side and 1.30 m BELOW it on the other (2.07 m at the second
   *             tower). The instance transform is yaw-only, so a level prop's
   *             left and right anchor lines cannot both be on the deck.
   *   grade     the deck falls 0.3-0.9 m over the fan's own length.
   *   curvature the straight chord departs from the curving deck edge by up to
   *             1.66 m at 27 m of reach.
   *
   * Measured against the DRAWN track mesh before this existed
   * (`.probe-tmp/staygap.ts`): all 96 stay anchor castings hung in the air, p50
   * 1.32 m, p90 4.06 m, max 5.01 m, and 6 of them sat over the tarmac. No amount
   * of tuning a shared geometry fixes that, because the two towers need different
   * numbers. Rebuilding the fan per anchor does, exactly, and it costs ONE extra
   * draw call per additional instance — the body and the glow stay shared.
   */
  metalPerAnchor?: (a: Anchor) => THREE.BufferGeometry;
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
  // City series: the cable-stayed bridge tower straddles its own deck and the
  // expressway overpass crosses the carriageway 9.6 m up. Both are authored at
  // lat 0 — `getDecorationHints().place()` yaws a lat-0 prop so local +X runs
  // ACROSS the road — and both must keep the height they were authored at.
  'bridgearch', 'overpassarch',
  // The district markers are not props at all (see CITY_KITS) and are authored at
  // lat 0 on the start line. Listing them here keeps the re-seating pass from
  // moving a declaration around as though it had a silhouette.
  'district:brick', 'district:midrise', 'district:tokyo',
  // New York's suspension-bridge tower straddles its own deck exactly the way
  // `bridgearch` does — authored at lat 0, piers outboard of the carriageway,
  // and the deck's own height is the anchor its cable web is solved against.
  'brooklyntower',
  'district:hongkong', 'district:newyork',
]);

/**
 * ===========================================================================
 *  THE CABLE-STAYED BRIDGE TOWER, IN ONE PLACE
 * ===========================================================================
 *  The body (`authoredSpec('bridgearch')`) and the stay fan (`bridgeFan`, built
 *  once per anchor) are two separate builders that have to agree to the
 *  centimetre: the fan derives each stay's tower end from the shaft's taper at
 *  that stay's own height, so a change to the obelisk that the fan did not see
 *  would leave 48 cables hanging off thin air at the top instead of the bottom.
 *  Neither builder is allowed a literal for any of these.
 */
const BRIDGE_KNEE = 27;
const BRIDGE_TOP = 86;
const BRIDGE = {
  /** Half the foot spread; local |x| of each leg. */
  leg: 14.9,
  /** Height of the crotch, where the legs meet and the obelisk starts. */
  knee: BRIDGE_KNEE,
  /** Top of the shaft, below the finial. */
  top: BRIDGE_TOP,
  /** Joint between the obelisk's two stages. */
  mid: BRIDGE_KNEE + (BRIDGE_TOP - BRIDGE_KNEE) * 0.56,
  /** How far the pier descends BELOW the deck anchor. */
  pier: -5.4,
  /** Half-width of the lower obelisk stage at its foot, and its taper. */
  shaftLo: 2.5,
  taperLo: 0.74,
  /** ...and of the upper stage. */
  shaftHi: 1.78,
  taperHi: 0.72,
  /** Stays per quadrant. */
  stays: 12,
  /** Arc length from the tower to the NEAREST and FURTHEST deck anchor. */
  near: 7,
  far: 27,
  /** Stay radius. 0.17 is 2.3 px at 120 m on a 1080p frame; 0.09 was 1.2. */
  radius: 0.17,
  /** Height of the anchor pier above the shoulder it stands on. */
  anchorH: 2.05,
  /**
   * Metres INBOARD of the shoulder's outer edge that the anchor pier stands.
   *
   * The concrete barrier's foot is `WALL_STANDOFF` (0.12 m) OUTBOARD of that
   * edge and it batters a further 0.36 m out as it rises, so 0.35 m in puts the
   * pier on drawn shoulder with its outboard face against the barrier's inboard
   * face. Not on top of the barrier: the barrier's lateral position moves with
   * `halfWidth`, which changes by 0.76 m between Boston's two towers, and the
   * shoulder is the widest thing that is certainly there.
   */
  inset: 0.35,
} as const;

/**
 * ===========================================================================
 *  THE SUSPENSION BRIDGE TOWER, IN ONE PLACE
 * ===========================================================================
 *  Exactly the reason `BRIDGE` above exists: `authoredSpec('brooklyntower')`
 *  builds the masonry and `brooklynCables()` builds the cable web per anchor,
 *  and the second has to know where the first put its saddles to the
 *  centimetre. Neither builder is allowed a literal for any of these.
 *
 *  Every height is measured from the DECK, which is the anchor — this is a
 *  `CORRIDOR_PROPS` type, so it keeps the carriageway's own Y.
 */
const BROOKLYN = {
  /** Inner face of each outer pier; nothing may come inside this below `spring`. */
  gap: 14.9,
  /** Half-thickness of one outer pier, so it occupies |x| in [gap, gap + 2*pierW]. */
  pierW: 2.6,
  /** Half-width of the corbelled centre pier, which starts at `pendant`. */
  centreW: 2.4,
  /** Springing line of the arches, and the underside of the centre corbel. */
  spring: 12.0,
  pendant: 9.4,
  /** Crown of the arch heads. */
  crown: 27.0,
  /** Top of the spandrel wall over the arches. */
  shoulderY: 35.0,
  /** Top of the tower, where the cable saddles sit. */
  top: 63.0,
  /** How far the pier skirt descends BELOW the deck anchor. */
  skirt: -5.4,
  /** Local |x| of each main-cable saddle. */
  cableX: 12.0,
  /** Arc length each way that the main cable and the stay web reach. */
  reach: 48,
  /** Suspenders and stays per side, per direction. */
  suspenders: 7,
  stays: 6,
  /** Radii: main cable, suspender, diagonal stay. */
  mainR: 0.30,
  hangR: 0.075,
  stayR: 0.12,
  /** Height of the deck edge girder above the shoulder it stands on. */
  anchorH: 1.85,
  /**
   * ---- THERE IS NO `shoulder` CONSTANT HERE ANY MORE ------------------------
   * There used to be: `shoulder: 1.2`, with a note explaining that
   * `deckFrameAt().shL/shR` could not be trusted because `PathStation` carried
   * the fields and `Environment.stationFrom()` never wrote them, so every
   * station on every circuit reported `SH_FALLBACK` (3 m) against an authored
   * 1.2 m. A girder placed at `hw + kerbW + 3 - inset` stood 1.3 m past the
   * deck edge and, on a superelevated deck, well below it.
   *
   * That was a workaround for one circuit, and it worked — but it also meant
   * this bridge could not follow a shoulder that CHANGES, and it left Boston's
   * `bridgeFan` (same field, same fallback) reading 3 m and floating.
   *
   * The field is now plumbed: `TrackSpline.SplineSample` publishes channels 2
   * and 3, `readSample()` carries them and `stationFrom()` writes them, so
   * `deckFrameAt()` returns the authored shoulder at the station's own arc.
   * `shoulderAt()` below reads `frame.shL / frame.shR` like `bridgeFan` does,
   * and the constant is gone rather than left as a second source of truth.
   *
   * Measured, `.probe-tmp/shoulderfix.ts` claim C, this circuit: the worst of
   * 54 girder anchor bands had +0.03 m of air with the constant and +0.05 m
   * with the derived value, against a drawn deck edge it stays 0.52 m inboard
   * of either way. Deriving it reproduces the hand-tuned number to within half
   * a centimetre and now follows a shoulder that changes.
   */
  /** Metres inboard of the drawn shoulder's outer edge the girder stands. */
  inset: 0.65,
} as const;

/** Half-width of the obelisk shaft at height `y`, in the tower's local frame. */
function bridgeShaftHalf(y: number): number {
  const { knee, top, mid, shaftLo, taperLo, shaftHi, taperHi } = BRIDGE;
  if (y <= mid) {
    const t = clamp01((y - knee) / Math.max(mid - knee, 1e-3));
    return shaftLo * (1 + (taperLo - 1) * t);
  }
  const t = clamp01((y - (mid + 0.64)) / Math.max(top - mid, 1e-3));
  return shaftHi * (1 + (taperHi - 1) * t);
}

// ===========================================================================
// City vocabularies
// ===========================================================================

/**
 * ===========================================================================
 *  ONE `theme: 'city'` IS NOT ONE CITY
 * ===========================================================================
 *  Boston Harbor, Taipei Circuit, Tokyo Neon and Neon Metropolis all set
 *  `theme: 'city'`, which routes to `buildCity()`. Until now that meant one kit:
 *  the same 46 m setback tower, the same ring-and-bars neon mast, the same
 *  parked cars and the same three cable trams, on all four. The critic's verdict
 *  was *"Boston's grid-wide is indistinguishable from Neon Metropolis — same
 *  towers, same VOLT neon, same trams"*, and the counts backed it: 68 generic
 *  skyscrapers and 30 neon signs against 18 Boston-specific instances.
 *
 *  A hardcoded `switch (trackId)` cannot fix it, because Props never learns the
 *  track id — `WorldContext` carries the theme, the sky preset, the terrain seed
 *  and the authored prop list, and nothing else. So the vocabulary is DECLARED
 *  BY THE TRACK, as a prop: `CityDefs` authors `{ type: 'districtBrick' }` once
 *  at t=0, `normaliseType` folds it to `district:brick`, and `buildCity` claims
 *  it with `takeAuthored` before anything is emitted. A circuit that declares
 *  nothing gets `neon`, which is byte-for-byte the old kit — that is what keeps
 *  Neon Metropolis unchanged without editing `TrackDefs.ts`.
 *
 *  Adding a fourth city is therefore one line in its own def, and the marker is
 *  visible in the track file where the art direction belongs.
 */
type CityKitId = 'neon' | 'brick' | 'midrise' | 'tokyo' | 'hongkong' | 'newyork';

interface CityKit {
  readonly id: CityKitId;
  /** Which facade vocabulary the background towers and the mid-rise use. */
  readonly facade: FacadeKind;
  /** Background towers in the annulus, before the density multiplier. */
  readonly towers: number;
  /**
   * Share of the background towers built as the SECOND body recipe. Boston is
   * brick masonry with a minority of dark-glass slabs; the others are 0 or 1.
   */
  readonly slabShare: number;
  /** Ring-and-bars neon masts. 0 on Boston: a brick city has no neon signage. */
  readonly neonRing: number;
  /** Vertical stacked shop signage (Taipei) / box signage (Tokyo). 0 elsewhere. */
  readonly neonStack: number;
  readonly parkedCars: number;
  /** Paint palette, so the kerbside cars are not the same six cars everywhere. */
  readonly carPaints: readonly number[];
  /** Overhead cable trams. Only the fictional Neon Metropolis has these. */
  readonly trams: number;
  /** Rock palette: [light, dark]. */
  readonly rock: readonly [number, number];
  /**
   * Lit shopfront band around the base of every background tower. This is the
   * dominant light source in a real night city street and the answer to
   * "the 78-tower skyline contributes only +2.19 L and is a net light sink".
   */
  readonly plinthGlow: boolean;
}

const CITY_KITS: Record<CityKitId, CityKit> = {
  // The original, unchanged: Neon Metropolis declares no district.
  neon: {
    id: 'neon', facade: 'curtain', towers: 52, slabShare: 0,
    neonRing: 30, neonStack: 0, parkedCars: 44,
    carPaints: [0xc9302c, 0x2f6fd0, 0xe8e6df, 0x2b2f35, 0xd8b13a, 0x2f9e6b],
    trams: 3, rock: [0x6f747c, 0x565b63], plinthGlow: true,
  },
  // BOSTON: brick, granite and glass. No neon anywhere, no trams, and the
  // background towers are masonry commercial blocks with a minority of dark
  // glass slabs — the Hancock among the Back Bay brick.
  brick: {
    id: 'brick', facade: 'masonry', towers: 46, slabShare: 0.34,
    neonRing: 0, neonStack: 0, parkedCars: 32,
    carPaints: [0x2b3038, 0x5c6672, 0x8d9298, 0x7d1f22, 0x1f3a5c, 0xd9d6cd],
    trams: 0, rock: [0x8a8378, 0x6b665e], plinthGlow: false,
  },
  // TAIPEI: dense tiled mid-rise with balconies and vertical shop signage, under
  // a dusk sky. Signage yes — but stacked shophouse boards, not the ring masts.
  midrise: {
    id: 'midrise', facade: 'tile', towers: 44, slabShare: 0,
    neonRing: 0, neonStack: 34, parkedCars: 26,
    carPaints: [0xe8e6df, 0xc9ccd2, 0x2b2f35, 0x1f4f8c, 0x7d8288, 0xb8352a],
    trams: 0, rock: [0x7e7a70, 0x605c55], plinthGlow: true,
  },
  // TOKYO: dark curtain wall carrying screens and box signage, at night. Same
  // family as `neon` but its own signage recipe and a much larger emissive area.
  tokyo: {
    id: 'tokyo', facade: 'curtain', towers: 50, slabShare: 0,
    neonRing: 18, neonStack: 26, parkedCars: 26,
    carPaints: [0xe8e6df, 0x1b1e22, 0xb8bcc2, 0x2f4f8c, 0x8d1f26, 0x50565f],
    trams: 0, rock: [0x6a6f77, 0x51565d], plinthGlow: true,
  },
  // HONG KONG: the podium-and-tower type, which is what actually distinguishes
  // this skyline from Tokyo's. A wide retail/carpark podium with a horizontal
  // banding, then a much slimmer residential shaft rising out of it — dozens of
  // them shoulder to shoulder. Signage is the STACKED shophouse board (the
  // cantilevered boards are an authored recipe on top of that), and a minority of
  // dark glass slabs stand in for the commercial core towers.
  hongkong: {
    id: 'hongkong', facade: 'tile', towers: 50, slabShare: 0.22,
    neonRing: 0, neonStack: 32, parkedCars: 22,
    // Hong Kong's kerbside is red taxis, white vans and dark saloons.
    carPaints: [0xc4302a, 0xe8e6df, 0x2b2f35, 0xc4302a, 0x7d8288, 0x1f3550],
    trams: 0, rock: [0x6f7a6a, 0x525a4e], plinthGlow: true,
  },
  // NEW YORK: the 1916 zoning envelope — a masonry ziggurat that steps back off
  // the lot line four times before it goes vertical, with a water tank on the
  // first setback. No neon of any kind, no trams. `slabShare` puts the post-war
  // glass boxes among the pre-war stone, which is exactly what a midtown avenue
  // looks like from the street.
  newyork: {
    id: 'newyork', facade: 'masonry', towers: 48, slabShare: 0.30,
    neonRing: 0, neonStack: 0, parkedCars: 34,
    carPaints: [0xf0b81c, 0x2b3038, 0xf0b81c, 0x8d9298, 0x24405e, 0xe8e6df],
    trams: 0, rock: [0x8c8579, 0x6d6860], plinthGlow: false,
  },
};

/**
 * ===========================================================================
 *  THE NIGHT FACTOR — one accessor, owned by Sky
 * ===========================================================================
 *  How night-time the circuit is, 0 (midday) to 1 (midnight). Drives every
 *  emissive decision in this file: which window material is used, what fraction
 *  of panes count as lit, and how bright the shopfront bands and screens are.
 *
 *  This is the gate that did not exist. `Props.ts` emitted the lit-window pass
 *  unconditionally, so Boston (`skyPreset: 'day'`, key 3.9 `#fff1d6`, blue sky)
 *  had all 68 of its towers full of `#ffffff` windows at `emissiveIntensity 2.6`
 *  while the facades rendered near-black.
 *
 *  The curve is `Sky.skyNightFactor()` — `max(night, cityGlow)` off the real
 *  preset — so there is one definition of "how dark is it" instead of a table
 *  here that could drift from the lighting it is supposed to match. It answers
 *  day 0, sunset 0.1, night 1, storm 0, volcanic 0, and 0 for anything unknown.
 *
 *  ---------------------------------------------------------------------------
 *  WHY THE ARGUMENT IS THE HINT AND NOT `worldRegistry.sky?.presetName`
 *  ---------------------------------------------------------------------------
 *  Sky's own doc suggests reading the live registry. That is not safe from here,
 *  for two measured reasons, and both fail SILENTLY and in the dark direction:
 *
 *   1. **The registry can be null.** `worldRegistry.sky = this` is the last line
 *      of Sky's *constructor*, and `Environment` never constructs Sky — it only
 *      adopts one if it is already there (`resolveSkyLighting`). Every headless
 *      path, including `.probe-tmp/daynight.ts`, builds `Environment` with no Sky
 *      at all, so the registry is null and every circuit would score 0.
 *   2. **It can be stale.** Sky's constructor calls `setPreset('day')` before
 *      registering itself, and Environment pushes the circuit's real preset
 *      later, with a retry counter (`presetTries`). So there is a window in which
 *      `worldRegistry.sky.presetName` is `'day'` on Tokyo Neon — and Props is
 *      built inside `Environment.init()`, which `RaceDirector.beginRace()` runs
 *      un-awaited during the countdown. Reading the registry there would turn
 *      Tokyo's windows OFF, which is the exact inverse of this bug.
 *
 *  `ctx.hints.skyPreset` has neither problem: `Environment.makeHints()` already
 *  validates the authored name against `SKY_NAMES` and substitutes
 *  `THEME_SKY[theme]` if it does not match, so the hint Props receives is the
 *  resolved name, per circuit, correct at build time. The registry is consulted
 *  only if the hint scores 0 *and* is not a name Sky knows — i.e. as a second
 *  opinion when the hint is the thing that is broken.
 */
function nightFactorFor(hintName: string | undefined): number {
  const fromHint = skyNightFactor(hintName);
  if (fromHint > 0) return fromHint;
  if (hintName && hintName in SKY_PRESETS) return fromHint;   // a real 0: daylight.
  return skyNightFactor(worldRegistry.sky?.presetName);
}

/**
 * Below this the emissive window pass is replaced by reflective day glass.
 * `skyNightFactor` returns an exact 0 for daylight and for anything it does not
 * recognise, so this only has to exclude zero — it is not a tuned threshold, and
 * it deliberately lets sunset's 0.1 through. Taipei is a dusk night market; its
 * windows and lanterns should come up a tenth at golden hour, not snap off.
 */
const WINDOW_NIGHT_MIN = 1e-3;

/** Window emissive at full night. Scaled by the night factor, not offset by it. */
const WINDOW_EMISSIVE_NIGHT = 3.7;

/**
 * Height of every background-tower recipe, about a CENTRED origin. `buildCity`
 * lifts each instance by `TOWER_H * 0.5 * scale`, and the window grid and the
 * shopfront band are laid out against the same number, so the four vocabularies
 * have to agree on it.
 */
const TOWER_H = 46;

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

/**
 * ================== THE `elevated` GATE WAS A BLANKET EXEMPTION ==============
 *
 * Condition 4 above used to be a bare `!surf.elevated`: on any bridge deck, bore
 * or helix, EVERY authored prop outside the corridor kept the deck's Y, at
 * whatever height the carriageway happened to be. The reasoning was a composition
 * one — a prop authored beside a deck was authored in the deck's frame — and it is
 * sound for deck-edge dressing. It is nonsense at 84 m of lateral offset.
 *
 * Measured (`.probe-tmp/elevgate.ts`), the gate was the only thing holding up:
 *
 *     tokyoNeon    skyscraper   lat +-84   8 instances 13.4-24.2 m IN THE AIR
 *                                          (46 m towers, bases up to 24 m off the
 *                                          ground) and 5 more 1.5-10.8 m BURIED
 *     volcanoRush  obsidianSpire lat -32   5 instances 21.8-52.1 m in the air,
 *                                          2 more 17.8-23.9 m buried
 *     sunsetCoastline townHouse  lat +-20  6 of 6 floating 4.9-8.2 m
 *
 * Nineteen props between 4.9 m and 52 m off the ground, on three circuits, and
 * `.probe-tmp/buried.ts` could not see any of it because its `AIRBORNE` list
 * excused half the names before it measured them.
 *
 * So the gate is now a DISTANCE, not a flag. Within `corridor + DECK_FRAME` of the
 * centreline a prop is plausibly part of the structure — a parapet lamp, a chevron
 * on the edge beam, a brake board — and keeps the deck datum, which is what the
 * original reasoning was actually about. Beyond that it is landscape and stands on
 * the ground like everything else. `DECK_FRAME` is the edge beam plus a parapet
 * walk: everything the measurement found inside it is within 0.4 m of the ground
 * anyway, so the choice of value does not decide any prop's fate by a whisker.
 */
const DECK_FRAME = 4.0;

/**
 * Metres of clear ground a roadside prop's GEOMETRY must leave past the kerb.
 *
 * The P0h fix. `roadside()` bands its anchors at `halfWidth + o.min …`, and every
 * call site reads as if that were clearance — but it is the ANCHOR, and the
 * recipe then builds outward from it in both directions. `tyreWall` is banded at
 * `min: 1.0` and its stack is 0.63 m deep, so its near face stood 0.37 m past the
 * asphalt edge: on the kerb, 2.24 m tall, on both sides, every 11 m. Measured
 * from the edge-riding chase pose (`.probe-tmp/edgeview.ts`), it was in frame at
 * 545 of 969 poses on coastal and blocked 171 road-ahead sightlines — the single
 * most pervasive contributor to the owner's "scenery clutter affecting the track".
 *
 * This is the third instance of one mistake in this file: `planStands` tested a
 * 78 m terrace at its anchor, `catchFence` tested a 6.1 m panel against a
 * constant 14 m, and `roadside` tested a nothing-wide point. So the correction is
 * applied once, in `emit()`, from the geometry's REAL local AABB rotated into the
 * anchor's own frame — no per-recipe constant to drift, and it covers all 16
 * `roadside` call sites at once.
 */
const PROP_KERB_VERGE = 0.6;
/** Kerb width outside the asphalt edge (`CROSS.kerbW`). */
const PROP_KERB_W = 1.55;
/** How far outboard an anchor may be walked before the push is abandoned. */
const PROP_PUSH_LIMIT = 6;

/**
 * ===========================================================================
 *  THE CARRIAGEWAY GUARD — every guard in this file failed OPEN
 * ===========================================================================
 *  Measured on the shipping build (`.probe-tmp/roadintrude.ts`, which walks the
 *  eight world corners of every emitted instance against the drawn asphalt):
 *
 *      volcanoRush      Prop:obsidian  9.0 m inside an 11.0 m half-width road
 *                       at d=784 m / t=0.514 — i.e. on the centreline of a
 *                       222 m left-hander, rolled 34 deg. 5 x 6 x 3 m.
 *      sunsetCoastline  Prop:rock      1.6 m inside a 12.5 m half-width road
 *                       at d=1522 m / t=0.948.
 *
 *  Neither had any guard between it and the racing line, for two DIFFERENT
 *  reasons, which is why one fix has to sit where every prop passes:
 *
 *   * The obsidian shard is an AUTHORED `obsidianSpire` — placement #14 of the
 *     `t 0.62 -> 0.78, lat -32` run on the helix, confirmed by identity
 *     (`.probe-tmp/obsidiag.ts`: the emitted instance is 0.00 m from the
 *     authored anchor). The helix passes over the caldera chute, so at that XZ
 *     `field.heightAt()` is not ground — it is the chute's own baked road
 *     plane, 24 m above where the prop was authored. `collectAuthored()`
 *     re-seats anything outside its own corridor onto the heightfield, so the
 *     spire was lifted 23.4 -> 47.5 m and landed on a different carriageway.
 *     Then `buildVolcano()` claims it with `takeAuthored('obsidianspire')` —
 *     and `takeAuthored` removes it from the pending set, so `buildAuthored()`,
 *     the ONLY caller of `clearAuthored()` and `clearRoadSurface()`, never sees
 *     it. `clearKerb()` cannot help either: authored anchors carry `side: 0`
 *     and it returns false on the first line.
 *   * The coastal rock came from `annulus({ minRoadDist: 17 })`, which is also
 *     `side: 0`, so `clearKerb` skipped it too. Its ANCHOR is 4.4 m clear of
 *     the asphalt (`roadDistanceAt` 17.8) and only its cluster reaches in —
 *     the same "min is the clearance of the ANCHOR, not of the prop" mistake
 *     `PROP_KERB_VERGE` above was written for, one scatterer along.
 *
 *  So the rule is applied once, in `emit()`, from the REAL instance matrix, for
 *  every non-corridor prop whatever produced its anchor — and it FAILS CLOSED:
 *  a prop still standing on the drivable road after the push has been attempted
 *  is dropped. Dropping one shard out of 63 is invisible; a boulder on the
 *  centreline is what the owner has reported three times.
 *
 *  ---- IT HAS TO WORK IN THE ROAD'S OWN PLANE -------------------------------
 *  `PathStation.halfWidth` is the asphalt half-width measured ALONG THE BANKED
 *  SURFACE — `Track.getDecorationHints()` resolves a prop's `lat` with
 *  `position + binormal * lat` on the full 3-D binormal and compares that same
 *  `lat` against `halfWidth + kerbW + shoulder`. But `PathStation.bx/bz` is
 *  that binormal flattened into XZ and renormalised, so `roadVerge()` and
 *  `roadClearance()` — which take `Math.hypot(x - cx, z - cz)` and subtract
 *  `halfWidth` — compare a HORIZONTAL distance against a ROAD-PLANE width.
 *
 *  On the flat the two agree. On volcano's caldera chute, rolled 34 deg, an
 *  11.0 m half-width road is 11.0*cos(34) = 9.1 m wide in plan and its edge
 *  stands 6.2 m above the centreline, so the plan-frame test invents 1.9 m of
 *  road that is not there. Measured: it reports volcano's five authored
 *  `warningPost`s at `lat -12.5` as 0.9 m INSIDE a road they clear by 1.5 m.
 *
 *  That error is harmless where it only makes a PUSH more generous, which is
 *  the one thing `clearKerb`/`clearRoadSurface` do with it — so they are left
 *  alone. It is not harmless when the verdict is "delete this prop". So the
 *  guard below works from the two numbers the road mesh itself uses: a plan
 *  half-extent of `halfWidth * cos(roll)`, and a surface that rises `tanBank`
 *  per metre of horizontal lateral offset.
 * ===========================================================================
 */
/**
 * Penetration of the asphalt, in metres, that is tolerated before a prop counts
 * as standing on the carriageway.
 *
 * Chosen from the measured distribution rather than picked: across all six
 * circuits the closest thing to the road that is *meant* to be there is a
 * `tyreWall` at 1.0-2.0 m OUTSIDE the edge, and nothing else comes within 1.0 m
 * of it. So 0.35 m leaves 1.35 m of headroom under the nearest legitimate prop
 * while still catching a 1.6 m intrusion. (Same intent as `AUTHORED_ROAD_SLACK`,
 * an order of magnitude tighter, because that one guards a *push* and this one
 * guards a *drop*.)
 */
const PROP_ROAD_SLACK = 0.35;
/**
 * Vertical band around a carriageway, relative to its surface, in which a prop
 * is in the driver's way. Asymmetric, and applied to the prop's whole world
 * y-span rather than to one corner:
 *
 *  * below: volcano's `lavaFountain` is authored `lat 0, up -26`, deliberately
 *    under the broken bridge, and its glow tops out 5.7 m under the deck. Two
 *    metres is enough to cover a prop bedded into a verge that stands a little
 *    proud of the tarmac, and far too little to reach a deck.
 *  * above: eight metres clears a kart and anything it can fly over, and stops
 *    a prop on the basin floor being judged against a carriageway overhead.
 *
 * Using the SPAN means a prop tall enough to pass through a deck is caught even
 * though no single corner of it is level with the road.
 */
const PROP_ROAD_UNDER = 2.0;
const PROP_ROAD_OVER = 8.0;
/**
 * Skip radius for the guard: an anchor whose baked road distance exceeds
 * `maxHalfWidth + its own reach + this` cannot touch any carriageway, so it
 * never pays for the chord scan. Generous because `roadDistanceAt` is a
 * nearest-texel lookup that over-reports by up to a texel half-diagonal
 * (~3.5 m at the `low` tier) — see the note on `roadVerge` in WorldTextures.
 */
const PROP_ROAD_SKIP_PAD = 8;
/** Measured steps the push may take before the prop is dropped instead. */
const PROP_ROAD_STEPS = 3;

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
    uWinLit: { value: 0.42 },
  };

  /** 0 = midday, 1 = midnight. See `SKY_NIGHT`. */
  private night = 0;
  /** Resolved in `buildCity()`; `neon` for every non-city theme. */
  private kit: CityKit = CITY_KITS.neon;
  /** Built on demand by `facadeMat()` — one or two per circuit. */
  private facades = new Map<FacadeKind, THREE.MeshStandardMaterial>();
  /** Built on demand by `rockMat()`. */
  private rockMaterial: THREE.MeshStandardMaterial | null = null;
  /** Anchors `bedOnFootprint` refused because the ground was too broken. */
  private footprintRejects = 0;

  private matte!: THREE.MeshStandardMaterial;
  private matteSway!: THREE.MeshStandardMaterial;
  private metal!: THREE.MeshStandardMaterial;
  private glow!: THREE.MeshStandardMaterial;
  private glowSoft!: THREE.MeshStandardMaterial;
  private windows!: THREE.MeshStandardMaterial;
  /**
   * The DAYLIGHT window material: reflective glass, no emissive at all. Which of
   * the two a circuit gets is decided once, by sky preset, in `windowMat()`.
   */
  private windowsDay!: THREE.MeshStandardMaterial;
  private atlas!: THREE.MeshStandardMaterial;
  private atlasSway!: THREE.MeshStandardMaterial;
  /** Cloth on the FLAG atlas — see `makeFlagAtlas`. */
  private flagSway!: THREE.MeshStandardMaterial;
  private mastSway!: THREE.MeshStandardMaterial;
  private fence!: THREE.MeshStandardMaterial;

  private time = 0;
  /** Instances the road-volume guard removed this build — reported once. */
  private volumeDrops = 0;
  private volumePushes = 0;
  /** Roadside anchors `clearKerb()` walked outboard this build — reported once. */
  private kerbPushes = 0;
  /** Anchors the road-SURFACE guard moved off the asphalt — reported once. */
  private roadSurfacePushes = 0;
  private roadSurfaceWorst = 0;
  private roadSurfaceRefused = 0;
  private roadSurfaceTypes: string[] = [];
  /** Anchors the carriageway guard walked off the drivable road — reported once. */
  private carriagewayPushes = 0;
  /** Instances it DROPPED because they were still on the road afterwards. */
  private carriagewayDrops = 0;
  private carriagewayWorst = 0;
  private carriagewayTypes: string[] = [];
  private carriagewayPushTypes: string[] = [];
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
    this.night = nightFactorFor(ctx.hints.skyPreset);
  }

  /** True when lit windows belong on this circuit at all. */
  private get litWindows(): boolean { return this.night >= WINDOW_NIGHT_MIN; }

  /** Emissive glass after dark, reflective glass by day. Same window geometry. */
  private windowMat(): THREE.MeshStandardMaterial {
    return this.litWindows ? this.windows : this.windowsDay;
  }

  /**
   * A facade material, built on first use and cached per vocabulary, so a circuit
   * only pays for the kinds it actually shows. Defaults to the declared district's
   * kind; a recipe that is glass on a brick circuit (Boston's glass tower and its
   * minority skyline slabs) asks for `'curtain'` explicitly.
   *
   * `uvScale` on the recipe decides the world size of a tile — see `facadeTile`.
   */
  private facadeMat(kind: FacadeKind = this.kit.facade): THREE.MeshStandardMaterial {
    const hit = this.facades.get(kind);
    if (hit) return hit;
    // 768 on ultra, 512 below. A tile is 6.2-7.2 m of wall, so even 512 gives ~12 px
    // per brick course and ~5 px of mortar joint — more than enough at the distance
    // a background tower is ever seen from. The cost is on the CRITICAL PATH:
    // `RaceDirector.beginRace()` calls `Environment.syncToTrack()` during the
    // countdown, and the Sobel in `heightToNormal` is O(texels). Measured whole
    // `Environment.init` on Boston, the worst case because it is the only circuit
    // that builds two sets (masonry + curtain): at ultra 1774 ms with 1024 against
    // 1634 ms with 768; at high — the tier the game actually selects on this
    // machine — 618 ms with 512, against 852 ms for Sunset Coastline, which builds
    // no facade at all. So at the shipping tier this is inside the noise.
    const set = makeFacade(kind, this.quality.tier === 'ultra' ? 768 : 512);
    set.map.anisotropy = this.quality.anisotropy;
    this.textures.push(set.map, set.roughnessMap, set.normalMap);
    const m = new THREE.MeshStandardMaterial({
      name: `prop-facade-${kind}`,
      vertexColors: true,
      map: set.map,
      roughnessMap: set.roughnessMap,
      normalMap: set.normalMap,
      // Curtain wall is glass and metal; masonry and tile are dielectric. The
      // roughness map carries the per-texel detail, so this is only the ceiling.
      roughness: 1.0,
      metalness: kind === 'curtain' ? 0.45 : 0.04,
      envMapIntensity: kind === 'curtain' ? 1.35 : 0.85,
      normalScale: new THREE.Vector2(1.0, 1.0),
    });
    this.materials.push(m);
    const patched = patchProp(m, this.u);
    this.facades.set(kind, patched);
    return patched;
  }

  /** Metres of facade per uv tile — recipes set `uvScale = 1 / this`. */
  private facadeTileOf(kind: FacadeKind = this.kit.facade): number {
    return kind === 'curtain' ? 7.2 : 6.2;
  }

  private get facadeTile(): number { return this.facadeTileOf(); }

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
    if (this.footprintRejects > 0) {
      console.info(
        `[Props] footprint bedding: ${this.footprintRejects} anchors rejected for ground`
        + ' relief bigger than the instance standing on it (see bedOnFootprint)',
      );
    }
    if (this.kerbPushes > 0) {
      console.info(
        `[Props] kerb clearance: ${this.kerbPushes} roadside anchors walked outboard so their`
        + ` geometry leaves ${PROP_KERB_VERGE} m past the kerb (see clearKerb)`,
      );
    }
    if (this.carriagewayPushes || this.carriagewayDrops) {
      // Loud, and it should stay loud. A DROP is the guard failing closed on a
      // placement that has no legal home — an authored `lat` whose XZ lands on
      // another branch of the spline, or a scatter band narrower than the recipe
      // standing on it — and the real fix for each is in TrackDefs or in the
      // recipe. See the CARRIAGEWAY GUARD block.
      console.warn(
        `[Props] carriageway guard: ${this.carriagewayPushes} props walked off the drivable`
        + ` road (worst move ${this.carriagewayWorst.toFixed(2)} m)`
        + `${this.carriagewayPushTypes.length ? ` [${this.carriagewayPushTypes.join(', ')}]` : ''}`
        + `; ${this.carriagewayDrops} DROPPED because they were still on it`
        + `${this.carriagewayTypes.length ? `: ${this.carriagewayTypes.join(', ')}` : ''}`,
      );
    }
    this.poseMotionProps();
  }

  /**
   * ======================= THE FIFTH "BOX AT THE START LINE" ==================
   *
   * Pose every CPU-animated prop AS BUILT, before anything can draw it.
   *
   * `seagull` and `tram` are the only two recipes whose anchors are literally
   * `{ x: 0, y: 0, z: 0, yaw: 0, scale: 1 }`: their real transform is not a
   * placement at all, it is `updateGulls()` / `updateTrams()` recomputing a flight
   * path or a tramline every frame. An anchor of all zeros composes to the
   * IDENTITY matrix, and **on all three circuits the start/finish line is world
   * (0, 0, 0) with the road surface at y ≈ 0** — so until the first
   * `Props.update()` lands, three 3.20 × 4.76 × 7.06 m tram boxes (Neon) or 22
   * seagulls (Coastal) are stacked exactly on the line with their centres ON the
   * tarmac. Measured in the real grid-slot chase frame at 800 × 450: the tram is
   * **110 px tall, 24 % of its height under the road, and to the RIGHT of the
   * FINISH lettering** — which is where the owner has been pointing for five
   * playtests.
   *
   * And that state IS rendered, repeatedly:
   *   · `RaceDirector.beginRace()` calls `Environment.syncToTrack()` and
   *     deliberately does not await it, so a circuit change rebuilds the world
   *     *during* the countdown, with the camera parked on the grid looking
   *     straight down the road at the line;
   *   · `Environment.init()` reparents each layer into the LIVE scene as that
   *     layer finishes, but only sets `ready = true` after the last one;
   *   · `Environment.update()` opens with `if (!this.ready) return;` — so
   *     `Props.update()` is never called while the rebuild is in flight, even
   *     though the props are already in the scene and being drawn. Every frame
   *     between the Props stage landing and the Weather stage finishing shows
   *     them at the origin. (`.probe-tmp/p0g-line.ts --rebuild` counts those
   *     frames; the Crowd and Weather stages each bake procedural textures, so
   *     in the browser this is hundreds of milliseconds, not one frame.)
   *
   * Fixing it here rather than in `Environment` keeps the change inside this
   * file's own contract: a prop that has been built is a prop that is posed.
   * `dt = 0` means nothing is advanced — this writes precisely the transform
   * `update()` would have written on its first call, so the flight paths, the
   * tramline, the phases and the seeds are all bit-identical to before. It is a
   * visual correction only; neither recipe has any gameplay function.
   */
  private poseMotionProps(): void {
    for (const entry of this.meshes) {
      if (entry.motion === 'gull') this.updateGulls(entry, POSE_FRAME);
      else if (entry.motion === 'tram') this.updateTrams(entry, POSE_FRAME);
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
    // ---- SWAY AMPLITUDES ----------------------------------------------------
    // These were 0.55 / 0.50 / 0.80, and `Environment.THEME_WIND` gives a `city`
    // circuit a base of 0.18 gusting to 0.25. The product is what the cloth
    // actually does, and measured over 240 frames of the real update loop
    // (`.probe-tmp/flagmotion.ts`) the numbers were: national flag fly edge
    // 0.229 m peak-to-peak on a 2.7 x 1.8 m panel, checkered flag 0.144 m on a
    // 2.1 x 1.36 m one, start-line banner 0.166 m on a 4.4 m drop. Five to nine
    // per cent of the panel's own span is not cloth; it is a board with a tremor.
    // Raised so the fly edge sweeps 0.5-0.6 m, which is what a flag in a fresh
    // breeze does, and so a banner's free corner moves a readable amount.
    this.matteSway = patchProp(
      base({ name: 'prop-cloth', roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide }),
      this.u, { sway: 0.95, curl: 0.22 },
    );
    // A FLAG is not a parasol. `matteSway` also carries the beach parasols, the
    // moored boats' sails and the seagulls' wing tips, and giving those the
    // amplitude a flag needs makes a sunshade wobble like laundry. Flags get
    // their own copy of the same material with the flag amplitudes — one extra
    // `MeshStandardMaterial`, no extra draw call, because a draw call is per
    // MESH and the cloth passes were already separate meshes.
    this.mastSway = patchProp(
      base({ name: 'prop-mast-cloth', roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide }),
      this.u, { sway: 2.05, curl: 0.55 },
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
    // ---- WINDOWS: the day/night gate ---------------------------------------
    // `uWinLit` is the hash threshold for "this pane is lit", so the same window
    // geometry is a quarter lit at dusk and nearly three quarters lit at midnight.
    // Tokyo Neon needs the second of those: the critic measured its 78-tower
    // skyline contributing only +2.19 L to a frame with a mean of 28/255, and
    // hiding the tower bodies made the frame BRIGHTER by 1.28 — a night city that
    // is a net light sink. More lit panes and a hotter emissive is the only lever
    // Props has, because props do not add real lights.
    // BRIGHTNESS is proportional to the night factor and LIT FRACTION is not.
    // Those are different quantities: at golden hour a real city has a quarter of
    // its lights on and they are *dim against a bright sky*, so the count comes up
    // on a shallow curve while the radiance comes up linearly. An additive floor
    // here (`1.15 + 2.55 * night`) would have made sunset 38 % as bright as
    // midnight instead of the tenth Sky's curve actually asks for.
    this.u.uWinLit.value = 0.74 - 0.46 * this.night;
    this.windows = patchProp(
      base({
        name: 'prop-windows', roughness: 0.16, metalness: 0.55,
        emissive: 0xffffff,
        emissiveIntensity: WINDOW_EMISSIVE_NIGHT * this.night,
        envMapIntensity: 1.4,
      }),
      this.u, { windows: true },
    );
    // The daylight half of the gate. Reflective glass, ZERO emissive, per-pane
    // value variation from the same hash — which is what a real curtain wall does
    // at midday and what Boston should always have been showing.
    this.windowsDay = patchProp(
      base({
        name: 'prop-windows-day', roughness: 0.11, metalness: 0.88,
        // Multiplies the recipe's warm window vertex colour down to a cool
        // blue-grey, so the geometry does not have to change with the preset.
        color: 0x8c9cab,
        emissive: 0x000000, emissiveIntensity: 0, envMapIntensity: 1.7,
      }),
      this.u, { litDiffuse: true },
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
      this.u, { atlas: true, sway: 1.15, curl: 0.22 },
    );

    // A national flag is a bigger, slacker cloth than a sponsor banner, so it
    // gets its own sway amplitude; everything else is `atlasSway`'s recipe.
    const flags = makeFlagAtlas();
    flags.anisotropy = this.quality.anisotropy;
    this.textures.push(flags);
    this.flagSway = patchProp(
      base({ name: 'prop-flag-cloth', map: flags, roughness: 0.88, side: THREE.DoubleSide }),
      this.u, { atlas: true, sway: 2.05, curl: 0.55 },
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

    // Worst HORIZONTAL distance from the anchor to a box corner, whatever the
    // yaw — the radius the carriageway guard's cheap rejection needs. Taken from
    // the box rather than from `radius` above, because a bounding SPHERE is
    // centred on the geometry, not on the anchor, and understates the reach of
    // anything authored off its own origin.
    const guardReach = localBox
      ? Math.max(
        Math.hypot(localBox.max.x, localBox.max.z), Math.hypot(localBox.min.x, localBox.min.z),
        Math.hypot(localBox.max.x, localBox.min.z), Math.hypot(localBox.min.x, localBox.max.z),
      )
      : 0;

    const cull = o.cull ?? CULL_NEAR;
    const phase = new Float32Array(anchors.length);
    const cullAttr = new Float32Array(anchors.length);
    const atlasAttr = (o.atlasCells || o.atlasBaked) ? new Float32Array(anchors.length * 4) : null;
    const placed: Array<{ x: number; y: number; z: number }> = [];

    let n = 0;
    let blocked = 0;
    let onRoad = 0;
    let pushed = 0;
    const bounds = new THREE.Box3();
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      // Kerb clearance BEFORE the road-volume test, so a prop that is pushed
      // outboard is tested against the volumes at the place it will actually
      // stand. `corridor: true` recipes (gantry, portal, arch, deck pylon) belong
      // over the carriageway and are left where they are, and `o.place` callers
      // compose their own transform so the anchor is not the thing that moves.
      if (o.corridor !== true && !o.place && this.clearKerb(a, localBox)) this.kerbPushes++;
      if (o.corridor !== true && this.insideRoadVolume(a, localBox)) { blocked++; continue; }
      // ...and off the OPEN carriageway, which no volume describes. See the
      // CARRIAGEWAY GUARD block: `clearKerb` cannot reach an authored or
      // annulus anchor (`side: 0`), and `clearRoadSurface` only ever runs from
      // `buildAuthored()`, which never sees a group a theme builder claimed with
      // `takeAuthored`. Both of the intrusions this was written for fell through
      // exactly those two gaps. Push first — a prop the track asked for belongs
      // beside the road, not deleted — and only if that fails, drop.
      // `o.motion` recipes are exempt, and the reason is the whole point of the
      // FIFTH "BOX AT THE START LINE" note above: `seagull` and `tram` anchors
      // are literally `{ x: 0, y: 0, z: 0, yaw: 0, scale: 1 }`, a placeholder,
      // because their real transform is `updateGulls()` / `updateTrams()`
      // recomputing a flight path or a tramline every frame. World (0, 0, 0) is
      // the start/finish line on these circuits, so the guard read 22 seagulls
      // (Coastal) and 3 trams (Neon) as standing on the tarmac and walked them
      // off it — 25 of the 27 pushes in the whole game, worst move 13.89 m.
      //
      // Pushing a placeholder is at best wasted work and at worst a 13 m offset
      // applied to a tramline that is supposed to sit on visible rails. A prop
      // whose transform is recomputed every frame is not placed by its anchor,
      // so testing that anchor against the road cannot mean anything. Volcano's
      // obsidian — the boulder this guard exists for — is unaffected: it is a
      // real `roadside()` placement with no motion.
      if (o.corridor !== true && !o.place && !o.motion && localBox
        && !this.farFromRoad(a, guardReach * a.scale)) {
        if (this.pushOffCarriageway(a, localBox)) { this.carriagewayPushes++; pushed++; }
      }
      _m.identity();
      if (o.place) {
        if (!o.place(a, i, _m)) continue;
      } else {
        _q.setFromAxisAngle(_axisY, a.yaw);
        _m.compose(_v.set(a.x, a.y, a.z), _q, _s.setScalar(a.scale));
      }
      // FAIL CLOSED. Measured from the transform the instance will actually be
      // drawn with, so it is exact for `o.place` recipes too.
      //
      // `o.motion` is exempt here for the same reason it is exempt from the push
      // above, and getting this half-right is worse than not doing it at all: on
      // the first attempt only the push was exempted, so the flock and the trams
      // sailed past it and were then DELETED by this test instead — 22 seagulls
      // off Coastal and all 3 trams off Neon. The matrix composed above is the
      // identity for these recipes, because their anchor is a placeholder and
      // `updateGulls()` / `updateTrams()` writes the real transform on the first
      // `Props.update()`. Measuring that identity against the road measures the
      // start/finish line, not the prop.
      if (o.corridor !== true && !o.motion && localBox
        && !this.farFromRoad(a, guardReach * a.scale)
        && this.onCarriageway(a, localBox, _m)) {
        onRoad++;
        continue;
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
          // ---- THE ROW WAS UPSIDE DOWN, AND IT WAS INVISIBLE. ---------------
          // Two mechanisms in this file address the same 4x2 atlas and they
          // disagreed about v for all 8 cells:
          //
          //   `atlasRect(cell)`  v = 1 - cy/rows downward.  CORRECT, and now
          //       confirmed on screen twice over: the caption reads at the BOTTOM
          //       of a board, and the right start-line banner is authored
          //       `atlasRect(7)` and reads FOXY KART, which is cell 7's wordmark.
          //   this line          `floor(cell/cols)/rows`, v UPWARD.  Wrong.
          //
          // `makeSponsorAtlas` draws cell i at canvas y = floor(i/4)*ch, top-down,
          // and `canvasTexture` leaves three's `CanvasTexture` default flipY =
          // true (measured on the live texture: 2048x1024, flipY true). So canvas
          // row r lives at v in [1-(r+1)/rows, 1-r/rows] and this line was
          // selecting the OTHER row: every per-instance board displayed the
          // artwork of the cell four along from the one it picked.
          //
          // Nothing looked broken, which is exactly why it survived — all eight
          // cells are complete, upright, legible sponsor boards, so swapping two
          // rows just changes WHICH brand you see. What it silently broke is the
          // one property the owner actually asked for. `SPONSOR_PICK` gives the
          // owner's two brands 2 of 22 slots each ("not too densely"); with the
          // rows swapped those weights landed on VOLT and NITRO instead, and
          // CAPY LAB / TINY TRIP CLUB were drawn at the generic 13.6 % — half
          // again as often as requested. The row-agreement assertion in
          // `.probe-tmp/banners.ts` is what keeps the two mechanisms in step.
          atlasAttr[n * 4 + 1] = 1 - (Math.floor(cell / cols) + 1) / rows;
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
    if (onRoad > 0) {
      this.carriagewayDrops += onRoad;
      this.carriagewayTypes.push(`${name} x${onRoad}`);
    }
    if (pushed > 0) this.carriagewayPushTypes.push(`${name} x${pushed}`);
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
   * Walk a roadside anchor outboard until its GEOMETRY clears the kerb.
   *
   * Only `side !== 0` anchors qualify, which is exactly the set `roadside()`
   * produces — `annulus()`, `shoreline()`, the stand-derived passes and
   * `collectAuthored()` all set `side: 0` and are placed deliberately elsewhere.
   * That is a structural gate, not a list of prop names: a name-based exemption
   * list is how the half-buried start-line box survived five playtests.
   *
   * The reach toward the road is computed by rotating the local AABB's four
   * horizontal corners by the anchor's own yaw and taking the most negative
   * projection onto the outward direction. That is exact for an off-centre box
   * and for `faceRoad: false` passes with a random yaw, so it does not depend on
   * which of the two orientation conventions the recipe used.
   *
   * Returns false only if the clearance cannot be bought within
   * `PROP_PUSH_LIMIT`; the anchor is then left untouched and kept, because a prop
   * slightly close to the kerb is a smaller loss than a hole in the scenery.
   */
  private clearKerb(a: Anchor, bb: THREE.Box3 | null): boolean {
    if (a.side === 0 || bb === null) return false;
    const stations = this.ctx.stations;
    if (!stations.length) return false;
    const ca = Math.cos(a.yaw), sa = Math.sin(a.yaw);
    // local +X -> (cos, 0, -sin); local +Z -> (sin, 0, cos)
    const corners: Array<[number, number]> = [
      [bb.min.x, bb.min.z], [bb.max.x, bb.min.z],
      [bb.min.x, bb.max.z], [bb.max.x, bb.max.z],
    ];
    let x = a.x, z = a.z;
    let moved = 0;
    for (let it = 0; it < 4; it++) {
      const v = roadVerge(stations, x, z, this._verge);
      // How far the geometry reaches TOWARD the road from the anchor: the most
      // negative projection of a rotated corner onto the outward direction.
      let reach = 0;
      for (const [lx, lz] of corners) {
        const wx = (lx * ca + lz * sa) * a.scale;
        const wz = (-lx * sa + lz * ca) * a.scale;
        const proj = wx * v.outX + wz * v.outZ;
        if (-proj > reach) reach = -proj;
      }
      const short = PROP_KERB_W + PROP_KERB_VERGE + reach - v.verge;
      if (short <= 0.001) break;
      if (moved + short > PROP_PUSH_LIMIT) return false;
      x += v.outX * short;
      z += v.outZ * short;
      moved += short;
    }
    if (moved <= 0.001) return false;
    // These anchors were seated on the heightfield by `roadside()`, so the new
    // spot takes its height from the same surface. Water and slope were already
    // vetted at the old spot and a sub-metre step cannot plausibly cross either,
    // but a wet or sheer landing is refused rather than assumed away.
    const y = this.field.heightAt(x, z);
    if (y < this.ctx.waterLevel + 0.35) return false;
    if (this.field.slopeAt(x, z) > 0.62) return false;
    a.x = x;
    a.z = z;
    a.y = y;
    return true;
  }

  private readonly _verge: RoadVerge = { verge: 0, halfWidth: 11, outX: 1, outZ: 0 };

  /**
   * How far an oriented bounding box reaches INSIDE the drawn asphalt, past
   * `PROP_ROAD_SLACK`, in metres. Zero when it clears. `dir` receives the
   * horizontal unit direction that leads away from the offending carriageway.
   *
   * Works from the instance MATRIX rather than from the anchor, so it is exact
   * for `o.place` recipes that compose their own transform (the hay bale is
   * tipped 90 deg about X; the parked car is yawed a further 90 deg) as well as
   * for the plain yaw-and-scale path.
   *
   * Three things it does that the two older guards do not — see the CARRIAGEWAY
   * GUARD block for the measurements behind each:
   *
   *  1. **Road plane, not plan.** The asphalt covers `halfWidth * cos(roll)` in
   *     plan, and its surface rises `tanBank` per metre of horizontal offset.
   *  2. **Every branch, not the nearest.** It scans all chords, so a prop is
   *     judged against the carriageway it is LEVEL with. Volcano's helix runs
   *     directly over the caldera chute and neon's flyover over its own
   *     approach; a plan-only "nearest" answers for whichever happens to be
   *     closer in XZ, which is how a pylon 40 m under a deck reads as being in
   *     the road and a shard standing ON one reads as being clear.
   *  3. **The prop's whole y-span.** A prop tall enough to pass through a deck
   *     is caught even when no corner of it is level with the surface.
   */
  private roadBoxIntrusion(bb: THREE.Box3, m: THREE.Matrix4, dir: THREE.Vector3): number {
    const st = this.ctx.stations;
    const n = st.length;
    if (n < 2) return 0;
    let yLo = Infinity, yHi = -Infinity;
    for (let c = 0; c < 8; c++) {
      _roadV.set(
        c & 1 ? bb.max.x : bb.min.x,
        c & 2 ? bb.max.y : bb.min.y,
        c & 4 ? bb.max.z : bb.min.z,
      ).applyMatrix4(m);
      _roadCorners[c * 3] = _roadV.x;
      _roadCorners[c * 3 + 1] = _roadV.y;
      _roadCorners[c * 3 + 2] = _roadV.z;
      if (_roadV.y < yLo) yLo = _roadV.y;
      if (_roadV.y > yHi) yHi = _roadV.y;
    }
    let worst = 0;
    for (let c = 0; c < 8; c++) {
      const x = _roadCorners[c * 3], z = _roadCorners[c * 3 + 2];
      let bestLat = Infinity, inside = 0, ox = 0, oz = 0;
      for (let i = 0; i < n; i++) {
        const p = st[i], q = st[(i + 1) % n];
        const ex = q.px - p.px, ez = q.pz - p.pz;
        const len2 = ex * ex + ez * ez;
        if (len2 < 1e-6) continue;
        const t = clamp(((x - p.px) * ex + (z - p.pz) * ez) / len2, 0, 1);
        const dx = x - (p.px + ex * t), dz = z - (p.pz + ez * t);
        const lat = Math.hypot(dx, dz);
        if (lat >= bestLat) continue;
        const tanBank = p.tanBank + (q.tanBank - p.tanBank) * t;
        // Sign of the offset, for the cross-fall. The MAGNITUDE stays `lat`: the
        // binormal projection collapses toward zero where `t` clamps to a chord
        // end (the offset is then mostly along the road), and using it as a width
        // would report a prop 134 m off the circuit as 10.9 m inside it.
        let bx = p.bx + (q.bx - p.bx) * t, bz = p.bz + (q.bz - p.bz) * t;
        const bl = Math.hypot(bx, bz);
        if (bl > 1e-6) { bx /= bl; bz /= bl; }
        const roadY = p.py + (q.py - p.py) * t
          + (dx * bx + dz * bz >= 0 ? lat : -lat) * tanBank;
        if (yHi < roadY - PROP_ROAD_UNDER || yLo > roadY + PROP_ROAD_OVER) continue;
        bestLat = lat;
        const halfWidth = p.halfWidth + (q.halfWidth - p.halfWidth) * t;
        inside = halfWidth / Math.sqrt(1 + tanBank * tanBank) - lat - PROP_ROAD_SLACK;
        if (lat > 1e-4) { ox = dx / lat; oz = dz / lat; } else { ox = bx; oz = bz; }
      }
      if (inside > worst) { worst = inside; dir.set(ox, 0, oz); }
    }
    return worst;
  }

  /**
   * Compose the transform `emit()` will use for a plain (non-`place`) anchor.
   * Shared so the push below and the final verdict cannot disagree about what
   * they are measuring.
   */
  private anchorMatrix(a: Anchor, out: THREE.Matrix4): THREE.Matrix4 {
    _roadQ.setFromAxisAngle(_axisY, a.yaw);
    return out.compose(_roadV.set(a.x, a.y, a.z), _roadQ, _roadS.setScalar(a.scale));
  }

  /**
   * Walk an anchor off the drivable road. Returns true only when it ended up
   * CLEAR; anything short of that is rolled back so the drop below deletes a
   * prop from where its author put it rather than from somewhere this pass
   * shoved it on the way to deleting it anyway.
   *
   * At most `PROP_ROAD_STEPS` measured steps, each of which must strictly
   * improve on the last. That bound is the lesson `clearRoadSurface` records:
   * where two branches of the spline run close in XZ — the volcano switchbacks,
   * the neon flyover — pushing away from the nearer one moves the prop toward
   * the other, `roadBoxIntrusion` flips to that branch, and an unbounded loop
   * ping-pongs the anchor out to the limit. Requiring strict improvement makes
   * the first ping-pong the last.
   *
   * Only anchors that are standing on the HEIGHTFIELD are moved, the same test
   * `clearRoadSurface` makes: anything else has a `y` measured from a deck, a
   * bore or the water plane, and re-seating it after a lateral step would trade
   * one wrong answer for a worse one. An unmovable prop that is on the road is
   * simply dropped, which is the whole point of the guard.
   */
  private pushOffCarriageway(a: Anchor, bb: THREE.Box3): boolean {
    let over = this.roadBoxIntrusion(bb, this.anchorMatrix(a, _roadM), _roadDir);
    if (over <= 0) return false;
    let up = a.up;
    if (up === undefined) {
      if (Math.abs(a.y - this.field.heightAt(a.x, a.z)) > 0.25) return false;
      up = 0;
    }
    const ox = a.x, oy = a.y, oz = a.z;
    let moved = 0;
    for (let it = 0; it < PROP_ROAD_STEPS && over > 0; it++) {
      if (_roadDir.x === 0 && _roadDir.z === 0) break;
      const step = Math.min(over + 0.4, AUTHORED_PUSH_LIMIT - moved);
      if (step <= 0.01) break;
      const x = a.x + _roadDir.x * step;
      const z = a.z + _roadDir.z * step;
      const y = this.field.heightAt(x, z) + up;
      // A wet or sheer landing is refused rather than assumed away — the same two
      // conditions `clearKerb` applies to its own re-seat.
      if (y < this.ctx.waterLevel + 0.35) break;
      if (this.field.slopeAt(x, z) > 0.62) break;
      a.x = x; a.y = y; a.z = z;
      moved += step;
      const now = this.roadBoxIntrusion(bb, this.anchorMatrix(a, _roadM), _roadDir);
      if (now >= over) break;   // no progress, or it flipped to another branch
      over = now;
    }
    if (over > 0) { a.x = ox; a.y = oy; a.z = oz; return false; }
    this.carriagewayWorst = Math.max(this.carriagewayWorst, moved);
    return true;
  }

  /**
   * True when this prop is still standing on the drivable road, so `emit()`
   * should drop it. Memoised on the anchor — see `Anchor.onRoad`.
   *
   * `m` is the transform the instance will actually be drawn with.
   */
  private onCarriageway(a: Anchor, bb: THREE.Box3, m: THREE.Matrix4): boolean {
    if (a.onRoad !== undefined) return a.onRoad;
    const hit = this.roadBoxIntrusion(bb, m, _roadDir) > 0;
    a.onRoad = hit;
    return hit;
  }

  /**
   * Cheap rejection: an anchor this far from the baked centreline field cannot
   * touch any carriageway, whatever its orientation, so it never pays for the
   * chord scan. `reach` is the instance's bounding-sphere radius.
   */
  private farFromRoad(a: Anchor, reach: number): boolean {
    return this.field.roadDistanceAt(a.x, a.z)
      > this.ctx.maxHalfWidth + reach + PROP_ROAD_SKIP_PAD;
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
      // Sponsor banner hanging under the deck. `double` because this gantry is
      // yawed by convention 2 (local +Z = tangent = down-track), so the single +Z
      // sheet `banner()` used to emit was seen from behind by every approaching
      // driver and read mirrored — see the long note on `banner()`.
      // `CELL_FULL`, not `[0,0,1,1]`: an ascending v range put the artwork upside
      // down and the exact 0/1 ends were collapsed to one texel by the shader.
      const b = this.builder();
      b.banner(0, 11.2, -0.1, (hw + 1) * 2, 2.6, 0, 0xffffff, 6, CELL_FULL,
        { double: true, wave: 0.20 });
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
              bwd, 2.4, 0, 0xffffff, 5, atlasRect(k + 5), { wave: 0.17 });
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
      // ---- THIS WAS 20 SEPARATE FLAT QUADS. --------------------------------
      // Each cell was authored in the z = 0 plane with ONE `flap` value for the
      // whole cell, so the panel had five discrete steps of displacement across
      // its span and no curvature at all — a rigid checkerboard signboard on a
      // stick, 17 of them per circuit at the roadside, and the most likely thing
      // a player is looking at when they say the flags look like panels.
      // `mastCloth` with `cellHex` builds the same checkerboard on the same
      // rippled, drooping surface the national flags use, with `aFlap` graded per
      // vertex rather than per cell. 48 triangles instead of 20.
      f.mastCloth(0.1, 5.05, 0, 2.1, 1.36, 0, 0xffffff, 6, 4, undefined, {
        wave: 0.26, sag: 0.16,
        cellHex: (i, j) => ((i + j) % 2 ? 0xf4f2ec : 0x14171b),
      });
      this.emit('checkerFlag', f.build('checkerFlag'), this.mastSway, anchors,
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
      /**
       * ---- AND IT MUST NOT GO ON A BANKED CORNER EITHER. --------------------
       * The arch is built in a plane perpendicular to the tangent but it is NOT
       * banked with the road: its springing sits at centreline height while a
       * banked surface climbs toward the outside. Measured
       * (`.probe-tmp/overhead.ts`): volcanoRush arc 639, `tanBank` steep enough
       * that the road at lat -9.83 m stands ~4 m above the centreline plane, so the
       * low part of the arc cleared the tarmac by 0.26 m — a balloon on the racing
       * line. Rejecting banked stations is the same kind of site test the height
       * check already is, and it costs nothing: `siteNear` scans 40 stations forward
       * and every circuit has flat straight ones.
       */
      const siteNear = (frac: number, avoidArc = -1e9): PathStation => {
        const n0 = st.length;
        const i0 = Math.floor(n0 * frac);
        // SCAN THE WHOLE LAP, not 40 stations. Measured on volcanoRush: from the
        // 0.42 start point there are ZERO stations in the next 40 that are both
        // level and unbanked — the helix runs at `tanBank` -0.36 to -0.82 for
        // hundreds of metres — so a 40-station window always fell through to the
        // fallback and re-picked the banked station it was trying to avoid. There
        // are 28 acceptable stations on that lap; they are just further away, and an
        // arch's exact lap position is arbitrary dressing whereas a balloon on the
        // racing line is not.
        for (let pass = 0; pass < 3; pass++) {
          for (let k = 0; k < n0; k++) {
            const s = st[(i0 + k) % n0];
            if (Math.abs(s.py - this.field.heightAt(s.px, s.pz)) > 2.5) continue;
            // Pass 0: level and flat, and clear of the other arch. Pass 1 drops the
            // separation. Pass 2 drops the bank test, so a circuit banked from end
            // to end still gets its arches rather than losing them.
            if (pass < 2 && Math.abs(s.tanBank) > 0.10) continue;
            if (pass === 0 && Math.abs(s.s - avoidArc) < 200) continue;
            return s;
          }
        }
        return st[i0];
      };
      const siteA = siteNear(0.42);
      const sites = [siteA, siteNear(0.72, siteA.s)];
      const arches: Anchor[] = sites.map((s) => ({
        x: s.px, y: s.py, z: s.pz,
        yaw: Math.atan2(s.tx, s.tz), side: 0, arc: s.s, scale: 1, seed: rng.next(),
      }));
      const b = this.builder();
      // ---- A BALLOON WAS SITTING ON THE RACING LINE. -------------------------
      // `span` was `hw + 3` where `hw` is the half-width AT THE START LINE, but the
      // arch stands at t = 0.42 and 0.72, where the road can be wider. Measured
      // (`.probe-tmp/overhead.ts`): volcanoRush arc 639, the end balloon of
      // `Prop:balloonArch` 0.26 m above the drawn road at lat -9.83 m, i.e. inside
      // the drivable width — a kart drives through it. `balloonArch` is a
      // `corridor: true` emit, so no clearance guard would ever have caught it;
      // this is the same class of error as the `alleyBlock` at lat 10.5 and the
      // `min: 4` obsidian, a constant standing in for a variable.
      // One geometry serves both anchors, so it takes the WIDER of the two sites.
      const span = Math.max(...sites.map((s) => s.halfWidth)) + 3.5;
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
      // ---- THE POST WAS BEING PAINTED WITH SPONSOR ARTWORK. -----------------
      // Post and face used to be ONE geometry on `this.atlas` with
      // `atlasCells: 8`. `prism()` writes TILING uvs in world metres (u runs to
      // `r * 6 * uvScale`, v to `h * uvScale`), and `patchProp`'s atlas remap put
      // every one of them through a cell — so a 2.4 m signpost was surfaced with
      // chopped-up fragments of a sponsor board, and once the remap stopped
      // wrapping it would have become one flat clamped edge colour, which is worse.
      // Measured by `.probe-tmp/mirror.ts`: 29 of `roadSign`'s uvs outside the
      // cell, worst u = -0.048, v = 1.44. The post belongs on `this.metal` with the
      // shared detail normal, exactly as `boardFrame` sits beside `sponsorBoard`.
      // One extra draw call per circuit.
      const post = this.builder();
      post.prism(0, 0, 0, 0.08, 2.4, 6, 0x8f959d, { capBottom: true });
      post.box(0, 2.6, -0.02, 0.78, 0.54, 0.04, 0x5c636b);
      this.emit('roadSignPost', post.build('roadSignPost'), this.metal, anchors, { cull: 200 });
      const b = this.builder();
      // v top-first (see `atlasRect()` note) so the sign face isn't flipped.
      b.plate(0, 2.6, 0.05, 1.5, 1.0, 0, 0xffffff, { uvRect: [0.05, 0.9, 0.95, 0.1] });
      this.emit('roadSign', b.build('roadSign'), this.atlas, anchors,
        { cull: 200, atlasCells: 8, shadow: false });
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
      // The moored boat's sail was the same flat quad the `sailboat` recipe had:
      // one `plate()` with a CONSTANT `flap` of 0.8, so all four vertices moved
      // together and a 1.4 x 2.6 m rectangle swung as a board. `mastCloth` with
      // camber, pinned on the mast and running aft (+Z is astern here — the prow
      // quad is at -Z), gives it a belly, a graded flap and a boom to sit on.
      b.tube(0, 1.42, -0.3, 0, 1.36, 2.2, 0.045, 4, 0xb8a98c);
      b.mastCloth(0, 4.50, -0.35, 2.5, 3.1, Math.PI * 0.5, 0xf6f3ea,
        5, 3, undefined, { double: true, bow: 0.42 });
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

  /**
   * Resolve the circuit's declared district vocabulary and consume the marker.
   *
   * `takeAuthored` removes the anchors from the pending set, so `buildAuthored`
   * never sees them and `authoredSpec` never needs a `district` case: the marker
   * produces no geometry by design. It is a declaration, not a prop.
   */
  private resolveKit(): CityKit {
    for (const id of ['brick', 'midrise', 'tokyo', 'hongkong', 'newyork'] as const) {
      if (this.takeAuthored(`district:${id}`).length > 0) return CITY_KITS[id];
    }
    return CITY_KITS.neon;
  }

  private buildCity(): void {
    const ctx = this.ctx, rng = this.rng;
    const kit = this.kit = this.resolveKit();

    // ---- background towers ---------------------------------------------------
    {
      const anchors = annulus(ctx, rng, {
        count: this.count(kit.towers), min: 90, max: 620, minRoadDist: 58, maxSlope: 0.42,
      });
      for (const a of anchors) a.scale = 0.7 + rng.next() * 1.5;
      // Fold the track's authored towers into this same InstancedMesh instead of
      // building a second copy of identical geometry — one draw call serves both.
      // This is what `takeAuthored` was written for; nothing had ever called it.
      // Appended AFTER the scale jitter above so an authored `scale: 1.6`
      // survives rather than being overwritten by it.
      anchors.push(...this.takeAuthored('skyscraper'));

      // Boston splits its skyline: brick-and-limestone commercial blocks with a
      // minority of dark glass slabs. Two body meshes, but the window pass is
      // shared and the whole thing still fits inside the same instance budget as
      // the single generic tower it replaces.
      const slabs: Anchor[] = [];
      if (kit.slabShare > 0) {
        for (let i = anchors.length - 1; i >= 0; i--) {
          if (anchors[i].seed < kit.slabShare) slabs.push(...anchors.splice(i, 1));
        }
      }
      const H = TOWER_H;
      const pose = (a: Anchor, m: THREE.Matrix4): boolean => {
        _q.setFromAxisAngle(_axisY, a.yaw);
        _s.set(0.75 + a.seed * 0.7, a.scale, 0.75 + (1 - a.seed) * 0.7);
        m.compose(_v.set(a.x, a.y + H * 0.5 * a.scale, a.z), _q, _s);
        return true;
      };

      const body = this.builder();
      body.uvScale = 1 / this.facadeTile;
      switch (kit.id) {
        case 'brick': this.towerMasonry(body); break;
        case 'midrise': this.towerMidRise(body); break;
        case 'tokyo': this.towerScreenSlab(body); break;
        case 'hongkong': this.towerPodium(body); break;
        case 'newyork': this.towerZiggurat(body); break;
        default: this.towerSetback(body); break;
      }
      const towerGeo = body.build('tower');
      // ---- FOLDED ANCHORS WERE SKIPPING THE ROAD-SURFACE GUARD. -------------
      // `buildAuthored()` runs `clearAuthored` + `clearRoadSurface` over every
      // authored group before it emits. Anything claimed by `takeAuthored()` never
      // reaches `buildAuthored`, so the authored `skyscraper` run folded in above
      // was never tested against the drawn road at all. Closing that hole, on the
      // same anchors array every companion pass below reads, so the window grid and
      // the shopfront band move with the body.
      //
      // BE CLEAR ABOUT WHAT THIS DOES NOT FIX. Measured: it pushes ZERO anchors on
      // all six circuits today, and in particular it does NOT fix the case that
      // found it. neonMetropolis crosses over itself and authors `skyscraper` at
      // `lat: 84`; measured against the OTHER branch (`.probe-tmp/overhead.ts`) four
      // tower instances and a flood mast stand at lat 4.5-9.6 m and poke through the
      // elevated carriageway at arc 853-873 with 1.0-1.1 m of clearance. This guard
      // cannot see that, for the reason its own doc comment gives: it is an XZ test,
      // so it projects onto the NEAREST branch — the one at ground level, which the
      // tower genuinely clears. The guard for a prop under a deck is
      // `insideRoadVolume`, and it does not fire because that flyover is not
      // published in `roadVolumes` at those stations. Needs TrackBuilder to publish
      // the elevated section, or the track author to move that `lat` run; reported
      // rather than papered over. (Not caused by the re-seating change above:
      // re-seating only moves Y, and these towers were already at this XZ — they
      // were floating at deck height instead of standing in the road.)
      {
        const off = this.clearRoadSurface(anchors, towerGeo);
        const offS = slabs.length ? this.clearRoadSurface(slabs, towerGeo) : 0;
        if (off + offS > 0) {
          this.roadSurfacePushes += off + offS;
          this.roadSurfaceTypes.push(`tower:${kit.id} x${off + offS}`);
        }
      }
      this.emit(kit.id === 'neon' ? 'skyscraper' : `tower:${kit.id}`,
        towerGeo, this.facadeMat(), anchors,
        { cull: CULL_FAR, place: (a, _i, m) => pose(a, m) });

      if (slabs.length) {
        // The glass minority takes the CURTAIN facade even on a brick circuit —
        // a masonry brick map on a glass slab would be the same "wrong prop in the
        // wrong place" the file warns about, one layer down.
        const s = this.builder();
        s.uvScale = 1 / this.facadeTileOf('curtain');
        this.towerGlassSlab(s);
        this.emit(`tower:${kit.id}:slab`, s.build('towerSlab'), this.facadeMat('curtain'), slabs,
          { cull: CULL_FAR, place: (a, _i, m) => pose(a, m) });
      }

      // ---- the window pass, and the gate that decides what it is made of ----
      // Same geometry either way. At night it is emissive glass on `this.windows`;
      // by day it is reflective glass with zero emissive on `this.windowsDay`.
      // Boston used to get the night material under a midday sky.
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
      const winAnchors = slabs.length ? [...anchors, ...slabs] : anchors;
      this.emit('skyscraperWindows', w.build('windows'), this.windowMat(), winAnchors,
        {
          cull: CULL_FAR, bloom: this.litWindows, shadow: false,
          place: (a, _i, m) => pose(a, m),
        });

      // ---- the shopfront band ------------------------------------------------
      // A night city street is lit from the ground floor up, and the critic proved
      // the towers were taking more light out of the frame than they put in. This
      // is a 3.4 m emissive band round the base of every background tower — the
      // biggest single lit area available, and it sits at eye level rather than
      // 40 m up where the window grid is.
      if (kit.plinthGlow && this.litWindows) {
        const g = this.builder();
        // `this.glow` multiplies emissive by the VERTEX COLOUR, so dimming these
        // toward black is how the band comes up "a tenth at golden hour" without
        // touching the shared glow material — which also carries the neon signs,
        // the traffic lamps and the balloon arch, none of which want scaling here.
        // Linear in the night factor, the same rule as the window emissive above,
        // so Sky's "a tenth at golden hour" means a tenth here too.
        const dim = (c: number): number => mixHex(0x000000, c, this.night);
        const cols = [0xffd8a4, 0xd8f4ff, 0xffc6e2, 0xfff0b0].map(dim);
        for (let s = 0; s < 4; s++) {
          const yaw = s * Math.PI * 0.5;
          const ca = Math.cos(yaw), sa = Math.sin(yaw);
          for (let i = -1; i <= 1; i++) {
            g.cell = s * 3 + i + 1;
            const off = i * 6.6;
            g.plate(ca * off + sa * 10.95, -H * 0.5 + 1.5, sa * off - ca * 10.95,
              5.6, 2.6, yaw + Math.PI, cols[(s + i + 3) % cols.length], { single: true });
          }
        }
        // TOKYO: the screens and the signage crown. This is the emissive AREA the
        // frame was missing — two 9 x 18 m screens and a lit crown box per tower,
        // against a window grid of 1.75 x 1.35 m panes. `cell` keeps advancing so
        // the per-instance hash varies which screens are on.
        if (kit.id === 'tokyo') {
          const screen = [0x2ef0ff, 0xff3d8a, 0xffe23a, 0x7dff9e].map(dim);
          for (const sx of [1, -1]) {
            g.cell = 40 + (sx > 0 ? 0 : 1);
            g.plate(sx * 9.9, H * 0.16, 0, 6.2, H * 0.38, sx > 0 ? Math.PI * 0.5 : -Math.PI * 0.5,
              screen[sx > 0 ? 0 : 1], { single: true });
          }
          for (let s = 0; s < 4; s++) {
            g.cell = 44 + s;
            const yaw = s * Math.PI * 0.5;
            const ca = Math.cos(yaw), sa = Math.sin(yaw);
            g.plate(sa * 5.5, H * 0.5 + 3.1, -ca * 5.5, 8.4, 1.5, yaw + Math.PI,
              screen[(s + 2) % screen.length], { single: true });
          }
        }
        g.cell = 0;
        this.emit('towerShopfront', g.build('towerShopfront'), this.glow, winAnchors,
          { cull: 520, bloom: true, shadow: false, place: (a, _i, m) => pose(a, m) });
      }
    }

    // ---- neon signage --------------------------------------------------------
    // Three vocabularies, and Boston gets none of them. The authored `neonSign`
    // run is claimed here whatever the kit, so a track that authors neon on a
    // brick circuit loses it rather than getting the wrong recipe silently.
    {
      const authored = this.takeAuthored('neonsign');
      if (kit.neonRing > 0) {
        const anchors = roadside(ctx, rng,
          { spacing: 46, min: 9, max: 22, sides: 2, limit: this.count(kit.neonRing) });
        if (kit.neonStack === 0) anchors.push(...authored);
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
      if (kit.neonStack > 0) {
        // Stacked shophouse signage: a column of boards bracketed off a wall,
        // reading vertically. This is the Taipei and Tokyo street read, and it is
        // deliberately a different silhouette from the ring masts so the two
        // cities cannot be confused at a glance.
        const anchors = roadside(ctx, rng,
          { spacing: 31, min: 6.5, max: 15, sides: 2, limit: this.count(kit.neonStack) });
        anchors.push(...authored);
        const b = this.builder();
        b.uvScale = 0.9;
        b.prism(0, 0, 0, 0.1, 7.2, 6, 0x2a2e34, { capBottom: true, taper: 0.7 });
        for (let i = 0; i < 4; i++) {
          const y = 2.2 + i * 1.28;
          b.box(0.34, y, 0, 0.36, 0.5, 0.07, 0x1b1e23);      // bracket
          b.box(0.9, y, 0, 0.28, 0.56, 0.13, 0x14171b);       // board carcass
        }
        this.emit('signStack', b.build('signStack'), this.metal, anchors, { cull: 320 });

        const g = this.builder();
        const cols = kit.id === 'midrise'
          ? [0xff4a3a, 0xffd23a, 0x3affc8, 0xff8ad0, 0xfff3d0]
          : [0xff2e88, 0x2ef0ff, 0xffe23a, 0x8b5cff, 0x39ff88];
        for (let i = 0; i < 4; i++) {
          const y = 2.2 + i * 1.28;
          g.cell = i;
          // The lit face of each board, both sides, plus a hot edge tube so the
          // sign still reads when seen end-on down the street.
          g.plate(0.9, y, 0.145, 0.5, 0.98, 0, cols[i % cols.length], { single: true });
          g.plate(0.9, y, -0.145, 0.5, 0.98, Math.PI, cols[(i + 2) % cols.length], { single: true });
          g.box(0.9, y + 0.3, 0, 0.3, 0.035, 0.15, cols[(i + 1) % cols.length]);
        }
        g.cell = 0;
        this.emit('signStackGlow', g.build('signStackGlow'), this.glow, anchors,
          { cull: 320, bloom: true, shadow: false });
      }
    }

    // ---- streetlights --------------------------------------------------------
    //
    // `min: 2.6` was the single worst thing the driver sees from the edge of the
    // road on neon. Measured with the eye at 0.85 of the half-width
    // (`.probe-tmp/edgefill.ts`): 2.69 % of the frame on the left and 3.09 % on
    // the right, across 84-87 of 155 stations, with the nearest instance leaving
    // **0.6 m** of verge. Nothing else on the circuit is both that close and
    // that relentless — a 9 m mast every 27 m on both sides, and at 0.6 m of
    // clearance it sweeps past the camera at kart height rather than reading as
    // street furniture. 5.5-8.0 m still puts them on the pavement (the authored
    // `streetLamp` runs sit at lat 17-18) without them brushing the kerb.
    {
      const anchors = roadside(ctx, rng, { spacing: 27, min: 5.5, max: 8.0, sides: 2, limit: this.count(70) });
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
        spacing: 22, min: 7, max: 15, sides: 2,
        limit: this.count(kit.parkedCars), skipNearStands: this.stands,
      });
      const paints = kit.carPaints;
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
    // Neon Metropolis only. A cable car strung over the city is that circuit's own
    // conceit, and "same trams" was one of the three things the critic named when
    // it could not tell Boston apart from it.
    {
      const st = ctx.stations;
      const trams = kit.trams;
      if (trams > 0 && st.length > 40) {
        const anchors: Anchor[] = [];
        for (let i = 0; i < trams; i++) {
          anchors.push({ x: 0, y: 0, z: 0, yaw: 0, side: 0, arc: 0, scale: 1, seed: i / trams });
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
          const data = new Float32Array(trams * 5);
          for (let i = 0; i < trams; i++) {
            data[i * 5] = (i / trams) * ctx.lapLength;   // arc position
            data[i * 5 + 1] = 9.5 + i * 1.5;            // height above ground
            data[i * 5 + 2] = 24 + i * 6;               // lateral offset
            data[i * 5 + 3] = 11 + i * 2.5;             // speed m/s
            data[i * 5 + 4] = i % 2 === 0 ? 1 : -1;     // side
          }
          entry.data = data;
        }
      }
    }

    this.buildRocks(this.count(14), kit.rock[0], kit.rock[1], 0.8);
  }

  // -------------------------------------------------------------------------
  //  The four background-tower vocabularies
  // -------------------------------------------------------------------------
  //  All four are `TOWER_H` tall about a centred origin and no more than
  //  ±10.95 m across, because `buildCity`'s `pose()` lifts every one of them by
  //  `TOWER_H * 0.5 * scale` and the window pass and the shopfront band are built
  //  to those same numbers. Change the height here and all three passes move.
  //
  //  Every one is built on the KIT'S FACADE MATERIAL, so the vertex colours below
  //  are the hue and the facade map supplies the brick courses, the tile grout or
  //  the mullion grid. That is the fix for `map: false, roughnessMap: false` on a
  //  46 m surface, and it is why these colours are lighter than the near-black
  //  `0x50565f / 0x585f68 / 0x4a5058 / 0x33383e` they replace: a texture that
  //  multiplies a near-black vertex colour is still near-black.

  /** Neon Metropolis, unchanged silhouette: three setbacks, crown and mast. */
  private towerSetback(b: Builder): void {
    const H = TOWER_H;
    const facade = 0x6b737e;
    b.box(0, 0, 0, 9.5, H * 0.5, 9.5, facade, { shade: { side: 1.0, top: 1.1 } });
    b.box(0, H * 0.5, 0, 7.6, H * 0.28, 7.6, 0x737b87);
    b.box(0, H * 0.5 + H * 0.56, 0, 5.6, H * 0.13, 5.6, 0x646c78);
    b.box(0, H * 0.5 + H * 0.82, 0, 3.0, 1.2, 3.0, 0x4d545d);
    b.prism(0, H * 0.5 + H * 0.82 + 1.2, 0, 0.16, 7.5, 6, 0x9aa1a9, { taper: 0.35 });
    b.box(0, -H * 0.5, 0, 10.4, 2.2, 10.4, 0x3f454c, { shade: { top: 1.0 } });
    b.box(0, -H * 0.5 + 2.4, 0, 10.9, 0.16, 10.9, 0x33383e);
    for (let i = -4; i <= 4; i++) {
      b.box(i * 2.35, 0, 9.55, 0.16, H * 0.5, 0.1, 0x848c96);
      b.box(9.55, 0, i * 2.35, 0.1, H * 0.5, 0.16, 0x848c96);
      b.box(i * 2.35, 0, -9.55, 0.16, H * 0.5, 0.1, 0x848c96);
      b.box(-9.55, 0, i * 2.35, 0.1, H * 0.5, 0.16, 0x848c96);
    }
  }

  /**
   * BOSTON. A brick-and-limestone commercial block: granite base, brick shaft
   * with limestone corner quoins, a projecting cornice, a stepped parapet and a
   * roof water tank. No mast, no crown lights — the silhouette is masonry, so it
   * cannot be mistaken for the neon setback tower even in a black-and-white
   * thumbnail, which was the test it was failing.
   */
  private towerMasonry(b: Builder): void {
    const H = TOWER_H;
    const brick = 0xa06450, brickAlt = 0x8f5644, stone = 0xd8cfbe;
    // Granite base, two courses, each stepped in — a chamfer read at the ground.
    b.box(0, -H * 0.5 + 1.1, 0, 10.6, 1.1, 10.6, 0xa9a49a, { shade: { top: 1.08 } });
    b.box(0, -H * 0.5 + 3.0, 0, 10.1, 0.8, 10.1, 0xbdb8ad, { shade: { top: 1.12 } });
    b.box(0, -H * 0.5 + 4.2, 0, 9.8, 0.4, 9.8, stone, { shade: { top: 1.16 } });
    // Brick shaft, very slightly battered so the silhouette is not a pure prism.
    b.box(0, 1.2, 0, 9.5, H * 0.5 - 3.0, 9.5, brick,
      { taper: 0.985, shade: { side: 1.0, top: 1.06 } });
    // Limestone quoins on all four corners: the vertical accent masonry has and
    // curtain wall does not, and a chamfer where a bare box would have a hard 90.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.box(sx * 9.1, 1.2, sz * 9.1, 0.9, H * 0.5 - 3.2, 0.9, stone,
          { yaw: Math.PI * 0.25, taper: 0.985 });
      }
    }
    // A limestone belt course every four storeys — the horizontal rhythm.
    for (let i = 1; i <= 3; i++) {
      const y = -H * 0.5 + 4.2 + i * (H - 8) * 0.25;
      b.box(0, y, 0, 9.7, 0.26, 9.7, stone, { shade: { top: 1.14 } });
    }
    // Projecting cornice + dentil course, then a stepped parapet.
    b.box(0, H * 0.5 - 1.5, 0, 10.3, 0.55, 10.3, stone, { shade: { top: 1.2 } });
    b.box(0, H * 0.5 - 0.7, 0, 9.9, 0.3, 9.9, 0xc6bda9);
    b.box(0, H * 0.5 + 0.5, 0, 9.2, 0.9, 9.2, brickAlt, { shade: { top: 1.1 } });
    b.box(0, H * 0.5 + 1.6, 0, 6.4, 0.7, 6.4, brickAlt, { shade: { top: 1.14 } });
    // Rooftop water tank on a steel frame, and a stair bulkhead. Boston roofs.
    b.prism(3.2, H * 0.5 + 2.3, -2.4, 1.7, 3.2, 9, 0x7d6a56, { shade: { top: 1.18 } });
    b.prism(3.2, H * 0.5 + 5.5, -2.4, 1.7, 1.1, 9, 0x6b5946, { taper: 0.1 });
    for (const sx of [-1, 1]) {
      b.box(3.2 + sx * 1.4, H * 0.5 + 1.6, -2.4, 0.14, 0.7, 0.14, 0x4a4038);
    }
    b.box(-3.4, H * 0.5 + 3.2, 2.6, 2.0, 1.6, 1.6, brickAlt, { shade: { top: 1.12 } });
  }

  /**
   * BOSTON's minority: a sheer dark-glass slab, far thinner than the masonry
   * block, so the skyline has two masses in it rather than one repeated one.
   */
  private towerGlassSlab(b: Builder): void {
    const H = TOWER_H;
    const glass = 0x5a7f96;
    b.box(0, 0, 0, 10.2, H * 0.5, 5.2, glass,
      { taper: 0.98, shade: { side: 1.0, top: 1.16 } });
    b.box(0, -H * 0.5 + 1.4, 0, 10.9, 1.4, 6.0, 0x9aa4ad, { shade: { top: 1.06 } });
    b.box(0, -H * 0.5 + 3.0, 0, 11.4, 0.16, 6.6, 0x7d878f);
    b.box(0, H * 0.5 + 0.45, 0, 10.0, 0.45, 5.1, 0xd6dde3, { shade: { top: 1.24 } });
    // Corner returns in a lighter metal, which is what stops a slab reading flat.
    for (const sx of [-1, 1]) {
      b.box(sx * 10.3, 0, 0, 0.22, H * 0.5, 5.3, 0xaeb8c0, { taper: 0.98 });
    }
  }

  /**
   * TAIPEI. A narrow tiled mid-rise with continuous balconies, roof water tanks
   * and a bamboo-scaffold parapet. Deliberately SHORTER in proportion and busier
   * in silhouette than either tower above, so a wall of these reads as dense city
   * rather than as a downtown skyline.
   */
  private towerMidRise(b: Builder): void {
    const H = TOWER_H;
    const tileA = 0xbfb8ab, tileB = 0xa8a79e, trim = 0x8d8b82;
    // Shorter shaft: the top third is roof clutter instead of building.
    const shaft = H * 0.5 - 6.5;
    b.box(0, -3.0, 0, 8.6, shaft, 7.4, tileA, { shade: { side: 1.0, top: 1.08 } });
    b.box(0, -H * 0.5 + 2.0, 0, 9.4, 2.0, 8.2, 0x6e6a62, { shade: { top: 1.04 } });
    b.box(0, -H * 0.5 + 4.3, 0, 9.9, 0.2, 8.7, 0x54514a);
    // A balcony slab per two storeys, on the two long faces. This is the read.
    const bays = 6;
    for (let i = 0; i < bays; i++) {
      const y = -H * 0.5 + 6.4 + i * ((shaft * 2 - 4.4) / bays);
      for (const sz of [1, -1]) {
        b.box(0, y, sz * 7.9, 8.4, 0.13, 0.62, trim, { shade: { top: 1.18 } });
        b.box(0, y + 0.55, sz * 8.45, 8.4, 0.55, 0.07, 0x9aa0a4);
      }
      b.box(0, y, 0, 8.75, 0.11, 7.55, tileB);
    }
    // A service riser and a vertical vent stack up one corner.
    b.box(-8.2, -3.0, 3.2, 0.7, shaft, 1.5, tileB, { shade: { top: 1.1 } });
    // Roof: parapet, three water tanks, a stair house and a slim aerial.
    const rt = -3.0 + shaft;
    b.box(0, rt + 0.3, 0, 8.8, 0.3, 7.6, trim, { shade: { top: 1.2 } });
    b.box(0, rt + 1.1, 0, 8.5, 0.8, 7.3, tileB, { taper: 0.99, shade: { top: 1.06 } });
    for (let i = 0; i < 3; i++) {
      const x = -4.2 + i * 4.2;
      b.prism(x, rt + 1.9, -2.0, 1.25, 2.1, 10, 0x9ba7ac, { shade: { top: 1.16 } });
      b.prism(x, rt + 4.0, -2.0, 1.25, 0.5, 10, 0x7f8b90, { taper: 0.3 });
    }
    b.box(3.0, rt + 3.2, 3.0, 1.9, 2.2, 1.9, tileA, { shade: { top: 1.12 } });
    b.prism(-3.4, rt + 2.0, 3.2, 0.11, 6.5, 5, 0x6d7276, { taper: 0.5 });
  }

  /**
   * TOKYO. Dark curtain wall carrying full-height screen panels and a crown of
   * box signage. The screens and the crown are on the GLOW pass built inside
   * `buildCity`; what is here is the mass they hang on, kept a mid grey-blue
   * rather than the old near-black so a lit facade has something to be lit.
   */
  private towerScreenSlab(b: Builder): void {
    const H = TOWER_H;
    const wall = 0x6d7683, spandrel = 0x5a6270;
    b.box(0, 0, 0, 9.5, H * 0.5, 9.5, wall, { taper: 0.99, shade: { side: 1.0, top: 1.12 } });
    b.box(0, -H * 0.5 + 1.8, 0, 10.6, 1.8, 10.6, 0x474e5a, { shade: { top: 1.04 } });
    b.box(0, -H * 0.5 + 4.0, 0, 11.0, 0.2, 11.0, 0x394049);
    // Screen surrounds: a raised bezel on two faces, which is what makes the
    // emissive panel read as a mounted screen instead of a glowing wall.
    for (const sx of [1, -1]) {
      b.box(sx * 9.62, H * 0.16, 0, 0.2, H * 0.20, 6.4, spandrel);
      b.box(sx * 9.72, H * 0.16 + H * 0.21, 0, 0.3, 0.32, 6.8, 0x2f353d);
      b.box(sx * 9.72, H * 0.16 - H * 0.21, 0, 0.3, 0.32, 6.8, 0x2f353d);
    }
    // Setback + a signage crown box, then the mast.
    b.box(0, H * 0.5 + 1.0, 0, 7.0, 1.0, 7.0, spandrel, { shade: { top: 1.1 } });
    b.box(0, H * 0.5 + 3.1, 0, 5.4, 1.1, 5.4, 0x3b4249, { shade: { top: 1.16 } });
    b.prism(0, H * 0.5 + 4.2, 0, 0.18, 9.0, 6, 0x9aa1a9, { taper: 0.3 });
    for (let i = -4; i <= 4; i++) {
      b.box(i * 2.35, 0, 9.58, 0.18, H * 0.5, 0.12, 0x8b95a2, { taper: 0.99 });
      b.box(i * 2.35, 0, -9.58, 0.18, H * 0.5, 0.12, 0x8b95a2, { taper: 0.99 });
    }
  }

  /**
   * HONG KONG. The podium-and-tower type: a wide banded podium — retail below,
   * car park above, the whole thing a solid block out to the lot line — with a
   * much SLIMMER residential shaft rising out of the middle of it, gridded with
   * bay windows and capped by a roof plant enclosure.
   *
   * The read is the STEP: the shaft is 0.52 of the podium's plan, so a wall of
   * these has a continuous street wall at 12 m and a forest of thin towers above
   * it, which is what separates this skyline from Tokyo's uniform slabs and from
   * Taipei's balconied mid-rise. Same `TOWER_H` about a centred origin and the
   * same +-10.95 m envelope as the other four — see the block comment above.
   */
  private towerPodium(b: Builder): void {
    const H = TOWER_H;
    const tileA = 0xb9bcb4, tileB = 0xa3a89f, glassy = 0x7f96a2, trim = 0x8b8f88;
    const podium = H * 0.30;
    // ---- the podium: banded, out to the lot line -----------------------------
    b.box(0, -H * 0.5 + podium * 0.5, 0, 10.4, podium * 0.5, 9.6, tileB,
      { shade: { side: 1.0, top: 1.06 } });
    // Car-park louvre bands. Four horizontal slots is the whole tell.
    for (let i = 0; i < 4; i++) {
      const y = -H * 0.5 + 3.6 + i * (podium - 4.6) / 4;
      b.box(0, y, 9.68, 10.1, 0.42, 0.16, 0x5f6660);
      b.box(0, y, -9.68, 10.1, 0.42, 0.16, 0x5f6660);
      b.box(10.48, y, 0, 0.16, 0.42, 9.3, 0x5f6660);
    }
    // Podium cap and its planted deck edge.
    b.box(0, -H * 0.5 + podium + 0.4, 0, 10.7, 0.4, 9.9, trim, { shade: { top: 1.2 } });
    b.box(0, -H * 0.5 + podium + 1.1, 0, 10.5, 0.35, 9.7, 0x4d5a48, { shade: { top: 1.14 } });
    // ---- the shaft -----------------------------------------------------------
    const sy = -H * 0.5 + podium + 1.45;
    const sh = (H - podium - 1.45 - 3.6) * 0.5;
    b.box(0, sy + sh, 0, 5.4, sh, 4.9, tileA, { taper: 0.985, shade: { side: 1.0, top: 1.1 } });
    // Bay windows: a full-height glazed box on each face, which is how a Hong
    // Kong residential shaft actually gets its section, and it breaks the
    // silhouette into four vertical reveals instead of one flat prism.
    for (const [ox, oz, hx, hz] of [
      [5.55, 0, 0.55, 2.0], [-5.55, 0, 0.55, 2.0],
      [0, 5.05, 2.3, 0.55], [0, -5.05, 2.3, 0.55],
    ] as ReadonlyArray<readonly [number, number, number, number]>) {
      b.box(ox, sy + sh, oz, hx, sh - 1.2, hz, glassy, { taper: 0.985, shade: { top: 1.16 } });
    }
    // Floor bands, so 30 m of shaft has storeys in it at 200 m.
    const floors = 9;
    for (let i = 1; i < floors; i++) {
      const y = sy + (sh * 2) * (i / floors);
      b.box(0, y, 0, 5.9, 0.09, 5.4, trim, { shade: { top: 1.18 } });
    }
    // Roof: plant enclosure, water tanks, a lift overrun and the aerial mast.
    const rt = sy + sh * 2;
    b.box(0, rt + 0.55, 0, 5.5, 0.55, 5.0, trim, { shade: { top: 1.2 } });
    b.box(-2.0, rt + 1.9, 0.9, 2.0, 1.35, 1.9, tileB, { shade: { top: 1.12 } });
    for (const ox of [1.9, 3.6]) {
      b.prism(ox, rt + 1.1, -1.5, 0.85, 1.7, 9, 0x9ba7ac, { shade: { top: 1.16 } });
    }
    b.prism(2.2, rt + 1.1, 2.0, 0.14, 6.4, 5, 0x777c80, { taper: 0.45 });
  }

  /**
   * NEW YORK. The 1916 zoning envelope, in stone: a broad base out to the lot
   * line, then FOUR setbacks, each stepping back a fixed fraction, before the
   * tower goes vertical and finishes in a small stepped crown. Every setback
   * carries a cornice band and the first one carries a roof water tank, because
   * that is the one piece of clutter you can see from the street.
   *
   * This is deliberately the widest-based of the six vocabularies: a masonry
   * ziggurat has most of its mass in the bottom third, which is exactly the
   * opposite of `towerPodium`'s slim shaft — the two cities cannot be confused.
   */
  private towerZiggurat(b: Builder): void {
    const H = TOWER_H;
    const stone = 0xb6aa96, stoneB = 0xa4977f, cornice = 0x8b7f6a, sill = 0xc6bca8;
    // base, then four setbacks. `f` is the plan fraction at each stage.
    const stages: ReadonlyArray<readonly [number, number, number]> = [
      // [top of stage as a fraction of H from the bottom, half-x, half-z]
      [0.30, 10.6, 9.8],
      [0.46, 9.0, 8.3],
      [0.62, 7.3, 6.7],
      [0.76, 5.6, 5.1],
      [0.94, 4.0, 3.7],
    ];
    let y0 = -H * 0.5;
    for (let i = 0; i < stages.length; i++) {
      const [f, hx, hz] = stages[i];
      const y1 = -H * 0.5 + H * f;
      const hy = (y1 - y0) * 0.5;
      b.box(0, y0 + hy, 0, hx, hy, hz, i % 2 ? stoneB : stone,
        { taper: 0.995, shade: { side: 1.0, top: 1.08 } });
      // The cornice that turns a step into a setback.
      b.box(0, y1 + 0.34, 0, hx + 0.34, 0.34, hz + 0.34, cornice, { shade: { top: 1.22 } });
      b.box(0, y1 + 0.78, 0, hx + 0.1, 0.1, hz + 0.1, sill, { shade: { top: 1.24 } });
      // Vertical pilaster strips: the Art Deco read, and what stops a stone box
      // looking like a crate at 300 m.
      const strips = Math.max(2, Math.round(hx / 2.4));
      for (let k = -strips; k <= strips; k += 2) {
        const x = (k / (strips * 2)) * (hx - 0.5) * 2;
        b.box(x, y0 + hy, hz + 0.08, 0.26, hy - 0.4, 0.1, sill, { taper: 0.995 });
        b.box(x, y0 + hy, -hz - 0.08, 0.26, hy - 0.4, 0.1, sill, { taper: 0.995 });
      }
      y0 = y1 + 0.88;
    }
    // The water tank on the first setback — visible from the street, unlike
    // everything above it.
    b.box(6.4, -H * 0.5 + H * 0.30 + 1.4, 5.0, 1.3, 0.5, 1.3, 0x4c443a);
    for (const [ox, oz] of [[5.3, 3.9], [7.5, 3.9], [5.3, 6.1], [7.5, 6.1]] as const) {
      b.box(ox, -H * 0.5 + H * 0.30 + 2.2, oz, 0.12, 1.3, 0.12, 0x5a5148);
    }
    b.prism(6.4, -H * 0.5 + H * 0.30 + 3.4, 5.0, 1.35, 2.4, 12, 0x7a6247,
      { shade: { top: 1.1 } });
    b.prism(6.4, -H * 0.5 + H * 0.30 + 5.8, 5.0, 1.4, 1.0, 12, 0x4f4438, { taper: 0.04 });
    // Crown: two more steps and a flagstaff.
    b.box(0, y0 + 0.9, 0, 2.6, 0.9, 2.4, stone, { shade: { top: 1.18 } });
    b.box(0, y0 + 2.2, 0, 1.6, 0.5, 1.5, cornice, { shade: { top: 1.22 } });
    b.prism(0, y0 + 2.7, 0, 0.13, 5.0, 6, 0x9aa1a9, { taper: 0.4 });
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
    // ---- REBUILT AND RE-SEATED. `prism()` takes a BASE and a height, so
    // `prism(0, -0.4, …, 1.0, …)` put the cone's base 0.4 m under its own origin
    // and its rim at 0.6 m: 35 % of the recipe below grade before the ground was
    // even consulted, and only 0.6 m of a 1.15 m cone showing. Measured at 41-59 m
    // from the grid, which is why it reads from the start line.
    //
    // The cone now STANDS on its origin, with a low ash apron round the foot doing
    // the bedding, and `bedOnFootprint` seats the group on the highest ground under
    // each instance's own footprint at a 0.18 target — a vent is a hole with a
    // spatter cone round it, so it should be almost entirely above grade.
    {
      const anchors = roadside(ctx, rng, {
        spacing: 33, min: 6, max: 34, sides: 2,
        limit: Math.round(this.count(34) * 1.6), faceRoad: false,
      });
      const b = this.builder();
      b.prism(0, 0, 0, 1.28, 1.35, 9, 0x2b1f20, { taper: 0.66, shade: { top: 0.86 } });
      b.prism(0, 1.35, 0, 0.85, 0.3, 9, 0x1c1416, { taper: 0.72 });
      // Ash apron: wide, 0.16 m tall, and the only part authored below the origin.
      b.prism(0, -0.16, 0, 2.05, 0.3, 9, 0x241b1a, { taper: 0.68, shade: { top: 0.78 } });
      const geo = b.build('emberVent');
      const kept = this.bedOnFootprint(anchors, geo, 0.18, 0.5, this.count(34));
      this.emit('emberVent', geo, this.matte, kept, { cull: 300 });
      const g = this.builder();
      g.prism(0, 1.42, 0, 0.74, 0.26, 9, 0xff7a2a, { taper: 0.55 });
      this.emit('emberVentGlow', g.build('emberVentGlow'), this.glowSoft, kept,
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

  /**
   * Rock clusters — the cheapest way to stop terrain looking like a bedsheet.
   *
   * ==========================================================================
   * THE ROCK CLUSTER WAS AUTHORED 63-75 % UNDERGROUND.
   * ==========================================================================
   * Each lump was `sphere(..., -r * 0.35 + rng * 0.2, ..., { squash: 0.62-0.92 })`
   * — centre a third of a radius BELOW y = 0, then a squashed half-height on top
   * of that. So the lump's own bottom sat at −(0.35 + squash)·r while its top
   * only reached (squash − 0.35)·r: measured on the real scene, 63 % of the
   * cluster's height was below the heightfield on coastal, 68 % on neon and
   * **75 % on volcano**, where the biggest one is 10.6 m across and 5.1 m tall
   * with 3.8 m of that underground. 1.2 m of a 5 m rock showing over a 10.6 m
   * footprint is not a rock bedded into the ground; it is a wide flat-topped
   * slab lying in the dirt.
   *
   * That matters here rather than anywhere else because `roadside()` marches
   * from **arc 0**, so this band guarantees one of these within a metre or two
   * of the start/finish line on every circuit — measured at arc +0/-2 m
   * (coastal), +2 m (neon) and +1 m (volcano), 18-27 m to the side, 32-57 px
   * tall in the real grid-slot chase frame at 800x450. A faceted 7-segment lump
   * with three quarters of itself buried reads, at a glance and from the grid,
   * as a box-shaped prop half sunk into the ground.
   *
   * `y = r * (0.24 + …)` puts the lump's centre a quarter of a radius ABOVE the
   * anchor, which lands the cluster ~35 % into the ground: still bedded — a rock
   * resting on the surface looks like a prop dropped on a table — but reading as
   * a boulder rather than a lid. Nothing else about the silhouette changes.
   *
   * The near-road band is also thinned: a 10 m boulder standing proud 0.3 m from
   * the tarmac would be a worse defect than a buried one, so that band now keeps
   * 7 m of clearance and takes the small end of the scale range, leaving the big
   * ones to the annulus out in the landscape.
   */
  private buildRocks(count: number, hexA: number, hexB: number, size: number): void {
    const rng = this.rng;
    // Ask for roughly twice what we want: `bedOnFootprint` REJECTS anchors whose
    // ground is too broken for the instance that would stand on it, and the count
    // has to survive that. `annulus`'s own 34 m mutual-clash rule means it will
    // often return fewer than asked anyway.
    const anchors = annulus(this.ctx, rng, {
      count: Math.round(count * 2.1), min: 40, max: this.field.extent * 0.44,
      minRoadDist: 17, maxSlope: 1.4,
    });
    for (const a of anchors) a.scale = (0.55 + rng.next() * 1.7) * size;
    // A band close to the road so the verges have structure too — but small
    // ones. These are the instances the driver's eye passes at 0.85 of the
    // half-width, and the ones that flank the start line.
    for (const a of roadside(this.ctx, rng, {
      spacing: 17, min: 7, max: 30, sides: 2, limit: Math.round(count * 1.5),
      faceRoad: false, maxSlope: 1.1,
    })) {
      a.scale = (0.45 + rng.next() * 0.7) * size;
      anchors.push(a);
    }

    const b = this.builder();
    b.jitter = 0.09;
    // A dirt / scree apron FIRST, so the boulder meets the ground through a band of
    // debris instead of a clean intersection with no AO and no blend. Wide, very
    // flat and much darker than the rock, which is what reads as an occlusion
    // gradient at the contact — the critic's "intersects the ground with no AO or
    // dirt blend". Authored deliberately below y = 0 so it always sinks in.
    const dirtA = mixHex(hexA, 0x2e2519, 0.62);
    const dirtB = mixHex(hexB, 0x241d14, 0.68);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rng.next() * 0.8;
      const d = 0.95 + rng.next() * 0.9;
      const r = 0.55 + rng.next() * 0.5;
      b.sphere(Math.cos(a) * d, -0.10 * r, Math.sin(a) * d, r, 6, 3,
        i % 2 ? dirtA : dirtB, { squash: 0.20 + rng.next() * 0.10 });
    }
    for (let i = 0; i < 4; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = rng.next() * 1.3;
      const r = 0.7 + rng.next() * 0.9;
      b.sphere(Math.cos(a) * d, r * (0.24 + rng.next() * 0.14), Math.sin(a) * d, r, 7, 4,
        i % 2 ? hexA : hexB, { squash: 0.62 + rng.next() * 0.3 });
    }
    const geo = b.build('rock');
    // 1.7x `count` is what the two passes above used to yield between them
    // (`count` from the annulus + 0.7 `count` from the roadside band), so the rock
    // DENSITY is unchanged; what changed is which anchors are allowed to keep one.
    const kept = this.bedOnFootprint(anchors, geo, 0.34, 0.45, Math.round(count * 1.7));
    this.emit('rock', geo, this.rockMat(), kept, { cull: 380 });
  }

  /**
   * A real rock material rather than `this.matte`'s bare vertex colours: the
   * shared library's `makeRock()` PbrSet (albedo + normal + roughness + cavity AO),
   * tiled at its own suggested world size. `uvScale` on the recipe above is the
   * Builder default of 0.6, i.e. a tile every 1.67 m, which is the right grain for
   * a 1-3 m boulder.
   */
  private rockMat(): THREE.MeshStandardMaterial {
    if (this.rockMaterial) return this.rockMaterial;
    const set = makeRock(this.quality.tier === 'low' ? 512 : 1024);
    const m = new THREE.MeshStandardMaterial({
      name: 'prop-rock',
      vertexColors: true,
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.roughnessMap,
      aoMap: set.aoMap,
      roughness: 1.0,
      metalness: 0.0,
      normalScale: new THREE.Vector2(set.normalScale ?? 1, set.normalScale ?? 1),
    });
    // NOT pushed to `this.textures`: `makeRock` is memoised inside TextureFactory
    // and shared with the terrain, so disposing it here would pull it out from
    // under another subsystem. `TextureFactory.disposeAll()` owns those.
    this.materials.push(m);
    this.rockMaterial = patchProp(m, this.u);
    return this.rockMaterial;
  }

  /**
   * =========================================================================
   *  WHY A ROCK'S BURIAL WAS UNBOUNDED — and what actually fixes it
   * =========================================================================
   *  Measured on the rejected build (`.probe-tmp/citykit.ts`, ultra), burial as a
   *  percentage of each instance's own height ran 32-373 % on Sunset Coastline
   *  (22 of 78 instances **entirely underground**) and 35-360 % on Volcano Rush
   *  (18 of 102). The city circuits were milder at 29-84 %, but out of band too.
   *
   *  The recipe's own sub-origin offset is NOT the cause, and clamping it would
   *  have fixed nothing: each lump is authored at `y = r * (0.24 …)` with a
   *  squashed half-height on top, so its bottom sits at a fixed FRACTION of its
   *  own height below the origin. Scale the instance and both the offset and the
   *  height scale together — as a percentage it is invariant, at about 35 %.
   *
   *  The unbounded term is that **the placement test is a point sample and the
   *  prop is an area.** `annulus()` and `roadside()` set `a.y = field.heightAt(x, z)`
   *  at the anchor and check `field.slopeAt(x, z)` at the anchor, and say nothing
   *  whatever about the ground under the other 99 % of the footprint. A rock
   *  cluster is 4:1 wider than it is tall and its footprint grows linearly with
   *  `a.scale`, while `maxSlope: 1.4` admits ground at 54 degrees. So the ground
   *  at the uphill edge of a big instance can be several times the whole rock's
   *  height above the single texel the anchor was seated on — and then every
   *  vertex of it is inside the hillside.
   *
   *  So the fix is at the placement, not the geometry:
   *
   *    1. Seat on the HIGHEST ground over the instance's own footprint, not on the
   *       centre sample. The recipe's designed bedding fraction is then measured
   *       against the ground that is actually in front of the camera, which pins
   *       burial at `target` for ANY scale on ANY slope.
   *    2. REJECT an anchor whose footprint relief exceeds `reliefBudget` of the
   *       instance's own height. Seating on the max would otherwise leave the
   *       downhill side hanging in the air — the mirrored defect, and the one that
   *       produced the critic's single -28 % reading.
   *
   *  `limit` caps how many survivors are kept, so the caller over-generates and
   *  this picks the ones that fit. Returns the kept anchors, re-seated in place.
   */
  private bedOnFootprint(
    anchors: Anchor[], geo: THREE.BufferGeometry,
    target: number, reliefBudget: number, limit: number,
  ): Anchor[] {
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return anchors.slice(0, limit);
    const lo = bb.min.y, hi = bb.max.y;
    const localH = hi - lo;
    if (localH < 1e-4) return anchors.slice(0, limit);
    const localR = Math.max(
      Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.z), Math.abs(bb.max.z),
    );
    const field = this.field;
    const kept: Anchor[] = [];
    let rejected = 0;
    for (const a of anchors) {
      if (kept.length >= limit) break;
      // A footprint that does not fit the ground is SHRUNK before it is rejected.
      // On a perfectly linear slope that changes nothing — relief and height both
      // scale with the instance — but real terrain is not linear, and a smaller
      // footprint very often lands inside a flatter patch of it. Three tries at
      // 0.72x recovers most of the density that a bare reject-and-move-on threw
      // away (coastal went 34 -> 60 drawn instances at ultra on this alone), and
      // the near-road band wanted the small end of the scale range regardless.
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const r = localR * a.scale;
        let gMax = -Infinity, gMin = Infinity;
        // Centre plus three rings, 25 samples. Four AABB corners is what
        // under-samples a 4:1 cluster; this has to be dense enough that the ground
        // it finds is the ground an auditing probe finds, or the seating is measured
        // against a different surface from the one it was solved for. The outer ring
        // reaches 1.4 r, not r: `localR` is the half-extent of the AABB's SIDE, and
        // its corners are a further 41 % out.
        for (const frac of [0, 0.5, 0.95, 1.4]) {
          const ring = frac === 0 ? 1 : 8;
          for (let k = 0; k < ring; k++) {
            const ang = (k / ring) * Math.PI * 2 + frac * 1.3;
            const g = field.heightAt(
              a.x + Math.cos(ang) * r * frac, a.z + Math.sin(ang) * r * frac,
            );
            if (g > gMax) gMax = g;
            if (g < gMin) gMin = g;
          }
        }
        const worldH = localH * a.scale;
        if (gMax - gMin > reliefBudget * worldH) { a.scale *= 0.72; continue; }
        // burial = (gMax - (y + lo*scale)) / worldH, so solve it for `target`.
        a.y = gMax - lo * a.scale - target * worldH;
        ok = true;
      }
      if (!ok) { rejected++; continue; }
      kept.push(a);
    }
    if (rejected > 0) this.footprintRejects += rejected;
    return kept;
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
    // The single worst correction is a MISLEADING headline and it has already
    // cost a review cycle: Taipei logged "worst correction 153.07 m", which reads
    // like a heightfield fault, and it is nothing of the kind. Measured
    // (`.probe-tmp/reseat.ts`), all four corrections above 30 m on that circuit
    // are `mountainRidge` skyline cones authored at `lat: 700`, 528 m from the
    // road. A `lat` that large is applied along a BANKED binormal in
    // `Track.getDecorationHints()`, so 700 m x sin(13.5 deg) hands them 164 m of
    // spurious altitude; the recipe builds them `capBottom: false` because they
    // are meant to be bedded in the ground, so 164 m up they would show an open
    // bottom face. The re-seat is what rescues the composition, not what breaks
    // it. What actually needs watching is the correction for props the driver
    // passes close to, so that is reported separately — near-road p50 is 0.23 m
    // on Taipei and under 2.5 m on every circuit.
    let nearWorst = 0;
    let nearWorstType = '';
    let farCount = 0;
    /** Props seated on the water plane rather than the seabed — see condition 5. */
    let floated = 0;
    const NEAR_BAND = 40;

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
        // Condition 4, now a distance rather than a flag — see `DECK_FRAME`.
        && (!surf.elevated || Math.abs(surf.lat) > surf.corridor + DECK_FRAME)
        && !CORRIDOR_PROPS.has(key)
        && !PLINTH_PROPS.has(key)
      ) {
        // The ground, not the ground plus `up`: a prop authored to sit below
        // grade still needs the grade itself to be dry land.
        const ground = this.field.heightAt(p.position.x, p.position.z);
        // ---- CONDITION 5 USED TO GIVE UP HERE. -----------------------------
        // Below the waterline the heightfield is a seabed and nothing stands on
        // it, so the old code left Track's road-plane extrapolation alone and the
        // file's own comment admitted the answer was wrong: "sea dressing wants
        // the water plane, and nothing in this pass knows that". It does know —
        // `ctx.waterLevel` is right there. Measured (`.probe-tmp/floating.ts`),
        // leaving it cost coastal a `sailboat` hull 5.7 m above the sea, a run of
        // 5 buoys 3.6-4.8 m above it, 5 palms 2.4-3.3 m, a lifeguard tower and 5
        // umbrellas. A hull seated ON the water plane is right by construction —
        // that is what floating means — and it is a strictly better answer than a
        // plane extrapolated 74 m sideways off the road.
        const onWater = ground < this.ctx.waterLevel;
        const datum = onWater ? this.ctx.waterLevel : ground;
        {
          const seated = datum + surf.up;
          if (Math.abs(seated - y) > 1e-3) {
            const corr = Math.abs(seated - y);
            worstReseat = Math.max(worstReseat, corr);
            // `surf.lat` is the authored lateral offset, which IS the distance
            // from the carriageway — no projection needed.
            if (Math.abs(surf.lat) <= NEAR_BAND) {
              if (corr > nearWorst) { nearWorst = corr; nearWorstType = p.type; }
            } else if (corr > 30) {
              farCount++;
            }
            if (onWater) floated++;
            reseated++;
            y = seated;
          }
          // `groundUp` means "this anchor's offset is measured from the GROUND",
          // and it is what licenses `clearAuthored` / `clearRoadSurface` to re-seat
          // after a lateral push. A water-seated prop must NOT carry it: a push
          // would then land the hull on the seabed, 28 m down, which is the exact
          // failure the old condition 5 was written to avoid. Left undefined, both
          // guards fall through their `heightAt` sanity check and leave it afloat.
          if (!onWater) groundUp = surf.up;
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
        + ` (outside the road corridor); worst within ${NEAR_BAND} m of the road`
        + ` ${nearWorst.toFixed(2)} m${nearWorstType ? ` (${nearWorstType})` : ''}`
        + `; ${farCount} distant backdrop props corrected by more than 30 m`
        + ` (expected — see collectAuthored)`
        + `; ${floated} seated on the water plane`,
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
        this.emit(`authored:${key}:cloth`, spec.cloth,
          spec.clothMast ? this.mastSway : this.matteSway, anchors,
          { cull: spec.cull ?? CULL_MID, shadow: false, corridor });
      }
      if (spec.clothSign) {
        this.emit(`authored:${key}:clothSign`, spec.clothSign, this.atlasSway, anchors,
          { cull: spec.cull ?? CULL_MID, atlasBaked: true, shadow: false, corridor });
      }
      if (spec.flag) {
        this.emit(`authored:${key}:flag`, spec.flag, this.flagSway, anchors,
          { cull: spec.cull ?? CULL_MID, atlasBaked: true, shadow: false, corridor });
      }
      if (spec.metal) {
        this.emit(`authored:${key}:metal`, spec.metal, this.metal, anchors,
          { cull: spec.cull ?? CULL_MID, corridor });
      }
      if (spec.metalPerAnchor) {
        // One single-instance mesh per anchor. The name keeps the `:metal`
        // infix so every probe that greps for a pass by name still finds it.
        anchors.forEach((a, i) => {
          const g = spec.metalPerAnchor?.(a);
          if (!g) return;
          this.emit(`authored:${key}:metal:${i}`, g, this.metal, [a],
            { cull: spec.cull ?? CULL_MID, corridor });
        });
      }
      if (spec.sign) {
        this.emit(`authored:${key}:sign`, spec.sign, this.atlas, anchors,
          spec.signCells
            ? { cull: spec.cull ?? CULL_MID, atlasCells: spec.signCells, shadow: false, corridor }
            : { cull: spec.cull ?? CULL_MID, atlasBaked: true, shadow: false, corridor });
      }
      if (spec.windows) {
        // The same day/night gate as `buildCity`'s tower pass. `glassTower` and
        // `towerBlock` were emitting `#ffffff` at `emissiveIntensity 2.6` on a
        // `skyPreset: 'day'` circuit; by day they now get reflective glass with no
        // emissive at all, and therefore no bloom either.
        this.emit(`authored:${key}:windows`, spec.windows, this.windowMat(), anchors,
          {
            cull: spec.cull ?? CULL_MID, bloom: this.litWindows, shadow: false, corridor,
          });
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
        // ---- THE OWNER'S "SECOND DARK PANEL FLOATING BEHIND IT". -------------
        // `b.box(0, H + 2.6, ...)` above is the sign board: 19.4 x 1.2 m of
        // near-black (0x1d222b) at 12.0 m over the start line. Its only decoration
        // is this lit panel, and it was authored at z = +0.34 with `single: true`,
        // whose face normal is local +Z. A `SPANS_THE_ROAD` prop is yawed off the
        // TANGENT, so local +Z runs DOWN-track: the lit board faced away from every
        // approaching kart, and `this.glow` is FrontSide, so it was not drawn at
        // all. What the driver saw was an unlit black slab hanging in the air above
        // the bar of red signal lights — measured in `.probe-tmp/redpanel.ts` as a
        // 24.6 x 3.0 m bloomed red panel with 9.4 m of air under it.
        //
        // Same fault as the mirrored banners, one material along: `yaw: Math.PI`
        // puts the normal on local -Z and the board on the side the driver is on.
        glow.plate(0, H + 2.6, -0.34, halfSpan * 1.3, 0.9, Math.PI, 0x7fe4ff, { single: true });
        // ---- THE HANGING BANNERS -------------------------------------------
        // Sponsor artwork off the shared atlas, not two flat saturated rectangles.
        // The vertex colour is held near-white on purpose: `atlasSway`'s `map`
        // MULTIPLIES it, so a saturated red here would turn every wordmark to mud.
        // `atlasRect(cell)` bakes one cell per banner, the same mechanism
        // `standBanner` uses, so the two banners carry different brands. A wider
        // banner (3.0 -> 3.4 m) because a square atlas cell stretched tall is the
        // other way to make a logo unreadable.
        //
        // ---- P0e, TWO CHANGES. -----------------------------------------------
        // CONTENT: cells 2 and 6 were TURBO and DRIFT; the owner asked for
        // CAPY LAB (cell 0) and FOXY KART (cell 7). Left banner reads CAPY LAB.
        // MIRRORING: `double: true`. This gantry is a `SPANS_THE_ROAD` type, so
        // `place()` yaws it off the TANGENT and local +Z points down-track, away
        // from the driver. `banner()` emitted only a +Z sheet and
        // `prop-atlas-cloth` is `DoubleSide`, so the driver read the back of it —
        // the wordmark AND the caption under it both came out in mirror image.
        // This is the fourth instance of the inside-out family in this file (every
        // closed primitive in `box()`/`prism()`, `superShape()` in KartBodies, the
        // grass colour attribute, the walls/tunnel/deck) and the first that was
        // reported as a texture fault rather than a winding one.
        //
        // `cloth.flap = 1` below is dead and stays only as a marker: `banner()`
        // OVERWRITES `this.flap` per row with `fy * fy` (5 distinct levels at
        // segs = 4) and zeroes it on the way out, so these banners never had the
        // rigid-translation defect the national flags had. Measured in
        // `.probe-tmp/mirror.ts`.
        const cloth = this.builder();
        cloth.flap = 1;
        for (const [i, sx] of [-1, 1].entries()) {
          cloth.banner(sx * (halfSpan - 4.4), H - 0.1, 0.4, 3.4, 4.4, 0, 0xf4f2ec, 6,
            atlasRect(i === 0 ? 0 : 7), { double: true, wave: 0.26 });
        }
        // A valance above them, in the truss colour, so the cloths read as hung
        // from the gantry rather than floating under it.
        const trim = this.builder();
        for (const sx of [-1, 1]) {
          trim.box(sx * (halfSpan - 4.4), H + 0.12, 0.4, 1.8, 0.1, 0.14, 0xb8bcc4);
        }
        return { geo: b.build('startGantry'), glow: glow.build('startGantryGlow'),
          clothSign: cloth.build('startGantryBanner'),
          metal: trim.build('startGantryValance'), cull: CULL_FAR };
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

        // ---- 4b. the CUT FACE on the approach side ------------------------
        // Everything above meets the hill BEHIND the headwall. Nothing held the
        // ground back in FRONT of it, and measurement says something has to:
        // with the heightfield's phantom embankment gone (see the STACK_V note
        // in `TerrainField.bake`) volcano t=0.805 is a mild side-hill cut —
        // ground +1.2 to +1.8 m above the road on the left flank and -1.9 to
        // -2.9 m on the right, over an opening that springs at -0.50 m. So on
        // the high side ~2 m of the arch's haunch has soil against it and on the
        // low side the headwall base is left in the air.
        //
        // Two returns per side fix both ends of that range: they run FORWARD out
        // of the face and step down, so the bank is retained by masonry instead
        // of spilling against the jamb, and the wall visibly continues below
        // grade on the falling side. This is the difference between "a hole in a
        // slope" and "a road entering a cutting".
        //
        // Kept to 8.1 m of forward reach, with every inner face at |x| >= 13.57 m:
        // the CLEARANCE note above allows nothing inside 13.4 m of the centreline
        // below the springing, and the widest shoulder edge at any portal is
        // 12.65 m. The outer faces stay inside the 17.97 m the coping already
        // reaches, so the prop's across-half does not grow.
        for (const sx of [-1, 1]) {
          for (let k = 0; k < 2; k++) {
            const zc = -1.5 - k * 4.3;          // forward of the face
            const half = 2.15;                   // along-z half length
            const top = Y0 + 6.6 - k * 2.6;      // steps down as it runs out
            const bot = YB - 0.4;                // and continues below grade
            b.box(sx * (R + 1.35 + k * 0.42), (bot + top) * 0.5, zc,
              1.05 + k * 0.16, (top - bot) * 0.5, half,
              k % 2 ? 0x827868 : stone, { shade: { top: 1.1, side: 1.02 } });
            // Coping, so the return has a top edge rather than ending in air.
            b.box(sx * (R + 1.35 + k * 0.42), top + 0.16, zc,
              1.28 + k * 0.16, 0.2, half + 0.16, light, { shade: { top: 1.28 } });
          }
          // Splayed plinth along the flank of the face: the footing course that
          // makes the headwall meet grade instead of being cut off by it.
          //
          // Placed so its inner face lands at 13.94 m. `.probe-tmp/portalclear.ts`
          // reads the built vertices back and reports the nearest approach to the
          // centreline below the springing: it is 13.55 m, and that is step 1's
          // pre-existing splayed footing (`WING*0.5 + 0.35` at `R + WING*0.5`),
          // not anything added here. Everything in step 4b stays at 13.94 m or
          // wider so it is never the binding constraint.
          b.box(sx * (R + WING * 0.6), Y0 + 0.35, -0.42,
            WING * 0.5 + 0.3, 1.35, FACE + 0.5, dark, { shade: { top: 1.14 } });
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
        // Subdivided cloth, not a 2-triangle quad — see `mastCloth`. Measured
        // (`.probe-tmp/flagcheck.ts`): this pennant had 4 vertices and 2 distinct
        // `aFlap` levels, so it could only swing rigidly.
        cloth.mastCloth(0, 7.1, 0, 2.6, 1.6, rng.range(0, 6.28), 0xe8332a, 6, 4,
          undefined, { wave: 0.30, sag: 0.18 });
        return {
          geo: b.build('flagPole'), cloth: cloth.build('flagPoleCloth'),
          clothMast: true, cull: CULL_MID,
        };
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
        // ---- THE SAILS WERE FLAT QUADS (section 0). --------------------------
        // Two `plate(..., flapAcross: true)` calls, i.e. 4 vertices and 2 triangles
        // each, with `aFlap` only ever 0 or 1 — the exact defect the national flags
        // were rebuilt out of last round (see `mastCloth`), left behind here. A
        // 2.1 x 4.6 m flat rectangle with a two-level flap cannot ripple and cannot
        // hold a curve, so it read as a painted board bolted to a mast.
        //
        // `mastCloth` with `bow` gives the one thing a sail must have that a banner
        // must not: CAMBER. The cloth bellies away from the chord, deepest a third
        // of the way aft, and the normals are differentiated from the same camber
        // so the shading follows the curve instead of reading as a tilted plane.
        // `double` because a moored boat is seen from both bows across the bay.
        // Main 6x4 + jib 5x3, both sheets: 156 triangles for the pair against 4,
        // on a `CULL_FAR` prop that appears 1-2 times per circuit.
        // Forestay and backstay, so the jib has something to be bent onto and the
        // rig reads as a sloop rather than a pole with two boards beside it.
        b.tube(0.15, 6.4, 0, 2.3, 1.0, 0, 0.035, 4, 0xb8bcc4);
        b.tube(0.15, 6.4, 0, -2.25, 1.0, 0, 0.03, 4, 0xb8bcc4);
        const cloth = this.builder();
        // BOTH SAILS ON THE SAME TACK. `yaw: PI` puts the in-plane axis on -X, so
        // each cloth is pinned at its luff and runs AFT, and both bellies fall to
        // -Z. Never express "aft" as a negative `w` at yaw 0: the positions would
        // run -X while the written normal stayed +Z, which is precisely the
        // inside-out fault the rest of this file is a monument to.
        // Main: luff on the mast (x = 0.15), leech at x = -2.45.
        cloth.mastCloth(0.12, 6.30, 0, 2.6, 4.6, Math.PI, 0xf7f3ea,
          6, 4, undefined, { double: true, bow: 0.62 });
        // Jib: luff on the forestay near the bow, leech just forward of the mast.
        cloth.mastCloth(2.15, 4.60, 0, 2.0, 2.9, Math.PI, 0xffd23f,
          5, 3, undefined, { double: true, bow: 0.34 });
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
        // Mid-rise, deliberately shorter than the 46 m background tower so the
        // authored lat-46 run reads as a wall of city behind the taller
        // background towers rather than competing with them.
        //
        // ---- PER-DISTRICT. This recipe was one grey box on all four city
        // circuits, and at 26-34 instances it is the second-largest generic count
        // after the towers themselves. It now takes the declared district's facade
        // material and palette, so Boston's mid-rise is brick with a stone cornice
        // and Taipei's is tiled with balconies. `authoredSpec` runs from
        // `buildAuthored`, i.e. AFTER `buildCity` has resolved `this.kit`.
        const b = this.builder();
        const kit = this.kit;
        b.uvScale = 1 / this.facadeTile;
        const H = rng.range(17, 25), w = rng.range(6.5, 9), d = rng.range(6, 8.5);
        const pal: Record<CityKitId, readonly [number, number, number, number]> = {
          //        shaft a,  shaft b,  base,     cornice
          neon: [0x6b737e, 0x5e6672, 0x3f454c, 0x4d545d],
          brick: [0xa06450, 0x8f5644, 0xa9a49a, 0xd8cfbe],
          midrise: [0xbfb8ab, 0xa8a79e, 0x6e6a62, 0x8d8b82],
          tokyo: [0x6d7683, 0x5f6875, 0x474e5a, 0x7d868f],
          // Appended for the two new City Series circuits. Additive only — the
          // four above are untouched, and the record is keyed by `CityKitId`, so
          // the compiler is what requires an entry per kit.
          hongkong: [0xb9bcb4, 0x9fa8a2, 0x5f6660, 0x8b8f88],
          newyork: [0xb6aa96, 0xa4977f, 0x6f665a, 0x8b7f6a],
        };
        const [shaftA, shaftB, baseC, corniceC] = pal[kit.id];
        b.box(0, H * 0.5, 0, w, H * 0.5, d, rng.next() < 0.5 ? shaftA : shaftB,
          { taper: 0.99, shade: { top: 1.12 } });
        b.box(0, 1.1, 0, w + 0.4, 1.1, d + 0.4, baseC, { shade: { top: 1.0 } });
        // Cornice in two steps rather than one slab: a chamfered eaves read, which
        // is what AGENTS.md section 3 means by "no hard-edged low-poly silhouette".
        b.box(0, H + 0.28, 0, w + 0.34, 0.28, d + 0.34, corniceC, { shade: { top: 1.16 } });
        b.box(0, H + 0.68, 0, w + 0.14, 0.16, d + 0.14, corniceC, { shade: { top: 1.2 } });
        // Roof clutter breaks the flat-top silhouette that says "box".
        b.box(w * 0.4, H + 1.4, d * 0.3, 1.1, 1.0, 1.1, shaftB);
        b.prism(-w * 0.45, H + 0.9, -d * 0.35, 0.5, 1.7, 8, baseC, { taper: 0.85 });
        if (kit.id === 'midrise') {
          // Taipei roofs carry water tanks, and the balcony line is the whole read.
          for (const sx of [-1, 1]) {
            b.prism(sx * w * 0.42, H + 0.9, d * 0.32, 0.85, 1.4, 9, 0x9ba7ac,
              { shade: { top: 1.16 } });
          }
        }
        // Horizontal floor bands: the cheapest way to give a block scale. Taipei
        // gets them as projecting balcony slabs instead of flush bands.
        const floors = Math.floor(H / 3.1);
        for (let f = 1; f < floors; f++) {
          if (kit.id === 'midrise') {
            for (const sz of [1, -1]) {
              b.box(0, f * 3.1, sz * (d + 0.42), w * 0.94, 0.11, 0.5, corniceC,
                { shade: { top: 1.18 } });
            }
          }
          b.box(0, f * 3.1, 0, w + 0.12, 0.1, d + 0.12, corniceC);
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
        return {
          geo: b.build('towerBlock'), windows: win.build('towerBlockWindows'),
          mat: this.facadeMat(), cull: CULL_FAR,
        };
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
        // ---- LIT OVER ITS WHOLE HEIGHT, not just at the setbacks -------------
        // Found by `.probe-tmp/landmark.ts`, not reported by the owner: the gate
        // it applies to every authored group over 90 m on a night circuit is
        // structural rather than a list of the three city-series names, so it
        // also judged this one. It scored `lit% 40` — five setback rings and a
        // beacon, with the 6.5 m cap, the 9 m mast and the whole face of every
        // drum dark. Same defect as Tokyo's two towers and the same fix: the
        // vertical members carry the light, so the silhouette is what is lit.
        let gy = 0, gr = 11.5;
        for (let i = 0; i < 5; i++) {
          const seg = 8.5 - i * 0.6;
          glow.torus(0, gy + seg + 0.3, 0, gr * 0.99, 0.16, 16, 5, 0x2ef0ff, 1);
          // Eight service risers up each drum, following its taper.
          const rt = gr * 0.9;
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            glow.tube(Math.cos(a) * gr * 1.01, gy, Math.sin(a) * gr * 1.01,
              Math.cos(a) * rt * 1.01, gy + seg, Math.sin(a) * rt * 1.01,
              0.2, 4, i % 2 ? 0x2ef0ff : 0x8f6cff);
          }
          gy += seg + 0.55;
          gr *= 0.84;
        }
        // The cap and the mast, so the top third is not a dark stub.
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          glow.tube(Math.cos(a) * r * 0.52, y, Math.sin(a) * r * 0.52,
            Math.cos(a) * r * 0.22, y + 6.5, Math.sin(a) * r * 0.22, 0.17, 4, 0x2ef0ff);
        }
        for (const f of [0.35, 0.7, 1.0]) {
          glow.sphere(0, y + 6.5 + 9 * f, 0, 0.5, 8, 6, 0xff3b6a);
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
        // Whole-cell uvs + signCells: each holo ad in view shows a different
        // sponsor rather than eight copies of the same one. `CELL_FULL`, not a raw
        // `[0,1,1,0]` — see the `clamp` note in `patchProp`; the exact 0 and 1 ends
        // were folded onto each other and this 14.6 x 4.7 m panel rendered as one
        // flat texel. Double-sided (no `single`), and `plate()`'s back face now
        // carries a correctly mirrored u range, which matters here because a lat-0
        // `holoAd` spans the road and the driver sees its BACK.
        sign.plate(0, 0, 0, 14.6, 4.7, 0, 0xffffff, { uvRect: CELL_FULL });
        const glow = this.builder();
        glow.plate(0, 0, -0.05, 14.6, 4.7, 0, 0x2ef0ff, { single: true });
        for (const sy of [-1, 1]) glow.box(0, sy * 2.5, 0, 7.4, 0.05, 0.1, 0x8bf6ff);
        return {
          geo: b.build('holoAd'), sign: sign.build('holoAdSign'), signCells: 8,
          glow: glow.build('holoAdGlow'), softGlow: true, cull: CULL_FAR, shadow: false,
        };
      }

      case 'billboard': {
        // ---- P0e: "a large red panel high above the ground with NO visible
        // supporting structure". Two faults, and the structure was the second one.
        // The posts stood at +-3.4 m under an 8.8 m face and STOPPED at 6.2 m,
        // 0.6 m above the panel's bottom edge — so 4.8 m of an 11 m structure was
        // cantilevered off nothing you could see, and from the road the panel read
        // as detached. A real hoarding runs its stringers up the back of the whole
        // face. The masts now reach 10.6 m (past the panel's 10.75 m top), stand at
        // +-3.9 m, and carry two horizontal stringers plus a raked back-stay to
        // ground. XZ extents are unchanged — the 8.8 m sign plate still sets the
        // bounding box — so no clearance guard sees a different prop.
        const b = this.builder();
        for (const sx of [-1, 1]) {
          b.prism(sx * 3.9, 0, 0, 0.26, 10.6, 8, 0x3d434a, { capBottom: true, taper: 0.62 });
          // Raked back-stay from high on the mast down to a footing behind it.
          b.tube(sx * 3.9, 7.4, 0, sx * 3.4, 0.1, -1.45, 0.13, 5, 0x3d434a);
          b.box(sx * 3.4, 0.22, -1.45, 0.5, 0.22, 0.5, 0x2f343a, { shade: { top: 1.1 } });
          b.box(sx * 3.9, 0.3, 0, 0.62, 0.3, 0.62, 0x2f343a, { shade: { top: 1.12 } });
        }
        // Stringers: the horizontals the hoarding is actually bolted to.
        for (const sy of [6.4, 10.0]) {
          b.tube(-4.3, sy, -0.12, 4.3, sy, -0.12, 0.11, 4, 0x454c54);
        }
        // Maintenance catwalk under the face — the detail that says "billboard".
        b.box(0, 5.5, -0.5, 4.2, 0.06, 0.34, 0x565e67, { shade: { top: 1.2 } });
        b.box(0, 8.3, 0.22, 4.6, 2.7, 0.16, 0x2b3036, { shade: { top: 1.1 } });
        const sign = this.builder();
        // `CELL_FULL`, not `[0,1,1,0]`: this is THE panel the owner photographed
        // floating over the volcano circuit as a flat red rectangle. The rect's 0
        // and 1 ends were collapsed onto each other by the `fract()` in
        // `patchProp`'s atlas remap, so an 8.8 x 4.9 m advertising face sampled a
        // single texel of one sponsor cell — flat colour, no wordmark, no frame,
        // and nothing to read it as a billboard by. See the `clamp` note there.
        sign.plate(0, 8.3, 0.05, 8.8, 4.9, 0, 0xffffff, { single: true, uvRect: CELL_FULL });
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

      // =====================================================================
      //  CITY SERIES LANDMARKS  (Boston / Taipei / Tokyo — see CityDefs.ts)
      // =====================================================================
      //  A landmark's job here is SILHOUETTE AT 200 M, per AGENTS.md section 3:
      //  bold massing and colour blocking, not trim. Every recipe below is
      //  authored with its local **min.y at 0** so it sits on the ground rather
      //  than half inside it (`marshalPost`, `beachHut` and the roadside rocks
      //  were all authored centred on y=0 and came out buried) — the two
      //  exceptions are `overpassarch`, which hangs BELOW its anchor exactly as
      //  `bridgepylon` does, and the flag masts' plinths, which start at 0.
      //
      //  Each one's built ACROSS-ROAD half-extent is stated in its comment,
      //  because `lat` in CityDefs is a CENTRE offset and a recipe wider than
      //  its own `lat` stands inside the road (the `alleyBlock` defect).
      //  `.probe-tmp/crowding.ts`'s lat audit checks every number here.

      case 'bridgearch': {
        // ---- BOSTON: the cable-stayed bridge tower --------------------------
        // An inverted Y whose legs straddle the deck and meet above it, then a
        // single obelisk shaft. Two of these on the deck, cables fanning fore
        // and aft, is the whole silhouette.
        //
        // WIDTH. Authored at lat 0, so local +-X is ACROSS the carriageway. The
        // bridge section is hw 11 + kerb 1.55 + shoulder 1.2 = 13.75 m of
        // corridor, so nothing may come inside 14.2 m of the centreline below
        // the crotch. The feet stand at +-14.9 m and the legs lean IN as they
        // rise, crossing the corridor only at 27 m — 25 m above the deck.
        //
        // ---- WHAT WAS WRONG WITH IT, MEASURED --------------------------------
        // Owner: *"the bridge in the Boston track has not been properly
        // optimised and appears visually unnatural."* Three separate numbers,
        // all off the old recipe (`.probe-tmp/landmark.ts`, `.probe-tmp/bridgeseat.ts`):
        //
        //  1. PROPORTION. 63 m tall against a 34 m foot spread and a 60 m cable
        //     fan: slenderness 1.0, i.e. as wide as it was tall. A cable-stayed
        //     tower is the opposite shape — the real one is 82 m above its deck
        //     on legs 30 m apart. That is the "generic wide low arch" read.
        //  2. NOTHING UNDER THE FEET. The legs stand at +-14.9 m; the bridge
        //     DECK ends at hw 11 + kerb 1.55 + shoulder 1.2 + 0.1 = 13.85 m. So
        //     both feet were outboard of the deck they appeared to stand on, and
        //     the prop is a `CORRIDOR_PROPS` type so it keeps the deck's Y with
        //     no re-seating. Measured against the heightfield: the -X feet hung
        //     1.60-3.01 m in the air, the +X feet were 0.71-1.63 m INTO the
        //     bank. One tower leg floating and the other buried, on both towers.
        //  3. 488 TRIANGLES for the circuit's signature structure, with cables
        //     0.09 m in radius — 1.2 px at 120 m on a 1080p frame, i.e. below
        //     the resolution at which a cable fan is a cable fan at all.
        //
        // The leg geometry BELOW the crotch is deliberately unchanged: its lean
        // is what keeps the carriageway clear, and re-tuning it would put the
        // corridor argument above back in play for no visual gain. Everything
        // that changed is above the crotch, below the deck, or in the fan.
        const b = this.builder();
        b.uvScale = 0.5;
        // Read from the module-level table so the fan (`bridgeFan`, built per
        // anchor) and the body cannot drift apart — the fan has to know exactly
        // where this shaft is at every height it lands on.
        const { leg: LEG, knee: KNEE, top: TOP, pier: PIER, mid: MID } = BRIDGE;
        const pale = 0xe0dbcd, stone = 0xd2ccbc;
        for (const sx of [-1, 1]) {
          // ---- the pier the leg actually stands on --------------------------
          // Descends BELOW the anchor, which is the deck. That is the same
          // convention `bridgePylon` and `overpassArch` use and it is listed with
          // its reason in `.probe-tmp/buried.ts`'s DESIGNED_SKIRT: a corridor
          // prop's anchor is the carriageway, so anything that meets the ground
          // has to hang from it. 5.4 m covers the 3.01 m of measured air with
          // margin and buries harmlessly where the bank is high.
          b.box(sx * LEG, PIER * 0.5 + 0.3, 0, 2.9, (0.6 - PIER) * 0.5, 3.3, stone,
            { taper: 1.18, shade: { top: 1.06 } });
          b.box(sx * LEG, PIER + 0.55, 0, 4.0, 0.55, 4.4, 0x9a958c, { shade: { top: 1.1 } });
          b.box(sx * LEG, 0.6, 0, 2.2, 0.6, 2.5, 0x8f8b82, { shade: { top: 1.12 } });
          // Four-sided tubes: a square section, and the only primitive here that
          // can lean. Two segments per leg so the lean has a knuckle in it.
          b.tube(sx * LEG, 0.9, 0, sx * LEG * 0.6, KNEE * 0.66, 0, 1.5, 4, pale, 1.0);
          b.tube(sx * LEG * 0.6, KNEE * 0.66, 0, sx * 1.6, KNEE, 0, 1.25, 4, pale, 0.94);
          // A shadow line down the outer face of each leg. Two thin battens on a
          // 30 m member is the cheapest thing that stops a smooth white tube
          // reading as a default primitive at 100 m.
          for (const sz of [-1, 1]) {
            b.tube(sx * (LEG - 0.1), 1.2, sz * 1.05, sx * (LEG * 0.6 - 0.1), KNEE * 0.66,
              sz * 0.9, 0.13, 4, 0xbdb6a6, 0.8);
          }
        }
        // ---- the obelisk above the crotch ------------------------------------
        // Was 31 m of shaft on a 58 m tower. Now 59 m on an 88 m one: the tower
        // is 2.6x its own foot spread instead of 1.8x, which is the proportion
        // the real structure has. Built in two stages with a set-off between
        // them, so the taper has a joint in it rather than being one long cone.
        // `bridgeShaftHalf()` is the same two stages read as a function of
        // height — keep them in step.
        b.box(0, KNEE + (MID - KNEE) * 0.5, 0, BRIDGE.shaftLo, (MID - KNEE) * 0.5, 2.2, 0xe8e3d6,
          { taper: BRIDGE.taperLo, shade: { top: 1.14 } });
        b.box(0, MID + 0.32, 0, 2.05, 0.32, 1.8, stone, { shade: { top: 1.2 } });
        b.box(0, MID + 0.64 + (TOP - MID) * 0.5, 0, BRIDGE.shaftHi, (TOP - MID) * 0.5, 1.56,
          0xe8e3d6, { taper: BRIDGE.taperHi, shade: { top: 1.14 } });
        b.box(0, TOP + 1.0, 0, 1.4, 0.36, 1.25, stone, { shade: { top: 1.2 } });
        b.box(0, TOP + 2.9, 0, 1.28, 1.55, 1.14, 0xe8e3d6, { taper: 0.08, shade: { top: 1.2 } });
        // Deck crossbeam under the crotch: what the legs are actually holding.
        // Its TOP is at the crotch, not 0.8 m under it. It used to span
        // KNEE-2.4..KNEE-0.8, which left the obelisk's 5 m wide base starting on
        // 0.8 m of air with only the two 2.5 m wide leg tops anywhere near it —
        // measured at 0.801 m by `.probe-tmp/staygap.ts` once that probe could
        // see individual components at all.
        b.box(0, KNEE - 0.8, 0, LEG * 0.62, 0.8, 1.6, 0xcfc9ba, { shade: { top: 1.1 } });
        // ---- THE FAN IS BUILT PER ANCHOR. See `metalPerAnchor`. --------------
        // It used to be one shared geometry with the deck ends authored at a
        // literal `sx * 12.6, y 2.9` and one 0.5 x 0.75 x 0.55 anchor casting per
        // stay. Every one of those numbers is a constant, and the thing they are
        // supposed to meet is not: the deck at Boston's two towers is banked 5.2
        // and 7.8 degrees, falls 0.3-0.9 m over the fan's own length, and curves
        // away from the straight chord by up to 1.66 m at 27 m of reach.
        //
        // Measured against the DRAWN track mesh (`.probe-tmp/staygap.ts`, which
        // decomposes the prop into welded components rather than trusting its
        // AABB the way `floating.ts` has to): all 96 castings hung in the air,
        // p50 1.32 m, p90 4.06 m, max 5.01 m, and 6 sat over the tarmac at
        // negative verge. That is the owner's *"suspension cables still appear to
        // be floating"*, and it is not a tuning problem — the two towers need
        // different numbers, so no shared geometry can be right at both.
        //
        // `bridgeFan` therefore resolves each stay's deck end against the
        // carriageway cross-section at that stay's own arc length, and stands a
        // real anchor pier on the shoulder under it. The tower ends are derived
        // from the shaft's own taper at the stay's height instead of a literal
        // 1.5, so the top stay is embedded rather than 0.05 m proud of it.
        const glow = this.builder();
        glow.sphere(0, TOP + 5.2, 0, 0.5, 8, 5, 0xff3b2e);
        // Soffit lights, hung off the underside of the crossbeam — which moved up
        // 0.8 m with it, so these move too or they hang in space under it.
        for (let i = -2; i <= 2; i++) {
          glow.box(i * 5.6, KNEE - 1.7, 0, 0.5, 0.14, 0.5, 0xfff0c8);
        }
        // Obstruction lights up the obelisk. Boston is a daylight circuit so
        // this is not doing the work `broadcastSpire`'s scheme does — it is the
        // detail that says "a structure tall enough to need warning lights",
        // and it costs 3 spheres.
        for (const f of [0.34, 0.67, 1.0]) {
          glow.sphere(0, KNEE + (TOP - KNEE) * f, 1.3, 0.34, 6, 4, 0xff5a3a);
        }
        return {
          geo: b.build('bridgeArch'),
          metalPerAnchor: (a) => this.bridgeFan(a),
          glow: glow.build('bridgeArchGlow'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'glasstower': {
        // ---- BOSTON: the tall glass tower ----------------------------------
        // One sheer 118 m slab. The read is proportion: far thinner than the
        // procedural `skyscraper`'s setback massing, and mirror-dark against the
        // brick. ACROSS-ROAD half-extent 7.3 m (the canopy), 15.9 m along.
        const b = this.builder();
        // One curtain-wall tile per 7.2 m: two floors of a 3.6 m module.
        b.uvScale = 1 / this.facadeTileOf('curtain');
        const H = 118, hx = 14, hz = 5.4;
        // Lifted from 0x24404f: the facade map multiplies this, and the critic's
        // core daylight finding was facades rendering near-black.
        b.box(0, H * 0.5, 0, hx, H * 0.5, hz, 0x4a6d83,
          { taper: 0.965, shade: { side: 1.0, top: 1.14 } });
        b.box(0, 1.7, 0, hx + 1.2, 1.7, hz + 1.2, 0x1a252d, { shade: { top: 1.02 } });
        b.box(0, 3.5, 0, hx + 1.9, 0.18, hz + 1.9, 0x141c23);
        b.box(0, H + 0.55, 0, hx * 0.965, 0.55, hz * 0.965, 0xcfd6dc, { shade: { top: 1.22 } });
        b.prism(0, H + 1.1, 0, 0.22, 8, 6, 0x9aa1a9, { taper: 0.35 });
        // A mullion every 2.5 m. 118 m of unbroken glass reads as a painted
        // slab; the mullions are what make it a curtain wall at any distance.
        for (let i = -5; i <= 5; i++) {
          for (const sz of [1, -1]) {
            b.box(i * 2.5, H * 0.5, sz * (hz + 0.07), 0.18, H * 0.5, 0.1, 0x4a687e,
              { taper: 0.965 });
          }
        }
        const win = this.builder();
        let cell = 0;
        const floors = 28;
        for (let f = 0; f < floors; f++) {
          const y = 6 + f * ((H - 10) / floors);
          for (const sz of [1, -1]) {
            for (let i = -4; i <= 4; i++) {
              win.cell = cell++;
              win.plate(i * 2.5, y, sz * (hz + 0.14), 2.0, 2.0,
                sz > 0 ? 0 : Math.PI, 0xa8d8ff, { single: true });
            }
          }
        }
        win.cell = 0;
        return {
          geo: b.build('glassTower'), windows: win.build('glassTowerWindows'),
          // Real curtain wall: mullion grid, spandrel bands and per-pane tint out
          // of the facade set, on a circuit whose other buildings are brick.
          mat: this.facadeMat('curtain'), cull: CULL_FAR,
        };
      }

      case 'brownstonerow': {
        // ---- BOSTON: the brick brownstone terrace --------------------------
        // Three bowfront houses as one prop, so a run of them at a matched step
        // becomes a continuous terrace for one draw call. The BOW is the read:
        // a five-sided bay running the full height of every house.
        //
        // ACROSS-ROAD half-extent 6.3 m (the stoop), 11.6 m along.
        //
        // ---- SLIMMED after measuring. At four houses the prop was 31 m long, and
        // a 31 m prop standing tangentially at lat 20 on the R62 kink swings its
        // ENDS ~2.7 m closer to the road than its centre — `.probe-tmp/crowding.ts`
        // measured the worst instance reaching **0.7 m inside the tarmac** and the
        // recipe filling 9.63 % of the whole frame (body + glow) across 47 of 204
        // chase stations, the largest figure on any city circuit. `lat` cannot fix
        // a chord: three houses (23 m) halves the swing, and CityDefs also moves
        // the run out to lat 22 and stops it before the kink. Same continuous
        // terrace, because the authored step matches the new length.
        const b = this.builder();
        // One masonry tile per 6.2 m of wall — two storeys, twelve brick courses
        // each. Was 0.7 (a tile every 1.4 m), which on a facade map would put four
        // storeys of windows inside one real storey.
        b.uvScale = 1 / this.facadeTileOf('masonry');
        const N = 3, W = 7.6, D = 4.6, H = 15.2;
        // Lighter than before: the facade map multiplies these, and a map over a
        // near-black brick is still near-black.
        const bricks = [0xa8604a, 0x99543e, 0xb06d52, 0x8c4c3a];
        const halfRun = N * W * 0.5;
        for (let i = 0; i < N; i++) {
          const x = -halfRun + W * (i + 0.5);
          const brick = bricks[(i + rng.int(0, 3)) % bricks.length];
          b.box(x, H * 0.5, 0, W * 0.5, H * 0.5, D, brick, { shade: { top: 1.06 } });
          b.prism(x, 0.55, D - 0.45, 1.85, H - 0.55, 5, brick,
            { yaw: Math.PI * 0.5, shade: { top: 1.1 } });
          // Granite basement course, and a stoop up to the parlour floor.
          b.box(x, 0.55, D + 0.3, W * 0.5, 0.55, 0.6, 0x9a958c, { shade: { top: 1.14 } });
          for (let s = 0; s < 4; s++) {
            b.box(x + 2.3, 0.22 + s * 0.3, D + 1.65 - s * 0.34, 1.0, 0.15, 0.2, 0xa8a29a,
              { shade: { top: 1.16 } });
          }
          // Cornice, mansard course and one chimney per house.
          b.box(x, H + 0.3, 0, W * 0.5 + 0.24, 0.3, D + 0.32, 0x5c4a3c, { shade: { top: 1.2 } });
          b.box(x, H + 1.55, 0, W * 0.46, 0.95, D * 0.88, 0x3a312a,
            { taper: 0.58, shade: { top: 1.16 } });
          b.box(x - 2.5, H + 2.7, -D * 0.4, 0.52, 1.15, 0.52, brick);
        }
        // Lit parlour windows — but gated on the sky. Boston is `skyPreset: 'day'`,
        // and a terrace with half its windows blazing at midday was part of the
        // same "night city under a midday sky" finding as the tower pass.
        const glow = this.builder();
        const litChance = 0.10 + 0.55 * this.night;
        for (let i = 0; i < N; i++) {
          const x = -halfRun + W * (i + 0.5);
          for (let s = 0; s < 4; s++) {
            const col = rng.next() < litChance ? 0xffdca8 : 0x1a1c22;
            glow.plate(x, 2.4 + s * 3.4, D + 1.62, 1.5, 1.9, 0, col, { single: true });
          }
        }
        return {
          geo: b.build('brownstoneRow'), glow: glow.build('brownstoneGlow'),
          // The masonry facade set, so the terrace has brick courses, mortar and
          // punched window reveals instead of a flat red box — this is the recipe
          // the critic named as "Boston's brownstone is a flat red box", and the
          // brick scale is fixed by `uvScale` above rather than by a repeat count.
          mat: this.facadeMat('masonry'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'goldendome': {
        // ---- BOSTON: the gold-domed state house ----------------------------
        // Brick block, columned portico, granite terrace, and a GILDED DOME —
        // which is the only part that has to read at 200 m, so it goes in the
        // `metal` pass and catches the sun properly.
        // ACROSS-ROAD half-extent 12.9 m, 25.4 m along.
        const b = this.builder();
        b.uvScale = 0.55;
        const W = 17, D = 9.5, H = 15;
        b.box(0, 0.7, 0, W + 2.4, 0.7, D + 3.4, 0x9a958c, { shade: { top: 1.16 } });
        b.box(0, H * 0.5 + 1.4, 0, W, H * 0.5, D, 0x8e4a38, { shade: { top: 1.07 } });
        for (const sx of [-1, 1]) {
          b.box(sx * (W + 4.2), 5.6, 0, 4.2, 4.2, D * 0.8, 0x7f4130, { shade: { top: 1.09 } });
        }
        // Portico: five columns, entablature, pediment.
        for (let i = -2; i <= 2; i++) {
          b.prism(i * 3.1, 1.4, D + 1.4, 0.52, 8.4, 10, 0xe6e1d6, { taper: 0.94 });
        }
        b.box(0, 10.6, D + 1.4, 8.4, 0.8, 1.1, 0xe6e1d6, { shade: { top: 1.18 } });
        b.box(0, 12.3, D + 1.4, 8.8, 0.95, 0.9, 0xdfd9cc, { taper: 0.5, shade: { top: 1.2 } });
        // Drum. The sphere's lower half hides inside it, so this is a dome.
        b.prism(0, H + 1.4, 0, 6.4, 4.2, 12, 0xe6e1d6, { taper: 0.96 });
        const met = this.builder();
        met.sphere(0, H + 5.6, 0, 6.5, 14, 7, 0xffc93a, { squash: 0.94 });
        met.prism(0, H + 11.2, 0, 1.15, 2.6, 8, 0xffc93a, { taper: 0.72 });
        met.sphere(0, H + 14.1, 0, 0.72, 8, 5, 0xffd96a);
        met.prism(0, H + 14.7, 0, 0.13, 2.4, 5, 0xffd96a, { taper: 0.45 });
        // NO terrace uplighters. They were authored at the terrace edge, 13 m out
        // from the anchor, and `.probe-tmp/buried.ts` measured every one of them
        // 100 % under ground: the building sits at lat -34 on natural ground 2.7 m
        // BELOW the raised plaza, so the terrain climbs 2.3 m across the terrace
        // toward the road. A 0.28 m light box cannot survive that, and the read
        // here is the gilded dome, not the ground lighting. One draw call saved.
        return {
          geo: b.build('goldenDome'), metal: met.build('goldenDomeGild'),
          cull: CULL_FAR,
        };
      }

      case 'stadiumwall': {
        // ---- BOSTON: the green outfield wall -------------------------------
        // A 42 m dark-green slab with a yellow line along the top, the manual
        // scoreboard facing the street, a foul pole and two flood towers behind
        // it. Colour blocking does all the work.
        // ACROSS-ROAD half-extent 4.9 m (the flood towers), 21.4 m along.
        const b = this.builder();
        b.uvScale = 0.5;
        const L = 21, H = 11.4;
        b.box(0, H * 0.5, 0, L, H * 0.5, 0.62, 0x1c4a2e, { shade: { top: 1.05 } });
        b.box(0, H + 0.3, 0, L + 0.3, 0.3, 0.95, 0xd8c33a, { shade: { top: 1.22 } });
        b.box(0, 1.1, 0, L + 0.4, 1.1, 1.15, 0x163d26, { shade: { top: 1.0 } });
        // The scoreboard, facing the road (+Z), with its slots.
        b.box(-L * 0.42, 4.7, 0.76, 6.4, 3.2, 0.16, 0x14171b, { shade: { top: 1.1 } });
        for (let i = -4; i <= 4; i++) {
          for (const sy of [-1.5, 0.2, 1.8]) {
            b.box(-L * 0.42 + i * 1.35, 4.7 + sy, 0.9, 0.5, 0.5, 0.06, 0xe8e4d8);
          }
        }
        b.prism(L - 1.4, H, -0.2, 0.17, 9.5, 6, 0xd8c33a, { taper: 0.78 });
        for (const sx of [-0.55, 0.4]) {
          b.prism(sx * L, 0, -3.6, 0.6, 24, 6, 0x4a5057, { taper: 0.48, capBottom: true });
          b.box(sx * L, 24.5, -3.6, 3.6, 1.7, 0.55, 0x3a3f47, { shade: { top: 1.14 } });
        }
        const glow = this.builder();
        for (const sx of [-0.55, 0.4]) {
          for (let i = -2; i <= 2; i++) {
            glow.box(sx * L + i * 1.3, 24.5, -3.28, 0.52, 0.66, 0.12, 0xfff4d2);
          }
        }
        return {
          geo: b.build('stadiumWall'), glow: glow.build('stadiumFloods'), cull: CULL_FAR,
        };
      }

      case 'pagodatower': {
        // ---- TAIPEI 101 -----------------------------------------------------
        // Owner, twice: *"Taipei 101 is still not aesthetically pleasing and
        // appears rather simplistic."* The rebuild is documented against the real
        // building in the T101 helper block at the foot of this file; the numbers
        // here are the profile, and every one of them is a fraction of the real
        // tower's 508 m rescaled to the 187 m this placement was measured for.
        //
        //   real                        share   here
        //   base + podium (L1-25)       21.7%   30.0 m
        //   eight modules (L26-90)      53.0%   108.0 m  (8 x 13.5)
        //   crown + setbacks (L91-101)  13.5%   26.0 m
        //   pinnacle mast               11.8%   23.0 m
        //                                       ------
        //                                       187.0 m
        //
        // HEIGHT IS HELD AT 187 m ON PURPOSE. `.probe-tmp/landmark.ts` measured
        // this placement at whole% 22.8 / vis% 24.3 with the tower filling 55% of
        // frame height; a taller tower pushes its own top out of a 79.75 deg
        // vertical FOV and takes whole% back toward the 0.0 the old placement
        // scored. The note in `CityDefs.ts` above this prop's placement is the
        // full history. Grow the DETAIL, never the envelope.
        //
        // ACROSS-ROAD half-extent 24.1 m — the podium's chamfered corner, at
        // 19.4 x 1.241. It stands 320 m from the racing line, so this buys
        // nothing but a bigger bounding sphere; it is recorded because every
        // other recipe in this file records one.
        const b = this.builder();
        b.uvScale = 1 / this.facadeTileOf('curtain');
        const met = this.builder();
        met.uvScale = 0.4;
        const glow = this.builder();
        const win = this.builder();
        win.uvScale = 0.5;

        // ---- BLUE-GREEN GLASS, AUTHORED FAR PAST BLUE-GREEN -----------------
        // This was #71968c — the real building's colour, near enough — and on
        // screen it read charcoal-brown. Measured rather than argued
        // (`.probe-tmp/t101.ts`, section 6c, which resolves the REAL map bytes
        // times the REAL vertex colours through the REAL preset):
        //
        //   albedo               #628586  h 183 deg  s 15 %
        //   sunlit face          h 33-39 deg, s 11-32 %   <- orange, every bracket
        //   shaded face          h 26 / 239 / 213 deg     <- no hue of its own AT ALL
        //
        // Three things eat the colour and all three are multiplicative:
        //  1. `facadeTexel`'s mullions land on (1.16, 1.17, 1.20) x 235 and CLAMP
        //     to white, and the spandrel band is near-neutral, so 37 % of the wall
        //     area is colourless before the vertex colour is applied. The map's
        //     area mean is #ced9eb at luminance 0.687 — bright and almost grey.
        //  2. `facadeMat('curtain')` carries `metalness: 0.45`, so 45 % of the
        //     diffuse albedo is removed and reappears as a specular tinted by F0
        //     and coloured by the ENVIRONMENT — which at sunset is orange.
        //  3. The key is #ffa055 at intensity 3.7 and the sun sits 4.5 deg up, so
        //     a VERTICAL face turned toward it has NdotL 0.997 and takes the whole
        //     of it. Linear-space, the light landing on a shaded face is already
        //     (0.336, 0.192, 0.284); green only wins there if the albedo's g:r
        //     exceeds 1.75 and its g:b exceeds 1.48.
        //
        // So the authored colour has to be pushed well past the target, which is
        // exactly the rule `CityDefs.ts:678-682` already records for this
        // circuit's kerbs: "warmth in the albedo compounds with a warm key and a
        // warm env into gold". Same argument, one surface up. The gate is on
        // CHROMA and on HUE STABILITY ACROSS THE ENV BRACKET, because the failure
        // was not "wrong hue", it was "no hue of its own".
        // The RED channel is the one that has to go, not the overall value: the
        // specular term is `F0 x E`, F0 is `0.022 + 0.45 x albedo`, and E at dusk
        // is red-dominant — so albedo red is multiplied into the frame twice, once
        // through the diffuse and once through a specular that is 45 % of the
        // shaded face's whole radiance. Dropping linear red from 0.125 to 0.085
        // takes the shaded face from s 9 % to s 20 % in the pessimistic bracket
        // and costs the sunlit face nothing it should not lose.
        const GLASS = 0x51b98a;
        const TRIM = 0x9ad9bd;      // anodised aluminium fascia, same treatment
        const SOFFIT = 0x265449;    // the eave underside — real AO, not a guess
        const STONE = 0x5d6a68;     // podium granite
        const GOLD = 0xffc23a;      // ruyi medallions and the coin motif
        const STEEL = 0xc4d0d2;     // the pinnacle

        // ---- podium and base ------------------------------------------------
        let v = 0;
        const band = (
          y0: number, y1: number, r0: number, r1: number, hex: number,
          o: T101SkinOpts = {},
        ): void => {
          t101Skin(b, y0, y1, r0, r1, hex, { ...o, v0: o.v0 ?? v });
          v += Math.hypot(y1 - y0, r1 - r0) * b.uvScale;
        };
        band(0.0, 2.4, 19.4, 18.8, STONE, { shade: 0.88 });     // battered plinth
        band(2.4, 9.6, 18.8, 18.2, STONE, { shade: 1.0 });      // the mall, six storeys
        band(9.6, 10.4, 18.9, 18.9, TRIM, { shade: 1.14 });     // podium cornice slab
        band(10.4, 15.6, 18.2, 14.4, STONE, { shade: 1.08 });   // THE SLOPED SKIRT
        band(15.6, 28.0, 14.4, 11.9, GLASS, { shade: 0.96 });   // base, battered in
        band(28.0, 28.35, 12.5, 11.9, SOFFIT, { shade: 0.6 });
        band(28.35, 28.9, 12.5, 12.58, TRIM, { shade: 1.16 });
        band(28.9, 30.0, 12.58, 10.6, TRIM, { shade: 1.12 });
        // The giant ancient-coin motif, one per cardinal face of the mall. A
        // circle with a square hole is the single most legible "this is Taipei"
        // mark available at 320 m that is not the silhouette itself.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          t101Disc(met, dx * 18.52, dz * 18.52, 6.0, 3.4, 1.0, 0.6, 16, true, GOLD, 0.86);
        }

        // ---- the eight modules ----------------------------------------------
        // Each is a truncated inverted pyramid flaring 8.3 deg outward as it
        // rises, closed by a projecting drip lip over a dark soffit and a soffit
        // raked back 54 deg to the start of the next one. Four golden ruyi
        // medallions on the fascia, one per chamfered corner.
        const MOD = 13.5, MODS = 8, Y0 = 30.0;
        const R_LO = 10.6, R_HI = 12.2, R_LIP = 12.78, R_FAS = 12.86;
        let cell = 1;
        for (let i = 0; i < MODS; i++) {
          const y = Y0 + i * MOD;
          // ---- A GRADIENT, NOT A STRIPE -------------------------------------
          // This was three bands at [0.93, 1.04, 0.90] — a bright middle between
          // two darker ends. Intended as a fake vertical gradient; what it
          // actually is, is an 11.8 % luminance step a third of the way up each
          // module and a 13.5 % step two thirds of the way up. Measured, the
          // module stack carried SIX strong contrast edges per module, one every
          // ~1.3 m, and the reviewer's screenshot from 230 m read it exactly as
          // that is: "a stack of many shallow bands rather than eight substantial
          // blocks — closer to a pagoda spine". The eye counts tiers by counting
          // contrast edges, and there were six per tier.
          //
          // Now four bands on a MONOTONE ramp, steps of 2.9 / 4.0 / 5.3 %, all
          // under the 8 % the probe treats as a resolvable edge. Monotone is also
          // the physically right shape: ambient occlusion increases toward the
          // overhanging cornice above, so the wall darkens as it rises. The one
          // strong edge per module is now the cornice assembly, which is what it
          // is on the real building. Costs 16 triangles a module.
          const AO: readonly number[] = [1.02, 0.99, 0.95, 0.90];
          for (let s = 0; s < 4; s++) {
            const a = y + (11.0 / 4) * s, c = y + (11.0 / 4) * (s + 1);
            band(a, c, R_LO + (R_HI - R_LO) * (s / 4), R_LO + (R_HI - R_LO) * ((s + 1) / 4),
              GLASS, { shade: AO[s] });
          }
          band(y + 11.00, y + 11.35, R_LIP, R_HI, SOFFIT, { shade: 0.58 });
          band(y + 11.35, y + 11.90, R_LIP, R_FAS, TRIM, { shade: 1.18 });
          band(y + 11.90, y + 13.50, R_FAS, R_LO, TRIM, { shade: 1.10 });
          t101Medallions(met, y + 11.62, R_FAS, 1.85, GOLD);
          // Cove lighting tucked under the drip lip — the real building's nightly
          // wash, and at `night` 0.1 it is the tenth of a glow golden hour wants.
          t101Skin(glow, y + 10.55, y + 10.95, R_HI, R_HI, 0x8fe6f2, { grow: 0.07 });
          // Interior lights. `cell` drives the per-pane hash in `prop-windows`, so
          // marching it forward is what stops three identical lit bands stacking.
          for (let k = 0; k < 3; k++) {
            const wy = y + 1.7 + k * 3.1;
            const rr = (h: number): number => R_LO + (R_HI - R_LO) * (h / 11.0);
            cell = t101Skin(win, wy, wy + 0.85, rr(wy - y), rr(wy - y + 0.85), 0xffd9a8,
              { grow: 0.06, splits: 2, cell0: cell });
          }
        }

        // ---- crown, stepped setbacks, mast base ------------------------------
        const YC = Y0 + MODS * MOD;                              // 138.0
        band(YC, YC + 8.4, 9.4, 10.55, GLASS, { shade: 1.02 });
        band(YC + 8.4, YC + 8.72, 11.05, 10.55, SOFFIT, { shade: 0.58 });
        band(YC + 8.72, YC + 9.24, 11.05, 11.12, TRIM, { shade: 1.18 });
        band(YC + 9.24, YC + 10.7, 11.12, 8.9, TRIM, { shade: 1.10 });
        t101Medallions(met, YC + 8.98, 11.12, 1.85, GOLD);
        band(YC + 10.7, YC + 16.2, 8.9, 6.6, GLASS, { shade: 0.98 });
        band(YC + 16.2, YC + 20.4, 6.6, 4.4, GLASS, { shade: 1.05 });
        band(YC + 20.4, YC + 23.6, 4.4, 2.9, TRIM, { shade: 1.08 });
        band(YC + 23.6, YC + 26.0, 2.9, 1.7, STONE, { shade: 1.0, capTop: true });
        cell = t101Skin(win, YC + 2.2, YC + 3.1, 9.7, 9.82, 0xffe0b4,
          { grow: 0.06, splits: 3, cell0: cell });
        t101Skin(win, YC + 5.0, YC + 5.9, 10.08, 10.2, 0xffe0b4,
          { grow: 0.06, splits: 3, cell0: cell });
        // The observatory band reads as one continuous lit ring, not panes.
        t101Skin(glow, YC + 7.5, YC + 8.15, 10.46, 10.46, 0xffd7a4, { grow: 0.07 });

        // ---- the pinnacle ----------------------------------------------------
        // 23 m of mast in three stages with collars, on the metal pass so the low
        // sun actually catches it. A single cone read as a party hat.
        const YM = YC + 26.0;                                    // 164.0
        met.prism(0, YM, 0, 1.6, 11.5, 8, STEEL, { taper: 0.52, capTop: false });
        met.prism(0, YM + 11.5, 0, 0.83, 7.5, 6, STEEL, { taper: 0.40, capTop: false });
        met.prism(0, YM + 19.0, 0, 0.33, 4.0, 5, 0xe2ecee, { taper: 0.25 });
        for (const cy of [YM + 3.4, YM + 7.6, YM + 13.2]) {
          const rr = cy < YM + 11.5
            ? 1.6 * (1 + (0.52 - 1) * (cy - YM) / 11.5)
            : 0.83 * (1 + (0.40 - 1) * (cy - YM - 11.5) / 7.5);
          met.prism(0, cy, 0, rr * 1.28, 0.45, 6, 0x94a3a6, { capTop: false });
        }
        // Podium entrance wash and the two aviation beacons.
        t101Skin(glow, 3.0, 4.1, 18.72, 18.63, 0xffd2a0, { grow: 0.06, splits: 3 });
        glow.sphere(0, YM + 11.5, 0, 0.55, 6, 4, 0xff7a5a);
        glow.sphere(0, YM + 23.4, 0, 0.8, 8, 5, 0xff8f66);

        return {
          geo: b.build('pagodaTower'),
          // THE CURTAIN WALL IS MATERIAL, NOT COLOUR. `uvScale` above is
          // 1 / 7.2 m, so the 3-bay tile lands 8 structural bays across a 21.2 m
          // module face — which is what the real tower has — and the 2-floor tile
          // gives a 3.6 m storey. Section 0: no solid-colour standard material.
          mat: this.facadeMat('curtain'),
          metal: met.build('pagodaGild'),
          glow: glow.build('pagodaGlow'),
          windows: win.build('pagodaWindows'),
          softGlow: true, cull: CULL_FAR,
        };
      }

      case 'memorialhall': {
        // ---- TAIPEI: the memorial hall on the plaza ------------------------
        // White marble mass on a three-step platform under a DOUBLE OCTAGONAL
        // cobalt roof. The blue octagon is the read; everything else is mass.
        // This is also what makes the plaza a plausible home for the flag mast.
        // ACROSS-ROAD half-extent 24.4 m. Authored once, at lat 46.
        const b = this.builder();
        b.uvScale = 0.45;
        const W = 19, D = 19;
        for (let s = 0; s < 3; s++) {
          b.box(0, 0.45 + s * 0.9, 0, W + 5.4 - s * 1.7, 0.45, D + 5.4 - s * 1.7,
            0xe8e4da, { shade: { top: 1.18 } });
        }
        b.box(0, 8.7, 0, W, 6.0, D, 0xf2eee4, { shade: { top: 1.12 } });
        // Four tall arched recesses on the road face.
        for (let i = -1; i <= 2; i++) {
          b.box((i - 0.5) * 7.6, 7.9, D + 0.1, 2.4, 5.2, 0.18, 0x64707a);
        }
        b.prism(0, 14.7, 0, W + 3.0, 0.7, 8, 0xe8e4da,
          { yaw: Math.PI / 8, shade: { top: 1.18 } });
        b.prism(0, 15.4, 0, W + 2.4, 5.4, 8, 0x1f4fa8,
          { yaw: Math.PI / 8, taper: 0.52, shade: { side: 1.0, top: 1.06 } });
        b.prism(0, 20.8, 0, (W + 2.4) * 0.58, 0.6, 8, 0xe8e4da,
          { yaw: Math.PI / 8, shade: { top: 1.2 } });
        b.prism(0, 21.4, 0, (W + 2.4) * 0.5, 4.8, 8, 0x1f4fa8,
          { yaw: Math.PI / 8, taper: 0.32, shade: { side: 1.0, top: 1.06 } });
        b.prism(0, 26.2, 0, 1.1, 2.2, 8, 0xffc93a, { taper: 0.48 });
        b.sphere(0, 28.8, 0, 0.88, 8, 5, 0xffd96a);
        // NO plaza uplighters, for the same measured reason as `goldendome`: a
        // 48 m wide building standing on a slope buries anything authored near its
        // outer corner (5.75 m under ground at the platform edge, 2.21 m even on
        // the top step). The blue octagonal roof is the read.
        return { geo: b.build('memorialHall'), cull: CULL_FAR };
      }

      case 'marketstall': {
        // ---- TAIPEI: one bay of the night-market arcade --------------------
        // Shophouse behind, stall and striped awning in front, vertical sign
        // boards and a lantern string in the glow pass. Authored as a run at a
        // 9.6 m step, so a dozen of them become a lit corridor for two draws.
        // ACROSS-ROAD half-extent 3.85 m, 4.65 m along.
        //
        // ---- SLIMMED after measuring, same lesson as `brownstonerow` and neon's
        // `alleyBlock`: at 4.6 m of across-road half-extent, 32 of these on an
        // 8.5 m half-width street filled 9.94 % of the frame (body + glow) across
        // 41 of 200 stations with 2.9 m of clear verge. The shophouse is 1.1 m
        // shallower, the awning reaches 0.35 m less, and CityDefs moves the run
        // out to lat 20 and spaces it 12 m instead of 9.6 — gaps between stalls
        // read MORE like a market than an unbroken wall did.
        const b = this.builder();
        b.uvScale = 0.8;
        const W = 4.4, storeys = 3, H = storeys * 3.3;
        b.box(0, H * 0.5, -1.35, W, H * 0.5, 2.5,
          rng.next() < 0.5 ? 0xc0b7a4 : 0xa89c8a, { shade: { top: 1.08 } });
        b.box(0, H + 0.4, -1.35, W + 0.25, 0.4, 2.75, 0x8d8375, { shade: { top: 1.18 } });
        b.box(0, 1.6, 1.02, W * 0.9, 1.6, 0.14, 0x454a52);
        // Stall counter, four posts, and an awning pitched out over the counter.
        b.box(0, 0.55, 2.1, W * 0.82, 0.55, 0.8, 0x8a5c3a, { shade: { top: 1.14 } });
        for (const sz of [2.72, 1.0]) {
          for (const sx of [-1, 1]) {
            b.prism(sx * W * 0.8, 0, sz, 0.075, sz > 2 ? 2.9 : 3.3, 4, 0x545a62);
          }
        }
        // ---- THE AWNING, striped rather than one flat saturated rectangle.
        // It was a single `plate` of solid `0xd8402f` or `0x2f6fd0` on an untextured
        // material, and it is the largest single surface on the recipe — the same
        // section 0 flat-colour defect as the start gantry's banners. A market awning
        // is striped, so the stripes are geometry: nine slats alternating the accent
        // with an off-white, each one a shade different from the last so the run
        // reads as cloth over a frame instead of a printed sheet.
        {
          const accent = rng.next() < 0.5 ? 0xd8402f : 0x2f6fd0;
          const slats = 9, span = W * 2.0;
          for (let i = 0; i < slats; i++) {
            const cx = (-0.5 + (i + 0.5) / slats) * span;
            const col = i % 2 === 0 ? accent : 0xf2ece0;
            b.plate(cx, 3.2, 1.95, span / slats + 0.02, 2.4, 0, col,
              { single: true, pitch: 1.32, shade: 0.94 + 0.1 * ((i * 7) % 5) / 4 });
          }
          // Scalloped valance along the front edge, and the pole that carries it.
          for (let i = 0; i < slats; i++) {
            const cx = (-0.5 + (i + 0.5) / slats) * span;
            b.plate(cx, 2.05, 3.06, span / slats + 0.02, 0.34, 0,
              i % 2 === 0 ? accent : 0xf2ece0, { single: true, shade: 0.9 });
          }
          b.tube(-span * 0.5, 2.24, 3.02, span * 0.5, 2.24, 3.02, 0.05, 5, 0x6b7178);
        }
        const glow = this.builder();
        glow.plate(W * 0.72, H * 0.62, 0.72, 0.95, H * 0.62, 0, 0xff4d6a, { single: true });
        glow.plate(-W * 0.72, H * 0.48, 0.72, 0.8, H * 0.46, 0, 0x39ff88, { single: true });
        for (let i = -2; i <= 2; i++) {
          glow.sphere(i * W * 0.42, 3.55, 2.72, 0.28, 7, 5,
            i % 2 ? 0xffb43a : 0xff6a4a, { squash: 1.15 });
        }
        glow.box(0, 1.95, 2.2, W * 0.8, 0.1, 0.12, 0xffe6b0);
        return {
          geo: b.build('marketStall'), glow: glow.build('marketGlow'), cull: CULL_MID,
        };
      }

      case 'mountainridge': {
        // ---- TAIPEI: the mountains behind ----------------------------------
        // Three overlapping near-cones, hazed toward the top so they read as
        // distance rather than as geometry. `shadow: false` on purpose: a 96 m
        // hill 400 m away would otherwise throw a cascade shadow over the whole
        // circuit for something that is meant to be backdrop.
        // Half-extent 120 m — authored beyond lat 380, i.e. outside the whole
        // footprint, so its box corners cannot reach any carriageway.
        const b = this.builder();
        b.uvScale = 0.08;
        b.jitter = 0.07;
        const peaks: Array<[number, number, number, number]> = [
          [0, 0, 62, 96], [-74, 26, 46, 68], [68, -18, 52, 78],
        ];
        for (const [px, pz, r, h] of peaks) {
          b.prism(px, 0, pz, r * rng.range(0.94, 1.06), h * rng.range(0.9, 1.1), 7, 0x4e6255,
            { taper: 0.07, capBottom: false, shade: { side: 1.0, top: 1.22 } });
          b.prism(px, h * 0.6, pz, r * 0.38, h * 0.44, 7, 0x76877a,
            { taper: 0.09, yaw: 0.55 });
        }
        return { geo: b.build('mountainRidge'), cull: CULL_FAR, shadow: false };
      }

      case 'latticetower': {
        // ---- TOKYO: the red lattice tower ----------------------------------
        // Four legs, X-braced over nine levels, two observation decks, a mast.
        // 99 m. Built from 4-sided `tube`s: a square member section, and the
        // only primitive here that can lean, at 8 triangles each.
        // ACROSS-ROAD half-extent 13.1 m. Authored once, at lat -46.
        const b = this.builder();
        const red = 0xe0552b, pale = 0xf0e8dc;
        const FOOT = 11.6, KNEE = 3.4, DECK = 33, TOP = 62, MAST = 99;
        const rAt = (y: number): number => (y < DECK
          ? FOOT + (KNEE - FOOT) * Math.pow(y / DECK, 0.72)
          : KNEE + (1.5 - KNEE) * ((y - DECK) / (TOP - DECK)));
        const corners: Array<[number, number]> = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
        const LV = 9;
        for (let l = 0; l < LV; l++) {
          // The level-0 members LEAN at 21 degrees, and `tube()` puts its end rim
          // perpendicular to the axis — so a 0.44 m tube starting at y = 0 reaches
          // 0.19 m BELOW the origin, which `.probe-tmp/buried.ts`'s recipe audit
          // flags (trap 4: every recipe's local min.y must be 0). Starting the
          // bottom level 0.35 m up puts the ground contact on the foot castings
          // below, which are the things that are supposed to touch the ground.
          const y0 = l === 0 ? 0.35 : (l / LV) * TOP;
          const y1 = ((l + 1) / LV) * TOP;
          const r0 = rAt(y0), r1 = rAt(y1);
          for (let c = 0; c < 4; c++) {
            const [ax, az] = corners[c];
            const [bx, bz] = corners[(c + 1) % 4];
            b.tube(ax * r0, y0, az * r0, ax * r1, y1, az * r1, 0.44, 4, red, 1.0);
            b.tube(ax * r0, y0, az * r0, bx * r1, y1, bz * r1, 0.2, 4, red, 0.9);
            b.tube(bx * r0, y0, bz * r0, ax * r1, y1, az * r1, 0.2, 4, red, 0.94);
            b.tube(ax * r1, y1, az * r1, bx * r1, y1, bz * r1, 0.25, 4, red, 0.96);
          }
        }
        for (const [ax, az] of corners) {
          b.box(ax * FOOT, 0.7, az * FOOT, 1.5, 0.7, 1.5, 0x8f8b82, { shade: { top: 1.12 } });
        }
        b.box(0, DECK + 2.4, 0, 7.4, 2.4, 7.4, pale, { taper: 0.9, shade: { top: 1.16 } });
        b.box(0, DECK + 5.1, 0, 6.3, 0.42, 6.3, red, { shade: { top: 1.1 } });
        b.box(0, TOP + 1.7, 0, 3.7, 1.7, 3.7, pale, { taper: 0.86, shade: { top: 1.16 } });
        b.prism(0, TOP + 3.4, 0, 0.58, MAST - TOP - 3.4, 8, red, { taper: 0.2 });
        // ---- FLOODLIT OVER ITS WHOLE HEIGHT --------------------------------
        // Measured on the old recipe: `lit% 35` — 7 of 20 height bands carried
        // any emissive geometry (a deck ring, a crown bar, the mast beacon), on
        // a night circuit, at an emissive area x intensity of 880 against a
        // background-tower median of 10 358. A tower that is dark for 85 % of its own height is
        // not a landmark at night however good its daytime silhouette is, and
        // the real one is uplit from the ground to the mast.
        //
        // The light is authored ON the four legs rather than as a separate glow
        // cage: one emissive member per leg per level, so it follows the batter
        // exactly and the lit line reads as the tower's own edge.
        // Every member type carries light, not just the legs: measured with only
        // the four legs lit, this came to an emissive area x intensity of 3 297
        // against a median of 10 358 for the ordinary background towers on the
        // same circuit — the landmark was a third as bright as the buildings it
        // is supposed to dominate, and an eighth before the material fix below. Lighting the braces and the level rings as
        // well is also what the real floodlighting does: it picks out the
        // lattice, and the lattice is the whole silhouette.
        const glow = this.builder();
        for (let l = 0; l < LV; l++) {
          const y0 = l === 0 ? 0.35 : (l / LV) * TOP;
          const y1 = ((l + 1) / LV) * TOP;
          const r0 = rAt(y0) * 1.02, r1 = rAt(y1) * 1.02;
          // Warm at the base, cooling toward the crown: a 2 % hue walk is what
          // AGENTS section 3 means by "even a small hue shift reads as art
          // directed", and it stops 36 members being one flat orange.
          const warm = mixHex(0xff8a2a, 0xffd9a0, l / LV);
          for (let c = 0; c < 4; c++) {
            const [ax, az] = corners[c];
            const [bx, bz] = corners[(c + 1) % 4];
            glow.tube(ax * r0, y0, az * r0, ax * r1, y1, az * r1, 0.26, 4, warm);
            glow.tube(ax * r0, y0, az * r0, bx * r1, y1, bz * r1, 0.19, 4, warm);
            glow.tube(bx * r0, y0, bz * r0, ax * r1, y1, az * r1, 0.19, 4, warm);
            glow.tube(ax * r1, y1, az * r1, bx * r1, y1, bz * r1, 0.21, 4, warm);
          }
        }
        // Deck soffit and crown bands, then the mast beacon ladder.
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          glow.box(Math.cos(a) * 6.7, DECK + 1.1, Math.sin(a) * 6.7, 0.55, 0.3, 0.55, 0xffd9a0);
        }
        glow.box(0, DECK - 0.35, 0, 7.6, 0.28, 7.6, 0xffc27a);
        glow.box(0, TOP + 3.5, 0, 3.4, 0.2, 3.4, 0xffb43a);
        for (const f of [0.42, 0.72, 1.0]) {
          glow.sphere(0, TOP + 3.4 + (MAST - TOP - 3.4) * f + 0.4, 0, 0.6, 8, 5, 0xff3b2e);
        }
        // Bright `glow`, not `glowSoft` — same reason as `broadcastSpire`, whose
        // note explains it: 1.35 against a circuit whose every window is at 3.7.
        return {
          geo: b.build('latticeTower'), glow: glow.build('latticeGlow'),
          cull: CULL_FAR,
        };
      }

      case 'broadcastspire': {
        // ---- TOKYO: the broadcast tower ------------------------------------
        // Owner: *"the Skytree is very slim and does not convey the sense of a
        // grand illuminated landmark"*. Both halves of that were measured before
        // this was touched (`.probe-tmp/landmark.ts` on the old recipe):
        //
        //   slenderness 10.0  — height / full width. The most needle-like object
        //                       in the game; the background towers run 2.4-3.4.
        //   lit% 25           — 5 of 20 equal height bands carried any emissive
        //                       geometry at all: two deck rings and the beacon.
        //                       On a `skyPreset: 'night'` circuit whose every
        //                       other building has a full window grid and a
        //                       shopfront band, that is why it read as a pale
        //                       vertical line against the sky. Worse, its
        //                       emissive area x `emissiveIntensity` came to 532
        //                       against a background-tower MEDIAN of 10 358 on
        //                       the same lap: the landmark was nineteen times
        //                       dimmer than the ordinary buildings behind it.
        //   923 triangles     — the least geometry of any landmark on the lap,
        //                       for the tallest thing on it.
        //
        // Three changes, in the order they matter:
        //
        //  1. THE PROFILE IS NOW A TABLE, not a geometric taper. `0.86^i` can
        //     only ever make a cone. The real tower's silhouette is a wide
        //     tripod base, a waist, a fat observation drum, a second waist, a
        //     smaller drum, and a needle — and that double bulge is the entire
        //     recognisability of the thing. Authored as `KEY` below so the
        //     silhouette IS the data and can be read without running the code.
        //  2. A STEEL EXOSKELETON. Ten corner columns following that profile,
        //     with diagonal bracing and a ring at every level, on the `metal`
        //     pass. A truss reads as structure at 200 m where a smooth prism
        //     reads as a painted post; it is also what makes the base flare
        //     legible as a tripod rather than as a fatter cone.
        //  3. FULL-HEIGHT ILLUMINATION. An emissive rib up every column at every
        //     level, plus lit deck bands and a beacon ladder. `lit%` goes to
        //     100: every band of the tower carries light, which is what a
        //     landmark lighting scheme is.
        //
        // ACROSS-ROAD half-extent 14.6 m (was 9.4). Authored once, 200 m off the
        // road, so the extra width costs no clearance anywhere.
        const b = this.builder();
        b.uvScale = 0.12;
        const white = 0xe6ebee, cool = 0xbcc9d4, steelC = 0x9fb0be;
        const H = 196;
        /**
         * Silhouette control points, `[height fraction, radius in metres]`.
         * Linear between them. The two local maxima at 0.56 and 0.73 are the
         * observation decks and they are the read — `.probe-tmp/landmark.ts`
         * counts them as `bulge 2` off the built vertices, so a future edit that
         * flattens them shows up as `bulge 0` rather than as nothing.
         */
        const KEY: ReadonlyArray<readonly [number, number]> = [
          [0.000, 14.6], [0.055, 11.6], [0.150, 8.4], [0.300, 6.4],
          [0.450, 5.2], [0.520, 5.4], [0.545, 10.4], [0.605, 10.8],
          [0.630, 4.6], [0.700, 4.0], [0.720, 7.6], [0.765, 7.4],
          [0.790, 2.5], [0.850, 1.5], [1.000, 0.30],
        ];
        const rAt = (f: number): number => {
          const t = clamp(f, 0, 1);
          for (let i = 1; i < KEY.length; i++) {
            if (t <= KEY[i][0]) {
              const [f0, r0] = KEY[i - 1], [f1, r1] = KEY[i];
              return r0 + (r1 - r0) * ((t - f0) / Math.max(1e-6, f1 - f0));
            }
          }
          return KEY[KEY.length - 1][1];
        };
        // Solid core, so the tower has mass behind the truss. Kept at 44 % of
        // the profile: enough to stop the lattice reading as a wire model,
        // narrow enough that the exoskeleton is still a separate silhouette.
        const LV = 20, COL = 10, TOPF = 0.855;
        for (let l = 0; l < LV; l++) {
          const f0 = (l / LV) * TOPF, f1 = ((l + 1) / LV) * TOPF;
          const r0 = rAt(f0) * 0.44, r1 = rAt(f1) * 0.44;
          b.prism(0, f0 * H, 0, r0, (f1 - f0) * H, 10, l % 2 ? white : cool,
            { taper: r1 / Math.max(1e-4, r0), capBottom: l === 0, capTop: false,
              shade: { side: 1.0 } });
        }
        // The needle above the truss, in two stages so the join is a shoulder.
        b.prism(0, TOPF * H, 0, rAt(TOPF) * 0.5, (1 - TOPF) * H * 0.62, 8, cool,
          { taper: 0.34, capTop: false });
        b.prism(0, TOPF * H + (1 - TOPF) * H * 0.62, 0, rAt(TOPF) * 0.17,
          (1 - TOPF) * H * 0.38, 6, steelC, { taper: 0.22 });
        // ---- the exoskeleton ------------------------------------------------
        const metal = this.builder();
        metal.uvScale = 0.3;
        for (let l = 0; l <= LV; l++) {
          const f = (l / LV) * TOPF;
          const r = rAt(f), y = f * H;
          // Ring at every level: the horizontal rhythm that gives a 196 m tower
          // a readable scale instead of one continuous edge.
          for (let k = 0; k < COL; k++) {
            const a0 = (k / COL) * Math.PI * 2, a1 = ((k + 1) / COL) * Math.PI * 2;
            metal.tube(Math.cos(a0) * r, y, Math.sin(a0) * r,
              Math.cos(a1) * r, y, Math.sin(a1) * r, 0.2, 4, steelC, 0.94);
          }
          if (l === LV) break;
          const f2 = ((l + 1) / LV) * TOPF;
          const r2 = rAt(f2), y2 = f2 * H;
          for (let k = 0; k < COL; k++) {
            const a0 = (k / COL) * Math.PI * 2, a1 = ((k + 1) / COL) * Math.PI * 2;
            // Column, then one diagonal per bay, alternating hand by level so
            // the bracing zig-zags up the tower the way a real truss does.
            metal.tube(Math.cos(a0) * r, y, Math.sin(a0) * r,
              Math.cos(a0) * r2, y2, Math.sin(a0) * r2, 0.34, 4, steelC, 1.0);
            const [ba, bb2] = l % 2 ? [a0, a1] : [a1, a0];
            metal.tube(Math.cos(ba) * r, y, Math.sin(ba) * r,
              Math.cos(bb2) * r2, y2, Math.sin(bb2) * r2, 0.17, 4, cool, 0.88);
          }
        }
        // ---- the two observation decks --------------------------------------
        // Drums with a projecting lip and a floor slab, so the bulge in the
        // profile is a building and not a swelling in the shaft.
        for (const [df, dh] of [[0.545, 0.06], [0.720, 0.045]] as const) {
          const dy = df * H, r = rAt(df + dh * 0.5);
          b.prism(0, dy, 0, r * 0.99, dh * H, 14, white,
            { taper: 0.98, shade: { side: 1.02, top: 1.14 } });
          b.prism(0, dy - 0.7, 0, r * 1.1, 0.7, 14, cool, { shade: { top: 1.16 } });
          b.prism(0, dy + dh * H, 0, r * 1.06, 0.6, 14, cool, { shade: { top: 1.2 } });
        }
        // ---- illumination ----------------------------------------------------
        // ---- HOW MUCH LIGHT, not just how far up it goes ---------------------
        // `lit%` reaching 100 says the scheme covers the height. It does not say
        // the landmark out-shines the skyline behind it, and measured, the first
        // version did not: emissive area x `emissiveIntensity` came to 11 440
        // against a background-tower median of 10 358 and a p90 of 15 056 on this
        // circuit. Level with the buildings is not a landmark. Every emissive
        // member is therefore on BOTH the columns and the diagonals, and the ribs
        // run at 0.3 m rather than 0.2 — the truss itself reads as lit, which is
        // what the real lighting scheme does, and the tower clears its own
        // background's p90 instead of sitting on its median.
        const glow = this.builder();
        for (let l = 0; l < LV; l++) {
          const f = (l / LV) * TOPF, f2 = ((l + 1) / LV) * TOPF;
          const r = rAt(f) * 1.02, r2 = rAt(f2) * 1.02;
          // The scheme alternates a cool blue and a warm violet up the tower,
          // the way the real one alternates its two named lightings; two hues
          // over 20 levels also stops a single flat emissive column.
          const hue = l % 2 ? 0x6fd8ff : 0xb08cff;
          for (let k = 0; k < COL; k++) {
            const a0 = (k / COL) * Math.PI * 2, a1 = ((k + 1) / COL) * Math.PI * 2;
            glow.tube(Math.cos(a0) * r, f * H, Math.sin(a0) * r,
              Math.cos(a0) * r2, f2 * H, Math.sin(a0) * r2, 0.3, 4, hue);
            const [ba, bb2] = l % 2 ? [a0, a1] : [a1, a0];
            glow.tube(Math.cos(ba) * r, f * H, Math.sin(ba) * r,
              Math.cos(bb2) * r2, f2 * H, Math.sin(bb2) * r2, 0.22, 4, hue);
          }
        }
        for (const [df, dh] of [[0.545, 0.06], [0.720, 0.045]] as const) {
          const dr = rAt(df + dh * 0.5);
          glow.prism(0, df * H - 0.85, 0, dr * 1.15, 0.75, 14, 0xd6ecff);
          glow.prism(0, (df + dh) * H - 0.05, 0, dr * 1.11, 0.6, 14, 0xd6ecff);
          // The deck's own window band: the drum is a building and a building at
          // 110 m with the lights on is the single most legible thing on a night
          // skyline.
          glow.prism(0, df * H + dh * H * 0.34, 0, dr * 1.01, dh * H * 0.36, 14, 0xfff0c8);
        }
        // Aviation beacons up the needle, not just one at the tip: a ladder of
        // red lights is what says "very tall" at night from far away.
        for (const f of [0.88, 0.94, 1.0]) {
          glow.sphere(0, f * H + 1.0, 0, 0.8, 8, 5, 0xff3b2e);
        }
        // ---- NOT `softGlow`, AND THAT IS THE WHOLE FIX FOR "IT IS THE DIMMEST
        // ---- THING ON THE HORIZON". -----------------------------------------
        // `glowSoft` is `emissiveIntensity 1.35`; `glow` is 3.4 and the night
        // window material is 3.7. This tower and the lattice tower were the only
        // two landmarks on a night circuit authored onto the soft material, so
        // every shopfront band, every neon sign and every lit window on the lap
        // was emitting 2.5-2.7x per unit area MORE than the thing they are all
        // arranged around. No amount of extra emissive geometry fixes a landmark
        // that is authored two and a half stops under its own background; the
        // material was the bug and the geometry above is what makes the fix
        // read.
        //
        // `glowSoft` also carries `bob: 0.22`, which is inert here (`aFlap`
        // defaults to 0 on every non-cloth primitive) but is a balloon's motion
        // and has no business on a 196 m broadcast tower in the first place.
        return {
          geo: b.build('broadcastSpire'), metal: metal.build('spireTruss'),
          glow: glow.build('spireGlow'), cull: CULL_FAR,
        };
      }

      case 'screentower': {
        // ---- TOKYO: the scramble crossing's screen block -------------------
        // A dark corner mass whose road face is nothing but advertising. The
        // three screens are a `sign` pass with atlas cells BAKED PER PANEL, so
        // one building carries three different boards — the same technique the
        // grandstand's sponsor band uses, and the reason `atlasBaked` exists.
        // ACROSS-ROAD half-extent 8.9 m, 11.6 m along.
        const b = this.builder();
        // Curtain-wall facade set at its authored world tile, so the dark mass has
        // a mullion grid and spandrel bands rather than one solid vertex colour on
        // an untextured material. Base colour lifted off near-black for the same
        // reason as the towers: a map multiplying 0x31363d is still 0x31363d.
        b.uvScale = 1 / this.facadeTileOf('curtain');
        const W = 11, D = 8.4, H = 27;
        b.box(0, H * 0.5, 0, W, H * 0.5, D, 0x59626d, { taper: 0.995, shade: { top: 1.09 } });
        b.box(0, 2.0, 0, W + 0.5, 2.0, D + 0.5, 0x3d434b, { shade: { top: 1.02 } });
        b.box(0, H + 0.38, 0, W + 0.42, 0.38, D + 0.42, 0x4a5057, { shade: { top: 1.18 } });
        const panels: Array<[number, number, number, number]> = [
          [0, 20.5, 8.6, 4.8], [-4.2, 13.4, 6.4, 5.2], [4.6, 12.6, 5.0, 6.6],
        ];
        for (const [px, py, pw, ph] of panels) {
          b.box(px, py, D + 0.22, pw * 0.5 + 0.3, ph * 0.5 + 0.3, 0.24, 0x14171b,
            { shade: { top: 1.12 } });
        }
        b.box(W * 0.55, H + 2.3, -D * 0.4, 1.2, 1.9, 1.2, 0x3a3f47);
        b.box(-W - 0.5, H * 0.42, D * 0.5, 0.35, H * 0.4, 1.5, 0x2a2e34);
        const sign = this.builder();
        panels.forEach(([px, py, pw, ph], i) => {
          sign.plate(px, py, D + 0.48, pw, ph, 0, 0xffffff,
            { single: true, uvRect: atlasRect(i * 3 + 1) });
        });
        const glow = this.builder();
        glow.box(0, H - 0.6, D + 0.3, W * 0.97, 0.22, 0.1, 0x2ef0ff);
        glow.box(-W - 0.62, H * 0.42, D * 0.5, 0.1, H * 0.38, 1.2, 0xff4d6a);
        // Lit windows up the -X flank. YAW SIGN MATTERS on a `single` plate:
        // `plate()` derives its normal from the corner order, and at yaw +pi/2
        // that normal comes out -X (outward from this face). At -pi/2 it is +X,
        // i.e. pointing into the building, and a single-sided plate facing inward
        // is a plate you cannot see. Same derivation as `skyscraperWindows`,
        // which uses `yaw + Math.PI` on its -Z face for the same reason.
        for (let f = 0; f < 7; f++) {
          glow.plate(-W - 0.08, 3.6 + f * 3.2, D * 0.25, 1.6, 1.4, Math.PI * 0.5,
            rng.next() < 0.6 ? 0xffdca8 : 0x1a1c22, { single: true });
        }
        return {
          geo: b.build('screenTower'), sign: sign.build('screenPanels'),
          glow: glow.build('screenGlow'), mat: this.facadeMat('curtain'), cull: CULL_FAR,
        };
      }

      case 'torii': {
        // ---- TOKYO: the shrine gate ----------------------------------------
        // Vermilion torii: two battered columns, the straight `nuki` tie, and a
        // `kasagi` that steps UP at both ends — that upturn is the difference
        // between a torii and a goalpost, and it is the whole silhouette.
        //
        // Authored at yaw 0 and lat 18, i.e. FACING the road. Turning it broadside
        // would put its 12 m width across the road instead of along it, and the
        // lat audit measures across-road extent from the recipe's own `hz` — so a
        // yawed gate would be 6 m wider than any probe could see. Facing the road
        // keeps the measurement honest: ACROSS-ROAD half-extent 0.72 m, 6.1 along.
        const b = this.builder();
        b.uvScale = 0.9;
        const red = 0xd6402f, dark = 0x2b2320;
        const HW = 3.2, H = 6.4;
        for (const sx of [-1, 1]) {
          b.box(sx * HW, 0.3, 0, 0.72, 0.3, 0.72, dark, { shade: { top: 1.12 } });
          b.prism(sx * HW, 0.6, 0, 0.44, H, 10, red, { taper: 0.86 });
        }
        b.box(0, H + 0.2, 0, HW + 0.5, 0.26, 0.34, red, { shade: { top: 1.14 } });
        b.box(0, H + 1.28, 0, HW + 1.5, 0.3, 0.44, dark, { shade: { top: 1.16 } });
        b.box(0, H + 1.75, 0, HW + 1.0, 0.3, 0.56, red, { shade: { top: 1.2 } });
        for (const sx of [-1, 1]) {
          b.box(sx * (HW + 1.55), H + 1.9, 0, 0.75, 0.28, 0.52, red, { shade: { top: 1.2 } });
          b.box(sx * (HW + 2.28), H + 2.16, 0, 0.62, 0.26, 0.48, red, { shade: { top: 1.22 } });
        }
        b.box(0, H + 0.74, 0, 0.3, 0.28, 0.3, red);
        b.plate(0, H + 0.74, 0.3, 1.5, 0.72, 0, 0xe8e4d8, { single: true });
        return { geo: b.build('torii'), cull: 340 };
      }

      case 'overpassarch': {
        // ---- TOKYO: the city expressway crossing overhead ------------------
        // Authored at lat 0 with `up: 9.6`, so — exactly like `bridgepylon` —
        // the ANCHOR is the deck and every structural part is at NEGATIVE local
        // y. That is why this recipe's `min.y` is not 0: it hangs from its
        // anchor rather than standing on the ground, and the piers reach down
        // 9.6 m to meet it.
        //
        // The piers sit at +-21.5 m. The widest carriageway this crosses is
        // hw 12.5 + kerb 1.55 + shoulder 5 = 19.05 m of corridor, so they stand
        // 2.45 m outside the drivable surface and the deck soffit clears the
        // road by 8.6 m.
        const b = this.builder();
        const HALF = 38, PIER = 21.5, DROP = 9.6;
        b.box(0, -0.95, 0, HALF, 0.95, 3.4, 0x878d94,
          { shade: { top: 1.0, bottom: 0.5 } });
        for (const sz of [1, -1]) {
          b.box(0, 0.62, sz * 3.5, HALF, 0.62, 0.22, 0x9aa1a9, { shade: { top: 1.16 } });
        }
        b.box(0, 0.06, 0, HALF, 0.12, 3.5, 0x40454c, { shade: { top: 1.0 } });
        for (const sx of [-1, 1]) {
          b.box(sx * PIER, -0.95 - (DROP - 1.3) * 0.5, 0, 1.9, (DROP - 1.3) * 0.5, 2.2,
            0x8f939a, { taper: 1.16 });
          b.box(sx * PIER, -DROP - 0.35, 0, 2.6, 0.35, 3.0, 0x71767c, { shade: { top: 1.02 } });
        }
        const glow = this.builder();
        for (let i = -5; i <= 5; i++) {
          glow.box(i * (HALF / 6), -0.12, 3.62, 0.5, 0.12, 0.1, 0xffd9a0);
        }
        return {
          geo: b.build('overpassArch'), glow: glow.build('overpassGlow'),
          softGlow: true, cull: CULL_FAR,
        };
      }

      // ---- the national flags ---------------------------------------------
      // One per city, on a plaza mast: the State House terrace in Boston, the
      // memorial plaza in Taipei, the tower plaza in Tokyo. Same mast, different
      // atlas cell. See `flagMast` and `makeFlagAtlas`.
      case 'flagusa': return this.flagMast(FLAG_USA);
      case 'flagroc': return this.flagMast(FLAG_ROC);
      case 'flagjapan': return this.flagMast(FLAG_JAPAN);

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

      // =====================================================================
      //  HONG KONG HARBOUR
      // =====================================================================

      case 'bankofchina': {
        // ---- the triangulated bank tower -----------------------------------
        // Four quadrant prisms rising out of one square plan, each terminating
        // at a different height under a triangular slope, so the silhouette
        // sheds a quarter of itself three times on the way up. That stepped
        // asymmetry IS the building; a square tower with a pointy hat is not.
        //
        // ACROSS-ROAD half-extent 20.5 m (the granite podium), 20.5 m along.
        // 188 m to the mast tips, against `harbourSupertall`'s 248 — the two
        // have to read as different heights or the skyline has no hierarchy.
        const b = this.builder();
        b.uvScale = 1 / this.facadeTileOf('curtain');
        const stone = 0x9ba4aa, wall = 0x6f8b9c, mull = 0xaab4bb;
        const Q = 7.6;                 // half-extent of ONE quadrant
        const SH = Q * 2;              // half-extent of the full shaft
        const PY = 13, S1 = 56, S2 = 94, S3 = 128, S4 = 152, CAP = 170;
        // Podium: banking hall, out to the lot line, with a granite plinth.
        b.box(0, 0.7, 0, 20.5, 0.7, 20.5, 0x8d8a82, { shade: { top: 1.1 } });
        b.box(0, PY * 0.5 + 0.6, 0, 19.4, PY * 0.5, 19.4, stone,
          { taper: 0.99, shade: { side: 1.0, top: 1.08 } });
        b.box(0, PY + 1.0, 0, 20.2, 0.5, 20.2, 0x7f868b, { shade: { top: 1.2 } });
        /** One stage of the shaft: a box between two heights. */
        const stage = (cx: number, cz: number, hx: number, hz: number,
          y0: number, y1: number, hex: number): void => {
          b.box(cx, (y0 + y1) * 0.5, cz, hx, (y1 - y0) * 0.5, hz, hex,
            { taper: 0.995, shade: { side: 1.0, top: 1.12 } });
        };
        stage(0, 0, SH, SH, PY, S1, wall);                    // 4 quadrants
        stage(0, -Q, SH, Q, S1, S2, wall);                    // 3: (-,-) (+,-) ...
        stage(-Q, Q, Q, Q, S1, S2, wall);                     //    ...and (-,+)
        stage(-Q, 0, Q, SH, S2, S3, wall);                    // 2: the -x pair
        stage(-Q, -Q, Q, Q, S3, S4, wall);                    // 1: the tallest
        // The triangular slopes that terminate each quadrant. A 3-sided prism
        // tapered to a point is exactly this form, and its circumradius (10.8)
        // is the quadrant's own corner distance, so the slope springs off the
        // quadrant's edges rather than hovering inside them.
        const slope = (cx: number, cz: number, y0: number, y1: number,
          yaw: number): void => {
          b.prism(cx, y0, cz, 10.8, y1 - y0, 3, 0x8fa4b0,
            { taper: 0.03, yaw, shade: { side: 1.04, top: 1.2 } });
        };
        slope(Q, Q, S1, S2, Math.PI * 0.25);
        slope(Q, -Q, S2, S3, Math.PI * 0.75);
        slope(-Q, Q, S3, S4, -Math.PI * 0.25);
        slope(-Q, -Q, S4, CAP, -Math.PI * 0.75);
        // ---- the space-frame X bracing --------------------------------------
        // The diagonals are the reason this tower has no interior columns, and
        // at 200 m they are the only thing that distinguishes it from a glass
        // box. Two storeys of X per exposed face on the bottom two stages.
        const brace = (x0: number, y0: number, z0: number,
          x1: number, y1: number, z1: number): void => {
          b.tube(x0, y0, z0, x1, y1, z1, 0.44, 4, mull, 1.06);
        };
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = az, nz = ax;                       // in-face direction
          const ox = ax * (SH + 0.18), oz = az * (SH + 0.18);
          for (const [y0, y1] of [[PY, (PY + S1) * 0.5], [(PY + S1) * 0.5, S1]] as const) {
            brace(ox - nx * SH, y0, oz - nz * SH, ox + nx * SH, y1, oz + nz * SH);
            brace(ox + nx * SH, y0, oz + nz * SH, ox - nx * SH, y1, oz - nz * SH);
            b.box(ox, y1, oz, ax ? 0.2 : SH, 0.24, az ? 0.2 : SH, mull);
          }
        }
        for (const [y0, y1] of [[S1, (S1 + S2) * 0.5], [(S1 + S2) * 0.5, S2]] as const) {
          brace(-SH - 0.18, y0, -Q, -SH - 0.18, y1, Q * 3);
          brace(-SH - 0.18, y1, -Q, -SH - 0.18, y0, Q * 3);
        }
        // Twin masts, the tower's signature pair of antennae.
        for (const sx of [-1.9, 1.9]) {
          b.prism(-Q + sx, CAP, -Q, 0.28, 18, 6, 0xb6bec4, { taper: 0.18 });
        }
        const glow = this.builder();
        for (const sx of [-1.9, 1.9]) glow.sphere(-Q + sx, CAP + 18.4, -Q, 0.5, 6, 4, 0xff3b2e);
        for (const y of [S1, S2, S3, S4]) glow.sphere(-Q, y + 1.2, -Q, 0.42, 6, 4, 0xff5a3a);
        // Lit floors. Kept to the four faces of the bottom two stages: the panes
        // above are under 2 px at the distance this thing is authored at.
        const win = this.builder();
        let cell = 0;
        for (let f = 0; f < 16; f++) {
          const y = PY + 3.4 + f * ((S2 - PY - 6) / 16);
          const half = y > S1 ? Q : SH;
          const cz = y > S1 ? -Q : 0;
          for (let s = 0; s < 4; s++) {
            const yaw = s * Math.PI * 0.5;
            const ca = Math.cos(yaw), sa = Math.sin(yaw);
            for (let i = -2; i <= 2; i++) {
              win.cell = cell++;
              const off = i * (half * 0.34);
              win.plate(ca * off + sa * (half + 0.1) + (y > S1 ? -Q : 0),
                y, sa * off - ca * (half + 0.1) + cz,
                half * 0.28, 1.5, yaw + Math.PI, 0xbfe0ff, { single: true });
            }
          }
        }
        win.cell = 0;
        return {
          geo: b.build('bankOfChina'), glow: glow.build('bankOfChinaGlow'),
          windows: win.build('bankOfChinaWindows'),
          mat: this.facadeMat('curtain'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'harboursupertall': {
        // ---- the supertall across the water ---------------------------------
        // Read the Taipei note in `CityDefs.ts` before moving this: a 248 m
        // tower needs roughly 290 m of distance before its top re-enters a
        // 79.75 deg vertical frustum whose eye looks at the horizon, so it is
        // authored ACROSS THE HARBOUR and not in the infield. Screen fill is the
        // defect, not the achievement.
        //
        // ACROSS-ROAD half-extent 17.5 m (the podium skirt), 17.5 m along.
        const b = this.builder();
        b.uvScale = 1 / this.facadeTileOf('curtain');
        const glassA = 0x6d8ea4, glassB = 0x5b7c92, trim = 0xb2bcc2;
        const H = 248;
        // Podium and its sloping glazed skirt.
        b.box(0, 1.1, 0, 17.5, 1.1, 17.5, 0x7d848a, { shade: { top: 1.12 } });
        b.box(0, 7.5, 0, 16.2, 5.3, 16.2, glassB, { taper: 0.78, shade: { top: 1.14 } });
        // Six stages, each stepping in and each with a re-entrant notch at the
        // corners — the taper is what makes a supertall read as tall rather
        // than as a tall box.
        const stages: ReadonlyArray<readonly [number, number]> = [
          [13, 12.6], [58, 11.3], [104, 10.0], [148, 8.6], [188, 7.1], [220, 5.6],
        ];
        for (let i = 0; i < stages.length; i++) {
          const [y0, hx] = stages[i];
          const y1 = i + 1 < stages.length ? stages[i + 1][0] : H;
          const nx = i + 1 < stages.length ? stages[i + 1][1] : 4.2;
          b.box(0, (y0 + y1) * 0.5, 0, hx, (y1 - y0) * 0.5, hx,
            i % 2 ? glassB : glassA, { taper: nx / hx, shade: { side: 1.0, top: 1.14 } });
          // Corner notches: four slim recesses that run the stage's full height.
          for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            b.box(sx * hx * 0.82, (y0 + y1) * 0.5, sz * hx * 0.82, hx * 0.13,
              (y1 - y0) * 0.5, hx * 0.13, trim, { taper: nx / hx, shade: { top: 1.2 } });
          }
          // Sky-lobby band at each setback.
          b.box(0, y1 + 0.42, 0, nx + 0.5, 0.42, nx + 0.5, trim, { shade: { top: 1.22 } });
        }
        // The crown: a tapered lantern and a spire.
        b.box(0, H + 3.2, 0, 4.0, 3.2, 4.0, glassA, { taper: 0.5, shade: { top: 1.24 } });
        b.prism(0, H + 6.4, 0, 1.5, 9.0, 8, trim, { taper: 0.26 });
        b.prism(0, H + 15.0, 0, 0.34, 15.0, 6, 0xc6ced4, { taper: 0.14 });
        // Mullions on the two long faces of the bottom three stages.
        for (let i = -4; i <= 4; i++) {
          for (const sz of [1, -1]) {
            b.box(i * 2.6, 76, sz * 11.6, 0.16, 63, 0.12, 0x7f95a4, { taper: 0.9 });
          }
        }
        const glow = this.builder();
        for (const y of [60, 106, 150, 190, 222, H + 6]) {
          glow.sphere(0, y, 0, 0.55, 6, 4, 0xff5a3a);
        }
        glow.sphere(0, H + 30.2, 0, 0.7, 7, 5, 0xff3b2e);
        const win = this.builder();
        let cell = 0;
        for (let i = 0; i < stages.length; i++) {
          const [y0, hx] = stages[i];
          const y1 = i + 1 < stages.length ? stages[i + 1][0] : H;
          const floors = Math.max(3, Math.round((y1 - y0) / 11));
          for (let f = 0; f < floors; f++) {
            const y = y0 + 3 + f * ((y1 - y0 - 5) / floors);
            for (let s = 0; s < 4; s++) {
              const yaw = s * Math.PI * 0.5;
              const ca = Math.cos(yaw), sa = Math.sin(yaw);
              for (let k = -1; k <= 1; k++) {
                win.cell = cell++;
                const off = k * hx * 0.5;
                win.plate(ca * off + sa * (hx + 0.12), y, sa * off - ca * (hx + 0.12),
                  hx * 0.42, 2.0, yaw + Math.PI, 0xc8e4ff, { single: true });
              }
            }
          }
        }
        win.cell = 0;
        return {
          geo: b.build('harbourSupertall'), glow: glow.build('harbourSupertallGlow'),
          windows: win.build('harbourSupertallWindows'),
          mat: this.facadeMat('curtain'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'bambooscaffold': {
        // ---- the building under renovation ----------------------------------
        // A 24 m block wrapped head to foot in a LASHED BAMBOO cage with green
        // safety mesh behind it and a red/white/blue nylon canopy over the
        // pavement. Nothing else in the game looks like this and it is the one
        // piece of Hong Kong street furniture that is unmistakably Hong Kong.
        //
        // ACROSS-ROAD half-extent 6.9 m (the canopy), 11.4 m along.
        const b = this.builder();
        b.uvScale = 1 / this.facadeTileOf('masonry');
        const H = 24, HX = 11.0, HZ = 6.2;
        b.box(0, H * 0.5, 0, HX, H * 0.5, HZ, 0x9c9285, { shade: { side: 1.0, top: 1.06 } });
        b.box(0, H + 0.35, 0, HX + 0.3, 0.35, HZ + 0.3, 0x6f675c, { shade: { top: 1.2 } });
        // The cage. Verticals every 1.55 m on the two long faces and the ends,
        // ledgers every 2.05 m, and a diagonal every third bay — that ratio is
        // what makes a lattice read as scaffolding rather than as a grid.
        const bamb = 0xc2a86a, bambB = 0xa98f56, lash = 0x2b2b2b;
        const poleR = 0.055;
        const faces: ReadonlyArray<readonly [number, number, number, number]> = [
          [0, HZ + 0.5, 1, 0], [0, -HZ - 0.5, 1, 0],
          [HX + 0.5, 0, 0, 1], [-HX - 0.5, 0, 0, 1],
        ];
        for (const [ox, oz, ux, uz] of faces) {
          const span = ux ? HX : HZ;
          const n = Math.max(3, Math.round(span / 1.55));
          for (let i = -n; i <= n; i++) {
            const t = (i / n) * span;
            b.prism(ox + ux * t, 0, oz + uz * t, poleR, H + 1.6, 5,
              i % 2 ? bamb : bambB, { capBottom: true });
          }
          const rungs = Math.round(H / 2.05);
          for (let r = 1; r <= rungs; r++) {
            const y = r * (H / rungs);
            b.tube(ox - ux * span, y, oz - uz * span, ox + ux * span, y, oz + uz * span,
              poleR, 4, bamb, 1.02);
            if (r % 3 === 0) {
              b.tube(ox - ux * span, y - H / rungs, oz - uz * span,
                ox + ux * span, y, oz + uz * span, poleR * 0.9, 4, bambB, 0.96);
            }
            if (r % 4 === 0) b.box(ox, y, oz, 0.09, 0.09, 0.09, lash);
          }
        }
        // Green safety mesh, inboard of the cage.
        for (const [ox, oz, yaw] of [
          [0, HZ + 0.32, 0], [0, -HZ - 0.32, Math.PI],
          [HX + 0.32, 0, Math.PI * 0.5], [-HX - 0.32, 0, -Math.PI * 0.5],
        ] as ReadonlyArray<readonly [number, number, number]>) {
          const w = Math.abs(oz) > HZ ? HX * 2 : HZ * 2;
          b.plate(ox, H * 0.5 + 0.8, oz, w, H - 1.0, yaw, 0x5c7d4a, { single: true });
        }
        // The nylon canopy over the pavement, on its own bamboo legs so it has
        // something under it. Red / white / blue, in that order, always.
        //
        // It reaches 4.0 m past the cage and NO FURTHER, and that number is what
        // sets the recipe's across-road half-extent at 10.2 m — the figure
        // `CityDefs` prices its `lat` against. A deeper awning is prettier and
        // costs a metre of verge on an 11 m half-width street.
        const CANOPY = 4.0;
        const stripes = [0xc4302a, 0xe8e6df, 0x24478c];
        for (let i = 0; i < 6; i++) {
          b.quad(
            -HX + i * (HX * 2 / 6), 4.3, HZ + 0.9,
            -HX + (i + 1) * (HX * 2 / 6), 4.3, HZ + 0.9,
            -HX + (i + 1) * (HX * 2 / 6), 3.62, HZ + CANOPY,
            -HX + i * (HX * 2 / 6), 3.62, HZ + CANOPY,
            stripes[i % 3], 1.14,
          );
        }
        for (const sx of [-1, 1]) {
          b.prism(sx * (HX - 0.6), 0, HZ + CANOPY - 0.2, 0.075, 3.66, 5, bamb,
            { capBottom: true });
        }
        const glow = this.builder();
        const litChance = 0.14 + 0.5 * this.night;
        for (let f = 0; f < 7; f++) {
          for (let i = -2; i <= 2; i++) {
            const col = rng.next() < litChance ? 0xffdca8 : 0x171a1f;
            glow.plate(i * 4.2, 3.2 + f * 3.0, HZ + 0.08, 2.0, 1.6, 0, col, { single: true });
          }
        }
        // A single work lamp on the cage, which is what says "under renovation"
        // at night rather than "abandoned".
        glow.sphere(HX * 0.4, 15.6, HZ + 0.7, 0.24, 7, 4, 0xfff0c0);
        return {
          geo: b.build('bambooScaffold'), glow: glow.build('bambooScaffoldGlow'),
          mat: this.facadeMat('masonry'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'neoncantilever': {
        // ---- the cantilevered shop sign -------------------------------------
        // The one thing everybody pictures: a lit box projecting out OVER the
        // street on a bracket, in a row of them, from both sides at once.
        //
        // Local +Z faces the road (convention 1), so the projection runs along
        // +Z and the ACROSS-ROAD half-extent is what decides the `lat`: 5.0 m,
        // measured from the face of the pier at z = 0 to the outer edge of the
        // hanging board. Authored at lat 20 on an 8.5 m half-width road that is
        // 12.05 m of corridor, the outer edge still stands 3.0 m clear of the
        // shoulder — the sign leans over the PAVEMENT, not over the tarmac.
        //
        // It carries its own masonry pier down to the ground. A sign bracketed
        // off the `building` wall style would have nothing under it, and
        // `.probe-tmp/floating.ts` has no exclusion list.
        const b = this.builder();
        b.uvScale = 0.9;
        const pier = 0x5f5851, frame = 0x24262b, steel = 0x8c9298;
        const HGT = 6.8 + rng.range(0, 2.6);
        b.box(0, HGT * 0.5, -0.55, 1.15, HGT * 0.5, 0.55, pier,
          { taper: 0.97, shade: { side: 1.0, top: 1.1 } });
        b.box(0, 0.3, -0.55, 1.35, 0.3, 0.72, 0x4a453f, { shade: { top: 1.12 } });
        // Bracket: a top chord and a diagonal strut, which is how the load
        // actually gets back into the wall.
        b.box(0, HGT - 0.35, 1.9, 0.2, 0.2, 2.5, steel);
        b.tube(0, HGT - 2.6, -0.1, 0, HGT - 0.5, 3.9, 0.11, 5, steel, 1.05);
        // The box sign itself: a carcass hung under the bracket, plus a vertical
        // blade board on its outer end.
        b.box(0, HGT - 1.55, 2.5, 1.5, 1.0, 1.05, frame, { shade: { top: 1.08 } });
        b.box(0, HGT - 2.9, 3.9, 0.62, 1.5, 0.5, frame, { shade: { top: 1.08 } });
        b.box(0, HGT - 0.12, 2.5, 1.62, 0.12, 1.15, steel, { shade: { top: 1.18 } });
        const glow = this.builder();
        const cols = [0xff2e5a, 0x2ef0ff, 0xffd23a, 0x39ff88, 0xff7ad0, 0xfff0c0];
        const c0 = cols[rng.int(0, cols.length - 1)];
        const c1 = cols[rng.int(0, cols.length - 1)];
        glow.cell = 0;
        // Both long faces of the box, so the sign reads coming and going, plus
        // the underside — which is the face a kart actually drives beneath.
        for (const [sz, yaw] of [[1.08, 0], [-1.08, Math.PI]] as const) {
          glow.plate(0, HGT - 1.55, 2.5 + sz, 1.34, 0.82, yaw, c0, { single: true });
        }
        glow.cell = 1;
        for (const [sx, yaw] of [[0.53, Math.PI * 0.5], [-0.53, -Math.PI * 0.5]] as const) {
          glow.plate(sx, HGT - 2.9, 3.9, 0.9, 1.3, yaw, c1, { single: true });
        }
        glow.cell = 2;
        glow.box(0, HGT - 2.6, 2.5, 1.3, 0.05, 0.9, c0);
        // A hot tube along the leading edge: the sign still reads end-on down
        // the length of the street, which is how you mostly see it.
        glow.box(0, HGT - 1.55, 3.58, 1.4, 0.9, 0.05, c1);
        glow.cell = 0;
        return {
          geo: b.build('neonCantilever'), glow: glow.build('neonCantileverGlow'),
          cull: 380,
        };
      }

      case 'junk': {
        // ---- the red-sailed junk --------------------------------------------
        // Battened lug sails, a high transom stern and a low bow. The BATTENS
        // are the read — a junk sail is a fan of horizontal spars, not a
        // triangle — so they are built into the cloth pass and move with it.
        //
        // ACROSS-ROAD half-extent 2.4 m (the beam), 14.2 m along.
        const b = this.builder();
        b.uvScale = 1.0;
        const hull = 0x6d4a2c, hullB = 0x54371f, deck = 0x8a6a42, trim = 0xb03024;
        // Hull: three tapering sections so the sheer line rises aft.
        b.box(0, 0.85, 0, 5.6, 0.85, 2.15, hull, { taper: 0.9, shade: { top: 1.06 } });
        b.box(-6.6, 1.0, 0, 1.3, 0.7, 1.5, hull, { taper: 0.6, shade: { top: 1.08 } });
        b.box(5.9, 1.55, 0, 1.3, 1.55, 2.0, hullB, { taper: 0.86, shade: { top: 1.1 } });
        b.box(0, 1.75, 0, 5.5, 0.12, 2.05, deck, { shade: { top: 1.2 } });
        b.box(5.9, 3.2, 0, 1.2, 0.2, 1.85, deck, { shade: { top: 1.22 } });
        // Waterline boot-top and a rubbing strake, so the hull is not one colour.
        b.box(0, 0.28, 0, 5.7, 0.16, 2.22, 0x2f2b26);
        b.box(0, 1.55, 0, 5.62, 0.1, 2.14, trim);
        // Deckhouse and a tiller.
        b.box(3.1, 2.35, 0, 1.5, 0.6, 1.5, 0x7d5c38, { shade: { top: 1.14 } });
        b.box(3.1, 3.0, 0, 1.65, 0.08, 1.65, 0x3e332a, { shade: { top: 1.2 } });
        // Two raked masts and their yards.
        const mast = (mx: number, h: number): void => {
          b.tube(mx, 1.8, 0, mx - h * 0.11, 1.8 + h, 0, 0.15, 6, 0x4e3a26, 1.04);
        };
        mast(-1.2, 11.4);
        mast(4.4, 7.6);
        // Rigging: a forestay and two shrouds per mast, all landing on the deck.
        for (const [mx, h] of [[-1.2, 11.4], [4.4, 7.6]] as const) {
          b.tube(mx - h * 0.11, 1.8 + h, 0, mx - 4.6, 1.85, 0, 0.045, 4, 0x2f2a24);
          for (const sz of [-1, 1]) {
            b.tube(mx - h * 0.11, 1.8 + h, 0, mx, 1.85, sz * 1.9, 0.04, 4, 0x2f2a24);
          }
        }
        const cloth = this.builder();
        // Oxide red, and the battens a shade darker so the fan reads at 120 m.
        const sailA = 0x9c3a22, batten = 0x5c2213;
        const sail = (mx: number, h: number, w: number, hh: number): void => {
          cloth.mastCloth(mx, 1.8 + h - 0.7, 0, w, hh, 0, sailA, 6, 5, undefined,
            { double: true, bow: 0.5, wave: 0.16 });
          const n = 5;
          for (let i = 0; i <= n; i++) {
            const y = 1.8 + h - 0.7 - (i / n) * hh;
            cloth.flap = 0.35;
            cloth.box(mx + w * 0.5, y, 0, w * 0.5, 0.055, 0.075, batten);
            cloth.flap = 0;
          }
        };
        sail(-1.2, 11.4, 6.4, 8.2);
        sail(4.4, 7.6, 4.2, 5.4);
        const glow = this.builder();
        glow.sphere(-6.5, 2.1, 0, 0.16, 6, 4, 0xffd08a);
        glow.sphere(5.9, 3.6, 0, 0.16, 6, 4, 0xffd08a);
        return {
          geo: b.build('junk'), cloth: cloth.build('junkSails'),
          glow: glow.build('junkLamps'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'tramhk': {
        // ---- the double-deck tram -------------------------------------------
        // Narrow, tall and flat-fronted, with an open upper deck and a full-height
        // advertising livery — the proportions are the whole identity, so the body
        // is 2.05 m wide against 4.85 m tall.
        //
        // It carries 14 m of its own rail and a trolley standard, so it is
        // standing on something. ACROSS-ROAD half-extent 2.15 m, 7.0 m along.
        const b = this.builder();
        b.uvScale = 1.1;
        const livery = rng.next() < 0.5 ? 0x1f7a4a : 0xc4302a;
        const cream = 0xe8e2d2, dark = 0x2b2f35;
        // Rails and sleepers first: the ground contact.
        for (const sz of [-0.72, 0.72]) {
          b.box(0, 0.055, sz, 7.0, 0.055, 0.075, 0x6b6560, { shade: { top: 1.2 } });
        }
        for (let i = -4; i <= 4; i++) {
          b.box(i * 1.6, 0.02, 0, 0.16, 0.02, 1.15, 0x4a443e);
        }
        // Trucks, lower saloon, upper deck, curved roof.
        b.box(0, 0.42, 0, 2.9, 0.26, 0.85, dark);
        b.box(0, 1.5, 0, 3.15, 0.9, 1.02, livery, { taper: 0.98, shade: { top: 1.06 } });
        b.box(0, 2.45, 0, 3.2, 0.15, 1.05, cream, { shade: { top: 1.16 } });
        b.box(0, 3.35, 0, 3.15, 0.85, 1.0, livery, { taper: 0.97, shade: { top: 1.06 } });
        b.box(0, 4.32, 0, 3.05, 0.2, 0.98, cream, { taper: 0.9, shade: { top: 1.22 } });
        // Upper-deck rail, so the top is not a solid brick.
        for (const sz of [-1, 1]) {
          b.box(0, 3.9, sz * 1.02, 3.1, 0.06, 0.05, cream);
          b.box(0, 3.05, sz * 1.02, 3.1, 0.06, 0.05, cream);
        }
        // Destination board, fenders and the trolley standard.
        b.box(0, 4.05, -1.03, 1.1, 0.28, 0.06, dark);
        for (const sx of [-1, 1]) b.box(sx * 3.2, 0.75, 0, 0.1, 0.5, 0.95, dark);
        b.prism(0.6, 4.5, 0, 0.06, 1.5, 5, 0x9aa1a9);
        b.tube(0.6, 6.0, 0, -1.9, 6.9, 0, 0.045, 4, 0x9aa1a9);
        const win = this.builder();
        let wc = 0;
        for (const y of [1.62, 3.45]) {
          for (const sz of [1, -1]) {
            for (let i = -2; i <= 2; i++) {
              win.cell = wc++;
              win.plate(i * 1.18, y, sz * 1.06, 0.95, 0.8, sz > 0 ? 0 : Math.PI,
                0xffe9c0, { single: true });
            }
          }
        }
        win.cell = 0;
        const glow = this.builder();
        glow.box(0, 1.15, -1.06, 0.5, 0.12, 0.05, 0xfff2d0);
        glow.box(0, 1.15, 1.06, 0.5, 0.12, 0.05, 0xd6402f);
        glow.plate(0, 4.05, -1.1, 1.0, 0.2, Math.PI, 0xffd23a, { single: true });
        return {
          geo: b.build('tramHK'), windows: win.build('tramHKWindows'),
          glow: glow.build('tramHKGlow'), cull: 460,
        };
      }

      case 'lionrock': {
        // ---- the ridge on the skyline ---------------------------------------
        // Three layered ridges at different depths, heights and hues, so the
        // horizon has aerial perspective instead of one cardboard cut-out; the
        // nearest carries the blocky crag the mountain is named for.
        //
        // NOT a cone. The owner's complaint about Taipei was "strange pyramid
        // structures in the background", and a low-poly cone at 400 m is exactly
        // that. This is a swept ridgeline with a jagged crest.
        //
        // ACROSS-ROAD half-extent 74 m; authored at |lat| >= 560 on an UNBANKED
        // node, because a lateral offset that size on a banked binormal buys
        // spurious altitude (see the `lat` note in `CityDefs.ts`).
        const b = this.builder();
        b.uvScale = 0.24;
        /** One ridge: a crest polyline swept back to a depth, closed to y=0. */
        const ridge = (
          span: number, depth: number, peak: number, base: number,
          hexTop: number, hexSide: number, phase: number,
        ): void => {
          const N = 15;
          const h = (i: number): number => {
            const f = i / N;
            const bell = Math.sin(Math.PI * f) ** 0.8;
            const jag = 0.82 + 0.18 * Math.sin(f * 11.3 + phase)
              + 0.09 * Math.sin(f * 27.1 + phase * 2.3);
            return base + (peak - base) * bell * jag;
          };
          // The base runs to -28, not to 0. The ridge is authored 550 m off the
          // road on ground with ~5 m of relief across its own 240 m span, so a
          // flat-bottomed silhouette seated on one heightfield sample would show
          // daylight under one end of it. Nothing above the skirt changes.
          const FOOT = -28;
          for (let i = 0; i < N; i++) {
            const x0 = -span + (i / N) * span * 2;
            const x1 = -span + ((i + 1) / N) * span * 2;
            const y0 = h(i), y1 = h(i + 1);
            // front face
            b.quad(x0, FOOT, depth * 0.5, x1, FOOT, depth * 0.5, x1, y1, depth * 0.5,
              x0, y0, depth * 0.5, hexSide, 1.0);
            // crest, tipped back
            b.quad(x0, y0, depth * 0.5, x1, y1, depth * 0.5,
              x1, y1 * 0.86, -depth * 0.5, x0, y0 * 0.86, -depth * 0.5, hexTop, 1.16);
            // back face
            b.quad(x0, y0 * 0.86, -depth * 0.5, x1, y1 * 0.86, -depth * 0.5,
              x1, FOOT, -depth * 0.5, x0, FOOT, -depth * 0.5, hexSide, 0.72);
          }
        };
        ridge(74, 26, 132, 34, 0x6b7a68, 0x4e5a4e, 0.0);
        ridge(96, 20, 96, 22, 0x5f6e6a, 0x46524f, 2.1);
        ridge(120, 16, 68, 12, 0x55635f, 0x3d4845, 4.4);
        // The crag: a blocky head at the crest of the near ridge.
        const cragX = 22, cragY = 118;
        b.box(cragX, cragY + 9, 4, 7.5, 9, 7.0, 0x7b7f72,
          { taper: 0.78, shade: { side: 1.05, top: 1.2 } });
        b.box(cragX + 6.5, cragY + 13, 4, 4.0, 4.6, 5.4, 0x83877a,
          { taper: 0.7, shade: { top: 1.22 } });
        b.box(cragX - 5.0, cragY + 15.5, 3, 3.4, 3.4, 4.6, 0x6f7368,
          { taper: 0.62, shade: { top: 1.18 } });
        b.prism(cragX + 1.5, cragY + 18, 2.5, 3.6, 6.5, 5,
          0x878b7e, { taper: 0.32, shade: { top: 1.24 } });
        return { geo: b.build('lionRock'), cull: 3200, shadow: false };
      }

      case 'harbourwater': {
        // ---- the harbour surface, as a PROP ---------------------------------
        // `waterLevel` cannot do this job on a `city` circuit and that was
        // measured, not assumed — see the long note on `bostonHarbor.waterLevel`
        // in `CityDefs.ts`: the theme scales the terrain field by 0.42 and the
        // road corridor sinks below every level that would still read as water,
        // so a global plane either covers 0.1 % of the map or floods the verge.
        //
        // A prop can do it, because a prop is seated on the heightfield at ONE
        // point and carries its own skirt. This is a 300 x 140 m facetted
        // surface on the `metal` material — roughness 0.34, metalness 0.85, so
        // it takes the sky and the city glow as a reflection rather than being
        // painted blue — with a 5.5 m apron all round that buries the near seam.
        //
        // ACROSS-ROAD half-extent 70 m, and that number is MEASURED, not chosen
        // for looks. `.probe-tmp/citysite.ts` walks the ground on the harbour
        // side of Hong Kong's promenade: it rises 0.09 m at lat 40, 1.53 m at
        // 100, 5.6 m at 170 and 16.7 m at 330. So the far half of any wider
        // plate would be underground. At 70 the far edge sits about 4 m below
        // the natural bank, which is not a defect — that bank IS the far shore,
        // and the towers across the water stand up it. Hong Kong Island rises
        // straight out of the harbour, so a rising far bank is the correct read.
        const b = this.builder();
        b.uvScale = 0.06;
        b.jitter = 0.06;
        const SX = 150, SZ = 70, NX = 20, NZ = 10;
        const deep = 0x14303e, shallow = 0x1c4657;
        const wy = (x: number, z: number): number =>
          0.16 * Math.sin(x * 0.11 + z * 0.05) + 0.11 * Math.sin(x * 0.037 - z * 0.13);
        for (let i = 0; i < NX; i++) {
          for (let j = 0; j < NZ; j++) {
            const x0 = -SX + (i / NX) * SX * 2, x1 = -SX + ((i + 1) / NX) * SX * 2;
            const z0 = -SZ + (j / NZ) * SZ * 2, z1 = -SZ + ((j + 1) / NZ) * SZ * 2;
            const hex = (i + j) % 3 === 0 ? shallow : deep;
            b.quad(
              x0, wy(x0, z0), z0, x1, wy(x1, z0), z0,
              x1, wy(x1, z1), z1, x0, wy(x0, z1), z1,
              hex, 1.0 + 0.06 * Math.sin(i * 1.7 + j * 2.3),
            );
          }
        }
        // The apron. Walks down 5.5 m all the way round, so wherever the ground
        // falls away from it the seam is under the water rather than a hole in it.
        const APRON = -5.5;
        const apron = 0x22262a;
        for (const [ax, az, ux, uz] of [
          [0, SZ, 1, 0], [0, -SZ, 1, 0], [SX, 0, 0, 1], [-SX, 0, 0, 1],
        ] as ReadonlyArray<readonly [number, number, number, number]>) {
          const span = ux ? SX : SZ;
          const outX = ux ? 0 : Math.sign(ax);
          const outZ = uz ? 0 : Math.sign(az);
          b.quad(
            ax - ux * span, 0, az - uz * span,
            ax + ux * span, 0, az + uz * span,
            ax + ux * span + outX * 0.6, APRON, az + uz * span + outZ * 0.6,
            ax - ux * span + outX * 0.6, APRON, az - uz * span + outZ * 0.6,
            apron, 0.7,
          );
        }
        return { geo: b.build('harbourWater'), mat: this.metal, cull: 2400, shadow: false };
      }

      case 'flaghk': return this.flagMast(FLAG_HK);

      // =====================================================================
      //  NEW YORK CIRCUIT
      // =====================================================================

      case 'brooklyntower': {
        // ---- the suspension bridge's masonry tower ---------------------------
        // Granite, with TWO POINTED ARCHES side by side — one over each half of
        // the carriageway. That pair of gothic openings is the entire identity
        // of this bridge; a single arch is a viaduct and a square hole is a
        // gatehouse.
        //
        // WIDTH, and it is the same argument `bridgearch` makes: authored at
        // lat 0, so local +-X runs ACROSS the deck. The bridge section is
        // hw 11 + kerb 1.55 + shoulder 1.2 = 13.75 m of corridor, so nothing may
        // come inside 14.2 m of the centreline below the arch springing. The
        // outer piers stand at |x| >= 14.9 and the springing is at 12.0 m, so the
        // opening is the full width of the carriageway with 12 m of headroom.
        const b = this.builder();
        b.uvScale = 1 / this.facadeTileOf('masonry');
        const { pierW, gap, spring, crown, shoulderY, top } = BROOKLYN;
        const gran = 0xa89e8c, granB = 0x968b79, cap = 0x7d7466;
        for (const sx of [-1, 1]) {
          // The pier, and the skirt that reaches for the ground beneath the
          // deck. Same convention as `bridgearch`'s `pier`: the anchor IS the
          // carriageway, so anything that meets the ground hangs from it.
          b.box(sx * (gap + pierW), BROOKLYN.skirt * 0.5, 0, pierW, -BROOKLYN.skirt * 0.5,
            4.6, granB, { taper: 1.14, shade: { top: 1.04 } });
          b.box(sx * (gap + pierW), spring * 0.5, 0, pierW, spring * 0.5, 4.2, gran,
            { taper: 0.985, shade: { side: 1.0, top: 1.08 } });
        }
        // ---- the two pointed arches -----------------------------------------
        // Corbelled: nine voussoir courses per jamb, each stepping in and up, so
        // the two faces of an opening meet in a point. Cheap, and it is the only
        // way to get a gothic head out of axis-aligned masonry.
        const COURSES = 9;
        {
          const inner = BROOKLYN.centreW, outer = gap;
          const halfSpan = (outer - inner) * 0.5;
          const mid = (inner + outer) * 0.5;
          const hgt = (crown - spring) / COURSES * 0.5;
          for (let i = 0; i < COURSES; i++) {
            const f = (i + 1) / COURSES;
            const y = spring + (crown - spring) * f;
            // The opening narrows from BOTH jambs as f^2, so the two curves meet
            // in a point at the crown instead of closing as a semicircle.
            const grown = halfSpan * f * f;
            for (const sx of [-1, 1]) {
              for (const s2 of [-1, 1]) {
                b.box(sx * (mid + s2 * (halfSpan - grown * 0.5)), y - hgt, 0,
                  grown * 0.5 + 0.34, hgt, 4.05,
                  i % 2 ? gran : granB, { shade: { top: 1.1 } });
              }
            }
          }
        }
        // The centre pier is CORBELLED OFF above the traffic envelope and does
        // not reach the deck. On the real bridge it lands between the two
        // carriageways; here that would be a 4.8 m wall on the centreline of a
        // racing circuit, which is an obstacle, not a landmark. It starts at
        // `pendant` — 9.4 m of clear air over the crown of the road, against a
        // kart 1.1 m tall — and terminates in a moulded boss, so the two arches
        // still read as two arches from every approach.
        b.box(0, (BROOKLYN.pendant + shoulderY) * 0.5, 0, BROOKLYN.centreW,
          (shoulderY - BROOKLYN.pendant) * 0.5, 4.0, gran,
          { taper: 0.99, shade: { top: 1.08 } });
        b.box(0, BROOKLYN.pendant - 0.45, 0, BROOKLYN.centreW * 0.82, 0.45, 3.3, cap,
          { taper: 0.62, shade: { top: 1.12 } });
        // Spandrel wall over the arches, then the tower proper.
        b.box(0, (crown + shoulderY) * 0.5, 0, gap + pierW * 2, (shoulderY - crown) * 0.5, 4.2,
          gran, { shade: { top: 1.06 } });
        b.box(0, shoulderY + 0.5, 0, gap + pierW * 2 + 0.5, 0.5, 4.7, cap,
          { shade: { top: 1.2 } });
        b.box(0, (shoulderY + top) * 0.5 + 1.0, 0, gap + pierW * 2 - 1.2,
          (top - shoulderY) * 0.5, 3.7, granB, { taper: 0.94, shade: { top: 1.08 } });
        // Saddle housings: the two boxes the main cables actually pass over, and
        // the reason the cable geometry below has somewhere to die into.
        for (const sx of [-1, 1]) {
          b.box(sx * BROOKLYN.cableX, top + 1.1, 0, 1.5, 1.1, 2.4, cap,
            { shade: { top: 1.22 } });
        }
        b.box(0, top + 0.6, 0, gap + pierW * 2 - 1.9, 0.6, 3.4, cap, { shade: { top: 1.22 } });
        // A string course and blind panels so 30 m of granite is not one flat.
        for (const y of [spring * 0.4, spring * 0.75, crown + 2.0]) {
          b.box(0, y, 4.35, gap + pierW * 2, 0.28, 0.16, cap, { shade: { top: 1.16 } });
          b.box(0, y, -4.35, gap + pierW * 2, 0.28, 0.16, cap, { shade: { top: 1.16 } });
        }
        const glow = this.builder();
        glow.sphere(0, top + 2.6, 0, 0.34, 6, 4, 0xff5a3a);
        for (const sx of [-1, 1]) {
          glow.box(sx * (gap + pierW * 0.4), crown - 1.4, 4.3, 0.34, 0.12, 0.1, 0xfff0c8);
        }
        return {
          geo: b.build('brooklynTower'),
          metalPerAnchor: (a) => this.brooklynCables(a),
          glow: glow.build('brooklynTowerGlow'),
          mat: this.facadeMat('masonry'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'empirespire': {
        // ---- the setback spire ----------------------------------------------
        // Five-storey base out to the lot line, four symmetric setbacks, then a
        // slender shaft with continuous limestone piers and nickel spandrels,
        // finishing in a tiered crown and a mooring mast.
        // ACROSS-ROAD half-extent 15.5 m (the base), 15.5 m along. 190 m tall.
        const b = this.builder();
        b.uvScale = 1 / this.facadeTileOf('masonry');
        const stone = 0xc0b49c, stoneB = 0xb0a48c, nickel = 0x9aa2a6, capC = 0x8d8271;
        const steps: ReadonlyArray<readonly [number, number, number]> = [
          [0, 22, 15.5], [22, 40, 12.6], [40, 56, 10.4], [56, 70, 8.6], [70, 138, 6.9],
        ];
        for (let i = 0; i < steps.length; i++) {
          const [y0, y1, hx] = steps[i];
          b.box(0, (y0 + y1) * 0.5, 0, hx, (y1 - y0) * 0.5, hx * 0.72,
            i % 2 ? stoneB : stone, { taper: 0.995, shade: { side: 1.0, top: 1.08 } });
          b.box(0, y1 + 0.4, 0, hx + 0.4, 0.4, hx * 0.72 + 0.4, capC, { shade: { top: 1.22 } });
          // Limestone piers: a vertical rhythm on all four faces. This is the
          // building's whole surface treatment and it must not be flat stone.
          const n = Math.max(3, Math.round(hx / 2.1));
          for (let k = -n; k <= n; k++) {
            const t = (k / n) * (hx - 0.4);
            b.box(t, (y0 + y1) * 0.5, hx * 0.72 + 0.12, 0.3, (y1 - y0) * 0.5 - 0.3, 0.16,
              nickel, { taper: 0.995 });
            b.box(t, (y0 + y1) * 0.5, -hx * 0.72 - 0.12, 0.3, (y1 - y0) * 0.5 - 0.3, 0.16,
              nickel, { taper: 0.995 });
          }
        }
        // The crown: five diminishing tiers, then the mast.
        let cy = 138.8;
        for (let i = 0; i < 5; i++) {
          const hx = 6.0 - i * 0.95;
          b.box(0, cy + 3.2, 0, hx, 3.2, hx * 0.78, i % 2 ? stoneB : stone,
            { taper: 0.93, shade: { top: 1.14 } });
          b.box(0, cy + 6.6, 0, hx * 0.96, 0.28, hx * 0.78 * 0.96, nickel,
            { shade: { top: 1.24 } });
          cy += 6.9;
        }
        b.prism(0, cy, 0, 2.3, 16.0, 12, nickel, { taper: 0.42, shade: { top: 1.2 } });
        // Mooring-mast fins, four of them, which is what stops the spire being
        // a plain cone.
        for (let s = 0; s < 4; s++) {
          const yaw = s * Math.PI * 0.5 + Math.PI * 0.25;
          b.box(Math.cos(yaw) * 1.6, cy + 5.0, Math.sin(yaw) * 1.6, 0.5, 5.0, 0.5,
            0x8f979b, { taper: 0.3, yaw });
        }
        b.prism(0, cy + 16, 0, 0.3, 20.0, 6, 0xb6bec4, { taper: 0.2 });
        const glow = this.builder();
        glow.sphere(0, cy + 36.4, 0, 0.6, 7, 5, 0xff3b2e);
        for (const y of [76, 110, 140]) glow.sphere(0, y, 7.2, 0.34, 6, 4, 0xff5a3a);
        // The floodlit crown: the one thing this building is famous for after
        // dark, and a warm wash on the tiers by day costs nothing.
        for (let i = 0; i < 5; i++) {
          for (let s = 0; s < 4; s++) {
            const yaw = s * Math.PI * 0.5;
            const hx = 6.0 - i * 0.95;
            glow.cell = i * 4 + s;
            glow.plate(Math.sin(yaw) * (hx * 0.8), 139.6 + i * 6.9, -Math.cos(yaw) * (hx * 0.8),
              hx * 1.3, 0.55, yaw + Math.PI, 0xfff0c8, { single: true });
          }
        }
        glow.cell = 0;
        const win = this.builder();
        let wc = 0;
        for (let i = 0; i < steps.length; i++) {
          const [y0, y1, hx] = steps[i];
          const floors = Math.max(3, Math.round((y1 - y0) / 8.5));
          for (let f = 0; f < floors; f++) {
            const y = y0 + 3.4 + f * ((y1 - y0 - 5) / floors);
            for (const [px, pz, yaw] of [
              [0, hx * 0.72 + 0.2, 0], [0, -hx * 0.72 - 0.2, Math.PI],
              [hx + 0.2, 0, Math.PI * 0.5], [-hx - 0.2, 0, -Math.PI * 0.5],
            ] as ReadonlyArray<readonly [number, number, number]>) {
              for (let k = -1; k <= 1; k++) {
                win.cell = wc++;
                const along = k * hx * 0.5;
                win.plate(px + Math.cos(yaw) * along, y, pz + Math.sin(yaw) * along,
                  hx * 0.4, 1.7, yaw, 0xd8e8ff, { single: true });
              }
            }
          }
        }
        win.cell = 0;
        return {
          geo: b.build('empireSpire'), glow: glow.build('empireSpireGlow'),
          windows: win.build('empireSpireWindows'),
          mat: this.facadeMat('masonry'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'chryslercrown': {
        // ---- the stepped steel crown ----------------------------------------
        // Seven diminishing shells, each with radial fins and triangular window
        // slots, on the METAL pass so the crown reflects the sky — this is the
        // one landmark on the daylight circuit whose whole point is that it is
        // polished stainless steel and not stone.
        // ACROSS-ROAD half-extent 12.4 m, 12.4 m along. 176 m to the needle tip.
        const b = this.builder();
        b.uvScale = 1 / this.facadeTileOf('masonry');
        const brick = 0xa89a86, band = 0x8a7f6d, trimC = 0xb8bec2;
        const SHAFT = 128;
        b.box(0, 9, 0, 12.4, 9, 12.4, 0x8f8474, { shade: { side: 1.0, top: 1.06 } });
        b.box(0, 18.5, 0, 12.6, 0.5, 12.6, band, { shade: { top: 1.2 } });
        b.box(0, (19 + 74) * 0.5, 0, 11.2, (74 - 19) * 0.5, 11.2, brick,
          { taper: 0.995, shade: { side: 1.0, top: 1.08 } });
        b.box(0, 74.5, 0, 11.5, 0.5, 11.5, band, { shade: { top: 1.2 } });
        b.box(0, (75 + SHAFT) * 0.5, 0, 8.6, (SHAFT - 75) * 0.5, 8.6, brick,
          { taper: 0.99, shade: { side: 1.0, top: 1.08 } });
        // Corner eagles, stylised: a bracket and a wedge at the second setback.
        for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          b.box(sx * 11.0, 75.4, sz * 11.0, 1.0, 0.5, 1.0, trimC, { shade: { top: 1.24 } });
          b.box(sx * 11.9, 76.4, sz * 11.9, 0.9, 0.55, 0.9, trimC,
            { taper: 0.2, yaw: Math.PI * 0.25, shade: { top: 1.26 } });
        }
        // Vertical brick piers on the shaft.
        for (let k = -3; k <= 3; k++) {
          for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
            b.box(dz * k * 2.4 + dx * 8.72, (75 + SHAFT) * 0.5, dx * k * 2.4 + dz * 8.72,
              dx ? 0.14 : 0.28, (SHAFT - 75) * 0.5 - 0.5, dz ? 0.14 : 0.28,
              band, { taper: 0.99 });
          }
        }
        const met = this.builder();
        met.uvScale = 0.5;
        // The crown. Each shell is a shallow tapered drum; the radii fall on a
        // curve rather than linearly, which is what gives the stack its parabola.
        const SHELLS = 7;
        let sy = SHAFT;
        for (let i = 0; i < SHELLS; i++) {
          const f = i / (SHELLS - 1);
          const r = 8.4 * Math.sqrt(Math.max(0.06, 1 - f * f * 0.96));
          const rTop = 8.4 * Math.sqrt(Math.max(0.05, 1 - ((i + 1) / (SHELLS - 1)) ** 2 * 0.96));
          const h = 5.4 - f * 1.4;
          met.prism(0, sy, 0, r, h, 14, i % 2 ? 0xd2d8dc : 0xbcc4ca,
            { taper: rTop / r, shade: { side: 1.05, top: 1.24 } });
          // Radial fins on the shell face — the sunburst.
          for (let k = 0; k < 14; k++) {
            const a = (k / 14) * Math.PI * 2;
            met.box(Math.cos(a) * r * 0.99, sy + h * 0.5, Math.sin(a) * r * 0.99,
              0.12, h * 0.5, 0.12, 0xe4eaee, { yaw: a, taper: rTop / r });
          }
          // Triangular window slots, three per shell, alternating faces.
          for (let k = 0; k < 3; k++) {
            const a = (k / 3) * Math.PI * 2 + i * 0.4;
            met.prism(Math.cos(a) * r * 0.96, sy + h * 0.25, Math.sin(a) * r * 0.96,
              0.9, h * 0.5, 3, 0x2c3238, { taper: 0.06, yaw: a });
          }
          sy += h;
        }
        met.prism(0, sy, 0, 1.1, 8.0, 8, 0xd2d8dc, { taper: 0.22 });
        met.prism(0, sy + 8, 0, 0.26, 26.0, 6, 0xe4eaee, { taper: 0.1 });
        const glow = this.builder();
        glow.sphere(0, sy + 34.4, 0, 0.5, 6, 4, 0xff3b2e);
        const win = this.builder();
        let wc = 0;
        for (let f = 0; f < 22; f++) {
          const y = 10 + f * ((SHAFT - 18) / 22);
          const hx = y > 74 ? 8.6 : (y > 18.5 ? 11.2 : 12.4);
          for (let s = 0; s < 4; s++) {
            const yaw = s * Math.PI * 0.5;
            const ca = Math.cos(yaw), sa = Math.sin(yaw);
            for (let k = -1; k <= 1; k++) {
              win.cell = wc++;
              const off = k * hx * 0.52;
              win.plate(ca * off + sa * (hx + 0.14), y, sa * off - ca * (hx + 0.14),
                hx * 0.36, 1.8, yaw + Math.PI, 0xd8e8ff, { single: true });
            }
          }
        }
        win.cell = 0;
        return {
          geo: b.build('chryslerCrown'), metal: met.build('chryslerCrownSteel'),
          glow: glow.build('chryslerCrownGlow'), windows: win.build('chryslerCrownWindows'),
          mat: this.facadeMat('masonry'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'watertankrow': {
        // ---- the tenement row, with the tanks on the roof --------------------
        // Two walk-ups as one prop, so a run of them at a matched step becomes a
        // continuous street wall for one draw call — the same trick
        // `brownstoneRow` uses, and the step in `CityDefs` matches the length.
        //
        // The ROOF TANK is the point: a cedar cylinder on a steel stand, which is
        // the single most New York silhouette above the second floor. It is on
        // this recipe rather than free-standing precisely so it has a roof under
        // it — a tank prop of its own would be a cylinder in the sky.
        //
        // ACROSS-ROAD half-extent 6.6 m (the fire escape), 15.6 m along.
        const b = this.builder();
        b.uvScale = 1 / this.facadeTileOf('masonry');
        const N = 2, W = 7.8, D = 4.9, H = 17.4;
        const bricks = [0x8f5a46, 0xa2664c, 0x7d4c3c, 0x986051];
        const halfRun = N * W * 0.5;
        for (let i = 0; i < N; i++) {
          const x = -halfRun + W * (i + 0.5);
          const brick = bricks[(i + rng.int(0, 3)) % bricks.length];
          b.box(x, H * 0.5, 0, W * 0.5, H * 0.5, D, brick, { shade: { top: 1.06 } });
          // Storefront at grade, with a fabric awning.
          b.box(x, 1.9, D + 0.2, W * 0.5 - 0.3, 1.9, 0.3, 0x39312b, { shade: { top: 1.1 } });
          b.quad(x - 2.6, 4.3, D + 0.4, x + 2.6, 4.3, D + 0.4,
            x + 2.6, 3.5, D + 2.3, x - 2.6, 3.5, D + 2.3, 0x2d5c46, 1.16);
          // Cornice, and a stone lintel band per floor.
          b.box(x, H + 0.42, 0, W * 0.5 + 0.36, 0.42, D + 0.4, 0x6b6157, { shade: { top: 1.22 } });
          for (let f = 1; f <= 4; f++) {
            b.box(x, 3.4 + f * 3.1, D + 0.06, W * 0.5, 0.18, 0.1, 0xb2a693,
              { shade: { top: 1.2 } });
          }
        }
        // Parapet, so the roof is a roof rather than a lid.
        b.box(0, H + 1.3, D - 0.2, halfRun, 0.45, 0.22, 0x6b6157, { shade: { top: 1.2 } });
        const met = this.builder();
        met.uvScale = 0.8;
        // The fire escape: landings, balustrades and the zig-zag flights. Reaches
        // 1.7 m off the facade, which is what sets the across-road half-extent.
        for (let i = 0; i < N; i++) {
          const x = -halfRun + W * (i + 0.5);
          for (let f = 1; f <= 4; f++) {
            const y = 3.4 + f * 3.1;
            met.box(x, y, D + 0.85, 2.5, 0.06, 0.85, 0x4c4a46, { shade: { top: 1.14 } });
            met.box(x, y + 0.55, D + 1.68, 2.5, 0.55, 0.05, 0x585652);
            for (const sx of [-1, 1]) {
              met.tube(x + sx * 2.45, y, D + 0.2, x + sx * 2.45, y + 3.1, D + 0.2,
                0.05, 4, 0x585652);
            }
            if (f < 4) {
              met.tube(x - 2.1, y + 0.1, D + 1.5, x + 2.1, y + 3.0, D + 0.4,
                0.06, 4, 0x4c4a46);
            }
          }
        }
        // Two tanks, on stands, on the roof.
        for (const tx of [-halfRun * 0.55, halfRun * 0.55]) {
          for (const [ox, oz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]] as const) {
            met.box(tx + ox, H + 1.9, oz, 0.1, 1.5, 0.1, 0x54524e);
          }
          met.box(tx, H + 3.4, 0, 1.5, 0.09, 1.5, 0x54524e, { shade: { top: 1.16 } });
          met.tube(tx - 1.3, H + 1.7, -1.3, tx + 1.3, H + 3.3, 1.3, 0.05, 4, 0x54524e);
          met.prism(tx, H + 3.5, 0, 1.35, 3.1, 12, 0x86694a, { shade: { side: 1.02, top: 1.1 } });
          for (const ry of [H + 4.2, H + 5.7]) {
            met.prism(tx, ry, 0, 1.4, 0.12, 12, 0x4a453e);
          }
          met.prism(tx, H + 6.6, 0, 1.42, 1.5, 12, 0x5f5348, { taper: 0.1, shade: { top: 1.2 } });
        }
        const glow = this.builder();
        const litChance = 0.16 + 0.5 * this.night;
        for (let i = 0; i < N; i++) {
          const x = -halfRun + W * (i + 0.5);
          for (let f = 1; f <= 4; f++) {
            for (const ox of [-2.1, 0, 2.1]) {
              const col = rng.next() < litChance ? 0xffdca8 : 0x191c22;
              glow.plate(x + ox, 2.2 + f * 3.1, D + 0.05, 1.15, 1.75, 0, col, { single: true });
            }
          }
        }
        return {
          geo: b.build('waterTankRow'), metal: met.build('waterTankRowSteel'),
          glow: glow.build('waterTankRowGlow'),
          mat: this.facadeMat('masonry'), softGlow: true, cull: CULL_FAR,
        };
      }

      case 'yellowcab': {
        // ---- the cab ---------------------------------------------------------
        // A three-box saloon with a roof light and a chequer band. Deliberately
        // NOT the `parkedCar` recipe: this one is always the same yellow, always
        // has the light, and appears in ranks at the kerb.
        // ACROSS-ROAD half-extent 0.98 m, 2.34 m along.
        // BUILT LENGTHWISE ALONG LOCAL +X, which is ALONG the road: a trackside
        // prop is yawed so local +Z faces the carriageway (convention 1 in
        // `Track.ts`), so a car modelled nose-forward in +Z parks nose-IN to the
        // kerb and its 4.6 m length becomes its across-road extent. Measured that
        // way it left 0.70 m of verge at lat 15.5; lengthwise it leaves 2.02 m.
        const b = this.builder();
        b.uvScale = 1.3;
        const cabY = 0xf0b81c, dark = 0x1b1e22, glassC = 0x39414a;
        b.box(0, 0.56, 0, 2.25, 0.36, 0.94, cabY, { taper: 0.96, shade: { top: 1.06 } });
        b.box(0.16, 1.02, 0, 1.12, 0.32, 0.82, cabY, { taper: 0.84, shade: { top: 1.14 } });
        b.box(0.16, 1.05, 0, 1.0, 0.24, 0.845, glassC, { taper: 0.86 });
        b.box(0, 0.22, 0, 2.3, 0.16, 0.98, dark);
        for (const sz of [-1, 1]) for (const sx of [-1.48, 1.48]) {
          b.prism(sx, 0.02, sz * 0.92, 0.32, 0.2, 8, 0x14171a);
        }
        // Chequer band and door line.
        for (let i = -4; i <= 4; i++) {
          for (const sz of [-1, 1]) {
            b.box(i * 0.25, 0.62, sz * 0.955, 0.125, 0.09, 0.01,
              i % 2 ? 0x1b1e22 : 0xf4f2ec);
          }
        }
        b.box(0.2, 1.42, 0, 0.16, 0.11, 0.34, dark);
        const glow = this.builder();
        glow.box(0.2, 1.42, 0, 0.13, 0.08, 0.3, 0xffd23a);
        glow.box(-2.28, 0.66, 0, 0.04, 0.09, 0.62, 0xfff2d0);
        glow.box(2.28, 0.66, 0, 0.04, 0.09, 0.62, 0xd6402f);
        return {
          geo: b.build('yellowCab'), glow: glow.build('yellowCabGlow'),
          softGlow: true, cull: 300,
        };
      }

      case 'steamvent': {
        // ---- steam out of the street ----------------------------------------
        // The orange-and-white stack over a manhole, and the plume. The plume is
        // built as a stack of squashed spheres of falling radiance which STARTS
        // AT THE ROAD: it is on `glowSoft`, whose `bob` gives it a slow vertical
        // drift, so it moves without a particle system.
        // ACROSS-ROAD half-extent 0.72 m, 0.72 m along.
        const b = this.builder();
        b.uvScale = 1.4;
        b.prism(0, 0.0, 0, 0.62, 0.09, 14, 0x4e4a45, { shade: { top: 1.1 } });
        b.prism(0, 0.09, 0, 0.52, 0.05, 14, 0x3a3733, { shade: { top: 1.04 } });
        // The stack: alternating orange and white collars, 2.4 m.
        for (let i = 0; i < 8; i++) {
          b.prism(0, 0.14 + i * 0.28, 0, 0.34, 0.28, 10,
            i % 2 ? 0xe06a1c : 0xe8e6df, { shade: { side: 1.04 } });
        }
        b.prism(0, 2.38, 0, 0.36, 0.1, 10, 0x2f2c28, { shade: { top: 1.14 } });
        const glow = this.builder();
        // Nine puffs, widening and dimming with height. `cell` varies so the
        // window hash does not make them all move together.
        for (let i = 0; i < 9; i++) {
          const f = i / 8;
          const y = 2.5 + f * 5.4;
          const r = 0.42 + f * 1.35;
          const v = Math.round(0xe8 * (1 - f * 0.72));
          const hex = (v << 16) | (v << 8) | Math.round(v * 1.04);
          glow.cell = i;
          glow.flap = 0.25 + f * 0.75;
          // The drift is deliberately small: at 0.9 the top puff reached 1.2 m
          // inside the drivable road from a lat of 13.5 (`.probe-tmp/sightline.ts`).
          glow.sphere((f - 0.3) * 0.55, y, f * 0.42, r, 7, 4, hex, { squash: 0.66 });
        }
        glow.flap = 0;
        glow.cell = 0;
        return {
          geo: b.build('steamVent'), glow: glow.build('steamVentPlume'),
          softGlow: true, cull: 260,
        };
      }

      case 'parklake': {
        // ---- the boating lake -----------------------------------------------
        // Same argument as `harbourWater`: the global water plane cannot serve a
        // `city` circuit, so the lake is a prop. An irregular 17-sided outline —
        // a circle would read as a puddle — with a coped stone rim, a 4 m apron
        // under it, and the surface on the `metal` pass so it takes the sky.
        // ACROSS-ROAD half-extent 34 m.
        const b = this.builder();
        b.uvScale = 0.35;
        const N = 17;
        const rimHex = 0x8f887a, rock = 0x6f6a60;
        const rad: number[] = [];
        for (let i = 0; i < N; i++) {
          rad.push(30 + 9 * Math.sin(i * 1.7) + 5 * Math.sin(i * 3.1 + 1.2));
        }
        const px = (i: number, k: number): number =>
          Math.cos((i % N / N) * Math.PI * 2) * rad[i % N] * k;
        const pz = (i: number, k: number): number =>
          Math.sin((i % N / N) * Math.PI * 2) * rad[i % N] * k;
        for (let i = 0; i < N; i++) {
          // Coping ring.
          b.quad(px(i, 1.0), 0.34, pz(i, 1.0), px(i + 1, 1.0), 0.34, pz(i + 1, 1.0),
            px(i + 1, 1.08), 0.42, pz(i + 1, 1.08), px(i, 1.08), 0.42, pz(i, 1.08),
            rimHex, 1.2);
          // Outer face of the coping, down to grade.
          b.quad(px(i, 1.08), 0.42, pz(i, 1.08), px(i + 1, 1.08), 0.42, pz(i + 1, 1.08),
            px(i + 1, 1.12), 0, pz(i + 1, 1.12), px(i, 1.12), 0, pz(i, 1.12), rimHex, 0.94);
          // Inner face, down into the water, and the apron below it.
          b.quad(px(i + 1, 1.0), 0.34, pz(i + 1, 1.0), px(i, 1.0), 0.34, pz(i, 1.0),
            px(i, 0.985), -4, pz(i, 0.985), px(i + 1, 0.985), -4, pz(i + 1, 0.985),
            rock, 0.6);
          b.quad(px(i, 1.12), 0, pz(i, 1.12), px(i + 1, 1.12), 0, pz(i + 1, 1.12),
            px(i + 1, 1.2), -4, pz(i + 1, 1.2), px(i, 1.2), -4, pz(i, 1.2), rock, 0.55);
        }
        // A few boulders on the rim — this park is famous for its schist.
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + 0.6;
          const r = 30 + 5 * Math.sin(i * 2.2);
          b.box(Math.cos(a) * r * 1.16, 0.55, Math.sin(a) * r * 1.16,
            1.6 + i * 0.2, 0.55, 1.3, rock,
            { yaw: a, taper: 0.72, shade: { top: 1.16 } });
        }
        const met = this.builder();
        met.uvScale = 0.1;
        met.jitter = 0.05;
        const water = 0x24413c, waterB = 0x2d5148;
        for (let i = 0; i < N; i++) {
          for (let k = 0; k < 4; k++) {
            const k0 = k / 4, k1 = (k + 1) / 4;
            const wob = (t: number): number => 0.05 * Math.sin(t * 4.0 + k * 1.7);
            met.quad(
              px(i, k0), 0.2 + wob(i), pz(i, k0),
              px(i + 1, k0), 0.2 + wob(i + 1), pz(i + 1, k0),
              px(i + 1, k1), 0.2 + wob(i + 1.5), pz(i + 1, k1),
              px(i, k1), 0.2 + wob(i + 0.5), pz(i, k1),
              (i + k) % 3 === 0 ? waterB : water, 1.0,
            );
          }
        }
        return {
          geo: b.build('parkLake'), metal: met.build('parkLakeWater'),
          cull: 900, shadow: false,
        };
      }

      case 'parktree': {
        // ---- the broadleaf ----------------------------------------------------
        // An elm, not a conifer: a short bole, three rising limbs and an
        // overlapping canopy of four squashed masses. The canopy goes on the
        // CLOTH pass so it moves in the wind; the trunk does not.
        // ACROSS-ROAD half-extent 3.4 m.
        const b = this.builder();
        b.uvScale = 1.4;
        const H = rng.range(8.5, 12.0);
        const bark = 0x5a4a3a, barkB = 0x4a3d30;
        b.prism(0, 0, 0, 0.46, H * 0.42, 8, bark, { taper: 0.62, capBottom: true });
        // Root flare: three small buttresses, which is what stops a trunk
        // looking like a pipe pushed into the ground.
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + rng.range(0, 1.2);
          b.box(Math.cos(a) * 0.42, 0.28, Math.sin(a) * 0.42, 0.3, 0.28, 0.22, barkB,
            { yaw: a, taper: 0.4 });
        }
        const limbs = 3;
        for (let i = 0; i < limbs; i++) {
          const a = (i / limbs) * Math.PI * 2 + rng.range(0, 0.9);
          const r = H * 0.24;
          b.tube(0, H * 0.42, 0, Math.cos(a) * r, H * 0.72, Math.sin(a) * r,
            0.19, 5, barkB, 0.98);
        }
        const cloth = this.builder();
        const greens = [0x4a6b32, 0x557a38, 0x40602c, 0x5f8440];
        cloth.flap = 0.3;
        cloth.sphere(0, H * 0.80, 0, H * 0.27, 8, 5, greens[0], { squash: 0.78 });
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + 0.7;
          cloth.flap = 0.34 + i * 0.06;
          cloth.sphere(Math.cos(a) * H * 0.17, H * (0.70 + i * 0.055), Math.sin(a) * H * 0.17,
            H * (0.19 - i * 0.012), 7, 4, greens[1 + i], { squash: 0.82 });
        }
        cloth.flap = 0;
        return {
          geo: b.build('parkTree'), cloth: cloth.build('parkTreeCanopy'),
          cull: 420,
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

  // =========================================================================
  //  THE CARRIAGEWAY, AS A SURFACE A PROP CAN LAND ON
  // =========================================================================

  /**
   * Height of the DRAWN road surface at lateral offset `u`, relative to the
   * banked centreline plane. Always <= 0.
   *
   * ⚠️ This is the same profile `TrackBuilder.surfaceHeight` draws and
   * `WorldTextures.roadSurfaceOffset` bakes the terrain against — a THIRD copy of
   * one shape, which is a real cost, so it is written entirely out of the
   * exported `CROSS` table rather than out of restated numbers. If the crown, the
   * kerb width or the shoulder drop moves, this moves with it; only the SHAPE is
   * duplicated. (The kerb is deliberately not followed up: it is a raised strip a
   * prop should sit beside, not on.)
   */
  private roadCross(u: number, hw: number, sh: number): number {
    const a = Math.abs(u);
    if (a <= hw) {
      const t = hw > 1e-3 ? a / hw : 0;
      return -CROSS.crown * t * t;
    }
    const s = clamp01(sh > 1e-3 ? (a - hw - CROSS.kerbW) / sh : 1);
    return -CROSS.crown - CROSS.shoulderDrop * (s * s * (3 - 2 * s));
  }

  /**
   * Resolve the carriageway cross-section at arc length `s`, in world space.
   *
   * `PathStation` publishes an XZ-flattened frame plus `tanBank`, so the banked
   * binormal is rebuilt here as `normalize(bx, tanBank, bz)` — which is a UNIT
   * vector, so a lateral offset measured along it carries the same `sin(bank)`
   * of rise that `Track.roadSurfacePoint` gets from the spline's own 3D
   * binormal. Verified against it on `bostonHarbor`: the two agree to 0.02 m at
   * lat +-12.55 on the bridge's 5.2 deg superelevation.
   *
   * The tangent carries the GRADE (`dy/ds` between the bracketing stations), so
   * the normal is the real surface normal and not a level approximation. That
   * matters here: the deck falls 0.9 m over the stay fan's own length.
   */
  private deckFrameAt(s: number, out: DeckFrame): DeckFrame {
    const st = this.ctx.stations;
    const n = st.length;
    if (n < 2) {
      out.p.set(0, 0, 0); out.b.set(1, 0, 0); out.n.set(0, 1, 0);
      out.hw = 11; out.shL = SH_FALLBACK; out.shR = SH_FALLBACK; out.ok = false;
      return out;
    }
    const L = this.ctx.lapLength || (st[n - 1].s + 1);
    let t = s % L;
    if (t < 0) t += L;
    let i = 0;
    while (i + 1 < n && st[i + 1].s <= t) i++;
    const a = st[i];
    const b = st[(i + 1) % n];
    const span = (b.s > a.s ? b.s - a.s : L - a.s) || 1;
    const f = clamp01((t - a.s) / span);
    const lerp = (u: number, v: number): number => u + (v - u) * f;
    out.p.set(lerp(a.px, b.px), lerp(a.py, b.py), lerp(a.pz, b.pz));
    out.hw = lerp(a.halfWidth, b.halfWidth);
    out.shL = lerp(a.shoulderL ?? SH_FALLBACK, b.shoulderL ?? SH_FALLBACK);
    out.shR = lerp(a.shoulderR ?? SH_FALLBACK, b.shoulderR ?? SH_FALLBACK);
    const bank = lerp(a.tanBank, b.tanBank);
    out.b.set(lerp(a.bx, b.bx), bank, lerp(a.bz, b.bz)).normalize();
    // Tangent with grade. `span` is arc length, so (dy/span) is the real slope.
    _v2.set(lerp(a.tx, b.tx), (b.py - a.py) / span, lerp(a.tz, b.tz)).normalize();
    out.n.crossVectors(out.b, _v2).normalize();
    if (out.n.y < 0) out.n.negate();
    out.ok = true;
    return out;
  }

  /** Arc length of the station nearest `(x, z)`. */
  private arcNearest(x: number, z: number): number {
    const st = this.ctx.stations;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < st.length; i++) {
      const dx = st[i].px - x, dz = st[i].pz - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return st.length ? st[bi].s : 0;
  }

  /**
   * The stay fan and its deck anchorages for ONE bridge tower.
   *
   * Built in the tower's own local frame (yaw about Y at the anchor, exactly what
   * `emit` composes), but every deck-end point is resolved in WORLD space against
   * the carriageway at that stay's own arc length and then brought back. That is
   * the whole point: bank, grade, curvature and a `halfWidth` that changes by
   * 0.76 m between Boston's two towers all land in the geometry instead of being
   * approximated by a constant.
   *
   * 12 stays per quadrant, 4 quadrants: 48 tubes at 8 triangles and 48 anchor
   * piers at 12, i.e. 960 triangles — the same count the shared version cost,
   * now on one instance each instead of two.
   */
  private bridgeFan(a: Anchor): THREE.BufferGeometry {
    const met = this.builder();
    met.uvScale = 0.8;
    const { knee, top, stays, near, far, radius, anchorH, inset } = BRIDGE;
    const arc0 = this.arcNearest(a.x, a.z);
    // Yaw-only instance basis, matching `emit`'s default `place`.
    const ca = Math.cos(a.yaw), sa = Math.sin(a.yaw);
    const sc = a.scale || 1;
    /** World point -> the tower's local frame. */
    const toLocal = (w: THREE.Vector3, o: THREE.Vector3): THREE.Vector3 => {
      const dx = w.x - a.x, dy = w.y - a.y, dz = w.z - a.z;
      return o.set((dx * ca - dz * sa) / sc, dy / sc, (dx * sa + dz * ca) / sc);
    };
    // Which lateral sign is the tower's local +X? A lat-0 prop is yawed off the
    // TANGENT, and whether that lands local +X on the driver's right or left
    // depends on the spline's handedness — measured, not assumed.
    this.deckFrameAt(arc0, _deck);
    const localX = _v.set(ca, 0, sa);
    const latSign = _deck.b.dot(localX) >= 0 ? 1 : -1;

    /**
     * The shoulder point, in the tower's LOCAL frame, at `along` metres of arc
     * from the tower on lateral side `side`. This is the one call that turns the
     * road into geometry; everything below is built on top of it.
     */
    const shoulderAt = (along: number, side: number, out: THREE.Vector3): THREE.Vector3 => {
      const frame = this.deckFrameAt(arc0 + along, _deck);
      // ---- `frame.shL/shR` IS A REAL NUMBER NOW, AND THAT IS THE FIX --------
      // This line has always read the station's shoulder. Until the field was
      // plumbed the station never had one, so it read `SH_FALLBACK` (3 m)
      // against an authored 1.2 m and put the whole edge girder 1.8 m too far
      // out — measured against the DRAWN ribbon (`.probe-tmp/shoulderfix.ts`
      // claim C, `bostonHarbor`, same probe both ways): 32 of 32 girder anchor
      // bands with NO drawn road beneath the foot, worst 1.41 m outboard of the
      // deck edge and 0.59 m of air under it. Afterwards: 0 of 32 off the deck,
      // worst 0.34 m INBOARD of the edge and 0.03 m of embedment. That is the
      // owner's twice-reported floating cables, and nothing in this function
      // changed — the number it was reading did.
      const sh = side < 0 ? frame.shL : frame.shR;
      const edge = frame.hw + CROSS.kerbW + sh;
      const lat = side * (edge - inset);
      const base = this.roadCross(lat, frame.hw, sh);
      _v.copy(frame.p).addScaledVector(frame.b, lat).addScaledVector(frame.n, base);
      return toLocal(_v, out);
    };

    // ---- THE EDGE GIRDER -----------------------------------------------------
    // A cable-stayed bridge's stays anchor into an edge beam running between the
    // towers, and that beam is the reason the fan reads as BUILT: it is the
    // continuous line the cables die into, and it is visible from 200 m.
    //
    // The previous revision landed each stay in its own 0.68 x 0.80 m anchor
    // pier. Geometrically that was correct — measured 0.015 m of air under the
    // worst of them — and it still read wrong on screen, because 0.68 m at 120 m
    // is 2.5 px against a concrete barrier of almost the same value. "The cables
    // descend and simply stop, well above the road, with nothing beneath them" is
    // what a correct-but-invisible anchorage looks like at racing speed. Seated
    // is necessary; legible is the other half.
    //
    // A continuous beam was rejected in an earlier round for a good reason — a
    // straight one at a fixed |x| departs from the curving deck edge by about a
    // metre over its length and ends up over the tarmac. It is safe NOW and only
    // now, because every station of it is resolved against the road at its own
    // arc length, so it follows the bank, the grade and the curve exactly.
    const GIRDER_R = 0.34;
    const SPAN = far + 1.5;
    const STEP = 2.0;
    // A post every 6 m, not every 8. Two reasons and both are measured: the
    // worst girder segment between posts had 0.315 m of air under its own
    // footprint against a 0.35 m tolerance (`.probe-tmp/staygap.ts`), which is a
    // 10 % margin on a guard, and a beam visibly propped every 6 m reads as
    // carried where one propped every 8 reads as laid on nothing.
    const postEvery = 3;
    for (const sx of [-1, 1]) {
      const side = sx * latSign;
      let prev: THREE.Vector3 | null = null;
      let k = 0;
      for (let along = -SPAN; along <= SPAN + 1e-6; along += STEP, k++) {
        const foot = shoulderAt(along, side, _v2).clone();
        const axis = new THREE.Vector3(foot.x, foot.y + anchorH, foot.z);
        if (prev) met.tube(prev.x, prev.y, prev.z, axis.x, axis.y, axis.z, GIRDER_R, 6, 0x97a0aa, 1.0);
        prev = axis;
        // Posts down to the shoulder. Sunk 0.1 m into it rather than resting
        // exactly on it: the cross-section here is reconstructed from a 7 m
        // resample, so a centimetre of disagreement has to land as embedment.
        // Air is the defect the owner reported.
        if (k % postEvery === 0) {
          const y0 = foot.y - 0.10;
          const y1 = axis.y;
          met.box(foot.x, (y0 + y1) * 0.5, foot.z, 0.21, (y1 - y0) * 0.5, 0.26,
            0x848d97, { taper: 1.25, shade: { top: 1.1 } });
        }
      }
    }

    // ---- THE STAYS -----------------------------------------------------------
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (let i = 0; i < stays; i++) {
          const f = (i + 1) / stays;
          const along = near + (far - near) * f;
          const side = sx * latSign;
          const foot = shoulderAt(sz * along, side, _v2).clone();
          // Land ON the girder's axis, so the tube ends inside the beam rather
          // than touching its skin.
          const y1 = foot.y + anchorH;
          // ---- tower end: derived from the shaft's own taper ----------------
          const ty = knee + (top - 8 - knee) * f;
          // Buried 0.42 m inside the shaft's own half-width at this height. The
          // stay is 0.17 m in radius, so that leaves 0.25 m of shaft outside the
          // tube at every height — enough that the joint cannot open at any
          // camera angle even where the taper is steepest. (0.30 was the first
          // value; it leaves 0.13 m, which is under a single obelisk facet.)
          const tx = sx * Math.max(bridgeShaftHalf(ty) - 0.42, 0.40);
          met.tube(tx, ty, 0, foot.x, y1, foot.z, radius, 4, 0xc4ced6, 1.0);
          // A collar where the stay meets the beam — small, but it is what says
          // the cable is bolted to the girder rather than passing through it.
          met.box(foot.x, y1 + 0.30, foot.z, 0.30, 0.34, 0.30, 0xb4bcc4,
            { taper: 0.7, shade: { top: 1.14 } });
        }
      }
    }
    return met.build('bridgeArchCables');
  }

  /**
   * The main cables, the suspenders and the diagonal stay web for ONE
   * suspension-bridge tower, plus the edge girder they all land on.
   *
   * ---- THIS IS SOLVED AGAINST THE DECK, NOT AGAINST CONSTANTS ---------------
   * Same construction as `bridgeFan` and for the same measured reason: over the
   * 96 m this web reaches, the New York deck is banked 5 deg, falls, and curves
   * away from a straight chord — a shared geometry cannot be right at both
   * towers. Every point that has to MEET the road is resolved in world space
   * against `deckFrameAt()` at that point's own arc length and brought back into
   * the tower's local frame, so bank, grade, curvature and a changing
   * `halfWidth` all land in the geometry.
   *
   * The main cable is a real parabola between the two saddles — `sag` is
   * measured DOWN from the chord joining them — and the suspenders are solved as
   * the vertical distance from that parabola to the girder axis at the same arc
   * length, which is what stops a cable end hanging in space. The owner reported
   * floating bridge cables twice; the fix both times was to stop authoring the
   * deck end as a literal.
   */
  private brooklynCables(a: Anchor): THREE.BufferGeometry {
    const met = this.builder();
    met.uvScale = 0.8;
    const {
      top, shoulderY, cableX, reach, suspenders, stays,
      mainR, hangR, stayR, anchorH, inset,
    } = BROOKLYN;
    const arc0 = this.arcNearest(a.x, a.z);
    const ca = Math.cos(a.yaw), sa = Math.sin(a.yaw);
    const sc = a.scale || 1;
    const toLocal = (w: THREE.Vector3, o: THREE.Vector3): THREE.Vector3 => {
      const dx = w.x - a.x, dy = w.y - a.y, dz = w.z - a.z;
      return o.set((dx * ca - dz * sa) / sc, dy / sc, (dx * sa + dz * ca) / sc);
    };
    // Which lateral sign is the tower's local +X? Measured off the real deck
    // frame, exactly as `bridgeFan` does — the spline's handedness decides it.
    this.deckFrameAt(arc0, _deck);
    const localX = _v.set(ca, 0, sa);
    const latSign = _deck.b.dot(localX) >= 0 ? 1 : -1;

    /** The shoulder point at `along` metres of arc, in the tower's local frame. */
    const shoulderAt = (along: number, side: number, out: THREE.Vector3): THREE.Vector3 => {
      const frame = this.deckFrameAt(arc0 + along, _deck);
      // The station's own shoulder, not a constant — see the note where
      // `BROOKLYN.shoulder` used to be. Identical to `bridgeFan.shoulderAt`.
      const sh = side < 0 ? frame.shL : frame.shR;
      const edge = frame.hw + CROSS.kerbW + sh;
      const lat = side * (edge - inset);
      const base = this.roadCross(lat, frame.hw, sh);
      _v.copy(frame.p).addScaledVector(frame.b, lat).addScaledVector(frame.n, base);
      return toLocal(_v, out);
    };
    /** The girder axis: the shoulder point lifted by the girder's own depth. */
    const girderAt = (along: number, side: number): THREE.Vector3 => {
      const f = shoulderAt(along, side, _v2).clone();
      f.y += anchorH;
      return f;
    };

    // ---- the edge girder -----------------------------------------------------
    // The continuous beam every suspender dies into. Resolved station by station
    // so it follows the bank and the curve; propped every 6 m so it reads as
    // carried. Both numbers are `bridgeFan`'s, measured there.
    const STEP = 2.0, SPAN = reach + 2;
    const NSTEP = Math.round((SPAN * 2) / STEP);
    for (const sx of [-1, 1]) {
      const side = sx * latSign;
      let prev: THREE.Vector3 | null = null;
      for (let k = 0; k <= NSTEP; k++) {
        const along = -SPAN + k * STEP;
        const foot = shoulderAt(along, side, _v2).clone();
        const axis = new THREE.Vector3(foot.x, foot.y + anchorH, foot.z);
        if (prev) met.tube(prev.x, prev.y, prev.z, axis.x, axis.y, axis.z, 0.32, 6, 0x8d959d, 1.0);
        prev = axis;
        // A post every 6 m, AND one at each end. Without the end posts the last
        // 4 m of beam has nothing under it — measured as the single floating
        // band on this circuit (`.probe-tmp/citynew.ts`, arc 992, +1.51 m of
        // air), which is exactly the defect the whole solve exists to avoid.
        if (k % 3 === 0 || k === NSTEP) {
          const y0 = foot.y - 0.10;
          met.box(foot.x, (y0 + axis.y) * 0.5, foot.z, 0.20, (axis.y - y0) * 0.5, 0.25,
            0x7d858d, { taper: 1.25, shade: { top: 1.1 } });
        }
      }
    }

    // ---- the main cables -----------------------------------------------------
    // A parabola from this saddle out to `reach` each way, sagging toward — and
    // finishing ON — the girder axis at the far end, which is where the next
    // tower's cable meets it. `SEG` segments a side; each joint is a real point
    // on the curve, so the polyline never crosses the deck it is supposed to
    // clear.
    const SEG = 10;
    /** Height of the main cable above the girder at fraction `f` of the reach. */
    const cableY = (f: number, gy: number, sy: number): number => {
      // Parabolic: full height at the saddle (f = 0), meeting the girder at f = 1.
      const k = 1 - f * f;
      return gy + (sy - gy) * k;
    };
    for (const sx of [-1, 1]) {
      const side = sx * latSign;
      const saddleX = sx * cableX;
      for (const sz of [-1, 1]) {
        let prev: THREE.Vector3 | null = null;
        for (let i = 0; i <= SEG; i++) {
          const f = i / SEG;
          const along = sz * reach * f;
          const g = girderAt(along, side);
          // Blend the cable's lateral position from the saddle to the girder, so
          // the cable planes converge on the deck edges the way the real ones do.
          const x = saddleX + (g.x - saddleX) * f;
          const z = g.z * f;
          const y = cableY(f, g.y, top + 2.2);
          const p = new THREE.Vector3(x, y, z);
          if (prev) met.tube(prev.x, prev.y, prev.z, p.x, p.y, p.z, mainR, 6, 0xb4bcc4, 1.05);
          prev = p;
        }
        // ---- the suspenders --------------------------------------------------
        // Vertical droppers from the cable to the girder axis at the SAME arc
        // length, so both ends are on something by construction.
        for (let i = 1; i <= suspenders; i++) {
          const f = i / (suspenders + 1);
          const along = sz * reach * f;
          const g = girderAt(along, side);
          const x = saddleX + (g.x - saddleX) * f;
          const y = cableY(f, g.y, top + 2.2);
          met.tube(x, y, g.z * f, g.x, g.y, g.z, hangR, 4, 0xc4ccd4, 1.0);
        }
        // ---- the diagonal stay web -------------------------------------------
        // Straight stays fanning from the tower shaft down to the girder. This
        // web crossing the suspenders is what makes the bridge unmistakable, and
        // it is structural: the real one is a hybrid suspension/stayed span.
        for (let i = 0; i < stays; i++) {
          const f = (i + 1) / stays;
          const along = sz * (reach * 0.24 + reach * 0.62 * f);
          const g = girderAt(along, side);
          const ty = shoulderY + (top - 6 - shoulderY) * f;
          met.tube(sx * (cableX - 3.2), ty, 0, g.x, g.y, g.z, stayR, 4, 0xc4ccd4, 1.0);
        }
      }
    }
    return met.build('brooklynCables');
  }

  /**
   * A plaza flag mast carrying one cell of the flag atlas.
   *
   * This is `flagpole`'s machinery, not a second cloth system: a mast plus one
   * `plate(..., flapAcross: true)` whose -x edge is pinned and whose +x edge is
   * moved by the shared `uWind` uniform in `patchProp`'s `sway` block. The only
   * difference is that the cloth's colour comes from a baked `atlasRect()` cell
   * instead of a solid hex, so the panel is a real flag rather than a red
   * rectangle.
   *
   * Local space: the mast is at x = 0 and the cloth flies out along +x. A
   * trackside prop is yawed so local +Z faces the road, which puts the cloth's
   * face toward the driver and its span along the road — i.e. you see the flag
   * flat-on as you go past, which is the whole reason for placing it here.
   *
   * `min.y` is 0 (the plinth's underside). Across-road half-extent is 1.15 m,
   * along-road 2.95 m.
   */
  private flagMast(cell: number, mastH = 9.6): AuthoredSpec {
    const b = this.builder();
    b.uvScale = 1.1;
    // Stepped granite plinth, so the mast lands on something rather than
    // sprouting from the paving.
    b.box(0, 0.14, 0, 1.15, 0.14, 1.15, 0x8d8a82, { shade: { top: 1.14 } });
    b.box(0, 0.42, 0, 0.8, 0.14, 0.8, 0xa5a096, { shade: { top: 1.16 } });
    b.prism(0, 0.56, 0, 0.12, mastH, 8, 0xe4e8ec, { taper: 0.6, capBottom: true });
    b.sphere(0, 0.56 + mastH + 0.15, 0, 0.18, 8, 5, 0xffc93a);
    // Halyard cleat and the two lugs the cloth is bent onto: small, but they are
    // what stop the panel looking welded to the pole.
    b.box(0.13, 1.75, 0, 0.05, 0.14, 0.05, 0xb8bcc4);
    for (const y of [0.56 + mastH - 0.5, 0.56 + mastH - 2.25]) {
      b.box(0.1, y, 0, 0.06, 0.05, 0.06, 0xb8bcc4);
    }
    const cloth = this.builder();
    const cw = 2.7, chh = 1.8;
    // `mastCloth` grades `aFlap` across its own span, so the builder-level
    // `flap = 1` the old `plate(..., flapAcross)` call needed would flatten the
    // gradient to a constant. Left unset on purpose.
    // `double`: a national flag is the one cloth in the file whose artwork is
    // asymmetric enough that the reverse side has to be right too (the USA canton
    // is in the top-LEFT — a tricolour would have hidden this forever). The +Z
    // sheet reads correctly from the road, which is the side that matters and the
    // side that was always correct; the -Z sheet is 36 triangles on one instance
    // per circuit and means a flyover or a cinematic angle cannot catch it out.
    // `wave` and `sag` give the panel a shape it is not animated into: see
    // `mastCloth`. Without them the flag is a plane every time the travelling
    // wave crosses zero, which is twice a second and is what the eye latches on
    // to. 7 rows instead of 3 so the diagonal crease has something to bend over —
    // 84 triangles a sheet, on 17 instances of one draw call.
    cloth.mastCloth(0.11, 0.56 + mastH - 1.4 + chh * 0.5, 0, cw, chh, 0, 0xffffff,
      6, 7, atlasRect(cell), { double: true, wave: 0.36, sag: 0.22 });
    return {
      geo: b.build(`flagMast${cell}`), flag: cloth.build(`flagCloth${cell}`),
      cull: CULL_MID,
    };
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

    // --- city series landmarks (Boston / Taipei / Tokyo) -------------------
    // Every one of these is authored by `CityDefs.ts`. `.probe-tmp/props.ts`
    // asserts that no authored type reaches `collectAuthored` without a builder
    // — the failure mode is silent (one console.info) and it once cost two
    // circuits two thirds of their scenery.
    case 'bridgearch': case 'cabletower': case 'bridgetower': return 'bridgearch';
    case 'glasstower': case 'glassslab': return 'glasstower';
    case 'brownstonerow': case 'brownstone': case 'terracerow': return 'brownstonerow';
    case 'goldendome': case 'statehouse': case 'domedhall': return 'goldendome';
    case 'stadiumwall': case 'greenwall': case 'ballpark': return 'stadiumwall';
    case 'pagodatower': case 'tieredtower': case 'supertall': return 'pagodatower';
    case 'memorialhall': case 'memorial': case 'greathall': return 'memorialhall';
    case 'marketstall': case 'nightmarket': case 'stall': return 'marketstall';
    case 'mountainridge': case 'mountain': case 'ridge': return 'mountainridge';
    case 'latticetower': case 'steeltower': case 'redtower': return 'latticetower';
    // NB: no `'spire'` alias — that already resolves to `rockspire` above, and a
    // duplicate case label would be silently dead code.
    case 'broadcastspire': case 'skyspire': return 'broadcastspire';
    case 'screentower': case 'screenblock': case 'adwall': return 'screentower';
    case 'torii': case 'toriigate': case 'shrinegate': return 'torii';
    case 'overpassarch': case 'overpass': case 'expressway': return 'overpassarch';
    case 'flagusa': case 'usflag': return 'flagusa';
    case 'flagroc': case 'taiwanflag': case 'rocflag': return 'flagroc';
    case 'flagjapan': case 'japanflag': case 'jpflag': return 'flagjapan';

    // --- DISTRICT DECLARATIONS, not props ---------------------------------
    // A `theme: 'city'` circuit declares WHICH city it is by authoring one of
    // these once. `buildCity` claims it with `takeAuthored` before it emits
    // anything, so it never reaches `authoredSpec` and produces no geometry —
    // that is the whole point of it. See CITY_KITS for what each one selects, and
    // `.probe-tmp/props.ts` for why the probe treats these as declarations rather
    // than as an authored type with a missing builder.
    case 'districtbrick': case 'brickdistrict': return 'district:brick';
    case 'districtmidrise': case 'midrisedistrict': return 'district:midrise';
    case 'districtneon': case 'neondistrict': return 'district:tokyo';
    // ---- the two new City Series circuits --------------------------------
    case 'districtpodium': case 'hongkongdistrict': case 'podiumdistrict':
      return 'district:hongkong';
    case 'districtziggurat': case 'newyorkdistrict': case 'decodistrict':
      return 'district:newyork';
    case 'bankofchina': case 'triangletower': case 'prismtower': return 'bankofchina';
    case 'harboursupertall': case 'harborsupertall': case 'icctower':
      return 'harboursupertall';
    case 'bambooscaffold': case 'bamboo': case 'scaffold': return 'bambooscaffold';
    case 'neoncantilever': case 'shopsign': case 'cantileversign':
      return 'neoncantilever';
    case 'junk': case 'junkboat': case 'redsail': return 'junk';
    case 'tramhk': case 'doubledecktram': case 'dingding': return 'tramhk';
    case 'lionrock': case 'ridgeline': case 'skylineridge': return 'lionrock';
    case 'harbourwater': case 'harborwater': case 'waterplate': return 'harbourwater';
    case 'flaghk': case 'hkflag': case 'bauhiniaflag': return 'flaghk';
    case 'brooklyntower': case 'suspensiontower': case 'gothictower':
      return 'brooklyntower';
    case 'empirespire': case 'setbackspire': case 'decospire': return 'empirespire';
    case 'chryslercrown': case 'steelcrown': case 'crowntower': return 'chryslercrown';
    case 'watertankrow': case 'tenementrow': case 'watertower': return 'watertankrow';
    case 'yellowcab': case 'taxi': case 'cab': return 'yellowcab';
    case 'steamvent': case 'manholesteam': case 'steamstack': return 'steamvent';
    case 'parklake': case 'lake': case 'boatingpond': return 'parklake';
    case 'parktree': case 'broadleaf': case 'elm': return 'parktree';

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

// ===========================================================================
//  TAIPEI 101 — GEOMETRY HELPERS
// ===========================================================================
/**
 * ---------------------------------------------------------------------------
 *  WHY THIS TOWER GETS ITS OWN HELPERS INSTEAD OF A STACK OF `box()` CALLS
 * ---------------------------------------------------------------------------
 *  The previous `pagodatower` was eight `box()` calls with `taper: 1.16` on the
 *  default `matte` material. Three separate defects, all of them the owner's
 *  word "simplistic":
 *
 *   1. `matte` carries the shared detail normal and NOTHING else — no albedo,
 *      no roughness map. A 187 m tower of solid `#6f9b90` with a faint bump is
 *      exactly the "no default MeshStandardMaterial with a solid colour" that
 *      section 0 forbids. The curtain-wall grid has to be MATERIAL, and
 *      `facadeMat('curtain')` already draws one: 3 structural bays and 2 floors
 *      per 7.2 m tile, raised anodised mullions, an opaque spandrel band over
 *      each floor slab, and per-pane tint jitter on the vision glass.
 *   2. A `box()` is a square in plan with four hard 90 deg arrises. Taipei 101's
 *      floor plate is a square with CUT CORNERS, and section 3 lists "geometry
 *      with visible hard-edged low-poly silhouettes where MK8 would have a
 *      smooth chamfer" as an instant fail. `t101Skin` builds the real chamfered
 *      plan for 16 triangles against a box's 12.
 *   3. The modules alternated `glass` / `dark`, which is a stripe, not a
 *      building. Every module of the real tower is the same blue-green glass;
 *      what separates them is the CORNICE — a projecting drip lip and a steeply
 *      raked soffit — and the four golden ruyi medallions bolted to it. Those
 *      two details are the entire reason the silhouette says "Taipei" and not
 *      "generic stepped pagoda", and neither existed.
 *
 *  Everything below is authored against ONE plan (`T101_PLAN`) so the podium,
 *  the eight modules, the crown, the light bands and the window pass cannot
 *  drift out of register with each other.
 * ---------------------------------------------------------------------------
 */

/** Corner cut as a fraction of the half-extent. 0.245 x 10.6 m = a 2.6 m chamfer. */
const T101_CHAMFER = 0.245;

/**
 * Unit plan of the chamfered square, **in increasing-angle order**, at
 * half-extent 1. The order is load-bearing: `t101Skin` walks consecutive pairs
 * and relies on the same winding convention `Builder.prism` uses, so a face
 * emitted from `P[i+1]` toward `P[i]` comes out with its normal pointing OUT.
 * See the winding note in `Builder.box` for what happens when that is wrong —
 * every surface of this tower would be back-face culled and you would be
 * looking at its far inside wall. `.probe-tmp/t101.ts` asserts the signed
 * volume of the body is positive for exactly this reason.
 */
const T101_PLAN: ReadonlyArray<readonly [number, number]> = (() => {
  const k = 1 - T101_CHAMFER;
  const p: Array<readonly [number, number]> = [
    [1, k], [k, 1], [-k, 1], [-1, k], [-1, -k], [-k, -1], [k, -1], [1, -k],
  ];
  return p;
})();

interface T101SkinOpts {
  /**
   * v of the BOTTOM edge in uv tiles; accumulate it up the tower so the floor
   * lines run continuously through a module instead of restarting per band.
   */
  v0?: number;
  /** Extra shade multiplier — this is how the under-cornice AO band is made. */
  shade?: number;
  /** Radial offset added to both radii. Stands a glow ribbon proud of the glass. */
  grow?: number;
  /** Split every plan face into this many quads, each with its own `cell`. */
  splits?: number;
  /** First `cell` value; the helper walks it forward one per quad. */
  cell0?: number;
  /** Flat lid over the top ring, as four quads (8 triangles). */
  capTop?: boolean;
}

/**
 * One band of chamfered-square skin between two heights, tapering linearly.
 * Eight quads (sixteen triangles) plus an optional lid.
 *
 * Returns the next free `cell` index so a caller can keep the window hash
 * marching forward across bands without repeating a pane pattern.
 */
function t101Skin(
  b: Builder,
  y0: number, y1: number, r0: number, r1: number,
  hex: number, opts: T101SkinOpts = {},
): number {
  const P = T101_PLAN;
  const n = P.length;
  const R0 = r0 + (opts.grow ?? 0);
  const R1 = r1 + (opts.grow ?? 0);
  const sh = opts.shade ?? 1;
  const splits = Math.max(1, Math.round(opts.splits ?? 1));
  const uvS = b.uvScale;
  const v0 = opts.v0 ?? 0;
  // v tracks the SLANT height, not the rise: on a cornice raked at 54 deg the
  // difference is 1.7x and the spandrel courses would visibly compress.
  const v1 = v0 + Math.hypot(y1 - y0, R1 - R0) * uvS;
  let cell = opts.cell0 ?? 0;
  let u = 0;

  for (let i = 0; i < n; i++) {
    const pA = P[i];
    const pB = P[(i + 1) % n];
    // Outward normal of this face, from its own midpoint — the facet shade that
    // keeps eight faces from reading as one smooth cylinder.
    let mx = (pA[0] + pB[0]) * 0.5, mz = (pA[1] + pB[1]) * 0.5;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const facet = 0.90 + 0.15 * (0.5 + 0.5 * (mx * 0.62 + mz * 0.78));
    const fw = Math.hypot(pB[0] - pA[0], pB[1] - pA[1]) * ((R0 + R1) * 0.5);
    const dx = pA[0] - pB[0], dz = pA[1] - pB[1];

    for (let s = 0; s < splits; s++) {
      const t0 = s / splits, t1 = (s + 1) / splits;
      // a = bottom at t0, b = bottom at t1, c = top at t1, d = top at t0, with
      // t running from pB toward pA. That order is what makes the face normal
      // point outward AND puts u across the wall and v up it — `Builder.box`'s
      // own quad order does the opposite (u vertical), which is why this helper
      // passes an explicit uvRect rather than letting `quad` derive one.
      const q0x = pB[0] + dx * t0, q0z = pB[1] + dz * t0;
      const q1x = pB[0] + dx * t1, q1z = pB[1] + dz * t1;
      b.cell = cell++;
      b.quad(
        q0x * R0, y0, q0z * R0,
        q1x * R0, y0, q1z * R0,
        q1x * R1, y1, q1z * R1,
        q0x * R1, y1, q0z * R1,
        hex, sh * facet,
        [u + fw * t0 * uvS, v0, u + fw * t1 * uvS, v1],
      );
    }
    u += fw * uvS;
  }
  b.cell = 0;

  if (opts.capTop) {
    // Four quads, each the centre plus three consecutive boundary points, in
    // DECREASING angle so the lid faces up (see `Builder.prism`'s cap, which
    // reverses its fan for the same reason).
    for (let i = 0; i < n; i += 2) {
      const q0 = P[i], q1 = P[(i + 1) % n], q2 = P[(i + 2) % n];
      b.quad(
        0, y1, 0,
        q2[0] * R1, y1, q2[1] * R1,
        q1[0] * R1, y1, q1[1] * R1,
        q0[0] * R1, y1, q0[1] * R1,
        hex, sh * 1.12,
      );
    }
  }
  return cell;
}

/**
 * A disc standing proud of a vertical face: an annulus with a round or SQUARE
 * hole, plus the cylindrical rim that joins it back to the wall.
 *
 * Two things on the tower are this shape and nothing else in the file is:
 *  * the giant **ancient-coin motif** on the podium — a circle with a square
 *    hole, the Chinese cash coin, and the reason the podium is not a plinth;
 *  * the golden **ruyi medallion** at every module junction, four to a cornice,
 *    which is the ornament that makes the silhouette specifically Taipei 101.
 *
 * `mx, mz` is the face midpoint already scaled into world XZ; the outward
 * direction is taken from it, so a caller can hang one on a cardinal face or on
 * a chamfered corner without knowing which it has.
 */
function t101Disc(
  b: Builder,
  mx: number, mz: number, cy: number,
  R: number, inner: number, depth: number,
  segs: number, squareHole: boolean,
  hex: number, shade = 1,
): void {
  const l = Math.hypot(mx, mz) || 1;
  const ox = mx / l, oz = mz / l;          // outward
  const rx = oz, rz = -ox;                 // in-plane "right"
  // p(u, d) — u across the face, d out of it; the third axis is world +Y.
  const px = (u: number, d: number): number => mx + rx * u + ox * d;
  const pz = (u: number, d: number): number => mz + rz * u + oz * d;

  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    // A square hole is the same polar sweep with the radius pushed out onto the
    // square: 1 / max(|cos|, |sin|). No extra vertices, no special case.
    const k0 = squareHole ? 1 / Math.max(Math.abs(c0), Math.abs(s0)) : 1;
    const k1 = squareHole ? 1 / Math.max(Math.abs(c1), Math.abs(s1)) : 1;
    const iu0 = inner * k0 * c0, iv0 = inner * k0 * s0;
    const iu1 = inner * k1 * c1, iv1 = inner * k1 * s1;
    const ou0 = R * c0, ov0 = R * s0;
    const ou1 = R * c1, ov1 = R * s1;
    // Face: inner -> outer -> outer' -> inner', at full depth.
    b.quad(
      px(iu0, depth), cy + iv0, pz(iu0, depth),
      px(ou0, depth), cy + ov0, pz(ou0, depth),
      px(ou1, depth), cy + ov1, pz(ou1, depth),
      px(iu1, depth), cy + iv1, pz(iu1, depth),
      hex, shade * 1.06,
    );
    // Rim, wall plane out to the face. Catches the low sun as a bright edge.
    b.quad(
      px(ou0, 0), cy + ov0, pz(ou0, 0),
      px(ou1, 0), cy + ov1, pz(ou1, 0),
      px(ou1, depth), cy + ov1, pz(ou1, depth),
      px(ou0, depth), cy + ov0, pz(ou0, depth),
      hex, shade * 0.84,
    );
  }
}

/**
 * The four ruyi medallions of one module junction, one on each chamfered
 * corner. Pulled out because ten junctions call it and the corner geometry is
 * easy to get backwards: a chamfer midpoint sits `(1 + k) / 2 * sqrt(2)` =
 * 1.241 half-extents from the axis, FURTHER out than a flat face, not nearer.
 */
function t101Medallions(
  b: Builder, cy: number, r: number, R: number, hex: number,
): void {
  const P = T101_PLAN;
  for (let i = 0; i < P.length; i++) {
    const pA = P[i], pB = P[(i + 1) % P.length];
    // Corner faces only: their two endpoints differ in BOTH axes.
    if (Math.abs(pA[0] - pB[0]) < 1e-6 || Math.abs(pA[1] - pB[1]) < 1e-6) continue;
    t101Disc(
      b, (pA[0] + pB[0]) * 0.5 * r, (pA[1] + pB[1]) * 0.5 * r, cy,
      R, R * 0.34, R * 0.30, 6, false, hex, 1,
    );
  }
}
