/**
 * ============================================================================
 *  APEX KART — PROJECTILES
 * ============================================================================
 *  Every thrown / dropped item lives here. All motion runs in fixedUpdate at
 *  120 Hz; update() only writes transforms and animates cosmetics.
 *
 *  Behavioural notes that matter for feel:
 *
 *  - GREEN SHELL reflects off walls with a true mirror bounce and rides the
 *    terrain normal, so it hugs banking instead of flying off.
 *  - RED SHELL homes *along the track spline*, not straight at the target.
 *    A pure seek vector leaves the road on any real corner; MK8 steers the
 *    shell down the centreline and converges laterally as the gap closes.
 *    It also gains speed against faster targets so it always closes.
 *  - BLUE SHELL is a three-act performance: climb + wind along the track to
 *    1st, hover with a growing spin, then slam down into a big blast.
 *  - BANANA settles with a real bounce and then persists until something
 *    touches it. BOMB arcs, bounces, and detonates on contact or fuse-out.
 *
 *  Everything is pooled. After init() the only allocations are `console`
 *  strings in the debug readout.
 * ============================================================================
 */

import * as THREE from 'three';
import type { GroundHit, KartState, TrackSample, WallHit, IVfxService } from '@/core/Types';
import { ItemType } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { WORLD } from '@/core/Config';
import { clamp, clamp01, damp, lerp, smoothstep, wrap } from '@/core/MathUtils';
import { canvasTexture, make2d, PART, type ItemModels } from './ItemModels';

// ---------------------------------------------------------------------------
// Structural views of the services we are handed.
//
// The track / kart / physics / vfx modules are authored by other agents in
// parallel, so we depend on the *shape* of what we use and nothing more.
// Every method is optional and feature-detected: a missing method degrades a
// behaviour, it never throws. Declared with method syntax on purpose so the
// concrete classes stay assignable even if their literal types are narrower.
// ---------------------------------------------------------------------------

export interface TrackLike {
  readonly lapLength?: number;
  sampleAt?(t: number): TrackSample;
  sampleAtDistance?(d: number): TrackSample;
  project?(position: THREE.Vector3): TrackSample;
  raycastGround?(origin: THREE.Vector3, up: THREE.Vector3, maxDist: number): GroundHit;
  collideWalls?(position: THREE.Vector3, radius: number): WallHit;
  racingLineAt?(t: number, lookahead: number): THREE.Vector3;
  getItemBoxSpawns?(): unknown;
}

export interface KartsLike {
  readonly karts: readonly KartState[];
  player?: KartState | null;
  getSocket?(kartId: number, name: string): THREE.Object3D | null | undefined;
}

export interface PhysicsLike {
  applyBoost?(kartId: number, seconds: number, strength: number, source: string): void;
  applyStun?(kartId: number, seconds: number, kind: string): void;
  applyImpulse?(kartId: number, impulse: THREE.Vector3): void;
  /** Optional: lets Bullet Bill drive the kart. Degrades to boost-only. */
  setAutopilot?(kartId: number, target: THREE.Vector3 | null, speed: number): void;
  /** Optional: lightning shrink. Degrades to a visual-only shrink. */
  setScale?(kartId: number, scale: number): void;
  // `setCoinBonus?(kartId, coins)` used to be declared here for a coin-driven
  // top-speed bonus. Coins are removed, and `PhysicsWorld` never implemented it
  // in the first place, so the hook is gone rather than left as a promise the
  // physics layer was never going to keep.
}

export type VfxLike = Partial<IVfxService>;

export interface ProjectileHooks {
  /** Star / ghost / already-spinning karts shrug items off. */
  isImmune(kartId: number): boolean;
  /** Central place for audio, HUD callouts and item-drop-on-hit. */
  onHit(targetId: number, sourceId: number, item: ItemType, point: THREE.Vector3): void;
  /** A shell / bomb was destroyed without hitting anybody. */
  onExpire?(id: number): void;
}

// ---------------------------------------------------------------------------

export type ProjKind = 'green' | 'red' | 'blue' | 'banana' | 'bomb';

export const PROJ_SPEED = {
  green: 34,
  redBase: 36,
  redMax: 48,
  blueTravel: 56,
} as const;

const POOL_SIZE: Record<ProjKind, number> = {
  green: 14, red: 12, blue: 2, banana: 22, bomb: 8,
};

const LIFE: Record<ProjKind, number> = {
  green: 9.0, red: 12.0, blue: 6.5, banana: 60.0, bomb: 3.0,
};

const RADIUS: Record<ProjKind, number> = {
  // P0d-D5: the Plastic Bottle is explicitly a *small* obstacle, so its contact
  // radius drops from the banana's 0.46 to 0.34 — a 24 cm narrower hit box on
  // each side, which is the difference between clipping it and threading past.
  green: 0.52, red: 0.52, blue: 0.62, banana: 0.34, bomb: 0.40,
};

/**
 * Height of a settled Plastic Bottle's centre above the road, metres.
 *
 * The model lies on its side with its origin on its own axis, so this is just
 * the bottle's radius. It used to be derived as `radius * 0.42` from the contact
 * radius, which coupled the hit box to the visual seating for no reason — and
 * would have floated the bottle 5 cm off the tarmac after the radius change.
 */
const BOTTLE_REST = 0.145;

const KART_RADIUS = 1.05;
const MAX_WALL_BOUNCES = 5;
const GROUND_PROBE = 6.0;
const EXPLOSIONS = 10;

/** Sub-states. */
const enum S {
  Fly = 0,
  Settled = 1,
  BlueClimb = 2,
  BlueHover = 3,
  BlueSlam = 4,
}

export interface Projectile {
  active: boolean;
  id: number;
  kind: ProjKind;
  item: ItemType;
  owner: number;
  /** Owner immunity window so you don't shoot yourself in the back. */
  ownerGrace: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  up: THREE.Vector3;
  life: number;
  age: number;
  bounces: number;
  radius: number;
  /** Visual spin accumulator. */
  spin: number;
  spinRate: number;
  state: S;
  stateTime: number;
  /** Homing. */
  target: number;
  lateral: number;
  trackDist: number;
  /** Held-behind shield mode: position is driven by ItemSystem, no motion. */
  held: boolean;
  node: THREE.Object3D;
  /** Resolved once at pool build time — the bob-omb's fuse spark, if any. */
  spark: THREE.Sprite | null;
}

interface Explosion {
  t: number;
  dur: number;
  scale: number;
  pos: THREE.Vector3;
  core: THREE.Sprite;
  ring: THREE.Mesh;
}

// --- module scratch --------------------------------------------------------
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
/** Project-wide forward axis (AGENTS §2) — the rocket's nose points down this. */
const _negZ = new THREE.Vector3(0, 0, -1);
const _samplePos = new THREE.Vector3();
const _sampleBi = new THREE.Vector3();
const _sampleUp = new THREE.Vector3();

export interface ThreatInfo { item: ItemType; distance: number }

export class Projectiles {
  private scene: THREE.Scene;
  private models: ItemModels;
  private track: TrackLike;
  private karts: KartsLike;
  private physics: PhysicsLike;
  private vfx: VfxLike;
  private hooks: ProjectileHooks;

  private group = new THREE.Group();
  private pools = new Map<ProjKind, Projectile[]>();
  private all: Projectile[] = [];
  private nextId = 1;

  private explosions: Explosion[] = [];
  private expCursor = 0;

  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private texs: THREE.Texture[] = [];

  /** Per-kart threat cache, refreshed every fixed step. */
  private threatItem: Int8Array = new Int8Array(0);
  private threatDist: Float32Array = new Float32Array(0);
  private threatOut: ThreatInfo = { item: ItemType.GreenShell, distance: 0 };

  constructor(
    scene: THREE.Scene,
    models: ItemModels,
    track: TrackLike,
    karts: KartsLike,
    physics: PhysicsLike,
    vfx: VfxLike,
    hooks: ProjectileHooks,
  ) {
    this.scene = scene;
    this.models = models;
    this.track = track;
    this.karts = karts;
    this.physics = physics;
    this.vfx = vfx;
    this.hooks = hooks;
  }

  // -------------------------------------------------------------------------

  init(): void {
    this.group.name = 'Projectiles';
    this.scene.add(this.group);

    const modelFor: Record<ProjKind, ItemType> = {
      green: ItemType.GreenShell,
      red: ItemType.RedShell,
      blue: ItemType.BlueShell,
      banana: ItemType.Banana,
      bomb: ItemType.Bomb,
    };

    for (const kind of Object.keys(POOL_SIZE) as ProjKind[]) {
      const arr: Projectile[] = [];
      for (let i = 0; i < POOL_SIZE[kind]; i++) {
        const node = this.models.createForItem(modelFor[kind]);
        node.visible = false;
        node.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          // Additive parts are LIGHT, not matter. Blanket `castShadow = true`
          // would have the Rocket's exhaust plume cast a solid black cone across
          // the road behind it — the depth pass does not care that the material
          // is additive and unlit.
          const mat = Array.isArray(m.material) ? m.material[0] : m.material;
          const additive = !!mat && mat.blending === THREE.AdditiveBlending;
          m.castShadow = !additive;
          m.receiveShadow = false;
        });
        this.group.add(node);
        const spark = node.getObjectByName(PART.fuseSpark);
        arr.push({
          active: false, id: 0, kind, item: modelFor[kind], owner: -1, ownerGrace: 0,
          pos: new THREE.Vector3(), vel: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
          life: 0, age: 0, bounces: 0, radius: RADIUS[kind], spin: 0, spinRate: 0,
          state: S.Fly, stateTime: 0, target: -1, lateral: 0, trackDist: 0,
          held: false, node,
          spark: spark instanceof THREE.Sprite ? spark : null,
        });
      }
      this.pools.set(kind, arr);
      for (const p of arr) this.all.push(p);
    }

    this.buildExplosions();
    const n = Math.max(16, this.karts.karts.length);
    this.threatItem = new Int8Array(n).fill(-1);
    this.threatDist = new Float32Array(n);
  }

  private buildExplosions(): void {
    const glow = this.models.glowTexture;
    // Soft shockwave ring.
    const ctx = make2d(256);
    const g = ctx.createRadialGradient(128, 128, 60, 128, 128, 128);
    g.addColorStop(0.00, 'rgba(255,255,255,0)');
    g.addColorStop(0.62, 'rgba(255,238,180,0.10)');
    g.addColorStop(0.84, 'rgba(255,248,220,0.95)');
    g.addColorStop(0.95, 'rgba(255,190,90,0.35)');
    g.addColorStop(1.00, 'rgba(255,160,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const ringTex = canvasTexture(ctx);
    this.texs.push(ringTex);

    const ringGeo = new THREE.PlaneGeometry(1, 1);
    this.geoms.push(ringGeo);

    for (let i = 0; i < EXPLOSIONS; i++) {
      const coreMat = new THREE.SpriteMaterial({
        map: glow ?? undefined,
        color: 0xffd070,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      this.mats.push(coreMat);
      const core = new THREE.Sprite(coreMat);
      core.visible = false;
      core.renderOrder = 320;
      this.group.add(core);

      const ringMat = new THREE.MeshBasicMaterial({
        map: ringTex,
        color: 0xffffff,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 0,
      });
      this.mats.push(ringMat);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      ring.renderOrder = 318;
      this.group.add(ring);

      this.explosions.push({ t: 0, dur: 0, scale: 1, pos: new THREE.Vector3(), core, ring });
    }
  }

  // -------------------------------------------------------------------------
  // Track helpers (all feature-detected)
  // -------------------------------------------------------------------------

  private get lapLength(): number {
    const l = this.track.lapLength;
    return typeof l === 'number' && l > 1 ? l : 1000;
  }

  /** Copies the sample into module scratch so we never hold a shared object. */
  private projectTo(p: THREE.Vector3): { distance: number; halfWidth: number } | null {
    if (typeof this.track.project !== 'function') return null;
    const s = this.track.project(p);
    if (!s) return null;
    _samplePos.copy(s.position);
    _sampleBi.copy(s.binormal);
    _sampleUp.copy(s.normal);
    return { distance: s.distance, halfWidth: s.halfWidth };
  }

  private sampleDist(d: number): boolean {
    if (typeof this.track.sampleAtDistance !== 'function') return false;
    const s = this.track.sampleAtDistance(wrap(d, this.lapLength));
    if (!s) return false;
    _samplePos.copy(s.position);
    _sampleBi.copy(s.binormal);
    _sampleUp.copy(s.normal);
    return true;
  }

  private ground(p: THREE.Vector3, up: THREE.Vector3): { y: number; nx: number; ny: number; nz: number } | null {
    if (typeof this.track.raycastGround !== 'function') return null;
    _a.copy(p).addScaledVector(up, 2.5);
    const h = this.track.raycastGround(_a, up, GROUND_PROBE);
    if (!h || !h.hit) return null;
    return { y: h.point.y, nx: h.normal.x, ny: h.normal.y, nz: h.normal.z };
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private alloc(kind: ProjKind): Projectile | null {
    const pool = this.pools.get(kind);
    if (!pool) return null;
    for (const p of pool) if (!p.active) return p;
    // Pool exhausted: recycle the oldest so a race never runs out.
    let oldest = pool[0];
    for (const p of pool) if (p.age > oldest.age) oldest = p;
    this.retire(oldest, false);
    return oldest;
  }

  /**
   * Launch a projectile.
   * `forward` must be the owner's facing; `ownerVel` lets shells inherit speed.
   */
  spawn(
    kind: ProjKind,
    item: ItemType,
    ownerId: number,
    origin: THREE.Vector3,
    forward: THREE.Vector3,
    ownerVel: THREE.Vector3 | null,
    backwards: boolean,
    up?: THREE.Vector3,
  ): Projectile | null {
    const p = this.alloc(kind);
    if (!p) return null;

    p.active = true;
    p.id = this.nextId++;
    p.item = item;
    p.owner = ownerId;
    p.ownerGrace = kind === 'banana' || kind === 'bomb' ? 0.85 : 0.32;
    p.life = LIFE[kind];
    p.age = 0;
    p.bounces = 0;
    p.spin = Math.random() * 6.28;
    p.state = kind === 'blue' ? S.BlueClimb : S.Fly;
    p.stateTime = 0;
    p.target = -1;
    p.lateral = 0;
    p.held = false;
    p.up.copy(up ?? _up).normalize();
    p.node.visible = true;
    p.node.scale.setScalar(1);

    const sgn = backwards ? -1 : 1;
    _dir.copy(forward).normalize();
    const fwdSpeed = ownerVel ? Math.max(0, ownerVel.dot(_dir)) : 0;

    switch (kind) {
      case 'green':
      case 'red': {
        p.pos.copy(origin).addScaledVector(_dir, sgn * 1.5).addScaledVector(p.up, 0.15);
        const base = kind === 'green' ? PROJ_SPEED.green : PROJ_SPEED.redBase;
        p.vel.copy(_dir).multiplyScalar(sgn * (base + (backwards ? 0 : fwdSpeed * 0.25)));
        p.spinRate = 15;
        if (kind === 'red') p.target = this.pickTargetAhead(ownerId);
        break;
      }
      case 'blue': {
        p.pos.copy(origin).addScaledVector(p.up, 1.2);
        p.vel.copy(_dir).multiplyScalar(14).addScaledVector(p.up, 16);
        p.spinRate = 4;
        p.target = this.leaderId(ownerId);
        break;
      }
      case 'banana': {
        p.pos.copy(origin).addScaledVector(_dir, sgn * 1.9).addScaledVector(p.up, 0.55);
        if (backwards) {
          // Trickles out behind and bounces once before settling.
          p.vel.copy(_dir).multiplyScalar(-Math.max(1.5, fwdSpeed * 0.18)).addScaledVector(p.up, 2.4);
        } else {
          p.vel.copy(_dir).multiplyScalar(11 + fwdSpeed * 0.35).addScaledVector(p.up, 5.5);
        }
        p.spinRate = backwards ? 3.5 : 9;
        break;
      }
      case 'bomb': {
        p.pos.copy(origin).addScaledVector(_dir, sgn * 1.8).addScaledVector(p.up, 0.85);
        if (backwards) {
          p.vel.copy(_dir).multiplyScalar(-4).addScaledVector(p.up, 3.0);
        } else {
          p.vel.copy(_dir).multiplyScalar(15 + fwdSpeed * 0.4).addScaledVector(p.up, 8.0);
        }
        p.spinRate = 6;
        break;
      }
    }

    const t = this.projectTo(p.pos);
    if (t) {
      p.trackDist = t.distance;
      p.lateral = _a.copy(p.pos).sub(_samplePos).dot(_sampleBi);
    }
    p.node.position.copy(p.pos);
    return p;
  }

  /** Drop a banana / bomb that is already fully settled (dev + AI helper). */
  place(kind: 'banana' | 'bomb', ownerId: number, at: THREE.Vector3): Projectile | null {
    const p = this.spawn(kind, kind === 'banana' ? ItemType.Banana : ItemType.Bomb,
      ownerId, at, _up, null, true);
    if (p && kind === 'banana') { p.state = S.Settled; p.vel.set(0, 0, 0); }
    return p;
  }

  // -------------------------------------------------------------------------

  private kartById(id: number): KartState | null {
    const list = this.karts.karts;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /** Nearest kart ahead of `ownerId` by race progress. */
  pickTargetAhead(ownerId: number): number {
    const list = this.karts.karts;
    const me = this.kartById(ownerId);
    if (!me) return -1;
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k.id === ownerId || k.finished) continue;
      const gap = k.progress - me.progress;
      if (gap <= 0) continue;
      if (gap < bestGap) { bestGap = gap; best = k.id; }
    }
    // Nobody ahead by progress? fall back to the closest kart in front of us.
    if (best === -1) {
      let bestD = Infinity;
      for (let i = 0; i < list.length; i++) {
        const k = list[i];
        if (k.id === ownerId || k.finished) continue;
        const d = k.position.distanceToSquared(me.position);
        if (d < bestD) { bestD = d; best = k.id; }
      }
    }
    return best;
  }

  leaderId(exclude = -1): number {
    const list = this.karts.karts;
    let best = -1;
    let bestP = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k.id === exclude) continue;
      if (k.progress > bestP) { bestP = k.progress; best = k.id; }
    }
    if (best === -1 && list.length > 0) best = list[0].id;
    return best;
  }

  // -------------------------------------------------------------------------
  // Fixed step
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    for (let i = 0; i < this.all.length; i++) {
      const p = this.all[i];
      if (!p.active) continue;
      p.age += dt;
      p.ownerGrace = Math.max(0, p.ownerGrace - dt);
      p.stateTime += dt;
      p.spin += p.spinRate * dt;
      if (p.held) continue;

      p.life -= dt;
      if (p.life <= 0) { this.expire(p); continue; }

      switch (p.kind) {
        case 'green': this.stepShellStraight(p, dt); break;
        case 'red': this.stepRedShell(p, dt); break;
        case 'blue': this.stepBlueShell(p, dt); break;
        case 'banana': this.stepBanana(p, dt); break;
        case 'bomb': this.stepBomb(p, dt); break;
      }
      if (!p.active) continue;

      if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.pos.y) || !Number.isFinite(p.pos.z)) {
        // Belt and braces: a NaN must never leak into the scene graph.
        this.retire(p, false);
        continue;
      }
      if (p.kind !== 'blue' && this.hitKarts(p)) continue;
    }

    this.projVsProj();
    this.buildThreats();
  }

  // --- green shell ---------------------------------------------------------

  private stepShellStraight(p: Projectile, dt: number): void {
    const speed = p.vel.length() || PROJ_SPEED.green;
    p.pos.addScaledVector(p.vel, dt);

    // Ride the terrain: snap height and re-project velocity into the surface.
    const g = this.ground(p.pos, p.up);
    if (g) {
      _n.set(g.nx, g.ny, g.nz).normalize();
      const want = g.y + p.radius * 0.86;
      p.pos.y = damp(p.pos.y, want, 0.018, dt);
      if (p.pos.y < want - 0.02) p.pos.y = want;
      const along = p.vel.dot(_n);
      p.vel.addScaledVector(_n, -along);
      if (p.vel.lengthSq() > 1e-6) p.vel.setLength(speed);
      p.up.copy(_n);
    } else {
      p.vel.y -= WORLD.gravity * 0.35 * dt;
    }

    this.wallBounce(p, true);
  }

  /** @returns true if the shell died on the wall. */
  private wallBounce(p: Projectile, reflect: boolean): boolean {
    if (typeof this.track.collideWalls !== 'function') return false;
    const w = this.track.collideWalls(p.pos, p.radius);
    if (!w || !w.hit) return false;
    _n.copy(w.normal);
    if (_n.lengthSq() < 1e-8) return false;
    _n.normalize();
    p.pos.addScaledVector(_n, (w.depth ?? 0) + 0.03);
    if (!reflect) {
      this.burst('shellBreak', p.pos, 0.8);
      this.retire(p, true);
      return true;
    }
    const d = p.vel.dot(_n);
    if (d < 0) {
      // Mirror reflection, keeping ~96 % of the speed so five bounces still
      // read as lively rather than sluggish.
      p.vel.addScaledVector(_n, -2 * d);
      p.vel.multiplyScalar(0.96);
      p.bounces++;
      p.spinRate = -p.spinRate;
      this.burst('sparks', p.pos, 0.5);
    }
    if (p.bounces > MAX_WALL_BOUNCES) {
      this.burst('shellBreak', p.pos, 0.9);
      this.retire(p, true);
      return true;
    }
    return false;
  }

  // --- red shell ----------------------------------------------------------

  private stepRedShell(p: Projectile, dt: number): void {
    const target = p.target >= 0 ? this.kartById(p.target) : null;
    const canSpline = typeof this.track.project === 'function'
      && typeof this.track.sampleAtDistance === 'function';

    if (!target || target.finished || !canSpline) {
      // No lock (or no spline service): behave like a green shell.
      this.stepShellStraight(p, dt);
      return;
    }

    const lap = this.lapLength;
    const own = this.projectTo(p.pos);
    if (!own) { this.stepShellStraight(p, dt); return; }
    const ownDist = own.distance;
    const ownLateral = _a.copy(p.pos).sub(_samplePos).dot(_sampleBi);

    const tp = this.projectTo(target.position);
    if (!tp) { this.stepShellStraight(p, dt); return; }
    const tgtDist = tp.distance;
    const tgtLateral = _a.copy(target.position).sub(_samplePos).dot(_sampleBi);

    let gap = wrap(tgtDist - ownDist, lap);
    if (gap > lap * 0.5) {
      // Target is behind us — the lock is stale, carry on straight.
      p.target = -1;
      this.stepShellStraight(p, dt);
      return;
    }

    // Catch-up: a shell that can't out-run a boosting kart is just annoying.
    const tSpeed = Math.abs(target.speed);
    const speed = lerp(PROJ_SPEED.redBase, PROJ_SPEED.redMax, clamp01((tSpeed - 16) / 16));

    // Aim a little way down the spline; tighten the look-ahead as we close so
    // the last metre is a direct strike rather than a lazy arc.
    const look = clamp(gap * 0.4, 2.0, 13.0);
    if (!this.sampleDist(ownDist + look)) { this.stepShellStraight(p, dt); return; }

    // Lateral convergence: hold our own line far out, slide onto theirs close up.
    const closeness = clamp01(1 - gap / 40);
    const latTarget = lerp(ownLateral, tgtLateral, Math.pow(closeness, 0.55));
    p.lateral = damp(p.lateral, latTarget, 0.16, dt);
    p.lateral = clamp(p.lateral, -own.halfWidth - 3, own.halfWidth + 3);

    _b.copy(_samplePos).addScaledVector(_sampleBi, p.lateral).addScaledVector(_sampleUp, 0.62);
    // Very close in: aim straight at the kart so we don't slide past it.
    if (gap < 6) _b.lerp(target.position, 1 - gap / 6);

    _dir.copy(_b).sub(p.pos);
    if (_dir.lengthSq() < 1e-6) _dir.copy(p.vel);
    _dir.normalize();

    _c.copy(p.vel);
    if (_c.lengthSq() < 1e-6) _c.copy(_dir);
    _c.normalize();
    // Limited turn rate -> a readable homing arc instead of a teleporting dot.
    const blend = 1 - Math.pow(2, -dt / 0.055);
    _c.lerp(_dir, blend).normalize();
    p.vel.copy(_c).multiplyScalar(speed);
    p.pos.addScaledVector(p.vel, dt);
    p.up.copy(_sampleUp);
    p.trackDist = ownDist;
    p.spinRate = 17;

    // A red shell that clips a wall dies — it never grinds along it.
    this.wallBounce(p, false);
  }

  // --- blue shell ---------------------------------------------------------

  private stepBlueShell(p: Projectile, dt: number): void {
    const lead = p.target >= 0 ? this.kartById(p.target) : null;
    if (!lead) { p.target = this.leaderId(); }
    const target = p.target >= 0 ? this.kartById(p.target) : null;
    p.spinRate = lerp(4, 26, clamp01(p.age / 3.2));

    if (!target) { this.detonateBlue(p); return; }

    const canSpline = typeof this.track.project === 'function'
      && typeof this.track.sampleAtDistance === 'function';

    if (p.state === S.BlueClimb) {
      const lap = this.lapLength;
      let gap = 40;
      if (canSpline) {
        const own = this.projectTo(p.pos);
        const tp = own ? this.projectTo(target.position) : null;
        if (own && tp) {
          gap = wrap(tp.distance - own.distance, lap);
          if (gap > lap * 0.5) gap = 4; // already past the leader
          const look = clamp(gap * 0.5, 6, 26);
          if (this.sampleDist(own.distance + look)) {
            // Winding path: a sine weave across the road, wider early on.
            const weave = Math.sin(p.age * 2.6) * lerp(7.5, 1.0, clamp01(p.age / 3.0));
            const alt = lerp(2.0, 15.0, smoothstep(clamp01(p.age / 1.1)));
            _b.copy(_samplePos).addScaledVector(_sampleBi, weave).addScaledVector(_sampleUp, alt);
            _dir.copy(_b).sub(p.pos);
            const dist = _dir.length();
            if (dist > 1e-4) _dir.divideScalar(dist);
            _c.copy(p.vel);
            if (_c.lengthSq() < 1e-6) _c.copy(_dir);
            _c.normalize().lerp(_dir, 1 - Math.pow(2, -dt / 0.10)).normalize();
            p.vel.copy(_c).multiplyScalar(PROJ_SPEED.blueTravel);
          }
        }
      } else {
        // No spline: fly a straight high arc at the leader.
        _b.copy(target.position).addScaledVector(_up, 13);
        _dir.copy(_b).sub(p.pos);
        gap = _dir.length();
        if (gap > 1e-4) _dir.divideScalar(gap);
        _c.copy(p.vel).normalize().lerp(_dir, 1 - Math.pow(2, -dt / 0.12)).normalize();
        p.vel.copy(_c).multiplyScalar(PROJ_SPEED.blueTravel);
      }
      p.pos.addScaledVector(p.vel, dt);
      if (gap < 14 || p.stateTime > 4.0) { p.state = S.BlueHover; p.stateTime = 0; }
      return;
    }

    if (p.state === S.BlueHover) {
      // Sit above the victim, drifting in, spinning up. Pure theatre.
      _b.copy(target.position).addScaledVector(_up, 7.0);
      _dir.copy(_b).sub(p.pos);
      const d = _dir.length();
      p.vel.copy(_dir).multiplyScalar(Math.min(1, d) * 6.5);
      p.pos.addScaledVector(p.vel, dt);
      if (p.stateTime > 0.85) {
        p.state = S.BlueSlam;
        p.stateTime = 0;
        p.vel.set(0, 0, 0);
      }
      return;
    }

    // Slam.
    _b.copy(target.position);
    _dir.copy(_b).sub(p.pos);
    _dir.y = 0;
    p.vel.x = _dir.x * 5.5;
    p.vel.z = _dir.z * 5.5;
    p.vel.y -= 95 * dt;
    p.pos.addScaledVector(p.vel, dt);
    const g = this.ground(p.pos, _up);
    const floorY = g ? g.y : target.position.y - 0.4;
    if (p.pos.y <= floorY + 0.9 || p.pos.distanceToSquared(target.position) < 2.2 * 2.2) {
      p.pos.y = Math.max(p.pos.y, floorY + 0.35);
      this.detonateBlue(p);
    }
  }

  private detonateBlue(p: Projectile): void {
    const direct = p.target;
    this.explode(p.pos, 9.5, 2.2, p.owner, ItemType.BlueShell, direct, 1.9);
    this.vfx.screenShake?.(1.0, 0.6);
    this.vfx.flash?.(0x9fd8ff, 0.5, 0.28);
    this.retire(p, true);
  }

  // --- banana -------------------------------------------------------------

  private stepBanana(p: Projectile, dt: number): void {
    if (p.state === S.Settled) {
      p.spinRate = 0;
      // Persist: only life-expiry (pool recycling) or a hit removes it.
      p.life = Math.max(p.life, 1);
      return;
    }
    p.vel.y -= WORLD.gravity * dt;
    p.pos.addScaledVector(p.vel, dt);
    const g = this.ground(p.pos, p.up);
    if (g) {
      _n.set(g.nx, g.ny, g.nz).normalize();
      const floor = g.y + BOTTLE_REST;
      if (p.pos.y <= floor) {
        p.pos.y = floor;
        const vn = p.vel.dot(_n);
        if (vn < 0) {
          p.vel.addScaledVector(_n, -vn * 1.34); // restitution 0.34
          p.vel.multiplyScalar(0.62);            // ground friction
          p.bounces++;
          p.spinRate *= 0.55;
          this.burst('dust', p.pos, 0.45);
        }
        if (p.vel.lengthSq() < 0.75 || p.bounces >= 3) {
          p.state = S.Settled;
          p.vel.set(0, 0, 0);
          p.pos.y = floor;
          p.up.copy(_n);
        }
      }
    } else if (p.pos.y < -60) {
      this.retire(p, false);
      return;
    }
    if (typeof this.track.collideWalls === 'function') {
      const w = this.track.collideWalls(p.pos, p.radius);
      if (w?.hit) {
        _n.copy(w.normal).normalize();
        p.pos.addScaledVector(_n, (w.depth ?? 0) + 0.02);
        const d = p.vel.dot(_n);
        if (d < 0) p.vel.addScaledVector(_n, -1.4 * d);
      }
    }
  }

  // --- bomb ---------------------------------------------------------------

  private stepBomb(p: Projectile, dt: number): void {
    p.vel.y -= WORLD.gravity * dt;
    p.pos.addScaledVector(p.vel, dt);
    const g = this.ground(p.pos, p.up);
    if (g) {
      _n.set(g.nx, g.ny, g.nz).normalize();
      const floor = g.y + p.radius;
      if (p.pos.y <= floor) {
        p.pos.y = floor;
        const vn = p.vel.dot(_n);
        if (vn < 0) {
          p.vel.addScaledVector(_n, -vn * 1.42);
          p.vel.multiplyScalar(0.7);
          p.bounces++;
          this.burst('dust', p.pos, 0.5);
        }
        if (p.vel.lengthSq() < 0.4) { p.vel.x *= 0.6; p.vel.z *= 0.6; }
      }
    } else if (p.pos.y < -60) { this.retire(p, false); return; }
    if (typeof this.track.collideWalls === 'function') {
      const w = this.track.collideWalls(p.pos, p.radius);
      if (w?.hit) {
        _n.copy(w.normal).normalize();
        p.pos.addScaledVector(_n, (w.depth ?? 0) + 0.02);
        const d = p.vel.dot(_n);
        if (d < 0) p.vel.addScaledVector(_n, -1.5 * d);
      }
    }
    // Fuse burns down via `life`; expire() detonates it.
  }

  // -------------------------------------------------------------------------
  // Collisions
  // -------------------------------------------------------------------------

  /** @returns true if the projectile was consumed. */
  private hitKarts(p: Projectile): boolean {
    const list = this.karts.karts;
    const r = p.radius + KART_RADIUS;
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k.id === p.owner && p.ownerGrace > 0) continue;
      if (k.finished) continue;
      const dx = k.position.x - p.pos.x;
      const dy = k.position.y - p.pos.y;
      const dz = k.position.z - p.pos.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (this.hooks.isImmune(k.id)) {
        // Star / bullet karts smash through — the item dies, they don't.
        if (p.kind === 'bomb') this.explode(p.pos, 7.5, 1.5, p.owner, ItemType.Bomb, -1, 1.5);
        else this.burst('shellBreak', p.pos, 0.9);
        this.retire(p, true);
        return true;
      }
      switch (p.kind) {
        case 'green':
        case 'red':
          this.strike(k.id, p.owner, p.item, p.pos, 'flip', 1.35, 7.5);
          this.burst('shellBreak', p.pos, 1.0);
          this.retire(p, true);
          return true;
        case 'banana':
          this.strike(k.id, p.owner, ItemType.Banana, p.pos, 'spin', 1.15, 0);
          this.burst('bananaSplat', p.pos, 0.9);
          this.retire(p, true);
          return true;
        case 'bomb':
          this.explode(p.pos, 7.5, 1.55, p.owner, ItemType.Bomb, k.id, 1.6);
          this.retire(p, true);
          return true;
        case 'blue':
          return false;
      }
    }
    return false;
  }

  /** Shells cancel; a shell kills a banana; a shell detonates a bomb. */
  private projVsProj(): void {
    for (let i = 0; i < this.all.length; i++) {
      const a = this.all[i];
      if (!a.active || a.held) continue;
      if (a.kind === 'blue') continue;
      const aIsShell = a.kind === 'green' || a.kind === 'red';
      if (!aIsShell) continue;
      for (let j = 0; j < this.all.length; j++) {
        if (j === i) continue;
        const b = this.all[j];
        if (!b.active || b.kind === 'blue') continue;
        if (b.owner === a.owner && b.held) continue;
        const rr = a.radius + b.radius;
        if (a.pos.distanceToSquared(b.pos) > rr * rr) continue;
        if (b.kind === 'bomb') {
          this.explode(b.pos, 7.5, 1.5, b.owner, ItemType.Bomb, -1, 1.6);
          this.retire(b, true);
          this.retire(a, true);
        } else {
          this.burst('shellBreak', a.pos, 1.0);
          this.retire(a, true);
          this.retire(b, true);
        }
        break;
      }
    }
  }

  /** A held shield absorbed something. */
  consumeHeld(p: Projectile): void {
    this.burst('shellBreak', p.pos, 1.0);
    this.retire(p, true);
  }

  // -------------------------------------------------------------------------

  private strike(
    targetId: number, sourceId: number, item: ItemType,
    at: THREE.Vector3, kind: string, seconds: number, knock: number,
  ): void {
    if (this.hooks.isImmune(targetId)) return;
    this.physics.applyStun?.(targetId, seconds, kind);
    if (knock > 0) {
      const k = this.kartById(targetId);
      if (k) {
        _d.copy(k.position).sub(at);
        _d.y = 0;
        if (_d.lengthSq() < 1e-4) _d.set(0, 0, 1);
        _d.normalize().multiplyScalar(knock * 120);
        _d.y = knock * 55;
        this.physics.applyImpulse?.(targetId, _d);
      }
    }
    bus.emit('item:hit', { targetId, sourceId, item, point: at });
    this.hooks.onHit(targetId, sourceId, item, at);
  }

  /** Multi-kart blast. `direct` takes the heavy hit. */
  explode(
    at: THREE.Vector3, radius: number, seconds: number,
    sourceId: number, item: ItemType, direct: number, visualScale: number,
  ): void {
    const list = this.karts.karts;
    const r2 = radius * radius;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      const d2 = k.position.distanceToSquared(at);
      if (d2 > r2) continue;
      const falloff = 1 - Math.sqrt(d2) / radius;
      const isDirect = k.id === direct;
      this.strike(
        k.id, sourceId, item, at,
        isDirect || falloff > 0.55 ? 'flip' : 'spin',
        seconds * (isDirect ? 1 : 0.6 + falloff * 0.4),
        (isDirect ? 1.4 : 0.7) * (0.35 + falloff),
      );
    }
    this.spawnExplosion(at, visualScale);
    this.burst('explosion', at, visualScale);
    this.vfx.screenShake?.(clamp01(visualScale * 0.4), 0.35);
  }

  private spawnExplosion(at: THREE.Vector3, scale: number): void {
    const e = this.explosions[this.expCursor];
    this.expCursor = (this.expCursor + 1) % this.explosions.length;
    e.t = 0;
    e.dur = 0.55 + scale * 0.22;
    e.scale = scale;
    e.pos.copy(at);
    e.core.visible = true;
    e.ring.visible = true;
    e.core.position.copy(at);
    e.ring.position.copy(at);
    e.ring.position.y += 0.35;
  }

  private burst(id: string, at: THREE.Vector3, scale: number): void {
    this.vfx.burst?.(id, at, undefined, scale);
  }

  private expire(p: Projectile): void {
    if (p.kind === 'bomb') {
      this.explode(p.pos, 7.5, 1.5, p.owner, ItemType.Bomb, -1, 1.6);
      this.retire(p, true);
      return;
    }
    if (p.kind === 'green' || p.kind === 'red') this.burst('shellBreak', p.pos, 0.8);
    this.retire(p, true);
  }

  private retire(p: Projectile, notify: boolean): void {
    if (!p.active) return;
    p.active = false;
    p.held = false;
    p.node.visible = false;
    p.vel.set(0, 0, 0);
    if (notify) {
      bus.emit('item:expired', { id: p.id });
      this.hooks.onExpire?.(p.id);
    }
  }

  /** Public destroy — used when a held shield is knocked away. */
  kill(p: Projectile): void { this.retire(p, true); }

  // -------------------------------------------------------------------------
  // Threat model (consumed by AI + HUD warnings)
  // -------------------------------------------------------------------------

  private buildThreats(): void {
    const list = this.karts.karts;
    if (this.threatItem.length < list.length) {
      this.threatItem = new Int8Array(list.length);
      this.threatDist = new Float32Array(list.length);
    }
    this.threatItem.fill(-1);
    for (let i = 0; i < list.length; i++) this.threatDist[i] = Infinity;

    const indexOf = (id: number): number => {
      for (let i = 0; i < list.length; i++) if (list[i].id === id) return i;
      return -1;
    };

    for (let i = 0; i < this.all.length; i++) {
      const p = this.all[i];
      if (!p.active || p.held) continue;

      if (p.kind === 'red' && p.target >= 0) {
        const idx = indexOf(p.target);
        if (idx >= 0) {
          const d = Math.sqrt(list[idx].position.distanceToSquared(p.pos));
          if (d < this.threatDist[idx]) { this.threatDist[idx] = d; this.threatItem[idx] = ItemType.RedShell; }
        }
        continue;
      }
      if (p.kind === 'blue' && p.target >= 0) {
        const idx = indexOf(p.target);
        if (idx >= 0) {
          const d = Math.sqrt(list[idx].position.distanceToSquared(p.pos));
          if (d < this.threatDist[idx]) { this.threatDist[idx] = d; this.threatItem[idx] = ItemType.BlueShell; }
        }
        continue;
      }
      // Green shells / bombs / bananas: anything close and roughly ahead of us.
      const warnR = p.kind === 'green' ? 34 : p.kind === 'bomb' ? 18 : 11;
      const warnR2 = warnR * warnR;
      for (let k = 0; k < list.length; k++) {
        const kart = list[k];
        if (kart.id === p.owner && p.ownerGrace > 0) continue;
        const d2 = kart.position.distanceToSquared(p.pos);
        if (d2 > warnR2) continue;
        const d = Math.sqrt(d2);
        if (d >= this.threatDist[k]) continue;
        this.threatDist[k] = d;
        this.threatItem[k] = p.item;
      }
    }
  }

  threatFor(kartId: number): ThreatInfo | null {
    const list = this.karts.karts;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id !== kartId) continue;
      if (this.threatItem[i] < 0) return null;
      this.threatOut.item = this.threatItem[i] as ItemType;
      this.threatOut.distance = this.threatDist[i];
      return this.threatOut;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Visual step
  // -------------------------------------------------------------------------

  update(dt: number, elapsed: number): void {
    for (let i = 0; i < this.all.length; i++) {
      const p = this.all[i];
      if (!p.active) continue;
      if (p.held) continue;

      p.node.position.copy(p.pos);

      switch (p.kind) {
        case 'green': {
          // Spin about the surface normal, tilted into the direction of travel.
          _a.copy(p.vel);
          _a.y = 0;
          if (_a.lengthSq() < 1e-6) _a.set(0, 0, -1);
          _a.normalize();
          _q.setFromUnitVectors(_up, p.up);
          p.node.quaternion.copy(_q);
          p.node.rotateY(p.spin);
          // Lean into the turn a touch — the shells look driven, not sliding.
          p.node.rotateOnAxis(_a, Math.sin(p.spin * 0.5) * 0.06);
          break;
        }
        case 'red': {
          /**
           * P0d-D5: the Rocket flies NOSE-FIRST.
           *
           * This used to share the green shell's branch, which spins the node
           * about its own +Y — correct for a shell, absurd for a rocket (it read
           * as a helicopter blade). The rocket model is built with its nose down
           * -Z, so we build a basis from the velocity and roll slowly about the
           * body axis instead.
           */
          _a.copy(p.vel);
          if (_a.lengthSq() < 1e-6) _a.set(0, 0, -1);
          _a.normalize();
          // -Z must land on the direction of travel.
          _q.setFromUnitVectors(_negZ, _a);
          p.node.quaternion.copy(_q);
          p.node.rotateZ(p.spin * 0.28);
          // Flame flicker, and a little swell as the rocket accelerates.
          const fl = p.node.getObjectByName(PART.rocketFlame);
          if (fl) {
            const f = 0.82 + Math.abs(Math.sin(elapsed * 31 + p.id)) * 0.34;
            fl.scale.set(0.9 + f * 0.16, f, 0.9 + f * 0.16);
          }
          break;
        }
        case 'blue': {
          _q.setFromAxisAngle(_up, p.spin);
          p.node.quaternion.copy(_q);
          const wob = p.state === S.BlueSlam ? 0.0 : Math.sin(elapsed * 9) * 0.12;
          p.node.rotateX(0.22 + wob);
          const s = p.state === S.BlueSlam
            ? 1 + Math.min(0.35, p.stateTime * 1.6)
            : 1.0 + Math.sin(elapsed * 6) * 0.03;
          p.node.scale.setScalar(s);
          break;
        }
        case 'banana': {
          if (p.state === S.Settled) {
            _q.setFromUnitVectors(_up, p.up);
            p.node.quaternion.copy(_q);
            p.node.rotateY(p.spin);
            // Tiny idle wobble so a settled banana isn't dead geometry.
            p.node.rotateZ(Math.sin(elapsed * 2.2 + p.id) * 0.035);
          } else {
            p.node.rotation.x += p.spinRate * dt * 0.7;
            p.node.rotation.y += p.spinRate * dt;
          }
          break;
        }
        case 'bomb': {
          p.node.rotation.y += p.spinRate * dt * 0.6;
          p.node.rotation.x += p.spinRate * dt * 0.35;
          // Fuse spark flickers faster as the fuse burns down.
          const spark = p.spark;
          if (spark) {
            const urgency = 1 - clamp01(p.life / LIFE.bomb);
            const f = 0.26 + Math.abs(Math.sin(elapsed * (16 + urgency * 42))) * (0.14 + urgency * 0.3);
            spark.scale.setScalar(f);
            (spark.material as THREE.SpriteMaterial).opacity = 0.55 + urgency * 0.45;
          }
          // Bob-omb swells just before it goes.
          const swell = 1 + Math.max(0, 1 - p.life / 0.6) * 0.18 * (0.5 + 0.5 * Math.sin(elapsed * 34));
          p.node.scale.setScalar(swell);
          break;
        }
      }
    }

    // Explosions
    for (const e of this.explosions) {
      if (!e.core.visible) continue;
      e.t += dt;
      const k = clamp01(e.t / e.dur);
      if (k >= 1) { e.core.visible = false; e.ring.visible = false; continue; }
      const grow = 1 - Math.pow(1 - k, 2.4);
      const fade = Math.pow(1 - k, 1.6);
      e.core.scale.setScalar(e.scale * (1.2 + grow * 7.5));
      (e.core.material as THREE.SpriteMaterial).opacity = fade * 0.95;
      const rs = e.scale * (1.0 + grow * 15.0);
      e.ring.scale.set(rs, rs, 1);
      (e.ring.material as THREE.MeshBasicMaterial).opacity = Math.pow(1 - k, 2.2) * 0.85;
    }
  }

  // -------------------------------------------------------------------------
  // Introspection (dev harness / HUD)
  // -------------------------------------------------------------------------

  get activeCount(): number {
    let n = 0;
    for (const p of this.all) if (p.active) n++;
    return n;
  }

  countOf(kind: ProjKind): number {
    let n = 0;
    const pool = this.pools.get(kind);
    if (pool) for (const p of pool) if (p.active) n++;
    return n;
  }

  /** True while a blue shell / bullet-blocking item is in the air. */
  hasActive(kind: ProjKind): boolean { return this.countOf(kind) > 0; }

  forEachActive(fn: (p: Projectile) => void): void {
    for (const p of this.all) if (p.active) fn(p);
  }

  /** All pool slots, active or not — used by the NaN sweep in tests. */
  forEachSlot(fn: (p: Projectile) => void): void {
    for (const p of this.all) fn(p);
  }

  clear(): void {
    for (const p of this.all) this.retire(p, false);
    for (const e of this.explosions) { e.core.visible = false; e.ring.visible = false; }
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    this.group.clear();
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    this.geoms.length = 0;
    this.mats.length = 0;
    this.texs.length = 0;
    this.all.length = 0;
    this.pools.clear();
    this.explosions.length = 0;
  }
}
