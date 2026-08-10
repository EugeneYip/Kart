/**
 * ============================================================================
 *  APEX KART — ITEM SYSTEM
 * ============================================================================
 *  The public face of the items subsystem. Owns:
 *    - the item-box field and its pickup tests
 *    - the roulette (probability table + slot animation)
 *    - per-kart inventory and status effects
 *    - the projectile pool
 *    - track hazards
 *    - the HUD icon atlas
 *
 *  Everything it is handed (track / karts / physics / vfx) is consumed through
 *  narrow structural interfaces with feature detection, because those modules
 *  are authored in parallel. A missing method degrades one behaviour; it never
 *  throws and never blocks.
 *
 *  Update order: fixedUpdate does gameplay at 120 Hz, update() only touches
 *  visuals. No allocation in either.
 * ============================================================================
 */

import * as THREE from 'three';
import type {
  FrameContext, IAudioService, ISubsystem, ItemType as ItemTypeT, KartState,
} from '@/core/Types';
import { ItemType } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { clamp, clamp01, lerp, Rng, wrap } from '@/core/MathUtils';
import { ItemModels, TRIPLE_ITEMS, ITEM_NAMES, type IconRect } from './ItemModels';
import { ItemBoxField, type BoxSpawn } from './ItemBox';
import {
  ItemRoulette, itemUses, rollItem, tableRow, weightsFor,
  BLUE_SHELL_COOLDOWN, LIGHTNING_COOLDOWN, type RollContext,
} from './ItemRoulette';
import {
  Projectiles, type KartsLike, type PhysicsLike, type ProjKind, type Projectile,
  type ThreatInfo, type TrackLike, type VfxLike,
} from './Projectiles';
import { Hazards } from './Hazards';

const MAX_KARTS = 16;
const STAR_TIME = 7.5;
const BULLET_TIME = 7.0;
const GHOST_TIME = 6.0;
const INK_TIME = 4.5;
const SHRINK_TIME = 6.0;
const MAX_COINS = 10;
/** Button must be down this long before a shell drops into shield mode. */
const HOLD_THRESHOLD = 0.16;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/** Where an item goes when it is used. */
export type AimMode = 'default' | 'back' | 'forward';

interface Inventory {
  item: ItemType | null;
  count: number;
  /** How long the use button has been held. */
  holdTime: number;
  buttonDown: boolean;
  /** Live shield / orbit projectiles owned by this kart. */
  orbit: Projectile[];
  orbitPhase: number;
  // --- status effects (ours, not physics') ---
  starTime: number;
  bulletTime: number;
  ghostTime: number;
  inkTime: number;
  shrinkTime: number;
  coins: number;
  /** Latch so a single press can't fire twice. */
  fireLatch: boolean;
}

export interface AutopilotInfo { active: boolean; target: THREE.Vector3; speed: number }

interface KartsMaybeAlpha extends KartsLike {
  setKartAlpha?(kartId: number, alpha: number): void;
  setKartScale?(kartId: number, scale: number): void;
}

interface TrackMaybeBoxes extends TrackLike {
  getItemBoxSpawns?(): unknown;
}

export class ItemSystem implements ISubsystem {
  private scene: THREE.Scene;
  private track: TrackMaybeBoxes;
  private karts: KartsMaybeAlpha;
  private physics: PhysicsLike;
  private vfx: VfxLike;
  private audio: Partial<IAudioService> | null = null;

  readonly models = new ItemModels();
  readonly boxes: ItemBoxField;
  readonly roulette = new ItemRoulette(MAX_KARTS);
  readonly projectiles: Projectiles;
  readonly hazards: Hazards;

  private inv: Inventory[] = [];
  private rng = new Rng(0x5EED17);

  private lightningCd = 0;
  private blueCd = 0;
  private ready = false;
  private elapsed = 0;

  /** Reused output objects — getters must not allocate. */
  private autopilotOut: AutopilotInfo = { active: false, target: new THREE.Vector3(), speed: 0 };
  private boxSpawnScratch: BoxSpawn[] = [];

  constructor(
    scene: THREE.Scene,
    track: TrackLike,
    karts: KartsLike,
    physics: PhysicsLike,
    vfx: VfxLike,
  ) {
    this.scene = scene;
    this.track = track as TrackMaybeBoxes;
    this.karts = karts as KartsMaybeAlpha;
    this.physics = physics;
    this.vfx = vfx;

    this.boxes = new ItemBoxField(scene);
    this.projectiles = new Projectiles(scene, this.models, track, karts, physics, vfx, {
      isImmune: (id) => this.isImmune(id),
      onHit: (t, s, item, at) => this.onProjectileHit(t, s, item, at),
    });
    this.hazards = new Hazards(scene, track, karts, physics, vfx);

    for (let i = 0; i < MAX_KARTS; i++) {
      this.inv.push({
        item: null, count: 0, holdTime: 0, buttonDown: false,
        orbit: [], orbitPhase: Math.random() * 6.28,
        starTime: 0, bulletTime: 0, ghostTime: 0, inkTime: 0, shrinkTime: 0,
        coins: 0, fireLatch: false,
      });
    }
  }

  setAudio(audio: Partial<IAudioService>): void { this.audio = audio; }

  private sfx(id: string, at?: THREE.Vector3, volume = 1, rate = 1): void {
    this.audio?.play?.(id, { position: at, volume, rate });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    await this.models.init();
    this.boxes.init();
    this.boxes.setSpawns(this.resolveBoxSpawns());
    this.projectiles.init();
    this.hazards.init();
    this.ready = true;
  }

  /**
   * Box placement: prefer the track's own spawns, otherwise lay out rows of
   * five across the road at even intervals so the harness (and any track that
   * forgets to publish spawns) still has boxes to drive through.
   */
  private resolveBoxSpawns(): BoxSpawn[] {
    const out = this.boxSpawnScratch;
    out.length = 0;

    const raw = typeof this.track.getItemBoxSpawns === 'function'
      ? this.track.getItemBoxSpawns()
      : null;
    if (Array.isArray(raw) && raw.length > 0) {
      for (const entry of raw) {
        if (entry instanceof THREE.Vector3) {
          out.push({ position: entry.clone() });
        } else if (entry && typeof entry === 'object') {
          const e = entry as { position?: THREE.Vector3; normal?: THREE.Vector3; up?: THREE.Vector3 };
          if (e.position instanceof THREE.Vector3) {
            out.push({ position: e.position.clone(), normal: (e.normal ?? e.up)?.clone() });
          }
        }
      }
      if (out.length > 0) return out;
    }

    const lap = typeof this.track.lapLength === 'number' ? this.track.lapLength : 0;
    if (lap < 10 || typeof this.track.sampleAtDistance !== 'function') return out;
    const rows = Math.max(3, Math.min(9, Math.round(lap / 200)));
    for (let r = 0; r < rows; r++) {
      const d = ((r + 0.5) / rows) * lap;
      const s = this.track.sampleAtDistance(wrap(d, lap));
      if (!s) continue;
      const halfW = Math.max(4, s.halfWidth - 2.6);
      for (let i = 0; i < 5; i++) {
        const lat = ((i - 2) / 2) * halfW;
        out.push({
          position: new THREE.Vector3()
            .copy(s.position)
            .addScaledVector(s.binormal, lat)
            .addScaledVector(s.normal, 1.35),
          normal: s.normal.clone(),
        });
      }
    }
    return out;
  }

  /** Re-read the track's box spawns (call after a track swap). */
  refreshBoxSpawns(): void {
    this.boxes.setSpawns(this.resolveBoxSpawns());
  }

  // -------------------------------------------------------------------------
  // Public contract
  // -------------------------------------------------------------------------

  getHeldItem(kartId: number): ItemType | null {
    return this.inv[kartId]?.item ?? null;
  }

  getItemCount(kartId: number): number {
    return this.inv[kartId]?.count ?? 0;
  }

  getIncomingThreat(kartId: number): ThreatInfo | null {
    return this.projectiles.threatFor(kartId);
  }

  getIconAtlas(): THREE.Texture { return this.models.getIconAtlas(); }
  getIconUV(item: ItemTypeT): IconRect { return this.models.getIconUV(item); }
  /** Pixel rect + raw canvas, for a DOM/2D HUD that prefers drawImage. */
  getIconCanvas(): HTMLCanvasElement | null { return this.models.getIconCanvas(); }
  getIconPixelRect(item: ItemTypeT): IconRect { return this.models.getIconPixelRect(item); }

  /** What the HUD slot should draw while the roulette spins (null when idle). */
  getRouletteDisplay(kartId: number): ItemType | null { return this.roulette.getDisplay(kartId); }
  getRouletteFlash(kartId: number): number { return this.roulette.getFlash(kartId); }
  isRouletteSpinning(kartId: number): boolean { return this.roulette.isSpinning(kartId); }

  /** Status readouts for HUD / camera / renderer. */
  getStarTime(kartId: number): number { return this.inv[kartId]?.starTime ?? 0; }
  getBulletTime(kartId: number): number { return this.inv[kartId]?.bulletTime ?? 0; }
  getGhostTime(kartId: number): number { return this.inv[kartId]?.ghostTime ?? 0; }
  getCoins(kartId: number): number { return this.inv[kartId]?.coins ?? 0; }
  /** 0..1 squid-ink screen coverage. */
  getInkAmount(kartId: number): number {
    const v = this.inv[kartId]?.inkTime ?? 0;
    if (v <= 0) return 0;
    // Splat instantly, wipe away over the last second.
    return clamp01(Math.min(1, (INK_TIME - v) * 6)) * clamp01(v / 1.0);
  }
  /** 0..1 lightning shrink amount (1 = fully shrunk, ramps back up at the end). */
  getShrinkAmount(kartId: number): number {
    const v = this.inv[kartId]?.shrinkTime ?? 0;
    return v <= 0 ? 0 : clamp01(v / 0.4);
  }
  /** Bullet Bill autopilot request. `active` false when not driving. */
  getAutopilot(kartId: number): AutopilotInfo {
    const inv = this.inv[kartId];
    this.autopilotOut.active = !!inv && inv.bulletTime > 0;
    return this.autopilotOut;
  }
  isImmune(kartId: number): boolean {
    const inv = this.inv[kartId];
    if (inv && (inv.starTime > 0 || inv.bulletTime > 0 || inv.ghostTime > 0)) return true;
    const k = this.kart(kartId);
    return !!k && (k.invulnerable || k.starTime > 0);
  }

  /**
   * Hand an item over immediately, skipping the box + roulette. Used by the
   * dev harness, by cheats, and by any mode that awards fixed items.
   */
  grantItem(kartId: number, item: ItemType): void {
    const inv = this.inv[kartId];
    if (!inv) return;
    this.clearOrbit(inv);
    this.roulette.cancel(kartId);
    this.grant(kartId, item);
  }

  /** Debug / balance tooling: the normalised row for a grid slot. */
  probabilityRow(slot: number): Float64Array { return tableRow(slot); }
  probabilityFor(position: number, totalKarts: number, out: Float64Array): void {
    weightsFor(position, totalKarts, out);
  }

  // -------------------------------------------------------------------------

  /** Item button pressed (tap). Fires immediately. */
  requestUse(kartId: number): void {
    if (this.roulette.isSpinning(kartId)) { this.roulette.hurry(kartId); return; }
    const inv = this.inv[kartId];
    if (!inv || inv.item === null) return;
    this.use(kartId, inv, 'default');
  }

  /**
   * Raw button state, for the hold-to-shield behaviour. Optional: a caller that
   * only ever taps `requestUse` gets standard fire-on-press.
   */
  requestHold(kartId: number, down: boolean): void {
    const inv = this.inv[kartId];
    if (!inv) return;
    if (down && !inv.buttonDown) {
      inv.buttonDown = true;
      inv.holdTime = 0;
      inv.fireLatch = false;
      if (this.roulette.isSpinning(kartId)) this.roulette.hurry(kartId);
      return;
    }
    if (!down && inv.buttonDown) {
      inv.buttonDown = false;
      // A tap fires; a hold-and-release throws the shield forward.
      if (!inv.fireLatch && inv.item !== null) this.use(kartId, inv, 'default');
      inv.holdTime = 0;
    }
  }

  /** Explicitly drop an item behind (AI defensive play). */
  requestDropBehind(kartId: number): void {
    const inv = this.inv[kartId];
    if (!inv || inv.item === null) return;
    this.use(kartId, inv, 'back');
  }

  /** Explicitly throw forward — a lobbed banana or bomb. */
  requestThrowForward(kartId: number): void {
    const inv = this.inv[kartId];
    if (!inv || inv.item === null) return;
    this.use(kartId, inv, 'forward');
  }

  // -------------------------------------------------------------------------
  // Fixed step
  // -------------------------------------------------------------------------

  fixedUpdate(ctx: FrameContext): void {
    if (!this.ready) return;
    const dt = ctx.fixedDt;
    this.lightningCd = Math.max(0, this.lightningCd - dt);
    this.blueCd = Math.max(0, this.blueCd - dt);

    this.collectBoxes(dt);
    this.advanceRoulettes(dt);
    this.tickStatus(dt);
    this.updateOrbits(dt);
    this.projectiles.fixedUpdate(dt);
    this.starContacts();
    this.hazards.fixedUpdate(dt);
    this.boxes.fixedUpdate(dt);
  }

  // --- boxes ---------------------------------------------------------------

  private boxProbe: Array<{ id: number; position: THREE.Vector3; skip: boolean }> = [];

  private collectBoxes(_dt: number): void {
    const list = this.karts.karts;
    // Grow the probe array once, then reuse.
    while (this.boxProbe.length < list.length) {
      this.boxProbe.push({ id: -1, position: new THREE.Vector3(), skip: true });
    }
    this.boxProbe.length = list.length;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      const inv = this.inv[k.id];
      const probe = this.boxProbe[i];
      probe.id = k.id;
      probe.position.copy(k.position);
      // Can't collect while already holding, mid-roulette, or finished.
      probe.skip = !inv || k.finished || inv.item !== null || this.roulette.isSpinning(k.id);
    }

    this.boxes.checkPickups(this.boxProbe, (p) => {
      const inv = this.inv[p.kartId];
      if (!inv) return;
      const k = this.kart(p.kartId);
      const total = Math.max(2, this.karts.karts.length);
      const roll: RollContext = {
        position: k?.racePosition && k.racePosition > 0 ? k.racePosition : total,
        totalKarts: total,
        lapsRemaining: k ? Math.max(0, 2 - (k.lap - 1)) : 1,
        lightningReady: this.lightningCd <= 0,
        blueShellReady: this.blueCd <= 0,
        bulletInPlay: this.anyBulletActive(),
        blueShellInPlay: this.projectiles.hasActive('blue'),
        rand: () => this.rng.next(),
      };
      const item = rollItem(roll);
      this.roulette.begin(p.kartId, item);
      bus.emit('item:box', { kartId: p.kartId, position: p.position });
      this.sfx('item_box', p.position, 1, 1);
      this.vfx.burst?.('itemBox', p.position, undefined, 1.0);
      if (this.isPlayer(p.kartId)) this.vfx.screenShake?.(0.14, 0.12);
    });
  }

  private advanceRoulettes(dt: number): void {
    const list = this.karts.karts;
    for (let i = 0; i < list.length; i++) {
      const id = list[i].id;
      const locked = this.roulette.advance(id, dt);
      if (locked !== null) this.grant(id, locked);
    }
  }

  private grant(kartId: number, item: ItemType): void {
    const inv = this.inv[kartId];
    if (!inv) return;
    inv.item = item;
    inv.count = itemUses(item);
    const k = this.kart(kartId);
    if (k) { k.heldItem = item; k.itemCount = inv.count; }
    if (item === ItemType.Lightning) this.lightningCd = LIGHTNING_COOLDOWN;
    if (item === ItemType.BlueShell) this.blueCd = BLUE_SHELL_COOLDOWN;
    bus.emit('item:granted', { kartId, item, count: inv.count });
    this.sfx('item_get', k?.position, 1, 1);
    // Triples orbit the kart from the moment you get them, MK8-style.
    if (TRIPLE_ITEMS.has(item)) this.spawnOrbit(kartId, inv, item);
  }

  // --- orbit / shield ------------------------------------------------------

  private orbitKindFor(item: ItemType): ProjKind | null {
    switch (item) {
      case ItemType.GreenShell:
      case ItemType.TripleGreenShell: return 'green';
      case ItemType.RedShell:
      case ItemType.TripleRedShell: return 'red';
      case ItemType.Banana:
      case ItemType.TripleBanana: return 'banana';
      default: return null;
    }
  }

  private spawnOrbit(kartId: number, inv: Inventory, item: ItemType): void {
    const kind = this.orbitKindFor(item);
    if (!kind) return;
    const k = this.kart(kartId);
    if (!k) return;
    this.clearOrbit(inv);
    for (let i = 0; i < inv.count; i++) {
      const p = this.projectiles.spawn(kind, item, kartId, k.position, this.forwardOf(k, _fwd), null, true);
      if (!p) break;
      p.held = true;
      p.life = 9999;
      p.spinRate = 6;
      inv.orbit.push(p);
    }
  }

  private clearOrbit(inv: Inventory): void {
    for (const p of inv.orbit) if (p.active) this.projectiles.kill(p);
    inv.orbit.length = 0;
  }

  /** Position the orbiting / shielding items. Runs at fixed rate. */
  private updateOrbits(dt: number): void {
    const list = this.karts.karts;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      const inv = this.inv[k.id];
      if (!inv) continue;

      if (inv.buttonDown) {
        inv.holdTime += dt;
        if (inv.holdTime > HOLD_THRESHOLD && !inv.fireLatch && inv.item !== null
          && inv.orbit.length === 0 && this.orbitKindFor(inv.item)) {
          // Drop the single shell into shield position behind the kart.
          this.spawnShield(k.id, inv, inv.item);
        }
      }

      if (inv.orbit.length === 0) continue;
      inv.orbitPhase += dt * 2.4;

      // Prune anything the world destroyed (a shield that blocked a shell).
      let write = 0;
      for (let j = 0; j < inv.orbit.length; j++) {
        const p = inv.orbit[j];
        if (p.active && p.held) inv.orbit[write++] = p;
      }
      if (write !== inv.orbit.length) {
        inv.orbit.length = write;
        // Losing a shield costs you the item use.
        if (inv.count > 0) {
          inv.count = Math.min(inv.count, Math.max(0, inv.orbit.length));
          if (inv.count === 0) this.setItem(k.id, inv, null);
          else { const kk = this.kart(k.id); if (kk) kk.itemCount = inv.count; }
        }
        if (inv.orbit.length === 0) continue;
      }

      const n = inv.orbit.length;
      this.forwardOf(k, _fwd);
      for (let j = 0; j < n; j++) {
        const p = inv.orbit[j];
        if (n === 1) {
          // Single shield: sits directly behind, close in.
          _a.copy(k.position).addScaledVector(_fwd, -2.35);
          _a.y += 0.35;
        } else {
          const ang = inv.orbitPhase + (j / n) * Math.PI * 2;
          const r = 2.55;
          // Orbit in the kart's own plane, biased behind it.
          _b.set(Math.sin(ang), 0, Math.cos(ang));
          _a.copy(k.position);
          _a.x += _b.x * r;
          _a.z += _b.z * r;
          _a.y += 0.42 + Math.sin(ang * 2) * 0.08;
        }
        p.pos.copy(_a);
        p.up.set(0, 1, 0);
      }
    }
  }

  private spawnShield(kartId: number, inv: Inventory, item: ItemType): void {
    const kind = this.orbitKindFor(item);
    if (!kind) return;
    const k = this.kart(kartId);
    if (!k) return;
    const p = this.projectiles.spawn(kind, item, kartId, k.position, this.forwardOf(k, _fwd), null, true);
    if (!p) return;
    p.held = true;
    p.life = 9999;
    p.spinRate = 6;
    inv.orbit.push(p);
    this.sfx('item_hold', k.position, 0.6, 1);
  }

  // --- status effects -----------------------------------------------------

  private tickStatus(dt: number): void {
    const list = this.karts.karts;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      const inv = this.inv[k.id];
      if (!inv) continue;

      if (inv.starTime > 0) {
        inv.starTime -= dt;
        k.starTime = Math.max(0, inv.starTime);
        if (inv.starTime <= 0) { inv.starTime = 0; k.starTime = 0; this.sfx('star_end', k.position); }
      }

      if (inv.bulletTime > 0) {
        inv.bulletTime -= dt;
        this.driveBullet(k, dt);
        if (inv.bulletTime <= 0) {
          inv.bulletTime = 0;
          this.physics.setAutopilot?.(k.id, null, 0);
          bus.emit('camera:mode', { mode: 'chase' });
          this.sfx('bullet_end', k.position);
        }
      }

      if (inv.ghostTime > 0) {
        inv.ghostTime -= dt;
        if (inv.ghostTime <= 0) {
          inv.ghostTime = 0;
          this.karts.setKartAlpha?.(k.id, 1);
        } else {
          // Fade back in over the last half second rather than popping.
          this.karts.setKartAlpha?.(k.id, lerp(1, 0.26, clamp01(inv.ghostTime / 0.5)));
        }
      }

      if (inv.inkTime > 0) { inv.inkTime -= dt; if (inv.inkTime < 0) inv.inkTime = 0; }

      if (inv.shrinkTime > 0) {
        inv.shrinkTime -= dt;
        const s = inv.shrinkTime > 0 ? 0.58 : 1;
        this.physics.setScale?.(k.id, s);
        this.karts.setKartScale?.(k.id, s);
        if (inv.shrinkTime <= 0) {
          inv.shrinkTime = 0;
          this.physics.setScale?.(k.id, 1);
          this.karts.setKartScale?.(k.id, 1);
        }
      }
    }
  }

  /**
   * Bullet Bill. If physics exposes an autopilot hook we hand it the racing
   * line; otherwise we steer with corrective impulses, which still keeps the
   * kart glued to the road.
   */
  private driveBullet(k: KartState, dt: number): void {
    if (typeof this.track.project !== 'function' || typeof this.track.sampleAtDistance !== 'function') {
      this.physics.applyBoost?.(k.id, 0.3, 2.1, 'item');
      return;
    }
    const own = this.track.project(k.position);
    if (!own) return;
    const lap = typeof this.track.lapLength === 'number' ? this.track.lapLength : 1000;
    const ahead = this.track.sampleAtDistance(wrap(own.distance + 16, lap));
    if (!ahead) return;
    // Aim slightly inside the apex — the racing line, not the centreline.
    _a.copy(ahead.position).addScaledVector(ahead.binormal, -clamp(ahead.curvature * 320, -6, 6));
    this.autopilotOut.target.copy(_a);
    this.autopilotOut.speed = 42;
    if (typeof this.physics.setAutopilot === 'function') {
      this.physics.setAutopilot(k.id, _a, 42);
      return;
    }
    // Fallback: boost + lateral correction toward the line.
    this.physics.applyBoost?.(k.id, 0.25, 2.1, 'item');
    const lat = _b.copy(k.position).sub(own.position).dot(own.binormal);
    _b.copy(own.binormal).multiplyScalar(-lat * 60 * dt * 60);
    _b.y = 0;
    this.physics.applyImpulse?.(k.id, _b);
  }

  /** Star / bullet karts bulldoze anyone they touch. */
  private starContacts(): void {
    const list = this.karts.karts;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const invA = this.inv[a.id];
      if (!invA) continue;
      const powered = invA.starTime > 0 || invA.bulletTime > 0;
      if (!powered) continue;
      const item = invA.starTime > 0 ? ItemType.Star : ItemType.Bullet;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const b = list[j];
        if (b.finished || this.isImmune(b.id)) continue;
        if (a.position.distanceToSquared(b.position) > 2.6 * 2.6) continue;
        this.physics.applyStun?.(b.id, 1.25, 'flip');
        _a.copy(b.position).sub(a.position);
        _a.y = 0;
        if (_a.lengthSq() < 1e-4) _a.set(0, 0, 1);
        _a.normalize().multiplyScalar(210);
        _a.y = 90;
        this.physics.applyImpulse?.(b.id, _a);
        this.dropItemOnHit(b.id);
        bus.emit('item:hit', { targetId: b.id, sourceId: a.id, item, point: b.position });
        this.vfx.burst?.('starHit', b.position, undefined, 1.1);
        this.sfx('star_hit', b.position);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Using items
  // -------------------------------------------------------------------------

  private setItem(kartId: number, inv: Inventory, item: ItemType | null): void {
    inv.item = item;
    if (item === null) inv.count = 0;
    const k = this.kart(kartId);
    if (k) { k.heldItem = item; k.itemCount = inv.count; }
  }

  private consume(kartId: number, inv: Inventory): void {
    inv.count = Math.max(0, inv.count - 1);
    if (inv.count === 0) this.setItem(kartId, inv, null);
    else {
      const k = this.kart(kartId);
      if (k) k.itemCount = inv.count;
    }
  }

  private use(kartId: number, inv: Inventory, mode: AimMode): void {
    const item = inv.item;
    if (item === null) return;
    const k = this.kart(kartId);
    if (!k || k.finished) return;
    inv.fireLatch = true;
    this.forwardOf(k, _fwd);

    // Bananas trail behind by default; shells and bombs go forward.
    const defaultBack = item === ItemType.Banana || item === ItemType.TripleBanana;
    const backwards = mode === 'back' ? true : mode === 'forward' ? false : defaultBack;

    switch (item) {
      case ItemType.Boost:
      case ItemType.TripleBoost: {
        this.physics.applyBoost?.(kartId, 1.6, 1.35, 'item');
        this.vfx.burst?.('boost', k.position, undefined, 1.0);
        this.sfx('mushroom', k.position);
        break;
      }

      case ItemType.GreenShell:
      case ItemType.TripleGreenShell:
      case ItemType.RedShell:
      case ItemType.TripleRedShell: {
        const kind: ProjKind = (item === ItemType.RedShell || item === ItemType.TripleRedShell) ? 'red' : 'green';
        const held = inv.orbit.pop();
        if (held && held.active) {
          // Release the shield: it keeps its place and takes off from there.
          held.held = false;
          held.life = kind === 'red' ? 12 : 9;
          held.age = 0;
          held.ownerGrace = 0.28;
          held.bounces = 0;
          held.spinRate = 15;
          _a.copy(_fwd).multiplyScalar(backwards ? -1 : 1);
          held.vel.copy(_a).multiplyScalar(kind === 'red' ? 36 : 34);
          if (kind === 'red') held.target = this.projectiles.pickTargetAhead(kartId);
        } else {
          this.projectiles.spawn(kind, item, kartId, k.position, _fwd, k.velocity, backwards);
        }
        this.sfx(kind === 'red' ? 'shell_red' : 'shell_green', k.position);
        break;
      }

      case ItemType.Banana:
      case ItemType.TripleBanana: {
        const held = inv.orbit.pop();
        if (held && held.active) {
          held.held = false;
          held.life = 60;
          held.age = 0;
          held.ownerGrace = 0.8;
          held.state = 0;
          held.bounces = 0;
          held.vel.set(0, -1.5, 0);
          if (!backwards) held.vel.copy(_fwd).multiplyScalar(11).setY(5.5);
        } else {
          this.projectiles.spawn('banana', item, kartId, k.position, _fwd, k.velocity, backwards);
        }
        this.sfx('banana_drop', k.position);
        break;
      }

      case ItemType.Bomb: {
        this.projectiles.spawn('bomb', item, kartId, k.position, _fwd, k.velocity, backwards);
        this.sfx('bomb_throw', k.position);
        break;
      }

      case ItemType.BlueShell: {
        this.projectiles.spawn('blue', item, kartId, k.position, _fwd, k.velocity, false);
        this.blueCd = BLUE_SHELL_COOLDOWN;
        this.sfx('blue_launch', k.position);
        bus.emit('ui:message', { text: 'SPINY SHELL!', seconds: 1.6, style: 'warn' });
        break;
      }

      case ItemType.Star: {
        inv.starTime = STAR_TIME;
        k.starTime = STAR_TIME;
        this.physics.applyBoost?.(kartId, STAR_TIME, 1.18, 'item');
        this.vfx.burst?.('starPop', k.position, undefined, 1.4);
        if (this.isPlayer(kartId)) this.vfx.flash?.(0xfff0a0, 0.3, 0.2);
        this.sfx('star_start', k.position);
        break;
      }

      case ItemType.Lightning: {
        this.castLightning(kartId);
        break;
      }

      case ItemType.Ghost: {
        inv.ghostTime = GHOST_TIME;
        this.karts.setKartAlpha?.(kartId, 0.28);
        this.stealItem(kartId);
        this.sfx('boo', k.position);
        break;
      }

      case ItemType.Bullet: {
        inv.bulletTime = BULLET_TIME;
        this.physics.applyBoost?.(kartId, BULLET_TIME, 2.1, 'item');
        bus.emit('camera:mode', { mode: 'bullet' });
        this.vfx.burst?.('bulletLaunch', k.position, undefined, 1.5);
        if (this.isPlayer(kartId)) this.vfx.screenShake?.(0.6, 0.35);
        this.sfx('bullet_start', k.position);
        break;
      }

      case ItemType.Coin: {
        inv.coins = Math.min(MAX_COINS, inv.coins + 1);
        this.physics.setCoinBonus?.(kartId, inv.coins);
        this.physics.applyBoost?.(kartId, 0.35, 1.06, 'item');
        this.vfx.burst?.('coin', k.position, undefined, 0.8);
        this.sfx('coin', k.position);
        break;
      }

      case ItemType.Squid: {
        this.castSquidInk(kartId);
        break;
      }
    }

    bus.emit('item:used', { kartId, item });
    this.consume(kartId, inv);
  }

  private castLightning(sourceId: number): void {
    const list = this.karts.karts;
    const src = this.kart(sourceId);
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k.id === sourceId) continue;
      const inv = this.inv[k.id];
      if (!inv) continue;
      if (this.isImmune(k.id)) continue;
      // Further back = shorter punishment, exactly like MK8.
      const pos = k.racePosition > 0 ? k.racePosition : list.length;
      const dur = lerp(SHRINK_TIME, SHRINK_TIME * 0.55, clamp01((pos - 1) / Math.max(1, list.length - 1)));
      inv.shrinkTime = dur;
      this.physics.applyStun?.(k.id, 1.05, 'shock');
      this.physics.setScale?.(k.id, 0.58);
      this.karts.setKartScale?.(k.id, 0.58);
      this.dropItemOnHit(k.id);
      bus.emit('item:hit', { targetId: k.id, sourceId, item: ItemType.Lightning, point: k.position });
      this.vfx.burst?.('lightning', k.position, undefined, 1.2);
    }
    this.lightningCd = LIGHTNING_COOLDOWN;
    this.vfx.flash?.(0xffffff, 1.0, 0.36);
    this.vfx.screenShake?.(0.7, 0.4);
    bus.emit('ui:message', { text: 'LIGHTNING!', seconds: 1.4, style: 'warn' });
    this.sfx('lightning', src?.position, 1.0);
  }

  private castSquidInk(sourceId: number): void {
    const list = this.karts.karts;
    const me = this.kart(sourceId);
    if (!me) return;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k.id === sourceId) continue;
      if (k.progress <= me.progress) continue;
      if (this.isImmune(k.id)) continue;
      const inv = this.inv[k.id];
      if (!inv) continue;
      inv.inkTime = INK_TIME;
      bus.emit('item:hit', { targetId: k.id, sourceId, item: ItemType.Squid, point: k.position });
      this.vfx.burst?.('ink', k.position, undefined, 1.1);
      n++;
    }
    if (n > 0) this.sfx('squid', me.position);
  }

  /** Boo steals from a random kart ahead that actually has something. */
  private stealItem(thiefId: number): void {
    const list = this.karts.karts;
    const me = this.kart(thiefId);
    const thief = this.inv[thiefId];
    if (!me || !thief) return;
    let bestId = -1;
    let seen = 0;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k.id === thiefId || k.progress <= me.progress) continue;
      const inv = this.inv[k.id];
      if (!inv || inv.item === null) continue;
      // Reservoir sample so every candidate is equally likely.
      seen++;
      if (this.rng.next() < 1 / seen) bestId = k.id;
    }
    if (bestId < 0) return;
    const victim = this.inv[bestId];
    if (!victim || victim.item === null) return;
    const stolen = victim.item;
    this.clearOrbit(victim);
    this.setItem(bestId, victim, null);
    // Boo is still active, so queue the stolen item as the thief's next item.
    thief.item = stolen;
    thief.count = itemUses(stolen);
    const k = this.kart(thiefId);
    if (k) { k.heldItem = stolen; k.itemCount = thief.count; }
    if (TRIPLE_ITEMS.has(stolen)) this.spawnOrbit(thiefId, thief, stolen);
    bus.emit('item:granted', { kartId: thiefId, item: stolen, count: thief.count });
    bus.emit('ui:message', { text: `STOLE ${ITEM_NAMES[stolen].toUpperCase()}!`, seconds: 1.2 });
  }

  /** Getting hit makes you drop whatever you were holding. */
  private dropItemOnHit(kartId: number): void {
    const inv = this.inv[kartId];
    if (!inv) return;
    this.clearOrbit(inv);
    if (inv.item !== null) this.setItem(kartId, inv, null);
    this.roulette.cancel(kartId);
  }

  private onProjectileHit(targetId: number, sourceId: number, item: ItemType, at: THREE.Vector3): void {
    this.dropItemOnHit(targetId);
    this.sfx(item === ItemType.Bomb || item === ItemType.BlueShell ? 'explosion' : 'item_hit', at);
    if (this.isPlayer(targetId)) {
      this.vfx.screenShake?.(0.55, 0.3);
      this.vfx.flash?.(0xff8844, 0.2, 0.15);
    }
    void sourceId;
  }

  // -------------------------------------------------------------------------
  // Visual step
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    if (!this.ready) return;
    this.elapsed += ctx.dt;
    this.models.syncEnvironment(this.scene);
    this.boxes.update(ctx.dt);
    this.projectiles.update(ctx.dt, this.elapsed);
    this.hazards.update(ctx.dt, this.elapsed);
    this.updateOrbitVisuals(ctx.dt);
  }

  private updateOrbitVisuals(dt: number): void {
    const list = this.karts.karts;
    for (let i = 0; i < list.length; i++) {
      const inv = this.inv[list[i].id];
      if (!inv || inv.orbit.length === 0) continue;
      for (const p of inv.orbit) {
        if (!p.active) continue;
        p.node.position.copy(p.pos);
        p.node.rotation.y += dt * 5.5;
        p.node.rotation.z = Math.sin(this.elapsed * 3 + p.id) * 0.08;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private kart(id: number): KartState | null {
    const list = this.karts.karts;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  private isPlayer(id: number): boolean {
    const p = this.karts.player;
    if (p) return p.id === id;
    const k = this.kart(id);
    return !!k && k.isPlayer;
  }

  private anyBulletActive(): boolean {
    for (const inv of this.inv) if (inv.bulletTime > 0) return true;
    return false;
  }

  /** Kart forward (-Z of its orientation) into `out`. */
  private forwardOf(k: KartState, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, -1).applyQuaternion(k.groundQuaternion ?? k.quaternion);
    if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
    return out.normalize();
  }

  // -------------------------------------------------------------------------

  /** Wipe inventories, projectiles and boxes — used between races. */
  reset(): void {
    for (let i = 0; i < this.inv.length; i++) {
      const inv = this.inv[i];
      inv.orbit.length = 0;
      inv.item = null; inv.count = 0; inv.holdTime = 0; inv.buttonDown = false;
      inv.starTime = 0; inv.bulletTime = 0; inv.ghostTime = 0;
      inv.inkTime = 0; inv.shrinkTime = 0; inv.coins = 0; inv.fireLatch = false;
    }
    this.roulette.reset();
    this.projectiles.clear();
    this.boxes.reset();
    this.lightningCd = 0;
    this.blueCd = 0;
    for (const k of this.karts.karts) { k.heldItem = null; k.itemCount = 0; }
  }

  dispose(): void {
    this.projectiles.dispose();
    this.boxes.dispose();
    this.hazards.dispose();
    this.models.dispose();
    this.ready = false;
  }
}

// Re-exported so the HUD / AI / dev harness can type against them without
// reaching into the module internals.
export type { ThreatInfo, Projectile, ProjKind, TrackLike, KartsLike, PhysicsLike, VfxLike } from './Projectiles';
export { MODEL_FOR_ITEM, ITEM_NAMES } from './ItemModels';
export default ItemSystem;
