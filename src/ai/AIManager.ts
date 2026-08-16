/**
 * ============================================================================
 *  FOXY KART — AI MANAGER
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
import { clamp, clamp01 } from '@/core/MathUtils';

import { RacingLine, type LineVariant, type ShortcutSpec } from './RacingLine';
import {
  AIDriver,
  NULL_ITEMS,
  createHazard,
  defaultChassis,
  type AIControl,
  type AIDebugState,
  type AIHazard,
  type ChassisFacts,
  type DriverWorld,
  type ItemAccess,
} from './AIDriver';
import {
  FORM,
  NEUTRAL_FORM,
  PERSONALITIES,
  Rand,
  assignForms,
  assignPersonalities,
  personalityForKart,
  personalityById,
  type DriverForm,
  type Personality,
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
  /** `PhysicsWorld.tuningOf` — lets a driver know which chassis it is sitting in. */
  tuningOf?: (kartId: number) => unknown;
}

/**
 * `grip` in `KartTuning` is `9.6 + traction·9.2` (see `physics/Tuning.ts`), so
 * this inverts it back to the 0..1 stat the driver wants. Kept here rather than
 * importing the physics tuning table: the AI must not depend on another
 * subsystem's internals, and a wrong-but-bounded guess is harmless.
 */
function tractionFromGrip(grip: number): number {
  return clamp01((grip - 9.6) / 9.2);
}

/** `tuning.halfExtents.x` if it looks like a vector, else the fallback. */
function readHalfWidth(v: unknown, fallback: number): number {
  if (!v || typeof v !== 'object') return fallback;
  const x = (v as Record<string, unknown>).x;
  return typeof x === 'number' && x > 0.2 && x < 3 ? x : fallback;
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

/** Resolved accessor trio for the indexed `Hazards` shape. See `collectHazards`. */
interface HazardHolder {
  obj: object;
  pos: AnyFn;
  rad: AnyFn | null;
  kind: AnyFn | null;
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
  /** Circuit fingerprint the current `line` was baked for. See `syncLineToTrack`. */
  private lineTag = '';
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
  private tuningFn: AnyFn | null = null;
  private itemAccess: ItemAccess = NULL_ITEMS;

  /**
   * Per-RACE seed. Everything randomised about the field — which racer gets
   * which rung of the pace ladder, which personality, each driver's mistake
   * stream — derives from this, so a race is reproducible but two races are not
   * identical. The owner's report: *"opponents … are not randomized"*.
   */
  private fieldSeed = 1;
  private forms = new Map<number, DriverForm>();
  private assigned = new Map<number, Personality>();
  private readonly scratchChassis: ChassisFacts = defaultChassis();
  /** Median top speed of the grid, m/s. Re-measured when the roster changes. */
  private fieldRef = 28.5;

  // Reusable world context + hazard pool (zero allocation per tick).
  private readonly world: DriverWorld;
  private readonly hazardPool: AIHazard[] = [];
  /** Cached indexed-hazard accessors. See `collectHazards`. */
  private hazardHolder: HazardHolder | null = null;
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
      // `Track` implements `collideWalls`, which is all `WallProbe` asks for. This
      // is what lets a driver steer away from a barrier instead of discovering it
      // by hitting it — see the `WALL` block in AIDriver.
      walls: track,
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

  /**
   * Bake the racing line for whatever circuit is loaded RIGHT NOW, and record
   * which circuit that was.
   *
   * Split out of `init()` because it is not a one-off: see `syncLineToTrack`.
   */
  private buildLine(): void {
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
    this.lineTag = this.trackFingerprint();
    const t1 =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : 0;
    if (t1 > t0) {
      const s = this.line.stats();
      console.info(
        `[AI] racing line: ${s.stations} stations, ${s.optimalLength.toFixed(1)} m ` +
          `(centre ${s.centreLength.toFixed(1)} m), v ${s.minSpeed.toFixed(1)}–` +
          `${s.maxSpeed.toFixed(1)} m/s, barrier clearance >= ` +
          `${s.minBarrierClearance.toFixed(2)} m, built in ${(t1 - t0).toFixed(1)} ms`,
      );
    }
  }

  /**
   * Which circuit is under us. Cheap, allocation-light, and deterministic for a
   * given spline, so it can be compared every half second without ever
   * false-positiving into a rebuild.
   *
   * `trackId` is not on `ITrackService` — `Track` exposes it as a getter and this
   * file is duck-typed against its collaborators by design, so it is read
   * structurally with a geometry fallback for any track service that lacks it.
   * The fallback matters: lap length alone does not separate every circuit
   * (volcanoRush and tokyoNeon are both ~1536 m).
   */
  private trackFingerprint(): string {
    const t = this.track;
    const L = Number.isFinite(t.lapLength) ? t.lapLength : 0;
    const idRaw = (t as unknown as { trackId?: unknown }).trackId;
    if (typeof idRaw === 'string' && idRaw.length > 0) return `${idRaw}|${L.toFixed(1)}`;
    let g = '';
    for (let i = 0; i < 3; i++) {
      const s = t.sampleAtDistance(L * (0.13 + i * 0.29));
      g += `${s.position.x.toFixed(1)},${s.position.z.toFixed(1)};`;
    }
    return `${L.toFixed(1)}|${g}`;
  }

  /**
   * ⚠️ THE RACING LINE WAS BAKED ONCE AND NEVER REBUILT.
   *
   * `RacingLine` is a snapshot: `build()` bakes 600 stations of geometry, corner
   * curvature, barrier clearance and a speed profile, and `lapLength` is
   * `readonly`, captured in its constructor. `init()` built it and nothing ever
   * built it again.
   *
   * `RaceDirector.beginRace()` does this, in this order:
   *
   *     callOpt(this.track, 'loadTrack', opts.trackId);   // swaps the spline
   *     ...
   *     callOpt(this.ai, 'setDifficulty', this.cc);
   *     callOpt(this.ai, 'resetRace');                    // did NOT rebuild
   *
   * So the first race of a session was driven on the right line and EVERY LATER
   * RACE ON A DIFFERENT CIRCUIT was driven on the previous circuit's line — the
   * AI aiming at corners that are not there, at speeds set by a different set of
   * corners, on a road whose barriers are somewhere else. That is the owner's
   * report exactly: NPCs repeatedly hitting walls and failing to follow the
   * course, on multiple circuits, in normal races.
   *
   * It was invisible to every probe in `.probe-tmp` because all of them load the
   * circuit first and construct `AIManager` afterwards, which is the one order
   * the game never uses. Measured with the shipping order
   * (`.probe-tmp/loopdet.ts`, `staleLineFrom`), volcanoRush entered from the
   * previous circuit: 8653 barrier-contact episodes, 807 s of contact, 226 pins,
   * a 33 s off-road excursion, and 0 of 11 AI karts finishing three laps inside
   * 400 s. On the same seed with the line rebuilt: 7 episodes, 0.7 s.
   *
   * Checked on the existing half-second `resolveStates` cadence rather than only
   * in `resetRace()`, so it also covers a swap made by any other path and the
   * case where `init()` ran before the track was ready.
   */
  private syncLineToTrack(): boolean {
    const L = this.track.lapLength;
    if (!Number.isFinite(L) || L <= 1) return false;
    const tag = this.trackFingerprint();
    if (this.line && tag === this.lineTag) return false;
    this.buildLine();
    // Every driver holds line-relative state — `hintStation` indexes the OLD
    // station array, the arc ring holds the old circuit's distances, the chosen
    // variant belongs to the old line. Reusing any of it on new geometry is how
    // a rebuilt line would still drive like a stale one.
    for (const d of this.drivers.values()) d.reset();
    return true;
  }

  init(): void {
    this.buildLine();
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
    // A fresh field for every race. `RaceDirector.beginRace()` calls
    // `resetRace()` — but only if `Game.ts` wired `race.setAi(ai)`, which it
    // currently does not, so `race:countdown` is the reliable hook.
    this.unsubscribes.push(
      bus.on('race:countdown', (p) => {
        if (p.count >= 3) this.newFieldSeed();
      }),
    );
    this.reshuffleField();
  }

  /**
   * Draw a new race seed and re-roll the field: pace ladder, personalities and
   * every driver's mistake stream. Deterministic given the seed.
   */
  newFieldSeed(seed?: number): void {
    this.fieldSeed =
      seed !== undefined && Number.isFinite(seed)
        ? Math.floor(seed) || 1
        : (Math.floor(Math.random() * 0x7ffffffe) + 1) | 0;
    this.reshuffleField();
  }

  get seed(): number {
    return this.fieldSeed;
  }

  /** Re-derive forms + personalities for the current roster from `fieldSeed`. */
  private reshuffleField(): void {
    const ids: number[] = [];
    let playerId = -1;
    for (const s of this.states) {
      ids.push(s.id);
      if (s.isPlayer) playerId = s.id;
    }
    if (ids.length === 0) return;
    this.fieldRef = this.measureFieldReference();
    this.forms = assignForms(ids, this.fieldSeed, playerId);
    this.assigned = assignPersonalities(ids, this.fieldSeed, playerId);
    const profile = this.rubberband.profile();
    for (const [id, d] of this.drivers) {
      const override = this.overrides.get(id);
      const p = override
        ? personalityById(override) ?? this.assigned.get(id) ?? personalityForKart(id)
        : this.assigned.get(id) ?? personalityForKart(id);
      d.setPersonality(p, profile);
      d.setForm(this.forms.get(id) ?? NEUTRAL_FORM);
      d.reseed(this.fieldSeed);
      // Chassis first: the pace ladder is solved against each kart's own cruise
      // ceiling, so it has to know what that ceiling is.
      this.pushChassis(id, d);
    }
    this.layOutPaceLadder(playerId);
  }

  /**
   * Turn `FORM.ladderStep` into an even ladder of *effective* cruise speeds.
   *
   * A per-kart pace multiplier alone does not produce a field: the roster's own
   * top speeds span 20 %, so a randomly-assigned pace ladder lands on top of a
   * bigger random variable and the two cancel. Measured with a deliberately
   * absurd 16 % ladder: the lap-time spread got *narrower* (9.3 s → 5.6 s) and
   * the slowest-form kart lapped faster than the quickest-form one.
   *
   * So: rank the racers on what they could do if they tried (chassis × authored
   * pace), jitter the ranking a little so it is not the same order every race,
   * then solve each racer's pace backwards from the rung it landed on. Character
   * decides WHERE you are in the field; the ladder guarantees the gaps are even.
   */
  private layOutPaceLadder(playerId: number): void {
    type Rung = { id: number; d: AIDriver; potential: number; key: number };
    const rungs: Rung[] = [];
    const rand = new Rand((this.fieldSeed || 1) * 2654 + 7);
    for (const [id, d] of this.drivers) {
      if (id === playerId) continue;
      const potential = d.cruiseCap * d.personality.paceFactor;
      if (!(potential > 1)) continue;
      rungs.push({
        id,
        d,
        potential,
        key: potential * (1 + (rand.next() * 2 - 1) * FORM.orderJitter),
      });
    }
    if (rungs.length < 2) return;
    rungs.sort((a, b) => b.key - a.key);

    // The quickest racer keeps its own pace; everybody else steps down from it.
    const top = rungs[0].potential;
    for (let i = 0; i < rungs.length; i++) {
      const r = rungs[i];
      const wanted = top * (1 - i * FORM.ladderStep);
      // `min(1, …)`: a kart whose chassis cannot reach its rung simply drives
      // flat out. Nobody is ever asked for more than their own tuning allows.
      const pace = clamp(wanted / r.potential, FORM.paceFloor, 1);
      const base = this.forms.get(r.id) ?? NEUTRAL_FORM;
      const form: DriverForm = {
        pace,
        mistake: base.mistake,
        error: base.error,
        drift: base.drift,
      };
      this.forms.set(r.id, form);
      r.d.setForm(form);
    }
  }

  /** Tell one driver which chassis it is sitting in, if physics will say. */
  private pushChassis(kartId: number, d: AIDriver): void {
    const fn = this.tuningFn;
    if (!fn) return;
    let t: unknown;
    try {
      t = fn.call(this.physicsSource, kartId);
    } catch {
      return;
    }
    if (!t || typeof t !== 'object') return;
    const r = t as Record<string, unknown>;
    const c = this.scratchChassis;
    c.maxSpeed = typeof r.maxSpeed === 'number' && r.maxSpeed > 1 ? r.maxSpeed : 28.4;
    c.handling = typeof r.handling === 'number' ? clamp01(r.handling) : 0.55;
    c.traction = typeof r.grip === 'number' ? tractionFromGrip(r.grip) : 0.55;
    // `turnRate` is the divisor in the AI's steering model, so getting it from the
    // chassis rather than assuming a constant is the difference between commanding
    // the right steer angle and commanding half of it. If physics does not publish
    // it, reconstruct it from `handling` the same way `buildTuning` does
    // (2.1 + handling − 0.14·weight); the weight term is at most 0.14 rad/s.
    c.turnRate =
      typeof r.turnRate === 'number' && r.turnRate > 0.5
        ? r.turnRate
        : 2.03 + c.handling;
    c.radius = readHalfWidth(r.halfExtents, 0.72);
    d.setChassis(c);
    d.setFieldReference(this.fieldRef);
  }

  /**
   * Median top speed of the whole grid, m/s — the reference the per-chassis
   * cruise blend works from (see `SPEED.chassisWeight`). Measured rather than
   * assumed so it tracks the CC class and whatever roster is on the grid.
   */
  private measureFieldReference(): number {
    const fn = this.tuningFn;
    if (!fn || this.states.length === 0) return 28.5;
    const caps: number[] = [];
    for (const s of this.states) {
      try {
        const t = fn.call(this.physicsSource, s.id);
        if (t && typeof t === 'object') {
          const v = (t as Record<string, unknown>).maxSpeed;
          if (typeof v === 'number' && v > 1) caps.push(v);
        }
      } catch {
        /* physics may not know this kart yet */
      }
    }
    if (caps.length === 0) return 28.5;
    caps.sort((a, b) => a - b);
    const h = caps.length >> 1;
    return caps.length % 2 ? caps[h] : (caps[h - 1] + caps[h]) * 0.5;
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
    this.tuningFn = fnOf(this.physicsSource, ['tuningOf', 'getTuning', 'tuningFor']);
    if (!this.setControlFn) {
      console.warn('[AI] physics has no setControl() — AI cannot drive.');
    }
    if (!this.tuningFn) {
      // Not fatal: every driver falls back to the `nova` chassis, which only
      // means the pace ladder stops varying by character.
      console.warn('[AI] physics has no tuningOf() — drivers cannot read their own chassis.');
    }
    this.fieldRef = this.measureFieldReference();
    for (const [id, d] of this.drivers) this.pushChassis(id, d);
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

  /** Per-driver form, for probes and the debug overlay. */
  formOf(kartId: number): DriverForm | undefined {
    return this.forms.get(kartId);
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
    // FIRST: `RaceDirector.beginRace()` calls `track.loadTrack()` a few lines
    // above this, and `Track.loadTrack` is synchronous up to `ready = true` (its
    // only `await` is a bare `Promise.resolve()` for the loading bar), so the new
    // circuit is already under us here. See `syncLineToTrack`.
    this.syncLineToTrack();
    this.rubberband.reset();
    this.elapsed = 0;
    for (const d of this.drivers.values()) d.reset();
    this.newFieldSeed();
  }

  // -------------------------------------------------------------------------
  //  The tick
  // -------------------------------------------------------------------------

  fixedUpdate(ctx: FrameContext): void {
    const dt = ctx.fixedDt > 0 ? ctx.fixedDt : 1 / 120;
    this.elapsed += dt;

    this.resolveCooldown -= dt;
    if (this.resolveCooldown <= 0) {
      this.resolveCooldown = 0.5;
      // Before the states: a circuit swap invalidates the line, and driving one
      // more tick on a stale line is a tick of driving at a corner that is not
      // there. See `syncLineToTrack`.
      this.syncLineToTrack();
      this.resolveStates(false);
    }
    const line = this.line;
    if (!line) return;
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
        // Do not push a driver that is not coping. See the COMPOSURE note in
        // Rubberband.ts — this argument is the fix for a runaway in which a lost
        // kart got maximum risk precisely because it was lost.
        d.composure,
      );
      const ctrl = d.step(dt, w, this.band);
      this.sendControl(st.id, ctrl);

      // Long-term stuck: ask for a respawn rather than sit there forever.
      //
      // `d.wantsRespawn` replaces a `recoverySeconds > 5.5` test that could not
      // fire for the failure it existed to catch — a driver that keeps escaping
      // recovery and re-entering it never accumulates 5.5 s in one episode. See
      // `AIDriver.wantsRespawn`.
      //
      // `clearRespawnRequest()` rather than `reset()`: a full reset wipes the
      // lifetime counters a probe (and the debug overlay) reads to detect exactly
      // this situation, which is how it stayed invisible.
      if (d.wantsRespawn && this.respawnFn) {
        try {
          this.respawnFn.call(this.physicsSource, st.id);
        } catch {
          /* physics may not support it */
        }
        d.clearRespawnRequest();
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
    let created = 0;
    for (const st of this.states) {
      seen.add(st.id);
      let d = this.drivers.get(st.id);
      if (!d) {
        const overrideId = this.overrides.get(st.id);
        const p = overrideId
          ? personalityById(overrideId) ?? personalityForKart(st.id)
          : this.assigned.get(st.id) ?? personalityForKart(st.id);
        d = new AIDriver(st.id, p, profile);
        d.setItems(this.itemAccess);
        this.drivers.set(st.id, d);
        created++;
      }
      d.setState(st);
      d.enabled = !st.isPlayer && !this.explicitlyDisabled.has(st.id);
    }
    // The roster changed, so the pace ladder has to be laid out over the new
    // grid (and every new driver needs its chassis + form).
    if (created > 0) this.reshuffleField();
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
   *
   * ⚠️ THIS RETURNED 0 ON EVERY TICK OF EVERY RACE EVER PLAYED.
   *
   * The duck-typed lookup below asks `itemSource` for `getHazards`,
   * `getObstacles`, `listHazards` or `activeHazards`. `ItemSystem` — which is
   * what `Game.ts` passes here — defines none of them, and neither does anything
   * else in `src/`:
   *
   *     grep -rn 'getHazards\|getObstacles\|listHazards\|activeHazards' src/
   *     -> src/ai/AIManager.ts only
   *
   * So `fnOf` returned null, `hazardCount` was pinned at 0, and the entire hazard
   * branch of `AIDriver.updateAvoidance` (`AVOID.hazardPad`, `AVOID.hazardStrength`,
   * the `AIHazard` interface, `createHazard()`, the 48-entry pool built in this
   * constructor) has never once executed — in the game or in any measurement this
   * project has taken. Every contact number in every round was measured with the
   * AI blind to boulders and fireballs.
   *
   * `ItemSystem` does expose `readonly hazards: Hazards`, and `Hazards` exposes
   * indexed accessors (`positionOf`, `radiusOf`, `kindOf`) rather than an array,
   * which is why no name-based probe found it. The second path below adapts to
   * those. It reads only public accessors and allocates nothing — `positionOf`
   * hands back its own `Vector3` and we copy out of it.
   */
  private collectHazards(): number {
    const src = this.itemSource;
    if (!src) return 0;
    const getter = fnOf(src, ['getHazards', 'getObstacles', 'listHazards', 'activeHazards']);
    if (!getter) return this.collectIndexedHazards(src);
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
    return this.collectProjectiles(src, n);
  }

  /**
   * The shipped `Hazards` shape: no list, just `positionOf(i)` / `radiusOf(i)` /
   * `kindOf(i)` over a dense array, returning null past the end. Either the item
   * source itself or its `hazards` member may carry them.
   *
   * Zero allocation: no array is built and `h.position.copy()` writes into the
   * pool entry created in the constructor.
   */
  private collectIndexedHazards(src: object): number {
    const holder = this.hazardHolder ?? this.resolveHazardHolder(src);
    if (!holder) return this.collectProjectiles(src, 0);
    const posFn = holder.pos;
    let n = 0;
    for (let i = 0; i < this.hazardPool.length; i++) {
      let p: unknown;
      try {
        p = posFn.call(holder.obj, i);
      } catch {
        return n;
      }
      // A dense list: the first null is the end of it.
      if (!isVec3(p)) break;
      const h = this.hazardPool[n];
      h.position.copy(p);
      const r = holder.rad ? holder.rad.call(holder.obj, i) : null;
      h.radius = typeof r === 'number' && r > 0 ? r : 1.2;
      const k = holder.kind ? holder.kind.call(holder.obj, i) : null;
      h.kind = typeof k === 'string' ? k : 'hazard';
      h.ownerId = -1;
      // Track hazards never chase. Only shells do, and those arrive by the
      // list path above.
      h.homing = false;
      n++;
    }
    return this.collectProjectiles(src, n);
  }

  /**
   * Dropped bananas, shells and bombs are hazards too, and they were invisible
   * for the same reason: `Projectiles` exposes a VISITOR (`forEachActive`), not
   * an array and not one of the four probed names. Its `Projectile` carries
   * `pos` / `radius` / `kind`, which is everything `AIHazard` needs.
   *
   * The callback is a bound field, not a closure created per call, so this stays
   * allocation-free in the tick. `hazardN` is the cursor it writes through.
   */
  private hazardN = 0;
  private readonly visitProjectile = (p: unknown): void => {
    if (this.hazardN >= this.hazardPool.length) return;
    if (!p || typeof p !== 'object') return;
    const rec = p as Record<string, unknown>;
    if (rec.active === false) return;
    const pos = isVec3(rec.pos) ? rec.pos : isVec3(rec.position) ? rec.position : null;
    if (!pos) return;
    const h = this.hazardPool[this.hazardN];
    h.position.copy(pos);
    h.radius = typeof rec.radius === 'number' && rec.radius > 0 ? rec.radius : 1.2;
    const kind = typeof rec.kind === 'string' ? rec.kind : 'projectile';
    h.kind = kind;
    h.ownerId = typeof rec.owner === 'number' ? rec.owner : -1;
    // Red and blue shells chase; a banana on the floor does not.
    h.homing = kind === 'red' || kind === 'blue';
    this.hazardN++;
  };

  /** Append live projectiles after the track hazards. Returns the new count. */
  private collectProjectiles(src: object, from: number): number {
    const holder = (propOf(src, 'projectiles') as object | null) ?? src;
    const each = fnOf(holder, ['forEachActive']);
    if (!each) return from;
    this.hazardN = from;
    try {
      each.call(holder, this.visitProjectile);
    } catch {
      return from;
    }
    return this.hazardN;
  }

  /** Resolved once — the accessor trio never moves after wiring. */
  private resolveHazardHolder(src: object): HazardHolder | null {
    const candidates: Array<object | null> = [
      (propOf(src, 'hazards') as object | null) ?? null,
      src,
    ];
    for (const obj of candidates) {
      if (!obj) continue;
      const pos = fnOf(obj, ['positionOf']);
      if (!pos) continue;
      this.hazardHolder = {
        obj,
        pos,
        rad: fnOf(obj, ['radiusOf']),
        kind: fnOf(obj, ['kindOf']),
      };
      return this.hazardHolder;
    }
    return null;
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
    /** Times the arc-progress / wall-pin tests fired across the field. */
    stuckEpisodes: number;
    /** Barrier contacts the wall reflex saw across the field. */
    wallContacts: number;
  } {
    let miniTurbos = 0;
    let attempts = 0;
    let boost = 0;
    let off = 0;
    let back = 0;
    let rec = 0;
    let inRec = 0;
    let enabled = 0;
    let stuck = 0;
    let walls = 0;
    for (const d of this.drivers.values()) {
      if (!d.enabled) continue;
      enabled++;
      miniTurbos += d.miniTurboCount;
      attempts += d.driftAttemptCount;
      boost += d.boostSecondsEarned;
      off += d.offTrackSeconds;
      back += d.backwardsSeconds;
      rec += d.recoveryLifetime;
      stuck += d.stuckEpisodeCount;
      walls += d.wallContactCount;
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
      stuckEpisodes: stuck,
      wallContacts: walls,
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
