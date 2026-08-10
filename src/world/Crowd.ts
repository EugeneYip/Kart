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
import type { StandSpec } from './Props';
import { InstanceChunks, type TerrainField, type WorldContext } from './WorldTextures';

/** Limb ids baked into the geometry. */
const LIMB_BODY = 0;
const LIMB_HEAD = 1;
const LIMB_ARM_L = 2;
const LIMB_ARM_R = 3;

const COUNT_FOR_TIER: Record<string, number> = {
  low: 320, medium: 780, high: 1350, ultra: 2000,
};

/** Shirt palette — saturated but not clownish, MK8 keeps crowds readable. */
const SHIRTS = [
  0xe23b32, 0x2f6fd0, 0xf2c53d, 0x2fa363, 0xe8752f, 0x8b4fd6,
  0xe9e5da, 0x2b3038, 0x3fc6d6, 0xd94f8a, 0x6b8f2f, 0xf0a63c,
];
const SKINS = [0xf2c9a0, 0xd9a273, 0xa9744b, 0x7a4f2e, 0xf6dcc0, 0x5c3a22];
const HAIRS = [0x2a1c14, 0x4a3220, 0x1a1512, 0x6b4a2a, 0x8a7256, 0xb8b0a4];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _axisY = new THREE.Vector3(0, 1, 0);

/** A 1.2 m person past this is sub-pixel; the shader used to cull at 250 m. */
const CROWD_CULL = 260;

interface Seat {
  x: number; y: number; z: number;
  yaw: number;
  arc: number;
  scale: number;
  /** 0 = seated in a stand, 1 = standing at the fence. */
  standing: number;
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

    const phase = new Float32Array(seats.length);
    const arc = new Float32Array(seats.length);
    const stand = new Float32Array(seats.length);
    const shirt = new Float32Array(seats.length * 3);
    const bounds = new THREE.Box3();

    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      _q.setFromAxisAngle(_axisY, s.yaw + (this.rng.next() - 0.5) * 0.5);
      _m.compose(_v.set(s.x, s.y, s.z), _q, _s.setScalar(s.scale));
      mesh.setMatrixAt(i, _m);
      phase[i] = this.rng.next();
      arc[i] = s.arc;
      stand[i] = s.standing;
      bounds.expandByPoint(_v);

      // Shirt colour rides its own attribute rather than `instanceColor`, so it
      // can be applied to the torso and sleeves only — skin and hair keep theirs.
      _c.setHex(SHIRTS[Math.floor(this.rng.next() * SHIRTS.length) % SHIRTS.length]);
      shirt[i * 3] = _c.r; shirt[i * 3 + 1] = _c.g; shirt[i * 3 + 2] = _c.b;
    }
    mesh.instanceMatrix.needsUpdate = true;

    this.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    this.geometry.setAttribute('aArc', new THREE.InstancedBufferAttribute(arc, 1));
    this.geometry.setAttribute('aStanding', new THREE.InstancedBufferAttribute(stand, 1));
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
      .track(this.geometry.getAttribute('aPhase') as THREE.InstancedBufferAttribute)
      .track(this.geometry.getAttribute('aArc') as THREE.InstancedBufferAttribute)
      .track(this.geometry.getAttribute('aStanding') as THREE.InstancedBufferAttribute)
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
      const rowH = 0.78, rowD = 1.15;
      const perRow = Math.max(1, Math.round(want / stand.rows));
      for (let r = 0; r < stand.rows; r++) {
        // Front rows fill first — that's what real stands look like.
        const rowFill = clamp01(stand.density * (1.25 - r / stand.rows * 0.45));
        for (let i = 0; i < perRow; i++) {
          if (rng.next() > rowFill) continue;
          const along = ((i + 0.5) / perRow - 0.5) * (stand.width - 3.0)
            + (rng.next() - 0.5) * 0.5;
          const lz = -r * rowD + 0.15;
          const ly = r * rowH + 0.44;
          seats.push({
            x: stand.position.x + ca * along + sa * lz,
            y: stand.position.y + ly,
            z: stand.position.z - sa * along + ca * lz,
            yaw: stand.yaw,
            arc: stand.arc + along * 0.5,
            scale: 0.92 + rng.next() * 0.2,
            standing: 0,
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
          scale: 0.94 + rng.next() * 0.2,
          standing: 1,
        });
        placed++;
      }
    }

    return seats;
  }

  // =========================================================================
  // GEOMETRY
  // =========================================================================

  /**
   * ~150 triangles: a tapered torso, a chamfered head, hair, and two arms whose
   * vertices are authored in shoulder-relative space so the shader can rotate
   * them without a skeleton.
   */
  private buildPerson(): THREE.BufferGeometry {
    const P: number[] = [], N: number[] = [], C: number[] = [], L: number[] = [];
    const T: number[] = [], I: number[] = [];
    const rng = this.rng;
    const skin = SKINS[Math.floor(rng.next() * SKINS.length) % SKINS.length];
    const hair = HAIRS[Math.floor(rng.next() * HAIRS.length) % HAIRS.length];
    /** 1 = this part takes the per-instance shirt colour. */
    let tint = 0;

    const push = (
      x: number, y: number, z: number,
      nx: number, ny: number, nz: number,
      hex: number, limb: number, shade: number,
    ): number => {
      P.push(x, y, z); N.push(nx, ny, nz);
      _c.setHex(hex);
      C.push(_c.r * shade, _c.g * shade, _c.b * shade);
      L.push(limb);
      T.push(tint);
      return P.length / 3 - 1;
    };

    const quad = (
      a: [number, number, number], b: [number, number, number],
      c: [number, number, number], d: [number, number, number],
      hex: number, limb: number, shade: number,
    ): void => {
      let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i0 = push(a[0], a[1], a[2], nx, ny, nz, hex, limb, shade);
      push(b[0], b[1], b[2], nx, ny, nz, hex, limb, shade);
      push(c[0], c[1], c[2], nx, ny, nz, hex, limb, shade);
      push(d[0], d[1], d[2], nx, ny, nz, hex, limb, shade);
      I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    };

    // `floor` draws the downward face. Off for every part that is stacked on
    // another part or sitting on a bench: 12 boxes × 2 triangles × 1 850
    // spectators is 44 000 triangles a frame that nothing can ever see.
    const box = (
      cx: number, cy: number, cz: number,
      hx: number, hy: number, hz: number,
      hex: number, limb: number, taper = 1, topShade = 1.14, floor = false,
    ): void => {
      const bx = hx, bz = hz, tx = hx * taper, tz = hz * taper;
      const b0: [number, number, number] = [cx - bx, cy - hy, cz - bz];
      const b1: [number, number, number] = [cx + bx, cy - hy, cz - bz];
      const b2: [number, number, number] = [cx + bx, cy - hy, cz + bz];
      const b3: [number, number, number] = [cx - bx, cy - hy, cz + bz];
      const t0: [number, number, number] = [cx - tx, cy + hy, cz - tz];
      const t1: [number, number, number] = [cx + tx, cy + hy, cz - tz];
      const t2: [number, number, number] = [cx + tx, cy + hy, cz + tz];
      const t3: [number, number, number] = [cx - tx, cy + hy, cz + tz];
      quad(b0, b1, t1, t0, hex, limb, 0.96);
      quad(b1, b2, t2, t1, hex, limb, 0.86);
      quad(b2, b3, t3, t2, hex, limb, 1.04);
      quad(b3, b0, t0, t3, hex, limb, 0.88);
      quad(t0, t1, t2, t3, hex, limb, topShade);
      if (floor) quad(b3, b2, b1, b0, hex, limb, 0.58);
    };

    // Torso — authored white, tinted per instance.
    tint = 1;
    box(0, 0.62, 0, 0.155, 0.26, 0.105, 0xffffff, LIMB_BODY, 0.86);
    tint = 0;
    // Trousers / legs (seated people show knees, standing show shins).
    box(0, 0.2, 0.02, 0.14, 0.2, 0.11, 0x3a3f47, LIMB_BODY, 1.05, 0.9);
    // Neck + head.
    box(0, 0.92, 0, 0.055, 0.05, 0.05, skin, LIMB_BODY, 1);
    box(0, 1.06, 0, 0.095, 0.1, 0.09, skin, LIMB_HEAD, 0.94);
    box(0, 1.15, -0.005, 0.1, 0.045, 0.095, hair, LIMB_HEAD, 0.9, 1.2);
    // Everyone gets a small cap brim: it catches the light as they bob, which is
    // most of what makes a distant crowd read as people rather than pillars.
    // The brim is thin and the stands sit above the track, so its underside is
    // one of the few downward faces a player can actually see.
    box(0, 1.13, 0.08, 0.09, 0.018, 0.05, hair, LIMB_HEAD, 1, 1.15, true);

    // Arms: authored hanging down from the shoulder pivot at y = 0.86.
    for (const side of [-1, 1]) {
      const limb = side < 0 ? LIMB_ARM_L : LIMB_ARM_R;
      const sx = side * 0.185;
      tint = 1;
      box(sx, 0.79, 0, 0.045, 0.075, 0.05, 0xffffff, limb, 1);   // sleeve
      tint = 0;
      box(sx, 0.6, 0, 0.038, 0.13, 0.042, skin, limb, 1);        // forearm
      // Hands end the limb, so they keep their end cap — arms get thrown
      // overhead during a wave and a hollow fist would show.
      box(sx, 0.47, 0, 0.042, 0.035, 0.045, skin, limb, 1, 1.14, true); // hand
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setAttribute('aLimb', new THREE.Float32BufferAttribute(L, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(T, 1));
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

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          attribute float aLimb;
          attribute float aTint;
          attribute float aPhase;
          attribute float aArc;
          attribute float aStanding;
          attribute vec3 aShirt;
          uniform float uTime;
          uniform float uWavePos;
          uniform float uWaveOn;
          uniform float uWaveWidth;
          uniform float uLapLength;
          uniform float uExcite;
          uniform vec2 uCamXZ;

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
            vColor.xyz = mix(vColor.xyz, vColor.xyz * aShirt, aTint);
          #endif
        `)
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          float ph = aPhase * 6.28318;

          // Distance cull: a person is ~1.2 m tall, invisible past 240 m.
          vec2 apxOrigin = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float apxVis = step(length(apxOrigin - uCamXZ), 250.0);

          // --- travelling wave -------------------------------------------------
          // Arc-length difference, wrapped so the wave can cross the start line.
          float d = aArc - uWavePos;
          d -= uLapLength * floor(d / uLapLength + 0.5);
          float wave = 1.0 - smoothstep(0.0, uWaveWidth, abs(d));
          wave = wave * wave * (3.0 - 2.0 * wave) * uWaveOn;

          // --- excitement ------------------------------------------------------
          float cheer = clamp(uExcite + wave, 0.0, 1.4);
          float ownBeat = sin(uTime * (4.4 + aPhase * 2.2) + ph);

          // --- idle bob + sway --------------------------------------------------
          float bob = sin(uTime * (1.7 + aPhase * 0.9) + ph) * 0.016
                    + wave * 0.30 + cheer * 0.012 * ownBeat;
          float sway = cos(uTime * (1.1 + aPhase * 0.6) + ph * 1.7) * 0.014;

          // --- arms -------------------------------------------------------------
          if (aLimb >= 2.0) {
            float side = (aLimb == 2.0) ? -1.0 : 1.0;
            // Rest: hanging. Cheering: elbows up. Wave: straight overhead.
            float raise = mix(0.15, 1.55, clamp(cheer, 0.0, 1.0)) + wave * 1.45;
            float flap = ownBeat * (0.35 + cheer * 0.75) * (0.35 + wave);
            vec3 pivot = vec3(side * 0.185, 0.86, 0.0);
            vec3 local = transformed - pivot;
            local = rotX(local, -(raise + flap * 0.45));
            local = rotZ(local, side * (raise * 0.55 + flap * 0.5));
            transformed = pivot + local;
          }

          // Seated people rise onto their feet as the wave passes.
          transformed.y += bob + wave * (1.0 - aStanding) * 0.16;
          transformed.x += sway;
          // Lean forward a touch when excited.
          transformed = rotX(transformed - vec3(0.0, 0.2, 0.0), cheer * 0.05 * ownBeat)
                      + vec3(0.0, 0.2, 0.0);
          transformed *= apxVis;
        `);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <defaultnormal_vertex>', /* glsl */ `
        #ifdef USE_INSTANCING
          // Arms are rotated after the normal is derived; a cheap re-derive keeps
          // raised arms from lighting like they are still hanging down.
          if (aLimb >= 2.0) {
            float side2 = (aLimb == 2.0) ? -1.0 : 1.0;
            float raise2 = mix(0.15, 1.55, clamp(uExcite, 0.0, 1.0));
            objectNormal = rotX(objectNormal, -raise2);
            objectNormal = rotZ(objectNormal, side2 * raise2 * 0.55);
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
