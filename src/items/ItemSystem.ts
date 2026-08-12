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
import { ItemBoxField, ITEM_BOX_LIFT, type BoxSpawn } from './ItemBox';
import {
  ItemRoulette, itemUses, rollItem, tableRow, weightsFor,
  BLUE_SHELL_COOLDOWN, LIVE_ITEMS, type RollContext,
} from './ItemRoulette';
import {
  Projectiles, type KartsLike, type PhysicsLike, type ProjKind, type Projectile,
  type ThreatInfo, type TrackLike, type VfxLike,
} from './Projectiles';
import { Hazards } from './Hazards';

const MAX_KARTS = 16;
const STAR_TIME = 7.5;
const BULLET_TIME = 7.0;
/**
 * Ninja cloak, seconds. The Ninja's *ability* is the steal, which is instant;
 * the cloak is the vanishing-in-smoke read that makes the steal legible.
 */
const GHOST_TIME = 6.0;
/** Retained only so the deprecated `getInkAmount()` still normalises. */
const INK_TIME = 4.5;
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
  /** Present on the real `Track`; used to notice a circuit swap. */
  readonly trackId?: string;
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

  private blueCd = 0;
  private ready = false;
  private elapsed = 0;
  /** Circuit identity at the last (re)build, so a swap can be detected. */
  private trackTag = '';
  private trackLap = 0;

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
        fireLatch: false,
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
    this.poseHazards();
    this.noteTrack();
    this.ready = true;
  }

  /**
   * Pose the hazard nodes the moment they are built.
   *
   * Same defect as the item boxes had (see the long note in `ItemBox.setSpawns`):
   * `Hazards.init()` / `.rebuild()` create their nodes at the default transform and
   * leave `update()` to place them. A node at the default transform sits at world
   * (0, 0, 0), which on all three circuits IS the start/finish line with the road
   * at y ≈ 0 — so an unposed boulder or fireball is a half-sunk lump on the line.
   * Measured as built (`.probe-tmp/p0g-line.ts`): 25 nodes on Coastal up to 100 %
   * under the tarmac at 15–25 px, 4 on Volcano at 33 px.
   *
   * `update(0, 0)` advances no animation state — `Hazards.fixedUpdate` owns the
   * phase — so this only writes the transform the first frame would have written.
   * Done from here rather than inside `Hazards.ts`, which this agent does not own.
   */
  private poseHazards(): void {
    this.hazards.update(0, 0);
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
    // Fallback rows, used only when the track has no authored spawns yet.
    //
    // Two bugs lived here. The lift was 1.35 m, but the box is BOX_SIZE = 1.72
    // and it tumbles and bobs, so its lowest point reaches 1.3164 m below centre
    // (measured — see ITEM_BOX_LIFT) — at 1.35 m a fallback box had 3 cm of
    // clearance on flat road and cut the tarmac on any crown. The authored path
    // in TrackBuilder already uses 1.70 m; these must agree.
    //
    // P0d-D3: BOTH paths are now measured on all three circuits by
    // `.probe-tmp/boxclear.ts`. Worst clearance anywhere, at the animation
    // extreme, against the road MESH as well as the analytic surface: 0.279 m
    // authored / 0.301 m fallback. No box is buried on any circuit.
    //
    // It also emitted lap/200 rows (8 on a 1610 m lap) of 5, i.e. 40 boxes —
    // more than the authored layout. Density is now deliberately sparse: a
    // fallback is a safety net, not a level design.
    const rows = Math.max(2, Math.min(3, Math.round(lap / 550)));
    for (let r = 0; r < rows; r++) {
      const d = ((r + 0.5) / rows) * lap;
      const s = this.track.sampleAtDistance(wrap(d, lap));
      if (!s) continue;
      const halfW = Math.max(4, s.halfWidth - 2.6);
      for (let i = 0; i < 3; i++) {
        const lat = ((i - 1) / 1) * halfW * 0.6;
        out.push({
          position: new THREE.Vector3()
            .copy(s.position)
            .addScaledVector(s.binormal, lat)
            .addScaledVector(s.normal, ITEM_BOX_LIFT),
          normal: s.normal.clone(),
        });
      }
    }
    return out;
  }

  /**
   * Re-read everything that is authored per circuit. Call after a track swap.
   *
   * P0d-D1: this used to refresh the box field ONLY. `Hazards.init()` runs once,
   * against whichever circuit happened to be loaded at boot, and nothing ever
   * rebuilt it — so a race on Neon Metropolis or Volcano Rush ran *Sunset
   * Coastline's* hazard list re-projected onto the new spline by arc length.
   * Wrong kinds, wrong places, and on a shorter lap two of them could land in
   * the same span, which is one plausible source of the "two boulders at once"
   * report.
   */
  refreshBoxSpawns(): void {
    this.boxes.setSpawns(this.resolveBoxSpawns());
    // Rebuild hazards ONLY on a real circuit change. A rebuild re-generates a
    // 512² boulder albedo and a 256² normal map, so doing it on every `restart()`
    // would put a visible hitch on the grid for no gain.
    if (this.trackChanged()) {
      this.hazards.rebuild();
      this.poseHazards();
    }
    this.noteTrack();
  }

  /** Latch the current circuit's identity so `fixedUpdate` can spot a swap. */
  private noteTrack(): void {
    this.trackTag = this.track.trackId ?? '';
    this.trackLap = typeof this.track.lapLength === 'number' ? this.track.lapLength : 0;
  }

  /**
   * Has the track been swapped without anybody telling us? Two comparisons, no
   * allocation, so this is safe to run every fixed step. A caller that forgets
   * `refreshBoxSpawns()` then costs one frame of stale layout instead of a whole
   * race of it.
   */
  private trackChanged(): boolean {
    const tag = this.track.trackId ?? '';
    const lap = typeof this.track.lapLength === 'number' ? this.track.lapLength : 0;
    return tag !== this.trackTag || Math.abs(lap - this.trackLap) > 0.5;
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
  /**
   * @deprecated Coins are removed from the game (P0d follow-up). Always 0.
   *
   * Kept as a stub for exactly one reason: `HUD` and `Minimap` feature-detect
   * this on the race/items object (`tryCall(this.race, 'getCoins', id)`), and a
   * missing method and a method returning 0 are indistinguishable to them — but
   * a *thrown* one is not. Removing the counter is the HUD's job; publishing a
   * truthful 0 here is ours.
   */
  getCoins(_kartId: number): number { return 0; }
  /**
   * 0..1 squid-ink screen coverage.
   *
   * @deprecated P0d-D5 removed Ink from the item set, so this is now always 0.
   * Kept because it is part of the published ItemSystem surface and callers
   * feature-detect it; 0 is the correct "no effect" answer for them. The
   * `ink` VFX impact and the `squid` SFX entry are now unreachable — see the
   * note above `use()`.
   */
  getInkAmount(kartId: number): number {
    const v = this.inv[kartId]?.inkTime ?? 0;
    if (v <= 0) return 0;
    return clamp01(Math.min(1, (INK_TIME - v) * 6)) * clamp01(v / 1.0);
  }
  /**
   * 0..1 lightning shrink amount.
   *
   * @deprecated P0d-D5 removed Lightning, so this is now always 0. See above.
   */
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
  /**
   * Can this kart be hurt right now?
   *
   * The single question every damage path in the items subsystem asks. Four
   * independent sources of immunity, deliberately OR-ed rather than collapsed:
   *
   *  - `starTime`  — P0d-D5: Star now ignores ALL item attacks AND obstacles.
   *  - `bulletTime`— Bullet Bill is on rails and cannot be interrupted.
   *  - `ghostTime` — the Ninja is cloaked.
   *  - `invulnerable` — published by physics. Covers the respawn drop-in AND
   *    P0d-D1's post-hit forgiveness window (`POST_HIT_GRACE`), which is what
   *    breaks the hazard stun-lock.
   *
   * `Hazards.contact()` asks `KartState` directly for the same four (it has no
   * inventory), and `KartPhysics.applyStunTo` refuses on `invulnTime` /
   * `starTime` as a final backstop. Three layers, so a new damage path added by
   * a future agent cannot silently bypass Star.
   */
  isImmune(kartId: number): boolean {
    const inv = this.inv[kartId];
    if (inv && (inv.starTime > 0 || inv.bulletTime > 0 || inv.ghostTime > 0)) return true;
    const k = this.kart(kartId);
    return !!k && (k.invulnerable || k.starTime > 0);
  }

  /** The five items a box can actually produce. Read-only; for tooling/HUD. */
  liveItems(): readonly ItemType[] { return LIVE_ITEMS; }

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
    // Self-heal a circuit swap nobody announced. Two scalar compares.
    if (this.trackChanged()) this.refreshBoxSpawns();
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

      // `inkTime` / `shrinkTime` no longer have a writer (Ink and Lightning are
      // gone). Nothing ticks them, so both stay 0 for the whole race.
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

  /**
   * Fire the held item.
   *
   * P0d-D5 note on the switch below. Only five arms are reachable in a race —
   * Boost (Battery), RedShell (Rocket), Banana (Plastic Bottle), Ghost (Ninja)
   * and Star. The rest survive because `grantItem()` is public: the dev harness
   * and cheats hand over any `ItemType`, and an item the roulette cannot produce
   * must still behave if it is forced.
   *
   * Three arms are now *inert*, and deliberately so:
   *
   *   - `Lightning` was the only caller of `physics.applyStun(..., 'shock')`, so
   *     the `shock` stun kind now has no source anywhere in the game. The kind
   *     itself stays in `StunKind` (it costs nothing, `src/core/*` is off limits
   *     to this agent, and the visual-shrink branch in KartPhysics is harmless).
   *   - `Squid` was the only caller of `vfx.burst('ink')` and `sfx('squid')`.
   *   - `Coin` was the only caller of `vfx.burst('coin')` and `sfx('coin')`.
   *
   * ---------------------------------------------------------------------------
   * WHAT THE COIN WAS ACTUALLY DOING — and it was less than it looked
   * ---------------------------------------------------------------------------
   * Owner: *"You can remove the coin item — it doesn't do much."* Correct, and
   * the mechanical half was already dead:
   *
   *   - `physics.setCoinBonus?.(kartId, coins)` — the MK-style "coins raise your
   *     top speed" hook. **`PhysicsWorld` never implemented it.** It was declared
   *     optional on `PhysicsLike` and called with `?.`, so every coin collected
   *     since the method was written has silently done nothing to top speed.
   *     Coins carried NO speed balance to preserve, so removing them changes no
   *     pace anywhere. (Same shape of defect as the three dead mechanics in P0.)
   *   - a 0.35 s / x1.06 boost — worth +0.4 m/s of soft cap for a third of a
   *     second, i.e. below the noise floor of the drag term.
   *   - `inv.coins`, capped at 10, read only by the HUD counter, now removed.
   *
   * `ItemRoulette` already gave the coin weight 0 in every row, so no box has
   * been able to produce one since P0d-D5 either.
   *
   * The ORPHANED EFFECT CODE IS LEFT IN PLACE, unreferenced, in the files that
   * own it (`VfxManager`'s `ink`/`coin` impacts, `ImpactEffects.coin`,
   * `SfxBank`'s `squid`/`lightning`/`coin` entries, `AudioEngine`'s
   * `ItemType.Coin` arm, `AIDriver`'s `ItemType.Coin` case — which shares a
   * `default` branch and so needs no change at all). Those all belong to other
   * agents, and an unreferenced branch in a switch costs nothing at runtime,
   * whereas a half-removed effect that a future item wants back is a merge
   * conflict. Flagged in the handoff instead.
   */
  private use(kartId: number, inv: Inventory, mode: AimMode): void {
    const item = inv.item;
    if (item === null) return;
    const k = this.kart(kartId);
    if (!k || k.finished) return;
    inv.fireLatch = true;
    this.forwardOf(k, _fwd);

    // Bottles trail behind by default; rockets and bombs go forward.
    const defaultBack = item === ItemType.Banana || item === ItemType.TripleBanana;
    const backwards = mode === 'back' ? true : mode === 'forward' ? false : defaultBack;

    switch (item) {
      /**
       * BATTERY — instant speed boost. **2.10 s @ strength 1.60.**
       *
       * Owner, P0d follow-up: *"the battery gives acceleration but feels too
       * weak."* It was 1.60 s @ 1.35, and measured against the boost it has to
       * beat — a purple mini-turbo, which a competent player earns several times
       * a lap for free — that was the problem, not the absolute number:
       *
       *   source              dur    str   soft cap   peak    gain   dist@4s
       *   mini-turbo tier 3   1.39s  1.09   40.7 m/s  52.2  +24.02   +19.9 m
       *   boost pad           0.90s  1.00   39.7 m/s  46.0  +17.78   +10.6 m
       *   BATTERY was         1.60s  1.35   43.6 m/s  59.4  +31.17   +29.4 m
       *   BATTERY now         2.10s  1.60   46.3 m/s  66.9  +38.70   +52.7 m
       *
       * So the old battery was **1.30x** a free purple mini-turbo on peak speed
       * and only **1.48x** on ground gained. Nobody spends an item slot for that.
       * It is now 1.61x and **2.65x**. Time from press to 90 % of the gain barely
       * moves (0.90 s -> 1.02 s), so it still hits like an item rather than
       * winding up like a turbocharger. Measured on the real `PhysicsWorld`,
       * `.probe-tmp/battery.ts`.
       *
       * ⚠️ Do not read `peak` as the design target. `PHYS.boostAccel` (30 m/s^2
       * per unit strength) against `PHYS.overspeedDecay` (1.9 /s) settles at
       * `softCap + 15.8 * strength`, so EVERY boost in the game overshoots its
       * own soft cap by ~17 m/s — a purple mini-turbo reaches 52 m/s against a
       * 40.7 cap. That is a shared property of the boost model in
       * `src/physics/KartPhysics.ts`, flagged for its owner; the soft cap is the
       * number this tuning is authored against.
       *
       * The punch is not only numeric. A boost that reads as weak is partly a
       * presentation bug, so the burst is bigger and the player gets the same
       * shake-and-flash treatment the Bullet gets, at about half strength.
       */
      case ItemType.Boost:
      case ItemType.TripleBoost: {
        this.physics.applyBoost?.(kartId, 2.1, 1.6, 'item');
        this.vfx.burst?.('boost', k.position, undefined, 1.45);
        if (this.isPlayer(kartId)) {
          this.vfx.screenShake?.(0.32, 0.22);
          this.vfx.flash?.(0xfff0c0, 0.14, 0.12);
        }
        this.sfx('mushroom', k.position);
        break;
      }

      // ROCKET (red) — homes on the kart ahead. Green shell is unreachable.
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

      // PLASTIC BOTTLE — a small obstacle, dropped behind by default.
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

      /**
       * STAR — P0d-D5 upgraded this from "ignores items" to "ignores EVERYTHING".
       *
       * No code is needed here to make that true, which is worth spelling out so
       * nobody adds a second mechanism later. `k.starTime` is what every damage
       * path already consults:
       *
       *   items    → `isImmune()`      → `Projectiles.strike()` / `starContacts()`
       *   hazards  → `Hazards.contact()` reads `KartState.starTime` directly
       *   physics  → `applyStunTo()` refuses while `state.starTime > 0`
       *
       * Before this pass the only gap was hazards, and there wasn't one: the
       * `starTime` check was already in `contact()`. What was NOT true is the
       * claim in reverse — a hazard could re-hit a NON-starred kart forever
       * (see D1). Verified by probe, not by reading: `.probe-tmp/d1d5.ts` fires
       * every remaining item and every hazard kind at a starred kart and asserts
       * zero stuns.
       *
       * Note we deliberately do NOT also call `physics.setInvulnerable()` here.
       * It would work, but `KartState.invulnerable` drives KartManager's
       * damage-blink, and strobing the kart's opacity for 7.5 s fights the star's
       * own rainbow tint.
       */
      case ItemType.Star: {
        inv.starTime = STAR_TIME;
        k.starTime = STAR_TIME;
        this.physics.applyBoost?.(kartId, STAR_TIME, 1.18, 'item');
        this.vfx.burst?.('starPop', k.position, undefined, 1.4);
        if (this.isPlayer(kartId)) this.vfx.flash?.(0xfff0a0, 0.3, 0.2);
        this.sfx('star_start', k.position);
        break;
      }

      // INK — removed from the item set. Unreachable; see the note above.
      case ItemType.Squid:
      // LIGHTNING — removed from the item set. Unreachable; see the note above.
      case ItemType.Lightning:
        break;

      // NINJA — steals an item from a racer ahead, and vanishes while doing it.
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

      // COIN — removed from the game. Unreachable; see the note above.
      case ItemType.Coin:
        break;
    }

    bus.emit('item:used', { kartId, item });
    this.consume(kartId, inv);
  }

  /**
   * The Ninja steals from a random kart ahead that actually has something.
   *
   * Reservoir-sampled so every candidate is equally likely, and the theft lands
   * as the thief's *next* item rather than replacing the cloak they are using.
   */
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
    // The cloak is still running, so queue the stolen item as the next one.
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

  /**
   * Is any kart currently riding a Bullet Bill?
   *
   * Was a roulette gate ("only one bullet at a time"). The Bullet is no longer in
   * the item set, so nothing gates on it — kept public-ish for the dev harness
   * and because `grantItem()` can still force one.
   */
  anyBulletActive(): boolean {
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
      inv.inkTime = 0; inv.shrinkTime = 0; inv.fireLatch = false;
    }
    this.roulette.reset();
    this.projectiles.clear();
    this.boxes.reset();
    this.hazards.resetTimers();
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
