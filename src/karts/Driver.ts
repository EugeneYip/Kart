/**
 * ============================================================================
 *  APEX KART — DRIVERS
 * ============================================================================
 *  Eight original characters. No Nintendo silhouettes — but the same rules that
 *  make those read at 40 metres:
 *
 *   1. **One idea per head.** Every driver owns a headwear shape nobody else
 *      has (backwards cap, winged full-face helmet, chromed dome, wide-brim
 *      welder's cap, teardrop aero shell, glass bubble, crested great-helm,
 *      earflapped flight cap). At minimap size that shape *is* the character.
 *   2. **Bold colour blocking.** Suits are two flat masses (cloth / clothAlt)
 *      split on a hard seam, never gradients or fiddly trim.
 *   3. **Chunky proportions.** Head is 1/3.2 of standing height, hands are
 *      oversized, shoulders are wider than the hips. Realistic proportions read
 *      as "sickly" at this scale.
 *
 *  RIG — no skeletal system, no skinning. Seven parented `Object3D`s:
 *
 *        hips
 *         ├── torso
 *         │    ├── head
 *         │    ├── armL ── foreL
 *         │    └── armR ── foreR
 *         └── (legs are welded into hips — they never move in a kart)
 *
 *  Geometry is authored **in driver space** in the final seated pose, then each
 *  node's merged geometry is translated by −pivot so the node can rotate about
 *  a sane joint. Every pivot has identity rest rotation, so a pose offset about
 *  X is always "swing forward/back" and about Z is always "lean left/right" —
 *  which keeps the pose maths readable instead of a pile of quaternion algebra.
 *
 *  Driver space: hips centre at the origin, **Y up, −Z forward** (matching the
 *  kart). `BodyBuildResult.driver.pos` is where this origin goes.
 * ============================================================================
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { QualitySettings } from '@/core/Types';
import { clamp, clamp01, damp, lerp } from '@/core/MathUtils';
import type { FaceExpression, FaceSpec, KartMaterialSet, MaterialSlot } from './KartMaterials';
import type { FaceMaterial } from './KartMaterials';
import { ANIMAL_MUZZLE_SPLIT } from './KartMaterials';
import {
  DEG, bakeAO, consolidateParts, disc, extrude, lathe, loft, mirrorX, prepGeometry,
  rivet, roundedBox, segs, shadeColor, smoothNormals, superShape, transferVertexColors, tube,
  type ConsolidatePart, type DetailLevel, type LoftSection,
} from './KartBodies';

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export const DRIVER_IDS = [
  'mechanic', 'racer', 'robot', 'heavy', 'speedy', 'alien', 'knight', 'aviator',
  'fox', 'capy',
] as const;
export type DriverId = (typeof DRIVER_IDS)[number];

export type HeadKind =
  | 'cap' | 'fullHelmet' | 'robot' | 'trucker'
  | 'aero' | 'bubble' | 'greatHelm' | 'flightCap'
  | 'beret' | 'bucketHat';

/**
 * Anatomy family. Absent means human — the original eight are untouched by
 * every animal branch in this file, which is checked by re-running the baseline
 * probe and diffing the per-node slot lists.
 */
export type Species = 'fox' | 'capy';

export interface DriverDef {
  id: DriverId;
  name: string;
  /** Uniform scale on the whole rig. */
  scale: number;
  /** 0..1 chunkiness — shoulder width, torso depth, arm thickness. */
  bulk: number;
  /** Head radius in metres (before `scale`). */
  headR: number;
  /** Neck length. 0 = head sits straight on the shoulders. */
  neck: number;
  /** Torso height from waist pivot to shoulder line. */
  torso: number;
  head: HeadKind;
  /** Suit treatment. */
  outfit: 'overalls' | 'race' | 'plated' | 'armour' | 'jacket' | 'slim' | 'shell'
  | 'sweater' | 'pelt';
  /** Primary suit colour — deliberately NOT the kart paint, so the driver
   *  reads as a separate mass against their own machine. */
  suit: number;
  /** Secondary suit colour (trim, cuffs, straps, pads). */
  suitAlt: number;
  /** Skin / shell colour — also feeds `FaceSpec.skin` and the `skin` material. */
  skinColor: number;
  face: FaceSpec;
  /** Extra scarf / cape that trails behind. */
  scarf?: boolean;

  // --- animals -------------------------------------------------------------
  species?: Species;
  /** Pelt tones. `fur` doubles as `skinColor` for the face atlas background. */
  fur?: number;
  furAlt?: number;
  furDark?: number;
  /** Muzzle length as a multiple of `headR`. 0 = no snout. */
  muzzle?: number;
  /** Bushy tail on the `hips` node. */
  tail?: boolean;
  /** Knitwear instead of a woven racing suit (swaps the cloth normal map). */
  knitwear?: boolean;
  /**
   * Opt in to expression-driven micro-pose — a head tilt on `neutral`, a paw
   * toward the chin on `thoughtful`. Off for the original eight so their idle
   * pose is bit-identical to what shipped.
   */
  expressive?: boolean;
}

const HUMAN_EYE = '#2b2f3a';

export const DRIVERS: Record<DriverId, DriverDef> = {
  // 1. Plucky mechanic — backwards cap, goggles on the forehead, overalls.
  mechanic: {
    id: 'mechanic', name: 'Nova', scale: 1.0, bulk: 0.38, headR: 0.115, neck: 0.020,
    torso: 0.255, head: 'cap', outfit: 'overalls', skinColor: 0xe8ab7f,
    suit: 0x2c3d63, suitAlt: 0xf1e7d3,
    face: {
      style: 'human', skin: '#e8ab7f', eye: '#3b6ea5', brow: '#5c3a24',
      blush: 'rgba(214,102,86,0.30)', eyeSize: 1.06, mark: 'freckles',
    },
  },
  // 2. Cool racer — full-face helmet, tinted visor, winglets.
  racer: {
    id: 'racer', name: 'Blitz', scale: 1.02, bulk: 0.5, headR: 0.118, neck: 0.012,
    torso: 0.27, head: 'fullHelmet', outfit: 'race', skinColor: 0xd39a72,
    suit: 0xe9edf4, suitAlt: 0xffcf2f,
    face: {
      style: 'visor', skin: '#d39a72', eye: '#101820', brow: '#2a2f38',
      glow: '#8fd8ff', eyeSize: 0.9, mark: 'none',
    },
  },
  // 3. Robot — chromed dome, single optic band, antenna, piston arms.
  robot: {
    id: 'robot', name: 'Zephyr', scale: 0.98, bulk: 0.42, headR: 0.112, neck: 0.034,
    torso: 0.25, head: 'robot', outfit: 'plated', skinColor: 0xb9c2cc,
    suit: 0x39424c, suitAlt: 0x9aa5b2,
    face: {
      style: 'robot', skin: '#1a1d23', eye: '#59ffd0', brow: '#1a1d23',
      glow: '#59ffd0', eyeSize: 1.15, mark: 'none',
    },
  },
  // 4. Big friendly heavy — tiny wide-brim cap on a huge frame.
  heavy: {
    id: 'heavy', name: 'Torque', scale: 1.14, bulk: 1.0, headR: 0.108, neck: 0.0,
    torso: 0.25, head: 'trucker', outfit: 'jacket', skinColor: 0xc98b62,
    suit: 0x4b5540, suitAlt: 0xe07a2c,
    face: {
      style: 'human', skin: '#c98b62', eye: '#4a3524', brow: '#3a2a1c',
      eyeSize: 0.86, mark: 'stubble',
    },
  },
  // 5. Small speedster — oversized teardrop helmet, big eyes, scarf.
  speedy: {
    id: 'speedy', name: 'Pip', scale: 0.84, bulk: 0.2, headR: 0.126, neck: 0.010,
    torso: 0.215, head: 'aero', outfit: 'slim', skinColor: 0xf2c49b,
    suit: 0xd93a7a, suitAlt: 0xfdf3e3,
    face: {
      style: 'human', skin: '#f2c49b', eye: '#2f8f6b', brow: '#4a3520',
      blush: 'rgba(224,116,96,0.35)', eyeSize: 1.28, mark: 'none',
    },
    scarf: true,
  },
  // 6. Alien — elongated cranium under a glass bubble, black almond eyes.
  alien: {
    id: 'alien', name: 'Vex', scale: 0.94, bulk: 0.24, headR: 0.112, neck: 0.048,
    torso: 0.245, head: 'bubble', outfit: 'slim', skinColor: 0x9fe3b8,
    suit: 0x1d2c50, suitAlt: 0x3cf0c8,
    face: {
      style: 'alien', skin: '#9fe3b8', eye: '#0b0d12', brow: '#7cc79a',
      glow: '#6effc8', eyeSize: 1.35, mark: 'none',
    },
  },
  // 7. Knight — crested great-helm with a T-slit, pauldrons over a gambeson.
  knight: {
    id: 'knight', name: 'Ember', scale: 1.06, bulk: 0.74, headR: 0.115, neck: 0.0,
    torso: 0.26, head: 'greatHelm', outfit: 'armour', skinColor: 0xdda07a,
    suit: 0x38445e, suitAlt: 0xd9a53a,
    face: {
      style: 'visor', skin: '#dda07a', eye: '#141820', brow: '#2b2118',
      eyeSize: 0.94, mark: 'scar',
    },
  },
  // 8. Pilot — leather flight cap, earflaps, aviator goggles, scarf.
  aviator: {
    id: 'aviator', name: 'Strata', scale: 1.0, bulk: 0.55, headR: 0.116, neck: 0.018,
    torso: 0.26, head: 'flightCap', outfit: 'jacket', skinColor: 0xdfae86,
    suit: 0x8a6b45, suitAlt: 0xf3e7d0,
    face: {
      style: 'human', skin: '#dfae86', eye: '#7a6a4a', brow: '#4a3a26',
      eyeSize: 1.0, mark: 'moustache',
    },
    scarf: true,
  },
  // 9. FOXY — the mascot. Upright academic red fox: beret, spectacles, chunky
  //    roll-neck knit, and the tail that owns the whole silhouette.
  //
  //    "One idea per head" is doubly true here: the pointed muzzle + big
  //    triangular dark-tipped ears + tilted beret is a shape nobody else has,
  //    and the tail means the character is readable from behind too — which no
  //    other driver on the roster manages, because eight helmets all read as
  //    "head" from the chase camera.
  fox: {
    id: 'fox', name: 'Foxy', scale: 0.94, bulk: 0.30, headR: 0.124, neck: 0.0,
    torso: 0.228, head: 'beret', outfit: 'sweater',
    // Bold two-mass blocking: cold blue knit over the whole upper body against
    // warm orange fur everywhere else, with the mustard beret as the only accent.
    suit: 0x4a7398, suitAlt: 0xd8a32b, skinColor: 0xe4761f,
    species: 'fox', fur: 0xe4761f, furAlt: 0xf3e3cb, furDark: 0x4a2e20,
    muzzle: 1.05, tail: true, knitwear: true, expressive: true,
    face: {
      style: 'fox', skin: '#e4761f', snout: '#f3e3cb', nose: '#241713',
      eye: '#43301c', brow: '#8a4a16', eyeSize: 1.10, mark: 'whiskers',
      idle: 'thoughtful',
    },
  },
  // 10. CAPY — the heavyweight. A calm, unbothered capybara: bucket hat, chunky
  //     scarf, no tail at all. Deliberately the anti-fox — where the fox is a
  //     tall thin wedge with a plume behind it, this is a wide low brick with
  //     sanded corners, so the two never read as the same character from behind.
  capy: {
    id: 'capy', name: 'Capy', scale: 1.12, bulk: 0.94, headR: 0.128, neck: 0.0,
    torso: 0.222, head: 'bucketHat', outfit: 'pelt',
    suit: 0x6e90ae, suitAlt: 0xc4622d, skinColor: 0xc9a98a,
    species: 'capy', fur: 0xc9a98a, furAlt: 0xe3cbae, furDark: 0x8a6a4a,
    muzzle: 0.78, knitwear: true, expressive: true,
    face: {
      style: 'capy', skin: '#c9a98a', snout: '#e3cbae', nose: '#3b2a20',
      eye: '#2c1e16', brow: '#6b4c30', eyeSize: 1.0, mark: 'whiskers',
      idle: 'sleepy',
    },
  },
};

export const DRIVER_NAMES: Record<DriverId, string> = {
  mechanic: 'Nova', racer: 'Blitz', robot: 'Zephyr', heavy: 'Torque',
  speedy: 'Pip', alien: 'Vex', knight: 'Ember', aviator: 'Strata',
  fox: 'Foxy', capy: 'Capy',
};

// ---------------------------------------------------------------------------
// Slot routing
// ---------------------------------------------------------------------------
//  Each of these reproduces the original expression verbatim for a human and
//  prepends the animal cases, so no human driver's slot assignment can drift.
// ---------------------------------------------------------------------------

/** The torso shell. */
function shellSlotFor(d: DriverDef): MaterialSlot {
  if (d.species === 'fox') return 'cloth';      // knitted sweater
  if (d.species === 'capy') return 'fur';       // bare pelt
  return d.outfit === 'plated' ? 'metal' : d.outfit === 'armour' ? 'paint' : 'cloth';
}

/** Shoulder caps — a separate volume so the silhouette has real shoulders. */
function capSlotFor(d: DriverDef): MaterialSlot {
  if (d.species === 'fox') return 'cloth';
  if (d.species === 'capy') return 'fur';
  return d.outfit === 'armour' ? 'paint' : 'clothAlt';
}

/** Upper arm. Sleeve on the fox, bare mid-brown limb on the capybara. */
function armSlotFor(d: DriverDef): MaterialSlot {
  if (d.species === 'fox') return 'cloth';      // sweater sleeve
  if (d.species === 'capy') return 'furDark';   // mid-brown limb
  return d.outfit === 'plated' ? 'metal' : 'cloth';
}

/** Forearm — the "gloves" band on an animal. */
function foreSlotFor(d: DriverDef): MaterialSlot {
  if (d.species !== undefined) return 'furDark';
  return d.outfit === 'plated' ? 'chrome' : d.outfit === 'armour' ? 'paint2' : 'clothAlt';
}

/** Paw / glove. */
function handSlotFor(d: DriverDef): MaterialSlot {
  if (d.species !== undefined) return 'furDark';
  return d.outfit === 'plated' ? 'chrome' : 'rubber';
}

/** Pelvis block — part of the body mass, so it stays pelt-coloured. */
function pelvisSlotFor(d: DriverDef): MaterialSlot {
  if (d.species !== undefined) return 'fur';
  return d.outfit === 'plated' ? 'metal' : 'cloth';
}

/** Thigh. Below the fox's sweater hem, so bare pelt; mid-brown on the capybara. */
function thighSlotFor(d: DriverDef): MaterialSlot {
  if (d.species === 'fox') return 'fur';
  if (d.species === 'capy') return 'furDark';
  return d.outfit === 'plated' ? 'metal' : 'cloth';
}

/** Shin — the "boots" band. */
function shinSlotFor(d: DriverDef): MaterialSlot {
  if (d.species !== undefined) return 'furDark';
  return d.outfit === 'armour' ? 'paint2' : d.outfit === 'plated' ? 'metal' : 'clothAlt';
}

/** Foot / boot. */
function footSlotFor(d: DriverDef): MaterialSlot {
  return d.species !== undefined ? 'furDark' : 'rubber';
}

/** The face atlas spec for a driver, optionally re-skinned. */
export function faceSpecFor(id: DriverId, skin?: string): FaceSpec {
  const base = DRIVERS[id].face;
  return skin ? { ...base, skin } : base;
}

// ---------------------------------------------------------------------------
// Rig nodes
// ---------------------------------------------------------------------------

export const DRIVER_NODES = ['hips', 'torso', 'head', 'armL', 'armR', 'foreL', 'foreR'] as const;
export type DriverNode = (typeof DRIVER_NODES)[number];

const NODE_PARENT: Record<DriverNode, DriverNode | null> = {
  hips: null, torso: 'hips', head: 'torso',
  armL: 'torso', armR: 'torso', foreL: 'armL', foreR: 'armR',
};

// ---------------------------------------------------------------------------
// Geometry helpers specific to organic forms
// ---------------------------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _qt = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _sc = new THREE.Vector3();

/**
 * A tapered capsule between two arbitrary points, authored directly in driver
 * space. Radius eases with a mid-span bulge so limbs read as muscle rather than
 * plumbing, and both ends get a domed cap.
 */
function limb(
  from: THREE.Vector3, to: THREE.Vector3,
  r0: number, r1: number,
  radial = 10, rings = 5, bulge = 0.1, flatten = 1,
): THREE.BufferGeometry {
  _t.subVectors(to, from);
  const len = Math.max(1e-4, _t.length());
  _t.multiplyScalar(1 / len);
  // Orthonormal frame around the axis.
  if (Math.abs(_t.y) < 0.9) _n1.set(0, 1, 0); else _n1.set(1, 0, 0);
  _n1.cross(_t).normalize();
  _n2.crossVectors(_t, _n1);

  const cols = radial + 1;
  const rows = rings + 1;
  // rings + 2 cap centroids
  const count = cols * rows + 2;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let p = 0;
  for (let j = 0; j < rows; j++) {
    const v = j / rings;
    const r = lerp(r0, r1, v) * (1 + bulge * Math.sin(Math.PI * v));
    for (let i = 0; i < cols; i++) {
      const u = i / radial;
      const th = u * Math.PI * 2;
      const cx = Math.cos(th) * r;
      const cy = Math.sin(th) * r * flatten;
      pos[p * 3] = from.x + _t.x * len * v + _n1.x * cx + _n2.x * cy;
      pos[p * 3 + 1] = from.y + _t.y * len * v + _n1.y * cx + _n2.y * cy;
      pos[p * 3 + 2] = from.z + _t.z * len * v + _n1.z * cx + _n2.z * cy;
      uv[p * 2] = u; uv[p * 2 + 1] = v;
      p++;
    }
  }
  // caps — pushed out slightly so the join domes instead of ending flat
  const capA = p;
  pos[p * 3] = from.x - _t.x * r0 * 0.72;
  pos[p * 3 + 1] = from.y - _t.y * r0 * 0.72;
  pos[p * 3 + 2] = from.z - _t.z * r0 * 0.72;
  uv[p * 2] = 0.5; uv[p * 2 + 1] = 0; p++;
  const capB = p;
  pos[p * 3] = to.x + _t.x * r1 * 0.72;
  pos[p * 3 + 1] = to.y + _t.y * r1 * 0.72;
  pos[p * 3 + 2] = to.z + _t.z * r1 * 0.72;
  uv[p * 2] = 0.5; uv[p * 2 + 1] = 1;

  const idx: number[] = [];
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < radial; i++) {
      const a0 = j * cols + i, b0 = j * cols + i + 1;
      const c0 = (j + 1) * cols + i + 1, d0 = (j + 1) * cols + i;
      idx.push(a0, b0, c0, a0, c0, d0);
    }
  }
  for (let i = 0; i < radial; i++) {
    idx.push(capA, i + 1, i);
    const base = rings * cols;
    idx.push(capB, base + i, base + i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * `loft()` sweeps along +Z. Torsos, helmets and necks want to sweep along +Y,
 * so this lofts then rolls the result upright:
 *   section.z  -> height
 *   section.y  -> forward offset      (+ = toward -Z, the kart's forward)
 *   section.hUp   -> chest / front extent
 *   section.hDown -> back extent
 */
function verticalLoft(sections: LoftSection[], segments = 20, capF = true, capB = true): THREE.BufferGeometry {
  const g = loft(sections, { segments, capFront: capF, capBack: capB });
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * The face patch: a domed quad carrying an expression atlas cell.
 * Curving it means it sinks into the head instead of floating like a sticker.
 *
 * `v0`/`v1` select a horizontal band of the cell. The humans take the whole
 * thing; the animals split it in two — an eye band on the skull and a muzzle
 * band on the snout — so the mouth is painted onto the muzzle instead of onto
 * the forehead. Both bands are tagged `face`, so `RigBucket.merge` groups them
 * into a single buffer and the split costs no extra draw call.
 */
function facePatch(
  w: number, h: number, depth: number, curve: number, seg = 6, v0 = 0, v1 = 1,
): THREE.BufferGeometry {
  const cols = seg + 1;
  const count = cols * cols;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let p = 0;
  for (let j = 0; j < cols; j++) {
    const v = j / seg;
    for (let i = 0; i < cols; i++) {
      const u = i / seg;
      const x = (u - 0.5) * 2;
      const y = (v - 0.5) * 2;
      // Squircle falloff: edges recede into the skull, centre stands proud.
      const r2 = Math.min(1, x * x * 0.9 + y * y * 0.72);
      pos[p * 3] = x * w * 0.5;
      pos[p * 3 + 1] = y * h * 0.5;
      pos[p * 3 + 2] = -depth + curve * r2;
      uv[p * 2] = u; uv[p * 2 + 1] = lerp(v0, v1, v);
      p++;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a0 = j * cols + i, b0 = j * cols + i + 1;
      const c0 = (j + 1) * cols + i + 1, d0 = (j + 1) * cols + i;
      idx.push(a0, c0, b0, a0, d0, c0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A thin curved shell (visor, brim, pauldron) swept around Y. */
function shell(
  radius: number, halfAngle: number, yTop: number, yBot: number,
  thickness: number, seg = 16,
): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(radius - thickness, yBot),
    new THREE.Vector2(radius, yBot + thickness * 0.5),
    new THREE.Vector2(radius * 1.005, (yBot + yTop) * 0.5),
    new THREE.Vector2(radius, yTop - thickness * 0.5),
    new THREE.Vector2(radius - thickness, yTop),
  ];
  return lathe(pts, seg, -Math.PI / 2 - halfAngle, halfAngle * 2);
}

// ---------------------------------------------------------------------------
// Animal vocabulary — muzzles, ears, tails, brims, rolled collars
// ---------------------------------------------------------------------------

/** Per-angle warp applied by `sweepRing`. Returns radial and vertical offsets. */
interface RingWarp { dr: number; dy: number }

/**
 * A closed elliptical cross section for `sweepRing`, wound clockwise in
 * `(r, y)` so the swept surface faces outward. Collars, scarves, hat bands.
 */
function ringProfile(radius: number, halfW: number, halfH: number, n = 8): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(new THREE.Vector2(radius + halfW * Math.cos(a), -halfH * Math.sin(a)));
  }
  return out;
}

/**
 * A closed brim cross section: thin at the crown, drooping to a soft edge.
 * Runs top-inner -> top-outer -> tip -> bottom-outer -> bottom-inner, which is
 * clockwise in `(r, y)` and therefore outward-facing once swept.
 */
function brimProfile(
  innerR: number, outerR: number, thickness: number, droop: number,
): THREE.Vector2[] {
  const t = thickness * 0.5;
  return [
    new THREE.Vector2(innerR, t),
    new THREE.Vector2(lerp(innerR, outerR, 0.55), t * 0.9 - droop * 0.24),
    new THREE.Vector2(outerR * 0.985, t * 0.5 - droop * 0.74),
    new THREE.Vector2(outerR, -droop),
    new THREE.Vector2(outerR * 0.985, -t * 0.5 - droop * 0.86),
    new THREE.Vector2(lerp(innerR, outerR, 0.55), -t * 0.9 - droop * 0.30),
    new THREE.Vector2(innerR, -t),
  ];
}

/**
 * Sweep a **closed** 2D profile all the way round +Y — a torus with an arbitrary
 * cross section. This is the workhorse for rolled collars, hat bands, scarf
 * loops and floppy brims; `warp` makes the ring non-circular, which is the whole
 * difference between "hat" and "traffic cone".
 *
 * WINDING (see `HANDOFF.md` §0 — every closed primitive in `Props.ts` was built
 * inside-out and silently back-face culled): with the profile expressed as
 * `(radius, height)` and swept as `(r·cosθ, y, r·sinθ)`, the face normal at
 * angle θ comes out proportional to `(-dy, dr)` in the radial/vertical plane. So
 * the profile must run **clockwise** in `(r, y)` — descending on the outside,
 * returning inward along the bottom — for the surface to face outward. Profiles
 * here are authored that way and the probe asserts positive signed volume.
 */
function sweepRing(
  profile: readonly THREE.Vector2[],
  segments: number,
  warp?: (theta: number) => RingWarp,
): THREE.BufferGeometry {
  const seg = segs(segments, 6);
  const rings = profile.length;
  const cols = seg + 1;             // duplicated seam column for clean UVs
  const count = cols * rings;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let p = 0;
  for (let k = 0; k < rings; k++) {
    const pr = profile[k];
    for (let i = 0; i < cols; i++) {
      const t = i / seg;
      const th = t * Math.PI * 2;
      const w = warp ? warp(th) : null;
      const r = pr.x + (w ? w.dr : 0);
      const y = pr.y + (w ? w.dy : 0);
      pos[p * 3] = r * Math.cos(th);
      pos[p * 3 + 1] = y;
      pos[p * 3 + 2] = r * Math.sin(th);
      uv[p * 2] = t; uv[p * 2 + 1] = k / (rings - 1 || 1);
      p++;
    }
  }
  const idx: number[] = [];
  for (let k = 0; k < rings; k++) {
    const k2 = (k + 1) % rings;     // profile is a loop — wrap
    for (let i = 0; i < seg; i++) {
      const a = k * cols + i, b = k * cols + i + 1;
      const c = k2 * cols + i + 1, d = k2 * cols + i;
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
 * A variable-radius sweep along a Catmull-Rom curve, capped at both ends.
 *
 * `limb()` can only taper linearly between two points; a fox's tail needs a
 * *profile* — thin where it leaves the hips, fat through the middle, tapering to
 * a tip — following a curve that bends twice. `fluff` modulates the radius
 * around the circumference so the silhouette breaks up into locks instead of
 * reading as a smooth sausage, which is most of what makes it look like fur at
 * the distance the minimap cares about.
 *
 * Uses the same `(N, B, T)` right-handed frame and index order as `limb()`, so
 * the surface faces outward.
 */
function taperTube(
  points: THREE.Vector3[],
  radii: readonly number[],
  radialIn = 12,
  tubularIn = 18,
  fluff = 0,
): THREE.BufferGeometry {
  const radial = segs(radialIn, 7);
  const tubular = segs(tubularIn, 7);
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.4);
  const frames = curve.computeFrenetFrames(tubular, false);
  const cols = radial + 1;
  const rows = tubular + 1;
  const count = cols * rows + 2;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const cp = new THREE.Vector3();
  let p = 0;
  const radiusAt = (v: number): number => {
    const n = radii.length - 1;
    const f = clamp(v, 0, 1) * n;
    const i = Math.min(n - 1, Math.floor(f));
    return lerp(radii[i], radii[i + 1], f - i);
  };
  for (let j = 0; j < rows; j++) {
    const v = j / tubular;
    curve.getPoint(v, cp);
    const N = frames.normals[j];
    const B = frames.binormals[j];
    const r0 = radiusAt(v);
    for (let i = 0; i < cols; i++) {
      const u = i / radial;
      const th = u * Math.PI * 2;
      // Three locks around the tail, drifting along its length.
      const r = r0 * (1 + fluff * Math.sin(th * 3 + v * 5.2));
      const cx = Math.cos(th) * r;
      const cy = Math.sin(th) * r;
      pos[p * 3] = cp.x + N.x * cx + B.x * cy;
      pos[p * 3 + 1] = cp.y + N.y * cx + B.y * cy;
      pos[p * 3 + 2] = cp.z + N.z * cx + B.z * cy;
      uv[p * 2] = u; uv[p * 2 + 1] = v;
      p++;
    }
  }
  // Domed caps so the base and tip close instead of ending in a hole.
  const tan0 = curve.getTangent(0, _t).clone();
  const tan1 = curve.getTangent(1, _t).clone();
  curve.getPoint(0, cp);
  const capA = p;
  pos[p * 3] = cp.x - tan0.x * radiusAt(0) * 0.7;
  pos[p * 3 + 1] = cp.y - tan0.y * radiusAt(0) * 0.7;
  pos[p * 3 + 2] = cp.z - tan0.z * radiusAt(0) * 0.7;
  uv[p * 2] = 0.5; uv[p * 2 + 1] = 0; p++;
  curve.getPoint(1, cp);
  const capB = p;
  pos[p * 3] = cp.x + tan1.x * radiusAt(1) * 0.7;
  pos[p * 3 + 1] = cp.y + tan1.y * radiusAt(1) * 0.7;
  pos[p * 3 + 2] = cp.z + tan1.z * radiusAt(1) * 0.7;
  uv[p * 2] = 0.5; uv[p * 2 + 1] = 1;

  const idx: number[] = [];
  for (let j = 0; j < tubular; j++) {
    for (let i = 0; i < radial; i++) {
      const a = j * cols + i, b = j * cols + i + 1;
      const c = (j + 1) * cols + i + 1, d = (j + 1) * cols + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  const base = tubular * cols;
  for (let i = 0; i < radial; i++) {
    idx.push(capA, i + 1, i);
    idx.push(capB, base + i, base + i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A triangular ear: a beveled wedge with a slight cup, authored standing upright
 * about +Y with its base at the origin so it can be planted on a skull and
 * leaned outward. `sweep` rakes the tip backward.
 */
function earWedge(
  halfBase: number, height: number, thickness: number, sweep = 0.25,
): THREE.BufferGeometry {
  const g = extrude([
    new THREE.Vector2(-halfBase, 0),
    new THREE.Vector2(halfBase, 0),
    new THREE.Vector2(halfBase * 0.52 + height * sweep, height * 0.60),
    new THREE.Vector2(height * sweep * 0.9, height),
    new THREE.Vector2(-halfBase * 0.62 + height * sweep * 0.4, height * 0.58),
  ], thickness, Math.min(thickness * 0.35, halfBase * 0.28));
  // Ears are not flat plates: pinch the tip so the shell reads as a cone.
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = clamp01(y / height);
    pos.setZ(i, pos.getZ(i) * (1 - k * 0.55));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Node-tagged part bucket
// ---------------------------------------------------------------------------

interface RigEntry {
  node: DriverNode;
  slot: MaterialSlot;
  geom: THREE.BufferGeometry;
  detail: DetailLevel;
}

interface RigPlace {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number] | number;
  detail?: DetailLevel;
  /**
   * Greyscale vertex-colour multiplier. `0.85` is 85 % brightness, `1` leaves
   * the slot colour alone. Necks, belts, boots, gloves and helmet vents are
   * darkened this way so they read below the surface they sit on.
   *
   * This used to have a sibling called `tint` that went through
   * `new THREE.Color(n)` — which routes a *number* to `setHex()` and floors, so
   * `shade: 0.85` was `#000000` and the part was multiplied to **pure black**
   * rather than shaded. That is why every one of those parts measured a vertex
   * colour of exactly 0.000 on all eight human drivers. There is now exactly one
   * mechanism, `shadeColor()` in `KartBodies.ts`; do not add a second.
   */
  shade?: number;
}

export interface DriverGroup {
  node: DriverNode;
  slot: MaterialSlot;
  geometry: THREE.BufferGeometry;
}

class RigBucket {
  private entries: RigEntry[] = [];

  add(node: DriverNode, slot: MaterialSlot, geom: THREE.BufferGeometry, o: RigPlace = {}): this {
    if (o.pos || o.rot || o.scale !== undefined) {
      const s = o.scale === undefined ? 1 : o.scale;
      _eu.set((o.rot?.[0] ?? 0) * DEG, (o.rot?.[1] ?? 0) * DEG, (o.rot?.[2] ?? 0) * DEG);
      _qt.setFromEuler(_eu);
      _mat.compose(
        _a.set(o.pos?.[0] ?? 0, o.pos?.[1] ?? 0, o.pos?.[2] ?? 0),
        _qt,
        typeof s === 'number' ? _sc.set(s, s, s) : _sc.set(s[0], s[1], s[2]),
      );
      geom.applyMatrix4(_mat);
    }
    prepGeometry(geom, o.shade !== undefined ? shadeColor(o.shade) : undefined);
    this.entries.push({ node, slot, geom, detail: o.detail ?? 1 });
    return this;
  }

  /** Adds `geom` on `node`, plus its X mirror on `mirrorNode`. */
  pair(
    node: DriverNode, mirrorNode: DriverNode, slot: MaterialSlot,
    geom: THREE.BufferGeometry, o: RigPlace = {},
  ): this {
    this.add(node, slot, geom, o);
    const src = this.entries[this.entries.length - 1].geom;
    this.entries.push({ node: mirrorNode, slot, geom: mirrorX(src), detail: o.detail ?? 1 });
    return this;
  }

  merge(maxDetail: DetailLevel, creaseDeg: number): DriverGroup[] {
    const byKey = new Map<string, { node: DriverNode; slot: MaterialSlot; list: THREE.BufferGeometry[] }>();
    for (const e of this.entries) {
      if (e.detail > maxDetail) continue;
      const key = `${e.node}|${e.slot}`;
      let rec = byKey.get(key);
      if (!rec) { rec = { node: e.node, slot: e.slot, list: [] }; byKey.set(key, rec); }
      rec.list.push(e.geom.clone());
    }
    const out: DriverGroup[] = [];
    for (const rec of byKey.values()) {
      const merged = rec.list.length === 1 ? rec.list[0] : (mergeGeometries(rec.list, false) ?? rec.list[0]);
      if (rec.list.length > 1) for (const g of rec.list) g.dispose();
      out.push({ node: rec.node, slot: rec.slot, geometry: smoothNormals(merged, creaseDeg) });
    }
    return out;
  }

  occluder(): THREE.BufferGeometry | null {
    const arr = this.entries.map((e) => e.geom.clone());
    if (arr.length === 0) return null;
    const m = arr.length === 1 ? arr[0] : mergeGeometries(arr, false);
    if (arr.length > 1) for (const g of arr) g.dispose();
    return m ?? null;
  }

  dispose(): void {
    for (const e of this.entries) e.geom.dispose();
    this.entries.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface DriverBuildOptions {
  quality: QualitySettings;
  /** Extra uniform scale on top of `def.scale`. */
  scale?: number;
  /** Steering wheel / handlebar centre in driver space. Hands reach for it. */
  wheelTarget?: THREE.Vector3;
  /** Radius of that wheel — sets how far apart the hands sit. */
  wheelRadius?: number;
  /** Grip spread multiplier (handlebars want ~1.9). */
  gripSpread?: number;
}

/** One consolidated buffer per rig node — see `consolidateParts`. */
export interface DriverMergedGroup {
  node: DriverNode;
  geometry: THREE.BufferGeometry;
}

export interface DriverBuild {
  id: DriverId;
  near: DriverGroup[];
  mid: DriverGroup[];
  /**
   * `near` collapsed to one buffer per node for everything except the face and
   * the skin, which keep their own materials because they are what you actually
   * look at. Drawn with the merged atlas material.
   */
  nearMerged: DriverMergedGroup[];
  /** Node pivot offsets relative to the parent node, already scaled. */
  pivots: Record<DriverNode, THREE.Vector3>;
  /** Socket for `driverHead`, in head-local space. */
  headSocket: THREE.Vector3;
  /** Rig height above the hips origin — used to size the celebration arc. */
  height: number;
  tris: number;
}

interface Skeleton {
  hipY: number;
  torsoTop: number;
  shoulderY: number;
  shoulderHalf: number;
  neckY: number;
  headY: number;
  elbow: THREE.Vector3;
  hand: THREE.Vector3;
  chest: number;
  waist: number;
}

function skeletonFor(d: DriverDef, o: DriverBuildOptions): Skeleton {
  const bulk = d.bulk;
  const hipY = 0.012 + bulk * 0.006;
  const torsoTop = hipY + d.torso;
  const shoulderHalf = 0.098 + bulk * 0.062;
  const shoulderY = torsoTop - 0.028;
  const neckY = torsoTop + 0.004;
  const headY = neckY + d.neck + d.headR * 0.86;

  const wt = o.wheelTarget ?? new THREE.Vector3(0, shoulderY - 0.03, -0.30);
  const wr = (o.wheelRadius ?? 0.10) * (o.gripSpread ?? 1);
  const shoulder = new THREE.Vector3(shoulderHalf, shoulderY, -0.004);
  const hand = new THREE.Vector3(wr * 0.80, wt.y + wr * 0.18, wt.z + 0.010);

  // A driver's arm is about 1.25 × torso height. Chassis put their wheels at
  // wildly different distances, so clamp the reach and let the hands sit just
  // short of the rim rather than stretching the arms into drainpipes.
  const maxReach = d.torso * 1.30;
  _a.subVectors(hand, shoulder);
  const reach = _a.length();
  if (reach > maxReach) {
    hand.copy(shoulder).addScaledVector(_a.multiplyScalar(1 / reach), maxReach);
  }

  // Elbow sits outboard of the straight shoulder→hand line and a little low,
  // which is what makes an arm read as an arm rather than a bent pipe.
  const elbow = new THREE.Vector3(
    Math.max(shoulderHalf, hand.x) + 0.026 + bulk * 0.024,
    lerp(shoulderY, hand.y, 0.46) - 0.030 - bulk * 0.012,
    lerp(-0.004, hand.z, 0.44) + 0.014,
  );
  return {
    hipY, torsoTop, shoulderY, shoulderHalf, neckY, headY, elbow, hand,
    chest: 0.088 + bulk * 0.052,
    waist: 0.074 + bulk * 0.040,
  };
}

// --- torso variants --------------------------------------------------------

function buildTorso(b: RigBucket, d: DriverDef, s: Skeleton): void {
  const bulk = d.bulk;
  const front = s.chest * 0.86;
  const back = s.chest * 0.72;
  const hw = (t: number) => lerp(s.waist, s.chest * 1.12, t);

  // Main mass. Waist -> ribs -> chest -> shoulder yoke.
  const sections: LoftSection[] = d.species === 'capy'
    // "Brick with the edges sanded off": near-constant width from waist to
    // shoulder and superellipse exponents up near 5.5, so the corners chamfer
    // instead of rounding. This is the single most important shape decision on
    // the character — from behind it has to read as a slab, not a torso.
    // The BACK is deliberately shallower than the front: the mass that makes the
    // silhouette is width and chest depth, and a deep back only buys you a torso
    // buried in the seat. Measured — it took the speedster's tiny 0.16 m
    // backrest from 30.5 % of torso verts inside down to inside the band the
    // eight already occupy.
    ? [
      { z: s.hipY - 0.062, y: 0.004, hw: s.waist * 1.06, hUp: front * 0.92, hDown: back * 0.86, eSide: 5.0, eTop: 4.6, eBot: 5.2 },
      { z: s.hipY + 0.050, y: 0.002, hw: s.waist * 1.10, hUp: front * 1.04, hDown: back * 0.90, eSide: 5.4, eTop: 5.0, eBot: 5.2 },
      { z: lerp(s.hipY, s.torsoTop, 0.62), y: 0.000, hw: s.chest * 1.06, hUp: front * 1.08, hDown: back * 0.88, eSide: 5.6, eTop: 5.0, eBot: 5.2 },
      { z: s.shoulderY - 0.008, y: -0.004, hw: s.chest * 1.05, hUp: front * 1.02, hDown: back * 0.86, eSide: 5.4, eTop: 4.8, eBot: 5.0 },
      { z: s.torsoTop + 0.014, y: -0.008, hw: s.chest * 0.92, hUp: front * 0.86, hDown: back * 0.76, eSide: 4.8, eTop: 4.2, eBot: 4.6 },
    ]
    : d.species === 'fox'
      // A knitted jumper is a soft cylinder, not a tailored suit: barely any
      // waist, and a slight bell at the hem where the rib grips.
      ? [
        { z: s.hipY - 0.058, y: 0.006, hw: s.waist * 1.10, hUp: front * 0.88, hDown: back * 0.92, eSide: 3.2, eTop: 3.0, eBot: 3.4 },
        { z: s.hipY + 0.040, y: 0.004, hw: hw(0.52), hUp: front * 0.94, hDown: back * 0.92, eSide: 3.2, eTop: 3.0, eBot: 3.2 },
        { z: lerp(s.hipY, s.torsoTop, 0.58), y: -0.002, hw: hw(0.86), hUp: front * 1.02, hDown: back * 0.96, eSide: 3.4, eTop: 3.2, eBot: 3.2 },
        { z: s.shoulderY - 0.010, y: -0.006, hw: hw(1.04), hUp: front * 1.00, hDown: back * 0.98, eSide: 3.6, eTop: 3.4, eBot: 3.6 },
        { z: s.torsoTop + 0.012, y: -0.008, hw: hw(0.90), hUp: front * 0.84, hDown: back * 0.84, eSide: 3.4, eTop: 3.2, eBot: 3.4 },
      ]
      : [
        { z: s.hipY - 0.055, y: 0.006, hw: s.waist * 0.98, hUp: front * 0.72, hDown: back * 0.74, eSide: 3.4, eTop: 3.2, eBot: 3.6 },
        { z: s.hipY + 0.045, y: 0.004, hw: hw(0.30), hUp: front * 0.84, hDown: back * 0.82, eSide: 3.6, eTop: 3.4, eBot: 3.6 },
        { z: lerp(s.hipY, s.torsoTop, 0.55), y: -0.002, hw: hw(0.72), hUp: front * 1.0, hDown: back * 0.92, eSide: 3.8, eTop: 3.4, eBot: 3.6 },
        { z: s.shoulderY - 0.010, y: -0.006, hw: hw(1.0), hUp: front * 0.96, hDown: back * 0.94, eSide: 4.2, eTop: 3.6, eBot: 3.8 },
        { z: s.torsoTop + 0.012, y: -0.008, hw: hw(0.86), hUp: front * 0.80, hDown: back * 0.80, eSide: 4.0, eTop: 3.4, eBot: 3.6 },
      ];
  const shellSlot = shellSlotFor(d);
  b.add('torso', shellSlot, verticalLoft(sections, 22), { detail: 0 });

  // Shoulder caps — separate volumes so the silhouette has real shoulders.
  const cap = superShape(0.052 + bulk * 0.030, 0.040 + bulk * 0.018, 0.052 + bulk * 0.026, 3.6, 3.4, 12, 8);
  b.pair('torso', 'torso', capSlotFor(d), cap, {
    pos: [s.shoulderHalf * 0.92, s.shoulderY + 0.006, -0.004], detail: 0,
  });

  // --- suit-specific colour blocking ------------------------------------
  switch (d.outfit) {
    case 'overalls': {
      // Bib + straps in clothAlt over a light shirt collar.
      const bib = extrude([
        new THREE.Vector2(-0.062, 0), new THREE.Vector2(0.062, 0),
        new THREE.Vector2(0.052, 0.148), new THREE.Vector2(-0.052, 0.148),
      ], 0.016, 0.006);
      b.add('torso', 'clothAlt', bib, {
        pos: [0, s.hipY + 0.030, -front * 0.90], rot: [4, 0, 0], detail: 0,
      });
      const strap = roundedBox(0.030, 0.150, 0.014, 3.0);
      b.pair('torso', 'torso', 'clothAlt', strap, {
        pos: [0.048, s.shoulderY - 0.070, -front * 0.80], rot: [-8, 0, 5], detail: 1,
      });
      for (const sx of [-1, 1]) {
        b.add('torso', 'chrome', rivet(0.011, 0.006), {
          pos: [sx * 0.048, s.hipY + 0.104, -front * 0.94], rot: [-90, 0, 0], detail: 2,
        });
      }
      // Wrench in the chest pocket — pure character.
      b.add('torso', 'chrome', roundedBox(0.014, 0.070, 0.010, 4.0), {
        pos: [-0.040, s.hipY + 0.118, -front * 0.96], rot: [0, 0, 12], detail: 2,
      });
      break;
    }
    case 'race': {
      // Hard chest panel + harness webbing.
      const panel = extrude([
        new THREE.Vector2(-0.058, 0), new THREE.Vector2(0.058, 0),
        new THREE.Vector2(0.044, 0.120), new THREE.Vector2(-0.044, 0.120),
      ], 0.014, 0.007);
      b.add('torso', 'paint2', panel, { pos: [0, s.hipY + 0.062, -front * 0.92], detail: 0 });
      const web = roundedBox(0.036, 0.190, 0.012, 3.0);
      b.pair('torso', 'torso', 'clothAlt', web, {
        pos: [0.044, s.shoulderY - 0.086, -front * 0.86], rot: [-6, 0, 11], detail: 1,
      });
      b.add('torso', 'metal', roundedBox(0.052, 0.042, 0.020, 3.2), {
        pos: [0, s.hipY + 0.030, -front * 0.92], detail: 1,
      });
      break;
    }
    case 'plated': {
      // Robot: stacked chest plates, exposed chromed spine ring, glowing core.
      for (let i = 0; i < 3; i++) {
        const plate = roundedBox(0.108 - i * 0.012, 0.036, 0.030, 4.2);
        b.add('torso', i === 1 ? 'chrome' : 'metal', plate, {
          pos: [0, s.hipY + 0.052 + i * 0.044, -front * 0.82], rot: [-6 + i * 3, 0, 0], detail: 0,
        });
      }
      b.add('torso', 'glow', disc(0.028, 0.012, 0.008, 16), {
        pos: [0, s.hipY + 0.098, -front * 0.99], detail: 0,
      });
      b.add('torso', 'chrome', new THREE.TorusGeometry(0.034, 0.008, 6, 14), {
        pos: [0, s.hipY + 0.098, -front * 0.96], detail: 1,
      });
      for (let i = 0; i < 4; i++) {
        b.pair('torso', 'torso', 'chrome', rivet(0.010, 0.006), {
          pos: [0.066, s.hipY + 0.045 + i * 0.042, -front * 0.80], rot: [-90, 0, 0], detail: 2,
        });
      }
      break;
    }
    case 'armour': {
      // Knight: segmented breastplate lames + pauldrons.
      for (let i = 0; i < 3; i++) {
        const lame = shell(s.chest * 1.02, 1.05, 0.026, -0.026, 0.012, 18);
        b.add('torso', 'paint2', lame, {
          pos: [0, s.hipY + 0.052 + i * 0.052, 0.006], rot: [0, 180, 0], detail: 0,
        });
      }
      const pauldron = shell(0.070 + bulk * 0.020, 1.5, 0.030, -0.034, 0.013, 16);
      b.pair('torso', 'torso', 'paint', pauldron, {
        pos: [s.shoulderHalf * 0.88, s.shoulderY + 0.012, 0], rot: [0, 0, -14], detail: 0,
      });
      b.add('torso', 'chrome', roundedBox(0.044, 0.038, 0.018, 3.4), {
        pos: [0, s.hipY + 0.164, -front * 0.94], detail: 1,
      });
      break;
    }
    case 'jacket': {
      // Popped collar + zip + big lapels.
      const collar = shell(s.chest * 1.06, 1.15, 0.052, -0.010, 0.014, 18);
      b.add('torso', 'clothAlt', collar, { pos: [0, s.torsoTop - 0.014, 0], rot: [-6, 180, 0], detail: 0 });
      b.add('torso', 'clothAlt', collar.clone(), { pos: [0, s.torsoTop - 0.014, 0], rot: [-6, 0, 0], detail: 0 });
      const zip = roundedBox(0.014, 0.190, 0.010, 3.0);
      b.add('torso', 'chrome', zip, { pos: [0, s.hipY + 0.100, -front * 0.94], detail: 1 });
      const pocket = extrude([
        new THREE.Vector2(-0.036, 0), new THREE.Vector2(0.036, 0),
        new THREE.Vector2(0.032, 0.040), new THREE.Vector2(-0.032, 0.040),
      ], 0.012, 0.005);
      b.pair('torso', 'torso', 'clothAlt', pocket, {
        pos: [0.052, s.hipY + 0.026, -front * 0.90], detail: 2,
      });
      break;
    }
    case 'slim': {
      // Slim: one hard diagonal seam in clothAlt — the cheapest strong read.
      const sash = extrude([
        new THREE.Vector2(-0.070, -0.030), new THREE.Vector2(0.070, 0.055),
        new THREE.Vector2(0.070, 0.100), new THREE.Vector2(-0.070, 0.015),
      ], 0.016, 0.006);
      b.add('torso', 'clothAlt', sash, { pos: [0, s.hipY + 0.070, -front * 0.90], detail: 0 });
      b.add('torso', 'glow', disc(0.017, 0.010, 0, 14), {
        pos: [-0.040, s.hipY + 0.128, -front * 0.96], detail: 1,
      });
      break;
    }
    case 'shell': {
      const ridge = extrude([
        new THREE.Vector2(-0.020, 0), new THREE.Vector2(0.020, 0),
        new THREE.Vector2(0.014, 0.180), new THREE.Vector2(-0.014, 0.180),
      ], 0.022, 0.008);
      b.add('torso', 'paint2', ridge, { pos: [0, s.hipY + 0.030, back * 0.86], detail: 0 });
      break;
    }
    case 'sweater': {
      // Chunky roll-neck knit. The knit normal map carries the stitch; these
      // are the MACRO ribs, because a normal map alone still reads as a printed
      // pattern on a smooth cylinder at ten metres.
      const collarR = 0.048 + bulk * 0.014;
      const roll = sweepRing(ringProfile(collarR, 0.024, 0.026, 7), 16);
      b.add('torso', 'cloth', roll, {
        pos: [0, s.torsoTop + 0.014, -0.004], rot: [-6, 0, 0], detail: 0,
      });
      // Cream chest ruff pushing up out of the collar — the only place the
      // fox's pale chest is visible once the jumper is on.
      const ruff = superShape(0.040, 0.030, 0.026, 2.6, 2.4, 11, 7);
      b.add('torso', 'furAlt', ruff, {
        pos: [0, s.torsoTop + 0.022, -collarR * 0.70], rot: [-14, 0, 0], detail: 1,
      });
      // Horizontal rib courses up the body, alternating depth so the light
      // breaks across them.
      for (let i = 0; i < 4; i++) {
        const t = i / 3;
        const y = lerp(s.hipY - 0.030, s.torsoTop - 0.036, t);
        const w = lerp(s.waist * 1.10, s.chest * 1.10, t * 0.9);
        const rib = verticalLoft([
          { z: -0.008, y: 0, hw: w, hUp: front * 0.96, hDown: back * 0.96, eSide: 3.3, eTop: 3.1, eBot: 3.3 },
          { z: 0.008, y: 0, hw: w * 1.008, hUp: front * 0.966, hDown: back * 0.966, eSide: 3.3, eTop: 3.1, eBot: 3.3 },
        ], 20, false, false);
        b.add('torso', 'cloth', rib, {
          pos: [0, y, 0], detail: i % 2 === 0 ? 1 : 2, shade: i % 2 === 0 ? 0.90 : 0.98,
        });
      }
      // Hem: a fatter double rib where the jumper grips the hips.
      const hem = sweepRing(ringProfile(s.waist * 1.02, 0.014, 0.019, 6), 18, (th) => ({
        dr: Math.abs(Math.cos(th)) * s.waist * 0.06, dy: 0,
      }));
      b.add('torso', 'cloth', hem, { pos: [0, s.hipY - 0.052, 0.002], detail: 0, shade: 0.88 });
      break;
    }
    case 'pelt': {
      // Bare fur with a paler chest/belly field, so a big single-tone mass still
      // has two values in it.
      const belly = verticalLoft([
        { z: 0, y: 0, hw: s.chest * 0.68, hUp: 0.016, hDown: 0.016, eSide: 3.0, eTop: 3.0 },
        { z: 0.070, y: -0.004, hw: s.chest * 0.80, hUp: 0.018, hDown: 0.018, eSide: 3.2, eTop: 3.2 },
        { z: 0.150, y: -0.010, hw: s.chest * 0.62, hUp: 0.016, hDown: 0.016, eSide: 3.0, eTop: 3.0 },
      ], 18);
      b.add('torso', 'furAlt', belly, {
        pos: [0, s.hipY - 0.020, -front * 0.94], rot: [-90, 0, 0], detail: 0,
      });
      // Chunky wrapped scarf: one loop round the neck, tilted so it reads as
      // wrapped rather than as a collar, plus a hanging fringed end.
      const wrapR = 0.060 + bulk * 0.016;
      const wrap = sweepRing(ringProfile(wrapR, 0.030, 0.032, 7), 18, (th) => ({
        dr: Math.cos(th) * 0.006, dy: Math.sin(th * 2) * 0.010,
      }));
      b.add('torso', 'cloth', wrap, {
        pos: [0, s.torsoTop - 0.004, -0.006], rot: [-9, 0, 6], detail: 0,
      });
      // The hanging tail of the scarf, over the driver's left shoulder.
      const drop = verticalLoft([
        { z: 0, y: 0, hw: 0.036, hUp: 0.014, hDown: 0.014, eSide: 3.0, eTop: 3.0 },
        { z: 0.070, y: 0.006, hw: 0.040, hUp: 0.013, hDown: 0.013, eSide: 3.0, eTop: 3.0 },
        { z: 0.140, y: 0.004, hw: 0.034, hUp: 0.012, hDown: 0.012, eSide: 3.0, eTop: 3.0 },
      ], 14);
      b.add('torso', 'cloth', drop, {
        pos: [0.052, s.torsoTop - 0.030, -front * 0.86], rot: [-104, 0, 9], detail: 0, shade: 0.94,
      });
      // Fringe. Four stubby strands — cheap, and it is what makes it a scarf.
      for (let i = 0; i < 4; i++) {
        const fx = 0.052 + (i - 1.5) * 0.017;
        const strand = limb(
          _a.set(fx, s.torsoTop - 0.166, -front * 0.84),
          _b.set(fx + (i - 1.5) * 0.004, s.torsoTop - 0.206 - (i % 2) * 0.010, -front * 0.80),
          0.0065, 0.0055, 6, 2, 0,
        );
        b.add('torso', 'cloth', strand, { detail: 2, shade: 0.86 });
      }
      break;
    }
  }

  // Belt — every human driver gets one; it separates the two colour masses.
  // Animals wear no belt: their blocking comes from the pelt itself.
  if (d.species === undefined) {
    const belt = verticalLoft([
      { z: -0.014, y: 0.004, hw: s.waist * 1.04, hUp: s.chest * 0.80, hDown: back * 0.80, eSide: 3.6, eTop: 3.4 },
      { z: 0.014, y: 0.004, hw: s.waist * 1.05, hUp: s.chest * 0.81, hDown: back * 0.81, eSide: 3.6, eTop: 3.4 },
    ], 20, false, false);
    b.add('torso', d.outfit === 'plated' ? 'chrome' : 'rubber', belt, {
      pos: [0, s.hipY - 0.030, 0], detail: 1, shade: 0.85,
    });
    b.add('torso', 'chrome', roundedBox(0.040, 0.030, 0.014, 3.6), {
      pos: [0, s.hipY - 0.030, -s.chest * 0.86], detail: 2,
    });
  }

  // Neck (skipped when a helmet swallows it).
  if (d.neck > 0.002) {
    const neck = verticalLoft([
      { z: 0, y: -0.004, hw: 0.030 + bulk * 0.008, hUp: 0.028, hDown: 0.028, eSide: 3.0, eTop: 3.0 },
      { z: d.neck + 0.030, y: -0.006, hw: 0.026 + bulk * 0.006, hUp: 0.025, hDown: 0.025, eSide: 3.0, eTop: 3.0 },
    ], 14, false, false);
    b.add('torso', d.outfit === 'plated' ? 'chrome' : 'skin', neck, {
      pos: [0, s.neckY - 0.014, 0], detail: 1, shade: 0.92,
    });
  }
}

// --- legs ------------------------------------------------------------------

function buildLegs(b: RigBucket, d: DriverDef, s: Skeleton): void {
  const bulk = d.bulk;
  const hipX = 0.052 + bulk * 0.020;
  const thighR = 0.048 + bulk * 0.020;
  const shinR = 0.036 + bulk * 0.014;

  // Pelvis block ties the legs to the torso.
  b.add('hips', pelvisSlotFor(d), superShape(
    s.waist * 1.02, 0.062 + bulk * 0.012, s.waist * 0.92, 3.6, 3.4, 13, 8,
  ), { pos: [0, s.hipY - 0.058, 0], detail: 0 });

  // Seated legs: hip -> knee (forward + up) -> ankle (forward + down).
  // Animals get short stubby legs — the capybara especially, whose whole read is
  // "heavy body, almost no leg". Pulling the ankle back and up shortens the limb
  // without lifting the paw off the pedal.
  const stub = d.species === 'capy' ? 0.72 : d.species === 'fox' ? 0.90 : 1;
  const knee = new THREE.Vector3(hipX + 0.010, s.hipY - 0.030 * stub, -0.150 * stub);
  const ankle = new THREE.Vector3(hipX + 0.004, s.hipY - 0.128 * stub, -0.278 * stub);
  const hip = new THREE.Vector3(hipX, s.hipY - 0.058, -0.012);

  const thigh = limb(hip, knee, thighR, thighR * 0.82, 9, 4, 0.12);
  b.pair('hips', 'hips', thighSlotFor(d), thigh, { detail: 0 });
  const shin = limb(knee, ankle, shinR * 0.98, shinR * 0.78, 8, 3, 0.06);
  b.pair('hips', 'hips', shinSlotFor(d), shin, { detail: 0 });

  // Knee pad reads instantly at distance.
  const pad = superShape(0.040, 0.032, 0.030, 3.2, 3.0, 10, 7);
  b.pair('hips', 'hips', d.species !== undefined ? 'furDark'
    : d.outfit === 'armour' ? 'chrome' : 'clothAlt', pad, {
    pos: [knee.x, knee.y + 0.014, knee.z - 0.014], detail: 1,
    ...(d.species !== undefined ? { shade: 0.88 } : {}),
  });

  if (d.species !== undefined) {
    // Paws, not boots: a rounded pad with three toe bumps. No sole — a fox does
    // not wear shoes, and the toes are what say "animal" at the pedals.
    const paw = superShape(0.044, 0.030, 0.056, 3.0, 2.6, 10, 6);
    b.pair('hips', 'hips', footSlotFor(d), paw, {
      pos: [ankle.x, ankle.y - 0.014, ankle.z - 0.016], rot: [-12, 0, 0], detail: 0,
    });
    for (let i = 0; i < 3; i++) {
      const toe = superShape(0.013, 0.011, 0.016, 2.6, 2.4, 6, 4);
      b.pair('hips', 'hips', footSlotFor(d), toe, {
        pos: [ankle.x + (i - 1) * 0.024, ankle.y - 0.020, ankle.z - 0.062],
        detail: 2, shade: 0.80,
      });
    }
    return;
  }

  // Boot: sole + upper, toes pointed forward-down onto the pedal.
  const boot = verticalLoft([
    { z: 0, y: -0.058, hw: 0.040, hUp: 0.070, hDown: 0.026, eSide: 3.4, eTop: 3.0, eBot: 4.0 },
    { z: 0.052, y: -0.030, hw: 0.044, hUp: 0.042, hDown: 0.032, eSide: 3.6, eTop: 3.2, eBot: 3.8 },
    { z: 0.086, y: -0.010, hw: 0.042, hUp: 0.034, hDown: 0.034, eSide: 3.4, eTop: 3.2, eBot: 3.4 },
  ], 16);
  b.pair('hips', 'hips', 'rubber', boot, {
    pos: [ankle.x, ankle.y - 0.020, ankle.z + 0.006], rot: [-16, 0, 0], detail: 0, shade: 0.9,
  });
  const sole = extrude([
    new THREE.Vector2(-0.040, -0.062), new THREE.Vector2(0.040, -0.062),
    new THREE.Vector2(0.040, 0.052), new THREE.Vector2(-0.040, 0.052),
  ], 0.014, 0.005);
  b.pair('hips', 'hips', 'rubber', sole, {
    pos: [ankle.x, ankle.y - 0.048, ankle.z - 0.028], rot: [74, 0, 0], detail: 1, shade: 0.62,
  });
}

// --- arms ------------------------------------------------------------------

function buildArms(b: RigBucket, d: DriverDef, s: Skeleton): void {
  const bulk = d.bulk;
  const upperR = 0.040 + bulk * 0.020;
  const foreR = 0.034 + bulk * 0.016;
  const shoulder = new THREE.Vector3(s.shoulderHalf, s.shoulderY, -0.004);
  const armSlot = armSlotFor(d);
  const foreSlot = foreSlotFor(d);
  const handSlot = handSlotFor(d);
  const animal = d.species !== undefined;

  // Upper arm
  const upper = limb(shoulder, s.elbow, upperR, upperR * 0.84, 9, 3, 0.14);
  b.pair('armR', 'armL', armSlot, upper, { detail: 0 });

  // Elbow joint — a real ball, so the arm bends convincingly. On an animal it
  // belongs to the SLEEVE, not the paw: the cuff below it is where the colour
  // changes, so the dark "glove" starts at the cuff and not at the joint.
  const ball = superShape(upperR * 0.94, upperR * 0.94, upperR * 0.94, 3.0, 3.0, 10, 7);
  b.pair('armR', 'armL', animal ? armSlot : d.outfit === 'plated' ? 'chrome' : foreSlot, ball, {
    pos: [s.elbow.x, s.elbow.y, s.elbow.z], detail: 1,
  });
  if (d.outfit === 'plated') {
    // Piston across the elbow.
    const piston = limb(
      _a.set(s.elbow.x + 0.012, s.elbow.y + 0.040, s.elbow.z + 0.010),
      _b.set(s.elbow.x + 0.008, s.elbow.y - 0.030, s.elbow.z - 0.028),
      0.010, 0.008, 8, 2, 0,
    );
    b.pair('armR', 'armL', 'chrome', piston, { detail: 2 });
  }

  // Forearm
  const fore = limb(s.elbow, s.hand, foreR, foreR * 0.86, 9, 3, 0.10);
  b.pair('foreR', 'foreL', foreSlot, fore, { detail: 0 });

  // Cuff ring: hard edge between sleeve and glove.
  if (animal) {
    // A knitted cuff where the sleeve meets the dark paw — a hard colour edge is
    // what makes the forearm read as a glove rather than as a thin arm.
    b.pair('foreR', 'foreL', d.species === 'fox' ? 'cloth' : 'fur', sweepRing(
      ringProfile(foreR * 1.16, foreR * 0.32, foreR * 0.34, 6), 10,
    ), {
      pos: [lerp(s.elbow.x, s.hand.x, 0.14), lerp(s.elbow.y, s.hand.y, 0.14), lerp(s.elbow.z, s.hand.z, 0.14)],
      rot: [90, 0, 0], detail: 1, shade: 0.92,
    });
  } else {
    const cuff = verticalLoft([
      { z: 0, y: 0, hw: foreR * 1.14, hUp: foreR * 1.14, hDown: foreR * 1.14, eSide: 2.6, eTop: 2.6, eBot: 2.6 },
      { z: 0.016, y: 0, hw: foreR * 1.12, hUp: foreR * 1.12, hDown: foreR * 1.12, eSide: 2.6, eTop: 2.6, eBot: 2.6 },
    ], 12, false, false);
    b.pair('foreR', 'foreL', d.outfit === 'plated' ? 'metal' : 'rubber', cuff, {
      pos: [lerp(s.elbow.x, s.hand.x, 0.80), lerp(s.elbow.y, s.hand.y, 0.80), lerp(s.elbow.z, s.hand.z, 0.80)],
      rot: [90, 0, 0], detail: 1, shade: 0.8,
    });
  }

  // Glove / paw: oversized mitt gripping the rim, with a thumb over the top.
  const glove = superShape(0.036, 0.042, 0.048, 3.0, 2.8, 11, 8);
  b.pair('foreR', 'foreL', handSlot, glove, {
    pos: [s.hand.x, s.hand.y, s.hand.z], rot: [-14, 0, 0], detail: 0, shade: 0.94,
  });
  const thumb = limb(
    _a.set(s.hand.x - 0.020, s.hand.y + 0.024, s.hand.z - 0.016),
    _b.set(s.hand.x - 0.038, s.hand.y + 0.010, s.hand.z - 0.030),
    0.014, 0.011, 7, 2, 0.1,
  );
  b.pair('foreR', 'foreL', handSlot, thumb, { detail: 1, shade: 0.94 });
  for (let i = 0; i < 2; i++) {
    const knuckle = superShape(0.011, 0.009, 0.011, 2.6, 2.6, 7, 5);
    b.pair('foreR', 'foreL', animal ? handSlot : 'rubber', knuckle, {
      pos: [s.hand.x + 0.014, s.hand.y + 0.036, s.hand.z - 0.020 + i * 0.019], detail: 2,
      // A paw's knuckles are fur on fur, so they need less separation than a
      // glove's rubber knuckle pads do against the glove.
      shade: animal ? 0.80 : 0.72,
    });
  }
}

// --- tail ------------------------------------------------------------------

/**
 * The fox's tail. Authored on `hips`, so it stays put while the torso leans —
 * a tail that swung with the shoulders would saw through the seat every corner.
 *
 * ROUTING IS A CLEARANCE PROBLEM, NOT AN ART ONE, and the numbers say so.
 * `.probe-tmp/fox-space.ts` maps the free space behind the driver in this exact
 * coordinate system across all six chassis at once. The result:
 *
 *   - Everything below driver-space y = 0.18 is solid on all six — seat pan,
 *     bolsters, tub, floor. A tail leaving the hips therefore *starts inside the
 *     chassis*, for exactly the same reason the driver's own pelvis and lower
 *     back do. That part is unavoidable and invisible.
 *   - The band y = 0.24..0.34 is the only continuous corridor. Within it the
 *     midline is blocked for z = 0.08..0.28 (seat back + headrest) and needs
 *     |x| >= 0.19; past z = 0.30 the midline reopens.
 *   - y >= 0.36 with z = 0.30..0.45 is blocked by the buggy's roll cage, so the
 *     crest has to stay under y = 0.35.
 *
 * Hence the path: out over the driver's left hip, up and *outboard* of the seat
 * back, cresting at y ~ 0.33, then curling back inboard over the rear deck.
 * Which is also the better picture — a plume held out to one side reads in
 * profile as well as from behind, where a vertical tail would be hidden by the
 * driver's own head.
 */
function buildTail(b: RigBucket, d: DriverDef, s: Skeleton): void {
  const y0 = s.hipY;
  const path = [
    new THREE.Vector3(0.020, y0 + 0.120, 0.020),
    new THREE.Vector3(0.118, y0 + 0.200, 0.078),
    new THREE.Vector3(0.204, y0 + 0.252, 0.152),
    new THREE.Vector3(0.216, y0 + 0.288, 0.232),
    new THREE.Vector3(0.152, y0 + 0.308, 0.302),
    new THREE.Vector3(0.074, y0 + 0.316, 0.368),
  ];
  // Thin at the root, fattest two thirds along, tapering to a point. `fluff`
  // breaks the silhouette into three locks so it is not a smooth sausage.
  const radii = [0.026, 0.050, 0.072, 0.078, 0.062, 0.022];
  b.add('hips', 'fur', taperTube(path, radii, 12, 18, 0.055), { detail: 0 });

  // Cream tip — the single highest-contrast note on the character, and the
  // reason the tail still reads as a fox tail at minimap size.
  const tipPath = [
    new THREE.Vector3(0.186, y0 + 0.300, 0.264),
    new THREE.Vector3(0.152, y0 + 0.308, 0.302),
    new THREE.Vector3(0.072, y0 + 0.317, 0.370),
  ];
  b.add('hips', 'furAlt', taperTube(tipPath, [0.068, 0.062, 0.020], 12, 8, 0.06), { detail: 0 });

  // Fur tufts along the top edge so the outline is not a clean arc.
  for (let i = 0; i < 3; i++) {
    const t = i / 2;
    const tuft = superShape(0.026 - i * 0.005, 0.019, 0.028, 2.4, 2.2, 7, 5);
    b.add('hips', i === 2 ? 'furAlt' : 'fur', tuft, {
      pos: [
        lerp(0.196, 0.130, t),
        y0 + lerp(0.300, 0.354, t),
        lerp(0.158, 0.290, t),
      ],
      rot: [-16 + i * 12, 0, 26], detail: 2, shade: 0.93,
    });
  }
}

// --- heads -----------------------------------------------------------------

/**
 * Fox / capybara head: cranium, snout, ears, and the split face panels.
 *
 * The two face panels are the important idea. A single domed patch works for a
 * flat human face but paints an animal's mouth onto its forehead, because the
 * mouth belongs on a volume that sticks 2 cm further forward. So the atlas cell
 * is split at `ANIMAL_MUZZLE_SPLIT`: the upper band goes on the skull and
 * carries eyes and brows, the lower band goes on the snout's front face and
 * carries the philtrum, mouth and whiskers. Both are tagged `face`, so they
 * merge into one buffer — the split is free.
 */
function buildAnimalHead(b: RigBucket, d: DriverDef, s: Skeleton): void {
  const R = d.headR;
  const hy = s.headY;
  const fox = d.species === 'fox';
  const mz = R * (d.muzzle ?? 1);

  // --- cranium -----------------------------------------------------------
  b.add('head', 'fur', verticalLoft(fox
    // A fox skull is a wedge: wide at the cheeks, narrow jaw, tapering crown.
    ? [
      { z: -R * 0.92, y: -R * 0.08, hw: R * 0.48, hUp: R * 0.54, hDown: R * 0.60, eSide: 3.0, eTop: 2.8, eBot: 3.2 },
      { z: -R * 0.34, y: -R * 0.04, hw: R * 0.80, hUp: R * 0.84, hDown: R * 0.88, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
      { z: R * 0.14, y: 0, hw: R * 0.96, hUp: R * 0.90, hDown: R * 1.02, eSide: 3.1, eTop: 2.9, eBot: 3.0 },
      { z: R * 0.66, y: R * 0.02, hw: R * 0.82, hUp: R * 0.74, hDown: R * 0.88, eSide: 3.0, eTop: 2.8, eBot: 2.9 },
      { z: R * 1.00, y: R * 0.02, hw: R * 0.50, hUp: R * 0.44, hDown: R * 0.54, eSide: 2.8, eTop: 2.6, eBot: 2.7 },
    ]
    // A capybara skull is a loaf: no taper worth speaking of, corners chamfered
    // rather than rounded, and it keeps its width right up to the crown.
    : [
      { z: -R * 0.82, y: R * 0.02, hw: R * 0.68, hUp: R * 0.70, hDown: R * 0.76, eSide: 4.4, eTop: 4.0, eBot: 4.6 },
      { z: -R * 0.26, y: R * 0.01, hw: R * 0.90, hUp: R * 0.92, hDown: R * 0.96, eSide: 4.8, eTop: 4.4, eBot: 4.6 },
      { z: R * 0.26, y: 0, hw: R * 0.97, hUp: R * 0.88, hDown: R * 1.02, eSide: 5.0, eTop: 4.6, eBot: 4.8 },
      { z: R * 0.78, y: 0, hw: R * 0.84, hUp: R * 0.74, hDown: R * 0.88, eSide: 4.4, eTop: 4.0, eBot: 4.2 },
      { z: R * 1.02, y: 0, hw: R * 0.56, hUp: R * 0.50, hDown: R * 0.60, eSide: 3.8, eTop: 3.4, eBot: 3.6 },
    ], 22), { pos: [0, hy, 0], detail: 0 });

  // --- snout -------------------------------------------------------------
  // `loft` sweeps along +Z and wants ascending z, so the tip is authored first.
  const tipZ = -R * 0.45 - mz;
  const snout = fox
    ? loft([
      { z: tipZ, y: hy - R * 0.34, hw: R * 0.30, hUp: R * 0.22, hDown: R * 0.26, eSide: 2.8, eTop: 2.6, eBot: 2.8 },
      { z: lerp(tipZ, -R * 0.45, 0.46), y: hy - R * 0.30, hw: R * 0.40, hUp: R * 0.28, hDown: R * 0.34, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
      { z: -R * 0.45, y: hy - R * 0.24, hw: R * 0.52, hUp: R * 0.36, hDown: R * 0.42, eSide: 3.2, eTop: 3.0, eBot: 3.0 },
      { z: R * 0.10, y: hy - R * 0.18, hw: R * 0.60, hUp: R * 0.42, hDown: R * 0.48, eSide: 3.2, eTop: 3.0, eBot: 3.0 },
    ], { segments: 18 })
    : loft([
      { z: tipZ, y: hy - R * 0.20, hw: R * 0.54, hUp: R * 0.32, hDown: R * 0.36, eSide: 4.2, eTop: 3.8, eBot: 4.0 },
      { z: lerp(tipZ, -R * 0.40, 0.50), y: hy - R * 0.19, hw: R * 0.62, hUp: R * 0.36, hDown: R * 0.42, eSide: 4.6, eTop: 4.2, eBot: 4.2 },
      { z: -R * 0.40, y: hy - R * 0.16, hw: R * 0.68, hUp: R * 0.42, hDown: R * 0.46, eSide: 4.6, eTop: 4.2, eBot: 4.2 },
      { z: R * 0.16, y: hy - R * 0.12, hw: R * 0.76, hUp: R * 0.50, hDown: R * 0.52, eSide: 4.4, eTop: 4.0, eBot: 4.0 },
    ], { segments: 18 });
  b.add('head', 'furAlt', snout, { detail: 0 });

  // Cheek tufts: pale fur flaring out below the eyes. On the fox these are the
  // widest thing on the head, which is what stops the wedge reading as a beak.
  const cheek = fox
    ? superShape(R * 0.26, R * 0.24, R * 0.30, 2.6, 2.4, 9, 6)
    : superShape(R * 0.24, R * 0.22, R * 0.26, 3.2, 3.0, 9, 6);
  b.pair('head', 'head', 'furAlt', cheek, {
    pos: [R * (fox ? 0.74 : 0.80), hy - R * (fox ? 0.22 : 0.14), -R * (fox ? 0.30 : 0.20)],
    rot: [0, fox ? -22 : -14, fox ? -14 : -6], detail: 0,
  });

  // --- face panels -------------------------------------------------------
  // Upper band: eyes + brows, on the skull front.
  const eyeW = R * (fox ? 1.56 : 1.66);
  const eyeH = R * (fox ? 0.74 : 0.70);
  const eyeZ = R * (fox ? 0.88 : 0.80);
  b.add('head', 'face', facePatch(eyeW, eyeH, eyeZ, R * 0.24, 6, ANIMAL_MUZZLE_SPLIT, 1), {
    pos: [0, hy + R * (fox ? 0.28 : 0.34), 0], detail: 0,
  });
  // Lower band: philtrum + mouth + whiskers, on the snout's front face.
  const mW = R * (fox ? 0.64 : 1.12);
  const mH = R * (fox ? 0.54 : 0.74);
  b.add('head', 'face', facePatch(mW, mH, 0, R * 0.10, 5, 0, ANIMAL_MUZZLE_SPLIT), {
    pos: [0, hy - R * (fox ? 0.34 : 0.20), tipZ - R * 0.012], rot: [fox ? -8 : -5, 0, 0], detail: 0,
  });

  // Nose — tiny, dark, and the shadow under it is what makes a snout read in 3D.
  const nose = fox
    ? superShape(R * 0.135, R * 0.105, R * 0.105, 2.4, 2.2, 9, 7)
    : superShape(R * 0.200, R * 0.082, R * 0.100, 3.0, 2.6, 10, 7);
  b.add('head', 'plastic', nose, {
    pos: [0, hy - R * (fox ? 0.185 : 0.055), tipZ - R * (fox ? 0.02 : 0.04)], detail: 0,
  });

  // --- ears --------------------------------------------------------------
  if (fox) {
    // Large triangular ears with dark tips. This is the head's "one idea":
    // nothing else on the roster has a tall paired triangle above the skull.
    const eh = R * 0.98;
    const earPlace: RigPlace = {
      pos: [R * 0.44, hy + R * 0.72, R * 0.06], rot: [-8, 0, -24], detail: 0,
    };
    b.pair('head', 'head', 'fur', earWedge(R * 0.36, eh, R * 0.15, 0.22), earPlace);
    // The dark tip is a second wedge in the SAME local frame, so it lands on the
    // point however the ear is leaned.
    const tip = earWedge(R * 0.23, eh * 0.44, R * 0.16, 0.22);
    tip.translate(eh * 0.22 * 0.56, eh * 0.58, 0);
    b.pair('head', 'head', 'furDark', tip, earPlace);
    // Pale inner ear, pressed into the front face.
    const inner = earWedge(R * 0.21, eh * 0.62, R * 0.05, 0.22);
    inner.translate(eh * 0.05, eh * 0.16, -R * 0.070);
    b.pair('head', 'head', 'furAlt', inner, { ...earPlace, detail: 1 });
  } else {
    // Small rounded ears, set high and wide — deliberately almost nothing, so
    // the head reads as one blunt mass.
    b.pair('head', 'head', 'fur', superShape(R * 0.20, R * 0.19, R * 0.11, 2.8, 2.6, 10, 7), {
      pos: [R * 0.78, hy + R * 0.68, R * 0.14], rot: [0, 0, -18], detail: 0,
    });
    b.pair('head', 'head', 'furDark', disc(R * 0.11, R * 0.030, 0, 9), {
      pos: [R * 0.80, hy + R * 0.70, R * 0.06], rot: [0, 74, 0], detail: 1, shade: 0.9,
    });
  }

  // Brow ridge tufts: a pale sliver over each eye. Cheap, and it gives the AO
  // bake something to darken so the eyes are not two decals on a sphere.
  b.pair('head', 'head', 'furAlt', superShape(R * 0.20, R * 0.055, R * 0.10, 2.6, 2.4, 7, 4), {
    pos: [R * 0.36, hy + R * (fox ? 0.52 : 0.56), -R * (fox ? 0.78 : 0.70)],
    rot: [0, 0, fox ? -12 : -8], detail: 2, shade: 0.95,
  });
}

function buildHead(b: RigBucket, d: DriverDef, s: Skeleton): THREE.Vector3 {
  const R = d.headR;
  const hy = s.headY;
  const isRobot = d.head === 'robot';
  const animal = d.species !== undefined;
  const skullSlot: MaterialSlot = isRobot ? 'chrome' : 'skin';

  // --- cranium ---------------------------------------------------------
  if (animal) {
    buildAnimalHead(b, d, s);
  } else if (d.head === 'bubble') {
    // Alien: tall, tapered, back-swept cranium.
    b.add('head', 'skin', verticalLoft([
      { z: -R * 0.98, y: 0.004, hw: R * 0.54, hUp: R * 0.60, hDown: R * 0.52, eSide: 2.8, eTop: 2.6, eBot: 3.0 },
      { z: -R * 0.30, y: 0.000, hw: R * 0.86, hUp: R * 0.92, hDown: R * 0.86, eSide: 2.6, eTop: 2.4, eBot: 2.8 },
      { z: R * 0.34, y: -0.014, hw: R * 0.96, hUp: R * 0.80, hDown: R * 1.10, eSide: 2.6, eTop: 2.6, eBot: 2.6 },
      { z: R * 1.10, y: -0.030, hw: R * 0.62, hUp: R * 0.44, hDown: R * 0.90, eSide: 2.6, eTop: 2.6, eBot: 2.6 },
    ], 22), { pos: [0, hy, 0], detail: 0 });
  } else if (isRobot) {
    b.add('head', 'metal', verticalLoft([
      { z: -R * 0.92, y: 0, hw: R * 0.62, hUp: R * 0.64, hDown: R * 0.60, eSide: 4.4, eTop: 4.0, eBot: 4.4 },
      { z: -R * 0.20, y: 0, hw: R * 0.94, hUp: R * 0.92, hDown: R * 0.90, eSide: 5.0, eTop: 4.4, eBot: 4.6 },
      { z: R * 0.56, y: 0, hw: R * 0.90, hUp: R * 0.86, hDown: R * 0.86, eSide: 5.0, eTop: 4.4, eBot: 4.6 },
      { z: R * 0.94, y: 0, hw: R * 0.64, hUp: R * 0.60, hDown: R * 0.60, eSide: 4.2, eTop: 3.6, eBot: 3.8 },
    ], 20), { pos: [0, hy, 0], detail: 0 });
  } else {
    // Human skull: slightly egg-shaped, jaw narrower than the crown.
    b.add('head', skullSlot, verticalLoft([
      { z: -R * 0.98, y: -0.008, hw: R * 0.62, hUp: R * 0.64, hDown: R * 0.72, eSide: 3.0, eTop: 2.8, eBot: 3.2 },
      { z: -R * 0.36, y: -0.006, hw: R * 0.90, hUp: R * 0.90, hDown: R * 0.94, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
      { z: R * 0.26, y: 0.000, hw: R * 0.98, hUp: R * 0.94, hDown: R * 0.98, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
      { z: R * 0.92, y: 0.002, hw: R * 0.70, hUp: R * 0.66, hDown: R * 0.70, eSide: 2.8, eTop: 2.6, eBot: 2.8 },
    ], 22), { pos: [0, hy, 0], detail: 0 });
    // Ears
    const ear = superShape(R * 0.10, R * 0.20, R * 0.13, 2.6, 2.4, 8, 6);
    b.pair('head', 'head', 'skin', ear, { pos: [R * 0.94, hy + R * 0.02, R * 0.06], rot: [0, 0, -8], detail: 1 });
  }

  // --- face patch ------------------------------------------------------
  // Animals already placed their own split panels and snout nose.
  if (!animal) {
    const faceW = d.head === 'bubble' ? R * 1.62 : R * 1.52;
    const faceH = d.head === 'bubble' ? R * 1.42 : R * 1.56;
    const faceZ = -(R * (d.head === 'bubble' ? 0.84 : 0.92));
    b.add('head', 'face', facePatch(faceW, faceH, -faceZ, R * 0.30, 6), {
      pos: [0, hy + R * (isRobot ? 0.04 : 0.02), 0], detail: 0,
    });

    if (!isRobot && d.head !== 'bubble') {
      // Nose — tiny, but its shadow is what makes a face read in 3D.
      const nose = superShape(R * 0.11, R * 0.10, R * 0.13, 2.4, 2.2, 8, 6);
      b.add('head', 'skin', nose, { pos: [0, hy - R * 0.02, faceZ - R * 0.06], detail: 1 });
    }
  }

  // --- headwear --------------------------------------------------------
  switch (d.head) {
    case 'cap': {
      // Backwards baseball cap + goggles pushed up on the forehead.
      b.add('head', 'paint', verticalLoft([
        { z: -0.004, y: -0.004, hw: R * 1.03, hUp: R * 1.00, hDown: R * 1.06, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
        { z: R * 0.52, y: -0.004, hw: R * 0.92, hUp: R * 0.88, hDown: R * 0.94, eSide: 2.8, eTop: 2.6, eBot: 2.8 },
        { z: R * 0.92, y: -0.006, hw: R * 0.60, hUp: R * 0.56, hDown: R * 0.60, eSide: 2.6, eTop: 2.6, eBot: 2.6 },
      ], 20, false), { pos: [0, hy + R * 0.16, 0], detail: 0 });
      const brim = extrude([
        new THREE.Vector2(-R * 0.78, 0), new THREE.Vector2(R * 0.78, 0),
        new THREE.Vector2(R * 0.56, R * 0.86), new THREE.Vector2(-R * 0.56, R * 0.86),
      ], 0.014, 0.006);
      b.add('head', 'paint2', brim, {
        pos: [0, hy + R * 0.20, R * 0.78], rot: [78, 0, 0], detail: 0,
      });
      b.add('head', 'paint2', new THREE.SphereGeometry(R * 0.10, 8, 6), {
        pos: [0, hy + R * 1.10, 0], detail: 2,
      });
      // Goggles on the forehead
      const band = shell(R * 1.04, 1.35, 0.020, -0.020, 0.010, 18);
      b.add('head', 'rubber', band, { pos: [0, hy + R * 0.60, 0], rot: [0, 180, 0], detail: 1, shade: 0.7 });
      const lens = disc(R * 0.30, 0.014, 0, 16);
      b.pair('head', 'head', 'glass', lens, {
        pos: [R * 0.40, hy + R * 0.62, -R * 0.86], rot: [-14, 0, 0], detail: 1,
      });
      b.pair('head', 'head', 'chrome', new THREE.TorusGeometry(R * 0.31, R * 0.045, 6, 13), {
        pos: [R * 0.40, hy + R * 0.62, -R * 0.86], rot: [-14, 0, 0], detail: 1,
      });
      break;
    }
    case 'fullHelmet': {
      // Full-face: shell + chin bar + winglets + tinted visor.
      b.add('head', 'paint', verticalLoft([
        { z: -R * 1.06, y: -0.004, hw: R * 0.86, hUp: R * 0.90, hDown: R * 0.92, eSide: 3.4, eTop: 3.0, eBot: 3.4 },
        { z: -R * 0.48, y: -0.004, hw: R * 1.10, hUp: R * 1.14, hDown: R * 1.14, eSide: 3.2, eTop: 3.0, eBot: 3.2 },
        { z: R * 0.28, y: -0.004, hw: R * 1.16, hUp: R * 1.18, hDown: R * 1.20, eSide: 3.2, eTop: 3.0, eBot: 3.2 },
        { z: R * 1.02, y: -0.004, hw: R * 0.82, hUp: R * 0.84, hDown: R * 0.90, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
      ], 24), { pos: [0, hy + R * 0.04, 0], detail: 0 });
      // Visor aperture, tinted, wraps around the front.
      const visor = shell(R * 1.20, 1.05, R * 0.34, -R * 0.34, 0.012, 22);
      b.add('head', 'glass', visor, { pos: [0, hy + R * 0.14, 0], rot: [0, 180, 0], detail: 0 });
      const surround = shell(R * 1.24, 1.10, R * 0.42, -R * 0.42, 0.016, 22);
      b.add('head', 'metal', surround, { pos: [0, hy + R * 0.14, 0], rot: [0, 180, 0], detail: 1, shade: 0.6 });
      // Chin bar
      b.add('head', 'paint2', verticalLoft([
        { z: -0.012, y: -R * 0.62, hw: R * 0.78, hUp: R * 0.52, hDown: R * 0.30, eSide: 3.2, eTop: 3.0, eBot: 3.4 },
        { z: 0.012, y: -R * 0.62, hw: R * 0.80, hUp: R * 0.54, hDown: R * 0.30, eSide: 3.2, eTop: 3.0, eBot: 3.4 },
      ], 18, false, false), { pos: [0, hy - R * 0.42, 0], detail: 0 });
      // Winglets
      const wing = extrude([
        new THREE.Vector2(0, 0), new THREE.Vector2(R * 0.62, R * 0.10),
        new THREE.Vector2(R * 0.58, R * 0.30), new THREE.Vector2(0, R * 0.26),
      ], 0.010, 0.004);
      b.pair('head', 'head', 'paint2', wing, {
        pos: [R * 0.94, hy + R * 0.06, R * 0.24], rot: [0, 96, 8], detail: 1,
      });
      // Top vent + spine stripe
      b.add('head', 'metal', roundedBox(R * 0.34, R * 0.10, R * 0.62, 4.0), {
        pos: [0, hy + R * 1.06, R * 0.05], detail: 1, shade: 0.55,
      });
      break;
    }
    case 'robot': {
      // Chromed dome + single optic band + antenna.
      b.add('head', 'chrome', verticalLoft([
        { z: 0, y: 0, hw: R * 0.94, hUp: R * 0.92, hDown: R * 0.92, eSide: 4.6, eTop: 3.0, eBot: 4.0 },
        { z: R * 0.44, y: 0, hw: R * 0.72, hUp: R * 0.70, hDown: R * 0.70, eSide: 3.4, eTop: 2.6, eBot: 3.0 },
      ], 20, false), { pos: [0, hy + R * 0.66, 0], detail: 0 });
      const band = shell(R * 0.99, 1.25, R * 0.24, -R * 0.24, 0.012, 20);
      b.add('head', 'glass', band, { pos: [0, hy + R * 0.08, 0], rot: [0, 180, 0], detail: 0 });
      // Jaw grille
      for (let i = 0; i < 4; i++) {
        b.add('head', 'metal', roundedBox(R * 0.72 - i * R * 0.04, R * 0.045, R * 0.05, 4.0), {
          pos: [0, hy - R * 0.44 - i * R * 0.10, -R * 0.80], detail: 2, shade: 0.5,
        });
      }
      // Antenna with a glowing bead
      b.add('head', 'chrome', limb(
        _a.set(R * 0.44, hy + R * 0.92, R * 0.20),
        _b.set(R * 0.66, hy + R * 1.72, R * 0.34), 0.008, 0.005, 7, 2, 0,
      ), { detail: 1 });
      b.add('head', 'glow', new THREE.SphereGeometry(R * 0.10, 10, 8), {
        pos: [R * 0.66, hy + R * 1.76, R * 0.34], detail: 0,
      });
      // Ear pods
      b.pair('head', 'head', 'metal', disc(R * 0.30, R * 0.14, R * 0.08, 14), {
        pos: [R * 0.94, hy + R * 0.06, 0], rot: [0, 90, 0], detail: 1,
      });
      break;
    }
    case 'trucker': {
      // Wide flat cap sitting low, plus a jaw that reads as a grin.
      b.add('head', 'paint', verticalLoft([
        { z: 0, y: 0, hw: R * 1.06, hUp: R * 1.02, hDown: R * 1.06, eSide: 4.2, eTop: 3.6, eBot: 4.0 },
        { z: R * 0.34, y: 0, hw: R * 1.00, hUp: R * 0.96, hDown: R * 1.00, eSide: 4.0, eTop: 3.0, eBot: 3.6 },
      ], 20, false), { pos: [0, hy + R * 0.44, 0], detail: 0 });
      const brim = extrude([
        new THREE.Vector2(-R * 1.02, 0), new THREE.Vector2(R * 1.02, 0),
        new THREE.Vector2(R * 0.86, R * 1.02), new THREE.Vector2(-R * 0.86, R * 1.02),
      ], 0.016, 0.007);
      b.add('head', 'plastic', brim, { pos: [0, hy + R * 0.46, -R * 0.98], rot: [86, 0, 0], detail: 0 });
      b.add('head', 'paint2', verticalLoft([
        { z: -0.010, y: 0, hw: R * 1.05, hUp: R * 1.02, hDown: R * 1.05, eSide: 4.2, eTop: 3.6, eBot: 4.0 },
        { z: 0.010, y: 0, hw: R * 1.06, hUp: R * 1.03, hDown: R * 1.06, eSide: 4.2, eTop: 3.6, eBot: 4.0 },
      ], 18, false, false), { pos: [0, hy + R * 0.40, 0], detail: 1 });
      // Heavy jaw + sideburns
      b.add('head', 'skin', superShape(R * 0.86, R * 0.34, R * 0.72, 3.6, 3.0, 12, 7), {
        pos: [0, hy - R * 0.66, -R * 0.08], detail: 1,
      });
      break;
    }
    case 'aero': {
      // Teardrop time-trial helmet: huge, smooth, with a long tail.
      b.add('head', 'paint', verticalLoft([
        { z: -R * 1.30, y: -0.006, hw: R * 0.94, hUp: R * 0.96, hDown: R * 1.00, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
        { z: -R * 0.44, y: -0.006, hw: R * 1.16, hUp: R * 1.20, hDown: R * 1.18, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
        { z: R * 0.44, y: -0.010, hw: R * 1.12, hUp: R * 1.24, hDown: R * 1.06, eSide: 3.2, eTop: 3.0, eBot: 3.0 },
        { z: R * 1.50, y: -0.030, hw: R * 0.56, hUp: R * 0.86, hDown: R * 0.42, eSide: 3.0, eTop: 3.0, eBot: 3.0 },
        { z: R * 2.10, y: -0.048, hw: R * 0.16, hUp: R * 0.40, hDown: R * 0.10, eSide: 2.8, eTop: 3.0, eBot: 3.0 },
      ], 24), { pos: [0, hy + R * 0.12, 0], detail: 0 });
      const visor = shell(R * 1.22, 0.98, R * 0.40, -R * 0.30, 0.012, 22);
      b.add('head', 'glass', visor, { pos: [0, hy + R * 0.10, 0], rot: [0, 180, 0], detail: 0 });
      const lip = shell(R * 1.26, 1.02, R * 0.06, -R * 0.42, 0.014, 22);
      b.add('head', 'paint2', lip, { pos: [0, hy - R * 0.28, 0], rot: [0, 180, 0], detail: 1 });
      // Racing stripe along the crown
      b.add('head', 'paint2', verticalLoft([
        { z: -R * 1.10, y: 0, hw: R * 0.16, hUp: R * 1.22, hDown: 0, eSide: 3.0, eTop: 3.0 },
        { z: R * 1.20, y: -0.02, hw: R * 0.13, hUp: R * 1.10, hDown: 0, eSide: 3.0, eTop: 3.0 },
      ], 12, false, false), { pos: [0, hy + R * 0.12, 0], detail: 2 });
      break;
    }
    case 'bubble': {
      // Glass fishbowl on a chromed collar ring.
      b.add('head', 'glass', new THREE.SphereGeometry(R * 1.34, 16, 11), {
        pos: [0, hy + R * 0.18, 0], detail: 0,
      });
      b.add('head', 'chrome', new THREE.TorusGeometry(R * 1.20, R * 0.13, 8, 18), {
        pos: [0, hy - R * 0.42, 0], rot: [90, 0, 0], detail: 0,
      });
      b.add('head', 'glow', new THREE.TorusGeometry(R * 1.06, R * 0.05, 6, 16), {
        pos: [0, hy - R * 0.36, 0], rot: [90, 0, 0], detail: 1,
      });
      // Twin breathing pipes running back to the pack.
      for (const sx of [-1, 1]) {
        b.add('head', 'rubber', tube([
          new THREE.Vector3(sx * R * 0.90, hy - R * 0.44, R * 0.42),
          new THREE.Vector3(sx * R * 1.04, hy - R * 0.86, R * 0.68),
          new THREE.Vector3(sx * R * 0.80, hy - R * 1.30, R * 0.72),
        ], R * 0.09, 8), { detail: 1, shade: 0.7 });
      }
      break;
    }
    case 'greatHelm': {
      // Great-helm: flat-topped shell, T-slit, tall crest.
      b.add('head', 'paint', verticalLoft([
        { z: -R * 1.02, y: -0.004, hw: R * 0.90, hUp: R * 0.92, hDown: R * 0.92, eSide: 4.6, eTop: 4.0, eBot: 4.4 },
        { z: -R * 0.30, y: -0.004, hw: R * 1.10, hUp: R * 1.12, hDown: R * 1.10, eSide: 4.8, eTop: 4.2, eBot: 4.4 },
        { z: R * 0.52, y: -0.004, hw: R * 1.04, hUp: R * 1.04, hDown: R * 1.02, eSide: 5.0, eTop: 4.2, eBot: 4.4 },
        { z: R * 1.02, y: -0.004, hw: R * 0.78, hUp: R * 0.78, hDown: R * 0.78, eSide: 4.2, eTop: 3.4, eBot: 3.6 },
      ], 22), { pos: [0, hy + R * 0.06, 0], detail: 0 });
      // T-slit: horizontal eye slot + vertical breath slot, both dark glass.
      b.add('head', 'glass', roundedBox(R * 1.60, R * 0.22, R * 0.10, 5.0), {
        pos: [0, hy + R * 0.18, -R * 1.02], detail: 0,
      });
      b.add('head', 'glass', roundedBox(R * 0.20, R * 0.70, R * 0.10, 5.0), {
        pos: [0, hy - R * 0.20, -R * 1.02], detail: 0,
      });
      // Crest
      const crest = extrude([
        new THREE.Vector2(-R * 0.90, 0), new THREE.Vector2(R * 0.86, 0),
        new THREE.Vector2(R * 0.50, R * 0.62), new THREE.Vector2(-R * 0.64, R * 0.56),
      ], 0.016, 0.006);
      b.add('head', 'chrome', crest, { pos: [0, hy + R * 1.06, 0], rot: [0, 90, 0], detail: 0 });
      for (let i = 0; i < 4; i++) {
        b.add('head', 'paint2', roundedBox(R * 0.26, R * 0.14, R * 0.12, 4.0), {
          pos: [0, hy + R * 1.14 + i * R * 0.16, -R * 0.34 + i * R * 0.20], rot: [0, 0, 0], detail: 2,
        });
      }
      // Rivet row around the base
      for (let i = 0; i < 7; i++) {
        const a0 = (-0.9 + (i / 6) * 1.8);
        b.add('head', 'chrome', rivet(R * 0.075, R * 0.05), {
          pos: [Math.sin(a0) * R * 1.06, hy - R * 0.66, -Math.cos(a0) * R * 1.02],
          rot: [90, 0, 0], detail: 2,
        });
      }
      break;
    }
    case 'flightCap': {
      // Leather cap + earflaps + strap + goggles worn over the eyes.
      b.add('head', 'clothAlt', verticalLoft([
        { z: -R * 0.10, y: -0.004, hw: R * 1.05, hUp: R * 1.02, hDown: R * 1.08, eSide: 3.2, eTop: 3.0, eBot: 3.2 },
        { z: R * 0.54, y: -0.004, hw: R * 0.94, hUp: R * 0.90, hDown: R * 0.96, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
        { z: R * 0.96, y: -0.006, hw: R * 0.62, hUp: R * 0.58, hDown: R * 0.62, eSide: 2.8, eTop: 2.6, eBot: 2.8 },
      ], 20, false), { pos: [0, hy + R * 0.12, 0], detail: 0 });
      const flap = superShape(R * 0.20, R * 0.40, R * 0.30, 3.0, 2.8, 10, 7);
      b.pair('head', 'head', 'clothAlt', flap, {
        pos: [R * 0.98, hy - R * 0.30, R * 0.04], rot: [0, 0, -6], detail: 0,
      });
      // Goggles over the eyes — the key silhouette beat.
      const strap = shell(R * 1.06, 1.45, 0.024, -0.024, 0.011, 20);
      b.add('head', 'rubber', strap, { pos: [0, hy + R * 0.24, 0], rot: [0, 180, 0], detail: 0, shade: 0.65 });
      b.pair('head', 'head', 'glass', disc(R * 0.34, 0.014, 0, 18), {
        pos: [R * 0.42, hy + R * 0.24, -R * 0.90], rot: [0, 8, 0], detail: 0,
      });
      b.pair('head', 'head', 'chrome', new THREE.TorusGeometry(R * 0.35, R * 0.055, 6, 14), {
        pos: [R * 0.42, hy + R * 0.24, -R * 0.90], rot: [0, 8, 0], detail: 0,
      });
      b.add('head', 'chrome', roundedBox(R * 0.24, R * 0.06, R * 0.06, 4.0), {
        pos: [0, hy + R * 0.24, -R * 0.92], detail: 1,
      });
      break;
    }
    case 'beret': {
      // Soft felted beret worn at a tilt, with the little stalk on top. Tilted
      // headwear is worth a surprising amount: a symmetrical hat reads as part
      // of the skull, an asymmetrical one reads as a *choice* the character made.
      const tilt: RigPlace = { pos: [-R * 0.10, hy + R * 0.68, R * 0.05], rot: [-9, 0, 19] };
      b.add('head', 'clothAlt', verticalLoft([
        { z: -R * 0.10, y: 0, hw: R * 0.88, hUp: R * 0.84, hDown: R * 0.92, eSide: 3.2, eTop: 3.0, eBot: 3.4 },
        { z: R * 0.10, y: -R * 0.01, hw: R * 1.08, hUp: R * 1.02, hDown: R * 1.10, eSide: 3.0, eTop: 2.8, eBot: 3.0 },
        { z: R * 0.30, y: -R * 0.02, hw: R * 0.96, hUp: R * 0.90, hDown: R * 0.98, eSide: 2.9, eTop: 2.7, eBot: 2.8 },
        { z: R * 0.42, y: -R * 0.02, hw: R * 0.56, hUp: R * 0.52, hDown: R * 0.58, eSide: 2.8, eTop: 2.6, eBot: 2.7 },
      ], 22), { ...tilt, detail: 0 });
      // The rolled headband the beret grips with — an actual separate volume,
      // because a beret with no band is a bowl.
      b.add('head', 'clothAlt', sweepRing(ringProfile(R * 0.90, R * 0.075, R * 0.055, 6), 16, (th) => ({
        dr: Math.sin(th * 2) * R * 0.035, dy: 0,
      })), { ...tilt, pos: [-R * 0.10, hy + R * 0.60, R * 0.05], detail: 0, shade: 0.86 });
      // Stalk.
      b.add('head', 'clothAlt', lathe([
        new THREE.Vector2(0, 0), new THREE.Vector2(R * 0.055, R * 0.012),
        new THREE.Vector2(R * 0.048, R * 0.090), new THREE.Vector2(R * 0.026, R * 0.118),
        new THREE.Vector2(0, R * 0.124),
      ], 9), { ...tilt, pos: [-R * 0.13, hy + R * 1.08, R * 0.03], detail: 1, shade: 0.92 });

      // Round thin dark-rimmed spectacles. Two rims + a bridge + temples: the
      // temples matter, they are what stop the glasses floating off the face.
      const rimR = R * 0.34;
      const lensZ = -R * 0.86;
      const lensY = hy + R * 0.22;
      b.pair('head', 'head', 'plastic', new THREE.TorusGeometry(rimR, R * 0.030, 5, 12), {
        pos: [R * 0.40, lensY, lensZ], rot: [0, 9, 0], detail: 0,
      });
      b.pair('head', 'head', 'glass', disc(rimR * 0.94, R * 0.014, 0, 10), {
        pos: [R * 0.40, lensY, lensZ + R * 0.004], rot: [0, 9, 0], detail: 0,
      });
      b.add('head', 'plastic', limb(
        _a.set(-R * 0.09, lensY + R * 0.06, lensZ - R * 0.01),
        _b.set(R * 0.09, lensY + R * 0.06, lensZ - R * 0.01),
        R * 0.024, R * 0.024, 6, 2, 0,
      ), { detail: 1 });
      b.pair('head', 'head', 'plastic', limb(
        _a.set(R * 0.70, lensY + R * 0.03, lensZ + R * 0.10),
        _b.set(R * 0.94, lensY + R * 0.12, R * 0.30),
        R * 0.020, R * 0.016, 6, 2, 0,
      ), { detail: 1 });
      break;
    }
    case 'bucketHat': {
      // Rust bucket hat: soft crown, darker band, floppy asymmetric brim. The
      // brim is the "one idea" — a wide soft disc is the exact opposite read to
      // the fox's two hard triangles, which is what keeps the pair distinct.
      b.add('head', 'clothAlt', verticalLoft([
        { z: -R * 0.06, y: 0, hw: R * 1.00, hUp: R * 0.98, hDown: R * 1.04, eSide: 4.0, eTop: 3.8, eBot: 4.2 },
        { z: R * 0.28, y: 0, hw: R * 1.02, hUp: R * 1.00, hDown: R * 1.04, eSide: 4.2, eTop: 4.0, eBot: 4.0 },
        { z: R * 0.52, y: -R * 0.01, hw: R * 0.92, hUp: R * 0.90, hDown: R * 0.94, eSide: 3.8, eTop: 3.6, eBot: 3.6 },
        { z: R * 0.64, y: -R * 0.01, hw: R * 0.60, hUp: R * 0.58, hDown: R * 0.62, eSide: 3.2, eTop: 3.0, eBot: 3.0 },
      ], 22), { pos: [0, hy + R * 0.60, R * 0.02], rot: [-5, 0, 6], detail: 0 });
      // Darker grosgrain band round the base of the crown.
      b.add('head', 'furDark', sweepRing(ringProfile(R * 1.03, R * 0.052, R * 0.075, 6), 18), {
        pos: [0, hy + R * 0.62, R * 0.02], rot: [-5, 0, 6], detail: 0, shade: 0.82,
      });
      // Floppy brim. The warp is what makes it floppy: it dips front and back,
      // lifts at the sides, and its outline is not a circle.
      b.add('head', 'clothAlt', sweepRing(
        brimProfile(R * 0.96, R * 1.62, R * 0.062, R * 0.20), 26, (th) => ({
          dr: Math.sin(th * 2 + 0.7) * R * 0.070,
          dy: -R * 0.055 * (0.5 - 0.5 * Math.cos(th * 2)) + Math.sin(th * 3) * R * 0.028,
        }),
      ), { pos: [0, hy + R * 0.56, R * 0.02], rot: [-5, 0, 6], detail: 0, shade: 0.94 });
      break;
    }
  }

  // Scarf trailing over the shoulder — belongs to the torso so it doesn't
  // swing with the head.
  if (d.scarf) {
    const knot = superShape(0.052, 0.032, 0.046, 3.0, 2.8, 10, 7);
    b.add('torso', 'clothAlt', knot, { pos: [0.018, s.torsoTop - 0.010, -s.chest * 0.66], detail: 1 });
    const tail = verticalLoft([
      { z: 0, y: 0, hw: 0.036, hUp: 0.012, hDown: 0.012, eSide: 3.0, eTop: 3.0 },
      { z: 0.10, y: 0.008, hw: 0.042, hUp: 0.010, hDown: 0.010, eSide: 3.0, eTop: 3.0 },
      { z: 0.19, y: 0.026, hw: 0.030, hUp: 0.008, hDown: 0.008, eSide: 3.0, eTop: 3.0 },
    ], 12);
    b.add('torso', 'clothAlt', tail, {
      pos: [0.030, s.torsoTop - 0.030, s.chest * 0.42], rot: [128, 6, 0], detail: 0,
    });
  }

  // Sits above the ears / hat brim so an item balanced on the socket does not
  // vanish inside the headwear.
  return new THREE.Vector3(0, hy + R * (animal ? 1.42 : 1.10), 0);
}

// ---------------------------------------------------------------------------

/** Build one driver. Geometry is cached by the caller, keyed on id + options. */
export function buildDriver(id: DriverId, o: DriverBuildOptions): DriverBuild {
  const d = DRIVERS[id];
  const s = skeletonFor(d, o);
  const b = new RigBucket();

  buildTorso(b, d, s);
  buildLegs(b, d, s);
  buildArms(b, d, s);
  if (d.tail) buildTail(b, d, s);
  const headSocketRaw = buildHead(b, d, s);

  // --- AO bake (driver-space, before the pivot split) -------------------
  const occl = b.occluder();
  const crease = 46;
  const near = b.merge(2, crease);
  const mid = b.merge(1, crease + 6);
  if (occl) {
    const samples = o.quality.tier === 'low' ? 0 : o.quality.tier === 'medium' ? 3 : 4;
    if (samples > 0) {
      bakeAO(occl, near.map((g) => g.geometry), { samples, radius: 0.20, strength: 0.85, skyBias: 0.30 });
      transferVertexColors(near.map((g) => g.geometry), mid.map((g) => g.geometry));
    }
    occl.dispose();
  }

  // --- pivots -----------------------------------------------------------
  const world: Record<DriverNode, THREE.Vector3> = {
    hips: new THREE.Vector3(0, 0, 0),
    torso: new THREE.Vector3(0, s.hipY, 0.006),
    head: new THREE.Vector3(0, s.neckY, 0.004),
    armL: new THREE.Vector3(-s.shoulderHalf, s.shoulderY, -0.004),
    armR: new THREE.Vector3(s.shoulderHalf, s.shoulderY, -0.004),
    foreL: new THREE.Vector3(-s.elbow.x, s.elbow.y, s.elbow.z),
    foreR: new THREE.Vector3(s.elbow.x, s.elbow.y, s.elbow.z),
  };

  const S = d.scale * (o.scale ?? 1);
  for (const list of [near, mid]) {
    for (const g of list) {
      const w = world[g.node];
      g.geometry.translate(-w.x, -w.y, -w.z);
      if (S !== 1) g.geometry.scale(S, S, S);
    }
  }

  // Pivots become parent-relative, then scaled.
  const pivots = {} as Record<DriverNode, THREE.Vector3>;
  for (const node of DRIVER_NODES) {
    const parent = NODE_PARENT[node];
    const v = world[node].clone();
    if (parent) v.sub(world[parent]);
    pivots[node] = v.multiplyScalar(S);
  }

  let tris = 0;
  for (const g of near) {
    const i = g.geometry.getIndex();
    tris += (i ? i.count : g.geometry.attributes.position.count) / 3;
  }

  // --- per-node consolidation -------------------------------------------
  // A rig of 23 separate meshes is most of a kart's draw-call budget on its
  // own. Everything but the face and the skin collapses to one buffer per node.
  const nearMerged: DriverMergedGroup[] = [];
  for (const node of DRIVER_NODES) {
    const parts: ConsolidatePart[] = [];
    for (const g of near) {
      if (g.node !== node) continue;
      if (g.slot === 'face' || g.slot === 'skin') continue;
      parts.push({ slot: g.slot, geometry: g.geometry });
    }
    const geometry = consolidateParts(parts);
    if (geometry) nearMerged.push({ node, geometry });
  }

  b.dispose();

  return {
    id,
    near, mid, nearMerged, pivots,
    headSocket: headSocketRaw.sub(world.head).multiplyScalar(S),
    height: (s.headY + d.headR * 1.4) * S,
    tris: Math.round(tris),
  };
}

/** Rest-pose offset of every rig node relative to the rig root, in rig space. */
export function driverRestOffsets(build: DriverBuild): Record<DriverNode, THREE.Vector3> {
  const out = {} as Record<DriverNode, THREE.Vector3>;
  for (const node of DRIVER_NODES) {
    const v = build.pivots[node].clone();
    let parent = NODE_PARENT[node];
    while (parent) {
      v.add(build.pivots[parent]);
      parent = NODE_PARENT[parent];
    }
    out[node] = v;
  }
  return out;
}

/**
 * The whole rig as consolidation parts in the rest pose, ready to be merged into
 * a kart's cheap-LOD buffer. `level` picks the near or the reduced geometry.
 */
export function driverRestParts(build: DriverBuild, level: 'near' | 'mid'): ConsolidatePart[] {
  const offsets = driverRestOffsets(build);
  const out: ConsolidatePart[] = [];
  for (const g of level === 'near' ? build.near : build.mid) {
    const o = offsets[g.node];
    out.push({ slot: g.slot, geometry: g.geometry, matrix: new THREE.Matrix4().makeTranslation(o.x, o.y, o.z) });
  }
  return out;
}

export function disposeDriverBuild(build: DriverBuild): void {
  for (const g of build.near) g.geometry.dispose();
  for (const g of build.mid) g.geometry.dispose();
  for (const g of build.nearMerged) g.geometry.dispose();
}

// ---------------------------------------------------------------------------
// Pose + rig
// ---------------------------------------------------------------------------

export interface DriverPose {
  /** Visual steer, -1 (left) .. +1 (right). */
  steer: number;
  /** Lateral lean target, -1 (left) .. +1 (right). */
  lean: number;
  /** +1 thrown back under acceleration, -1 pitched forward under braking. */
  pitch: number;
  /** 0..1 drift bracing (elbows out, shoulders down, head into the apex). */
  brace: number;
  /** 0..1 finish celebration. */
  cheer: number;
  /** 0..1 slump after a hit. */
  slump: number;
  /** Head yaw in radians, + = look right. */
  look: number;
  /** 0..1 airborne (arms up, knees tucked). */
  air: number;
  /** 0..1 engine idle vibration. */
  bob: number;
}

export const NEUTRAL_POSE: Readonly<DriverPose> = Object.freeze({
  steer: 0, lean: 0, pitch: 0, brace: 0, cheer: 0, slump: 0, look: 0, air: 0, bob: 0,
});

/**
 * One instantiated driver. Owns nothing but `Object3D`s and mesh instances —
 * geometry and materials are shared, so a rig is cheap to create and destroy.
 */
export class DriverRig {
  readonly root: THREE.Object3D;
  readonly hips: THREE.Object3D;
  readonly torso: THREE.Object3D;
  readonly head: THREE.Object3D;
  readonly headSocket: THREE.Object3D;
  readonly build: DriverBuild;

  private readonly nodes: Record<DriverNode, THREE.Object3D>;
  private readonly nearMeshes: THREE.Mesh[] = [];
  private readonly midMeshes: THREE.Mesh[] = [];
  private readonly face: FaceMaterial | null;

  // damped pose state
  private cur: DriverPose = { ...NEUTRAL_POSE };
  private time = 0;
  private expr: FaceExpression = 'neutral';
  private torsoRestY: number;

  /**
   * Expression-driven micro-pose. A face atlas can change the eyes but it cannot
   * tilt a head, and "curious" and "thoughtful" are *postures* as much as
   * faces — the reference sheet draws a head tilt and a paw at the chin. These
   * three damped channels supply that without adding a field to `DriverPose`,
   * which would break every caller that builds one as a literal.
   *
   * Only drivers flagged `expressive` opt in, so the original eight keep the
   * idle pose they shipped with — `neutral` must not start tilting Nova's head.
   */
  private readonly expressive: boolean;
  private exTilt = 0;   // head roll, radians
  private exPitch = 0;  // head pitch, radians (- = chin up)
  private exChin = 0;   // 0..1 right forearm drawn toward the chin

  /**
   * `merged` is the racer's atlas material. When supplied the rig draws one
   * consolidated mesh per node plus the rich face and skin — ten draw calls
   * instead of twenty-three, with no visible difference at gameplay distance.
   * Pass `null` to get a mesh per material slot (used by the model viewer).
   */
  constructor(
    build: DriverBuild, mats: KartMaterialSet, face: FaceMaterial | null, name: string,
    merged: THREE.Material | null = null,
  ) {
    this.build = build;
    this.face = face;
    this.expressive = DRIVERS[build.id].expressive === true;

    const make = (node: DriverNode): THREE.Object3D => {
      const o = new THREE.Object3D();
      o.name = `${name}:${node}`;
      o.position.copy(build.pivots[node]);
      return o;
    };
    this.nodes = {
      hips: make('hips'), torso: make('torso'), head: make('head'),
      armL: make('armL'), armR: make('armR'), foreL: make('foreL'), foreR: make('foreR'),
    };
    for (const node of DRIVER_NODES) {
      const parent = NODE_PARENT[node];
      if (parent) this.nodes[parent].add(this.nodes[node]);
    }
    this.root = this.nodes.hips;
    this.hips = this.nodes.hips;
    this.torso = this.nodes.torso;
    this.head = this.nodes.head;
    this.torsoRestY = this.torso.position.y;

    const faceMat = face ? face.material : mats.face;
    const attach = (groups: DriverGroup[], into: THREE.Mesh[], suffix: string) => {
      for (const g of groups) {
        if (merged && g.slot !== 'face' && g.slot !== 'skin') continue;
        const mat = g.slot === 'face' ? faceMat : mats[g.slot];
        const m = new THREE.Mesh(g.geometry, mat);
        m.name = `${name}:${g.node}:${g.slot}${suffix}`;
        m.castShadow = g.slot !== 'glow';
        m.receiveShadow = true;
        this.nodes[g.node].add(m);
        into.push(m);
      }
    };
    attach(build.near, this.nearMeshes, '');
    if (merged) {
      for (const g of build.nearMerged) {
        const m = new THREE.Mesh(g.geometry, merged);
        m.name = `${name}:${g.node}:merged`;
        m.castShadow = true;
        m.receiveShadow = true;
        this.nodes[g.node].add(m);
        this.nearMeshes.push(m);
      }
    } else {
      attach(build.mid, this.midMeshes, ':mid');
      for (const m of this.midMeshes) m.visible = false;
    }

    this.headSocket = new THREE.Object3D();
    this.headSocket.name = `${name}:driverHead`;
    this.headSocket.position.copy(build.headSocket);
    this.head.add(this.headSocket);
  }

  /** 0 = full detail, 1 = reduced, 2 = hidden. */
  setLod(level: 0 | 1 | 2): void {
    // In merged mode there is no separate reduced set — the cheap kart LODs bake
    // the driver straight into the chassis buffer, so level 1 keeps the near rig.
    const hasMid = this.midMeshes.length > 0;
    const near = level === 0 || (level === 1 && !hasMid);
    const mid = level === 1 && hasMid;
    for (const m of this.nearMeshes) m.visible = near;
    for (const m of this.midMeshes) m.visible = mid;
    this.root.visible = level < 2;
  }

  setExpression(e: FaceExpression): void {
    if (e === this.expr) return;
    this.expr = e;
    this.face?.setExpression(e);
  }

  get expression(): FaceExpression { return this.expr; }

  /** Damp toward `target` and write the node rotations. Allocation-free. */
  update(dt: number, target: DriverPose): void {
    this.time += dt;
    const c = this.cur;
    c.steer = damp(c.steer, clamp(target.steer, -1, 1), 0.055, dt);
    c.lean = damp(c.lean, clamp(target.lean, -1, 1), 0.085, dt);
    c.pitch = damp(c.pitch, clamp(target.pitch, -1, 1), 0.10, dt);
    c.brace = damp(c.brace, clamp01(target.brace), 0.075, dt);
    c.cheer = damp(c.cheer, clamp01(target.cheer), 0.13, dt);
    c.slump = damp(c.slump, clamp01(target.slump), 0.11, dt);
    c.look = damp(c.look, clamp(target.look, -0.95, 0.95), 0.10, dt);
    c.air = damp(c.air, clamp01(target.air), 0.09, dt);
    c.bob = damp(c.bob, clamp01(target.bob), 0.20, dt);

    const t = this.time;
    const vib = Math.sin(t * 41.0) * 0.0016 * c.bob + Math.sin(t * 17.3) * 0.0008 * c.bob;

    // --- torso -----------------------------------------------------------
    const torso = this.torso;
    torso.rotation.z = -c.lean * 0.20 - c.brace * c.lean * 0.10;
    torso.rotation.x = c.pitch * 0.13 - c.slump * 0.46 + c.cheer * 0.14 - c.brace * 0.07 - c.air * 0.06;
    torso.rotation.y = -c.lean * 0.07 - c.look * 0.12;
    torso.position.y = this.torsoRestY + vib - c.brace * 0.008 - c.slump * 0.018 + c.air * 0.006;

    // --- head ------------------------------------------------------------
    // rotation.y is + = nose LEFT, so `look` (+ = right) is negated here.
    const head = this.head;
    head.rotation.y = -c.look * 0.85;
    head.rotation.x = -c.pitch * 0.09 - c.slump * 0.52 + c.cheer * 0.26 + c.air * 0.10;
    head.rotation.z = -c.lean * 0.13 + c.look * 0.10;

    // --- arms ------------------------------------------------------------
    const cheerPump = c.cheer * (0.10 + Math.sin(t * 9.0) * 0.10);
    const braceX = -c.brace * 0.10;
    const airX = c.air * 0.22;

    const armL = this.nodes.armL;
    const armR = this.nodes.armR;
    armL.rotation.x = c.steer * 0.50 + braceX + airX - c.slump * 0.30;
    armR.rotation.x = -c.steer * 0.50 + braceX + airX - c.slump * 0.30;
    armL.rotation.z = -c.brace * 0.20 - c.air * 0.10 + c.slump * 0.16;
    armR.rotation.z = c.brace * 0.20 + c.air * 0.10 - c.slump * 0.16;
    armL.rotation.y = -c.steer * 0.10;
    armR.rotation.y = -c.steer * 0.10;

    const foreL = this.nodes.foreL;
    const foreR = this.nodes.foreR;
    foreL.rotation.x = -c.steer * 0.22 + c.brace * 0.26 - c.slump * 0.34;
    foreR.rotation.x = c.steer * 0.22 + c.brace * 0.26 - c.slump * 0.34;
    foreL.rotation.z = -c.brace * 0.10;
    foreR.rotation.z = c.brace * 0.10;

    // Celebration overrides the right arm entirely: fist to the sky.
    if (c.cheer > 0.01) {
      armR.rotation.x = lerp(armR.rotation.x, 1.85 + cheerPump, c.cheer);
      armR.rotation.z = lerp(armR.rotation.z, 0.42, c.cheer);
      foreR.rotation.x = lerp(foreR.rotation.x, -0.55, c.cheer);
      armL.rotation.x = lerp(armL.rotation.x, 0.55, c.cheer * 0.7);
    }

    // --- expression micro-pose (animals only) -----------------------------
    if (this.expressive) {
      const e = this.expr;
      // Damped so an expression change eases in rather than snapping.
      this.exTilt = damp(
        this.exTilt,
        (e === 'neutral' ? 0.085 : e === 'thoughtful' ? 0.060 : e === 'sleepy' ? 0.040
          : e === 'happy' ? -0.045 : 0) * (1 - c.brace),
        0.16, dt,
      );
      this.exPitch = damp(
        this.exPitch,
        e === 'thoughtful' ? -0.115 : e === 'sleepy' ? 0.130 : e === 'hit' ? 0.05 : 0,
        0.18, dt,
      );
      this.exChin = damp(this.exChin, e === 'thoughtful' ? 1 : 0, 0.22, dt);
      head.rotation.z += this.exTilt;
      head.rotation.x += this.exPitch;
      if (this.exChin > 0.005) {
        const k = this.exChin * (1 - c.cheer) * (1 - c.slump);
        armR.rotation.x += k * 0.42;
        armR.rotation.z += k * 0.20;
        foreR.rotation.x -= k * 1.05;
      }
    }

    this.face?.tick(dt);
  }

  /** Snap the damped state to a target with no easing (teleports, resets). */
  snap(target: DriverPose): void {
    Object.assign(this.cur, target);
    this.update(1, target);
  }

  dispose(): void {
    for (const m of [...this.nearMeshes, ...this.midMeshes]) {
      m.removeFromParent();
    }
    this.nearMeshes.length = 0;
    this.midMeshes.length = 0;
    this.root.removeFromParent();
  }
}
