/**
 * ============================================================================
 *  APEX KART — CROWD
 * ============================================================================
 *  One InstancedMesh. Up to two thousand spectators. Zero CPU per frame.
 *
 *  MK8's crowds are simple shapes — the thing that sells them is that they are
 *  never still. So every scrap of motion here is derived in the vertex shader
 *  from two per-instance floats (a phase and an arc-length position) and a
 *  per-vertex limb id:
 *
 *    · idle bob + lateral sway, at a per-person frequency
 *    · arms raised and waved, rotated about the shoulder rather than sheared
 *    · a Mexican wave that travels around the circuit in arc-length space:
 *      people stand up, throw their arms overhead, and settle back down
 *    · a constant low-level "cheer" excitement that rises near the start/finish
 *
 *  Colour comes from `instanceColor` (shirts) multiplied into baked vertex
 *  colours (skin, hair, trousers stay themselves because the shirt tint is
 *  applied selectively via the limb id).
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings } from '@/core/Types';
import { RENDER_ORDER } from '@/core/Config';
import { Rng, clamp, clamp01 } from '@/core/MathUtils';
import { SHADOW_LAYER } from './Lighting';
import {
  STAND_AISLE_HW, STAND_BENCH_H, standAisleCount, standAisleXs, standSeatY, standSeatZ,
  type StandSpec,
} from './Props';
import { InstanceChunks, type TerrainField, type WorldContext } from './WorldTextures';

/**
 * Limb ids baked per vertex. The shader poses the figure from these, so they
 * double as the joint hierarchy: 4/5 rotate about the knee and hip, 2/3 about
 * the shoulders, 1/6 scale about the neck.
 */
const LIMB_BODY = 0;
const LIMB_HEAD = 1;
const LIMB_ARM_L = 2;
const LIMB_ARM_R = 3;
const LIMB_SHIN = 4;
const LIMB_THIGH = 5;
const LIMB_HAT = 6;

/** Tint channels. Parts on a channel are authored white and coloured per instance. */
const TINT_NONE = 0;
const TINT_SHIRT = 1;
const TINT_SKIN = 2;
const TINT_HAIR = 3;

/** Joint heights, shared between the geometry and the shader. */
const HIP_Y = 0.4;
const KNEE_Y = 0.2;
const NECK_Y = 0.9;
const SHOULDER_Y = 0.86;
const SHOULDER_X = 0.185;

const COUNT_FOR_TIER: Record<string, number> = {
  low: 320, medium: 780, high: 1350, ultra: 2000,
};

/** Shirt palette — saturated but not clownish, MK8 keeps crowds readable. */
const SHIRTS = [
  0xe23b32, 0x2f6fd0, 0xf2c53d, 0x2fa363, 0xe8752f, 0x8b4fd6,
  0xe9e5da, 0x2b3038, 0x3fc6d6, 0xd94f8a, 0x6b8f2f, 0xf0a63c,
];
/**
 * Skin and hair are per-instance ramps rather than palettes: one geometry is
 * shared by every spectator, so a hex baked into the vertices would give the
 * whole venue one skin tone and one hair colour, which is exactly what it used
 * to do. Two uniforms and one float per instance fixes it for free.
 */
const SKIN_LIGHT = 0xf7ddc2;
const SKIN_DARK = 0x54331d;
const HAIR_DARK = 0x191310;
const HAIR_LIGHT = 0xc0b7a6;

/**
 * Body archetypes: `[height, girth, headScale, hatChance]`. Height and girth ride
 * the instance matrix (free), head scale is one shader multiply. Four silhouettes
 * plus a height jitter is enough that a packed stand stops looking stamped.
 */
const ARCHETYPES: Array<[number, number, number, number]> = [
  [1.0, 1.0, 1.0, 0.45],    // adult
  [0.74, 0.93, 1.17, 0.55], // child
  [0.96, 1.17, 0.98, 0.32], // broad
  [1.12, 0.88, 0.95, 0.4],  // lanky
];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _axisY = new THREE.Vector3(0, 1, 0);

/** A 1.2 m person past this is sub-pixel. Shader and chunk culling share it. */
const CROWD_CULL = 260;

interface Seat {
  x: number; y: number; z: number;
  yaw: number;
  arc: number;
  scale: number;
  /** 0 = seated in a stand, 1 = standing at the fence. */
  standing: number;
  /** 1 = sitting on the bench (legs folded, hips dropped onto the seat). */
  seated: number;
  /** Index into ARCHETYPES. */
  arch: number;
}

export class Crowd implements ISubsystem {
  readonly group = new THREE.Group();
  mesh: THREE.InstancedMesh | null = null;
  camera: THREE.PerspectiveCamera | null = null;

  private scene: THREE.Scene;
  private ctx: WorldContext;
  private quality: QualitySettings;
  private field: TerrainField;
  private stands: StandSpec[];
  private rng: Rng;

  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.MeshStandardMaterial | null = null;
  private chunks: InstanceChunks | null = null;

  private uTime = { value: 0 };
  private uWavePos = { value: 0 };
  private uWaveOn = { value: 0 };
  private uWaveWidth = { value: 58 };
  private uLapLength = { value: 1000 };
  private uExcite = { value: 0.35 };
  private uCamXZ = { value: new THREE.Vector2() };
  // Skin/hair ramps. THREE.Color converts sRGB -> linear on `setHex`, which is
  // the same space the baked vertex colours end up in, so the two multiply
  // cleanly.
  private uSkinA = { value: new THREE.Color(SKIN_LIGHT) };
  private uSkinB = { value: new THREE.Color(SKIN_DARK) };
  private uHairA = { value: new THREE.Color(HAIR_DARK) };
  private uHairB = { value: new THREE.Color(HAIR_LIGHT) };

  private waveActive = false;
  private waveSpeed = 95;
  private time = 0;

  constructor(
    scene: THREE.Scene,
    ctx: WorldContext,
    quality: QualitySettings,
    stands: StandSpec[] = [],
  ) {
    this.scene = scene;
    this.ctx = ctx;
    this.quality = quality;
    this.field = ctx.field;
    this.stands = stands;
    this.rng = new Rng((ctx.hints.terrainSeed ^ 0x51ed270b) >>> 0 || 11);
    this.uLapLength.value = Math.max(50, ctx.lapLength);
  }

  async init(): Promise<void> {
    this.group.name = 'Crowd';
    this.scene.add(this.group);

    const seats = this.planSeats();
    if (!seats.length) return;

    this.geometry = this.buildPerson();
    this.material = this.buildMaterial();

    const mesh = new THREE.InstancedMesh(this.geometry, this.material, seats.length);
    mesh.name = 'Crowd';
    mesh.castShadow = false;      // 2000 shadow casters is not a trade worth making
    mesh.receiveShadow = true;
    // Declares intent for Lighting's cascade masks: the crowd sits 10 m+ off the
    // racing line, so if it ever casts it belongs in the near cascade only.
    mesh.layers.enable(SHADOW_LAYER.NEAR_ONLY);
    mesh.renderOrder = RENDER_ORDER.PROPS;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    // Four instance attributes, packed: WebGL2 guarantees only 16 attribute
    // slots and instanceMatrix eats four of them.
    //   aWho  = (phase, arc, headScale, bobAmp)
    //   aPose = (seated, standingAtFence, armBias, hat)
    //   aTone = (skinT, hairT)
    const who = new Float32Array(seats.length * 4);
    const pose = new Float32Array(seats.length * 4);
    const tone = new Float32Array(seats.length * 2);
    const shirt = new Float32Array(seats.length * 3);
    const bounds = new THREE.Box3();
    const rng = this.rng;

    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      const [ah, ag, ahead, ahat] = ARCHETYPES[s.arch];
      _q.setFromAxisAngle(_axisY, s.yaw + (rng.next() - 0.5) * 0.55);
      // Non-uniform scale: height and girth per archetype, plus a jitter. The
      // skew this puts in the normals is a couple of degrees at most.
      const h = ah * s.scale * (0.97 + rng.next() * 0.07);
      const g = ag * s.scale * (0.96 + rng.next() * 0.09);
      _m.compose(_v.set(s.x, s.y, s.z), _q, _s.set(g, h, g));
      mesh.setMatrixAt(i, _m);

      who[i * 4] = rng.next();
      who[i * 4 + 1] = s.arc;
      who[i * 4 + 2] = ahead;
      who[i * 4 + 3] = rng.next();
      pose[i * 4] = s.seated;
      pose[i * 4 + 1] = s.standing;
      // A fifth of the venue holds its arms up the whole time. At a distance
      // that reads as a crowd doing something rather than a field of posts.
      pose[i * 4 + 2] = rng.next() < 0.18 ? 0.55 + rng.next() * 0.45 : 0;
      pose[i * 4 + 3] = rng.next() < ahat ? 1 : 0;
      tone[i * 2] = rng.next();
      tone[i * 2 + 1] = rng.next();
      bounds.expandByPoint(_v);

      // Shirt colour rides its own attribute rather than `instanceColor`, so it
      // can be applied to the torso and sleeves only — skin and hair keep theirs.
      _c.setHex(SHIRTS[Math.floor(rng.next() * SHIRTS.length) % SHIRTS.length]);
      shirt[i * 3] = _c.r; shirt[i * 3 + 1] = _c.g; shirt[i * 3 + 2] = _c.b;
    }
    mesh.instanceMatrix.needsUpdate = true;

    this.geometry.setAttribute('aWho', new THREE.InstancedBufferAttribute(who, 4));
    this.geometry.setAttribute('aPose', new THREE.InstancedBufferAttribute(pose, 4));
    this.geometry.setAttribute('aTone', new THREE.InstancedBufferAttribute(tone, 2));
    this.geometry.setAttribute('aShirt', new THREE.InstancedBufferAttribute(shirt, 3));

    bounds.getCenter(_v);
    mesh.boundingSphere = new THREE.Sphere(_v.clone(), bounds.getSize(_s).length() * 0.5 + 4);
    // The bounding sphere wraps the whole circuit, so the camera is always inside
    // it and `frustumCulled` can never fire. Chunk the seats into 56 m cells
    // instead and repack the visible ones each frame: still one draw call, but
    // only the spectators in front of the camera are submitted (typically a fifth
    // of the venue). Safe to frustum-cull because the crowd casts no shadows.
    mesh.frustumCulled = false;
    this.chunks = new InstanceChunks(mesh, seats, CROWD_CULL, 56, true)
      .track(this.geometry.getAttribute('aWho') as THREE.InstancedBufferAttribute)
      .track(this.geometry.getAttribute('aPose') as THREE.InstancedBufferAttribute)
      .track(this.geometry.getAttribute('aTone') as THREE.InstancedBufferAttribute)
      .track(this.geometry.getAttribute('aShirt') as THREE.InstancedBufferAttribute);

    this.mesh = mesh;
    this.group.add(mesh);
  }

  // =========================================================================
  // SEATING PLAN
  // =========================================================================

  private planSeats(): Seat[] {
    const budget = Math.round((COUNT_FOR_TIER[this.quality.tier] ?? 1000)
      * clamp(this.quality.foliageDensity * 0.5 + 0.5, 0.4, 1));
    const seats: Seat[] = [];
    const rng = this.rng;

    // ---- grandstand seating --------------------------------------------------
    // Weight by density so the main straight is packed and the far side is thin.
    let weightSum = 0;
    for (const s of this.stands) weightSum += s.width * s.rows * s.density;
    const standShare = this.stands.length ? 0.78 : 0;

    for (const stand of this.stands) {
      const share = weightSum > 0 ? (stand.width * stand.rows * stand.density) / weightSum : 0;
      const want = Math.round(budget * standShare * share);
      const ca = Math.cos(stand.yaw), sa = Math.sin(stand.yaw);
      const perRow = Math.max(1, Math.round(want / stand.rows));
      // Aisles are real steps in the terrace, so nobody is seated in one.
      const aisles = standAisleXs(stand.width, standAisleCount(stand.main));
      for (let r = 0; r < stand.rows; r++) {
        // Front rows fill first — that's what real stands look like.
        const rowFill = clamp01(stand.density * (1.25 - r / stand.rows * 0.45));
        // ...and the back rows are where people sit down.
        const sitChance = 0.22 + (r / Math.max(1, stand.rows - 1)) * 0.55;
        for (let i = 0; i < perRow; i++) {
          if (rng.next() > rowFill) continue;
          const along = ((i + 0.5) / perRow - 0.5) * (stand.width - 3.0)
            + (rng.next() - 0.5) * 0.5;
          let inAisle = false;
          for (const a of aisles) if (Math.abs(along - a) < STAND_AISLE_HW + 0.3) inAisle = true;
          if (inAisle) continue;
          const lz = standSeatZ(r);
          const ly = standSeatY(r);
          seats.push({
            x: stand.position.x + ca * along + sa * lz,
            y: stand.position.y + ly,
            z: stand.position.z - sa * along + ca * lz,
            yaw: stand.yaw,
            arc: stand.arc + along * 0.5,
            scale: 0.94 + rng.next() * 0.14,
            standing: 0,
            seated: rng.next() < sitChance ? 1 : 0,
            // No children in row 0: a 0.74-scale figure's crown lands exactly on
            // the barrier capping, so it would be a stand seat with nobody in it.
            arch: r === 0 ? (rng.next() < 0.5 ? 0 : 2 + (rng.next() < 0.5 ? 0 : 1))
              : this.pickArchetype(rng),
          });
        }
      }
    }

    // ---- standing spectators along the fence line ---------------------------
    const remaining = Math.max(0, budget - seats.length);
    const st = this.ctx.stations;
    if (remaining > 0 && st.length > 8) {
      const total = st[st.length - 1].s || 1;
      let placed = 0;
      let guard = remaining * 12;
      while (placed < remaining && guard-- > 0) {
        const idx = Math.floor(rng.next() * st.length);
        const s = st[idx];
        // Density falls off away from the start/finish line.
        const arcFrac = s.s / total;
        const nearStart = Math.max(
          1 - arcFrac / 0.13,
          arcFrac > 0.87 ? (arcFrac - 0.87) / 0.13 : 0,
        );
        const chance = 0.14 + clamp01(nearStart) * 0.72;
        if (rng.next() > chance) continue;

        const side = rng.next() < 0.5 ? -1 : 1;
        const d = s.halfWidth + 7 + rng.next() * 9;
        const x = s.px + s.bx * d * side + s.tx * (rng.next() - 0.5) * 7;
        const z = s.pz + s.bz * d * side + s.tz * (rng.next() - 0.5) * 7;
        if (this.field.roadDistanceAt(x, z) < s.halfWidth + 5) continue;
        const y = this.field.heightAt(x, z);
        if (y < this.ctx.waterLevel + 0.5) continue;
        if (this.field.slopeAt(x, z) > 0.5) continue;
        let blocked = false;
        for (const stand of this.stands) {
          if (Math.hypot(stand.position.x - x, stand.position.z - z) < stand.width * 0.55) {
            blocked = true; break;
          }
        }
        if (blocked) continue;
        seats.push({
          x, y, z,
          yaw: Math.atan2(-s.bx * side, -s.bz * side),
          arc: s.s,
          scale: 0.94 + rng.next() * 0.16,
          standing: 1,
          seated: 0,
          arch: this.pickArchetype(rng),
        });
        placed++;
      }
    }

    return seats;
  }

  /** Adults dominate; children and broad builds fill in the variety. */
  private pickArchetype(rng: Rng): number {
    const r = rng.next();
    if (r < 0.46) return 0;
    if (r < 0.66) return 1;
    if (r < 0.85) return 2;
    return 3;
  }

  // =========================================================================
  // GEOMETRY
  // =========================================================================

  /**
   * ~164 triangles, and not one of them a box.
   *
   * Every part is a lathe: a stack of elliptical rings with **analytically
   * smooth normals**, so a six-sided torso lights like a cylinder instead of
   * showing four flat faces with a hard corner between them. That corner was the
   * whole problem — at 30 m a boxy spectator reads as a brick because the two
   * visible sides differ by a fixed step in brightness, and no amount of extra
   * geometry fixes it while the normals stay faceted.
   *
   * The rings also *cost less* than the boxes they replace: neighbouring rings
   * share vertices, so this is 119 vertices against the old 252 for six boxes.
   * Shoulders, jaw and crown are chamfered by tapering the last ring; hair is a
   * shell over the skull, which is 18 triangles for a real hairline.
   *
   * Nothing is coloured here except the trousers and shoes: torso, arms, head
   * and hair are authored white on a tint channel and coloured per instance.
   */
  private buildPerson(): THREE.BufferGeometry {
    const P: number[] = [], N: number[] = [], C: number[] = [];
    const A: number[] = [], I: number[] = [];

    const push = (
      x: number, y: number, z: number,
      nx: number, ny: number, nz: number,
      hex: number, limb: number, tint: number, shade: number,
    ): number => {
      P.push(x, y, z); N.push(nx, ny, nz);
      _c.setHex(hex);
      C.push(_c.r * shade, _c.g * shade, _c.b * shade);
      A.push(limb, tint);
      return P.length / 3 - 1;
    };

    /**
     * A ring of a lathed part. `rx`/`rz` differ so a chest can be wider than it
     * is deep — the superellipse-ish cross-section that makes a person read as a
     * person rather than a dowel.
     */
    type Ring = { y: number; rx: number; rz: number; hex: number; shade: number };

    const lathe = (
      rings: Ring[], sides: number, limb: number, tints: number[],
      o: { cx?: number; cz?: number; capTop?: number; capBottom?: number; limbs?: number[] } = {},
    ): void => {
      const cx = o.cx ?? 0, cz = o.cz ?? 0;
      const base = P.length / 3;
      for (let j = 0; j < rings.length; j++) {
        const r = rings[j];
        const prev = rings[Math.max(0, j - 1)];
        const next = rings[Math.min(rings.length - 1, j + 1)];
        const dy = (next.y - prev.y) || 1e-3;
        const drx = next.rx - prev.rx;
        const drz = next.rz - prev.rz;
        const lm = o.limbs ? o.limbs[j] : limb;
        const tn = tints[Math.min(j, tints.length - 1)];
        for (let i = 0; i < sides; i++) {
          // Half-step offset so a face — not an edge — points at the road.
          const a = ((i + 0.5) / sides) * Math.PI * 2;
          const ca = Math.cos(a), sa = Math.sin(a);
          // Outward normal of a surface of revolution with an elliptical
          // section: cross(meridian tangent, circumferential tangent).
          let nx = dy * r.rz * ca;
          let ny = -(r.rx * drz * sa * sa + r.rz * drx * ca * ca);
          let nz = dy * r.rx * sa;
          const l = Math.hypot(nx, ny, nz) || 1;
          // Faces turned away from the key light dim smoothly rather than in
          // six discrete steps: this is the baked half of the rounding.
          const sh = r.shade * (0.9 + 0.15 * (sa * 0.5 + 0.5));
          push(cx + ca * r.rx, r.y, cz + sa * r.rz, nx / l, ny / l, nz / l,
            r.hex, lm, tn, sh);
        }
      }
      for (let j = 0; j + 1 < rings.length; j++) {
        for (let i = 0; i < sides; i++) {
          const v00 = base + j * sides + i;
          const v01 = base + j * sides + ((i + 1) % sides);
          I.push(v00, v00 + sides, v01, v01, v00 + sides, v01 + sides);
        }
      }
      if (o.capTop !== undefined) {
        const top = rings[rings.length - 1];
        const ringBase = base + (rings.length - 1) * sides;
        const c = push(cx, top.y + o.capTop, cz, 0, 1, 0, top.hex, limb,
          tints[tints.length - 1], top.shade * 1.12);
        for (let i = 0; i < sides; i++) {
          I.push(c, ringBase + ((i + 1) % sides), ringBase + i);
        }
      }
      if (o.capBottom !== undefined) {
        const bot = rings[0];
        const c = push(cx, bot.y - o.capBottom, cz, 0, -1, 0, bot.hex, limb,
          tints[0], bot.shade * 0.7);
        for (let i = 0; i < sides; i++) I.push(c, base + i, base + ((i + 1) % sides));
      }
    };

    const quad = (
      a: [number, number, number], b: [number, number, number],
      c: [number, number, number], d: [number, number, number],
      hex: number, limb: number, tint: number, shade: number,
    ): void => {
      let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i0 = push(a[0], a[1], a[2], nx, ny, nz, hex, limb, tint, shade);
      push(b[0], b[1], b[2], nx, ny, nz, hex, limb, tint, shade);
      push(c[0], c[1], c[2], nx, ny, nz, hex, limb, tint, shade);
      push(d[0], d[1], d[2], nx, ny, nz, hex, limb, tint, shade);
      I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    };

    // Measured: the old 0x3a3f47 trousers over 0x24272c shoes landed at 0.011
    // linear at the feet — a black blob with no readable form. These sit around
    // 0.04-0.08, still clearly dark clothing, but the leg keeps its shape.
    const TROUSER = 0x4a5060;
    const SHOE = 0x3f434b;

    // ---- legs: ankle -> knee -> hip, one merged mass -------------------------
    // Limb ids ride the rings, which is also the joint chain: the hip ring is
    // fixed, the knee rotates about the hip, the ankle follows both. That is
    // what lets a fifth of the stand actually sit down.
    lathe([
      { y: 0.0, rx: 0.102, rz: 0.084, hex: SHOE, shade: 0.7 },
      { y: KNEE_Y, rx: 0.122, rz: 0.095, hex: TROUSER, shade: 0.88 },
      { y: HIP_Y, rx: 0.141, rz: 0.105, hex: TROUSER, shade: 1.04 },
    ], 6, LIMB_BODY, [TINT_NONE], { limbs: [LIMB_SHIN, LIMB_THIGH, LIMB_BODY] });

    // ---- torso: waist -> chest -> chamfered shoulders ------------------------
    lathe([
      { y: 0.34, rx: 0.142, rz: 0.104, hex: 0xffffff, shade: 0.8 },
      { y: 0.66, rx: 0.164, rz: 0.117, hex: 0xffffff, shade: 1.0 },
      { y: SHOULDER_Y, rx: 0.14, rz: 0.104, hex: 0xffffff, shade: 1.07 },
      { y: 0.92, rx: 0.086, rz: 0.072, hex: 0xffffff, shade: 0.88 },
    ], 6, LIMB_BODY, [TINT_SHIRT]);

    // ---- neck + head --------------------------------------------------------
    lathe([
      { y: NECK_Y - 0.02, rx: 0.058, rz: 0.056, hex: 0xffffff, shade: 0.62 },
      { y: 1.0, rx: 0.096, rz: 0.09, hex: 0xffffff, shade: 0.94 },
      { y: 1.12, rx: 0.102, rz: 0.096, hex: 0xffffff, shade: 1.06 },
    ], 6, LIMB_HEAD, [TINT_SKIN]);

    // Hair shell: proud of the skull, so the seam is a hairline and the open
    // top of the head lands inside it.
    lathe([
      { y: 1.055, rx: 0.112, rz: 0.105, hex: 0xffffff, shade: 0.82 },
      { y: 1.15, rx: 0.1, rz: 0.094, hex: 0xffffff, shade: 1.0 },
    ], 6, LIMB_HEAD, [TINT_HAIR], { capTop: 0.055 });

    // ---- arms: shoulder -> elbow -> wrist -> fist ----------------------------
    for (const side of [-1, 1]) {
      const limb = side < 0 ? LIMB_ARM_L : LIMB_ARM_R;
      lathe([
        { y: SHOULDER_Y, rx: 0.05, rz: 0.05, hex: 0xffffff, shade: 0.94 },
        { y: 0.68, rx: 0.043, rz: 0.043, hex: 0xffffff, shade: 1.0 },
        { y: 0.52, rx: 0.038, rz: 0.038, hex: 0xffffff, shade: 1.0 },
        { y: 0.46, rx: 0.046, rz: 0.046, hex: 0xffffff, shade: 1.06 },
      ], 4, limb, [TINT_SHIRT, TINT_SHIRT, TINT_SKIN, TINT_SKIN],
      { cx: side * SHOULDER_X, capBottom: 0.03 });
    }

    // ---- cap brim -----------------------------------------------------------
    // A chamfered wedge rather than a box: it catches the light as they bob,
    // which is most of what makes a distant crowd read as people not pillars.
    // Collapses to a point for bare-headed instances (see the shader).
    {
      const bl: [number, number, number] = [-0.1, 1.12, 0.068];
      const br: [number, number, number] = [0.1, 1.12, 0.068];
      const fl: [number, number, number] = [-0.076, 1.112, 0.172];
      const fr: [number, number, number] = [0.076, 1.112, 0.172];
      const blu: [number, number, number] = [-0.1, 1.104, 0.068];
      const bru: [number, number, number] = [0.1, 1.104, 0.068];
      const flu: [number, number, number] = [-0.076, 1.098, 0.168];
      const fru: [number, number, number] = [0.076, 1.098, 0.168];
      quad(bl, fl, fr, br, 0xffffff, LIMB_HAT, TINT_HAIR, 1.18);
      quad(blu, bru, fru, flu, 0xffffff, LIMB_HAT, TINT_HAIR, 0.5);
      quad(flu, fru, fr, fl, 0xffffff, LIMB_HAT, TINT_HAIR, 1.06);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    // (limb, tintChannel) in one slot — attribute slots are the scarce resource
    // here, not bandwidth.
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(A, 2));
    g.setIndex(I);
    g.computeBoundingSphere();
    g.name = 'spectator';
    return g;
  }

  // =========================================================================
  // MATERIAL
  // =========================================================================

  private buildMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      name: 'crowd',
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.0,
      dithering: true,
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.uniforms.uWavePos = this.uWavePos;
      shader.uniforms.uWaveOn = this.uWaveOn;
      shader.uniforms.uWaveWidth = this.uWaveWidth;
      shader.uniforms.uLapLength = this.uLapLength;
      shader.uniforms.uExcite = this.uExcite;
      shader.uniforms.uCamXZ = this.uCamXZ;
      shader.uniforms.uSkinA = this.uSkinA;
      shader.uniforms.uSkinB = this.uSkinB;
      shader.uniforms.uHairA = this.uHairA;
      shader.uniforms.uHairB = this.uHairB;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          attribute vec2 aPart;      // (limb id, tint channel)
          attribute vec4 aWho;       // (phase, arc, headScale, bobAmp)
          attribute vec4 aPose;      // (seated, standingAtFence, armBias, hat)
          attribute vec2 aTone;      // (skin t, hair t)
          attribute vec3 aShirt;
          uniform float uTime;
          uniform float uWavePos;
          uniform float uWaveOn;
          uniform float uWaveWidth;
          uniform float uLapLength;
          uniform float uExcite;
          uniform vec2 uCamXZ;
          uniform vec3 uSkinA;
          uniform vec3 uSkinB;
          uniform vec3 uHairA;
          uniform vec3 uHairB;

          vec3 rotX(vec3 p, float a){
            float c = cos(a), s = sin(a);
            return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
          }
          vec3 rotZ(vec3 p, float a){
            float c = cos(a), s = sin(a);
            return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
          }
        `)
        .replace('#include <color_vertex>', /* glsl */ `
          #include <color_vertex>
          #ifdef USE_COLOR
            // Tint channels: 1 shirt, 2 skin, 3 hair. Everything on a channel is
            // authored white with its AO baked in, so one geometry gives a whole
            // venue of different people.
            float apxTint = aPart.y;
            vec3 apxCol = vec3(1.0);
            if (apxTint > 2.5)      apxCol = mix(uHairA, uHairB, aTone.y);
            else if (apxTint > 1.5) apxCol = mix(uSkinA, uSkinB, aTone.x);
            else if (apxTint > 0.5) apxCol = aShirt;
            vColor.xyz *= apxCol;
          #endif
        `)
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          float apxLimb = aPart.x;
          float ph = aWho.x * 6.28318;

          // Distance cull: a person is ~1.2 m tall, sub-pixel past this.
          vec2 apxOrigin = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float apxVis = step(length(apxOrigin - uCamXZ), ${CROWD_CULL.toFixed(1)});

          // A second phase from the instance's own position. aWho.x on its own
          // leaves neighbours that drew similar values bobbing in lockstep,
          // which is instantly visible as a shimmer across a packed stand.
          float hpos = fract(sin(apxOrigin.x * 12.9898 + apxOrigin.y * 78.233) * 43758.5453);
          float ph2 = ph + hpos * 6.28318;

          // --- travelling wave -------------------------------------------------
          // Arc-length difference, wrapped so the wave can cross the start line.
          float d = aWho.y - uWavePos;
          d -= uLapLength * floor(d / uLapLength + 0.5);
          float wave = 1.0 - smoothstep(0.0, uWaveWidth, abs(d));
          wave = wave * wave * (3.0 - 2.0 * wave) * uWaveOn;

          // --- excitement ------------------------------------------------------
          float cheer = clamp(uExcite + wave, 0.0, 1.4);
          float ownBeat = sin(uTime * (4.1 + aWho.x * 2.2 + hpos * 1.4) + ph2);

          // --- idle bob + sway (frequency AND phase decorrelated) --------------
          float bobAmp = 0.010 + aWho.w * 0.014;
          float bob = sin(uTime * (1.35 + aWho.x * 1.1 + hpos * 0.9) + ph2) * bobAmp
                    + wave * 0.30 + cheer * 0.012 * ownBeat;
          float sway = cos(uTime * (0.95 + hpos * 0.7) + ph2 * 1.7) * (0.009 + aWho.w * 0.009);

          // --- seated: fold the legs, drop the hips onto the bench -------------
          // The wave brings them to their feet, so seated relaxes as it passes.
          float seated = aPose.x * (1.0 - wave);
          if (apxLimb > 3.5 && apxLimb < 5.5) {
            float hipA = -seated * 1.30;                 // knees toward the road
            vec3 hip = vec3(0.0, ${HIP_Y.toFixed(3)}, 0.0);
            vec3 q = rotX(transformed - hip, hipA);
            if (apxLimb < 4.5) {                          // shin hangs from the knee
              vec3 knee = rotX(vec3(0.0, ${(KNEE_Y - HIP_Y).toFixed(3)}, 0.0), hipA);
              q = knee + rotX(q - knee, -hipA);
            }
            transformed = hip + q;
          }

          // --- head / hat: archetype head scale, about the neck ---------------
          if ((apxLimb > 0.5 && apxLimb < 1.5) || apxLimb > 5.5) {
            float hs = aWho.z;
            transformed.y = ${NECK_Y.toFixed(3)} + (transformed.y - ${NECK_Y.toFixed(3)}) * hs;
            transformed.xz *= hs;
            // Bare-headed instances collapse the brim to a point at the neck.
            if (apxLimb > 5.5) {
              transformed = mix(vec3(0.0, ${NECK_Y.toFixed(3)}, 0.0), transformed, aPose.w);
            }
          }

          // --- arms -------------------------------------------------------------
          if (apxLimb > 1.5 && apxLimb < 3.5) {
            float side = (apxLimb < 2.5) ? -1.0 : 1.0;
            // Rest: hanging. Cheering: elbows up. Wave: straight overhead.
            // aPose.z is the fifth of the crowd who never put them down.
            float raise = mix(0.15, 1.55, clamp(cheer, 0.0, 1.0))
                        + wave * 1.45 + aPose.z * 1.5;
            float flap = ownBeat * (0.35 + cheer * 0.75) * (0.35 + wave + aPose.z * 0.5);
            vec3 pivot = vec3(side * ${SHOULDER_X.toFixed(3)}, ${SHOULDER_Y.toFixed(3)}, 0.0);
            vec3 local = transformed - pivot;
            local = rotX(local, -(raise + flap * 0.45));
            local = rotZ(local, side * (raise * 0.55 + flap * 0.5));
            transformed = pivot + local;
          }

          // Sitting down: hips onto the bench and shift back over it. The drop
          // is derived from the instance's own height scale, so a child lands on
          // the same bench an adult does (and its feet dangle, which is right)
          // instead of sinking through it.
          float hScale = length(instanceMatrix[1].xyz);
          float sitDrop = ${HIP_Y.toFixed(3)} - ${STAND_BENCH_H.toFixed(3)} / max(hScale, 0.3);
          transformed.y += bob + wave * (1.0 - aPose.y) * 0.16 - seated * sitDrop;
          transformed.z -= seated * 0.42;
          transformed.x += sway;
          // Lean forward a touch when excited, back a touch when sitting.
          transformed = rotX(transformed - vec3(0.0, 0.2, 0.0),
                             cheer * 0.05 * ownBeat - seated * 0.1)
                      + vec3(0.0, 0.2, 0.0);
          transformed *= apxVis;
        `);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <defaultnormal_vertex>', /* glsl */ `
        #ifdef USE_INSTANCING
          // NB: this chunk runs *before* <begin_vertex>, so read the attribute
          // directly — the locals from the position pass do not exist yet.
          float apxNLimb = aPart.x;
          // Arms are rotated after the normal is derived; a cheap re-derive keeps
          // raised arms from lighting like they are still hanging down.
          if (apxNLimb > 1.5 && apxNLimb < 3.5) {
            float side2 = (apxNLimb < 2.5) ? -1.0 : 1.0;
            float raise2 = mix(0.15, 1.55, clamp(uExcite, 0.0, 1.0)) + aPose.z * 1.5;
            objectNormal = rotX(objectNormal, -raise2);
            objectNormal = rotZ(objectNormal, side2 * raise2 * 0.55);
          }
          // Folded thighs, likewise: without this a seated row lights as if the
          // legs were still vertical and the whole block goes flat. The shin's
          // net rotation is zero (hip then counter-rotate), so it is left alone.
          if (apxNLimb > 4.5 && apxNLimb < 5.5) {
            objectNormal = rotX(objectNormal, -aPose.x * 1.30);
          }
        #endif
        #include <defaultnormal_vertex>
      `);

    };
    mat.customProgramCacheKey = () => 'apx-crowd';
    return mat;
  }

  // =========================================================================
  // FRAME
  // =========================================================================

  setCamera(camera: THREE.PerspectiveCamera): void {
    if (camera && camera.isPerspectiveCamera) this.camera = camera;
  }

  /** Base excitement, 0 = bored, 1 = final lap. */
  setExcitement(v: number): void { this.uExcite.value = clamp(v, 0, 1.3); }

  /** Send a Mexican wave around the circuit, starting at `arc` metres. */
  triggerWave(arc = 0): void {
    if (this.waveActive) return;
    this.uWavePos.value = arc - this.uWaveWidth.value;
    this.uWaveOn.value = 1;
    this.waveActive = true;
  }

  update(ctx: FrameContext): void {
    this.time += ctx.dt;
    this.uTime.value = this.time;
    if (this.camera) {
      this.uCamXZ.value.set(this.camera.position.x, this.camera.position.z);
      this.chunks?.cullTo(this.camera);
    }

    if (this.waveActive) {
      this.uWavePos.value += this.waveSpeed * ctx.dt;
      if (this.uWavePos.value > this.uLapLength.value + this.uWaveWidth.value * 2) {
        this.waveActive = false;
        this.uWaveOn.value = 0;
      }
    } else if (this.mesh) {
      // Spontaneous waves keep the venue alive between race events.
      if (Math.random() < ctx.dt * 0.045) this.triggerWave(Math.random() * this.uLapLength.value);
    }
  }

  get drawCalls(): number { return this.mesh ? 1 : 0; }
  get count(): number { return this.mesh ? this.mesh.count : 0; }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
    this.mesh?.dispose();
    this.geometry = null;
    this.material = null;
    this.mesh = null;
    this.chunks = null;
    this.scene.remove(this.group);
    this.group.clear();
  }
}
