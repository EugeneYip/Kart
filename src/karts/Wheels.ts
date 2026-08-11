/**
 * ============================================================================
 *  APEX KART — WHEELS
 * ============================================================================
 *  Wheels rotate about the kart's local **X** axis:
 *    root.rotation.y   = steerAngle   (front only)
 *    spinner.rotation.x = -wheelSpin
 *    root.scale.y      = squash       (compression under load — MK8 does this
 *                                      and it is a huge part of the read)
 *
 *  Geometry is authored for the RIGHT-hand side (outboard = +X) and mirrored
 *  for the left, so the brake caliper and hub nut are always on the correct
 *  face without ever using a negative scale.
 *
 *  The tyre is a parametric revolution, not a cylinder: the tread is modelled
 *  into the silhouette (grooves for road tyres, real staggered lugs for the
 *  knobbly set), the shoulders are rounded, and the sidewall carries its
 *  lettering from the tyre atlas in `KartMaterials`.
 *
 *  UV convention (matched by `makeTyreAlbedo` / `makeTyreNormal`):
 *    u = around the circumference, v = across the section
 *    v 0.00–0.19 and 0.81–1.00 = sidewalls, 0.19–0.81 = tread
 * ============================================================================
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { QualitySettings } from '@/core/Types';
import type { KartMaterialSet, MaterialSlot } from './KartMaterials';
import {
  DEG, consolidateParts, lathe, loft, mirrorX, prepGeometry, shadeColor, smoothNormals,
  superShape,
} from './KartBodies';

export const TYRE_IDS = ['slick', 'standard', 'knobbly', 'hover'] as const;
export type TyreId = (typeof TYRE_IDS)[number];

// ---------------------------------------------------------------------------
// Tyre section profile
// ---------------------------------------------------------------------------

interface ProfilePoint {
  /** Axial position as a fraction of the half width, -1 (inboard) .. +1. */
  ax: number;
  /** Radius as a fraction of the nominal radius. */
  rf: number;
  /** How much of the tread modulation applies here, 0..1. */
  tread: number;
  /** Texture v. */
  v: number;
}

const SECTION: ProfilePoint[] = [
  { ax: -1.00, rf: 0.600, tread: 0, v: 0.000 },
  { ax: -1.00, rf: 0.700, tread: 0, v: 0.045 },
  { ax: -0.99, rf: 0.830, tread: 0, v: 0.095 },
  { ax: -0.96, rf: 0.925, tread: 0, v: 0.145 },
  { ax: -0.90, rf: 0.972, tread: 0.15, v: 0.190 },
  { ax: -0.79, rf: 0.995, tread: 0.70, v: 0.245 },
  { ax: -0.45, rf: 1.004, tread: 1.00, v: 0.360 },
  { ax: 0.00, rf: 1.008, tread: 1.00, v: 0.500 },
  { ax: 0.45, rf: 1.004, tread: 1.00, v: 0.640 },
  { ax: 0.79, rf: 0.995, tread: 0.70, v: 0.755 },
  { ax: 0.90, rf: 0.972, tread: 0.15, v: 0.810 },
  { ax: 0.96, rf: 0.925, tread: 0, v: 0.855 },
  { ax: 0.99, rf: 0.830, tread: 0, v: 0.905 },
  { ax: 1.00, rf: 0.700, tread: 0, v: 0.955 },
  { ax: 1.00, rf: 0.600, tread: 0, v: 1.000 },
];

function sstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 0 = full rubber, 1 = full groove depth. */
function treadMask(id: TyreId, u: number, ax: number): number {
  const a = Math.abs(ax);
  if (id === 'slick') {
    let g = 0;
    for (const c of [0.30, 0.68]) g = Math.max(g, 1 - sstep(0.02, 0.05, Math.abs(a - c)));
    return g;
  }
  if (id === 'standard') {
    // two circumferential rain grooves
    let g = 0;
    for (const c of [0.22, 0.60]) g = Math.max(g, 1 - sstep(0.028, 0.062, Math.abs(a - c)));
    // lateral block gaps, staggered per lane
    const lane = a < 0.22 ? 0 : a < 0.60 ? 1 : 2;
    const blocks = 18;
    const phase = (u * blocks + lane * 0.34) % 1;
    const gap = 1 - sstep(0.20, 0.30, Math.abs(phase - 0.5));
    return Math.max(g, gap * 0.9);
  }
  if (id === 'knobbly') {
    const rows = [
      { c: 0.00, h: 0.26, n: 10, off: 0.00 },
      { c: 0.50, h: 0.22, n: 10, off: 0.50 },
      { c: 0.86, h: 0.18, n: 10, off: 0.25 },
    ];
    let lug = 0;
    for (const r of rows) {
      const inRow = 1 - sstep(r.h * 0.66, r.h, Math.abs(a - r.c));
      if (inRow <= 0) continue;
      const phase = (u * r.n + r.off) % 1;
      const inLug = 1 - sstep(0.19, 0.27, Math.abs(phase - 0.5));
      lug = Math.max(lug, Math.min(inRow, inLug));
    }
    return 1 - lug;
  }
  return 0;
}

const TREAD_DEPTH: Record<TyreId, number> = {
  slick: 0.022,
  standard: 0.055,
  knobbly: 0.115,
  hover: 0,
};

/** Parametric tyre carcass, axis = +X. */
function buildTyreGeometry(id: TyreId, radius: number, halfWidth: number, seg: number): THREE.BufferGeometry {
  const rows = SECTION.length;
  const cols = seg + 1;
  const depth = TREAD_DEPTH[id] * radius;
  const pos = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  let p = 0;
  for (let r = 0; r < rows; r++) {
    const s = SECTION[r];
    for (let ci = 0; ci < cols; ci++) {
      const u = ci / seg;
      const th = u * Math.PI * 2;
      let rad = s.rf * radius;
      if (depth > 0 && s.tread > 0) rad -= treadMask(id, u, s.ax) * depth * s.tread;
      pos[p * 3] = s.ax * halfWidth;
      pos[p * 3 + 1] = Math.cos(th) * rad;
      pos[p * 3 + 2] = Math.sin(th) * rad;
      uv[p * 2] = u;
      uv[p * 2 + 1] = s.v;
      p++;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let ci = 0; ci < seg; ci++) {
      const a = r * cols + ci, b = r * cols + ci + 1;
      const c = (r + 1) * cols + ci + 1, d = (r + 1) * cols + ci;
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

/**
 * Lathe about +X (the axle). Profile points are (radius, axialPosition) and
 * MUST be ordered from -X (inboard) to +X (outboard) so normals face outward.
 */
function latheX(profile: THREE.Vector2[], seg = 20, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  const g = lathe(profile, seg, phiStart, phiLength);
  g.rotateZ(-90 * DEG); // lathe axis +Y -> +X
  return g;
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

interface Bucket { slot: MaterialSlot; geoms: THREE.BufferGeometry[] }

/**
 * `shade` is a greyscale vertex-colour multiplier (see `shadeColor`). Wheels was
 * the one caller that already spelled it correctly — as the three-argument
 * `new THREE.Color(t, t, t)`, which is `setRGB` and therefore a real multiplier
 * rather than the scalar `new THREE.Color(t)` that floors to black. It now
 * shares the single helper so there is nothing left to get wrong.
 */
function push(list: Bucket[], slot: MaterialSlot, g: THREE.BufferGeometry, shade?: number): void {
  let b = list.find((x) => x.slot === slot);
  if (!b) { b = { slot, geoms: [] }; list.push(b); }
  prepGeometry(g, shade !== undefined ? shadeColor(shade) : undefined);
  b.geoms.push(g);
}

/** Radial spoke: lofted along +Z, reoriented to point +Y, then spun to `angle`. */
function radialSpoke(
  sections: Array<{ r: number; halfAxial: number; halfTangent: number; e?: number; roll?: number }>,
  angle: number,
  segments = 10,
): THREE.BufferGeometry {
  const g = loft(sections.map((s) => ({
    z: s.r, y: 0, hw: s.halfAxial, hUp: s.halfTangent, hDown: s.halfTangent,
    eSide: s.e ?? 3.0, eTop: s.e ?? 3.0, eBot: s.e ?? 3.0, roll: s.roll,
  })), { segments });
  g.rotateX(-90 * DEG); // +Z -> +Y
  g.applyMatrix4(new THREE.Matrix4().makeRotationX(angle));
  return g;
}

// ---------------------------------------------------------------------------
// Rims
// ---------------------------------------------------------------------------

interface RimSpec {
  spokes: number;
  style: 'straight' | 'y' | 'heavy' | 'turbine';
  slot: MaterialSlot;
  beadBolts: number;
}

const RIMS: Record<TyreId, RimSpec> = {
  slick: { spokes: 10, style: 'straight', slot: 'chrome', beadBolts: 0 },
  standard: { spokes: 5, style: 'y', slot: 'chrome', beadBolts: 5 },
  knobbly: { spokes: 6, style: 'heavy', slot: 'metal', beadBolts: 12 },
  hover: { spokes: 8, style: 'turbine', slot: 'chrome', beadBolts: 0 },
};

function buildRim(id: TyreId, radius: number, halfWidth: number, out: Bucket[]): void {
  const spec = RIMS[id];
  const rimR = radius * 0.615;
  const hw = halfWidth * 0.95;

  // --- barrel with a rolled lip at each bead ------------------------------
  push(out, spec.slot, latheX([
    new THREE.Vector2(rimR * 0.97, -hw),
    new THREE.Vector2(rimR * 1.04, -hw * 0.90),
    new THREE.Vector2(rimR * 1.04, -hw * 0.74),
    new THREE.Vector2(rimR * 0.93, -hw * 0.62),
    new THREE.Vector2(rimR * 0.93, hw * 0.62),
    new THREE.Vector2(rimR * 1.04, hw * 0.74),
    new THREE.Vector2(rimR * 1.04, hw * 0.90),
    new THREE.Vector2(rimR * 0.97, hw),
  ], 22));

  // dark inner drum so no daylight shows through the tyre
  push(out, 'plastic', latheX([
    new THREE.Vector2(rimR * 0.60, -hw * 0.58),
    new THREE.Vector2(rimR * 0.60, hw * 0.58),
  ], 16), 0.17);

  // --- hub face (dished, outboard = +X) -----------------------------------
  push(out, spec.slot, latheX([
    new THREE.Vector2(1e-4, -hw * 0.34),
    new THREE.Vector2(rimR * 0.36, -hw * 0.30),
    new THREE.Vector2(rimR * 0.40, -hw * 0.02),
    new THREE.Vector2(rimR * 0.38, hw * 0.30),
    new THREE.Vector2(rimR * 0.22, hw * 0.44),
    new THREE.Vector2(1e-4, hw * 0.46),
  ], 18));

  // hub nut — 6 lathe segments read as a hex
  push(out, 'metal', latheX([
    new THREE.Vector2(1e-4, hw * 0.42),
    new THREE.Vector2(rimR * 0.14, hw * 0.44),
    new THREE.Vector2(rimR * 0.19, hw * 0.56),
    new THREE.Vector2(rimR * 0.17, hw * 0.74),
    new THREE.Vector2(1e-4, hw * 0.78),
  ], 6), 1.3);

  // --- spokes -------------------------------------------------------------
  const len = rimR * 0.99;
  for (let i = 0; i < spec.spokes; i++) {
    const a = (i / spec.spokes) * Math.PI * 2;
    if (spec.style === 'y') {
      push(out, spec.slot, radialSpoke([
        { r: rimR * 0.28, halfAxial: hw * 0.18, halfTangent: rimR * 0.125, e: 3.0 },
        { r: rimR * 0.58, halfAxial: hw * 0.15, halfTangent: rimR * 0.105, e: 3.2 },
      ], a, 9));
      for (const sgn of [-1, 1]) {
        push(out, spec.slot, radialSpoke([
          { r: rimR * 0.56, halfAxial: hw * 0.14, halfTangent: rimR * 0.078, e: 3.0 },
          { r: len, halfAxial: hw * 0.13, halfTangent: rimR * 0.056, e: 3.0 },
        ], a + sgn * 0.30, 7));
      }
    } else if (spec.style === 'straight') {
      push(out, spec.slot, radialSpoke([
        { r: rimR * 0.28, halfAxial: hw * 0.13, halfTangent: rimR * 0.072, e: 2.8 },
        { r: rimR * 0.66, halfAxial: hw * 0.11, halfTangent: rimR * 0.056, e: 3.0 },
        { r: len, halfAxial: hw * 0.10, halfTangent: rimR * 0.046, e: 3.0 },
      ], a, 7));
    } else if (spec.style === 'heavy') {
      push(out, spec.slot, radialSpoke([
        { r: rimR * 0.24, halfAxial: hw * 0.22, halfTangent: rimR * 0.175, e: 3.4 },
        { r: rimR * 0.64, halfAxial: hw * 0.19, halfTangent: rimR * 0.140, e: 3.6 },
        { r: len, halfAxial: hw * 0.18, halfTangent: rimR * 0.120, e: 3.6 },
      ], a, 9), 0.95);
    } else {
      push(out, spec.slot, radialSpoke([
        { r: rimR * 0.30, halfAxial: hw * 0.055, halfTangent: rimR * 0.17, e: 2.4, roll: 0 },
        { r: rimR * 0.68, halfAxial: hw * 0.055, halfTangent: rimR * 0.14, e: 2.4, roll: 24 },
        { r: len, halfAxial: hw * 0.055, halfTangent: rimR * 0.11, e: 2.4, roll: 42 },
      ], a, 7));
    }
  }

  // --- bead-lock bolts on the outboard face -------------------------------
  const boltR = spec.style === 'heavy' ? rimR * 0.93 : rimR * 0.60;
  for (let i = 0; i < spec.beadBolts; i++) {
    const a = ((i + 0.5) / spec.beadBolts) * Math.PI * 2;
    const bolt = latheX([
      new THREE.Vector2(1e-4, 0),
      new THREE.Vector2(rimR * 0.072, 0),
      new THREE.Vector2(rimR * 0.080, hw * 0.11),
      new THREE.Vector2(rimR * 0.048, hw * 0.16),
      new THREE.Vector2(1e-4, hw * 0.17),
    ], 6);
    bolt.translate(hw * 0.82, Math.cos(a) * boltR, Math.sin(a) * boltR);
    push(out, 'metal', bolt, 1.25);
  }
}

// ---------------------------------------------------------------------------
// Brakes — visible through the spokes, which is why the rim has real gaps
// ---------------------------------------------------------------------------

function buildBrakes(id: TyreId, radius: number, halfWidth: number, spin: Bucket[], fixed: Bucket[]): void {
  const dr = radius * 0.50;
  const x = -halfWidth * 0.16; // just inboard of the wheel centre plane

  // vented rotor: chamfered rim, raised bell
  const rotor = latheX([
    new THREE.Vector2(dr * 0.30, x - 0.014),
    new THREE.Vector2(dr * 0.34, x - 0.028),
    new THREE.Vector2(dr * 0.72, x - 0.028),
    new THREE.Vector2(dr * 0.74, x - 0.020),
    new THREE.Vector2(dr * 0.96, x - 0.020),
    new THREE.Vector2(dr, x - 0.012),
    new THREE.Vector2(dr, x + 0.012),
    new THREE.Vector2(dr * 0.96, x + 0.020),
    new THREE.Vector2(dr * 0.74, x + 0.020),
    new THREE.Vector2(dr * 0.72, x + 0.028),
    new THREE.Vector2(dr * 0.34, x + 0.028),
    new THREE.Vector2(dr * 0.30, x + 0.014),
  ], 28);
  push(spin, 'metal', rotor, 1.3);

  // drilled holes as dark plugs
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const hole = latheX([
      new THREE.Vector2(1e-4, -0.03), new THREE.Vector2(dr * 0.072, -0.03),
      new THREE.Vector2(dr * 0.072, 0.03), new THREE.Vector2(1e-4, 0.03),
    ], 8);
    hole.translate(x, Math.cos(a) * dr * 0.83, Math.sin(a) * dr * 0.83);
    push(spin, 'plastic', hole, 0.09);
  }

  // caliper: a partial shell hugging the rotor plus a body block
  const shell = latheX([
    new THREE.Vector2(dr * 1.01, x - 0.055),
    new THREE.Vector2(dr * 1.11, x - 0.060),
    new THREE.Vector2(dr * 1.11, x + 0.060),
    new THREE.Vector2(dr * 1.01, x + 0.055),
  ], 12, Math.PI * 1.10, Math.PI * 0.36);
  push(fixed, 'paint2', shell);
  const body = superShape(halfWidth * 0.32, dr * 0.28, dr * 0.15, 3.6, 3.6, 12, 8);
  body.translate(x, dr * 0.86, -dr * 0.42);
  push(fixed, 'paint2', body);
  for (const s of [-1, 1]) {
    const bolt = latheX([
      new THREE.Vector2(1e-4, x - halfWidth * 0.42),
      new THREE.Vector2(dr * 0.055, x - halfWidth * 0.42),
      new THREE.Vector2(dr * 0.060, x - halfWidth * 0.32),
      new THREE.Vector2(1e-4, x - halfWidth * 0.30),
    ], 6);
    bolt.translate(0, dr * 0.86 + s * dr * 0.19, -dr * 0.42);
    push(fixed, 'chrome', bolt);
  }
  // upright / stub axle so the wheel visibly attaches to something
  const upright = superShape(halfWidth * 0.40, dr * 0.44, dr * 0.30, 3.8, 3.8, 12, 8);
  upright.translate(-halfWidth * 0.66, 0, 0);
  push(fixed, 'metal', upright, 0.8);
}

// ---------------------------------------------------------------------------
// Hover pod (replaces the wheel on the hover chassis)
// ---------------------------------------------------------------------------

function buildHoverPod(radius: number, halfWidth: number, spin: Bucket[], fixed: Bucket[]): void {
  push(fixed, 'paint2', latheX([
    new THREE.Vector2(radius * 0.55, -halfWidth),
    new THREE.Vector2(radius * 0.92, -halfWidth * 0.86),
    new THREE.Vector2(radius * 1.00, -halfWidth * 0.30),
    new THREE.Vector2(radius * 1.00, halfWidth * 0.30),
    new THREE.Vector2(radius * 0.92, halfWidth * 0.86),
    new THREE.Vector2(radius * 0.55, halfWidth),
  ], 26));
  const ring = new THREE.TorusGeometry(radius * 0.80, radius * 0.070, 7, 20);
  ring.rotateY(90 * DEG);
  push(fixed, 'chrome', ring);
  push(spin, 'glow', latheX([
    new THREE.Vector2(1e-4, -halfWidth * 0.38),
    new THREE.Vector2(radius * 0.46, -halfWidth * 0.22),
    new THREE.Vector2(radius * 0.50, halfWidth * 0.22),
    new THREE.Vector2(1e-4, halfWidth * 0.38),
  ], 22));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    push(spin, 'chrome', radialSpoke([
      { r: radius * 0.42, halfAxial: halfWidth * 0.06, halfTangent: radius * 0.10, e: 2.4, roll: 0 },
      { r: radius * 0.78, halfAxial: halfWidth * 0.06, halfTangent: radius * 0.08, e: 2.4, roll: 34 },
    ], a, 8));
  }
}

// ---------------------------------------------------------------------------
// Public build
// ---------------------------------------------------------------------------

export interface WheelBuild {
  /** Geometry that rotates with the wheel. */
  spin: Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }>;
  /** Geometry fixed to the upright (caliper, hub carrier). */
  fixed: Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }>;
  /**
   * Everything that spins except the tyre, consolidated into one buffer for the
   * merged atlas material — rim, spokes, brake disc and hub in a single draw.
   * The tyre keeps its own material because its tread atlas is the one texture
   * on a wheel you can actually read.
   */
  spinMerged: THREE.BufferGeometry | null;
  /** `fixed` consolidated the same way (caliper + hub carrier). */
  fixedMerged: THREE.BufferGeometry | null;
  /** Index into `spin` of the tyre carcass, or -1. */
  tyreIndex: number;
  radius: number;
  halfWidth: number;
  tyreId: TyreId;
  tris: number;
}

function finish(list: Bucket[]): Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }> {
  const out: Array<{ slot: MaterialSlot; geometry: THREE.BufferGeometry }> = [];
  for (const b of list) {
    const merged = b.geoms.length === 1 ? b.geoms[0] : (mergeGeometries(b.geoms, false) ?? b.geoms[0]);
    if (b.geoms.length > 1) for (const g of b.geoms) g.dispose();
    out.push({ slot: b.slot, geometry: smoothNormals(merged, 32) });
  }
  return out;
}

export function buildWheel(
  id: TyreId,
  radius: number,
  width: number,
  quality: QualitySettings,
): WheelBuild {
  const halfWidth = width * 0.5;
  const spin: Bucket[] = [];
  const fixed: Bucket[] = [];

  if (id === 'hover') {
    buildHoverPod(radius, halfWidth, spin, fixed);
  } else {
    const seg = quality.tier === 'low' ? 20 : id === 'knobbly' ? 38 : 30;
    push(spin, 'rubber', buildTyreGeometry(id, radius, halfWidth, seg));
    buildRim(id, radius, halfWidth, spin);
    buildBrakes(id, radius, halfWidth, spin, fixed);
  }

  const spinOut = finish(spin);
  const fixedOut = finish(fixed);
  let tris = 0;
  for (const g of [...spinOut, ...fixedOut]) {
    const i = g.geometry.getIndex();
    tris += (i ? i.count : g.geometry.attributes.position.count) / 3;
  }
  const tyreIndex = spinOut.findIndex((g) => g.slot === 'rubber');
  return {
    spin: spinOut, fixed: fixedOut,
    spinMerged: consolidateParts(spinOut.filter((g) => g.slot !== 'rubber')),
    fixedMerged: consolidateParts(fixedOut),
    tyreIndex,
    radius, halfWidth, tyreId: id, tris: Math.round(tris),
  };
}

/** Mirrored copy for the left-hand side (proper winding + normal flip). */
export function mirrorWheelBuild(b: WheelBuild): WheelBuild {
  return {
    spin: b.spin.map((g) => ({ slot: g.slot, geometry: mirrorX(g.geometry) })),
    fixed: b.fixed.map((g) => ({ slot: g.slot, geometry: mirrorX(g.geometry) })),
    spinMerged: b.spinMerged ? mirrorX(b.spinMerged) : null,
    fixedMerged: b.fixedMerged ? mirrorX(b.fixedMerged) : null,
    tyreIndex: b.tyreIndex,
    radius: b.radius, halfWidth: b.halfWidth, tyreId: b.tyreId, tris: b.tris,
  };
}

/**
 * Instantiate one wheel.
 *   root    — positioned + steered + squashed by the animation layer
 *   spinner — rotated about X by `wheelSpin`
 */
export function createWheelObject(
  build: WheelBuild,
  mats: KartMaterialSet,
  tyreMaterial: THREE.Material,
  name: string,
  merged: THREE.Material | null = null,
): { root: THREE.Group; spinner: THREE.Group } {
  const root = new THREE.Group();
  root.name = name;
  const spinner = new THREE.Group();
  spinner.name = `${name}:spin`;
  root.add(spinner);

  if (merged) {
    // Tyre + one consolidated rim buffer + one consolidated upright buffer:
    // three draws instead of seven, and the tyre keeps its tread atlas.
    const tyre = build.tyreIndex >= 0 ? build.spin[build.tyreIndex] : null;
    if (tyre) {
      const m = new THREE.Mesh(tyre.geometry, tyreMaterial);
      m.name = `${name}:rubber`;
      m.castShadow = true;
      m.receiveShadow = true;
      spinner.add(m);
    }
    if (build.spinMerged) {
      const m = new THREE.Mesh(build.spinMerged, merged);
      m.name = `${name}:rim`;
      m.castShadow = true;
      spinner.add(m);
    }
    if (build.fixedMerged) {
      const m = new THREE.Mesh(build.fixedMerged, merged);
      m.name = `${name}:fixed`;
      m.castShadow = true;
      root.add(m);
    }
    return { root, spinner };
  }

  for (const g of build.spin) {
    const mat = g.slot === 'rubber' ? tyreMaterial : mats[g.slot];
    const m = new THREE.Mesh(g.geometry, mat);
    m.name = `${name}:${g.slot}`;
    m.castShadow = g.slot !== 'glow';
    m.receiveShadow = g.slot === 'rubber';
    spinner.add(m);
  }
  for (const g of build.fixed) {
    const m = new THREE.Mesh(g.geometry, mats[g.slot]);
    m.name = `${name}:fixed:${g.slot}`;
    m.castShadow = g.slot !== 'glow';
    root.add(m);
  }
  return { root, spinner };
}

export function disposeWheelBuild(b: WheelBuild): void {
  for (const g of b.spin) g.geometry.dispose();
  for (const g of b.fixed) g.geometry.dispose();
  b.spinMerged?.dispose();
  b.fixedMerged?.dispose();
}
