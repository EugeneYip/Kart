/**
 * ============================================================================
 *  APEX KART — TRACK HAZARDS
 * ============================================================================
 *  Everything on the track that hurts you but isn't an item: oil slicks,
 *  rolling boulders, lava fireballs, sliding blocks and snapper plants.
 *
 *  Placement comes from the track's decoration hints when it offers them
 *  (`track.getHazardHints()`); otherwise hazards are laid out procedurally
 *  from the spline with a seeded RNG, so the layout is identical every run.
 *
 *  All contact damage goes through `physics.applyStun` — hazards never touch
 *  kart state directly.
 *
 *  ---------------------------------------------------------------------------
 *  P0d-D1 — three separate reasons hazards read as unfair, all fixed here:
 *
 *  1. AUTHORED `lat` WAS DISCARDED FOR MOVERS. `boulder` and `slider` built
 *     their lateral offset as `sin(...) * amplitude` about the *centreline* and
 *     never read `h.lateral` at all. The previous difficulty pass moved every
 *     hazard off the racing line in `TrackDefs`, and for the two moving kinds
 *     that edit did nothing: a boulder authored at `lat: -15` still swept
 *     symmetrically through the middle of the road. `lateral` is now the centre
 *     of the sweep, and the sweep is clamped so it can never come within
 *     `MOVER_MIN_CLEAR` of the centreline.
 *
 *  2. MOVERS WERE FASTER THAN THE KARTS. Speed was an angular rate multiplied
 *     by the amplitude, so a wide span meant a *faster* object: Volcano's
 *     `span: 18, speed: 4` boulder crossed at 13 m x 2.2 rad/s = 28.6 m/s peak,
 *     i.e. above a kart's 28 m/s top speed. Movers are now specified in metres
 *     per second of cross-track travel and the angular rate is derived, so span
 *     changes the distance covered and never the speed.
 *
 *  3. ONE MOVER PER SPAN. Two hazards sharing an arc-length span take turns
 *     re-hitting a stunned kart. `build()` now rejects a mover that lands
 *     within `SPAN_GUARD` metres of one already placed.
 *
 *  The stun-lock itself is fixed in physics (`POST_HIT_GRACE` in KartPhysics):
 *  a stun now carries invulnerability for its own duration plus a forgiveness
 *  window, and `contact()` consults `KartState.invulnerable`. The per-hazard
 *  `cool` here is a second, independent guard.
 *
 *  The `traffic` kind is GONE, not slowed. It was the only hazard that arrived
 *  from behind the player, outside their field of view.
 * ============================================================================
 */

import * as THREE from 'three';
import type { KartState } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { clamp01, lerp, Rng, smoothstep, wrap } from '@/core/MathUtils';
import { canvasTexture, fbm, make2d, normalFromHeight, pixelTexture, ringNoise } from './ItemModels';
import type { KartsLike, PhysicsLike, TrackLike, VfxLike } from './Projectiles';

export type HazardKind = 'oil' | 'boulder' | 'fireball' | 'slider' | 'snapper';

export interface HazardHint {
  kind: HazardKind;
  /** Arc length along the lap, metres. */
  distance: number;
  /** Offset from the centreline, metres (+ = driver's right). */
  lateral?: number;
  /** Travel range for movers, metres. */
  span?: number;
  speed?: number;
}

interface TrackWithHints extends TrackLike {
  getHazardHints?(): readonly HazardHint[] | undefined;
}

const MAX_HAZARDS = 40;
const KART_RADIUS = 1.05;

/**
 * Cross-track travel speed of a moving hazard at its fastest point, m/s.
 *
 * Authored as a real speed, not an angular rate — see note 2 in the header.
 * A kart at 28 m/s spends ~0.12 s inside a 3.4 m boulder; at 3.2 m/s the
 * boulder shifts 0.38 m in that time, so the gap you aimed at is still there
 * when you arrive. That is the difference between "hard" and "unfair".
 */
const MOVER_SPEED: Partial<Record<HazardKind, number>> = {
  boulder: 3.2,
  slider: 4.0,
};

/**
 * How close a mover's sweep may come to the centreline, metres.
 *
 * The racing line is not the centreline, but it is never further out than this
 * on any authored corner, so a hazard that respects the clearance punishes a bad
 * line instead of blocking the good one.
 */
const MOVER_MIN_CLEAR = 3.0;

/** Authored `speed` that maps to 1.0x. Values either side scale within ±50 %. */
const MOVER_SPEED_REF = 4;

/**
 * Arc-length exclusion zone around a placed mover, metres. A second mover
 * inside it can re-hit a kart that is still recovering from the first.
 */
const SPAN_GUARD = 55;

/**
 * Extra seconds on top of the stun before one hazard may hit the same area
 * again. Mirrors `POST_HIT_GRACE` in KartPhysics — kept as its own constant so
 * the hazard guard survives a change to the physics window.
 */
const HAZARD_RECOVERY = 1.6;

/** Kinds that travel across the road and therefore contend for a span. */
const MOVING_KINDS: ReadonlySet<HazardKind> = new Set<HazardKind>(['boulder', 'slider', 'fireball']);

/**
 * Cycle time of the two hazards that pulse in place rather than travel, seconds.
 *
 * These had the same units bug as the movers: `h.speed` was read as an angular
 * rate, so Volcano's `speed: 5` fireball rose and fell 6 m at 6.75 rad/s — a
 * peak vertical speed of 40 m/s, faster than any kart, and far too fast to
 * read. A snapper with no authored speed bit once every 1.8 s.
 */
const CYCLE_PERIOD: Partial<Record<HazardKind, number>> = {
  fireball: 3.4,
  snapper: 2.6,
};

const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _sPos = new THREE.Vector3();
const _sBi = new THREE.Vector3();
const _sUp = new THREE.Vector3();

interface Hazard {
  kind: HazardKind;
  node: THREE.Object3D;
  /** Sub-nodes that need animating. */
  partA: THREE.Object3D | null;
  partB: THREE.Object3D | null;
  dist: number;
  lateral: number;
  span: number;
  speed: number;
  /** Centre of a mover's sweep, metres from the centreline. */
  centre: number;
  /** Half-travel of a mover's sweep, metres. 0 for a static hazard. */
  amp: number;
  /** Sweep angular rate, rad/s. Derived from MOVER_SPEED, never authored. */
  omega: number;
  phase: number;
  radius: number;
  /** Vertical half-extent for the contact test. */
  height: number;
  pos: THREE.Vector3;
  up: THREE.Vector3;
  t: number;
  cool: number;
  stun: number;
  kick: number;
  stunKind: string;
  /**
   * 0..1 animation phase written by fixedUpdate and *read* by update().
   * Both used to recompute it from `t` independently, which meant the visible
   * jaw and the collision radius could disagree by a frame.
   */
  anim: number;
}

export class Hazards {
  private scene: THREE.Scene;
  private track: TrackWithHints;
  private karts: KartsLike;
  private physics: PhysicsLike;
  private vfx: VfxLike;

  private group = new THREE.Group();
  private list: Hazard[] = [];
  private rng = new Rng(0xA71C3);

  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private texs: THREE.Texture[] = [];
  private enabled = true;

  constructor(
    scene: THREE.Scene,
    track: TrackLike,
    karts: KartsLike,
    physics: PhysicsLike,
    vfx: VfxLike,
  ) {
    this.scene = scene;
    this.track = track as TrackWithHints;
    this.karts = karts;
    this.physics = physics;
    this.vfx = vfx;
  }

  // -------------------------------------------------------------------------

  init(): void {
    this.group.name = 'Hazards';
    this.scene.add(this.group);

    if (typeof this.track.sampleAtDistance !== 'function') {
      // Without a spline we cannot place anything sensibly — stay silent.
      this.enabled = false;
      return;
    }

    const hints = this.gatherHints();
    for (const h of hints) {
      if (this.list.length >= MAX_HAZARDS) break;
      this.build(h);
    }
  }

  /**
   * Rebuild for a different circuit. `ItemSystem` calls this when it notices the
   * track changed under it — without it a race on Neon or Volcano runs Sunset's
   * hazard list re-projected onto the new spline, because `init()` only ever ran
   * once against whichever circuit happened to be loaded at boot.
   */
  rebuild(): void {
    this.clear();
    if (typeof this.track.sampleAtDistance !== 'function') { this.enabled = false; return; }
    this.enabled = true;
    this.rng = new Rng(0xA71C3);
    const hints = this.gatherHints();
    for (const h of hints) {
      if (this.list.length >= MAX_HAZARDS) break;
      this.build(h);
    }
  }

  /** Drop every hazard and release its GPU resources. */
  private clear(): void {
    this.group.clear();
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    this.geoms.length = 0;
    this.mats.length = 0;
    this.texs.length = 0;
    this.list.length = 0;
  }

  /**
   * True when `d` is too close to a mover already placed. One mover per span:
   * two that share a span take turns re-hitting a kart that is still recovering.
   */
  private spanTaken(d: number, kind: HazardKind): boolean {
    if (!MOVING_KINDS.has(kind)) return false;
    const lap = this.lapLength;
    for (const h of this.list) {
      if (!MOVING_KINDS.has(h.kind)) continue;
      // Wrapped separation, so a hazard at d=5 and one at d=lap-5 are 10 m apart.
      const raw = Math.abs(wrap(d - h.dist + lap * 0.5, lap) - lap * 0.5);
      if (raw < SPAN_GUARD) return true;
    }
    return false;
  }

  private get lapLength(): number {
    const l = this.track.lapLength;
    return typeof l === 'number' && l > 1 ? l : 800;
  }

  private gatherHints(): HazardHint[] {
    const fromTrack = typeof this.track.getHazardHints === 'function'
      ? this.track.getHazardHints()
      : undefined;
    if (fromTrack && fromTrack.length) return fromTrack.slice(0, MAX_HAZARDS);

    // Procedural fallback: walk the lap and drop a themed hazard every so often,
    // keeping the first 60 m of the lap clear so the grid start is fair.
    const out: HazardHint[] = [];
    const lap = this.lapLength;
    // Was `lap / 22` — one hazard every 38 m on a 1.6 km lap is 22 hazards per
    // lap, which is where the "two boulders at once" reports come from on any
    // track that does not publish hints (the dev harness, and the real game for
    // one frame after a circuit swap). A fallback is a safety net, not a level.
    const step = Math.max(150, lap / 7);
    const kinds: HazardKind[] = ['oil', 'boulder', 'fireball', 'slider', 'snapper'];
    for (let d = 90; d < lap - 60; d += step) {
      const kind = kinds[this.rng.int(0, kinds.length - 1)];
      const jitter = this.rng.range(-step * 0.18, step * 0.18);
      const side = this.rng.next() < 0.5 ? -1 : 1;
      out.push({
        kind,
        distance: wrap(d + jitter, lap),
        // Never on the racing line, even in the fallback.
        lateral: side * this.rng.range(MOVER_MIN_CLEAR + 1.5, 9.5),
        span: this.rng.range(8, 13),
        speed: this.rng.range(MOVER_SPEED_REF * 0.6, MOVER_SPEED_REF),
      });
    }
    return out;
  }

  /** Sample the spline into module scratch. */
  private sample(d: number): boolean {
    if (typeof this.track.sampleAtDistance !== 'function') return false;
    const s = this.track.sampleAtDistance(wrap(d, this.lapLength));
    if (!s) return false;
    _sPos.copy(s.position);
    _sBi.copy(s.binormal);
    _sUp.copy(s.normal);
    return true;
  }

  private reg<T extends THREE.BufferGeometry>(g: T): T { this.geoms.push(g); return g; }
  private regM<T extends THREE.Material>(m: T): T { this.mats.push(m); return m; }
  private regT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t; }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * Resolve a hint's authored `lateral` / `span` / `speed` into a sweep centred
   * off the racing line, moving at a fixed cross-track speed.
   *
   * `amp` shrinks so that `|centre| - amp >= MOVER_MIN_CLEAR`: the inner end of
   * the sweep stops short of the line rather than the whole sweep being pushed
   * outboard, which keeps the hazard visible in the player's path.
   *
   * Authored `speed` is now a *trim* in [0.25, 1.25]x, never the rate itself.
   */
  private resolveMotion(h: HazardHint): { centre: number; amp: number; omega: number } {
    const lat = h.lateral ?? 0;
    const scale = 0.25 + clamp01(((h.speed ?? MOVER_SPEED_REF) / MOVER_SPEED_REF) * 0.75);

    const cross = MOVER_SPEED[h.kind];
    if (cross !== undefined) {
      const span = Math.max(2, h.span ?? 12);
      const side = lat === 0 ? 1 : Math.sign(lat);
      // A mover authored on the line is nudged out rather than silently centred.
      const centre = Math.abs(lat) < MOVER_MIN_CLEAR + 1
        ? side * (MOVER_MIN_CLEAR + span * 0.25)
        : lat;
      const amp = Math.max(0.8, Math.min(span * 0.5, Math.abs(centre) - MOVER_MIN_CLEAR));
      // omega = v / amp, so peak cross-track speed is `cross * scale` whatever the span.
      return { centre, amp, omega: (cross * scale) / amp };
    }

    const period = CYCLE_PERIOD[h.kind];
    if (period !== undefined) {
      return { centre: lat, amp: 0, omega: (Math.PI * 2 * scale) / period };
    }
    return { centre: lat, amp: 0, omega: 0 };
  }

  private build(h: HazardHint): void {
    if (this.spanTaken(h.distance, h.kind)) return;
    if (!this.sample(h.distance)) return;
    let node: THREE.Object3D;
    let partA: THREE.Object3D | null = null;
    let partB: THREE.Object3D | null = null;
    let radius = 1.5;
    let height = 1.6;
    let stun = 1.2;
    let kick = 0.8;
    let stunKind = 'spin';

    switch (h.kind) {
      case 'oil': {
        node = this.makeOil();
        radius = 2.7; height = 0.9; stun = 0.85; kick = 0; stunKind = 'spin';
        break;
      }
      case 'boulder': {
        node = this.makeBoulder();
        // Stun and kick both down: the boulder is the heaviest object on the
        // track and a 1.55 s flip plus a 1.5 kick was most of a lost position
        // from one glancing contact.
        radius = 1.7; height = 2.0; stun = 1.15; kick = 1.0; stunKind = 'flip';
        break;
      }
      case 'fireball': {
        const g = this.makeFireball();
        node = g.node; partA = g.glow;
        radius = 1.05; height = 1.4; stun = 1.1; kick = 0.9; stunKind = 'flip';
        break;
      }
      case 'slider': {
        node = this.makeSlider();
        radius = 1.9; height = 1.6; stun = 1.05; kick = 0.9; stunKind = 'spin';
        break;
      }
      case 'snapper': {
        const g = this.makeSnapper();
        node = g.node; partA = g.upper; partB = g.lower;
        radius = 1.5; height = 1.8; stun = 1.2; kick = 1.0; stunKind = 'flip';
        break;
      }
    }

    const sweep = this.resolveMotion(h);
    this.group.add(node);
    this.list.push({
      kind: h.kind, node, partA, partB,
      dist: h.distance,
      lateral: sweep.centre,
      span: h.span ?? 12,
      speed: h.speed ?? MOVER_SPEED_REF,
      centre: sweep.centre,
      amp: sweep.amp,
      omega: sweep.omega,
      phase: this.rng.next() * Math.PI * 2,
      radius, height,
      pos: new THREE.Vector3().copy(_sPos),
      up: new THREE.Vector3().copy(_sUp),
      t: 0, cool: 0, stun, kick, stunKind, anim: 0,
    });
  }

  private makeOil(): THREE.Object3D {
    const SZ = 512;
    const ctx = make2d(SZ);
    ctx.clearRect(0, 0, SZ, SZ);
    // Irregular slick: several overlapping blobs, iridescent film on top.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = SZ * (0.20 + Math.random() * 0.12);
      const cx = SZ / 2 + Math.cos(a) * SZ * 0.13;
      const cy = SZ / 2 + Math.sin(a) * SZ * 0.13;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(10,10,14,0.95)');
      g.addColorStop(0.7, 'rgba(14,14,20,0.75)');
      g.addColorStop(1, 'rgba(16,16,24,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = SZ * (0.10 + Math.random() * 0.16);
      const cx = SZ / 2 + Math.cos(a) * SZ * 0.15;
      const cy = SZ / 2 + Math.sin(a) * SZ * 0.15;
      const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      g.addColorStop(0, 'rgba(90,40,140,0.28)');
      g.addColorStop(0.45, 'rgba(30,120,140,0.22)');
      g.addColorStop(0.8, 'rgba(150,110,30,0.16)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    const map = this.regT(canvasTexture(ctx));
    map.wrapS = THREE.ClampToEdgeWrapping;

    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      map,
      transparent: true,
      roughness: 0.07,
      metalness: 0.25,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      iridescence: 1.0,
      iridescenceIOR: 1.5,
      iridescenceThicknessRange: [180, 900],
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      side: THREE.DoubleSide,
    }));
    const mesh = new THREE.Mesh(this.reg(new THREE.CircleGeometry(3.1, 40)), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 20;
    return mesh;
  }

  private makeBoulder(): THREE.Object3D {
    const geo = this.reg(new THREE.IcosahedronGeometry(1.55, 3));
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = fbm(v.x * 0.9 + 5, v.y * 0.9 + v.z * 0.4, 4);
      v.multiplyScalar(0.86 + n * 0.30);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const albedo = this.regT(pixelTexture(512, (u, vv, o) => {
      const base = new THREE.Color(0x6b6257);
      const n = fbm(u * 9, vv * 9, 5);
      const grit = ringNoise(u, vv, 26, 3);
      base.lerp(new THREE.Color(0x3a352f), n * 0.75);
      base.lerp(new THREE.Color(0x9c9184), Math.pow(clamp01(grit - 0.45) * 2, 1.6) * 0.5);
      base.offsetHSL(0, 0, (grit - 0.5) * 0.05);
      o.r = Math.round(clamp01(base.r) * 255);
      o.g = Math.round(clamp01(base.g) * 255);
      o.b = Math.round(clamp01(base.b) * 255);
    }));
    const nrm = this.regT(normalFromHeight(256, (u, vv) =>
      fbm(u * 12, vv * 12, 5) * 0.6 + ringNoise(u, vv, 30, 3) * 0.4, 2.6));
    const mat = this.regM(new THREE.MeshStandardMaterial({
      map: albedo, normalMap: nrm, normalScale: new THREE.Vector2(1.4, 1.4),
      roughness: 0.92, metalness: 0.02, envMapIntensity: 0.85,
    }));
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  private makeFireball(): { node: THREE.Object3D; glow: THREE.Object3D } {
    const g = new THREE.Group();
    const core = new THREE.Mesh(
      this.reg(new THREE.IcosahedronGeometry(0.72, 3)),
      this.regM(new THREE.MeshStandardMaterial({
        color: 0xff8a20,
        emissive: new THREE.Color(0xff5a08),
        emissiveIntensity: 4.2,
        roughness: 0.6,
        metalness: 0,
      })),
    );
    g.add(core);
    const glowTex = this.regT((() => {
      const ctx = make2d(128);
      const rg = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      rg.addColorStop(0, 'rgba(255,240,190,1)');
      rg.addColorStop(0.35, 'rgba(255,150,40,0.55)');
      rg.addColorStop(1, 'rgba(200,60,0,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, 128, 128);
      return canvasTexture(ctx);
    })());
    const glow = new THREE.Sprite(this.regM(new THREE.SpriteMaterial({
      map: glowTex, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, opacity: 0.9, color: 0xffffff,
    })));
    glow.scale.setScalar(3.2);
    g.add(glow);
    return { node: g, glow };
  }

  private makeSlider(): THREE.Object3D {
    const albedo = this.regT(pixelTexture(256, (u, v, o) => {
      const plate = (Math.floor(u * 4) + Math.floor(v * 4)) % 2 === 0 ? 1 : 0;
      const c = new THREE.Color(0x9aa4b4).offsetHSL(0, 0, plate * 0.05 - 0.02);
      const n = ringNoise(u, v, 18, 3);
      c.offsetHSL(0, 0, (n - 0.5) * 0.06);
      // Hazard stripes along the leading faces.
      const s = ((u * 6 + v * 6) % 1);
      if (s < 0.5) c.lerp(new THREE.Color(0xf2b21c), 0.55);
      else c.lerp(new THREE.Color(0x22262e), 0.35);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const nrm = this.regT(normalFromHeight(256, (u, v) =>
      0.5 + (((Math.floor(u * 4) + Math.floor(v * 4)) % 2 === 0) ? 0.06 : 0)
      + ringNoise(u, v, 22, 3) * 0.06, 2.0));
    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      map: albedo, normalMap: nrm, roughness: 0.38, metalness: 0.72,
      clearcoat: 0.4, envMapIntensity: 1.1,
    }));
    const geo = this.reg(new THREE.BoxGeometry(3.0, 1.9, 1.9, 2, 2, 2));
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  }

  private makeSnapper(): { node: THREE.Object3D; upper: THREE.Object3D; lower: THREE.Object3D } {
    const g = new THREE.Group();
    // Stem
    const stemMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0x2f8f3a, roughness: 0.6, metalness: 0.0,
    }));
    const stem = new THREE.Mesh(this.reg(new THREE.CylinderGeometry(0.16, 0.26, 1.1, 12)), stemMat);
    stem.position.y = -0.55;
    g.add(stem);

    const headMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xf24a3a, roughness: 0.35, metalness: 0.0,
      clearcoat: 0.9, clearcoatRoughness: 0.15,
      sheen: 0.6, sheenColor: new THREE.Color(0xff9a86),
    }));
    const mouthMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0x5c1418, roughness: 0.55, side: THREE.DoubleSide,
    }));
    const toothMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xfffaf0, roughness: 0.18, clearcoat: 1.0,
    }));

    const jaw = (sign: number): THREE.Group => {
      const j = new THREE.Group();
      const shell = new THREE.Mesh(
        this.reg(new THREE.SphereGeometry(0.68, 26, 18, 0, Math.PI * 2, 0, Math.PI * 0.5)),
        headMat,
      );
      if (sign < 0) shell.rotation.x = Math.PI;
      j.add(shell);
      const inner = new THREE.Mesh(this.reg(new THREE.CircleGeometry(0.66, 26)), mouthMat);
      inner.rotation.x = -Math.PI / 2 * sign;
      j.add(inner);
      // Teeth around the rim.
      const toothGeo = this.reg(new THREE.ConeGeometry(0.09, 0.24, 8));
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const t = new THREE.Mesh(toothGeo, toothMat);
        t.position.set(Math.cos(a) * 0.58, sign * 0.05, Math.sin(a) * 0.58);
        t.rotation.x = sign > 0 ? Math.PI : 0;
        j.add(t);
      }
      return j;
    };
    const upper = jaw(1);
    const lower = jaw(-1);
    g.add(upper, lower);
    g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
    return { node: g, upper, lower };
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (!this.enabled) return;
    for (let i = 0; i < this.list.length; i++) {
      const h = this.list[i];
      h.t += dt;
      if (h.cool > 0) h.cool -= dt;

      switch (h.kind) {
        case 'oil':
          if (!this.sample(h.dist)) break;
          h.pos.copy(_sPos).addScaledVector(_sBi, h.lateral).addScaledVector(_sUp, 0.03);
          h.up.copy(_sUp);
          break;

        case 'boulder': {
          if (!this.sample(h.dist)) break;
          // Rolls back and forth across ITS OWN lane, not across the racing line.
          const across = h.centre + Math.sin(h.t * h.omega + h.phase) * h.amp;
          h.pos.copy(_sPos).addScaledVector(_sBi, across).addScaledVector(_sUp, 1.55);
          h.up.copy(_sUp);
          h.lateral = across;
          break;
        }

        case 'fireball': {
          if (!this.sample(h.dist)) break;
          const k = Math.sin(h.t * h.omega + h.phase);
          // Lower arc as well as a slower one: 6 m put the fireball above the
          // camera's sightline on the way up, so it appeared out of nowhere.
          const rise = Math.max(0, k) * 4.2;
          h.anim = clamp01(Math.max(0, k));
          h.pos.copy(_sPos).addScaledVector(_sBi, h.lateral)
            .addScaledVector(_sUp, 0.4 + rise);
          h.up.copy(_sUp);
          break;
        }

        case 'slider': {
          if (!this.sample(h.dist)) break;
          const across = h.centre + Math.sin(h.t * h.omega + h.phase) * h.amp;
          h.pos.copy(_sPos).addScaledVector(_sBi, across).addScaledVector(_sUp, 0.95);
          h.up.copy(_sUp);
          h.lateral = across;
          break;
        }

        case 'snapper': {
          if (!this.sample(h.dist)) break;
          // Anchored at the roadside; lunges toward the racing line when it bites.
          const lunge = Math.pow(Math.max(0, Math.sin(h.t * h.omega + h.phase)), 3);
          const side = h.centre >= 0 ? 1 : -1;
          const anchor = side * Math.max(6.0, Math.abs(h.centre) + 3.0);
          // Reach cut 5.5 -> 4.0 m so the bite stops short of the racing line.
          const reach = lerp(anchor, anchor - side * 4.0, lunge);
          h.anim = lunge;
          h.pos.copy(_sPos).addScaledVector(_sBi, reach).addScaledVector(_sUp, 1.15);
          h.up.copy(_sUp);
          h.lateral = reach;
          // Only dangerous while lunging with the jaws open-then-shut.
          h.radius = 1.2 + lunge * 0.7;
          break;
        }
      }

      this.contact(h);
    }
  }

  private contact(h: Hazard): void {
    if (h.cool > 0) return;
    const list = this.karts.karts;
    const r = h.radius + KART_RADIUS;
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) {
      const k: KartState = list[i];
      // `invulnerable` covers the respawn drop-in, Star (belt and braces — see
      // `starTime` below) AND the post-hit forgiveness window granted by
      // `applyStunTo`. This one line is what stops a hazard re-hitting a kart
      // that is still spinning out from the last contact.
      if (k.finished || k.stunned || k.invulnerable || k.starTime > 0) continue;
      const dx = k.position.x - h.pos.x;
      const dy = k.position.y - h.pos.y;
      const dz = k.position.z - h.pos.z;
      if (Math.abs(dy) > h.height + 1.0) continue;
      if (dx * dx + dz * dz > r2) continue;
      // An oil slick only spins you if you're actually moving.
      if (h.kind === 'oil' && Math.abs(k.speed) < 5) continue;

      this.physics.applyStun?.(k.id, h.stun, h.stunKind);
      if (h.kick > 0) {
        _b.set(dx, 0, dz);
        if (_b.lengthSq() < 1e-4) _b.set(0, 0, 1);
        _b.normalize().multiplyScalar(h.kick * 130);
        _b.y = h.kick * 55;
        this.physics.applyImpulse?.(k.id, _b);
      }
      this.vfx.burst?.(h.kind === 'fireball' ? 'explosion' : 'impact', h.pos, h.up, 1.0);
      if (this.karts.player && this.karts.player.id === k.id) {
        this.vfx.screenShake?.(0.5, 0.25);
        bus.emit('ui:message', { text: 'OUCH!', seconds: 0.9, style: 'hazard' });
      }
      // Was 0.9 s, i.e. SHORTER than the 1.55 s stun it had just applied — so
      // the same hazard re-armed while the kart was still spinning and refreshed
      // the stun to full. Now the hazard cannot fire again until the victim has
      // had its stun plus the forgiveness window back.
      h.cool = h.stun + HAZARD_RECOVERY;
      break;
    }
  }

  // -------------------------------------------------------------------------

  update(dt: number, elapsed: number): void {
    if (!this.enabled) return;
    for (let i = 0; i < this.list.length; i++) {
      const h = this.list[i];
      h.node.position.copy(h.pos);
      switch (h.kind) {
        case 'oil':
          _q.setFromUnitVectors(_up, h.up);
          h.node.quaternion.copy(_q);
          h.node.rotateY(h.phase);
          break;
        case 'boulder': {
          // Roll about the axis perpendicular to travel, at v/r so the surface
          // speed matches the travel — a boulder that slides instead of rolling
          // is the single most obvious tell that a hazard is on rails.
          _n.copy(_sBi).cross(h.up).normalize();
          const vel = h.amp * h.omega * Math.cos(h.t * h.omega + h.phase);
          h.node.rotateOnWorldAxis(_n.lengthSq() > 0.1 ? _n : _up, (vel / 1.55) * dt);
          break;
        }
        case 'fireball': {
          h.node.rotation.y += dt * 3.2;
          h.node.rotation.x += dt * 1.7;
          const pulse = 0.85 + Math.sin(elapsed * 11 + h.phase) * 0.15;
          h.node.scale.setScalar(pulse);
          if (h.partA) h.partA.scale.setScalar(3.0 * pulse + Math.sin(elapsed * 17) * 0.25);
          break;
        }
        case 'slider':
          _q.setFromUnitVectors(_up, h.up);
          h.node.quaternion.copy(_q);
          h.node.rotateY(Math.sin(elapsed * 0.7 + h.phase) * 0.06);
          break;
        case 'snapper': {
          // `anim` is the lunge value the collision test used this step, so the
          // jaws and the hit radius can never disagree.
          const gape = smoothstep(clamp01(h.anim * 1.4)) * 0.62;
          if (h.partA) h.partA.rotation.x = -gape;
          if (h.partB) h.partB.rotation.x = gape * 0.55;
          _q.setFromUnitVectors(_up, h.up);
          h.node.quaternion.copy(_q);
          h.node.rotateY(Math.sin(elapsed * 1.3 + h.phase) * 0.25);
          break;
        }
      }
    }
  }

  get count(): number { return this.list.length; }
  countOf(kind: HazardKind): number {
    let n = 0;
    for (const h of this.list) if (h.kind === kind) n++;
    return n;
  }
  /** World position of hazard `i` — used by AI avoidance. */
  positionOf(i: number): THREE.Vector3 | null { return this.list[i]?.pos ?? null; }
  kindOf(i: number): HazardKind | null { return this.list[i]?.kind ?? null; }
  radiusOf(i: number): number { return this.list[i]?.radius ?? 0; }
  /** Arc length along the lap, metres. */
  distanceOf(i: number): number { return this.list[i]?.dist ?? 0; }
  /** Current lateral offset from the centreline, metres (+ = driver's right). */
  lateralOf(i: number): number { return this.list[i]?.lateral ?? 0; }
  /**
   * Resolved sweep of hazard `i`: centre and half-travel in metres, rate in
   * rad/s. Peak cross-track speed is `amp * omega`. Exposed so a probe can
   * assert the speed cap instead of trusting the constants.
   */
  sweepOf(i: number): { centre: number; amp: number; omega: number } {
    const h = this.list[i];
    return h ? { centre: h.centre, amp: h.amp, omega: h.omega } : { centre: 0, amp: 0, omega: 0 };
  }
  /** Seconds before this hazard may hit anyone again. */
  cooldownOf(i: number): number { return this.list[i]?.cool ?? 0; }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.group.visible = v;
  }

  /**
   * Put every hazard back to its start-of-race phase without rebuilding it.
   *
   * Called from `ItemSystem.reset()`. Without it a restart inherits whatever
   * sweep phase and cooldown the previous race ended on, so "retry" is not the
   * same race twice — the boulder is somewhere else on the grid each time.
   */
  resetTimers(): void {
    for (const h of this.list) {
      h.t = 0;
      h.cool = 0;
      h.anim = 0;
      h.lateral = h.centre;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.clear();
  }
}
