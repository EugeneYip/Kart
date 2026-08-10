/**
 * ============================================================================
 *  APEX KART — CHASSIS GEOMETRY
 * ============================================================================
 *  Six genuinely different silhouettes, all authored in code.
 *
 *  CONSTRUCTION RULES (these are what separate this from boxes-and-cylinders):
 *   1. Nothing is a `BoxGeometry`. Volumes come from `loft()` (a swept chain of
 *      super-elliptical cross sections) or `superShape()` (a superellipsoid).
 *      Both have an intrinsic chamfer controlled by their exponents.
 *   2. Every merged group goes through `smoothNormals()`, which welds by
 *      position, clusters incident faces by crease angle and *splits* vertices
 *      where the crease is real. `computeVertexNormals()` cannot do this.
 *   3. Ambient occlusion is baked into the vertex colour by raycasting a
 *      cosine hemisphere per unique position against a BVH of the whole kart.
 *      This is the single biggest "it looks authored" win available offline.
 *   4. Author space has **ground at y = 0** and the kart facing **-Z**. The
 *      whole rig is translated down by `frame.groundY` at the end so it lines
 *      up with the physics origin.
 * ============================================================================
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import type { KartTuning, QualitySettings } from '@/core/Types';
import { WORLD } from '@/core/Config';
import type { MaterialSlot, KartMaterialSet } from './KartMaterials';
import { atlasUv } from './KartMaterials';

export const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Frame — every dimension the body builders are allowed to depend on
// ---------------------------------------------------------------------------

export interface KartFrame {
  wheelRadius: number;
  wheelWidth: number;
  trackHalfFront: number;
  trackHalfRear: number;
  frontZ: number;
  rearZ: number;
  /** Suspension attachment height in kart-local space. */
  hubY: number;
  restLen: number;
  travel: number;
  /** Spring length at static ride height. */
  staticLen: number;
  /** Kart-local Y of the ground plane when parked (negative). */
  groundY: number;
  halfWidth: number;
  halfLength: number;
  /** 0..1 heaviness, drives proportions. */
  weight: number;
}

export function frameFromTuning(t: KartTuning): KartFrame {
  const fo = t.wheelOffsets;
  const staticSag = Math.min(
    t.suspensionTravel * 0.9,
    (t.mass * WORLD.gravity) / (4 * Math.max(1, t.suspensionStiffness)),
  );
  const staticLen = t.suspensionRest - staticSag;
  const hubY = fo[0].y;
  return {
    wheelRadius: t.wheelRadius,
    wheelWidth: 0.24 + t.weight * 0.08,
    trackHalfFront: Math.abs(fo[0].x),
    trackHalfRear: Math.abs(fo[2].x),
    frontZ: fo[0].z,
    rearZ: fo[2].z,
    hubY,
    restLen: t.suspensionRest,
    travel: t.suspensionTravel,
    staticLen,
    groundY: hubY - staticLen - t.wheelRadius,
    halfWidth: t.halfExtents.x,
    halfLength: t.halfExtents.z,
    weight: t.weight,
  };
}

// ===========================================================================
//  GEOMETRY HELPERS
// ===========================================================================

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _nA = new THREE.Vector3();
const _nB = new THREE.Vector3();
const _ray = new THREE.Ray();

// ---------------------------------------------------------------------------
// Global tessellation dial
// ---------------------------------------------------------------------------

/**
 * Every primitive below runs its segment counts through `segs()`. The body
 * builders therefore author in "ideal" density and one call to
 * `setSegmentScale()` re-tessellates the entire kart for a quality tier —
 * which is the only sane way to hit a triangle budget across ~2000 lines of
 * hand-authored parts.
 */
let SEGMENT_SCALE = 1;

export function setSegmentScale(s: number): void {
  SEGMENT_SCALE = s < 0.3 ? 0.3 : s > 1.5 ? 1.5 : s;
}

export function getSegmentScale(): number { return SEGMENT_SCALE; }

/** Scale a segment count, never below `min` (keeps hex nuts hexagonal). */
export function segs(n: number, min = 6): number {
  const v = Math.round(n * SEGMENT_SCALE);
  return v < min ? Math.min(n, min) : v;
}

/** Give a geometry the full attribute set so it can be merged with any other. */
export function prepGeometry(g: THREE.BufferGeometry, tint?: THREE.Color): THREE.BufferGeometry {
  if (!g.index) {
    const count = g.attributes.position.count;
    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const n = g.attributes.position.count;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!g.attributes.color) {
    const c = new Float32Array(n * 3);
    const r = tint ? tint.r : 1, gg = tint ? tint.g : 1, b = tint ? tint.b : 1;
    for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  } else if (tint) {
    const c = g.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      c.setXYZ(i, c.getX(i) * tint.r, c.getY(i) * tint.g, c.getZ(i) * tint.b);
    }
  }
  // Drop anything else so merges never fail.
  for (const key of Object.keys(g.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv' && key !== 'color') {
      g.deleteAttribute(key);
    }
  }
  return g;
}

/**
 * Crease-aware vertex normals.
 *
 * Welds by quantised position, groups the faces at each welded position into
 * smoothing clusters (transitive closure of "angle between face normals is
 * under the threshold"), then duplicates vertices so each cluster gets its own
 * normal. Result stays indexed and near-minimal.
 */
export function smoothNormals(geometry: THREE.BufferGeometry, angleDeg = 35): THREE.BufferGeometry {
  const index = geometry.getIndex();
  if (!index) return geometry;
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const idx = index.array;
  const faces = idx.length / 3;
  if (faces === 0) return geometry;

  const cosT = Math.cos(angleDeg * DEG);
  const fnx = new Float32Array(faces);
  const fny = new Float32Array(faces);
  const fnz = new Float32Array(faces);
  const area = new Float32Array(faces);

  for (let f = 0; f < faces; f++) {
    const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
    _v3a.fromBufferAttribute(pos, a);
    _v3b.fromBufferAttribute(pos, b);
    _v3c.fromBufferAttribute(pos, c);
    _v3b.sub(_v3a);
    _v3c.sub(_v3a);
    _v3a.crossVectors(_v3b, _v3c);
    const len = _v3a.length();
    area[f] = len * 0.5;
    if (len > 1e-12) {
      fnx[f] = _v3a.x / len; fny[f] = _v3a.y / len; fnz[f] = _v3a.z / len;
    } else {
      fnx[f] = 0; fny[f] = 1; fnz[f] = 0;
    }
  }

  // Group faces by welded position (per corner).
  const Q = 1e4;
  const groups = new Map<string, number[]>(); // key -> face list
  const cornerKey = new Array<string>(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    const kx = Math.round(pos.getX(v) * Q);
    const ky = Math.round(pos.getY(v) * Q);
    const kz = Math.round(pos.getZ(v) * Q);
    const key = `${kx},${ky},${kz}`;
    cornerKey[i] = key;
    let list = groups.get(key);
    if (!list) { list = []; groups.set(key, list); }
    const f = (i / 3) | 0;
    if (list[list.length - 1] !== f) list.push(f);
  }

  // Per welded position: cluster faces, accumulate cluster normals.
  const clusterOf = new Map<string, Float32Array>(); // key -> per-face cluster normal, packed
  const faceCluster = new Map<string, Map<number, number>>();
  for (const [key, list] of groups) {
    const n = list.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const fi = list[i], fj = list[j];
        const d = fnx[fi] * fnx[fj] + fny[fi] * fny[fj] + fnz[fi] * fnz[fj];
        if (d >= cosT) { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; }
      }
    }
    const rootToSlot = new Map<number, number>();
    const sums: number[] = [];
    const map = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let slot = rootToSlot.get(r);
      if (slot === undefined) { slot = rootToSlot.size; rootToSlot.set(r, slot); sums.push(0, 0, 0); }
      const f = list[i];
      const w = area[f] + 1e-7;
      sums[slot * 3] += fnx[f] * w;
      sums[slot * 3 + 1] += fny[f] * w;
      sums[slot * 3 + 2] += fnz[f] * w;
      map.set(f, slot);
    }
    const packed = new Float32Array(sums.length);
    for (let s = 0; s < rootToSlot.size; s++) {
      let x = sums[s * 3], y = sums[s * 3 + 1], z = sums[s * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      packed[s * 3] = x / l; packed[s * 3 + 1] = y / l; packed[s * 3 + 2] = z / l;
    }
    clusterOf.set(key, packed);
    faceCluster.set(key, map);
  }

  // Rebuild: (originalVertex, cluster) -> new vertex.
  const srcAttrs: Array<[string, THREE.BufferAttribute]> = [];
  for (const name of ['position', 'uv', 'color'] as const) {
    const a = geometry.attributes[name] as THREE.BufferAttribute | undefined;
    if (a) srcAttrs.push([name, a]);
  }
  const remap = new Map<number, number>();
  const outIdx = new Uint32Array(idx.length);
  const srcVert: number[] = [];
  const outNormal: number[] = [];

  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    const key = cornerKey[i];
    const f = (i / 3) | 0;
    const slot = faceCluster.get(key)!.get(f)!;
    const combo = v * 32 + Math.min(31, slot);
    let nv = remap.get(combo);
    if (nv === undefined) {
      nv = srcVert.length;
      remap.set(combo, nv);
      srcVert.push(v);
      const p = clusterOf.get(key)!;
      outNormal.push(p[slot * 3], p[slot * 3 + 1], p[slot * 3 + 2]);
    }
    outIdx[i] = nv;
  }

  const out = new THREE.BufferGeometry();
  const count = srcVert.length;
  for (const [name, attr] of srcAttrs) {
    const items = attr.itemSize;
    const arr = new Float32Array(count * items);
    for (let i = 0; i < count; i++) {
      const s = srcVert[i];
      for (let k = 0; k < items; k++) arr[i * items + k] = attr.array[s * items + k];
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, items));
  }
  out.setAttribute('normal', new THREE.Float32BufferAttribute(outNormal, 3));
  out.setIndex(new THREE.BufferAttribute(outIdx, 1));
  geometry.dispose();
  return out;
}

// ---------------------------------------------------------------------------
// Lofted volumes — the workhorse
// ---------------------------------------------------------------------------

export interface LoftSection {
  /** Position along the kart's length (-Z is forward). */
  z: number;
  /** Vertical centre of the section. */
  y: number;
  /** Horizontal half width. */
  hw: number;
  /** Half height above `y`. */
  hUp: number;
  /** Half height below `y`. */
  hDown: number;
  /** Lateral offset of the whole ring. */
  x?: number;
  /** Superellipse exponent for the sides (2 = ellipse, 6 = crisp chamfered box). */
  eSide?: number;
  /** Exponent for the top half. */
  eTop?: number;
  /** Exponent for the bottom half. */
  eBot?: number;
  /** Roll about +Z, degrees. */
  roll?: number;
}

function seFactor(t: number, e: number): number {
  const a = Math.abs(t);
  if (a < 1e-6) return 0;
  return Math.sign(t) * Math.pow(a, 2 / e);
}

function ringPoint(s: LoftSection, theta: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(theta), n = Math.sin(theta);
  const eS = s.eSide ?? 3.6;
  const eV = n >= 0 ? (s.eTop ?? 3.4) : (s.eBot ?? 5.0);
  let x = s.hw * seFactor(c, eS);
  let y = (n >= 0 ? s.hUp : s.hDown) * seFactor(n, eV);
  if (s.roll) {
    const r = s.roll * DEG, cr = Math.cos(r), sr = Math.sin(r);
    const nx = x * cr - y * sr;
    y = x * sr + y * cr;
    x = nx;
  }
  out.set(x + (s.x ?? 0), y + s.y, s.z);
  return out;
}

export interface LoftOptions {
  segments?: number;
  capFront?: boolean;
  capBack?: boolean;
  uRepeat?: number;
  vRepeat?: number;
}

/** Sweep super-elliptical cross sections. Sections MUST be ordered by ascending z. */
export function loft(sections: LoftSection[], opts: LoftOptions = {}): THREE.BufferGeometry {
  const seg = segs(opts.segments ?? 24, 8);
  const cols = seg + 1; // duplicated seam column for clean UVs
  const rows = sections.length;
  const capF = opts.capFront !== false;
  const capB = opts.capBack !== false;
  const uRep = opts.uRepeat ?? 1;
  const vRep = opts.vRepeat ?? 1;

  const nVerts = rows * cols + (capF ? cols + 1 : 0) + (capB ? cols + 1 : 0);
  const pos = new Float32Array(nVerts * 3);
  const uv = new Float32Array(nVerts * 2);
  const tmp = new THREE.Vector3();
  let p = 0;
  const zSpan = sections[rows - 1].z - sections[0].z || 1;

  for (let r = 0; r < rows; r++) {
    const s = sections[r];
    const v = ((s.z - sections[0].z) / zSpan) * vRep;
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const t = cIdx / seg;
      ringPoint(s, t * Math.PI * 2, tmp);
      pos[p * 3] = tmp.x; pos[p * 3 + 1] = tmp.y; pos[p * 3 + 2] = tmp.z;
      uv[p * 2] = t * uRep; uv[p * 2 + 1] = v;
      p++;
    }
  }

  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < seg; c++) {
      const a = r * cols + c, b = r * cols + c + 1;
      const cc = (r + 1) * cols + c + 1, d = (r + 1) * cols + c;
      idx.push(a, b, cc, a, cc, d);
    }
  }

  const addCap = (row: number, front: boolean) => {
    const s = sections[row];
    const base = p;
    // centroid
    pos[p * 3] = s.x ?? 0; pos[p * 3 + 1] = s.y; pos[p * 3 + 2] = s.z;
    uv[p * 2] = 0.5; uv[p * 2 + 1] = 0.5;
    p++;
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const t = cIdx / seg;
      ringPoint(s, t * Math.PI * 2, tmp);
      // pull the rim in a hair so the cap reads as a chamfer, not a lid
      tmp.x = (s.x ?? 0) + (tmp.x - (s.x ?? 0)) * 0.965;
      tmp.y = s.y + (tmp.y - s.y) * 0.965;
      tmp.z += front ? 0.012 : -0.012;
      pos[p * 3] = tmp.x; pos[p * 3 + 1] = tmp.y; pos[p * 3 + 2] = tmp.z;
      uv[p * 2] = 0.5 + Math.cos(t * Math.PI * 2) * 0.5;
      uv[p * 2 + 1] = 0.5 + Math.sin(t * Math.PI * 2) * 0.5;
      p++;
    }
    for (let c = 0; c < seg; c++) {
      const a = base + 1 + c, b = base + 1 + c + 1;
      if (front) idx.push(base, b, a); else idx.push(base, a, b);
    }
  };
  if (capF) addCap(0, true);
  if (capB) addCap(rows - 1, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Superellipsoid — a rounded box whose chamfer radius is a continuous dial.
 * `eXZ`/`eY` around 4 gives the MK8 "2 mm bevel on everything" read.
 */
export function superShape(
  rx: number, ry: number, rz: number,
  eXZ = 4.2, eY = 4.2,
  segUIn = 18, segVIn = 11,
): THREE.BufferGeometry {
  const segU = segs(segUIn, 8);
  const segV = segs(segVIn, 6);
  const cols = segU + 1, rows = segV + 1;
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  let p = 0;
  for (let j = 0; j < rows; j++) {
    const v = j / segV;
    const phi = -Math.PI / 2 + v * Math.PI;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    for (let i = 0; i < cols; i++) {
      const u = i / segU;
      const th = u * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      const fx = seFactor(cp, eXZ), fy = seFactor(sp, eY);
      pos[p * 3] = rx * fx * seFactor(ct, eXZ);
      pos[p * 3 + 1] = ry * fy;
      pos[p * 3 + 2] = rz * fx * seFactor(st, eXZ);
      uv[p * 2] = u; uv[p * 2 + 1] = v;
      p++;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * cols + i, b = j * cols + i + 1;
      const c = (j + 1) * cols + i + 1, d = (j + 1) * cols + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Rounded box built from a superellipsoid, sized by full extents. */
export function roundedBox(w: number, h: number, d: number, sharp = 5.0): THREE.BufferGeometry {
  return superShape(w / 2, h / 2, d / 2, sharp, sharp, 16, 10);
}

/** A swept tube through points — roll bars, exhausts, tube frames, wiring. */
export function tube(
  points: THREE.Vector3[], radius: number, radial = 10, tubular?: number, closed = false,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.35);
  return new THREE.TubeGeometry(
    curve,
    segs(tubular ?? Math.max(8, points.length * 5), 6),
    radius,
    segs(radial, 6),
    closed,
  );
}

/** Lathe about +Y from a 2D profile (x = radius, y = height). */
export function lathe(profile: THREE.Vector2[], segments = 20, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.LatheGeometry(profile, segs(segments, 6), phiStart, phiLength);
}

/** Extruded 2D outline with a real bevel. Used for wings, plates, brackets. */
export function extrude(
  points: THREE.Vector2[], depth: number, bevel = 0.012, bevelSeg = 2,
): THREE.BufferGeometry {
  const shape = new THREE.Shape(points);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.002, depth - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: SEGMENT_SCALE < 0.7 ? 1 : bevelSeg,
    curveSegments: segs(8, 4),
    steps: 1,
  });
  g.translate(0, 0, -depth / 2 + bevel);
  return g;
}

/**
 * A chamfered disc (brake rotor, wheel face, vent cover), facing +Z.
 *
 * `LatheGeometry` derives its normals from the profile tangent as (dy, -dx), so
 * profiles must be ordered from low y to high y for the surface to face
 * outward. Every lathe in this file follows that rule.
 */
export function disc(r: number, thickness: number, innerR = 0, seg = 24): THREE.BufferGeometry {
  const ch = Math.min(thickness * 0.35, r * 0.06);
  const h = thickness / 2;
  const i0 = Math.max(innerR, 1e-4);
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(i0, -h),
    new THREE.Vector2(r - ch, -h),
    new THREE.Vector2(r, -h + ch),
    new THREE.Vector2(r, h - ch),
    new THREE.Vector2(r - ch, h),
    new THREE.Vector2(i0, h),
  ];
  const g = lathe(pts, seg); // `lathe` applies the segment scale
  g.rotateX(Math.PI / 2); // lathe axis +Y -> +Z
  return g;
}

/** A single rivet / bolt head. Cheap (24 tris) and enormously effective. */
export function rivet(r = 0.014, h = 0.008): THREE.BufferGeometry {
  const pts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(r * 0.75, 0),
    new THREE.Vector2(r, h * 0.55),
    new THREE.Vector2(r * 0.62, h),
    new THREE.Vector2(0, h * 1.05),
  ];
  return lathe(pts, 7);
}

/** Mirror a geometry across X, fixing the winding. */
export function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.clone();
  const pos = out.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
  const nrm = out.attributes.normal as THREE.BufferAttribute | undefined;
  if (nrm) for (let i = 0; i < nrm.count; i++) nrm.setX(i, -nrm.getX(i));
  const idx = out.getIndex();
  if (idx) {
    const a = idx.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; }
    idx.needsUpdate = true;
  }
  pos.needsUpdate = true;
  return out;
}

// ---------------------------------------------------------------------------
// Part bucket
// ---------------------------------------------------------------------------

/** 0 = far LOD keeps it, 1 = mid, 2 = near only. */
export type DetailLevel = 0 | 1 | 2;

interface BucketEntry {
  slot: MaterialSlot;
  geom: THREE.BufferGeometry;
  detail: DetailLevel;
}

const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _eul = new THREE.Euler();

export interface PlaceOptions {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number] | number;
  detail?: DetailLevel;
  /** Multiplied into the vertex colour — free per-part shade variation. */
  tint?: number;
}

export class PartBucket {
  private entries: BucketEntry[] = [];

  add(slot: MaterialSlot, geom: THREE.BufferGeometry, o: PlaceOptions = {}): this {
    if (o.pos || o.rot || o.scale !== undefined) {
      const s = o.scale === undefined ? 1 : o.scale;
      _eul.set(
        (o.rot?.[0] ?? 0) * DEG,
        (o.rot?.[1] ?? 0) * DEG,
        (o.rot?.[2] ?? 0) * DEG,
      );
      _quat.setFromEuler(_eul);
      _mat4.compose(
        _v3a.set(o.pos?.[0] ?? 0, o.pos?.[1] ?? 0, o.pos?.[2] ?? 0),
        _quat,
        typeof s === 'number' ? _v3b.set(s, s, s) : _v3b.set(s[0], s[1], s[2]),
      );
      geom.applyMatrix4(_mat4);
    }
    prepGeometry(geom, o.tint !== undefined ? new THREE.Color(o.tint) : undefined);
    this.entries.push({ slot, geom, detail: o.detail ?? 1 });
    return this;
  }

  /** Symmetric pair: adds the geometry and its X mirror. */
  pair(slot: MaterialSlot, geom: THREE.BufferGeometry, o: PlaceOptions = {}): this {
    this.add(slot, geom, o);
    // `add` transformed + prepped `geom` in place; mirror that result.
    const mirrored = mirrorX(this.entries[this.entries.length - 1].geom);
    this.entries.push({ slot, geom: mirrored, detail: o.detail ?? 1 });
    return this;
  }

  /** Merge into one geometry per slot, keeping parts at or below `maxDetail`. */
  merge(maxDetail: DetailLevel, creaseDeg = 35): Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }> {
    const bySlot = new Map<MaterialSlot, THREE.BufferGeometry[]>();
    for (const e of this.entries) {
      if (e.detail > maxDetail) continue;
      let arr = bySlot.get(e.slot);
      if (!arr) { arr = []; bySlot.set(e.slot, arr); }
      arr.push(e.geom.clone());
    }
    const out: Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }> = [];
    for (const [slot, arr] of bySlot) {
      const merged = arr.length === 1 ? arr[0] : (mergeGeometries(arr, false) ?? arr[0]);
      if (arr.length > 1) for (const a of arr) a.dispose();
      out.push({ slot, geometry: smoothNormals(merged, creaseDeg) });
    }
    return out;
  }

  /** One merged geometry of everything — used as the AO occluder. */
  occluder(): THREE.BufferGeometry | null {
    const arr = this.entries.map((e) => e.geom.clone());
    if (arr.length === 0) return null;
    const m = arr.length === 1 ? arr[0] : mergeGeometries(arr, false);
    if (arr.length > 1) for (const a of arr) a.dispose();
    return m ?? null;
  }

  dispose(): void {
    for (const e of this.entries) e.geom.dispose();
    this.entries.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Consolidation — many slots, one draw call
// ---------------------------------------------------------------------------

export interface ConsolidatePart {
  slot: MaterialSlot;
  geometry: THREE.BufferGeometry;
  /** Baked into the result — used for driver joints and wheels at rest. */
  matrix?: THREE.Matrix4;
}

/**
 * Flatten per-slot geometry into ONE buffer that the merged material can draw.
 *
 * Each part's `uv` is rewritten to its slot's texel in the material atlas, so
 * albedo / roughness / metalness / clearcoat / emissive still vary per part.
 * The baked-AO `color` attribute survives untouched, which is what keeps the
 * crevices dark once the tiling normal maps are gone.
 *
 * Inputs are never modified. Returns `null` for an empty list.
 */
export function consolidateParts(parts: readonly ConsolidatePart[]): THREE.BufferGeometry | null {
  const list: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    if (!p.geometry.attributes.position) continue;
    const g = p.geometry.clone();
    if (p.matrix) g.applyMatrix4(p.matrix);
    prepGeometry(g);
    const n = g.attributes.position.count;
    const u = atlasUv(p.slot);
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = 0.5; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    list.push(g);
  }
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  return merged ?? null;
}

// ---------------------------------------------------------------------------
// AO baking
// ---------------------------------------------------------------------------

/** Cosine-ish hemisphere directions, deterministic. */
function hemisphereDirs(count: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const r = Math.sqrt(t);
    const z = Math.sqrt(Math.max(0, 1 - t));
    const a = i * ga;
    out.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z));
  }
  return out;
}

export interface AoOptions {
  samples?: number;
  radius?: number;
  strength?: number;
  /** Extra darkening on downward-facing surfaces (fakes sky occlusion). */
  skyBias?: number;
  /** Author-space ground plane; surfaces close to it darken. */
  groundY?: number;
}

/**
 * Bake AO into the `color` attribute of `targets`, occluded by `occluder`.
 * Rays are cast once per unique position and shared, which is what makes this
 * affordable (a full kart bakes in ~30–90 ms).
 */
export function bakeAO(
  occluder: THREE.BufferGeometry,
  targets: THREE.BufferGeometry[],
  o: AoOptions = {},
): void {
  const samples = o.samples ?? 6;
  const radius = o.radius ?? 0.5;
  const strength = o.strength ?? 0.85;
  const skyBias = o.skyBias ?? 0.35;
  const groundY = o.groundY;
  if (samples <= 0) return;

  let bvh: MeshBVH;
  try {
    bvh = new MeshBVH(occluder, { targetLeafSize: 12 });
  } catch {
    return;
  }
  const dirs = hemisphereDirs(samples);
  const cache = new Map<string, number>();
  const tangent = new THREE.Vector3();
  const bitan = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (const g of targets) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nrm = g.attributes.normal as THREE.BufferAttribute;
    let col = g.attributes.color as THREE.BufferAttribute | undefined;
    if (!col) {
      const arr = new Float32Array(pos.count * 3).fill(1);
      col = new THREE.BufferAttribute(arr, 3);
      g.setAttribute('color', col);
    }
    for (let i = 0; i < pos.count; i++) {
      _v3a.fromBufferAttribute(pos, i);
      _nA.fromBufferAttribute(nrm, i);
      // 8 mm position buckets and 3 normal buckets per axis. Coarse on purpose:
      // AO is a low-frequency term, and every cache hit is `samples` rays saved.
      // Going from 2 mm to 8 mm cut a full kart's bake from ~600 ms to ~150 ms.
      const key = (
        `${Math.round(_v3a.x * 125)},${Math.round(_v3a.y * 125)},${Math.round(_v3a.z * 125)},`
        + `${Math.round(_nA.x * 3)},${Math.round(_nA.y * 3)},${Math.round(_nA.z * 3)}`
      );
      let ao = cache.get(key);
      if (ao === undefined) {
        // build a frame around the normal
        if (Math.abs(_nA.z) < 0.9) tangent.set(0, 0, 1); else tangent.set(1, 0, 0);
        tangent.cross(_nA).normalize();
        bitan.crossVectors(_nA, tangent);
        let hits = 0;
        _ray.origin.copy(_v3a).addScaledVector(_nA, 0.004);
        for (const d of dirs) {
          dir.set(0, 0, 0)
            .addScaledVector(tangent, d.x)
            .addScaledVector(bitan, d.y)
            .addScaledVector(_nA, d.z)
            .normalize();
          _ray.direction.copy(dir);
          const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0.002, radius);
          if (hit) hits += 1 - Math.min(1, hit.distance / radius) * 0.35;
        }
        ao = 1 - (hits / samples) * strength;
        // Sky occlusion: downward-facing surfaces see no sky.
        ao *= 1 - skyBias * (0.5 - 0.5 * _nA.y);
        if (groundY !== undefined) {
          const h = Math.max(0, _v3a.y - groundY);
          ao *= 0.72 + 0.28 * Math.min(1, h / 0.34);
        }
        ao = Math.max(0.16, Math.min(1, ao));
        cache.set(key, ao);
      }
      col.setXYZ(i, col.getX(i) * ao, col.getY(i) * ao, col.getZ(i) * ao);
    }
    col.needsUpdate = true;
  }
}

/**
 * Copy baked vertex colours from one set of geometries to another by position.
 *
 * The mid and far LOD groups are built from the *same* authored parts as the
 * near group, so every vertex they keep exists in the near set at an identical
 * position. Looking the AO up is therefore free, where re-baking costs as much
 * as the first bake did. This is why only one bake per kart is ever run.
 */
export function transferVertexColors(
  from: THREE.BufferGeometry[],
  to: THREE.BufferGeometry[],
): void {
  const map = new Map<number, number>();
  const q = (v: number) => Math.round(v * 400) + 4096;
  const hash = (x: number, y: number, z: number) => q(x) * 8192 * 8192 + q(y) * 8192 + q(z);
  for (const g of from) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    const col = g.attributes.color as THREE.BufferAttribute | undefined;
    if (!col) continue;
    for (let i = 0; i < pos.count; i++) {
      map.set(hash(pos.getX(i), pos.getY(i), pos.getZ(i)), col.getX(i));
    }
  }
  if (map.size === 0) return;
  for (const g of to) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    let col = g.attributes.color as THREE.BufferAttribute | undefined;
    if (!col) {
      col = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3);
      g.setAttribute('color', col);
    }
    for (let i = 0; i < pos.count; i++) {
      const ao = map.get(hash(pos.getX(i), pos.getY(i), pos.getZ(i)));
      if (ao === undefined) continue;
      col.setXYZ(i, ao, ao, ao);
    }
    col.needsUpdate = true;
  }
}

// ===========================================================================
//  SHARED SUB-ASSEMBLIES
// ===========================================================================

function panelGapStrip(len: number, width = 0.012): THREE.BufferGeometry {
  return roundedBox(width, 0.02, len, 3.0);
}

/**
 * A hard-edged bead swept along a path.
 *
 * This is the single cheapest way to make a moulded body read as *moulded*: a
 * ~14 mm chamfer running along the shoulder of a panel picks up a specular line
 * from the key light and traces the silhouette even when the paint underneath is
 * in shadow. MK8 gets the same effect from its edge highlights; without it a
 * lofted tub is a smooth blob with nothing for the eye to catch.
 */
function edgeBead(path: THREE.Vector3[], r = 0.0135): THREE.BufferGeometry {
  return tube(path, r, 6, Math.max(10, path.length * 5));
}

/**
 * Aerofoil section wing, spanning ±`halfSpan` in X with the chord along Z.
 * Flat underside, cambered top, tapered trailing edge.
 */
function wingPlane(halfSpan: number, chord: number, thick: number): THREE.BufferGeometry {
  const c = chord;
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(-c * 0.5, -thick * 0.30),
    new THREE.Vector2(-c * 0.22, -thick * 0.46),
    new THREE.Vector2(c * 0.30, -thick * 0.30),
    new THREE.Vector2(c * 0.5, 0),
    new THREE.Vector2(c * 0.22, thick * 0.52),
    new THREE.Vector2(-c * 0.28, thick * 0.44),
    new THREE.Vector2(-c * 0.5, thick * 0.10),
  ];
  const g = extrude(pts, halfSpan * 2, 0.008, 2);
  // extrude() builds along +Z; -90° puts the span on X and the chord on Z with
  // the leading edge forward (-Z) and the winding intact.
  g.rotateY(-90 * DEG);
  return g;
}

/** Wing endplate — a tapered vertical fin, authored for the +X side. */
function endPlate(h: number, len: number, thick: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(-len * 0.5, -h * 0.5),
    new THREE.Vector2(len * 0.5, -h * 0.38),
    new THREE.Vector2(len * 0.42, h * 0.5),
    new THREE.Vector2(-len * 0.42, h * 0.30),
  ];
  const g = extrude(pts, thick, 0.006, 2);
  g.rotateY(-90 * DEG);
  return g;
}

/** Radiator / intake grille: a frame plus angled slats. */
function grille(w: number, h: number, slats = 6, depth = 0.05): { frame: THREE.BufferGeometry; slats: THREE.BufferGeometry } {
  const frameProfile: THREE.Vector2[] = [
    new THREE.Vector2(-w / 2, -h / 2), new THREE.Vector2(w / 2, -h / 2),
    new THREE.Vector2(w / 2, h / 2), new THREE.Vector2(-w / 2, h / 2),
  ];
  const inner: THREE.Vector2[] = [
    new THREE.Vector2(-w / 2 + 0.022, -h / 2 + 0.022), new THREE.Vector2(w / 2 - 0.022, -h / 2 + 0.022),
    new THREE.Vector2(w / 2 - 0.022, h / 2 - 0.022), new THREE.Vector2(-w / 2 + 0.022, h / 2 - 0.022),
  ];
  const shape = new THREE.Shape(frameProfile);
  shape.holes.push(new THREE.Path(inner.slice().reverse()));
  const frame = new THREE.ExtrudeGeometry(shape, {
    depth: depth * 0.55, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, steps: 1,
  });
  frame.translate(0, 0, -depth * 0.28);

  const parts: THREE.BufferGeometry[] = [];
  const sh = (h - 0.05) / slats;
  for (let i = 0; i < slats; i++) {
    const y = -h / 2 + 0.025 + sh * (i + 0.5);
    const b = roundedBox(w - 0.05, sh * 0.6, depth * 0.5, 3.2);
    b.rotateX(-24 * DEG);
    b.translate(0, y, -depth * 0.34);
    parts.push(b);
  }
  const slatGeom = mergeGeometries(parts, false) ?? parts[0];
  for (const p of parts) p.dispose();
  return { frame, slats: slatGeom };
}

/** Bucket seat with a rolled edge and a headrest. Returns the hip anchor Y/Z. */
function seatAssembly(
  b: PartBucket, x: number, y: number, z: number,
  width: number, backHeight: number, tilt: number, detail: DetailLevel = 1,
): void {
  // base pan
  const pan = loft([
    { z: -0.20, y: 0.0, hw: width * 0.40, hUp: 0.030, hDown: 0.030, eSide: 3.0, eTop: 3.0 },
    { z: -0.06, y: 0.006, hw: width * 0.50, hUp: 0.036, hDown: 0.034, eSide: 3.4 },
    { z: 0.10, y: 0.014, hw: width * 0.52, hUp: 0.040, hDown: 0.034, eSide: 3.6 },
    { z: 0.22, y: 0.030, hw: width * 0.47, hUp: 0.044, hDown: 0.030, eSide: 3.2 },
  ], { segments: 20 });
  b.add('seat', pan, { pos: [x, y, z], rot: [tilt, 0, 0] });

  // side bolsters
  const bolster = loft([
    { z: -0.20, y: 0, hw: 0.030, hUp: 0.030, hDown: 0.030, eSide: 2.6, eTop: 2.6 },
    { z: 0.0, y: 0.026, hw: 0.040, hUp: 0.050, hDown: 0.034, eSide: 2.8 },
    { z: 0.20, y: 0.030, hw: 0.034, hUp: 0.040, hDown: 0.030, eSide: 2.6 },
  ], { segments: 14 });
  b.pair('seat', bolster, { pos: [x + width * 0.48, y + 0.035, z], rot: [tilt, 0, 0], detail });

  // backrest
  const back = loft([
    { z: -0.030, y: 0, hw: width * 0.47, hUp: 0.030, hDown: 0.030, eSide: 3.4, eTop: 3.0 },
    { z: 0.028, y: 0, hw: width * 0.50, hUp: 0.034, hDown: 0.032, eSide: 3.6 },
  ], { segments: 20 });
  back.rotateX(-90 * DEG + tilt * DEG - 12 * DEG);
  back.scale(1, 1, backHeight / 0.058);
  b.add('seat', back, { pos: [x, y + backHeight * 0.52, z + 0.24] });

  // headrest
  const head = superShape(width * 0.30, 0.075, 0.045, 3.4, 3.2, 16, 10);
  b.add('seat', head, { pos: [x, y + backHeight + 0.03, z + 0.20], rot: [-8, 0, 0], detail });

  // seat frame rails
  const rail = tube([
    new THREE.Vector3(0, -0.03, -0.18), new THREE.Vector3(0, -0.05, 0.05), new THREE.Vector3(0, -0.03, 0.24),
  ], 0.014, 7);
  b.pair('metal', rail, { pos: [x + width * 0.34, y, z], detail: 2 });
}

/** Steering wheel geometry in its own local space (spins about +Z). */
function steeringWheelGeom(radius: number): { rim: THREE.BufferGeometry; core: THREE.BufferGeometry } {
  const rim = new THREE.TorusGeometry(radius, radius * 0.13, 8, 26);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
    const spoke = roundedBox(radius * 0.16, radius * 0.9, 0.018, 3.2);
    spoke.translate(0, radius * 0.46, 0);
    spoke.rotateZ(a + Math.PI / 2);
    parts.push(spoke);
  }
  const hub = lathe([
    new THREE.Vector2(0, -0.014), new THREE.Vector2(radius * 0.24, -0.016),
    new THREE.Vector2(radius * 0.28, 0.008), new THREE.Vector2(radius * 0.20, 0.026),
    new THREE.Vector2(0, 0.030),
  ], 14);
  hub.rotateX(-90 * DEG);
  parts.push(hub);
  const core = mergeGeometries(parts, false) ?? parts[0];
  for (const p of parts) p.dispose();
  return { rim, core };
}

/** Exhaust: swept pipe with a darkened, hollow tip. */
function exhaust(
  b: PartBucket, path: THREE.Vector3[], r: number, tipR: number, detail: DetailLevel = 1,
): THREE.Vector3 {
  const pipe = tube(path, r, 10);
  b.add('chrome', pipe, {});
  const end = path[path.length - 1];
  const prev = path[path.length - 2];
  const dir = new THREE.Vector3().copy(end).sub(prev).normalize();
  // flared tip
  const tip = lathe([
    new THREE.Vector2(r * 0.86, -0.02),
    new THREE.Vector2(tipR, 0.012),
    new THREE.Vector2(tipR, 0.05),
    new THREE.Vector2(tipR * 0.82, 0.05),
    new THREE.Vector2(tipR * 0.78, -0.02),
  ], 16);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  tip.applyQuaternion(q);
  tip.translate(end.x, end.y, end.z);
  b.add('chrome', tip, { detail });
  // dark interior disc so the pipe reads as hollow
  const inner = disc(tipR * 0.78, 0.01, 0, 16);
  inner.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir));
  inner.translate(end.x + dir.x * 0.03, end.y + dir.y * 0.03, end.z + dir.z * 0.03);
  b.add('plastic', inner, { tint: 0.12, detail });
  return new THREE.Vector3(end.x + dir.x * 0.055, end.y + dir.y * 0.055, end.z + dir.z * 0.055);
}

function headlight(b: PartBucket, x: number, y: number, z: number, r: number, detail: DetailLevel = 1): void {
  const housing = lathe([
    new THREE.Vector2(0, 0), new THREE.Vector2(r * 0.98, 0.004),
    new THREE.Vector2(r * 1.04, 0.028), new THREE.Vector2(r * 0.9, 0.05), new THREE.Vector2(0, 0.052),
  ], 16);
  housing.rotateX(90 * DEG);
  b.pair('chrome', housing, { pos: [x, y, z], tint: 0.9, detail });
  const lens = lathe([
    new THREE.Vector2(1e-4, -0.030), new THREE.Vector2(r * 0.8, -0.022),
    new THREE.Vector2(r * 0.86, 0.0), new THREE.Vector2(1e-4, 0.0),
  ], 16);
  lens.rotateX(90 * DEG);
  b.pair('lightFront', lens, { pos: [x, y, z - 0.006] });
}

function tailLight(b: PartBucket, x: number, y: number, z: number, w: number, h: number): void {
  const lens = loft([
    { z: 0, y: 0, hw: w / 2, hUp: h / 2, hDown: h / 2, eSide: 3.4, eTop: 3.2, eBot: 3.2 },
    { z: 0.028, y: 0, hw: w / 2 * 0.9, hUp: h / 2 * 0.86, hDown: h / 2 * 0.86, eSide: 3.4 },
  ], { segments: 16 });
  b.pair('lightRear', lens, { pos: [x, y, z] });
  const bezel = loft([
    { z: -0.014, y: 0, hw: w / 2 + 0.014, hUp: h / 2 + 0.014, hDown: h / 2 + 0.014, eSide: 3.4 },
    { z: 0.006, y: 0, hw: w / 2 + 0.010, hUp: h / 2 + 0.010, hDown: h / 2 + 0.010, eSide: 3.4 },
  ], { segments: 16 });
  b.pair('plastic', bezel, { pos: [x, y, z], tint: 0.35, detail: 2 });
}

function mirror(b: PartBucket, x: number, y: number, z: number, detail: DetailLevel = 2): void {
  const stalk = tube([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.045, 0.035, -0.01), new THREE.Vector3(0.085, 0.055, -0.02),
  ], 0.011, 7);
  b.pair('metal', stalk, { pos: [x, y, z], detail });
  const shell = superShape(0.055, 0.038, 0.022, 3.2, 3.2, 14, 8);
  b.pair('paint2', shell, { pos: [x + 0.09, y + 0.062, z - 0.022], rot: [0, -18, 6], detail });
  const glass = disc(0.042, 0.006, 0, 14);
  b.pair('glass', glass, { pos: [x + 0.093, y + 0.062, z - 0.040], rot: [0, 200, 0], detail });
}

function numberPlate(b: PartBucket, x: number, y: number, z: number, w = 0.22, detail: DetailLevel = 2): void {
  const plate = extrude([
    new THREE.Vector2(-w / 2, -w * 0.34), new THREE.Vector2(w / 2, -w * 0.34),
    new THREE.Vector2(w / 2, w * 0.34), new THREE.Vector2(-w / 2, w * 0.34),
  ], 0.018, 0.008);
  b.add('plastic', plate, { pos: [x, y, z], tint: 1.35, detail });
  const ring = new THREE.TorusGeometry(w * 0.29, 0.006, 6, 20);
  b.add('metal', ring, { pos: [x, y, z - 0.012], detail });
}

/** Suspension A-arm, authored pointing +X from the chassis. */
export function suspensionArm(len: number, thick = 0.020): THREE.BufferGeometry {
  const parts = [
    tube([new THREE.Vector3(0, 0.01, -0.06), new THREE.Vector3(len * 0.6, 0.004, -0.02), new THREE.Vector3(len, 0, 0)], thick, 7),
    tube([new THREE.Vector3(0, 0.01, 0.06), new THREE.Vector3(len * 0.6, 0.004, 0.02), new THREE.Vector3(len, 0, 0)], thick, 7),
  ];
  const knuckle = superShape(thick * 1.9, thick * 2.4, thick * 1.9, 3.4, 3.4, 12, 8);
  knuckle.translate(len, 0, 0);
  parts.push(knuckle);
  const m = mergeGeometries(parts, false) ?? parts[0];
  for (const p of parts) p.dispose();
  return m;
}

/** Coil-over damper, authored along +Y with the body at the origin. */
export function coilover(len: number, r = 0.032): { body: THREE.BufferGeometry; spring: THREE.BufferGeometry } {
  const body = lathe([
    new THREE.Vector2(0, 0), new THREE.Vector2(r * 0.55, 0), new THREE.Vector2(r * 0.55, len * 0.42),
    new THREE.Vector2(r * 0.34, len * 0.46), new THREE.Vector2(r * 0.34, len),
    new THREE.Vector2(0, len),
  ], 12);
  // helical spring as a swept tube
  const pts: THREE.Vector3[] = [];
  const turns = 7;
  const steps = turns * 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, len * 0.06 + t * len * 0.8, Math.sin(a) * r));
  }
  const spring = tube(pts, r * 0.16, 6, steps);
  return { body, spring };
}

// ===========================================================================
//  BODY DEFINITIONS
// ===========================================================================

export const KART_BODY_IDS = ['standard', 'bike', 'cruiser', 'speedster', 'buggy', 'hover'] as const;
export type KartBodyId = (typeof KART_BODY_IDS)[number];

export const BODY_NAMES: Record<KartBodyId, string> = {
  standard: 'Standard Kart',
  bike: 'Sport Bike',
  cruiser: 'Heavy Cruiser',
  speedster: 'Speedster',
  buggy: 'Trail Buggy',
  hover: 'Hover Racer',
};

/** Which tyre family each chassis wants by default. */
export const BODY_TYRE: Record<KartBodyId, 'slick' | 'standard' | 'knobbly' | 'hover'> = {
  standard: 'standard',
  bike: 'slick',
  cruiser: 'standard',
  speedster: 'slick',
  buggy: 'knobbly',
  hover: 'hover',
};

export interface BodyBuildResult {
  /** Merged chassis geometry per material slot, near LOD. */
  near: Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }>;
  mid: Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }>;
  far: Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }>;
  /** Steering wheel parts (null for the bike/cruiser which use bars). */
  steering: { rim: THREE.BufferGeometry; core: THREE.BufferGeometry; pos: THREE.Vector3; tilt: number; radius: number } | null;
  /** Where the driver's hips sit, and how far the torso is pitched forward. */
  driver: { pos: THREE.Vector3; leanDeg: number; scale: number };
  sockets: Record<string, THREE.Vector3>;
  /** Front wheels drawn as one central wheel (bike). */
  singleFront: boolean;
  /** Per-wheel visual scale multiplier, FL FR RL RR. */
  wheelScale: [number, number, number, number];
  /**
   * Per-wheel *width* multiplier on top of `wheelScale`. Fat rear tyres are half
   * the reason a MK8 kart reads as a kart and not a shopping trolley, and widening
   * costs nothing — unlike a bigger diameter, which would sink into the road.
   */
  wheelWidthScale: [number, number, number, number];
  /** Show suspension arms / coilovers. */
  suspension: 'arm' | 'coilover' | 'none';
  tris: number;
}

interface BuildCtx {
  b: PartBucket;
  f: KartFrame;
  /** Author-space Y of the static wheel centre. */
  wy: number;
}

// ---------------------------------------------------------------------------
// 1. STANDARD KART — rounded open-wheel tub, nose cone, roll bar, side pods
// ---------------------------------------------------------------------------

function buildStandard(c: BuildCtx): Partial<BodyBuildResult> {
  const { b, f } = c;
  const fz = f.frontZ, rz = f.rearZ;
  const floor = f.wheelRadius * 0.52;
  const tw = f.trackHalfFront;

  // --- main tub -----------------------------------------------------------
  const tub = loft([
    { z: fz - 0.36, y: floor + 0.10, hw: 0.105, hUp: 0.055, hDown: 0.045, eSide: 2.6, eTop: 2.6, eBot: 3.0 },
    { z: fz - 0.26, y: floor + 0.10, hw: 0.185, hUp: 0.075, hDown: 0.062, eSide: 3.0, eTop: 2.8 },
    { z: fz - 0.10, y: floor + 0.10, hw: 0.275, hUp: 0.095, hDown: 0.080, eSide: 3.4, eTop: 3.0 },
    { z: fz + 0.14, y: floor + 0.09, hw: 0.340, hUp: 0.125, hDown: 0.085, eSide: 4.0, eTop: 3.2, eBot: 5.0 },
    { z: 0.0, y: floor + 0.085, hw: 0.365, hUp: 0.150, hDown: 0.082, eSide: 4.4, eTop: 3.4, eBot: 5.6 },
    { z: rz - 0.28, y: floor + 0.085, hw: 0.372, hUp: 0.170, hDown: 0.080, eSide: 4.4, eTop: 3.6, eBot: 5.6 },
    { z: rz - 0.06, y: floor + 0.095, hw: 0.352, hUp: 0.185, hDown: 0.078, eSide: 4.2, eTop: 3.6 },
    { z: rz + 0.16, y: floor + 0.10, hw: 0.300, hUp: 0.160, hDown: 0.070, eSide: 3.6, eTop: 3.2 },
    { z: rz + 0.27, y: floor + 0.10, hw: 0.235, hUp: 0.120, hDown: 0.055, eSide: 3.0, eTop: 2.8 },
  ], { segments: 26, uRepeat: 2, vRepeat: 2.4 });
  b.add('paint', tub, { detail: 0 });

  // --- cockpit cut-out floor + inner shell -------------------------------
  const inner = loft([
    { z: fz + 0.18, y: floor + 0.11, hw: 0.245, hUp: 0.055, hDown: 0.055, eSide: 3.4 },
    { z: 0.10, y: floor + 0.105, hw: 0.265, hUp: 0.075, hDown: 0.060, eSide: 3.8 },
    { z: rz - 0.20, y: floor + 0.11, hw: 0.250, hUp: 0.070, hDown: 0.055, eSide: 3.6 },
  ], { segments: 20 });
  b.add('plastic', inner, { tint: 0.55, detail: 1 });

  // --- nose cone ----------------------------------------------------------
  const nose = loft([
    { z: fz - 0.50, y: floor + 0.075, hw: 0.055, hUp: 0.030, hDown: 0.028, eSide: 2.4, eTop: 2.4 },
    { z: fz - 0.44, y: floor + 0.080, hw: 0.115, hUp: 0.048, hDown: 0.042, eSide: 2.8 },
    { z: fz - 0.34, y: floor + 0.090, hw: 0.165, hUp: 0.060, hDown: 0.052, eSide: 3.0 },
  ], { segments: 20 });
  b.add('paint2', nose, { detail: 0 });

  // front bumper bar
  const bumper = tube([
    new THREE.Vector3(-tw * 0.86, floor + 0.05, fz - 0.34),
    new THREE.Vector3(-tw * 0.55, floor + 0.045, fz - 0.50),
    new THREE.Vector3(0, floor + 0.042, fz - 0.545),
    new THREE.Vector3(tw * 0.55, floor + 0.045, fz - 0.50),
    new THREE.Vector3(tw * 0.86, floor + 0.05, fz - 0.34),
  ], 0.030, 9);
  b.add('paint2', bumper, { detail: 0 });

  // --- raised cockpit coaming --------------------------------------------
  // The tub on its own tops out well below the wheel centres, which is why the
  // kart read as a spindly frame carrying four oversized tyres. These flanks add
  // the missing vertical mass along both sides of the cockpit while leaving the
  // seat, the driver's legs and the steering wheel on show.
  const coaming = loft([
    { z: fz - 0.04, y: 0.000, hw: 0.050, hUp: 0.044, hDown: 0.085, eSide: 3.0, eTop: 3.0, eBot: 4.4 },
    { z: fz + 0.30, y: 0.030, hw: 0.060, hUp: 0.060, hDown: 0.100, eSide: 3.4, eTop: 3.2 },
    { z: 0.10, y: 0.048, hw: 0.065, hUp: 0.068, hDown: 0.110, eSide: 3.8, eTop: 3.4 },
    { z: rz - 0.20, y: 0.056, hw: 0.062, hUp: 0.066, hDown: 0.110, eSide: 3.6, eTop: 3.2 },
    { z: rz + 0.02, y: 0.030, hw: 0.048, hUp: 0.048, hDown: 0.090, eSide: 3.0, eTop: 3.0 },
  ], { segments: 20, uRepeat: 1.5, vRepeat: 1.8 });
  b.pair('paint', coaming, { pos: [0.310, floor + 0.210, 0], detail: 0 });

  // --- side pods ----------------------------------------------------------
  const pod = loft([
    { z: fz + 0.22, y: 0, hw: 0.066, hUp: 0.068, hDown: 0.058, eSide: 2.8, eTop: 2.8 },
    { z: fz + 0.42, y: 0.006, hw: 0.112, hUp: 0.104, hDown: 0.078, eSide: 3.4, eTop: 3.0 },
    { z: rz - 0.34, y: 0.010, hw: 0.120, hUp: 0.112, hDown: 0.080, eSide: 3.8, eTop: 3.2 },
    { z: rz - 0.10, y: 0.004, hw: 0.096, hUp: 0.088, hDown: 0.068, eSide: 3.2, eTop: 3.0 },
  ], { segments: 20, uRepeat: 1.4 });
  b.pair('paint', pod, { pos: [tw * 0.80, floor + 0.098, 0], detail: 0 });

  // pod intake
  const intake = lathe([
    new THREE.Vector2(0.030, 0), new THREE.Vector2(0.058, 0.004),
    new THREE.Vector2(0.058, 0.034), new THREE.Vector2(0.030, 0.038),
  ], 14);
  intake.rotateX(90 * DEG);
  b.pair('plastic', intake, { pos: [tw * 0.80, floor + 0.128, fz + 0.20], tint: 0.3, detail: 2 });

  // --- floor pan ----------------------------------------------------------
  const pan = loft([
    { z: fz - 0.10, y: 0, hw: 0.30, hUp: 0.016, hDown: 0.014, eSide: 4.0, eTop: 4.0, eBot: 5.0 },
    { z: 0, y: 0, hw: 0.40, hUp: 0.018, hDown: 0.016, eSide: 5.0 },
    { z: rz + 0.10, y: 0, hw: 0.36, hUp: 0.018, hDown: 0.016, eSide: 4.4 },
  ], { segments: 16 });
  b.add('metal', pan, { pos: [0, floor - 0.028, 0], tint: 0.7, detail: 1 });

  // --- roll bar behind the seat ------------------------------------------
  const bar = tube([
    new THREE.Vector3(-0.30, floor + 0.12, rz - 0.05),
    new THREE.Vector3(-0.325, floor + 0.34, rz - 0.10),
    new THREE.Vector3(-0.26, floor + 0.50, rz - 0.14),
    new THREE.Vector3(0, floor + 0.545, rz - 0.155),
    new THREE.Vector3(0.26, floor + 0.50, rz - 0.14),
    new THREE.Vector3(0.325, floor + 0.34, rz - 0.10),
    new THREE.Vector3(0.30, floor + 0.12, rz - 0.05),
  ], 0.032, 10, 44);
  b.add('chrome', bar, { detail: 0 });
  const brace = tube([
    new THREE.Vector3(0, floor + 0.50, rz - 0.15),
    new THREE.Vector3(0, floor + 0.30, rz + 0.06),
    new THREE.Vector3(0, floor + 0.14, rz + 0.20),
  ], 0.020, 8);
  b.add('metal', brace, { detail: 1 });

  // --- engine block behind the driver -----------------------------------
  const engine = superShape(0.175, 0.135, 0.185, 4.2, 4.0, 18, 12);
  b.add('metal', engine, { pos: [0.0, floor + 0.215, rz + 0.08], tint: 0.85, detail: 0 });
  for (let i = 0; i < 5; i++) {
    const fin = roundedBox(0.34, 0.020, 0.016, 3.0);
    b.add('metal', fin, { pos: [0, floor + 0.14 + i * 0.058, rz + 0.08], tint: 1.15, detail: 2 });
  }
  const airbox = lathe([
    new THREE.Vector2(0, 0), new THREE.Vector2(0.058, 0.006), new THREE.Vector2(0.062, 0.052),
    new THREE.Vector2(0.048, 0.070), new THREE.Vector2(0, 0.074),
  ], 16);
  // Primary paint, not the accent: the airbox sits directly behind the helmet and
  // is one of the largest things the chase camera ever sees.
  b.add('paint', airbox, { pos: [0, floor + 0.33, rz + 0.06], rot: [-16, 0, 0], detail: 1 });

  // --- rear deck ----------------------------------------------------------
  // A body-coloured cover across the engine bay. Without it the whole rear of
  // the kart is brushed metal and chrome, which is why it read as a pale blob
  // from the default chase framing however saturated the paint was.
  const deck = loft([
    { z: rz - 0.30, y: 0, hw: 0.250, hUp: 0.048, hDown: 0.090, eSide: 3.6, eTop: 3.4, eBot: 5.0 },
    { z: rz - 0.06, y: 0.010, hw: 0.286, hUp: 0.058, hDown: 0.100, eSide: 4.0, eTop: 3.6 },
    { z: rz + 0.14, y: 0.006, hw: 0.268, hUp: 0.052, hDown: 0.095, eSide: 3.8, eTop: 3.4 },
    { z: rz + 0.32, y: -0.012, hw: 0.196, hUp: 0.040, hDown: 0.070, eSide: 3.2, eTop: 3.0 },
  ], { segments: 22, uRepeat: 1.6, vRepeat: 1.8 });
  b.add('paint', deck, { pos: [0, floor + 0.300, 0], detail: 0 });

  // Louvred vents in the deck so it is not a bare shell.
  for (let i = 0; i < 3; i++) {
    const louvre = roundedBox(0.20, 0.014, 0.030, 3.0);
    b.pair('plastic', louvre, {
      pos: [0.115, floor + 0.348 - i * 0.004, rz - 0.10 + i * 0.058],
      rot: [-18, 0, 0], tint: 0.22, detail: 2,
    });
  }

  // --- rear diffuser ------------------------------------------------------
  const diffuser = loft([
    { z: rz + 0.20, y: 0, hw: 0.290, hUp: 0.026, hDown: 0.024, eSide: 4.4, eTop: 4.0 },
    { z: rz + 0.40, y: 0.030, hw: 0.250, hUp: 0.022, hDown: 0.020, eSide: 4.0, eTop: 3.6 },
  ], { segments: 16 });
  b.add('paint2', diffuser, { pos: [0, floor - 0.010, 0], detail: 0 });
  for (let i = -1; i <= 1; i++) {
    const fin = roundedBox(0.014, 0.052, 0.185, 3.2);
    b.add('plastic', fin, { pos: [i * 0.105, floor + 0.014, rz + 0.30], rot: [-8, 0, 0], tint: 0.3, detail: 2 });
  }

  // --- seat ---------------------------------------------------------------
  seatAssembly(b, 0, floor + 0.115, -0.02, 0.30, 0.30, -6, 1);

  // --- grille, lights, plate, mirrors ------------------------------------
  const gr = grille(0.30, 0.115, 6, 0.06);
  b.add('metal', gr.frame, { pos: [0, floor + 0.115, fz - 0.315], tint: 0.55, detail: 1 });
  b.add('plastic', gr.slats, { pos: [0, floor + 0.115, fz - 0.315], tint: 0.28, detail: 2 });
  headlight(b, 0.155, floor + 0.145, fz - 0.245, 0.052, 1);
  tailLight(b, 0.185, floor + 0.135, rz + 0.275, 0.145, 0.070);
  numberPlate(b, 0, floor + 0.185, fz - 0.32, 0.20, 2);
  mirror(b, 0.29, floor + 0.20, fz + 0.30, 2);

  // --- rivet rows ---------------------------------------------------------
  for (let i = 0; i < 7; i++) {
    const z = fz + 0.1 + i * 0.16;
    const r = rivet(0.013, 0.007);
    b.pair('chrome', r, { pos: [0.352, floor + 0.02 + 0.005 * i, z], rot: [0, 0, -90], detail: 2, tint: 0.9 });
  }
  // panel gap along the tub shoulder
  b.pair('plastic', panelGapStrip(0.9), { pos: [0.30, floor + 0.175, 0.05], tint: 0.15, detail: 2 });

  // --- sponsor stripe (paint2 inlay) -------------------------------------
  const stripe = loft([
    { z: fz - 0.30, y: 0, hw: 0.10, hUp: 0.012, hDown: 0.012, eSide: 3.0 },
    { z: 0.0, y: 0, hw: 0.115, hUp: 0.012, hDown: 0.012, eSide: 3.0 },
    { z: rz + 0.20, y: 0, hw: 0.095, hUp: 0.012, hDown: 0.012, eSide: 3.0 },
  ], { segments: 12 });
  b.add('paint2', stripe, { pos: [0, floor + 0.235, 0], detail: 1 });

  // --- shoulder chamfer bead ---------------------------------------------
  // Traces the coaming's top edge from the nose to the roll hoop. This is the
  // line that catches the key light and gives the bodywork a readable silhouette.
  b.pair('chrome', edgeBead([
    new THREE.Vector3(0.150, floor + 0.180, fz - 0.30),
    new THREE.Vector3(0.262, floor + 0.216, fz - 0.10),
    new THREE.Vector3(0.318, floor + 0.268, fz + 0.14),
    new THREE.Vector3(0.336, floor + 0.300, fz + 0.34),
    new THREE.Vector3(0.340, floor + 0.322, 0.06),
    new THREE.Vector3(0.334, floor + 0.328, rz - 0.22),
    new THREE.Vector3(0.300, floor + 0.300, rz + 0.02),
    new THREE.Vector3(0.262, floor + 0.262, rz + 0.20),
  ], 0.0135), { detail: 0, tint: 1.05 });

  // Matching bead along the outer lip of each side pod.
  b.pair('paint2', edgeBead([
    new THREE.Vector3(tw * 0.80 + 0.058, floor + 0.152, fz + 0.26),
    new THREE.Vector3(tw * 0.80 + 0.104, floor + 0.190, fz + 0.46),
    new THREE.Vector3(tw * 0.80 + 0.112, floor + 0.198, rz - 0.34),
    new THREE.Vector3(tw * 0.80 + 0.088, floor + 0.180, rz - 0.12),
  ], 0.0115), { detail: 1 });

  // --- front wing ---------------------------------------------------------
  // Spans nearly the full front track so the nose stops reading as a point with
  // two wheels floating either side of it — the single biggest reason the kart
  // looked spindly from the chase camera.
  const splitter = wingPlane(tw * 0.97, 0.195, 0.036);
  b.add('paint2', splitter, { pos: [0, floor + 0.020, fz - 0.40], rot: [-4, 0, 0], detail: 0 });
  b.pair('paint', endPlate(0.108, 0.205, 0.020), {
    pos: [tw * 0.96, floor + 0.062, fz - 0.40], detail: 0,
  });
  // Struts tying the wing back into the nose cone.
  b.pair('metal', tube([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(-0.055, 0.050, 0.055),
    new THREE.Vector3(-0.098, 0.070, 0.115),
  ], 0.014, 7), { pos: [tw * 0.62, floor + 0.026, fz - 0.42], tint: 0.85, detail: 1 });

  // --- rear wing ---------------------------------------------------------
  // The biggest single silhouette win on the kart: a real aerofoil on two
  // endplates, sitting proud of the engine cover where the light can reach it.
  const wingY = floor + 0.545;
  const wingZ = rz + 0.235;
  const wingHalf = 0.330;
  b.add('paint', wingPlane(wingHalf, 0.185, 0.042), {
    pos: [0, wingY, wingZ], rot: [8, 0, 0], detail: 0,
  });
  // Under-plane: a smaller second element reads as a real two-tier wing.
  b.add('paint2', wingPlane(wingHalf * 0.86, 0.098, 0.026), {
    pos: [0, wingY - 0.062, wingZ + 0.026], rot: [14, 0, 0], detail: 1,
  });
  b.pair('paint2', endPlate(0.150, 0.230, 0.018), {
    pos: [wingHalf + 0.010, wingY - 0.024, wingZ], detail: 0,
  });
  // Chrome lip along the wing's trailing edge — a bright horizontal accent.
  b.add('chrome', edgeBead([
    new THREE.Vector3(-wingHalf, wingY + 0.012, wingZ + 0.092),
    new THREE.Vector3(0, wingY + 0.014, wingZ + 0.094),
    new THREE.Vector3(wingHalf, wingY + 0.012, wingZ + 0.092),
  ], 0.0105), { detail: 1, tint: 1.08 });
  // Twin pylons down to the engine cover.
  b.pair('metal', tube([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0.105, -0.014),
    new THREE.Vector3(0, 0.210, -0.022),
  ], 0.019, 8), { pos: [0.115, floor + 0.335, wingZ + 0.010], tint: 0.85, detail: 0 });

  // --- extra panel definition -------------------------------------------
  // Two more gaps: across the nose and along the engine cover shoulder.
  const noseGap = roundedBox(0.30, 0.018, 0.011, 3.0);
  b.add('plastic', noseGap, { pos: [0, floor + 0.150, fz - 0.155], tint: 0.15, detail: 2 });
  b.pair('plastic', panelGapStrip(0.42), { pos: [0.148, floor + 0.345, rz + 0.02], tint: 0.15, detail: 2 });

  const steer = steeringWheelGeom(0.125);
  return {
    steering: { ...steer, pos: new THREE.Vector3(0, floor + 0.36, fz + 0.30), tilt: -32, radius: 0.125 },
    driver: { pos: new THREE.Vector3(0, floor + 0.16, 0.02), leanDeg: 4, scale: 1 },
    sockets: {
      exhaustL: new THREE.Vector3(), exhaustR: new THREE.Vector3(),
      itemMount: new THREE.Vector3(0, floor + 0.30, rz + 0.30),
      rearCentre: new THREE.Vector3(0, floor + 0.10, rz + 0.30),
    },
    singleFront: false,
    wheelScale: [1, 1, 1.06, 1.06],
    suspension: 'arm',
  };
}

// ---------------------------------------------------------------------------
// 2. SPORT BIKE — leaning trike, single front wheel, fairing, exhaust cans
// ---------------------------------------------------------------------------

function buildBike(c: BuildCtx): Partial<BodyBuildResult> {
  const { b, f } = c;
  const fz = f.frontZ, rz = f.rearZ;
  const base = f.wheelRadius * 0.62;

  // --- fairing / nose ----------------------------------------------------
  const fairing = loft([
    { z: fz - 0.34, y: base + 0.24, hw: 0.075, hUp: 0.075, hDown: 0.070, eSide: 2.4, eTop: 2.2, eBot: 2.6 },
    { z: fz - 0.22, y: base + 0.235, hw: 0.135, hUp: 0.115, hDown: 0.105, eSide: 2.8, eTop: 2.4 },
    { z: fz - 0.06, y: base + 0.225, hw: 0.185, hUp: 0.135, hDown: 0.130, eSide: 3.2, eTop: 2.8 },
    { z: fz + 0.12, y: base + 0.215, hw: 0.205, hUp: 0.130, hDown: 0.140, eSide: 3.4, eTop: 3.0 },
    { z: fz + 0.30, y: base + 0.205, hw: 0.180, hUp: 0.105, hDown: 0.125, eSide: 3.2, eTop: 2.8 },
  ], { segments: 24, uRepeat: 1.6 });
  b.add('paint', fairing, { detail: 0 });

  // windscreen
  const screen = loft([
    { z: fz - 0.30, y: 0, hw: 0.062, hUp: 0.006, hDown: 0.006, eSide: 2.4 },
    { z: fz - 0.20, y: 0.055, hw: 0.085, hUp: 0.006, hDown: 0.006, eSide: 2.6 },
    { z: fz - 0.11, y: 0.085, hw: 0.075, hUp: 0.005, hDown: 0.005, eSide: 2.4 },
  ], { segments: 14 });
  b.add('glass', screen, { pos: [0, base + 0.325, 0], detail: 1 });

  // --- tank / spine ------------------------------------------------------
  const tank = loft([
    { z: fz + 0.24, y: base + 0.30, hw: 0.115, hUp: 0.080, hDown: 0.085, eSide: 2.8, eTop: 2.6 },
    { z: fz + 0.46, y: base + 0.315, hw: 0.155, hUp: 0.095, hDown: 0.100, eSide: 3.2, eTop: 2.8 },
    { z: 0.06, y: base + 0.305, hw: 0.145, hUp: 0.085, hDown: 0.105, eSide: 3.0, eTop: 2.6 },
    { z: 0.24, y: base + 0.285, hw: 0.105, hUp: 0.060, hDown: 0.095, eSide: 2.6, eTop: 2.4 },
  ], { segments: 22, uRepeat: 1.4 });
  b.add('paint', tank, { detail: 0 });

  // --- rear seat hump + tail --------------------------------------------
  const tail = loft([
    { z: 0.22, y: base + 0.27, hw: 0.115, hUp: 0.055, hDown: 0.090, eSide: 2.8, eTop: 2.6 },
    { z: rz - 0.16, y: base + 0.275, hw: 0.150, hUp: 0.075, hDown: 0.105, eSide: 3.2, eTop: 2.8 },
    { z: rz + 0.06, y: base + 0.285, hw: 0.140, hUp: 0.080, hDown: 0.100, eSide: 3.2, eTop: 3.0 },
    { z: rz + 0.24, y: base + 0.29, hw: 0.098, hUp: 0.058, hDown: 0.070, eSide: 2.8, eTop: 2.6 },
  ], { segments: 20 });
  b.add('paint2', tail, { detail: 0 });

  // --- frame spars connecting to the rear axle ---------------------------
  const spar = tube([
    new THREE.Vector3(0.09, base + 0.26, fz + 0.40),
    new THREE.Vector3(0.20, base + 0.18, 0.10),
    new THREE.Vector3(0.24, base + 0.06, rz - 0.05),
  ], 0.026, 8);
  b.pair('metal', spar, { detail: 0, tint: 0.9 });
  const swing = tube([
    new THREE.Vector3(0.13, base + 0.06, 0.16),
    new THREE.Vector3(f.trackHalfRear * 0.92, 0.0, rz),
  ], 0.030, 8);
  b.pair('metal', swing, { detail: 0 });

  // --- front forks + single wheel mount ----------------------------------
  const fork = tube([
    new THREE.Vector3(0.02, base + 0.30, fz - 0.12),
    new THREE.Vector3(0.055, base + 0.10, fz - 0.05),
    new THREE.Vector3(0.075, -0.02, fz + 0.00),
  ], 0.026, 8);
  b.pair('chrome', fork, { detail: 0 });
  const yoke = roundedBox(0.19, 0.032, 0.075, 3.4);
  b.add('metal', yoke, { pos: [0, base + 0.315, fz - 0.115], detail: 1 });

  // handlebars (this chassis steers with bars, not a wheel)
  const bar = tube([
    new THREE.Vector3(-0.215, base + 0.335, fz + 0.03),
    new THREE.Vector3(-0.10, base + 0.36, fz - 0.02),
    new THREE.Vector3(0, base + 0.365, fz - 0.03),
    new THREE.Vector3(0.10, base + 0.36, fz - 0.02),
    new THREE.Vector3(0.215, base + 0.335, fz + 0.03),
  ], 0.017, 8, 30);
  b.add('chrome', bar, { detail: 0 });
  const grip = lathe([
    new THREE.Vector2(0.023, 0), new THREE.Vector2(0.026, 0.01),
    new THREE.Vector2(0.026, 0.085), new THREE.Vector2(0.021, 0.095),
  ], 12);
  grip.rotateZ(78 * DEG);
  b.pair('rubber', grip, { pos: [0.135, base + 0.345, fz + 0.005], detail: 1, tint: 0.6 });

  // --- exhaust cans ------------------------------------------------------
  const can = lathe([
    new THREE.Vector2(0, 0), new THREE.Vector2(0.040, 0.005), new THREE.Vector2(0.046, 0.03),
    new THREE.Vector2(0.046, 0.30), new THREE.Vector2(0.052, 0.325), new THREE.Vector2(0.046, 0.345),
    new THREE.Vector2(0.030, 0.348), new THREE.Vector2(0, 0.348),
  ], 18);
  can.rotateX(96 * DEG);
  b.pair('chrome', can, { pos: [0.145, base + 0.12, rz - 0.02], rot: [0, -5, 0], detail: 0 });
  const canTip = disc(0.030, 0.012, 0, 14);
  b.pair('plastic', canTip, { pos: [0.152, base + 0.155, rz + 0.315], tint: 0.10, detail: 1 });
  const header = tube([
    new THREE.Vector3(0.06, base + 0.20, fz + 0.52),
    new THREE.Vector3(0.12, base + 0.14, 0.05),
    new THREE.Vector3(0.145, base + 0.115, rz - 0.06),
  ], 0.019, 8);
  b.pair('chrome', header, { detail: 1, tint: 0.8 });

  // --- engine block ------------------------------------------------------
  const eng = superShape(0.115, 0.100, 0.145, 4.0, 3.8, 16, 10);
  b.add('metal', eng, { pos: [0, base + 0.10, fz + 0.55], tint: 0.8, detail: 1 });
  for (let i = 0; i < 4; i++) {
    const fin = roundedBox(0.235, 0.014, 0.024, 3.0);
    b.add('chrome', fin, { pos: [0, base + 0.045 + i * 0.042, fz + 0.55], tint: 1.05, detail: 2 });
  }

  // --- lights ------------------------------------------------------------
  const lensGeom = lathe([
    new THREE.Vector2(1e-4, -0.034), new THREE.Vector2(0.048, -0.026),
    new THREE.Vector2(0.055, 0.0), new THREE.Vector2(1e-4, 0.0),
  ], 16);
  lensGeom.rotateX(90 * DEG);
  b.add('lightFront', lensGeom, { pos: [0, base + 0.235, fz - 0.345], rot: [-6, 0, 0], detail: 0 });
  tailLight(b, 0.052, base + 0.30, rz + 0.255, 0.070, 0.045);
  numberPlate(b, 0, base + 0.13, rz + 0.30, 0.16, 2);

  // seat pad
  const pad = superShape(0.115, 0.032, 0.185, 3.0, 2.8, 16, 8);
  b.add('seat', pad, { pos: [0, base + 0.36, 0.10], rot: [-5, 0, 0], detail: 1 });
  const padRear = superShape(0.095, 0.030, 0.10, 3.0, 2.8, 14, 8);
  b.add('seat', padRear, { pos: [0, base + 0.375, rz - 0.20], rot: [-8, 0, 0], detail: 2 });

  return {
    steering: null,
    driver: { pos: new THREE.Vector3(0, base + 0.375, 0.08), leanDeg: 26, scale: 0.97 },
    sockets: {
      itemMount: new THREE.Vector3(0, base + 0.40, rz + 0.10),
      rearCentre: new THREE.Vector3(0, base + 0.26, rz + 0.30),
    },
    singleFront: true,
    wheelScale: [1.02, 1.02, 1.10, 1.10],
    suspension: 'none',
  };
}

// ---------------------------------------------------------------------------
// 3. HEAVY CRUISER — wide, exposed V-twin, fat rears, chrome pipes
// ---------------------------------------------------------------------------

function buildCruiser(c: BuildCtx): Partial<BodyBuildResult> {
  const { b, f } = c;
  const fz = f.frontZ, rz = f.rearZ;
  const base = f.wheelRadius * 0.55;

  // --- big teardrop tank / body -----------------------------------------
  const body = loft([
    { z: fz - 0.42, y: base + 0.16, hw: 0.115, hUp: 0.075, hDown: 0.070, eSide: 2.6, eTop: 2.4 },
    { z: fz - 0.24, y: base + 0.17, hw: 0.215, hUp: 0.120, hDown: 0.105, eSide: 3.0, eTop: 2.6 },
    { z: fz + 0.02, y: base + 0.185, hw: 0.315, hUp: 0.165, hDown: 0.140, eSide: 3.4, eTop: 2.8 },
    { z: fz + 0.34, y: base + 0.19, hw: 0.375, hUp: 0.180, hDown: 0.150, eSide: 3.8, eTop: 3.0, eBot: 4.4 },
    { z: 0.12, y: base + 0.185, hw: 0.395, hUp: 0.170, hDown: 0.150, eSide: 4.2, eTop: 3.2, eBot: 4.8 },
    { z: rz - 0.22, y: base + 0.18, hw: 0.415, hUp: 0.160, hDown: 0.145, eSide: 4.4, eTop: 3.4 },
    { z: rz + 0.06, y: base + 0.185, hw: 0.400, hUp: 0.150, hDown: 0.130, eSide: 4.2, eTop: 3.2 },
    { z: rz + 0.28, y: base + 0.19, hw: 0.330, hUp: 0.115, hDown: 0.100, eSide: 3.4, eTop: 2.8 },
  ], { segments: 26, uRepeat: 2, vRepeat: 2 });
  b.add('paint', body, { detail: 0 });

  // --- exposed V-twin ----------------------------------------------------
  const jugProfile: THREE.Vector2[] = [
    new THREE.Vector2(0, 0), new THREE.Vector2(0.062, 0.0), new THREE.Vector2(0.066, 0.03),
    new THREE.Vector2(0.058, 0.05), new THREE.Vector2(0.062, 0.20), new THREE.Vector2(0.072, 0.215),
    new THREE.Vector2(0.058, 0.24), new THREE.Vector2(0, 0.245),
  ];
  for (const sgn of [-1, 1]) {
    const jug = lathe(jugProfile, 16);
    b.add('metal', jug, { pos: [0, base + 0.02, fz + 0.34 + sgn * 0.0], rot: [sgn * 34, 0, 0], tint: 0.9, detail: 0 });
    for (let i = 0; i < 6; i++) {
      const fin = lathe([
        new THREE.Vector2(0.060, 0), new THREE.Vector2(0.086, 0.004),
        new THREE.Vector2(0.086, 0.014), new THREE.Vector2(0.060, 0.018),
      ], 14);
      const m = new THREE.Matrix4().makeRotationX(sgn * 34 * DEG);
      fin.translate(0, 0.055 + i * 0.028, 0);
      fin.applyMatrix4(m);
      b.add('chrome', fin, { pos: [0, base + 0.02, fz + 0.34], tint: 1.1, detail: 2 });
    }
    const head = superShape(0.070, 0.036, 0.070, 3.4, 3.2, 14, 8);
    const hm = new THREE.Matrix4().makeRotationX(sgn * 34 * DEG);
    head.translate(0, 0.255, 0);
    head.applyMatrix4(hm);
    b.add('chrome', head, { pos: [0, base + 0.02, fz + 0.34], detail: 1 });
  }
  const crank = lathe([
    new THREE.Vector2(0, 0), new THREE.Vector2(0.105, 0), new THREE.Vector2(0.112, 0.03),
    new THREE.Vector2(0.105, 0.055), new THREE.Vector2(0, 0.058),
  ], 18);
  crank.rotateZ(90 * DEG);
  b.add('chrome', crank, { pos: [-0.028, base + 0.02, fz + 0.34], detail: 0 });

  // --- fat fenders -------------------------------------------------------
  for (const sgn of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = (0.08 + (i / 10) * 0.84) * Math.PI;
      pts.push(new THREE.Vector3(
        sgn * f.trackHalfRear,
        f.wheelRadius * 1.30 * Math.sin(a) * 0.86 + 0.02,
        rz - Math.cos(a) * f.wheelRadius * 1.28,
      ));
    }
    const fender = tube(pts, 0.075, 10, 26);
    b.add('paint2', fender, { detail: 0 });
  }

  // --- pull-back bars ----------------------------------------------------
  const apeBar = tube([
    new THREE.Vector3(-0.30, base + 0.34, fz + 0.02),
    new THREE.Vector3(-0.24, base + 0.46, fz - 0.06),
    new THREE.Vector3(-0.09, base + 0.50, fz - 0.13),
    new THREE.Vector3(0.09, base + 0.50, fz - 0.13),
    new THREE.Vector3(0.24, base + 0.46, fz - 0.06),
    new THREE.Vector3(0.30, base + 0.34, fz + 0.02),
  ], 0.021, 9, 36);
  b.add('chrome', apeBar, { detail: 0 });
  const grip = lathe([
    new THREE.Vector2(0.027, 0), new THREE.Vector2(0.030, 0.012),
    new THREE.Vector2(0.030, 0.10), new THREE.Vector2(0.024, 0.112),
  ], 12);
  grip.rotateZ(70 * DEG);
  b.pair('rubber', grip, { pos: [0.20, base + 0.40, fz - 0.02], detail: 1, tint: 0.6 });

  // --- chrome pipes ------------------------------------------------------
  for (const sgn of [-1, 1]) {
    const path = [
      new THREE.Vector3(sgn * 0.10, base + 0.16, fz + 0.24),
      new THREE.Vector3(sgn * 0.28, base + 0.09, fz + 0.44),
      new THREE.Vector3(sgn * 0.36, base + 0.06, 0.10),
      new THREE.Vector3(sgn * 0.375, base + 0.075, rz + 0.30),
    ];
    const pipe = tube(path, 0.030, 10, 30);
    b.add('chrome', pipe, { detail: 0 });
    const tip = lathe([
      new THREE.Vector2(0.028, 0), new THREE.Vector2(0.048, 0.012),
      new THREE.Vector2(0.048, 0.09), new THREE.Vector2(0.038, 0.09), new THREE.Vector2(0.032, 0),
    ], 16);
    tip.rotateX(90 * DEG);
    b.add('chrome', tip, { pos: [sgn * 0.375, base + 0.075, rz + 0.30], detail: 1 });
    const inner = disc(0.036, 0.01, 0, 14);
    b.add('plastic', inner, { pos: [sgn * 0.375, base + 0.075, rz + 0.385], tint: 0.10, detail: 1 });
  }

  // --- bench seat + backrest --------------------------------------------
  seatAssembly(b, 0, base + 0.34, 0.06, 0.40, 0.24, -4, 1);
  const sissy = tube([
    new THREE.Vector3(-0.16, base + 0.36, rz - 0.02),
    new THREE.Vector3(-0.17, base + 0.62, rz - 0.05),
    new THREE.Vector3(0, base + 0.68, rz - 0.06),
    new THREE.Vector3(0.17, base + 0.62, rz - 0.05),
    new THREE.Vector3(0.16, base + 0.36, rz - 0.02),
  ], 0.019, 8, 30);
  b.add('chrome', sissy, { detail: 1 });

  // --- headlamp nacelle + lights ----------------------------------------
  const nacelle = lathe([
    new THREE.Vector2(0, 0), new THREE.Vector2(0.088, 0.004), new THREE.Vector2(0.098, 0.035),
    new THREE.Vector2(0.092, 0.075), new THREE.Vector2(0.06, 0.09), new THREE.Vector2(0, 0.092),
  ], 20);
  nacelle.rotateX(90 * DEG);
  b.add('chrome', nacelle, { pos: [0, base + 0.235, fz - 0.32], detail: 0 });
  const lens = lathe([
    new THREE.Vector2(1e-4, -0.042), new THREE.Vector2(0.072, -0.032),
    new THREE.Vector2(0.082, 0), new THREE.Vector2(1e-4, 0),
  ], 18);
  lens.rotateX(90 * DEG);
  b.add('lightFront', lens, { pos: [0, base + 0.235, fz - 0.40], detail: 0 });
  headlight(b, 0.20, base + 0.215, fz - 0.30, 0.042, 2);
  tailLight(b, 0.10, base + 0.24, rz + 0.30, 0.085, 0.055);

  // studded leather detail
  for (let i = 0; i < 6; i++) {
    const r = rivet(0.011, 0.007);
    b.pair('chrome', r, { pos: [0.055 + i * 0.006, base + 0.36, -0.06 - i * 0.03], rot: [-90, 0, 0], detail: 2 });
  }

  return {
    steering: null,
    driver: { pos: new THREE.Vector3(0, base + 0.375, 0.05), leanDeg: -6, scale: 1.05 },
    sockets: {
      itemMount: new THREE.Vector3(0, base + 0.44, rz + 0.16),
      rearCentre: new THREE.Vector3(0, base + 0.20, rz + 0.34),
    },
    singleFront: false,
    wheelScale: [0.94, 0.94, 1.22, 1.22],
    suspension: 'coilover',
  };
}

// ---------------------------------------------------------------------------
// 4. SPEEDSTER — low F1 wedge, rear wing, pontoons
// ---------------------------------------------------------------------------

function buildSpeedster(c: BuildCtx): Partial<BodyBuildResult> {
  const { b, f } = c;
  const fz = f.frontZ, rz = f.rearZ;
  const low = f.wheelRadius * 0.34;

  // --- monocoque wedge ---------------------------------------------------
  const mono = loft([
    { z: fz - 0.60, y: low + 0.045, hw: 0.048, hUp: 0.026, hDown: 0.024, eSide: 2.2, eTop: 2.2 },
    { z: fz - 0.46, y: low + 0.055, hw: 0.088, hUp: 0.040, hDown: 0.034, eSide: 2.6 },
    { z: fz - 0.28, y: low + 0.070, hw: 0.135, hUp: 0.058, hDown: 0.046, eSide: 2.8, eTop: 2.6 },
    { z: fz - 0.06, y: low + 0.085, hw: 0.195, hUp: 0.082, hDown: 0.058, eSide: 3.2, eTop: 2.8 },
    { z: fz + 0.22, y: low + 0.090, hw: 0.245, hUp: 0.105, hDown: 0.062, eSide: 3.6, eTop: 3.0, eBot: 5.0 },
    { z: 0.06, y: low + 0.090, hw: 0.255, hUp: 0.120, hDown: 0.062, eSide: 4.0, eTop: 3.2, eBot: 5.4 },
    { z: rz - 0.26, y: low + 0.090, hw: 0.240, hUp: 0.135, hDown: 0.060, eSide: 4.0, eTop: 3.4 },
    { z: rz + 0.02, y: low + 0.095, hw: 0.205, hUp: 0.130, hDown: 0.055, eSide: 3.6, eTop: 3.2 },
    { z: rz + 0.22, y: low + 0.095, hw: 0.145, hUp: 0.100, hDown: 0.045, eSide: 3.0, eTop: 2.8 },
  ], { segments: 26, uRepeat: 2, vRepeat: 2.6 });
  b.add('paint', mono, { detail: 0 });

  // --- front wing --------------------------------------------------------
  const mainPlane = extrude([
    new THREE.Vector2(-0.20, -0.012), new THREE.Vector2(0.20, -0.028),
    new THREE.Vector2(0.20, 0.010), new THREE.Vector2(-0.20, 0.020),
  ], f.trackHalfFront * 1.75, 0.008);
  mainPlane.rotateY(90 * DEG);
  b.add('paint2', mainPlane, { pos: [0, low + 0.010, fz - 0.60], detail: 0 });
  const flap = extrude([
    new THREE.Vector2(-0.09, -0.006), new THREE.Vector2(0.09, -0.016),
    new THREE.Vector2(0.09, 0.006), new THREE.Vector2(-0.09, 0.012),
  ], f.trackHalfFront * 1.6, 0.006);
  flap.rotateY(90 * DEG);
  b.add('plastic', flap, { pos: [0, low + 0.055, fz - 0.66], rot: [-10, 0, 0], tint: 0.3, detail: 1 });
  for (const sgn of [-1, 1]) {
    const plate = extrude([
      new THREE.Vector2(-0.115, -0.02), new THREE.Vector2(0.10, -0.02),
      new THREE.Vector2(0.10, 0.10), new THREE.Vector2(-0.115, 0.12),
    ], 0.014, 0.006);
    b.add('paint2', plate, { pos: [sgn * f.trackHalfFront * 0.88, low + 0.045, fz - 0.60], detail: 0 });
  }

  // --- pontoons / sidepods ----------------------------------------------
  const pontoon = loft([
    { z: fz + 0.12, y: 0, hw: 0.048, hUp: 0.052, hDown: 0.044, eSide: 2.6, eTop: 2.6 },
    { z: fz + 0.34, y: 0.006, hw: 0.098, hUp: 0.080, hDown: 0.062, eSide: 3.2, eTop: 2.8 },
    { z: 0.10, y: 0.006, hw: 0.105, hUp: 0.082, hDown: 0.062, eSide: 3.6, eTop: 3.0 },
    { z: rz - 0.30, y: 0.002, hw: 0.086, hUp: 0.062, hDown: 0.050, eSide: 3.0, eTop: 2.8 },
    { z: rz - 0.14, y: 0.0, hw: 0.052, hUp: 0.040, hDown: 0.034, eSide: 2.6, eTop: 2.6 },
  ], { segments: 22, uRepeat: 1.6 });
  b.pair('paint', pontoon, { pos: [f.trackHalfFront * 0.82, low + 0.075, 0], detail: 0 });

  // pontoon intake mouth
  const mouth = lathe([
    new THREE.Vector2(0.026, 0), new THREE.Vector2(0.056, 0.006),
    new THREE.Vector2(0.056, 0.040), new THREE.Vector2(0.026, 0.046),
  ], 16);
  mouth.rotateX(90 * DEG);
  b.pair('plastic', mouth, { pos: [f.trackHalfFront * 0.82, low + 0.095, fz + 0.10], tint: 0.22, detail: 1 });

  // --- airbox behind the head -------------------------------------------
  const airbox = loft([
    { z: rz - 0.52, y: low + 0.16, hw: 0.062, hUp: 0.075, hDown: 0.070, eSide: 2.4, eTop: 2.2 },
    { z: rz - 0.34, y: low + 0.175, hw: 0.085, hUp: 0.098, hDown: 0.085, eSide: 2.8, eTop: 2.6 },
    { z: rz - 0.10, y: low + 0.16, hw: 0.098, hUp: 0.088, hDown: 0.082, eSide: 3.0, eTop: 2.8 },
    { z: rz + 0.12, y: low + 0.14, hw: 0.072, hUp: 0.062, hDown: 0.062, eSide: 2.6 },
  ], { segments: 20 });
  b.add('paint2', airbox, { detail: 0 });
  const inlet = lathe([
    new THREE.Vector2(0.030, 0), new THREE.Vector2(0.056, 0.004),
    new THREE.Vector2(0.056, 0.034), new THREE.Vector2(0.030, 0.040),
  ], 16);
  inlet.rotateX(-90 * DEG);
  b.add('plastic', inlet, { pos: [0, low + 0.245, rz - 0.50], tint: 0.2, detail: 1 });

  // --- rear wing ---------------------------------------------------------
  const wingMain = extrude([
    new THREE.Vector2(-0.115, 0.0), new THREE.Vector2(0.115, -0.022),
    new THREE.Vector2(0.115, 0.012), new THREE.Vector2(-0.115, 0.030),
  ], f.trackHalfRear * 1.55, 0.008);
  wingMain.rotateY(90 * DEG);
  b.add('paint2', wingMain, { pos: [0, low + 0.36, rz + 0.30], rot: [-9, 0, 0], detail: 0 });
  const wingFlap = extrude([
    new THREE.Vector2(-0.055, 0.0), new THREE.Vector2(0.055, -0.010),
    new THREE.Vector2(0.055, 0.008), new THREE.Vector2(-0.055, 0.014),
  ], f.trackHalfRear * 1.5, 0.005);
  wingFlap.rotateY(90 * DEG);
  b.add('plastic', wingFlap, { pos: [0, low + 0.425, rz + 0.35], rot: [-18, 0, 0], tint: 0.3, detail: 1 });
  for (const sgn of [-1, 1]) {
    const ep = extrude([
      new THREE.Vector2(-0.12, -0.075), new THREE.Vector2(0.13, -0.055),
      new THREE.Vector2(0.13, 0.10), new THREE.Vector2(-0.12, 0.085),
    ], 0.013, 0.005);
    b.add('paint', ep, { pos: [sgn * f.trackHalfRear * 0.78, low + 0.375, rz + 0.31], detail: 0 });
  }
  const pylon = extrude([
    new THREE.Vector2(-0.09, 0), new THREE.Vector2(0.09, 0),
    new THREE.Vector2(0.05, 0.20), new THREE.Vector2(-0.05, 0.20),
  ], 0.030, 0.006);
  b.add('metal', pylon, { pos: [0, low + 0.16, rz + 0.26], detail: 0, tint: 0.6 });

  // --- diffuser ----------------------------------------------------------
  const diff = loft([
    { z: rz - 0.14, y: 0, hw: 0.20, hUp: 0.014, hDown: 0.012, eSide: 4.0 },
    { z: rz + 0.20, y: 0.038, hw: 0.235, hUp: 0.016, hDown: 0.014, eSide: 4.4 },
  ], { segments: 16 });
  b.add('plastic', diff, { pos: [0, low - 0.010, 0], tint: 0.25, detail: 1 });
  for (let i = -2; i <= 2; i++) {
    const strake = roundedBox(0.012, 0.055, 0.30, 3.0);
    b.add('plastic', strake, { pos: [i * 0.085, low + 0.012, rz + 0.04], rot: [-7, 0, 0], tint: 0.18, detail: 2 });
  }

  // --- exposed pushrods --------------------------------------------------
  for (const sgn of [-1, 1]) {
    for (const [z, len] of [[fz, f.trackHalfFront], [rz, f.trackHalfRear]] as Array<[number, number]>) {
      const rod = tube([
        new THREE.Vector3(sgn * 0.10, low + 0.10, z),
        new THREE.Vector3(sgn * len * 0.92, low - 0.005, z),
      ], 0.015, 7);
      b.add('metal', rod, { detail: 1, tint: 0.8 });
    }
  }

  // --- cockpit + halo ----------------------------------------------------
  seatAssembly(b, 0, low + 0.105, -0.02, 0.24, 0.16, -14, 1);
  const halo = tube([
    new THREE.Vector3(-0.235, low + 0.115, rz - 0.60),
    new THREE.Vector3(-0.205, low + 0.245, fz + 0.42),
    new THREE.Vector3(0, low + 0.265, fz + 0.24),
    new THREE.Vector3(0.205, low + 0.245, fz + 0.42),
    new THREE.Vector3(0.235, low + 0.115, rz - 0.60),
  ], 0.023, 8, 34);
  b.add('metal', halo, { detail: 0, tint: 0.5 });
  const haloStrut = tube([
    new THREE.Vector3(0, low + 0.26, fz + 0.24),
    new THREE.Vector3(0, low + 0.16, fz + 0.10),
  ], 0.018, 7);
  b.add('metal', haloStrut, { detail: 1, tint: 0.5 });

  headlight(b, 0.10, low + 0.075, fz - 0.46, 0.034, 2);
  tailLight(b, 0.075, low + 0.10, rz + 0.24, 0.070, 0.040);
  numberPlate(b, 0, low + 0.145, fz - 0.20, 0.15, 2);

  const steer = steeringWheelGeom(0.098);
  return {
    steering: { ...steer, pos: new THREE.Vector3(0, low + 0.235, fz + 0.26), tilt: -20, radius: 0.098 },
    driver: { pos: new THREE.Vector3(0, low + 0.135, 0.0), leanDeg: 16, scale: 0.95 },
    sockets: {
      itemMount: new THREE.Vector3(0, low + 0.26, rz + 0.10),
      rearCentre: new THREE.Vector3(0, low + 0.10, rz + 0.28),
    },
    singleFront: false,
    wheelScale: [0.94, 0.94, 1.16, 1.16],
    suspension: 'arm',
  };
}

// ---------------------------------------------------------------------------
// 5. BUGGY — high suspension, tube frame, light bar, knobbly tyres
// ---------------------------------------------------------------------------

function buildBuggy(c: BuildCtx): Partial<BodyBuildResult> {
  const { b, f } = c;
  const fz = f.frontZ, rz = f.rearZ;
  const deck = f.wheelRadius * 1.02;

  // --- body tub ----------------------------------------------------------
  const tub = loft([
    { z: fz - 0.20, y: deck + 0.06, hw: 0.185, hUp: 0.075, hDown: 0.070, eSide: 3.0, eTop: 2.8 },
    { z: fz + 0.04, y: deck + 0.055, hw: 0.275, hUp: 0.095, hDown: 0.085, eSide: 3.6, eTop: 3.0 },
    { z: fz + 0.30, y: deck + 0.05, hw: 0.315, hUp: 0.110, hDown: 0.090, eSide: 4.2, eTop: 3.4, eBot: 5.0 },
    { z: 0.10, y: deck + 0.05, hw: 0.320, hUp: 0.115, hDown: 0.090, eSide: 4.4, eTop: 3.6, eBot: 5.4 },
    { z: rz - 0.16, y: deck + 0.055, hw: 0.305, hUp: 0.120, hDown: 0.085, eSide: 4.2, eTop: 3.4 },
    { z: rz + 0.10, y: deck + 0.06, hw: 0.255, hUp: 0.105, hDown: 0.075, eSide: 3.4, eTop: 3.0 },
  ], { segments: 24, uRepeat: 2, vRepeat: 2 });
  b.add('paint', tub, { detail: 0 });

  // --- skid plate / bash bar --------------------------------------------
  const skid = loft([
    { z: fz - 0.32, y: 0.03, hw: 0.20, hUp: 0.016, hDown: 0.014, eSide: 3.6 },
    { z: fz - 0.02, y: 0.0, hw: 0.28, hUp: 0.018, hDown: 0.016, eSide: 4.2 },
    { z: 0.10, y: 0.0, hw: 0.29, hUp: 0.018, hDown: 0.016, eSide: 4.4 },
    { z: rz + 0.10, y: 0.02, hw: 0.25, hUp: 0.016, hDown: 0.014, eSide: 3.8 },
  ], { segments: 16 });
  b.add('metal', skid, { pos: [0, deck - 0.035, 0], tint: 0.62, detail: 1 });

  // --- tube roll cage ----------------------------------------------------
  const cageR = 0.030;
  const hoopMain = tube([
    new THREE.Vector3(-0.325, deck + 0.06, rz - 0.30),
    new THREE.Vector3(-0.345, deck + 0.36, rz - 0.34),
    new THREE.Vector3(-0.26, deck + 0.55, rz - 0.36),
    new THREE.Vector3(0, deck + 0.585, rz - 0.37),
    new THREE.Vector3(0.26, deck + 0.55, rz - 0.36),
    new THREE.Vector3(0.345, deck + 0.36, rz - 0.34),
    new THREE.Vector3(0.325, deck + 0.06, rz - 0.30),
  ], cageR, 9, 42);
  b.add('metal', hoopMain, { detail: 0, tint: 0.95 });
  const hoopFront = tube([
    new THREE.Vector3(-0.30, deck + 0.06, fz + 0.12),
    new THREE.Vector3(-0.31, deck + 0.28, fz + 0.10),
    new THREE.Vector3(-0.22, deck + 0.42, fz + 0.06),
    new THREE.Vector3(0, deck + 0.45, fz + 0.05),
    new THREE.Vector3(0.22, deck + 0.42, fz + 0.06),
    new THREE.Vector3(0.31, deck + 0.28, fz + 0.10),
    new THREE.Vector3(0.30, deck + 0.06, fz + 0.12),
  ], cageR * 0.92, 9, 40);
  b.add('metal', hoopFront, { detail: 0, tint: 0.95 });
  for (const sgn of [-1, 1]) {
    const rail = tube([
      new THREE.Vector3(sgn * 0.245, deck + 0.435, fz + 0.06),
      new THREE.Vector3(sgn * 0.275, deck + 0.55, rz - 0.36),
    ], cageR * 0.85, 8);
    b.add('metal', rail, { detail: 0, tint: 0.9 });
    const backStay = tube([
      new THREE.Vector3(sgn * 0.32, deck + 0.44, rz - 0.35),
      new THREE.Vector3(sgn * 0.30, deck + 0.10, rz + 0.16),
    ], cageR * 0.8, 8);
    b.add('metal', backStay, { detail: 1, tint: 0.85 });
    const doorBar = tube([
      new THREE.Vector3(sgn * 0.305, deck + 0.08, fz + 0.14),
      new THREE.Vector3(sgn * 0.345, deck + 0.20, 0.0),
      new THREE.Vector3(sgn * 0.325, deck + 0.09, rz - 0.30),
    ], cageR * 0.75, 8, 22);
    b.add('metal', doorBar, { detail: 1, tint: 0.9 });
  }

  // --- light bar ---------------------------------------------------------
  const barBody = roundedBox(0.60, 0.070, 0.070, 3.6);
  b.add('plastic', barBody, { pos: [0, deck + 0.50, fz + 0.02], tint: 0.35, detail: 0 });
  for (let i = -2; i <= 2; i++) {
    const lampHousing = lathe([
      new THREE.Vector2(0, 0), new THREE.Vector2(0.048, 0.002), new THREE.Vector2(0.052, 0.024),
      new THREE.Vector2(0.040, 0.040), new THREE.Vector2(0, 0.042),
    ], 14);
    lampHousing.rotateX(90 * DEG);
    b.add('metal', lampHousing, { pos: [i * 0.118, deck + 0.50, fz + 0.02], tint: 0.7, detail: 1 });
    const lens = lathe([
      new THREE.Vector2(1e-4, -0.026), new THREE.Vector2(0.036, -0.020),
      new THREE.Vector2(0.042, 0), new THREE.Vector2(1e-4, 0),
    ], 14);
    lens.rotateX(90 * DEG);
    b.add('lightFront', lens, { pos: [i * 0.118, deck + 0.50, fz - 0.014], detail: 0 });
  }

  // --- coilover shock towers (visual) -----------------------------------
  for (const sgn of [-1, 1]) {
    const tower = tube([
      new THREE.Vector3(sgn * 0.20, deck + 0.06, fz + 0.04),
      new THREE.Vector3(sgn * 0.235, deck + 0.30, fz + 0.02),
    ], 0.026, 8);
    b.add('metal', tower, { detail: 1, tint: 0.8 });
    const towerR = tube([
      new THREE.Vector3(sgn * 0.22, deck + 0.06, rz - 0.24),
      new THREE.Vector3(sgn * 0.255, deck + 0.34, rz - 0.28),
    ], 0.026, 8);
    b.add('metal', towerR, { detail: 1, tint: 0.8 });
  }

  // --- spare wheel carrier + jerrycan ------------------------------------
  const carrier = tube([
    new THREE.Vector3(-0.20, deck + 0.10, rz + 0.16),
    new THREE.Vector3(-0.22, deck + 0.34, rz + 0.28),
    new THREE.Vector3(0.22, deck + 0.34, rz + 0.28),
    new THREE.Vector3(0.20, deck + 0.10, rz + 0.16),
  ], 0.022, 8, 24);
  b.add('metal', carrier, { detail: 1, tint: 0.8 });
  const can = superShape(0.075, 0.115, 0.045, 4.4, 4.0, 14, 10);
  b.add('paint2', can, { pos: [0.16, deck + 0.20, rz + 0.24], detail: 2 });

  // --- mud flaps ---------------------------------------------------------
  for (const sgn of [-1, 1]) {
    const flap = roundedBox(0.16, 0.14, 0.012, 3.0);
    b.add('rubber', flap, { pos: [sgn * f.trackHalfRear * 0.86, deck * 0.42, rz + 0.30], rot: [-8, 0, 0], tint: 0.55, detail: 2 });
  }

  // --- snorkel -----------------------------------------------------------
  const snorkel = tube([
    new THREE.Vector3(0.28, deck + 0.06, fz + 0.22),
    new THREE.Vector3(0.315, deck + 0.30, fz + 0.16),
    new THREE.Vector3(0.315, deck + 0.46, fz + 0.10),
  ], 0.032, 9);
  b.add('plastic', snorkel, { tint: 0.35, detail: 1 });
  const snorkelMouth = lathe([
    new THREE.Vector2(0.024, 0), new THREE.Vector2(0.046, 0.006),
    new THREE.Vector2(0.046, 0.048), new THREE.Vector2(0.024, 0.054),
  ], 14);
  snorkelMouth.rotateX(-96 * DEG);
  b.add('plastic', snorkelMouth, { pos: [0.315, deck + 0.47, fz + 0.09], tint: 0.22, detail: 2 });

  seatAssembly(b, 0, deck + 0.09, -0.02, 0.30, 0.30, -8, 1);
  tailLight(b, 0.20, deck + 0.10, rz + 0.20, 0.10, 0.075);
  numberPlate(b, 0, deck + 0.24, rz + 0.28, 0.20, 2);

  // exhaust up the side
  const exPath = [
    new THREE.Vector3(-0.14, deck - 0.01, rz - 0.10),
    new THREE.Vector3(-0.30, deck + 0.05, rz + 0.02),
    new THREE.Vector3(-0.335, deck + 0.30, rz + 0.05),
    new THREE.Vector3(-0.335, deck + 0.50, rz + 0.02),
  ];
  exhaust(b, exPath, 0.032, 0.046, 1);

  return {
    steering: { ...steeringWheelGeom(0.128), pos: new THREE.Vector3(0, deck + 0.335, fz + 0.30), tilt: -34, radius: 0.128 },
    driver: { pos: new THREE.Vector3(0, deck + 0.14, 0.0), leanDeg: 2, scale: 1 },
    sockets: {
      itemMount: new THREE.Vector3(0, deck + 0.30, rz + 0.20),
      rearCentre: new THREE.Vector3(0, deck + 0.08, rz + 0.28),
    },
    singleFront: false,
    wheelScale: [1.12, 1.12, 1.20, 1.20],
    suspension: 'coilover',
  };
}

// ---------------------------------------------------------------------------
// 6. HOVER RACER — floating body, glowing thruster vents
// ---------------------------------------------------------------------------

function buildHover(c: BuildCtx): Partial<BodyBuildResult> {
  const { b, f } = c;
  const fz = f.frontZ, rz = f.rearZ;
  const mid = f.wheelRadius * 0.95;

  // --- hull: two stacked lofts, the lower one inset (floating read) ------
  const upper = loft([
    { z: fz - 0.44, y: mid + 0.02, hw: 0.090, hUp: 0.052, hDown: 0.040, eSide: 2.4, eTop: 2.4 },
    { z: fz - 0.26, y: mid + 0.025, hw: 0.195, hUp: 0.080, hDown: 0.058, eSide: 2.8, eTop: 2.6 },
    { z: fz - 0.02, y: mid + 0.030, hw: 0.300, hUp: 0.105, hDown: 0.070, eSide: 3.4, eTop: 2.8 },
    { z: fz + 0.30, y: mid + 0.030, hw: 0.375, hUp: 0.125, hDown: 0.075, eSide: 4.0, eTop: 3.0, eBot: 4.6 },
    { z: 0.10, y: mid + 0.030, hw: 0.395, hUp: 0.140, hDown: 0.075, eSide: 4.4, eTop: 3.2, eBot: 5.0 },
    { z: rz - 0.22, y: mid + 0.030, hw: 0.385, hUp: 0.150, hDown: 0.072, eSide: 4.4, eTop: 3.4 },
    { z: rz + 0.06, y: mid + 0.035, hw: 0.335, hUp: 0.140, hDown: 0.065, eSide: 3.8, eTop: 3.2 },
    { z: rz + 0.26, y: mid + 0.035, hw: 0.235, hUp: 0.100, hDown: 0.050, eSide: 3.0, eTop: 2.8 },
  ], { segments: 26, uRepeat: 2, vRepeat: 2.4 });
  b.add('paint', upper, { detail: 0 });

  const keel = loft([
    { z: fz - 0.18, y: 0, hw: 0.155, hUp: 0.030, hDown: 0.040, eSide: 3.0, eBot: 2.6 },
    { z: 0.05, y: 0, hw: 0.235, hUp: 0.034, hDown: 0.055, eSide: 3.6, eBot: 3.0 },
    { z: rz, y: 0, hw: 0.205, hUp: 0.032, hDown: 0.048, eSide: 3.2, eBot: 2.8 },
  ], { segments: 20 });
  b.add('metal', keel, { pos: [0, mid - 0.055, 0], tint: 0.45, detail: 0 });

  // --- underglow strip ---------------------------------------------------
  const glowStrip = loft([
    { z: fz - 0.10, y: 0, hw: 0.13, hUp: 0.010, hDown: 0.010, eSide: 3.0 },
    { z: 0.10, y: 0, hw: 0.20, hUp: 0.012, hDown: 0.012, eSide: 3.4 },
    { z: rz + 0.02, y: 0, hw: 0.175, hUp: 0.010, hDown: 0.010, eSide: 3.0 },
  ], { segments: 14 });
  b.add('glow', glowStrip, { pos: [0, mid - 0.10, 0], detail: 0 });

  // --- canopy ------------------------------------------------------------
  const canopy = loft([
    { z: fz + 0.22, y: mid + 0.10, hw: 0.155, hUp: 0.030, hDown: 0.020, eSide: 2.6, eTop: 2.4 },
    { z: fz + 0.42, y: mid + 0.11, hw: 0.185, hUp: 0.105, hDown: 0.020, eSide: 3.0, eTop: 2.6 },
    { z: 0.14, y: mid + 0.11, hw: 0.180, hUp: 0.120, hDown: 0.020, eSide: 3.2, eTop: 2.8 },
    { z: rz - 0.30, y: mid + 0.10, hw: 0.140, hUp: 0.075, hDown: 0.018, eSide: 2.6, eTop: 2.4 },
  ], { segments: 20 });
  b.add('glass', canopy, { detail: 0 });

  // --- thruster nacelles at each corner ---------------------------------
  for (const sgn of [-1, 1]) {
    for (const [z, len] of [[fz, 0.16], [rz, 0.20]] as Array<[number, number]>) {
      const nac = loft([
        { z: -len, y: 0, hw: 0.075, hUp: 0.060, hDown: 0.060, eSide: 2.6, eTop: 2.6, eBot: 2.6 },
        { z: 0, y: 0, hw: 0.098, hUp: 0.082, hDown: 0.082, eSide: 3.0, eTop: 3.0, eBot: 3.0 },
        { z: len, y: 0, hw: 0.082, hUp: 0.066, hDown: 0.066, eSide: 2.8, eTop: 2.8, eBot: 2.8 },
      ], { segments: 20 });
      b.add('paint2', nac, { pos: [sgn * (f.trackHalfRear + 0.03), mid - 0.02, z], detail: 0 });
      const ringGeom = new THREE.TorusGeometry(0.072, 0.016, 8, 20);
      b.add('chrome', ringGeom, { pos: [sgn * (f.trackHalfRear + 0.03), mid - 0.06, z], rot: [90, 0, 0], detail: 1 });
      const vent = disc(0.062, 0.014, 0.018, 18);
      b.add('glow', vent, { pos: [sgn * (f.trackHalfRear + 0.03), mid - 0.075, z], rot: [90, 0, 0], detail: 0 });
    }
  }

  // --- rear thruster block ----------------------------------------------
  const block = loft([
    { z: rz - 0.02, y: mid + 0.05, hw: 0.235, hUp: 0.090, hDown: 0.070, eSide: 4.0, eTop: 3.4 },
    { z: rz + 0.20, y: mid + 0.05, hw: 0.215, hUp: 0.082, hDown: 0.062, eSide: 4.0, eTop: 3.4 },
  ], { segments: 20 });
  b.add('metal', block, { tint: 0.5, detail: 0 });
  for (const sgn of [-1, 1]) {
    const nozzle = lathe([
      new THREE.Vector2(0.030, 0), new THREE.Vector2(0.062, 0.01),
      new THREE.Vector2(0.070, 0.055), new THREE.Vector2(0.058, 0.070),
      new THREE.Vector2(0.040, 0.070), new THREE.Vector2(0.036, 0),
    ], 18);
    nozzle.rotateX(-90 * DEG);
    b.add('chrome', nozzle, { pos: [sgn * 0.115, mid + 0.05, rz + 0.20], detail: 0 });
    const core = disc(0.040, 0.012, 0, 16);
    b.add('glow', core, { pos: [sgn * 0.115, mid + 0.05, rz + 0.255], detail: 0 });
  }

  // --- dorsal fin + vents -----------------------------------------------
  const fin = extrude([
    new THREE.Vector2(-0.20, 0), new THREE.Vector2(0.16, 0),
    new THREE.Vector2(0.02, 0.19), new THREE.Vector2(-0.16, 0.17),
  ], 0.026, 0.008);
  b.add('paint2', fin, { pos: [0, mid + 0.16, rz - 0.02], detail: 0 });
  for (let i = 0; i < 4; i++) {
    const louvre = roundedBox(0.16, 0.012, 0.055, 3.0);
    b.pair('glow', louvre, { pos: [0.29, mid + 0.10 + i * 0.026, fz + 0.30 + i * 0.02], rot: [0, 0, -14], detail: 1 });
  }

  // --- nose sensor ring --------------------------------------------------
  const ring = new THREE.TorusGeometry(0.062, 0.014, 8, 20);
  b.add('chrome', ring, { pos: [0, mid + 0.04, fz - 0.40], rot: [90, 0, 0], detail: 1 });
  const eye = disc(0.048, 0.012, 0, 16);
  b.add('lightFront', eye, { pos: [0, mid + 0.04, fz - 0.425], detail: 0 });
  tailLight(b, 0.155, mid + 0.075, rz + 0.30, 0.115, 0.045);

  seatAssembly(b, 0, mid + 0.10, -0.02, 0.26, 0.22, -12, 1);

  return {
    steering: { ...steeringWheelGeom(0.108), pos: new THREE.Vector3(0, mid + 0.26, fz + 0.30), tilt: -26, radius: 0.108 },
    driver: { pos: new THREE.Vector3(0, mid + 0.145, 0.0), leanDeg: 10, scale: 0.98 },
    sockets: {
      itemMount: new THREE.Vector3(0, mid + 0.28, rz + 0.10),
      rearCentre: new THREE.Vector3(0, mid + 0.05, rz + 0.30),
    },
    singleFront: false,
    wheelScale: [1, 1, 1, 1],
    suspension: 'none',
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const BUILDERS: Record<KartBodyId, (c: BuildCtx) => Partial<BodyBuildResult>> = {
  standard: buildStandard,
  bike: buildBike,
  cruiser: buildCruiser,
  speedster: buildSpeedster,
  buggy: buildBuggy,
  hover: buildHover,
};

/**
 * Build one chassis. Returns merged geometry per material slot at three detail
 * levels, plus every anchor the animation layer needs.
 *
 * Everything is authored with ground at y = 0 and then translated down by
 * `frame.groundY`, so the result is directly parentable to the kart root.
 */
export function buildKartBody(
  id: KartBodyId,
  frame: KartFrame,
  quality: QualitySettings,
): BodyBuildResult {
  const b = new PartBucket();
  const ctx: BuildCtx = { b, f: frame, wy: frame.wheelRadius };
  const partial = BUILDERS[id](ctx);

  // Exhausts: bodies that didn't add their own get a pair at the rear.
  const sockets: Record<string, THREE.Vector3> = partial.sockets ?? {};
  if (!sockets.exhaustL || sockets.exhaustL.lengthSq() === 0) {
    const y = (partial.driver?.pos.y ?? frame.wheelRadius * 0.6) - 0.05;
    for (const sgn of [-1, 1]) {
      const path = [
        new THREE.Vector3(sgn * 0.14, y, frame.rearZ - 0.20),
        new THREE.Vector3(sgn * 0.22, y + 0.02, frame.rearZ + 0.08),
        new THREE.Vector3(sgn * 0.235, y + 0.05, frame.rearZ + 0.30),
      ];
      const tip = exhaust(b, path, 0.030, 0.044, 1);
      sockets[sgn < 0 ? 'exhaustL' : 'exhaustR'] = tip;
    }
  }

  // --- AO bake ------------------------------------------------------------
  const occl = b.occluder();
  const near = b.merge(2, 34);
  const mid = b.merge(1, 34);
  const far = b.merge(0, 40);

  if (occl) {
    const samples = quality.tier === 'low' ? 0
      : quality.tier === 'medium' ? 3
        : quality.tier === 'high' ? 4 : 5;
    if (samples > 0) {
      bakeAO(occl, near.map((n) => n.geometry), {
        samples, radius: 0.44, strength: 0.9, skyBias: 0.22, groundY: 0,
      });
      // Mid and far reuse the near bake — same authored vertices, zero rays.
      const src = near.map((n) => n.geometry);
      transferVertexColors(src, mid.map((n) => n.geometry));
      transferVertexColors(src, far.map((n) => n.geometry));
    }
    occl.dispose();
  }

  // --- translate everything into kart-local space -------------------------
  const dy = frame.groundY;
  for (const list of [near, mid, far]) {
    for (const g of list) g.geometry.translate(0, dy, 0);
  }
  const steering = partial.steering ?? null;
  if (steering) steering.pos.y += dy;
  const driver = partial.driver ?? { pos: new THREE.Vector3(0, 0, 0), leanDeg: 0, scale: 1 };
  driver.pos.y += dy;
  for (const k of Object.keys(sockets)) sockets[k].y += dy;

  let tris = 0;
  for (const g of near) {
    const idx = g.geometry.getIndex();
    tris += (idx ? idx.count : g.geometry.attributes.position.count) / 3;
  }

  b.dispose();

  return {
    near, mid, far, steering, driver, sockets,
    singleFront: partial.singleFront ?? false,
    wheelScale: partial.wheelScale ?? [1, 1, 1, 1],
    wheelWidthScale: partial.wheelWidthScale
      ?? (id === 'bike' || id === 'hover' ? [1, 1, 1, 1] : [1.04, 1.04, 1.22, 1.22]),
    suspension: partial.suspension ?? 'arm',
    tris: Math.round(tris),
  };
}

/** Instantiate merged groups as meshes using a material set. */
export function meshesFor(
  groups: Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }>,
  mats: KartMaterialSet,
  name: string,
): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const g of groups) {
    const m = new THREE.Mesh(g.geometry, mats[g.slot]);
    m.name = `${name}:${g.slot}`;
    m.castShadow = g.slot !== 'glow' && g.slot !== 'lightFront' && g.slot !== 'lightRear';
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    out.push(m);
  }
  return out;
}
