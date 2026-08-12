/**
 * ============================================================================
 *  APEX KART — ITEM BOXES
 * ============================================================================
 *  A rotating translucent iridescent cube with a glowing `?` on every face,
 *  an inner glow core, and a Fresnel rim shell. Everything is procedural:
 *  a spherified (rounded) cube, a canvas-drawn `?` decal, and a physical
 *  material with transmission + iridescence.
 *
 *  Boxes are drawn as three InstancedMeshes (body / rim / core) so a field of
 *  60 boxes costs three draw calls. Pickup shatters the box into pooled shards
 *  and respawns it after ~3 s with an elastic scale-up pop.
 *
 *  Collision is a plain sphere test against kart positions, run every fixed
 *  step from ItemSystem.
 * ============================================================================
 */

import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '@/core/MathUtils';
import { canvasTexture, make2d } from './ItemModels';

export interface BoxSpawn {
  position: THREE.Vector3;
  /** Track up at that point. Defaults to +Y. */
  normal?: THREE.Vector3;
}

const MAX_BOXES = 96;
const MAX_SHARDS = 192;
const SHARDS_PER_BREAK = 14;

export const BOX_SIZE = 1.72;
export const BOX_PICKUP_RADIUS = 1.55;

/**
 * Seconds before a collected box returns.
 *
 * Raised from 3.0: with 26–31 authored boxes per lap a 3 s respawn meant a
 * player was holding an item almost continuously, and a playtester reported it
 * was "impossible to have a normal race". Rows were thinned at the same time;
 * this is the second half of that change.
 */
export const BOX_RESPAWN = 6.0;

/**
 * Height a SPAWNER lifts a box's centre above the road, metres.
 *
 * NOT a free parameter. The box tumbles (±0.32 rad about X, free yaw, ±0.22 rad
 * about Z), bobs and breathes ±2.2 % of scale, and the outer rim shell is
 * 1.075× the body — so its lowest point sweeps below its centre as it animates.
 *
 * MEASURED, not estimated (`.probe-tmp/boxclear.ts`, which drives the same
 * transform maths over the whole incommensurate tumble cycle and takes the true
 * minimum over both shells' vertices):
 *
 *     lowest point below centre   1.3164 m   (rim shell, at x=0.27 z=0.53)
 *     clearance at 1.70 m lift    0.3836 m   on flat road
 *     worst on any circuit        0.2789 m   (Neon Metropolis, animation extreme)
 *
 * An earlier revision of this comment claimed 1.47 m. That over-estimated the
 * drop by 15 cm — it took the half-diagonal of a *hard* cube, where the rounded
 * corners pull the extreme in. The lift is right either way, but the margin is
 * bigger than the comment implied.
 *
 * ⚠️ `TrackBuilder` does NOT import this. It carries its own private
 * `ITEM_BOX_HEIGHT = 1.7`, and the authored path — the one every shipping
 * circuit actually uses — reads that. The two agree numerically today, and a
 * previous handoff claimed they were the same symbol; they are not. That is why
 * the float trim below lives in `ItemBoxField` rather than in this constant:
 * raising this number alone would move the fallback boxes and leave all 39
 * authored ones exactly where they were.
 */
export const ITEM_BOX_LIFT = 1.7;

/**
 * Extra float the FIELD adds to every spawn, along that spawn's own up axis.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS — the third "half-buried box" report, and it is not geometry
 * ------------------------------------------------------------------------
 * The boxes do not intersect the road. Measured twice, on both spawn paths, all
 * three circuits: worst clearance 0.2789 m. What was never checked is whether
 * 0.28 m LOOKS like clearance, and on a 1.72 m box it does not — the visible gap
 * under it was 16 % of its own height at the animation extreme and ~32 % at rest.
 * An object floating that close to a surface reads as resting on it, and three
 * things then finish the illusion:
 *
 *   1. the body casts a real shadow-map shadow, which at 0.28 m lands directly
 *      under the box and merges with its own base;
 *   2. the additive Fresnel rim shell is 1.075x the body, so its halo hangs
 *      6.5 cm past the silhouette — including downward, onto the tarmac;
 *   3. the bob was SYMMETRIC (±0.10 m), so half of every cycle was spent BELOW
 *      the authored rest height, i.e. the worst case was also the common case.
 *
 * MK8's boxes float roughly half a box height clear. This trim plus the one-sided
 * bob (see `update`) takes the worst case from 0.28 m to ~0.72 m and the typical
 * gap to ~1.0 m — 42 % and 58 % of the box's height — which separates the shadow,
 * lifts the halo off the road, and makes the float legible.
 *
 * Applied here, in the field, for two reasons: it is the one place BOTH spawn
 * paths funnel through (so the authored path in `TrackBuilder` — which this agent
 * does not own — is fixed without touching it), and it is baked into `pos`, so
 * pickup collision, shards and VFX all use the same height the player sees.
 */
export const BOX_FLOAT = 0.34;

/** Peak of the one-sided bob, metres. The box rises from rest, never below it. */
export const BOX_BOB = 0.16;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const HIDDEN = new THREE.Matrix4().makeScale(1e-6, 1e-6, 1e-6);

/**
 * Box geometry with rounded edges: start from a subdivided cube and push every
 * vertex out to the rounded-cube surface. A hard-edged cube reads as low-poly
 * immediately, and the rounded edge is what catches the rim light.
 */
export function roundedBox(size: number, radius: number, seg = 6): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const h = size * 0.5;
  const inner = Math.max(1e-4, h - radius);
  const p = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    c.set(
      Math.max(-inner, Math.min(inner, p.x)),
      Math.max(-inner, Math.min(inner, p.y)),
      Math.max(-inner, Math.min(inner, p.z)),
    );
    p.sub(c);
    const len = p.length();
    if (len > 1e-6) p.multiplyScalar(radius / len);
    pos.setXYZ(i, c.x + p.x, c.y + p.y, c.z + p.z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** The `?` glyph, drawn as a stroked path so no font is required. */
function drawQuestion(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = s * 0.215;
  ctx.beginPath();
  // Hook: sweeps up the left, over the top, down the right.
  ctx.arc(cx, cy - s * 0.30, s * 0.29, Math.PI * 1.06, Math.PI * 0.18, false);
  // Tail curls back into the stem.
  ctx.bezierCurveTo(
    cx + s * 0.31, cy + s * 0.02,
    cx + s * 0.02, cy + s * 0.06,
    cx + s * 0.01, cy + s * 0.24,
  );
  ctx.stroke();
  // Dot.
  ctx.beginPath();
  ctx.arc(cx + s * 0.01, cy + s * 0.50, s * 0.125, 0, Math.PI * 2);
  ctx.fill();
}

export interface BoxPickup {
  boxIndex: number;
  kartId: number;
  position: THREE.Vector3;
}

interface BoxRec {
  pos: THREE.Vector3;
  up: THREE.Vector3;
  phase: number;
  /** > 0 while broken. */
  respawn: number;
  /** 0..1 pop-in envelope, 1 = fully present. */
  pop: number;
  alive: boolean;
}

export class ItemBoxField {
  private scene: THREE.Scene;
  private group = new THREE.Group();

  private body!: THREE.InstancedMesh;
  private rim!: THREE.InstancedMesh;
  private core!: THREE.InstancedMesh;
  private shards!: THREE.InstancedMesh;

  private boxes: BoxRec[] = [];
  private count = 0;

  // Shard pool — parallel arrays, never reallocated.
  private sPos = new Float32Array(MAX_SHARDS * 3);
  private sVel = new Float32Array(MAX_SHARDS * 3);
  private sRot = new Float32Array(MAX_SHARDS * 3);
  private sSpin = new Float32Array(MAX_SHARDS * 3);
  private sLife = new Float32Array(MAX_SHARDS);
  private sMax = new Float32Array(MAX_SHARDS);
  private sScale = new Float32Array(MAX_SHARDS);
  private sCursor = 0;

  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private texs: THREE.Texture[] = [];

  private elapsed = 0;
  /** Reused return object for pickup reporting. */
  private pickupOut: BoxPickup = { boxIndex: -1, kartId: -1, position: new THREE.Vector3() };

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  init(): void {
    this.group.name = 'ItemBoxes';
    this.buildBody();
    this.buildRim();
    this.buildCore();
    this.buildShards();
    this.scene.add(this.group);
  }

  // -------------------------------------------------------------------------

  private buildBody(): void {
    const SZ = 512;
    const ctx = make2d(SZ);
    // Iridescent panel: diagonal rainbow wash over a deep teal base.
    const bg = ctx.createLinearGradient(0, 0, SZ, SZ);
    bg.addColorStop(0.00, '#0e5f7a');
    bg.addColorStop(0.22, '#17a08f');
    bg.addColorStop(0.45, '#3fd06a');
    bg.addColorStop(0.62, '#d8e34a');
    bg.addColorStop(0.80, '#f08a3c');
    bg.addColorStop(1.00, '#c8479a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SZ, SZ);

    // Soft vignette so each face has its own falloff instead of reading flat.
    const vg = ctx.createRadialGradient(SZ * 0.5, SZ * 0.44, SZ * 0.06, SZ * 0.5, SZ * 0.5, SZ * 0.72);
    vg.addColorStop(0, 'rgba(255,255,255,0.42)');
    vg.addColorStop(0.55, 'rgba(255,255,255,0.04)');
    vg.addColorStop(1, 'rgba(0,20,40,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, SZ, SZ);

    // Fine chevron sheen — kills the "flat gradient" look at close range.
    ctx.globalCompositeOperation = 'overlay';
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 3;
    for (let i = -SZ; i < SZ * 2; i += 18) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + SZ, SZ);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Rounded inset frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 10;
    const pad = 42, r = 64;
    ctx.beginPath();
    ctx.moveTo(pad + r, pad);
    ctx.arcTo(SZ - pad, pad, SZ - pad, SZ - pad, r);
    ctx.arcTo(SZ - pad, SZ - pad, pad, SZ - pad, r);
    ctx.arcTo(pad, SZ - pad, pad, pad, r);
    ctx.arcTo(pad, pad, SZ - pad, pad, r);
    ctx.closePath();
    ctx.stroke();

    // The `?` — dark drop shadow, white glyph, warm inner highlight.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.strokeStyle = '#0b2230';
    ctx.fillStyle = '#0b2230';
    ctx.lineWidth = SZ * 0.055;
    drawQuestion(ctx, SZ * 0.5, SZ * 0.47, SZ * 0.62);
    ctx.restore();
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    drawQuestion(ctx, SZ * 0.5, SZ * 0.47, SZ * 0.60);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#fff6c8';
    ctx.fillStyle = '#fff6c8';
    ctx.lineWidth = SZ * 0.075;
    drawQuestion(ctx, SZ * 0.5, SZ * 0.455, SZ * 0.575);
    ctx.globalAlpha = 1;

    const map = canvasTexture(ctx);
    this.texs.push(map);

    // Emissive mask: only the glyph + frame glow.
    const ectx = make2d(SZ);
    ectx.fillStyle = '#000000';
    ectx.fillRect(0, 0, SZ, SZ);
    ectx.strokeStyle = '#8fe8ff';
    ectx.fillStyle = '#8fe8ff';
    ectx.shadowColor = '#4fd8ff';
    ectx.shadowBlur = 34;
    drawQuestion(ectx, SZ * 0.5, SZ * 0.47, SZ * 0.60);
    const emissive = canvasTexture(ectx);
    this.texs.push(emissive);

    const geo = roundedBox(BOX_SIZE, BOX_SIZE * 0.20, 6);
    this.geoms.push(geo);

    const mat = new THREE.MeshPhysicalMaterial({
      map,
      emissiveMap: emissive,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 1.35,
      roughness: 0.10,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      iridescence: 1.0,
      iridescenceIOR: 1.42,
      iridescenceThicknessRange: [140, 720],
      transmission: 0.42,
      thickness: 0.9,
      ior: 1.32,
      transparent: true,
      opacity: 0.9,
      sheen: 1.0,
      sheenColor: new THREE.Color(0x9fe8ff),
      sheenRoughness: 0.24,
      side: THREE.FrontSide,
      envMapIntensity: 1.3,
      depthWrite: true,
    });
    this.mats.push(mat);

    this.body = new THREE.InstancedMesh(geo, mat, MAX_BOXES);
    this.body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.body.frustumCulled = false;
    this.body.castShadow = true;
    this.body.count = 0;
    this.group.add(this.body);
  }

  private buildRim(): void {
    const geo = roundedBox(BOX_SIZE * 1.075, BOX_SIZE * 0.22, 5);
    this.geoms.push(geo);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0x7fe6ff) }, uPower: { value: 2.6 } },
      vertexShader: /* glsl */ `
        varying float vFres;
        void main() {
          #ifdef USE_INSTANCING
            mat4 im = instanceMatrix;
          #else
            mat4 im = mat4(1.0);
          #endif
          vec4 mv = modelViewMatrix * im * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * (mat3(im) * normal));
          vec3 vd = normalize(-mv.xyz);
          vFres = 1.0 - abs(dot(n, vd));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uPower;
        varying float vFres;
        void main() {
          float f = pow(clamp(vFres, 0.0, 1.0), uPower);
          gl_FragColor = vec4(uColor * (1.6 + f * 2.4), f * 0.95);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    });
    this.mats.push(mat);
    this.rim = new THREE.InstancedMesh(geo, mat, MAX_BOXES);
    this.rim.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rim.frustumCulled = false;
    this.rim.count = 0;
    this.rim.renderOrder = 5;
    this.group.add(this.rim);
  }

  private buildCore(): void {
    const geo = new THREE.IcosahedronGeometry(BOX_SIZE * 0.30, 1);
    this.geoms.push(geo);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xdff8ff,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mats.push(mat);
    this.core = new THREE.InstancedMesh(geo, mat, MAX_BOXES);
    this.core.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.core.frustumCulled = false;
    this.core.count = 0;
    this.core.renderOrder = 6;
    this.group.add(this.core);
  }

  private buildShards(): void {
    // Irregular tetra-ish shard: a squashed low-poly octahedron reads as glass.
    const geo = new THREE.OctahedronGeometry(0.19, 0);
    geo.scale(1.0, 0.55, 0.7);
    this.geoms.push(geo);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x9fe4ff,
      roughness: 0.12,
      metalness: 0.0,
      transparent: true,
      opacity: 0.85,
      clearcoat: 1.0,
      iridescence: 0.9,
      iridescenceIOR: 1.4,
      emissive: new THREE.Color(0x2fa8d8),
      emissiveIntensity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mats.push(mat);
    this.shards = new THREE.InstancedMesh(geo, mat, MAX_SHARDS);
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shards.frustumCulled = false;
    this.shards.count = MAX_SHARDS;
    this.shards.renderOrder = 7;
    for (let i = 0; i < MAX_SHARDS; i++) this.shards.setMatrixAt(i, HIDDEN);
    this.group.add(this.shards);
  }

  // -------------------------------------------------------------------------

  /** Replace the field. Safe to call before or after init(). */
  setSpawns(spawns: readonly BoxSpawn[]): void {
    this.boxes.length = 0;
    const n = Math.min(spawns.length, MAX_BOXES);
    for (let i = 0; i < n; i++) {
      const s = spawns[i];
      const up = (s.normal ? s.normal.clone() : new THREE.Vector3(0, 1, 0)).normalize();
      this.boxes.push({
        // `BOX_FLOAT` is baked in HERE and nowhere else, so every consumer of
        // `pos` — the pickup sphere, the shard burst, the VFX position the HUD
        // reads — agrees with what is drawn. See the constant for why.
        pos: s.position.clone().addScaledVector(up, BOX_FLOAT),
        up,
        phase: (i * 0.618033) % 1,
        respawn: 0,
        pop: 1,
        alive: true,
      });
    }
    this.count = this.boxes.length;
    if (this.body) {
      this.body.count = this.count;
      this.rim.count = this.count;
      this.core.count = this.count;
    }
  }

  get boxCount(): number { return this.count; }
  getBoxPosition(i: number): THREE.Vector3 | null { return this.boxes[i]?.pos ?? null; }
  isAlive(i: number): boolean { return this.boxes[i]?.alive ?? false; }
  /** Boxes currently collectable. */
  get aliveCount(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.boxes[i].alive) n++;
    return n;
  }

  /**
   * CYLINDER test against every kart. `onPickup` fires once per box per hit.
   * Called from fixedUpdate.
   *
   * ⚠️ It used to open with a 3-D pre-filter,
   * `dx² + dy² + dz² > r² + 1.2 -> skip`, which silently COUPLED THE CATCH RADIUS
   * TO THE FLOAT HEIGHT. With a kart CoM ~0.45 m up and a box centre at 1.70 m,
   * `dy² = 1.56` ate most of the 3.60 budget and left a 1.43 m horizontal reach;
   * raising the float by `BOX_FLOAT` would have cut that to 1.04 m — barely wider
   * than a kart's half-width — and turned a visual fix into "the boxes stopped
   * collecting". `TrackBuilder`'s own comment on `ITEM_BOX_HEIGHT` even cites the
   * 1.4 m figure as the *upper bound on how high a box may float*, which is the
   * tail wagging the dog: a pre-filter is an early-out, not a gameplay rule.
   *
   * The two tests that follow are the actual contract and always were — a 1.55 m
   * horizontal radius and ±2.4 m of vertical slack — so the reach is now
   * independent of how high the box hovers.
   */
  checkPickups(
    positions: ReadonlyArray<{ id: number; position: THREE.Vector3; skip: boolean }>,
    onPickup: (p: BoxPickup) => void,
  ): void {
    const r2 = BOX_PICKUP_RADIUS * BOX_PICKUP_RADIUS;
    for (let i = 0; i < this.count; i++) {
      const b = this.boxes[i];
      if (!b.alive || b.pop < 0.55) continue;
      for (let k = 0; k < positions.length; k++) {
        const kart = positions[k];
        if (kart.skip) continue;
        const dy = kart.position.y - b.pos.y;
        // Cheapest reject first, and the one that culls a whole lap's worth of
        // boxes on a circuit with bridges over itself.
        if (Math.abs(dy) > 2.4) continue;
        const dx = kart.position.x - b.pos.x;
        const dz = kart.position.z - b.pos.z;
        if (dx * dx + dz * dz > r2) continue;
        this.breakBox(i);
        this.pickupOut.boxIndex = i;
        this.pickupOut.kartId = kart.id;
        this.pickupOut.position.copy(b.pos);
        onPickup(this.pickupOut);
        break;
      }
    }
  }

  breakBox(i: number): void {
    const b = this.boxes[i];
    if (!b || !b.alive) return;
    b.alive = false;
    b.respawn = BOX_RESPAWN;
    b.pop = 0;
    this.spawnShards(b.pos);
  }

  private spawnShards(at: THREE.Vector3): void {
    for (let n = 0; n < SHARDS_PER_BREAK; n++) {
      const i = this.sCursor;
      this.sCursor = (this.sCursor + 1) % MAX_SHARDS;
      const i3 = i * 3;
      this.sPos[i3] = at.x; this.sPos[i3 + 1] = at.y; this.sPos[i3 + 2] = at.z;
      // Spray outward on a slightly upward cone.
      const a = Math.random() * Math.PI * 2;
      const el = 0.25 + Math.random() * 0.95;
      const sp = 4.5 + Math.random() * 6.5;
      this.sVel[i3] = Math.cos(a) * Math.cos(el) * sp;
      this.sVel[i3 + 1] = Math.sin(el) * sp * 1.15 + 1.5;
      this.sVel[i3 + 2] = Math.sin(a) * Math.cos(el) * sp;
      this.sRot[i3] = Math.random() * 6.28;
      this.sRot[i3 + 1] = Math.random() * 6.28;
      this.sRot[i3 + 2] = Math.random() * 6.28;
      this.sSpin[i3] = (Math.random() - 0.5) * 22;
      this.sSpin[i3 + 1] = (Math.random() - 0.5) * 22;
      this.sSpin[i3 + 2] = (Math.random() - 0.5) * 22;
      this.sMax[i] = 0.55 + Math.random() * 0.45;
      this.sLife[i] = this.sMax[i];
      this.sScale[i] = 0.6 + Math.random() * 0.8;
    }
  }

  // -------------------------------------------------------------------------

  /** Fixed-step: respawn timers only (collision is driven by ItemSystem). */
  fixedUpdate(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      const b = this.boxes[i];
      if (b.alive) {
        if (b.pop < 1) b.pop = Math.min(1, b.pop + dt * 2.4);
        continue;
      }
      b.respawn -= dt;
      if (b.respawn <= 0) { b.alive = true; b.pop = 0; }
    }
  }

  /** Variable-step: tumble, pop, glow pulse, shard simulation. */
  update(dt: number): void {
    this.elapsed += dt;
    const t = this.elapsed;

    for (let i = 0; i < this.count; i++) {
      const b = this.boxes[i];
      if (!b.alive) {
        this.body.setMatrixAt(i, HIDDEN);
        this.rim.setMatrixAt(i, HIDDEN);
        this.core.setMatrixAt(i, HIDDEN);
        continue;
      }
      // Slow two-axis tumble, per-instance phase so the field never syncs up.
      const ph = b.phase * Math.PI * 2;
      _euler.set(
        0.32 * Math.sin(t * 0.55 + ph) + 0.38,
        t * 0.72 + ph,
        0.22 * Math.cos(t * 0.41 + ph * 1.7),
        'YXZ',
      );
      _q.setFromEuler(_euler);

      // Elastic pop-in with overshoot, plus a gentle idle breathe + bob.
      const k = clamp01(b.pop);
      const overshoot = 1 + Math.sin(k * Math.PI) * 0.34 * (1 - smoothstep(k));
      const breathe = 1 + Math.sin(t * 2.2 + ph) * 0.022;
      const s = smoothstep(k) * overshoot * breathe;
      // ONE-SIDED BOB. This used to be `sin(...) * 0.10`, i.e. half of every
      // cycle spent BELOW the authored rest height — so the worst-case road
      // clearance was also the average one, and the box dipped toward the tarmac
      // twice a second. Now it only ever rises from rest, which reads as the same
      // gentle hover and makes the rest height a true floor.
      const bob = (0.5 + 0.5 * Math.sin(t * 1.5 + ph)) * BOX_BOB;

      _v.copy(b.pos).addScaledVector(b.up, bob);
      _scale.setScalar(s);
      _m.compose(_v, _q, _scale);
      this.body.setMatrixAt(i, _m);
      this.rim.setMatrixAt(i, _m);

      // Core counter-rotates and pulses harder.
      _euler.set(-t * 1.35 + ph, t * 0.9, 0, 'YXZ');
      _q.setFromEuler(_euler);
      _scale.setScalar(s * (0.85 + Math.sin(t * 4.1 + ph * 3) * 0.16));
      _m.compose(_v, _q, _scale);
      this.core.setMatrixAt(i, _m);
    }
    if (this.count > 0) {
      this.body.instanceMatrix.needsUpdate = true;
      this.rim.instanceMatrix.needsUpdate = true;
      this.core.instanceMatrix.needsUpdate = true;
    }

    // Shards
    let anyShard = false;
    for (let i = 0; i < MAX_SHARDS; i++) {
      if (this.sLife[i] <= 0) continue;
      anyShard = true;
      const i3 = i * 3;
      this.sLife[i] -= dt;
      if (this.sLife[i] <= 0) { this.shards.setMatrixAt(i, HIDDEN); continue; }
      this.sVel[i3 + 1] -= 26 * dt;
      this.sPos[i3] += this.sVel[i3] * dt;
      this.sPos[i3 + 1] += this.sVel[i3 + 1] * dt;
      this.sPos[i3 + 2] += this.sVel[i3 + 2] * dt;
      this.sRot[i3] += this.sSpin[i3] * dt;
      this.sRot[i3 + 1] += this.sSpin[i3 + 1] * dt;
      this.sRot[i3 + 2] += this.sSpin[i3 + 2] * dt;
      const life01 = clamp01(this.sLife[i] / this.sMax[i]);
      _v.set(this.sPos[i3], this.sPos[i3 + 1], this.sPos[i3 + 2]);
      _euler.set(this.sRot[i3], this.sRot[i3 + 1], this.sRot[i3 + 2], 'XYZ');
      _q.setFromEuler(_euler);
      _scale.setScalar(this.sScale[i] * (0.35 + life01 * 0.85));
      _m.compose(_v, _q, _scale);
      this.shards.setMatrixAt(i, _m);
    }
    if (anyShard) this.shards.instanceMatrix.needsUpdate = true;
  }

  /** Everything back to alive, shards cleared. */
  reset(): void {
    for (const b of this.boxes) { b.alive = true; b.respawn = 0; b.pop = 1; }
    for (let i = 0; i < MAX_SHARDS; i++) {
      this.sLife[i] = 0;
      if (this.shards) this.shards.setMatrixAt(i, HIDDEN);
    }
    if (this.shards) this.shards.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.clear();
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    this.geoms.length = 0;
    this.mats.length = 0;
    this.texs.length = 0;
    this.boxes.length = 0;
    this.count = 0;
  }
}

/** Kept for callers that want the raw glyph painter (dev harness / HUD). */
export const paintQuestionMark = drawQuestion;
export const boxLerp = lerp;
