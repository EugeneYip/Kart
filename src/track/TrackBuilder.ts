/**
 * ============================================================================
 *  TrackBuilder — spline in, circuit out
 * ============================================================================
 *
 *  ONE cross-section function, `surfaceHeight()`, defines the road. The visual
 *  geometry and the physics ground probe both call it, so what you see and
 *  what the wheels feel can never disagree — no "the kerb looks 8 cm high but
 *  the collision mesh says 3" class of bug.
 *
 *  Cross-section, from the centreline outwards (per side):
 *
 *      |<----------- hw ----------->|<- kerb ->|<--- shoulder --->|wall
 *      ______                                                      |
 *            ‾‾‾---___                 __/‾‾\__                    |
 *       crown camber  ‾‾‾--___________/          ‾‾--_____         |
 *        (1.5 %)                 chamfer  rumble        ‾‾--___    |
 *
 *   * crown camber sheds water and makes the road read as a real surface
 *     rather than a flat ribbon,
 *   * the kerb is genuine 3D geometry: an inner chamfer, a flat top carrying
 *     a rumble sawtooth (a smooth analytic function of arc length, so the
 *     geometry and the raycast agree exactly), then an outer chamfer,
 *   * the shoulder falls away with a smoothstep so the transition to
 *     off-road has no hard crease.
 *
 *  Tessellation is adaptive: ~1.7 m rings on a straight, down to 0.4 m in a
 *  40 m-radius hairpin, with extra rings wherever the bank rate is high (the
 *  wall-ride) and a forced ring on every control-point boundary so features
 *  switch on cleanly.
 *
 *  Output: a handful of merged meshes (road / kerb / one per shoulder surface
 *  / one per wall style / tunnels / bridge decks), plus a SEPARATE simplified
 *  collision mesh with a BVH on it.
 * ============================================================================
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { SurfaceType } from '@/core/Types';
import type { QualitySettings } from '@/core/Types';
import { clamp, clamp01, Rng, smoothstep } from '@/core/MathUtils';
import { TF, makeAttribs, makeSample } from './TrackSpline';
import type { SplineAttribs, TrackSpline, WallStyle } from './TrackSpline';
import type { TrackDef } from './TrackDefs';
import type { RoadMaterials } from './RoadMaterial';

// ---------------------------------------------------------------------------
// The cross-section. Everything downstream depends on these numbers.
// ---------------------------------------------------------------------------

export const CROSS = {
  /** Metres of drop from the crown to the asphalt edge (~1.4 % average). */
  crown: 0.16,
  /** Kerb width outside the asphalt edge. */
  kerbW: 1.55,
  /** Inner ramp of the kerb. */
  chamferIn: 0.42,
  /** Outer ramp of the kerb. */
  chamferOut: 0.46,
  /** Kerb top above the asphalt edge. */
  kerbH: 0.085,
  /** Rumble sawtooth amplitude on the kerb top. */
  rumbleAmp: 0.032,
  /** Metres per rumble tooth. */
  rumblePeriod: 1.5,
  /** Metres of one painted kerb stripe (drives the kerb UV). */
  stripe: 2.3,
  /** Drop across the whole shoulder. */
  shoulderDrop: 0.34,
  /** World metres per asphalt texture tile. */
  roadTile: 6.0,
  /** Guardrail height above the shoulder edge. */
  railH: 0.62,
  /** Concrete barrier height. */
  concreteH: 0.95,
  /** Rock face height. */
  rockH: 6.5,
  /** Building façade height (Environment builds the rest). */
  buildingH: 9.0,
  /** Chain-link fence height. */
  fenceH: 2.5,
  /** Energy rail height. */
  energyH: 1.15,
  /** Timber railing height. */
  woodH: 1.0,
  /** Tunnel bore clearance above the crown. */
  tunnelH: 8.2,
  /** Bridge fascia depth. */
  deckDepth: 1.35,
} as const;

/**
 * Metres of lap behind the start line taken up by the twelve-kart grid. Must
 * stay >= `Checkpoints.buildGrid`'s deepest row (8.5 + 5 * gridSpacing * 1.55
 * + gridStagger); item rows are kept out of it.
 */
const START_GRID_LENGTH = 70;

// ---------------------------------------------------------------------------
//  ROAD VOLUMES — the exclusion set the world dresser must respect
// ---------------------------------------------------------------------------
/**
 * ========================= WHY THIS EXISTS =========================
 * A human playtester reported buildings poking through the tunnel wall and
 * standing *inside the bore*, on the racing line.
 *
 * The guard that was in place tested **lateral distance to the centreline**:
 * every corner of a prop's footprint was projected onto the spline and had to
 * clear `halfWidth + margin`. That took coastal from 19 violations to 0 and is
 * still the right test for a flat trackside. It is, however, purely 2D — it has
 * no notion of the tunnel as a *volume*. A townhouse row authored at lat ±15
 * clears a 9 m half-width road by 6 m and passes; the tunnel arch at that
 * station springs from `hw + kerb + shoulder + 0.6 = 12.75 m` and rises 8.2 m,
 * so the same house has 3.5 m of its gable *inside the rock*. Street lamps
 * authored at lat -12 are inside the bore outright, standing in the traffic
 * space, and no lateral test will ever say so.
 *
 * So the builder publishes the volumes it actually creates. `Props` reads them
 * through `roadVolumePenetration()` and either pushes an authored prop out or
 * drops a procedural one. Sampling is a swept cross-section rather than a
 * bounding box because a tunnel follows a descending left-hander: its AABB is
 * mostly *outside* the tunnel.
 *
 * Frames carry their own basis, which is what makes the same code correct on
 * the Neon Metropolis wall-ride: at 84° of bank "up" is very nearly horizontal,
 * and a naive `y` test passes everything. Work in `(tangent, binormal, normal)`
 * and banking costs nothing.
 */
export const ROAD_VOLUME_KIND = {
  /** Tunnel bore + lining. Cross-section is a half-ellipse. */
  Tunnel: 1,
  /** Elevated deck: box above the road, plus the soffit below it. */
  Bridge: 2,
  /** Anti-gravity plating — same box, arbitrarily banked. */
  AntiGravity: 4,
} as const;

/** One sampled cross-section of an excluded volume, with its own basis. */
export interface RoadVolume {
  kind: number;
  /** Section origin: centreline point, already offset to the section's centre. */
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
  bx: number; by: number; bz: number;
  nx: number; ny: number; nz: number;
  /** Lateral semi-extent, metres. */
  lat: number;
  /** Extent above the origin along the normal, metres. */
  up: number;
  /** Extent below the origin along the normal, metres. */
  down: number;
  /** Half-ellipse (tunnel) rather than a box. */
  arch: boolean;
}

/**
 * Metres of solid a prop must clear *beyond* the traffic space. The tunnel
 * lining is a single-sided shell, so a prop that merely clears the bore still
 * z-fights the rock and shows a slice of wall inside the tunnel. 1.25 m is the
 * apparent thickness of the ribbed lining plus a hand's breadth.
 */
export const ROAD_VOLUME_SHELL = 1.25;

/** Arc-length spacing of published frames, metres. */
const VOLUME_STEP = 4;

/**
 * The current circuit's excluded volumes. Rebuilt by every `buildTrack()`;
 * `lapLength` lets a consumer working in resampled-station arc length rescale.
 * Module-level for the same reason `worldRegistry` is: the world dresser is
 * constructed by `Environment`, which never sees a `Track`.
 */
export const roadVolumes: {
  list: RoadVolume[];
  step: number;
  lapLength: number;
} = { list: [], step: VOLUME_STEP, lapLength: 0 };

/**
 * Metres a world point sits *inside* the published volumes — specifically, the
 * shortest lateral push that would clear them. 0 means clear.
 *
 * @param margin extra clearance demanded on every face (pass
 *               `ROAD_VOLUME_SHELL` to clear the outside of the tunnel shell).
 * @param out    optional: receives the world-space outward push direction.
 */
export function roadVolumePenetration(
  x: number, y: number, z: number,
  margin = 0,
  out?: THREE.Vector3,
  kinds = 0xff,
): number {
  const list = roadVolumes.list;
  if (list.length === 0) return 0;
  const reach = roadVolumes.step * 0.75;
  let worst = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if ((v.kind & kinds) === 0) continue;
    const rx = x - v.px, ry = y - v.py, rz = z - v.pz;
    // Cheap reject before the three dot products.
    const span = v.lat + v.up + margin + reach;
    if (rx * rx + ry * ry + rz * rz > span * span) continue;
    const along = rx * v.tx + ry * v.ty + rz * v.tz;
    if (along < -reach || along > reach) continue;
    const up = rx * v.nx + ry * v.ny + rz * v.nz;
    if (up < -v.down - margin || up > v.up + margin) continue;
    const lat = rx * v.bx + ry * v.by + rz * v.bz;
    let need = v.lat + margin;
    if (v.arch && up > 0) {
      // Lateral half-width of the bore at this height. Above the crown the
      // requirement falls to zero, which is correct: clear over the top.
      const h = v.up + margin;
      const k = 1 - (up / h) * (up / h);
      need *= k > 0 ? Math.sqrt(k) : 0;
    }
    const a = lat < 0 ? -lat : lat;
    if (a >= need) continue;
    const pen = need - a;
    if (pen > worst) {
      worst = pen;
      if (out) {
        const s = lat < 0 ? -1 : 1;
        out.set(v.bx * s, v.by * s, v.bz * s);
      }
    }
  }
  return worst;
}

/**
 * Item box CENTRE height above the road surface, metres.
 *
 * Not a taste value — derived. `ItemBox` draws a `BOX_SIZE = 1.72` cube that
 * tumbles (euler YXZ, x = 0.38 +- 0.32, y free, z +- 0.22) and bobs +-0.10, and
 * breathes to 1.022 scale. The lowest corner of that cube sits
 *   0.86 * (cos x * (|sin z| + |cos z|) + |sin x|) * 1.022 + 0.10
 * below the centre, which maximises at **1.47 m** (x = 0.70, z = 0.22). At the
 * old 1.50 m that left 3 cm of clearance over the crown of the road, so the
 * centre box of every row — the one on the racing line — visibly cut through the
 * tarmac. 1.70 m leaves 0.23 m.
 *
 * Upper bound: `ItemBox.checkPickups` pre-filters on
 * `dx^2 + dy^2 + dz^2 <= BOX_PICKUP_RADIUS^2 + 1.2`, so with a kart CoM ~0.45 m
 * up this still leaves a 1.4 m horizontal catch radius — wider than a kart.
 */
const ITEM_BOX_HEIGHT = 1.7;
/** Lateral clearance an item box keeps from the asphalt edge, metres. */
const ITEM_BOX_EDGE = 2.2;

/** Normalise a lap fraction into [0,1). */
function wrap01(t: number): number {
  return ((t % 1) + 1) % 1;
}

/** Rumble profile on the kerb top. Smooth, so physics can sample it. */
function rumble(d: number): number {
  const p = (d / CROSS.rumblePeriod) * Math.PI * 2;
  const w = 0.5 - 0.5 * Math.cos(p);
  // flatten the tops so the teeth read as blocks rather than a sine wave
  return CROSS.rumbleAmp * Math.pow(w, 0.62);
}

export type LateralZone = 'road' | 'kerb' | 'shoulder' | 'off';

/** Which band of the cross-section a lateral offset falls in. */
export function lateralZone(lat: number, hw: number, sh: number, noKerb: boolean): LateralZone {
  const u = Math.abs(lat);
  if (u <= hw) return 'road';
  const kw = noKerb ? 0 : CROSS.kerbW;
  if (u <= hw + kw) return 'kerb';
  if (u <= hw + kw + sh) return 'shoulder';
  return 'off';
}

/**
 * Height of the drivable surface above the banked centreline plane, at a
 * signed lateral offset. THE definition of the road surface.
 *
 * @param lat  signed lateral offset, metres (+ = driver's right)
 * @param hw   half width of the asphalt
 * @param sh   shoulder width on the side `lat` is on
 * @param d    arc length (only the rumble depends on it)
 * @param noKerb suppress the kerb (ramps, gaps, jump lips)
 */
export function surfaceHeight(
  lat: number,
  hw: number,
  sh: number,
  d: number,
  noKerb: boolean,
): number {
  const u = Math.abs(lat);
  const edge = -CROSS.crown;
  if (u <= hw) {
    const t = hw > 1e-3 ? u / hw : 0;
    return -CROSS.crown * t * t;
  }
  const kw = noKerb ? 0 : CROSS.kerbW;
  if (u <= hw + kw && kw > 0) {
    const s = u - hw;
    const a = smoothstep(s / CROSS.chamferIn);
    const b = smoothstep((kw - s) / CROSS.chamferOut);
    const shape = a * b;
    return edge + (CROSS.kerbH + rumble(d)) * shape;
  }
  const s = clamp01(sh > 1e-3 ? (u - hw - kw) / sh : 1);
  return edge - CROSS.shoulderDrop * (s * s * (3 - 2 * s));
}

/** d(height)/d(lat) — the lateral slope, for the surface normal. */
function surfaceSlopeLat(
  lat: number,
  hw: number,
  sh: number,
  d: number,
  noKerb: boolean,
): number {
  const e = 0.06;
  return (
    (surfaceHeight(lat + e, hw, sh, d, noKerb) - surfaceHeight(lat - e, hw, sh, d, noKerb)) /
    (2 * e)
  );
}

/** d(height)/d(arcLength) — only the rumble contributes. */
function surfaceSlopeLong(
  lat: number,
  hw: number,
  sh: number,
  d: number,
  noKerb: boolean,
): number {
  const u = Math.abs(lat);
  const kw = noKerb ? 0 : CROSS.kerbW;
  if (u <= hw || u > hw + kw || kw <= 0) return 0;
  const e = 0.08;
  return (
    (surfaceHeight(lat, hw, sh, d + e, noKerb) - surfaceHeight(lat, hw, sh, d - e, noKerb)) /
    (2 * e)
  );
}

// ---------------------------------------------------------------------------
// Module scratch
// ---------------------------------------------------------------------------

const _s = makeSample();
const _at = makeAttribs();
const _v = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _sc = new THREE.Vector3(1, 1, 1);

/** True when this arc length has a kerb suppressed by a feature flag. */
export function kerbSuppressed(flags: number, side: -1 | 1): boolean {
  if (flags & (TF.Ramp | TF.Gap)) return true;
  if (side < 0 && flags & TF.NoKerbL) return true;
  if (side > 0 && flags & TF.NoKerbR) return true;
  return false;
}

/**
 * World position (and optionally the surface normal) of a point on the road,
 * given arc length and lateral offset. Shared by Decals, boost pads, item
 * boxes, the grid and the analytic ground probe.
 */
export function roadSurfacePoint(
  spline: TrackSpline,
  d: number,
  lat: number,
  out: THREE.Vector3,
  outNormal?: THREE.Vector3,
): THREE.Vector3 {
  spline.sampleAtDistance(d, _s);
  spline.attribsAtDistance(_s.distance, _at);
  const sh = lat < 0 ? _at.shoulderL : _at.shoulderR;
  const noKerb = kerbSuppressed(_at.flags, lat < 0 ? -1 : 1);
  const h = surfaceHeight(lat, _at.halfWidth, sh, _s.distance, noKerb);
  out.copy(_s.position).addScaledVector(_s.binormal, lat).addScaledVector(_s.normal, h);
  if (outNormal) {
    const dl = surfaceSlopeLat(lat, _at.halfWidth, sh, _s.distance, noKerb);
    const dz = surfaceSlopeLong(lat, _at.halfWidth, sh, _s.distance, noKerb);
    outNormal
      .copy(_s.normal)
      .addScaledVector(_s.binormal, -dl)
      .addScaledVector(_s.tangent, -dz)
      .normalize();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ring plan
// ---------------------------------------------------------------------------

/** A resampled station along the lap: everything the mesh writers need. */
export interface Station {
  d: number;
  pos: THREE.Vector3;
  tan: THREE.Vector3;
  nrm: THREE.Vector3;
  bin: THREE.Vector3;
  hw: number;
  shL: number;
  shR: number;
  bank: number;
  curvature: number;
  flags: number;
  surface: SurfaceType;
  shoulderSurface: SurfaceType;
  wallL: WallStyle;
  wallR: WallStyle;
  /** Lateral offset of the ideal racing line here. */
  line: number;
  /** 0..1 darkening from tunnels / overpasses. */
  dark: number;
}

/**
 * Adaptive tessellation. Straights get ~1.7 m; a 40 m-radius hairpin gets
 * 0.4 m; the wall-ride gets extra rings because the bank is rotating fast.
 * Control-point boundaries always land exactly on a ring.
 */
function planRings(spline: TrackSpline): number[] {
  const L = spline.length;
  const boundaries: number[] = [];
  for (let i = 0; i < spline.nodes.length; i++) {
    boundaries.push(spline.distanceOfNode(i) % L);
  }
  boundaries.sort((a, b) => a - b);

  const out: number[] = [];
  let d = 0;
  let bi = 0;
  const bankAt = (x: number) => {
    spline.sampleAtDistance(x, _s);
    return _s.bank;
  };

  let guard = 0;
  while (d < L && guard++ < 200000) {
    out.push(d);
    const k = Math.abs(spline.curvatureAtDistance(d));
    let step = 1.7 / (1 + k * 62);
    // bank rate: 1 rad over 10 m must not be one segment
    const dBank = Math.abs(bankAt(d + 4) - bankAt(d)) / 4;
    step = Math.min(step, 1.7 / (1 + dBank * 26));
    step = clamp(step, 0.4, 1.7);
    let next = d + step;
    // snap onto the next control-point boundary if we would step past it
    while (bi < boundaries.length && boundaries[bi] <= d + 1e-4) bi++;
    if (bi < boundaries.length && boundaries[bi] < next) {
      const b = boundaries[bi];
      if (b - d > 0.06) next = b;
    }
    if (L - next < 0.25) break;
    d = next;
  }
  return out;
}

/** Smoothed ideal racing line: lateral offset per station. */
function bakeRacingLine(spline: TrackSpline, ds: number[]): Float32Array {
  const n = ds.length;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    spline.sampleAtDistance(ds[i], _s);
    const k = spline.curvatureAtDistance(ds[i]);
    // Aim for the inside of the corner, proportional to how tight it is.
    const inside = -Math.sign(k) * Math.min(0.62, Math.abs(k) * 26);
    raw[i] = inside * (_s.halfWidth - 2.2);
  }
  // Two smoothing passes over ~35 m — a real line is much smoother than the
  // curvature signal that produced it.
  const out = new Float32Array(n);
  const win = Math.max(2, Math.round(n * (30 / Math.max(1, spline.length))));
  let src = raw;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let acc = 0;
      let wsum = 0;
      for (let o = -win; o <= win; o++) {
        const j = (i + o + n * 4) % n;
        const w = 1 - Math.abs(o) / (win + 1);
        acc += src[j] * w;
        wsum += w;
      }
      out[i] = acc / wsum;
    }
    src = out.slice();
  }
  return src;
}

function buildStations(spline: TrackSpline): Station[] {
  const ds = planRings(spline);
  const line = bakeRacingLine(spline, ds);
  const n = ds.length;
  const stations: Station[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const d = ds[i];
    spline.sampleAtDistance(d, _s);
    spline.attribsAtDistance(d, _at);
    stations[i] = {
      d,
      pos: _s.position.clone(),
      tan: _s.tangent.clone(),
      nrm: _s.normal.clone(),
      bin: _s.binormal.clone(),
      hw: _at.halfWidth,
      shL: _at.shoulderL,
      shR: _at.shoulderR,
      bank: _at.bank,
      curvature: _s.curvature,
      flags: _at.flags,
      surface: _at.surface,
      shoulderSurface: _at.shoulderSurface,
      wallL: _at.wallL,
      wallR: _at.wallR,
      line: line[i],
      dark: 0,
    };
  }

  // Portal darkening: fade in over 14 m from each tunnel mouth so the
  // entrance reads as a real change in light rather than a hard switch.
  const isDark = (st: Station) => (st.flags & (TF.Tunnel | TF.Dark)) !== 0;
  for (let i = 0; i < n; i++) {
    if (!isDark(stations[i])) continue;
    // distance to the nearest non-dark station, forwards and backwards
    let fwd = 0;
    for (let k = 1; k < n; k++) {
      const j = (i + k) % n;
      if (!isDark(stations[j])) { fwd = stations[j].d - stations[i].d; break; }
    }
    let back = 0;
    for (let k = 1; k < n; k++) {
      const j = (i - k + n) % n;
      if (!isDark(stations[j])) { back = stations[i].d - stations[j].d; break; }
    }
    if (fwd < 0) fwd += spline.length;
    if (back < 0) back += spline.length;
    const edge = Math.min(Math.abs(fwd), Math.abs(back));
    stations[i].dark = smoothstep(edge / 15);
  }

  return stations;
}

// ---------------------------------------------------------------------------
// Mesh accumulator
// ---------------------------------------------------------------------------

class Strip {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  uv2: number[] = [];
  col: number[] = [];
  mask: number[] = [];
  idx: number[] = [];
  vcount = 0;

  vertex(
    p: THREE.Vector3,
    n: THREE.Vector3,
    u: number,
    v: number,
    u2: number,
    v2: number,
    r: number,
    g: number,
    b: number,
    m0 = 0,
    m1 = 0,
    m2 = 0,
  ): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.uv2.push(u2, v2);
    this.col.push(r, g, b);
    this.mask.push(m0, m1, m2);
    return this.vcount++;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  toGeometry(withUv2: boolean, withMask: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (withUv2) g.setAttribute('apxUv2', new THREE.Float32BufferAttribute(this.uv2, 2));
    if (withMask) g.setAttribute('apxMask', new THREE.Float32BufferAttribute(this.mask, 3));
    g.setIndex(this.vcount > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface BuiltTrack {
  roadGroup: THREE.Group;
  collisionMesh: THREE.Mesh;
  bvh: MeshBVH;
  stations: Station[];
  /** Lateral offset of the racing line, sampled every `rlStep` metres. */
  racingLine: Float32Array;
  rlStep: number;
  minimapPath: THREE.Vector2[];
  boostPads: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; width: number }>;
  itemBoxSpawns: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; normal: THREE.Vector3 }>;
  stats: { rings: number; vertices: number; triangles: number; drawCalls: number; ms: number };
  dispose(): void;
}

const OFFROAD_LOOKUP: SurfaceType[] = [
  SurfaceType.Grass, SurfaceType.Sand, SurfaceType.Dirt, SurfaceType.OffRoad,
  SurfaceType.Metal, SurfaceType.Wood, SurfaceType.Ice,
];

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildTrack(
  spline: TrackSpline,
  def: TrackDef,
  mats: RoadMaterials,
  quality: QualitySettings,
  decalStain: THREE.Texture,
): BuiltTrack {
  const t0 = performance.now();
  const L = spline.length;
  const stations = buildStations(spline);
  const n = stations.length;
  const low = quality.tier === 'low';
  const rng = new Rng(def.terrainSeed ^ 0x77aa);

  const group = new THREE.Group();
  group.name = 'roadGroup';
  const disposables: Array<{ dispose(): void }> = [];
  const verge = new THREE.Color(def.road.verge);

  // ---- lateral sample plan -------------------------------------------------
  // Road: denser toward the edges so the crown and the kerb join read cleanly.
  const ROAD_SPANS = low ? 6 : 10;
  const roadParam: number[] = [];
  for (let i = 0; i <= ROAD_SPANS; i++) {
    const t = (i / ROAD_SPANS) * 2 - 1;
    roadParam.push(Math.sign(t) * Math.pow(Math.abs(t), 0.86));
  }
  // Kerb: inner chamfer / top / outer chamfer.
  const kerbParam = [0, 0.28, 0.52, 0.74, 1];
  const shoulderParam = low ? [0, 0.5, 1] : [0, 0.28, 0.6, 1];

  const road = new Strip();
  const kerb = new Strip();
  const shoulders = new Map<SurfaceType, Strip>();
  const walls = new Map<WallStyle, Strip>();
  const tunnel = new Strip();
  const deck = new Strip();
  const postXf: THREE.Matrix4[] = [];

  const stripFor = <K,>(map: Map<K, Strip>, key: K): Strip => {
    let s = map.get(key);
    if (!s) { s = new Strip(); map.set(key, s); }
    return s;
  };

  // Per-station ring index caches so quads can be stitched.
  let prevRoadRing: number[] | null = null;
  let prevKerbRing: [number[], number[]] | null = null;
  const prevShoulderRing = new Map<SurfaceType, [number[], number[]]>();
  const prevWallRing = new Map<WallStyle, [number[], number[]]>();
  let prevTunnelRing: number[] | null = null;
  let prevDeckRing: [number[], number[]] | null = null;

  const gapAt = (i: number) => (stations[i].flags & TF.Gap) !== 0;

  // ---- exclusion volumes (see the ROAD VOLUMES block at the top) -----------
  roadVolumes.list.length = 0;
  roadVolumes.step = VOLUME_STEP;
  roadVolumes.lapLength = L;
  let lastVolumeD = -1e9;
  const publishVolume = (st: Station): void => {
    const kind =
      st.flags & TF.Tunnel ? ROAD_VOLUME_KIND.Tunnel
        : st.flags & TF.AntiGravity ? ROAD_VOLUME_KIND.AntiGravity
          : st.flags & TF.Bridge ? ROAD_VOLUME_KIND.Bridge
            : 0;
    if (kind === 0 || st.flags & TF.Gap) return;
    if (st.d - lastVolumeD < VOLUME_STEP) return;
    lastVolumeD = st.d;
    const arch = kind === ROAD_VOLUME_KIND.Tunnel;
    // Same numbers the arch / fascia sweeps below use, so the exclusion volume
    // is the geometry rather than an estimate of it.
    const outer = st.hw + CROSS.kerbW + Math.max(st.shL, st.shR)
      + (arch ? 0.6 : 0.4);
    // The bore's ellipse is centred on the springing line, which sits a crown
    // plus a shoulder drop below the centreline.
    const lift = arch ? -CROSS.crown - CROSS.shoulderDrop : 0;
    roadVolumes.list.push({
      kind,
      px: st.pos.x + st.nrm.x * lift,
      py: st.pos.y + st.nrm.y * lift,
      pz: st.pos.z + st.nrm.z * lift,
      tx: st.tan.x, ty: st.tan.y, tz: st.tan.z,
      bx: st.bin.x, by: st.bin.y, bz: st.bin.z,
      nx: st.nrm.x, ny: st.nrm.y, nz: st.nrm.z,
      lat: outer,
      up: arch ? CROSS.tunnelH : 6.5,
      down: arch ? 1.2 : CROSS.deckDepth + 0.6,
      arch,
    });
  };

  // ---- helper: ambient occlusion + dirt for a lateral position ------------
  const shadeRoad = (st: Station, lat: number, out: THREE.Color): void => {
    const u = Math.abs(lat) / Math.max(1e-3, st.hw);
    // Dirt washed toward the edges. `verge` is a *multiplier* on the asphalt
    // albedo, so this must read as the road getting darker and dustier at the
    // edge — never as a sand colour being painted onto the drivable ribbon.
    // Keep the reach short (outer quarter only) and the amplitude low: over a
    // 22 m road, 0.38 of the half width is 4 m of tinted asphalt per side,
    // which at speed reads as the whole road having changed colour.
    const dirt = Math.pow(clamp01((u - 0.74) / 0.26), 2) * 0.3;
    // contact occlusion where the road meets the kerb
    const ao = 1 - Math.pow(clamp01((u - 0.78) / 0.22), 2.2) * 0.28 * def.road.ao;
    out.setRGB(
      (1 - dirt) * ao + verge.r * dirt * ao,
      (1 - dirt) * ao + verge.g * dirt * ao,
      (1 - dirt) * ao + verge.b * dirt * ao,
    );
    const dk = 1 - st.dark * 0.66;
    out.multiplyScalar(dk);
  };

  const tmpCol = new THREE.Color();
  const wetNoise = (d: number, lat: number) =>
    clamp01(0.35 + 0.65 * Math.abs(Math.sin(d * 0.11 + lat * 0.31) * Math.cos(d * 0.037 - lat * 0.13)));

  // =========================================================================
  //  Sweep
  // =========================================================================
  for (let i = 0; i < n; i++) {
    const st = stations[i];
    const nextIsGap = gapAt((i + 1) % n);
    const thisIsGap = gapAt(i);
    const stitch = !thisIsGap && !nextIsGap ? true : false;
    const d = st.d;
    const v2 = d / L;
    publishVolume(st);

    // ---------------- road ribbon ----------------
    const roadRing: number[] = [];
    for (const t of roadParam) {
      const lat = t * st.hw;
      const sh = lat < 0 ? st.shL : st.shR;
      const noKerb = kerbSuppressed(st.flags, lat < 0 ? -1 : 1);
      const h = surfaceHeight(lat, st.hw, sh, d, noKerb);
      _v.copy(st.pos).addScaledVector(st.bin, lat).addScaledVector(st.nrm, h);
      const dl = surfaceSlopeLat(lat, st.hw, sh, d, noKerb);
      _n2.copy(st.nrm).addScaledVector(st.bin, -dl).normalize();
      shadeRoad(st, lat, tmpCol);
      // two tyre tracks either side of the ideal line
      const off = Math.abs(lat - st.line);
      const trackA = Math.exp(-Math.pow((off - 0.85) / 2.35, 2));
      const trackB = Math.exp(-Math.pow((off + 0.85) / 2.35, 2));
      const polish = clamp01(Math.max(trackA, trackB) * 1.05);
      const wet = st.flags & TF.Wet ? wetNoise(d, lat) : 0;
      roadRing.push(
        road.vertex(
          _v, _n2,
          lat / CROSS.roadTile, d / CROSS.roadTile,
          0.5 + lat / (st.hw * 2), v2,
          tmpCol.r, tmpCol.g, tmpCol.b,
          polish, wet, 0,
        ),
      );
    }
    if (prevRoadRing && stitch) {
      for (let k = 0; k < ROAD_SPANS; k++) {
        road.quad(prevRoadRing[k], prevRoadRing[k + 1], roadRing[k + 1], roadRing[k]);
      }
    }
    prevRoadRing = roadRing;

    // ---------------- kerbs ----------------
    const kerbRings: [number[], number[]] = [[], []];
    for (const side of [-1, 1] as const) {
      const si = side < 0 ? 0 : 1;
      const sh = side < 0 ? st.shL : st.shR;
      if (kerbSuppressed(st.flags, side)) continue;
      for (const t of kerbParam) {
        const lat = side * (st.hw + t * CROSS.kerbW);
        const h = surfaceHeight(lat, st.hw, sh, d, false);
        _v.copy(st.pos).addScaledVector(st.bin, lat).addScaledVector(st.nrm, h);
        const dl = surfaceSlopeLat(lat, st.hw, sh, d, false);
        const dz = surfaceSlopeLong(lat, st.hw, sh, d, false);
        _n2.copy(st.nrm).addScaledVector(st.bin, -dl).addScaledVector(st.tan, -dz).normalize();
        // valley AO at both chamfers, brightest on the top
        const ao = (0.72 + 0.28 * smoothstep(t / 0.3) * smoothstep((1 - t) / 0.28)) * (1 - st.dark * 0.6);
        kerbRings[si].push(
          kerb.vertex(
            _v, _n2,
            t, d / (CROSS.stripe * 2),
            0.5 + lat / (st.hw * 2), v2,
            ao, ao, ao,
          ),
        );
      }
    }
    if (prevKerbRing && stitch) {
      for (const si of [0, 1]) {
        const a = prevKerbRing[si];
        const b = kerbRings[si];
        if (a.length === kerbParam.length && b.length === kerbParam.length) {
          for (let k = 0; k < kerbParam.length - 1; k++) {
            if (si === 0) kerb.quad(a[k], b[k], b[k + 1], a[k + 1]);
            else kerb.quad(a[k], a[k + 1], b[k + 1], b[k]);
          }
        }
      }
    }
    prevKerbRing = kerbRings;

    // ---------------- shoulders ----------------
    const shSurf = OFFROAD_LOOKUP.includes(st.shoulderSurface) ? st.shoulderSurface : SurfaceType.Dirt;
    const shStrip = stripFor(shoulders, shSurf);
    let shPrev = prevShoulderRing.get(shSurf) ?? null;
    const shRings: [number[], number[]] = [[], []];
    for (const side of [-1, 1] as const) {
      const si = side < 0 ? 0 : 1;
      const sh = side < 0 ? st.shL : st.shR;
      if (sh < 0.35 || thisIsGap) continue;
      const kw = kerbSuppressed(st.flags, side) ? 0 : CROSS.kerbW;
      for (const t of shoulderParam) {
        const lat = side * (st.hw + kw + t * sh);
        const h = surfaceHeight(lat, st.hw, sh, d, kw === 0);
        _v.copy(st.pos).addScaledVector(st.bin, lat).addScaledVector(st.nrm, h);
        const dl = surfaceSlopeLat(lat, st.hw, sh, d, kw === 0);
        _n2.copy(st.nrm).addScaledVector(st.bin, -dl).normalize();
        // darker in the crease against the kerb and against the wall
        const ao = (0.68 + 0.32 * smoothstep(t / 0.35) * smoothstep((1 - t) / 0.3)) * (1 - st.dark * 0.6);
        shRings[si].push(
          shStrip.vertex(
            _v, _n2,
            lat * 0.22, d * 0.22,
            0.5 + lat / (st.hw * 2), v2,
            ao, ao, ao,
          ),
        );
      }
    }
    if (shPrev) {
      for (const si of [0, 1]) {
        const a = shPrev[si];
        const b = shRings[si];
        if (a.length === shoulderParam.length && b.length === shoulderParam.length) {
          for (let k = 0; k < shoulderParam.length - 1; k++) {
            if (si === 0) shStrip.quad(a[k], b[k], b[k + 1], a[k + 1]);
            else shStrip.quad(a[k], a[k + 1], b[k + 1], b[k]);
          }
        }
      }
    }
    prevShoulderRing.set(shSurf, shRings);
    // any other surface's cached ring is now stale
    for (const key of prevShoulderRing.keys()) {
      if (key !== shSurf) prevShoulderRing.delete(key);
    }

    // ---------------- walls ----------------
    for (const side of [-1, 1] as const) {
      const style = side < 0 ? st.wallL : st.wallR;
      if (style === 'none' || thisIsGap) continue;
      const si = side < 0 ? 0 : 1;
      const wStrip = stripFor(walls, style);
      let cache = prevWallRing.get(style);
      if (!cache) { cache = [[], []]; prevWallRing.set(style, cache); }

      const sh = side < 0 ? st.shL : st.shR;
      const kw = kerbSuppressed(st.flags, side) ? 0 : CROSS.kerbW;
      const lat = side * (st.hw + kw + sh + 0.12);
      const baseH = surfaceHeight(lat, st.hw, sh, d, kw === 0);
      const height = wallHeight(style);
      const prof = wallProfile(style);

      const ring: number[] = [];
      for (const pr of prof) {
        const outLat = lat + side * pr.o;
        _v.copy(st.pos)
          .addScaledVector(st.bin, outLat)
          .addScaledVector(st.nrm, baseH + pr.h * height);
        if (style === 'rock') {
          // Break the rock face up so it does not read as extruded card.
          const wob = (Math.sin(d * 0.21 + pr.h * 5.1) + Math.sin(d * 0.073 - pr.h * 2.3)) * 0.5;
          _v.addScaledVector(st.bin, side * wob * (0.5 + pr.h * 1.6));
          _v.addScaledVector(st.nrm, Math.sin(d * 0.13 + pr.h * 3.7) * 0.3 * pr.h);
        }
        _n2.copy(st.bin).multiplyScalar(-side * pr.nx).addScaledVector(st.nrm, pr.ny).normalize();
        const ao = (0.55 + 0.45 * clamp01(pr.h * 1.6)) * (1 - st.dark * 0.5);
        ring.push(
          wStrip.vertex(
            _v, _n2,
            d * 0.12, pr.h,
            0.5 + outLat / (st.hw * 2), v2,
            ao, ao, ao,
          ),
        );
      }
      const a = cache[si];
      if (a.length === prof.length && ring.length === prof.length) {
        for (let k = 0; k < prof.length - 1; k++) {
          if (si === 0) wStrip.quad(a[k], a[k + 1], ring[k + 1], ring[k]);
          else wStrip.quad(a[k], ring[k], ring[k + 1], a[k + 1]);
        }
      }
      cache[si] = ring;

      // instanced posts for guardrails and fences
      if ((style === 'guardrail' || style === 'fence') && i % postStride(style, low) === 0) {
        _v.copy(st.pos).addScaledVector(st.bin, lat).addScaledVector(st.nrm, baseH);
        _n2.copy(st.nrm);
        _q.setFromUnitVectors(_up, _n2);
        _sc.set(1, height / CROSS.railH, 1);
        postXf.push(new THREE.Matrix4().compose(_v.clone(), _q.clone(), _sc.clone()));
      }
    }

    // ---------------- tunnel arch ----------------
    if (st.flags & TF.Tunnel) {
      const outer = st.hw + CROSS.kerbW + Math.max(st.shL, st.shR) + 0.6;
      const ring: number[] = [];
      const SEG = low ? 8 : 13;
      for (let k = 0; k <= SEG; k++) {
        const a = (k / SEG) * Math.PI;
        const lat = -Math.cos(a) * outer;
        const hh = Math.sin(a) * CROSS.tunnelH - CROSS.crown - CROSS.shoulderDrop;
        _v.copy(st.pos).addScaledVector(st.bin, lat).addScaledVector(st.nrm, hh);
        _n2.copy(st.bin).multiplyScalar(Math.cos(a)).addScaledVector(st.nrm, -Math.sin(a));
        // ribbed lining
        const rib = 0.14 * Math.sin(d * 1.1) * Math.sin(a);
        _v.addScaledVector(_n2, rib);
        const ao = (0.2 + 0.55 * Math.pow(Math.sin(a), 0.6)) * (1 - st.dark * 0.55);
        ring.push(tunnel.vertex(_v, _n2, d * 0.1, k / SEG, 0.5 + lat / (st.hw * 2), v2, ao, ao, ao));
      }
      if (prevTunnelRing && prevTunnelRing.length === ring.length) {
        for (let k = 0; k < SEG; k++) {
          tunnel.quad(prevTunnelRing[k], prevTunnelRing[k + 1], ring[k + 1], ring[k]);
        }
      }
      prevTunnelRing = ring;
    } else {
      prevTunnelRing = null;
    }

    // ---------------- bridge fascia / deck underside ----------------
    if (st.flags & TF.Bridge && !thisIsGap) {
      const ring: [number[], number[]] = [[], []];
      for (const side of [-1, 1] as const) {
        const si = side < 0 ? 0 : 1;
        const sh = side < 0 ? st.shL : st.shR;
        const kw = kerbSuppressed(st.flags, side) ? 0 : CROSS.kerbW;
        const lat = side * (st.hw + kw + sh + 0.1);
        const top = surfaceHeight(lat, st.hw, sh, d, kw === 0);
        for (const step of [0, 0.35, 1]) {
          const inset = step * 0.55;
          _v.copy(st.pos)
            .addScaledVector(st.bin, lat - side * inset)
            .addScaledVector(st.nrm, top - step * CROSS.deckDepth);
          _n2.copy(st.bin).multiplyScalar(side * (1 - step)).addScaledVector(st.nrm, -step).normalize();
          const ao = 0.34 + 0.5 * (1 - step);
          ring[si].push(deck.vertex(_v, _n2, d * 0.16, step, 0.5, v2, ao, ao, ao));
        }
      }
      // flat soffit between the two sides
      if (prevDeckRing) {
        for (const si of [0, 1]) {
          const a = prevDeckRing[si];
          const b = ring[si];
          if (a.length === 3 && b.length === 3) {
            for (let k = 0; k < 2; k++) {
              if (si === 0) deck.quad(a[k], a[k + 1], b[k + 1], b[k]);
              else deck.quad(a[k], b[k], b[k + 1], a[k + 1]);
            }
          }
        }
        const a0 = prevDeckRing[0][2];
        const a1 = prevDeckRing[1][2];
        const b0 = ring[0][2];
        const b1 = ring[1][2];
        if (a0 !== undefined && a1 !== undefined && b0 !== undefined && b1 !== undefined) {
          deck.quad(a0, b0, b1, a1);
        }
      }
      prevDeckRing = ring;
    } else {
      prevDeckRing = null;
    }
  }

  // close the loop on the road ribbon
  if (prevRoadRing && !gapAt(n - 1) && !gapAt(0)) {
    const first: number[] = [];
    for (let k = 0; k <= ROAD_SPANS; k++) first.push(k);
    for (let k = 0; k < ROAD_SPANS; k++) {
      road.quad(prevRoadRing[k], prevRoadRing[k + 1], first[k + 1], first[k]);
    }
  }

  // =========================================================================
  //  Meshes
  // =========================================================================
  let drawCalls = 0;
  let vertices = 0;
  let triangles = 0;

  const push = (
    strip: Strip,
    mat: THREE.Material,
    name: string,
    opts: { uv2?: boolean; mask?: boolean; shadow?: boolean; order?: number } = {},
  ): THREE.Mesh | null => {
    if (strip.empty) return null;
    const g = strip.toGeometry(opts.uv2 === true, opts.mask === true);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.castShadow = opts.shadow ?? false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    if (opts.order !== undefined) mesh.renderOrder = opts.order;
    group.add(mesh);
    disposables.push(g);
    drawCalls++;
    vertices += strip.vcount;
    triangles += strip.idx.length / 3;
    return mesh;
  };

  push(road, mats.road, 'roadSurface', { uv2: true, mask: true, order: 10 });
  push(kerb, mats.kerb, 'roadKerbs', { shadow: true, order: 11 });
  for (const [surf, strip] of shoulders) {
    const m = mats.shoulder.get(surf) ?? mats.shoulder.get(SurfaceType.Dirt)!;
    push(strip, m, `roadShoulder_${SurfaceType[surf]}`, { order: 5 });
  }
  for (const [style, strip] of walls) {
    const m = mats.wall.get(style);
    if (!m) continue;
    push(strip, m, `trackWall_${style}`, { shadow: style !== 'fence', order: 12 });
  }
  push(tunnel, mats.tunnel, 'trackTunnel', { shadow: true, order: 4 });
  push(deck, mats.deck, 'trackDeck', { shadow: true, order: 4 });

  // ---- instanced guardrail posts ------------------------------------------
  if (postXf.length > 0) {
    const postGeo = makePostGeometry();
    const posts = new THREE.InstancedMesh(postGeo, mats.rail, postXf.length);
    for (let i = 0; i < postXf.length; i++) posts.setMatrixAt(i, postXf[i]);
    posts.instanceMatrix.needsUpdate = true;
    posts.name = 'guardrailPosts';
    posts.castShadow = true;
    posts.receiveShadow = true;
    posts.frustumCulled = false;
    group.add(posts);
    disposables.push(postGeo);
    drawCalls++;
    vertices += postGeo.attributes.position.count * postXf.length;
    triangles += ((postGeo.getIndex()?.count ?? 0) / 3) * postXf.length;
  }

  // ---- boost pads ----------------------------------------------------------
  /**
   * Largest gap-free sub-range of [a, b], in metres of arc length, or null when
   * the whole span is over a jump.
   *
   * Authoring guard. The coastal cove pad used to be authored 2 m past the jump
   * lip: 13 m of an 18 m strip was extruded at a road height that does not exist
   * there, so it hung in mid-air over the water and the boost that makes the jump
   * clearable was uncollectable. Rather than trust the numbers, trim.
   */
  const gapFreeSpan = (a: number, b: number): [number, number] | null => {
    const probe = makeAttribs();
    let bestA = 0;
    let bestB = -1;
    let runA = NaN;
    for (let d = a; d <= b + 1e-6; d += 0.5) {
      spline.attribsAtDistance(d, probe);
      if (probe.flags & TF.Gap) { runA = NaN; continue; }
      if (Number.isNaN(runA)) runA = d;
      if (d - runA > bestB - bestA) { bestA = runA; bestB = d; }
    }
    return bestB > bestA ? [bestA, bestB] : null;
  };

  const boostPads: BuiltTrack['boostPads'] = [];
  const padStrip = new Strip();
  for (const pad of def.boostPads) {
    const span = gapFreeSpan(pad.t * L - pad.length * 0.5, pad.t * L + pad.length * 0.5);
    if (!span || span[1] - span[0] < pad.length * 0.4) {
      console.warn(
        `[Track] boost pad at t=${pad.t} on ${def.id} sits over a TF.Gap — skipped. ` +
        'Move it onto the ramp.',
      );
      continue;
    }
    const d0 = (span[0] + span[1]) * 0.5;
    const hl = (span[1] - span[0]) * 0.5;
    spline.attribsAtDistance(d0, _at);
    // Never wider than the asphalt: a pad overhanging the kerb reads as a bug.
    const hwid = Math.min(pad.width * 0.5, Math.max(1.5, _at.halfWidth - Math.abs(pad.lat) - 0.4));
    const SEGS = 6;
    const rings: number[][] = [];
    for (let s2 = 0; s2 <= SEGS; s2++) {
      const dd = d0 - hl + (hl * 2 * s2) / SEGS;
      const r: number[] = [];
      for (const lt of [-1, -0.34, 0.34, 1]) {
        roadSurfacePoint(spline, dd, pad.lat + lt * hwid, _v, _n2);
        _v.addScaledVector(_n2, 0.02);
        r.push(padStrip.vertex(_v, _n2, (lt + 1) * 0.5, s2 / SEGS, 0, 0, 1, 1, 1));
      }
      rings.push(r);
    }
    for (let s2 = 0; s2 < SEGS; s2++) {
      for (let k = 0; k < 3; k++) {
        padStrip.quad(rings[s2][k], rings[s2][k + 1], rings[s2 + 1][k + 1], rings[s2 + 1][k]);
      }
    }
    roadSurfacePoint(spline, d0, pad.lat, _v, _n2);
    spline.sampleAtDistance(d0, _s);
    _m.makeBasis(_s.binormal, _n2, _s.tangent.clone().negate());
    boostPads.push({
      position: _v.clone(),
      quaternion: new THREE.Quaternion().setFromRotationMatrix(_m),
      // The width actually drawn, not the authored one — VFX sizes its chevron
      // glow off this and must match the strip after any clamping above.
      width: hwid * 2,
    });
  }
  const padMesh = push(padStrip, mats.boost, 'boostPads', { order: 21 });
  if (padMesh) padMesh.receiveShadow = false;

  // ---- item box spawns ----------------------------------------------------
  /**
   * A tidy row straight across the road, every box at the same height above the
   * surface, on the surface's own normal so a banked row leans with the road.
   *
   * Rules enforced here rather than trusted to the author:
   *  - the row is nudged off any `TF.Gap` segment (a box floating over a jump is
   *    uncollectable and reads as a bug),
   *  - the row never starts inside the starting grid, which occupies the last
   *    ~60 m of the lap: a box there sits among the karts on the grid,
   *  - the spread is clamped to the asphalt so no box hangs over the kerb,
   *  - a single-box row is offset off the centreline rather than dropped on the
   *    racing line.
   */
  const gridStart = L - START_GRID_LENGTH;
  const itemBoxSpawns: BuiltTrack['itemBoxSpawns'] = [];
  for (const row of def.itemRows) {
    let d0 = wrap01(row.t) * L;
    // Keep clear of the grid (behind the line) and of the line itself: a row in
    // either place stands among twelve stationary karts.
    const legal = clamp(d0, 40, Math.max(40, gridStart - 10));
    if (legal !== d0) {
      console.warn(
        `[Track] item row at t=${row.t} on ${def.id} lands in the starting grid — ` +
        `moved to t=${(legal / L).toFixed(3)}.`,
      );
      d0 = legal;
    }
    const clear = gapFreeSpan(Math.max(0, d0 - 14), Math.min(L, d0 + 14));
    if (clear) d0 = clamp(d0, clear[0] + 2, Math.max(clear[0] + 2, clear[1] - 2));
    spline.sampleAtDistance(d0, _s);
    spline.attribsAtDistance(_s.distance, _at);
    const usable = Math.max(4, (_at.halfWidth - ITEM_BOX_EDGE) * 2);
    const spread = Math.min(row.spread ?? usable, usable);
    for (let k = 0; k < row.count; k++) {
      const lat = row.count === 1
        ? Math.min(2.5, _at.halfWidth * 0.25)
        : ((k / (row.count - 1)) - 0.5) * spread;
      roadSurfacePoint(spline, d0, lat, _v, _n2);
      _v.addScaledVector(_n2, ITEM_BOX_HEIGHT);
      _m.makeBasis(_s.binormal, _n2, _s.tangent.clone().negate());
      itemBoxSpawns.push({
        position: _v.clone(),
        quaternion: new THREE.Quaternion().setFromRotationMatrix(_m),
        // ItemSystem reads `normal`/`up` off each spawn to stand the box on the
        // road's own up axis; without it every box defaults to world +Y and
        // leans wrongly on banked road and inside the anti-gravity sections.
        normal: _n2.clone(),
      });
    }
  }

  // =========================================================================
  //  Simplified collision mesh + BVH
  // =========================================================================
  const colGeo = buildCollisionGeometry(spline, stations);
  const bvh = new MeshBVH(colGeo, { maxLeafTris: 8 });
  // three-mesh-bvh's accelerated raycast reads this off the geometry.
  (colGeo as THREE.BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = bvh;
  const colMat = new THREE.MeshBasicMaterial({ color: 0x22ff88, wireframe: true, visible: false });
  const collisionMesh = new THREE.Mesh(colGeo, colMat);
  collisionMesh.name = 'trackCollision';
  collisionMesh.visible = false;
  collisionMesh.matrixAutoUpdate = false;
  collisionMesh.updateMatrixWorld(true);
  disposables.push(colGeo, colMat);

  // =========================================================================
  //  Racing line LUT + minimap outline
  // =========================================================================
  const rlStep = 2;
  const rlN = Math.max(8, Math.ceil(L / rlStep));
  const racingLine = new Float32Array(rlN + 1);
  {
    // resample the per-station line onto a uniform arc-length grid
    let cursor = 0;
    for (let i = 0; i <= rlN; i++) {
      const d = Math.min(L - 1e-4, i * rlStep);
      while (cursor < n - 1 && stations[cursor + 1].d <= d) cursor++;
      const a = stations[cursor];
      const b = stations[Math.min(n - 1, cursor + 1)];
      const span = Math.max(1e-4, b.d - a.d);
      const f = clamp01((d - a.d) / span);
      racingLine[i] = a.line + (b.line - a.line) * f;
    }
  }

  const minimapPath: THREE.Vector2[] = [];
  {
    const box = new THREE.Box2();
    const pts: THREE.Vector2[] = [];
    const STEPS = 220;
    for (let i = 0; i < STEPS; i++) {
      spline.sampleAtDistance((i / STEPS) * L, _s);
      const p = new THREE.Vector2(_s.position.x, _s.position.z);
      pts.push(p);
      box.expandByPoint(p);
    }
    const sx = Math.max(1e-3, box.max.x - box.min.x);
    const sz = Math.max(1e-3, box.max.y - box.min.y);
    const scale = 1 / Math.max(sx, sz);
    const ox = (1 - sx * scale) * 0.5;
    const oz = (1 - sz * scale) * 0.5;
    for (const p of pts) {
      minimapPath.push(new THREE.Vector2(
        (p.x - box.min.x) * scale + ox,
        (p.y - box.min.y) * scale + oz,
      ));
    }
  }

  void decalStain;
  void rng;

  const ms = performance.now() - t0;

  return {
    roadGroup: group,
    collisionMesh,
    bvh,
    stations,
    racingLine,
    rlStep,
    minimapPath,
    boostPads,
    itemBoxSpawns,
    stats: { rings: n, vertices, triangles, drawCalls, ms },
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      group.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Wall profiles — (lateral offset, height fraction, normal)
// ---------------------------------------------------------------------------

interface ProfilePoint { o: number; h: number; nx: number; ny: number }

const PROFILES: Record<WallStyle, ProfilePoint[]> = {
  none: [],
  // W-section beam on a short post: two corrugations so it catches highlights
  guardrail: [
    { o: 0.0, h: 0.0, nx: 1, ny: 0.2 },
    { o: 0.0, h: 0.42, nx: 1, ny: 0 },
    { o: -0.13, h: 0.6, nx: 0.75, ny: 0.65 },
    { o: 0.02, h: 0.78, nx: 1, ny: 0.1 },
    { o: -0.13, h: 0.95, nx: 0.7, ny: -0.7 },
    { o: 0.0, h: 1.0, nx: 0.4, ny: 0.92 },
  ],
  // Jersey barrier: kick, slope, vertical, capped
  concrete: [
    { o: 0.0, h: 0.0, nx: 1, ny: 0.1 },
    { o: -0.05, h: 0.13, nx: 0.92, ny: 0.38 },
    { o: -0.22, h: 0.55, nx: 0.85, ny: 0.5 },
    { o: -0.28, h: 0.92, nx: 1, ny: 0.05 },
    { o: -0.36, h: 1.0, nx: 0.5, ny: 0.86 },
  ],
  energy: [
    { o: 0.0, h: 0.0, nx: 1, ny: 0.2 },
    { o: -0.04, h: 0.35, nx: 1, ny: 0 },
    { o: -0.04, h: 0.8, nx: 1, ny: 0 },
    { o: -0.1, h: 1.0, nx: 0.6, ny: 0.8 },
  ],
  building: [
    { o: 0.0, h: 0.0, nx: 1, ny: 0.05 },
    { o: -0.08, h: 0.06, nx: 1, ny: 0.2 },
    { o: -0.1, h: 0.5, nx: 1, ny: 0 },
    { o: -0.1, h: 1.0, nx: 1, ny: 0 },
  ],
  rock: [
    { o: 0.0, h: 0.0, nx: 1, ny: 0.1 },
    { o: -0.5, h: 0.18, nx: 0.9, ny: 0.3 },
    { o: -1.2, h: 0.45, nx: 0.95, ny: 0.15 },
    { o: -1.6, h: 0.72, nx: 0.9, ny: 0.3 },
    { o: -2.4, h: 1.0, nx: 0.7, ny: 0.6 },
  ],
  fence: [
    { o: 0.0, h: 0.0, nx: 1, ny: 0 },
    { o: 0.0, h: 0.5, nx: 1, ny: 0 },
    { o: 0.0, h: 1.0, nx: 1, ny: 0 },
  ],
  wood: [
    { o: 0.0, h: 0.0, nx: 1, ny: 0.2 },
    { o: 0.0, h: 0.34, nx: 1, ny: 0 },
    { o: -0.06, h: 0.62, nx: 1, ny: 0.1 },
    { o: -0.06, h: 1.0, nx: 0.5, ny: 0.86 },
  ],
};

function wallProfile(style: WallStyle): ProfilePoint[] {
  return PROFILES[style] ?? PROFILES.guardrail;
}

/** Collision + visual height of each wall style, metres. */
export function wallHeight(style: WallStyle): number {
  switch (style) {
    case 'guardrail': return CROSS.railH;
    case 'concrete': return CROSS.concreteH;
    case 'rock': return CROSS.rockH;
    case 'building': return CROSS.buildingH;
    case 'fence': return CROSS.fenceH;
    case 'energy': return CROSS.energyH;
    case 'wood': return CROSS.woodH;
    default: return 0;
  }
}

function postStride(style: WallStyle, low: boolean): number {
  const base = style === 'fence' ? 5 : 3;
  return low ? base * 2 : base;
}

/** Chamfered I-post for the instanced guardrail supports. */
function makePostGeometry(): THREE.BufferGeometry {
  const w = 0.11;
  const t = 0.05;
  const h = CROSS.railH;
  const shape = new THREE.Shape();
  shape.moveTo(-w, -t);
  shape.lineTo(-t * 0.6, -t);
  shape.lineTo(-t * 0.6, t);
  shape.lineTo(-w, t);
  shape.lineTo(-w, t + 0.02);
  shape.lineTo(w, t + 0.02);
  shape.lineTo(w, t);
  shape.lineTo(t * 0.6, t);
  shape.lineTo(t * 0.6, -t);
  shape.lineTo(w, -t);
  shape.lineTo(w, -t - 0.02);
  shape.lineTo(-w, -t - 0.02);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 1, steps: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, 0);
  return g;
}

// ---------------------------------------------------------------------------
// Simplified collision mesh
// ---------------------------------------------------------------------------

/**
 * A much coarser version of the drivable surface plus flat wall quads. The
 * analytic ground probe is the fast path; this exists so the BVH can answer
 * arbitrary rays (item shells, camera occlusion, anything not straight down)
 * and so other subsystems have something concrete to test against.
 */
function buildCollisionGeometry(spline: TrackSpline, stations: Station[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const L = spline.length;
  const STEP = 3.0;
  const N = Math.max(8, Math.round(L / STEP));
  const lateral = [-1, -0.55, 0, 0.55, 1];

  const addV = (p: THREE.Vector3) => {
    pos.push(p.x, p.y, p.z);
    return pos.length / 3 - 1;
  };

  let prev: number[] | null = null;
  let prevOuter: [number[], number[]] | null = null;
  let firstRing: number[] | null = null;
  const cache = makeAttribs();

  for (let i = 0; i <= N; i++) {
    const d = (i / N) * L;
    spline.sampleAtDistance(d % L, _s);
    spline.attribsAtDistance(_s.distance, cache);
    const isGap = (cache.flags & TF.Gap) !== 0;
    const hw = cache.halfWidth;
    const ring: number[] = [];
    if (!isGap) {
      // drivable band = asphalt + kerb + shoulder
      const full: number[] = [];
      for (const t of lateral) {
        const lat = t * hw;
        const sh = lat < 0 ? cache.shoulderL : cache.shoulderR;
        const noKerb = kerbSuppressed(cache.flags, lat < 0 ? -1 : 1);
        const h = surfaceHeight(lat, hw, sh, _s.distance, noKerb);
        _v.copy(_s.position).addScaledVector(_s.binormal, lat).addScaledVector(_s.normal, h);
        full.push(addV(_v));
      }
      // outer edges (kerb outer + shoulder outer)
      for (const side of [-1, 1] as const) {
        const sh = side < 0 ? cache.shoulderL : cache.shoulderR;
        const kw = kerbSuppressed(cache.flags, side) ? 0 : CROSS.kerbW;
        for (const extra of [kw, kw + sh]) {
          const lat = side * (hw + extra);
          const h = surfaceHeight(lat, hw, sh, _s.distance, kw === 0);
          _v.copy(_s.position).addScaledVector(_s.binormal, lat).addScaledVector(_s.normal, h);
          if (side < 0) full.unshift(addV(_v));
          else full.push(addV(_v));
        }
      }
      ring.push(...full);
    }

    if (prev && ring.length === prev.length && ring.length > 1) {
      for (let k = 0; k < ring.length - 1; k++) {
        idx.push(prev[k], prev[k + 1], ring[k + 1], prev[k], ring[k + 1], ring[k]);
      }
    }
    if (i === 0) firstRing = ring;
    prev = ring.length ? ring : null;

    // walls as single quads per side
    const outer: [number[], number[]] = [[], []];
    if (!isGap) {
      for (const side of [-1, 1] as const) {
        const style = side < 0 ? cache.wallL : cache.wallR;
        if (style === 'none') continue;
        const sh = side < 0 ? cache.shoulderL : cache.shoulderR;
        const kw = kerbSuppressed(cache.flags, side) ? 0 : CROSS.kerbW;
        const lat = side * (hw + kw + sh + 0.12);
        const base = surfaceHeight(lat, hw, sh, _s.distance, kw === 0);
        const hgt = Math.min(3.2, wallHeight(style));
        _v.copy(_s.position).addScaledVector(_s.binormal, lat).addScaledVector(_s.normal, base);
        const a = addV(_v);
        _v.addScaledVector(_s.normal, hgt);
        const b = addV(_v);
        outer[side < 0 ? 0 : 1] = [a, b];
      }
    }
    if (prevOuter) {
      for (const si of [0, 1]) {
        const a = prevOuter[si];
        const b = outer[si];
        if (a.length === 2 && b.length === 2) {
          if (si === 0) idx.push(a[0], a[1], b[1], a[0], b[1], b[0]);
          else idx.push(a[0], b[0], b[1], a[0], b[1], a[1]);
        }
      }
    }
    prevOuter = outer;
  }

  // stitch the last ring back to the first
  if (prev && firstRing && prev.length === firstRing.length && prev.length > 1) {
    for (let k = 0; k < prev.length - 1; k++) {
      idx.push(prev[k], prev[k + 1], firstRing[k + 1], prev[k], firstRing[k + 1], firstRing[k]);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(pos.length / 3 > 65535
    ? new THREE.Uint32BufferAttribute(idx, 1)
    : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
