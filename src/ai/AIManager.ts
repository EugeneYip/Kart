/**
 * ============================================================================
 *  APEX KART — AI MANAGER
 * ============================================================================
 *  Owns the racing line, one `AIDriver` per computer-controlled kart, and the
 *  rubber-band. Registered by `Game` between physics and items:
 *
 *      fixedUpdate: physics -> AI -> items -> race
 *
 *  DEFENSIVE BY DESIGN
 *  -------------------
 *  Every other subsystem is authored in parallel with this one, so nothing here
 *  may assume a method exists. `karts`, `items` and `physics` arrive as opaque
 *  objects and are adapted at wire time by `resolve*()`, which probes for the
 *  documented method names (and a couple of plausible aliases) with `typeof`.
 *  The probe result is cached, so the per-tick path is a direct call with no
 *  reflection at all.
 *
 *  That is also why the constructor parameters are typed `object` rather than
 *  the concrete classes: this file must compile before `KartManager`,
 *  `ItemSystem` and `PhysicsWorld` exist, and must keep compiling whatever
 *  signatures they end up with. The shapes we *hope* for are documented as
 *  `AIKartRegistry` / `AIItemProvider` / `AIControlSink` below.
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem, ITrackService, KartState } from '@/core/Types';
import { ItemType } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { clamp01 } from '@/core/MathUtils';

import { RacingLine, type LineVariant, type ShortcutSpec } from './RacingLine';
import {
  AIDriver,
  NULL_ITEMS,
  createHazard,
  type AIControl,
  type AIDebugState,
  type AIHazard,
  type DriverWorld,
  type ItemAccess,
} from './AIDriver';
import {
  PERSONALITIES,
  personalityForKart,
  personalityById,
  type PersonalityId,
} from './AIPersonality';
import { Rubberband, createBandOutput, type CCClass } from './Rubberband';

// ---------------------------------------------------------------------------
//  Documented (hoped-for) shapes of our collaborators.
//  These are reference documentation for the runtime probes below — the
//  constructor deliberately accepts `object` so that any concrete signature
//  compiles.
// ---------------------------------------------------------------------------

/** What we look for on the kart manager. First hit wins. */
export interface AIKartRegistry {
  /** Preferred: an array of `KartState`, or of wrappers with a `.state`. */
  karts?: readonly unknown[];
  states?: readonly KartState[];
  getStates?: () => readonly KartState[];
  getKarts?: () => readonly unknown[];
}

/** What we look for on the item system. */
export interface AIItemProvider {
  getHeldItem?: (kartId: number) => ItemType | null;
  requestUse?: (kartId: number, opts?: unknown) => unknown;
  getIncomingThreat?: (kartId: number) => unknown;
  getHazards?: () => readonly unknown[];
  getObstacles?: () => readonly unknown[];
  setHold?: (kartId: number, held: boolean) => void;
}

/** What we look for on the physics world. */
export interface AIControlSink {
  setControl?: (kartId: number, control: AIControl) => void;
  requestRespawn?: (kartId: number) => void;
  getTurnRate?: (kartId: number) => number;
}

// ---------------------------------------------------------------------------
//  Reflection helpers — no `any`, no per-tick cost (results are cached).
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown;

function propOf(o: object | null | undefined, key: string): unknown {
  if (!o) return undefined;
  return (o as Record<string, unknown>)[key];
}

/** Find the first key on `o` whose value is a function. */
function fnOf(o: object | null | undefined, keys: readonly string[]): AnyFn | null {
  if (!o) return null;
  for (const k of keys) {
    const v = propOf(o, k);
    if (typeof v === 'function') return v as AnyFn;
  }
  return null;
}

function isVec3(v: unknown): v is THREE.Vector3 {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.x === 'number' && typeof r.y === 'number' && typeof r.z === 'number';
}

/** Does this object look like a `KartState`? */
function isKartState(v: unknown): v is KartState {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'number' && isVec3(r.position) && typeof r.speed === 'number';
}

function toIterable(v: unknown): readonly unknown[] | null {
  if (Array.isArray(v)) return v as readonly unknown[];
  if (v instanceof Map) return Array.from(v.values()) as readonly unknown[];
  if (v instanceof Set) return Array.from(v.values()) as readonly unknown[];
  return null;
}

// ---------------------------------------------------------------------------

export interface AIManagerOptions {
  /** Stations used by the racing line optimiser. */
  stations?: number;
  /** Lateral acceleration budget for the speed profile, m/s². */
  latAccel?: number;
  /** Top speed the line profile will ever ask for, m/s. */
  maxSpeed?: number;
  /** Start with the rubber band off (for benchmarking). */
  rubberband?: boolean;
}

export class AIManager implements ISubsystem {
  readonly rubberband = new Rubberband();

  private readonly track: ITrackService;
  private readonly kartSource: object | null;
  private itemSource: object | null;
  private physicsSource: object | null = null;

  private line: RacingLine | null = null;
  private readonly options: AIManagerOptions;

  private readonly drivers = new Map<number, AIDriver>();
  private readonly explicitlyDisabled = new Set<number>();
  private readonly overrides = new Map<number, PersonalityId>();

  /** Resolved kart states, refreshed when the roster changes. */
  private states: KartState[] = [];
  private stateSignature = '';
  private resolveCooldown = 0;

  // Cached collaborator entry points.
  private setControlFn: AnyFn | null = null;
  private respawnFn: AnyFn | null = null;
  private itemAccess: ItemAccess = NULL_ITEMS;

  // Reusable world context + hazard pool (zero allocation per tick).
  private readonly world: DriverWorld;
  private readonly hazardPool: AIHazard[] = [];
  private readonly band = createBandOutput();
  private readonly debugList: AIDebugState[] = [];

  private raceStarted = true;
  private countdown = 0;
  private cc: CCClass = 150;
  private elapsed = 0;
  private unsubscribes: Array<() => void> = [];

  /**
   * @param track  the track service (`ITrackService`)
   * @param karts  the kart manager — probed for a `KartState` collection
   * @param items  the item system — optional, probed for item hooks
   */
  constructor(track: ITrackService, karts: object, items?: object, options: AIManagerOptions = {}) {
    this.track = track;
    this.kartSource = karts ?? null;
    this.itemSource = items ?? null;
    this.options = options;
    if (options.rubberband === false) this.rubberband.setEnabled(false);

    for (let i = 0; i < 48; i++) this.hazardPool.push(createHazard());

    this.world = {
      // `line` is filled in by init(); a placeholder keeps the type honest.
      line: null as unknown as RacingLine,
      karts: this.states,
      hazards: this.hazardPool,
      hazardCount: 0,
      elapsed: 0,
      raceStarted: true,
      countdown: 0,
      playerProgress: -1,
      playerId: -1,
      lapLength: 1000,
      fieldSize: 12,
      cc: this.rubberband.profile(),
    };
  }

  // -------------------------------------------------------------------------
  //  Lifecycle
  // -------------------------------------------------------------------------

  init(): void {
    const t0 =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : 0;
    this.line = new RacingLine(this.track, {
      stations: this.options.stations ?? 600,
      latAccel: this.options.latAccel ?? 30,
      maxSpeed: this.options.maxSpeed ?? 36,
    });
    this.line.build();
    this.world.line = this.line;
    this.world.lapLength = this.line.lapLength;
    const t1 =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : 0;
    if (t1 > t0) {
      const s = this.line.stats();
      console.info(
        `[AI] racing line: ${s.stations} stations, ${s.optimalLength.toFixed(1)} m ` +
          `(centre ${s.centreLength.toFixed(1)} m), v ${s.minSpeed.toFixed(1)}–` +
          `${s.maxSpeed.toFixed(1)} m/s, built in ${(t1 - t0).toFixed(1)} ms`,
      );
    }

    this.resolveItems();
    this.resolveStates(true);

    // Ground truth for mini-turbo accounting + race flow.
    this.unsubscribes.push(
      bus.on('kart:driftRelease', (p) => {
        this.drivers.get(p.kartId)?.notifyDriftRelease(p.tier, p.boostTime);
      }),
    );
    this.unsubscribes.push(
      bus.on('race:countdown', (p) => {
        this.raceStarted = false;
        this.countdown = Math.max(0, p.count);
      }),
    );
    this.unsubscribes.push(
      bus.on('race:start', () => {
        this.raceStarted = true;
        this.countdown = 0;
        this.rubberband.reset();
      }),
    );
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.drivers.clear();
    this.states = [];
    this.line = null;
  }

  // -------------------------------------------------------------------------
  //  Wiring (called by Game via the guarded `wire()` helper)
  // -------------------------------------------------------------------------

  /** Game.ts calls this once `PhysicsWorld` exists. */
  setPhysics(physics: object): void {
    this.physicsSource = physics ?? null;
    this.setControlFn = fnOf(this.physicsSource, ['setControl', 'setControls', 'setInput', 'applyControl']);
    this.respawnFn = fnOf(this.physicsSource, ['requestRespawn', 'respawn', 'respawnKart']);
    if (!this.setControlFn) {
      console.warn('[AI] physics has no setControl() — AI cannot drive.');
    }
  }

  /** Game.ts calls this once `ItemSystem` exists. */
  setItems(items: object): void {
    this.itemSource = items ?? null;
    this.resolveItems();
    for (const d of this.drivers.values()) d.setItems(this.itemAccess);
  }

  /** 50 / 100 / 150 / 200 cc. Rescales every driver's skill profile. */
  setDifficulty(cc: CCClass): void {
    this.cc = CC_VALID.has(cc) ? cc : 150;
    this.rubberband.setCC(this.cc);
    const profile = this.rubberband.profile();
    this.world.cc = profile;
    for (const d of this.drivers.values()) d.setCCProfile(profile);
  }

  get difficulty(): CCClass {
    return this.cc;
  }

  /** Disable a kart (the player's is disabled automatically). */
  setEnabled(kartId: number, enabled: boolean): void {
    if (enabled) this.explicitlyDisabled.delete(kartId);
    else this.explicitlyDisabled.add(kartId);
    const d = this.drivers.get(kartId);
    if (d) {
      d.enabled = enabled;
      if (!enabled) {
        d.reset();
        this.sendControl(kartId, d.control);
      }
    }
  }

  isEnabled(kartId: number): boolean {
    return this.drivers.get(kartId)?.enabled ?? false;
  }

  /** Force a personality (menus, debug, "rival = the character you beat"). */
  setPersonality(kartId: number, id: PersonalityId): void {
    if (!PERSONALITIES[id]) return;
    this.overrides.set(kartId, id);
    const d = this.drivers.get(kartId);
    if (d) d.setPersonality(PERSONALITIES[id], this.rubberband.profile());
  }

  /** Tell the AI about a shortcut so they can choose it situationally. */
  declareShortcut(spec: ShortcutSpec): void {
    this.line?.declareShortcut(spec);
  }

  /** Race flow, for harnesses that have no RaceDirector. */
  setRaceStarted(started: boolean, countdown = 0): void {
    this.raceStarted = started;
    this.countdown = countdown;
  }

  resetRace(): void {
    this.rubberband.reset();
    this.elapsed = 0;
    for (const d of this.drivers.values()) d.reset();
  }

  // -------------------------------------------------------------------------
  //  The tick
  // -------------------------------------------------------------------------

  fixedUpdate(ctx: FrameContext): void {
    const line = this.line;
    if (!line) return;
    const dt = ctx.fixedDt > 0 ? ctx.fixedDt : 1 / 120;
    this.elapsed += dt;

    this.resolveCooldown -= dt;
    if (this.resolveCooldown <= 0) {
      this.resolveCooldown = 0.5;
      this.resolveStates(false);
    }
    if (this.states.length === 0) return;

    // --- world context ----------------------------------------------------
    const w = this.world;
    w.elapsed = this.elapsed;
    w.raceStarted = this.raceStarted;
    w.countdown = this.countdown;
    w.fieldSize = this.states.length;
    w.lapLength = line.lapLength;
    w.cc = this.rubberband.profile();
    w.hazardCount = this.collectHazards();

    // Player reference for the rubber band.
    let playerProgress = -1;
    let playerId = -1;
    for (let i = 0; i < this.states.length; i++) {
      const s = this.states[i];
      if (s.isPlayer) {
        playerProgress = s.progress;
        playerId = s.id;
        break;
      }
    }
    w.playerProgress = playerProgress;
    w.playerId = playerId;

    this.rubberband.tick(dt, this.raceStarted);

    // --- drive ------------------------------------------------------------
    for (let i = 0; i < this.states.length; i++) {
      const st = this.states[i];
      const d = this.drivers.get(st.id);
      if (!d) continue;
      if (st.isPlayer) {
        // Never fight the human for control.
        if (d.enabled) {
          d.enabled = false;
          d.reset();
        }
        continue;
      }
      if (!d.enabled) continue;
      if (st.finished) {
        // Ease off after the flag but keep driving so they clear the line.
        d.step(dt, w, this.band);
        this.sendControl(st.id, d.control);
        continue;
      }

      const gap =
        playerProgress >= 0 ? (st.progress - playerProgress) * line.lapLength : 0;
      this.rubberband.evaluate(
        st.id,
        gap,
        st.racePosition > 0 ? st.racePosition : i + 1,
        d.personality.matchesPlayer > 0.5,
        dt,
        this.band,
      );
      const ctrl = d.step(dt, w, this.band);
      this.sendControl(st.id, ctrl);

      // Long-term stuck: ask for a respawn rather than sit there forever.
      if (d.recoverySeconds > 5.5 && this.respawnFn) {
        try {
          this.respawnFn.call(this.physicsSource, st.id);
        } catch {
          /* physics may not support it */
        }
        d.reset();
      }
    }
  }

  private sendControl(kartId: number, ctrl: AIControl): void {
    const fn = this.setControlFn;
    if (!fn) return;
    try {
      fn.call(this.physicsSource, kartId, ctrl);
    } catch (err) {
      // One bad call must not kill the whole field.
      this.setControlFn = null;
      console.error('[AI] setControl failed, disabling AI control:', err);
    }
  }

  // -------------------------------------------------------------------------
  //  Resolution of collaborators
  // -------------------------------------------------------------------------

  /** Discover the `KartState` list and create/retire drivers to match. */
  private resolveStates(force: boolean): void {
    const src = this.kartSource;
    let raw: readonly unknown[] | null = null;

    if (src) {
      raw = toIterable(propOf(src, 'karts'));
      if (!raw) raw = toIterable(propOf(src, 'states'));
      if (!raw) raw = toIterable(propOf(src, 'all'));
      if (!raw) {
        const getter = fnOf(src, ['getStates', 'getKarts', 'getAll']);
        if (getter) {
          try {
            raw = toIterable(getter.call(src));
          } catch {
            raw = null;
          }
        }
      }
      // The source might itself be the array.
      if (!raw) raw = toIterable(src);
    }
    if (!raw) return;

    const next: KartState[] = [];
    for (const entry of raw) {
      if (isKartState(entry)) {
        next.push(entry);
        continue;
      }
      const inner = propOf(entry as object, 'state');
      if (isKartState(inner)) next.push(inner);
    }

    let signature = '';
    for (const s of next) signature += `${s.id}/${s.isPlayer ? 1 : 0},`;
    if (!force && signature === this.stateSignature) return;
    this.stateSignature = signature;

    this.states.length = 0;
    for (const s of next) this.states.push(s);
    this.world.karts = this.states;

    // Create drivers for anyone new.
    const profile = this.rubberband.profile();
    const seen = new Set<number>();
    for (const st of this.states) {
      seen.add(st.id);
      let d = this.drivers.get(st.id);
      if (!d) {
        const overrideId = this.overrides.get(st.id);
        const p = overrideId
          ? personalityById(overrideId) ?? personalityForKart(st.id)
          : personalityForKart(st.id);
        d = new AIDriver(st.id, p, profile);
        d.setItems(this.itemAccess);
        this.drivers.set(st.id, d);
      }
      d.setState(st);
      d.enabled = !st.isPlayer && !this.explicitlyDisabled.has(st.id);
    }
    // Retire drivers whose karts vanished.
    for (const id of Array.from(this.drivers.keys())) {
      if (!seen.has(id)) {
        this.drivers.delete(id);
        this.rubberband.forget(id);
      }
    }
    this.rebuildDebugList();
  }

  /** Build the `ItemAccess` façade over whatever the ItemSystem exposes. */
  private resolveItems(): void {
    const src = this.itemSource;
    if (!src) {
      this.itemAccess = NULL_ITEMS;
      return;
    }
    const heldFn = fnOf(src, ['getHeldItem', 'heldItem', 'getItem']);
    const useFn = fnOf(src, ['requestUse', 'useItem', 'use', 'requestItemUse']);
    const threatFn = fnOf(src, ['getIncomingThreat', 'incomingThreat', 'getThreat']);
    const holdFn = fnOf(src, ['setHold', 'setHolding', 'requestHold']);

    const useOpts: { aimBack: boolean; target: number; backward: boolean; targetId: number } = {
      aimBack: false,
      target: -1,
      backward: false,
      targetId: -1,
    };

    this.itemAccess = {
      heldItem: (kartId: number): ItemType | null => {
        if (!heldFn) return null;
        try {
          const v = heldFn.call(src, kartId);
          return typeof v === 'number' ? (v as ItemType) : null;
        } catch {
          return null;
        }
      },
      threat: (kartId: number): number => {
        if (!threatFn) return -1;
        try {
          const v = threatFn.call(src, kartId);
          if (v === null || v === undefined || v === false) return -1;
          if (typeof v === 'number') return v >= 0 ? v : -1;
          if (v === true) return 40;
          const d = propOf(v as object, 'distance');
          return typeof d === 'number' ? d : 40;
        } catch {
          return -1;
        }
      },
      use: (kartId: number, aimBack: boolean, targetId: number): void => {
        if (!useFn) return;
        useOpts.aimBack = aimBack;
        useOpts.backward = aimBack;
        useOpts.target = targetId;
        useOpts.targetId = targetId;
        try {
          useFn.call(src, kartId, useOpts);
        } catch {
          /* item system may reject — that is fine */
        }
      },
      hold: (kartId: number, held: boolean): void => {
        if (!holdFn) return;
        try {
          holdFn.call(src, kartId, held);
        } catch {
          /* optional */
        }
      },
    };
  }

  /**
   * Copy hazards into our own pool so the AI never holds a reference into
   * another subsystem's array. Returns how many entries are valid.
   */
  private collectHazards(): number {
    const src = this.itemSource;
    if (!src) return 0;
    const getter = fnOf(src, ['getHazards', 'getObstacles', 'listHazards', 'activeHazards']);
    if (!getter) return 0;
    let raw: readonly unknown[] | null = null;
    try {
      raw = toIterable(getter.call(src));
    } catch {
      return 0;
    }
    if (!raw) return 0;
    let n = 0;
    for (const entry of raw) {
      if (n >= this.hazardPool.length) break;
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const pos = isVec3(rec.position) ? rec.position : isVec3(rec.pos) ? rec.pos : null;
      if (!pos) continue;
      const h = this.hazardPool[n];
      h.position.copy(pos);
      h.radius = typeof rec.radius === 'number' ? rec.radius : 1.2;
      h.kind = typeof rec.kind === 'string' ? rec.kind : 'hazard';
      h.ownerId = typeof rec.ownerId === 'number' ? rec.ownerId : -1;
      h.homing = rec.homing === true;
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  //  Introspection (HUD, dev harness, tests)
  // -------------------------------------------------------------------------

  get racingLine(): RacingLine | null {
    return this.line;
  }

  getDriver(kartId: number): AIDriver | undefined {
    return this.drivers.get(kartId);
  }

  get driverCount(): number {
    let n = 0;
    for (const d of this.drivers.values()) if (d.enabled) n++;
    return n;
  }

  private rebuildDebugList(): void {
    this.debugList.length = 0;
    for (const st of this.states) {
      const d = this.drivers.get(st.id);
      if (d) this.debugList.push(d.debug);
    }
  }

  /** Live per-driver debug states, in grid order. Do not mutate. */
  get debug(): readonly AIDebugState[] {
    if (this.debugList.length !== this.drivers.size) this.rebuildDebugList();
    return this.debugList;
  }

  /** Aggregate numbers for assertions. */
  stats(): {
    drivers: number;
    enabled: number;
    miniTurbos: number;
    driftAttempts: number;
    boostSeconds: number;
    offTrackSeconds: number;
    backwardsSeconds: number;
    recoverySeconds: number;
    inRecovery: number;
  } {
    let miniTurbos = 0;
    let attempts = 0;
    let boost = 0;
    let off = 0;
    let back = 0;
    let rec = 0;
    let inRec = 0;
    let enabled = 0;
    for (const d of this.drivers.values()) {
      if (!d.enabled) continue;
      enabled++;
      miniTurbos += d.miniTurboCount;
      attempts += d.driftAttemptCount;
      boost += d.boostSecondsEarned;
      off += d.offTrackSeconds;
      back += d.backwardsSeconds;
      rec += d.recoverySeconds;
      if (d.currentMode === 'reverse' || d.currentMode === 'realign') inRec++;
    }
    return {
      drivers: this.drivers.size,
      enabled,
      miniTurbos,
      driftAttempts: attempts,
      boostSeconds: boost,
      offTrackSeconds: off,
      backwardsSeconds: back,
      recoverySeconds: rec,
      inRecovery: inRec,
    };
  }

  /** Which line each driver is currently on — useful for the debug overlay. */
  variantOf(kartId: number): LineVariant {
    return this.drivers.get(kartId)?.debug.variant ?? 'optimal';
  }

  /** 0..1 how hard the field is being pushed by the band right now. */
  bandLoad(): number {
    let sum = 0;
    let n = 0;
    for (const d of this.drivers.values()) {
      if (!d.enabled) continue;
      sum += Math.abs(d.band0.speedMul - 1);
      n++;
    }
    return n === 0 ? 0 : clamp01(sum / n / 0.07);
  }
}

const CC_VALID = new Set<number>([50, 100, 150, 200]);
