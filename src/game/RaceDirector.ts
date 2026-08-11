/**
 * ============================================================================
 *  RACE DIRECTOR — the facade every other subsystem asks "what's happening?"
 * ============================================================================
 *  Owns the race phase machine, the countdown and rocket start, lap validation,
 *  live position ranking, finishing order, Grand Prix points, pause/restart,
 *  and — because it is the only subsystem holding both `InputState` and
 *  `PhysicsWorld` — the player's control bridge.
 *
 *  Everything it touches outside its own three files is **feature-detected**.
 *  Sibling subsystems are authored in parallel; a missing method is never an
 *  error, it is simply a capability this build doesn't have. Nothing in here
 *  throws, nothing in here blocks, and `state` is a legal value from the
 *  constructor onward so the HUD can read it on frame 1.
 *
 *  Phase machine:
 *
 *     idle ──beginRace()──▶ intro ──▶ countdown ──▶ racing ──▶ finished ──▶ results
 *       ▲                     │           │           │           │           │
 *       └──────── abortRace() ┴───────────┴───────────┴───────────┴───────────┘
 *
 *  `paused` is orthogonal: it remembers the phase it interrupted.
 * ============================================================================
 */

import type {
  FrameContext,
  InputState,
  ISubsystem,
  ITrackService,
  KartState,
} from '@/core/Types';
import { bus } from '@/core/EventBus';
import { RACE } from '@/core/Config';
import { clamp, clamp01 } from '@/core/MathUtils';
import {
  DEFAULT_CHECKPOINTS,
  RaceState,
  type IKartRoster,
  type LapTracker,
  type RacePhase,
  type RaceResult,
} from './RaceState';
import { CUP_RACES, Standings, type CupSummary } from './Standings';

// ---------------------------------------------------------------------------
// Tuning — the whole feel of the race flow lives here.
// ---------------------------------------------------------------------------

export const RACE_TUNING = {
  /** Length of the pre-race flyby. Matches CinematicCamera.introSeconds. */
  introSeconds: 6.2,
  /** Hard ceiling on the intro even if a camera promise never resolves. */
  introTimeout: 9.0,
  /** Total countdown length. Lights land on 3 / 2 / 1, GO at zero. */
  countdownSeconds: RACE.countdownSeconds,

  /** Holding accel inside this window before GO earns the rocket start. */
  rocketWindow: 0.35,
  /** …and a hold that began this far before GO burns the tyres instead. */
  burnoutThreshold: 0.45,
  rocketBoostSeconds: 1.45,
  rocketBoostStrength: 1.55,
  /** Seconds of dead throttle after a jumped start. */
  burnoutSeconds: 0.8,
  /** Chance an AI nails its own rocket start, scaled by CC. */
  aiRocketChance: 0.28,

  /** Seconds the remaining field gets after the player finishes. */
  finishGraceSeconds: 16,
  /** Absolute per-lap time budget before a kart is DNF'd. */
  dnfSecondsPerLap: 150,
  /** Beat between the last finish and the results screen. */
  resultsDelaySeconds: 2.4,
  /** Seconds of finish cinematic before the camera goes to the leader. */
  spectateDelaySeconds: 6.0,

  /** Music intensity by phase. */
  musicIdle: 0.25,
  musicCountdown: 0.55,
  musicRacing: 0.7,
  musicFinalLap: 1.0,
  musicResults: 0.35,

  /** Wrong-way nag threshold, seconds of sustained reverse progress. */
  wrongWaySeconds: 1.1,
  /** Autopilot steering gain for a kart that has already finished. */
  autopilotGain: 2.4,
  autopilotLookahead: 16,
} as const;

// ---------------------------------------------------------------------------
// Structural views of siblings. Deliberately opaque: we only ever probe them.
// ---------------------------------------------------------------------------

/** Anything late-wired. We never rely on its shape, only on `typeof`. */
export type LateDep = object;

type AnyFn = (...args: unknown[]) => unknown;

function methodOf(obj: unknown, name: string): AnyFn | null {
  if (obj === null || obj === undefined) return null;
  const fn = (obj as Record<string, unknown>)[name];
  return typeof fn === 'function' ? (fn as AnyFn) : null;
}

/** Call an optional method, swallowing anything it does wrong. */
function callOpt(obj: unknown, name: string, ...args: unknown[]): unknown {
  const fn = methodOf(obj, name);
  if (!fn) return undefined;
  try {
    return fn.apply(obj, args);
  } catch (err) {
    console.warn(`[Race] ${name}() failed:`, err);
    return undefined;
  }
}

/** Control packet handed to physics. Reused — the update path allocates nothing. */
interface ControlPacket {
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  driftPressed: boolean;
}

const IDLE_CONTROL: ControlPacket = {
  steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false,
};

// module scratch
const _ctrl: ControlPacket = { steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false };
const EMPTY_LAPS: readonly number[] = [];

export interface BeginRaceOptions {
  trackId?: string;
  characterId?: string;
  /** Kart body id — passed through to the kart manager if it wants it. */
  kartId?: string;
  cc?: number;
  laps?: number;
  /** `'single' | 'gp' | 'time'` — anything else behaves as a single race. */
  mode?: string;
  /** Skip the flyby (harness / retry). */
  skipIntro?: boolean;
}

export class RaceDirector implements ISubsystem {
  // --- constructor deps ----------------------------------------------------
  private readonly roster: IKartRoster;
  private readonly track: ITrackService;
  private readonly input: InputState;

  // --- owned state ---------------------------------------------------------
  private readonly race = new RaceState();
  readonly standings = new Standings(CUP_RACES);

  private opts: BeginRaceOptions = {};
  private cc = 150;
  private mode = 'single';
  private cupActive = false;

  // --- late-wired siblings -------------------------------------------------
  private physics: LateDep | null = null;
  private items: LateDep | null = null;
  private audio: LateDep | null = null;
  private vfx: LateDep | null = null;
  private camera: LateDep | null = null;
  private ai: LateDep | null = null;
  private environment: LateDep | null = null;

  // --- capability flags ----------------------------------------------------
  private canProject = false;
  private canStartPositions = false;
  private canLoadTrack = false;
  private canRacingLine = false;

  // --- countdown / rocket start -------------------------------------------
  private countdownBeat = 99;
  /** Countdown value at which accel was last pressed; NaN when released. */
  private accelPressedAt = Number.NaN;
  private accelWasDown = false;
  private rocketStart = false;
  private burnoutTime = 0;

  // --- intro ---------------------------------------------------------------
  private introTime = 0;
  private introDone = false;
  private introRequested = false;

  // --- ranking (allocation-free) ------------------------------------------
  private readonly rank: number[] = [];
  private readonly prevPosition = new Map<number, number>();
  /** Arc fallback for a track service without `project()`. */
  private readonly fallbackT = new Map<number, number>();

  // --- flow bookkeeping ----------------------------------------------------
  private playerId = -1;
  private finishedCount = 0;
  private playerFinishTime = -1;
  private lastFinishTime = 0;
  private finalLapAnnounced = false;
  private completeEmitted = false;
  private spectating = false;
  private spectateTarget = -1;
  private unsubscribe: Array<() => void> = [];

  /** Live numbers for the debug overlay and the automated assertions. */
  readonly debug = {
    phase: 'idle' as RacePhase,
    countdown: 0,
    raceTime: 0,
    leader: -1,
    playerPosition: 0,
    playerLap: 0,
    finished: 0,
    rocketStart: false,
    burnout: 0,
    wrongWay: false,
  };

  constructor(karts: IKartRoster, track: ITrackService, input: InputState) {
    this.roster = karts;
    this.track = track;
    this.input = input;
    // A legal phase and a sane countdown before init() has even run.
    this.race.countdown = RACE_TUNING.countdownSeconds;
    this.race.totalLaps = RACE.laps;
  }

  // =========================================================================
  //  Lifecycle
  // =========================================================================

  init(): void {
    const t = this.track as unknown as Record<string, unknown> | null;
    this.canProject = typeof t?.['project'] === 'function';
    this.canStartPositions = typeof t?.['getStartPosition'] === 'function';
    this.canLoadTrack = typeof t?.['loadTrack'] === 'function';
    this.canRacingLine = typeof t?.['racingLineAt'] === 'function';

    this.race.totalLaps = this.trackLapCount();
    this.resolvePlayer();

    this.unsubscribe.push(
      // A respawn teleports the kart along the spline. Re-seat the tracker's
      // `t` so the jump is never mistaken for a line crossing.
      bus.on('kart:respawn', ({ kartId }) => {
        const tr = this.race.trackers.get(kartId);
        if (!tr) return;
        const t = this.progressOf(this.kartById(kartId));
        if (t !== null) tr.resync(t);
      }),
    );

    this.debug.phase = this.race.phase;
    this.debug.countdown = this.race.countdown;
  }

  setPhysics(physics: LateDep): void {
    this.physics = physics;
    callOpt(physics, 'setCC', this.cc);
    // Nothing should be moving before a race begins.
    if (!this.race.is('racing', 'finished')) callOpt(physics, 'setFrozen', true);
  }

  setItems(items: LateDep): void { this.items = items; }
  /**
   * Optional — lets the director tell the world that the circuit changed in the
   * same tick as `loadTrack`, instead of leaving it to notice on its next frame.
   * Needs `wire(this.race, 'setEnvironment', this.environment)` in `Game.ts`;
   * everything still works without it, just one frame later.
   */
  setEnvironment(environment: LateDep): void { this.environment = environment; }
  setAudio(audio: LateDep): void {
    this.audio = audio;
    callOpt(audio, 'setMusicIntensity', RACE_TUNING.musicIdle);
  }
  setVfx(vfx: LateDep): void { this.vfx = vfx; }
  setCamera(camera: LateDep): void { this.camera = camera; }
  /** Optional — lets the director push the CC class into the AI difficulty. */
  setAi(ai: LateDep): void {
    this.ai = ai;
    callOpt(ai, 'setDifficulty', this.cc);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  // =========================================================================
  //  Public read API (HUD, camera, minimap, AI, QA)
  // =========================================================================

  get state(): RacePhase { return this.race.phase; }
  /** Seconds remaining on the start countdown, counting down to zero. */
  get countdown(): number { return this.race.countdown; }
  /** Seconds since the lights went out. */
  get raceTime(): number { return this.race.raceTime; }
  get totalLaps(): number { return this.race.totalLaps; }
  get phaseTime(): number { return this.race.phaseTime; }
  get results(): RaceResult[] { return this.race.results; }
  /** Kart ids in current running order, leader first. */
  get order(): readonly number[] { return this.rank; }
  get leader(): number { return this.rank.length > 0 ? this.rank[0] : -1; }
  get isRunning(): boolean { return this.race.is('racing', 'finished'); }
  get ccClass(): number { return this.cc; }
  get raceMode(): string { return this.mode; }
  get didRocketStart(): boolean { return this.rocketStart; }

  getPosition(kartId: number): number {
    const p = this.prevPosition.get(kartId);
    if (p !== undefined && p > 0) return p;
    const tr = this.race.trackers.get(kartId);
    if (tr && tr.position > 0) return tr.position;
    return Math.max(1, this.indexOf(kartId) + 1);
  }

  getLap(kartId: number): number {
    const tr = this.race.trackers.get(kartId);
    if (!tr) return 1;
    return tr.displayLap(this.race.totalLaps);
  }

  /** Raw lap counter: 0 on the grid, totalLaps+1 once finished. */
  getRawLap(kartId: number): number {
    return this.race.trackers.get(kartId)?.lap ?? 0;
  }

  getLapTimes(kartId: number): readonly number[] {
    return this.race.trackers.get(kartId)?.lapTimes ?? EMPTY_LAPS;
  }

  getBestLap(kartId: number): number {
    const b = this.race.trackers.get(kartId)?.bestLap ?? Infinity;
    return isFinite(b) ? b : 0;
  }

  getProgress(kartId: number): number {
    return this.race.trackers.get(kartId)?.progress ?? 0;
  }

  isFinished(kartId: number): boolean {
    return this.race.trackers.get(kartId)?.finished === true;
  }

  isWrongWay(kartId: number): boolean {
    return this.race.trackers.get(kartId)?.wrongWay === true;
  }

  /** True on the last lap for this kart — HUD tint, music, camera. */
  isFinalLap(kartId: number): boolean {
    const tr = this.race.trackers.get(kartId);
    return !!tr && !tr.finished && tr.lap >= this.race.totalLaps;
  }

  /** Grand Prix snapshot. */
  cupSummary(): CupSummary { return this.standings.summary(); }
  cupPoints(kartId: number): number { return this.standings.points(kartId); }

  // =========================================================================
  //  Flow control
  // =========================================================================

  beginRace(opts: BeginRaceOptions = {}): void {
    this.opts = opts;
    this.mode = typeof opts.mode === 'string' ? opts.mode : 'single';
    this.cc = this.normaliseCc(opts.cc);

    // --- track ------------------------------------------------------------
    if (opts.trackId && this.canLoadTrack) {
      if (callOpt(this.track, 'loadTrack', opts.trackId) === undefined) {
        this.canLoadTrack = false;
      }
    }
    // `loadTrack` swaps the road spline; the world the road sits in has to follow,
    // or Neon Metropolis and Volcano Rush render inside the coastal world. The
    // rebuild is async and deliberately NOT awaited: it is Environment's own
    // business, nothing below depends on it, and holding a synchronous
    // `beginRace()` open would leave the race half-started. Environment also
    // notices the swap itself on its next frame, so this is only worth the same
    // tick — and it is a no-op when the circuit hasn't actually changed, which is
    // what keeps `restart()` from rebuilding the world on every retry.
    callOpt(this.environment, 'syncToTrack');
    if (opts.characterId) callOpt(this.roster, 'setPlayerCharacter', opts.characterId);
    if (opts.kartId) callOpt(this.roster, 'setPlayerKart', opts.kartId);

    // --- laps -------------------------------------------------------------
    const laps = typeof opts.laps === 'number' && isFinite(opts.laps) && opts.laps > 0
      ? Math.round(opts.laps)
      : this.trackLapCount();
    this.race.resetAll();
    this.race.totalLaps = clamp(laps, 1, 16);
    this.race.countdown = RACE_TUNING.countdownSeconds;

    // --- class ------------------------------------------------------------
    callOpt(this.physics, 'setCC', this.cc);
    callOpt(this.ai, 'setDifficulty', this.cc);
    callOpt(this.ai, 'resetRace');
    callOpt(this.items, 'reset');
    callOpt(this.items, 'refreshBoxSpawns');

    // --- grid -------------------------------------------------------------
    this.resolvePlayer();
    this.placeOnGrid();

    // --- per-kart bookkeeping --------------------------------------------
    this.finishedCount = 0;
    this.playerFinishTime = -1;
    this.lastFinishTime = 0;
    this.finalLapAnnounced = false;
    this.completeEmitted = false;
    this.spectating = false;
    this.spectateTarget = -1;
    this.rocketStart = false;
    this.burnoutTime = 0;
    this.countdownBeat = 99;
    this.accelPressedAt = Number.NaN;
    this.accelWasDown = false;
    this.introTime = 0;
    this.introDone = false;
    this.introRequested = false;
    this.prevPosition.clear();
    this.fallbackT.clear();
    this.rank.length = 0;

    const list = this.roster?.karts;
    const checkpoints = this.checkpointCount();
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const k = list[i];
        if (!k) continue;
        this.resetKartState(k, i);
        const tr = this.race.tracker(k.id, checkpoints);
        const t = this.progressOf(k);
        tr.reset(t ?? 0, 0);
        this.fallbackT.set(k.id, tr.t);
        this.prevPosition.set(k.id, i + 1);
        k.racePosition = i + 1;
        k.lap = tr.displayLap(this.race.totalLaps);
        k.progress = tr.progress;
        this.rank.push(k.id);
        callOpt(this.audio, 'bindEngine', k.id, k.isPlayer);
      }
    }

    // --- Grand Prix -------------------------------------------------------
    if (this.mode === 'gp') {
      if (!this.cupActive || this.standings.isComplete) {
        this.standings.beginCup(this.rank, undefined, CUP_RACES);
        this.cupActive = true;
      }
    } else {
      this.cupActive = false;
    }

    // --- go ---------------------------------------------------------------
    callOpt(this.physics, 'setFrozen', true);
    callOpt(this.ai, 'setRaceStarted', false, RACE_TUNING.countdownSeconds);
    callOpt(this.audio, 'setMusicIntensity', RACE_TUNING.musicCountdown);

    const skip = opts.skipIntro === true || RACE_TUNING.introSeconds <= 0;
    if (skip) {
      this.enterCountdown();
    } else {
      this.race.set('intro');
      this.debug.phase = 'intro';
      this.startIntroShot();
    }
  }

  /** Bail out of a race back to the menus. */
  abortRace(): void {
    callOpt(this.physics, 'setFrozen', true);
    callOpt(this.ai, 'setRaceStarted', false, 0);
    this.pushControl(IDLE_CONTROL);
    this.race.set('idle');
    this.race.countdown = RACE_TUNING.countdownSeconds;
    this.debug.phase = 'idle';
    callOpt(this.audio, 'setMusicIntensity', RACE_TUNING.musicIdle);
  }

  pause(): void {
    if (this.race.is('paused', 'idle', 'results')) return;
    this.race.set('paused');
    this.debug.phase = 'paused';
    callOpt(this.physics, 'setFrozen', true);
    this.pushControl(IDLE_CONTROL);
    callOpt(this.audio, 'duck', 0.6, 0.15);
  }

  resume(): void {
    if (this.race.phase !== 'paused') return;
    const back = this.race.pausedFrom;
    this.race.set(back === 'paused' ? 'racing' : back);
    this.debug.phase = this.race.phase;
    callOpt(this.physics, 'setFrozen', !this.race.is('racing', 'finished'));
    callOpt(this.audio, 'duck', 0, 0.25);
  }

  /** MenuSystem's preferred hook. */
  setPaused(on: boolean): void { if (on) this.pause(); else this.resume(); }

  restart(): void {
    const opts = this.opts;
    // A retry never replays the flyby — you want to be racing again.
    this.beginRace({ ...opts, skipIntro: true });
  }

  /** Cut the flyby short (start button, or a harness in a hurry). */
  skipIntro(): void {
    if (this.race.phase !== 'intro') return;
    this.introDone = true;
    callOpt(this.camera, 'setMode', 'chase');
    this.enterCountdown();
  }

  /** Cycle the spectator camera through the field after finishing. */
  spectateNext(): void {
    if (this.rank.length === 0) return;
    const i = this.rank.indexOf(this.spectateTarget);
    this.spectateTarget = this.rank[(i + 1) % this.rank.length];
    callOpt(this.camera, 'setTarget', this.spectateTarget);
    callOpt(this.camera, 'setMode', 'chase');
  }

  // =========================================================================
  //  Fixed step — the machine
  // =========================================================================

  fixedUpdate(ctx: FrameContext): void {
    const dt = ctx.fixedDt > 0 ? ctx.fixedDt : 1 / 120;
    const phase = this.race.phase;
    if (phase === 'idle' || phase === 'paused') { this.writeDebug(); return; }

    this.race.tick(dt);

    switch (phase) {
      case 'intro': this.stepIntro(dt); break;
      case 'countdown': this.stepCountdown(dt); break;
      case 'racing':
      case 'finished': this.stepRacing(dt); break;
      case 'results': this.stepResults(dt); break;
      default: break;
    }

    this.writeDebug();
  }

  // ---- intro --------------------------------------------------------------

  private startIntroShot(): void {
    if (this.introRequested) return;
    this.introRequested = true;
    // If a camera is wired, let its promise decide when the shot has landed;
    // `introTimeout` still guarantees we move on.
    const fn = methodOf(this.camera, 'playIntro');
    if (!fn) return;
    try {
      const p = fn.call(this.camera) as unknown;
      if (p && typeof (p as Promise<void>).then === 'function') {
        (p as Promise<void>).then(
          () => { this.introDone = true; },
          () => { this.introDone = true; },
        );
      } else {
        this.introDone = false;
      }
    } catch {
      this.introDone = true;
    }
  }

  private stepIntro(dt: number): void {
    this.introTime += dt;
    // The camera drives itself off `state === 'intro'`, so an unwired camera
    // still gets its flyby; we just time it out ourselves.
    const done = this.introDone
      || this.introTime >= RACE_TUNING.introSeconds
      || this.introTime >= RACE_TUNING.introTimeout;
    if (done) this.enterCountdown();
  }

  // ---- countdown ----------------------------------------------------------

  private enterCountdown(): void {
    this.race.set('countdown');
    this.debug.phase = 'countdown';
    this.race.countdown = RACE_TUNING.countdownSeconds;
    this.countdownBeat = 99;
    this.accelPressedAt = Number.NaN;
    this.accelWasDown = false;
    callOpt(this.physics, 'setFrozen', true);
    callOpt(this.ai, 'setRaceStarted', false, RACE_TUNING.countdownSeconds);
    callOpt(this.audio, 'setMusicIntensity', RACE_TUNING.musicCountdown);
  }

  private stepCountdown(dt: number): void {
    this.sampleStartInput();
    this.race.countdown = Math.max(0, this.race.countdown - dt);
    const c = this.race.countdown;

    // Lights on the integer beats: 3 at t-3.0, 2 at t-2.0, 1 at t-1.0.
    // The 0.6 s lead-in above 3.0 exists so the camera can settle first.
    const beat = Math.ceil(c - 1e-6);
    if (beat < this.countdownBeat && beat <= 3) {
      this.countdownBeat = beat;
      if (beat > 0) {
        bus.emit('race:countdown', { count: beat });
        callOpt(this.audio, 'play', beat === 1 ? 'countdown_last' : 'countdown_beep');
      }
    }

    if (c <= 0) this.startRacing();
  }

  /**
   * Watch the throttle through the countdown. We remember *when* the current
   * hold began, which is what separates a rocket start from a jumped one.
   */
  private sampleStartInput(): void {
    const down = (this.input?.accel ?? 0) > 0.5;
    if (down && !this.accelWasDown) this.accelPressedAt = this.race.countdown;
    else if (!down) this.accelPressedAt = Number.NaN;
    this.accelWasDown = down;
  }

  private startRacing(): void {
    this.race.countdown = 0;
    this.race.set('racing');
    this.debug.phase = 'racing';
    this.countdownBeat = 0;

    // --- rocket start adjudication ---------------------------------------
    const pressedAt = this.accelPressedAt;
    const holding = this.accelWasDown;
    let rocket = false;
    let burnout = false;
    if (holding && isFinite(pressedAt)) {
      if (pressedAt <= RACE_TUNING.rocketWindow) rocket = true;
      else if (pressedAt >= RACE_TUNING.burnoutThreshold) burnout = true;
    }
    this.rocketStart = rocket;

    callOpt(this.physics, 'setFrozen', false);
    callOpt(this.ai, 'setRaceStarted', true, 0);
    bus.emit('race:countdown', { count: 0 });
    bus.emit('race:start', { rocketStart: rocket });
    callOpt(this.audio, 'play', 'countdown_go');
    callOpt(this.audio, 'setMusicIntensity', RACE_TUNING.musicRacing);

    const player = this.playerKart();
    if (player) {
      if (rocket) {
        this.grantBoost(player, RACE_TUNING.rocketBoostSeconds, RACE_TUNING.rocketBoostStrength, 'start');
        callOpt(this.vfx, 'flash', 0xfff2c0, 0.35, 0.22);
        bus.emit('ui:message', { text: 'ROCKET START!', seconds: 1.3, style: 'boost' });
      } else if (burnout) {
        this.burnoutTime = RACE_TUNING.burnoutSeconds;
        callOpt(this.vfx, 'burst', 'tyre_smoke', player.position, undefined, 1.4);
        bus.emit('camera:shake', { amount: 0.35, seconds: 0.4 });
        bus.emit('ui:message', { text: 'BURNOUT!', seconds: 1.1, style: 'warn' });
      }
    }

    // A couple of AI drivers nail it too — the grid should never look scripted.
    this.grantAiRocketStarts();
  }

  private grantAiRocketStarts(): void {
    const list = this.roster?.karts;
    if (!list) return;
    const chance = RACE_TUNING.aiRocketChance * (this.cc >= 150 ? 1.2 : 0.75);
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (!k || k.isPlayer) continue;
      // Deterministic per grid slot so a retry behaves the same way.
      const r = ((Math.sin((k.id + 1) * 12.9898 + this.race.totalLaps) * 43758.5453) % 1 + 1) % 1;
      if (r < chance) {
        this.grantBoost(k, RACE_TUNING.rocketBoostSeconds * 0.85, RACE_TUNING.rocketBoostStrength, 'start');
      }
    }
  }

  private grantBoost(k: KartState, seconds: number, strength: number, source: 'start'): void {
    const applied = callOpt(this.physics, 'applyBoost', k.id, seconds, strength, source);
    if (applied === undefined) {
      // No physics yet — write the state directly so VFX/audio still react.
      k.boostTime = Math.max(k.boostTime, seconds);
      k.boostStrength = Math.max(k.boostStrength, strength);
    }
    bus.emit('kart:boost', { kartId: k.id, duration: seconds, source });
  }

  // ---- racing -------------------------------------------------------------

  private stepRacing(dt: number): void {
    if (this.burnoutTime > 0) this.burnoutTime = Math.max(0, this.burnoutTime - dt);

    this.updateProgress(dt);
    this.updateRanking();
    this.checkTimeouts();

    if (this.race.phase === 'finished') {
      this.updateSpectate(dt);
      const grace = this.race.phaseTime;
      const everyone = this.finishedCount >= this.kartCount();
      if (everyone || grace >= RACE_TUNING.finishGraceSeconds) {
        if (!everyone) this.dnfRemaining();
        if (this.race.raceTime - this.lastFinishTime >= RACE_TUNING.resultsDelaySeconds || !everyone) {
          this.enterResults();
        }
      }
    }
  }

  /**
   * Per-kart lap + checkpoint bookkeeping. Robust at the t-wrap: `LapTracker`
   * owns the ±0.5 delta rules, we only feed it a trustworthy `t`.
   */
  private updateProgress(dt: number): void {
    const list = this.roster?.karts;
    if (!list) return;
    const total = this.race.totalLaps;
    const raceTime = this.race.raceTime;
    const checkpoints = this.checkpointCount();

    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (!k) continue;
      const tr = this.race.tracker(k.id, checkpoints);
      const t = this.progressOf(k, dt);
      if (t === null) continue;

      const before = tr.lap;
      const event = tr.step(t, raceTime, total);

      // Wrong-way nag: sustained negative progress while grounded and moving.
      const reversing = k.speed < -1.5 || event === 'back';
      tr.wrongWayTime = reversing ? tr.wrongWayTime + dt : Math.max(0, tr.wrongWayTime - dt * 2);
      tr.wrongWay = tr.wrongWayTime > RACE_TUNING.wrongWaySeconds;

      k.lap = tr.displayLap(total);
      k.progress = tr.progress;

      switch (event) {
        case 'lap': this.onLap(k, tr); break;
        case 'finish': this.onFinish(k, tr); break;
        case 'invalid':
          if (k.isPlayer) {
            bus.emit('ui:message', { text: 'CHECKPOINT MISSED', seconds: 1.4, style: 'warn' });
          }
          break;
        case 'back':
          if (k.isPlayer && before > tr.lap) {
            bus.emit('ui:message', { text: 'WRONG WAY!', seconds: 1.2, style: 'warn' });
          }
          break;
        default: break;
      }
    }
  }

  private onLap(k: KartState, tr: LapTracker): void {
    const lapTime = tr.lapTimes.length > 0 ? tr.lapTimes[tr.lapTimes.length - 1] : 0;
    const isBest = lapTime > 0 && lapTime <= tr.bestLap + 1e-6;
    // Mirror into KartState so the HUD can read either source.
    k.lapTimes.length = 0;
    for (let i = 0; i < tr.lapTimes.length; i++) k.lapTimes.push(tr.lapTimes[i]);
    bus.emit('race:lap', { kartId: k.id, lap: tr.lap, lapTime, isBest });
    callOpt(this.audio, 'play', 'lap_chime');

    // Final lap fanfare — once, for the player.
    if (k.isPlayer && tr.lap >= this.race.totalLaps && !this.finalLapAnnounced) {
      this.finalLapAnnounced = true;
      bus.emit('ui:message', { text: 'FINAL LAP', seconds: 2.0, style: 'final' });
      callOpt(this.audio, 'setMusicIntensity', RACE_TUNING.musicFinalLap);
      callOpt(this.audio, 'play', 'final_lap');
    }
  }

  private onFinish(k: KartState, tr: LapTracker): void {
    if (this.race.finishOrder.indexOf(k.id) >= 0) return;
    this.race.finishOrder.push(k.id);
    this.finishedCount++;
    const position = this.race.finishOrder.length;
    tr.position = position;
    this.lastFinishTime = this.race.raceTime;

    k.finished = true;
    k.finishTime = tr.finishTime;
    k.racePosition = position;
    this.prevPosition.set(k.id, position);

    this.race.results.push({
      kartId: k.id,
      position,
      time: tr.finishTime,
      bestLap: isFinite(tr.bestLap) ? tr.bestLap : 0,
      laps: this.race.totalLaps,
      dnf: false,
    });

    bus.emit('race:finish', { kartId: k.id, position, totalTime: tr.finishTime });

    if (k.isPlayer) {
      this.playerFinishTime = tr.finishTime;
      this.race.set('finished');
      this.debug.phase = 'finished';
      this.spectating = false;
      this.spectateTarget = k.id;
      const ord = position === 1 ? '1st' : position === 2 ? '2nd' : position === 3 ? '3rd' : `${position}th`;
      bus.emit('ui:message', { text: `FINISH — ${ord}`, seconds: 2.6, style: 'finish' });
      callOpt(this.audio, 'play', position <= 3 ? 'finish_good' : 'finish_ok');
      callOpt(this.audio, 'setMusicIntensity', RACE_TUNING.musicResults);
      // The chase camera also listens for `race:finish`; this is the explicit
      // path for a camera that was wired directly to us.
      callOpt(this.camera, 'playFinish', k.id);
      // Hand the kart over so it keeps driving out of the shot.
      callOpt(this.ai, 'setEnabled', k.id, true);
    }

    if (this.finishedCount >= this.kartCount() && this.race.phase !== 'finished') {
      this.race.set('finished');
      this.debug.phase = 'finished';
    }
  }

  /** DNF anything that has taken absurdly long, and close out the grace window. */
  private checkTimeouts(): void {
    const budget = RACE_TUNING.dnfSecondsPerLap * this.race.totalLaps;
    if (this.race.raceTime < budget) return;
    this.dnfRemaining();
    if (this.race.phase !== 'finished') {
      this.race.set('finished');
      this.debug.phase = 'finished';
    }
  }

  private dnfRemaining(): void {
    const list = this.roster?.karts;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (!k) continue;
      const tr = this.race.trackers.get(k.id);
      if (!tr || tr.finished) continue;
      tr.markDnf(this.race.raceTime);
      this.race.finishOrder.push(k.id);
      const position = this.race.finishOrder.length;
      tr.position = position;
      k.finished = true;
      k.finishTime = tr.finishTime;
      k.racePosition = position;
      this.finishedCount++;
      this.race.results.push({
        kartId: k.id,
        position,
        time: tr.finishTime,
        bestLap: isFinite(tr.bestLap) ? tr.bestLap : 0,
        laps: tr.lap,
        dnf: true,
      });
      bus.emit('race:finish', { kartId: k.id, position, totalTime: tr.finishTime });
    }
  }

  private updateSpectate(dt: number): void {
    if (this.spectating) return;
    void dt;
    if (this.race.phaseTime < RACE_TUNING.spectateDelaySeconds) return;
    this.spectating = true;
    // Watch whoever is still racing for the lead.
    for (let i = 0; i < this.rank.length; i++) {
      const id = this.rank[i];
      if (!this.isFinished(id)) { this.spectateTarget = id; break; }
    }
    if (this.spectateTarget >= 0) {
      callOpt(this.camera, 'setTarget', this.spectateTarget);
      callOpt(this.camera, 'setMode', 'chase');
    }
  }

  // ---- results ------------------------------------------------------------

  private enterResults(): void {
    if (this.completeEmitted) return;
    this.completeEmitted = true;
    this.race.set('results');
    this.debug.phase = 'results';

    // Anything still out there gets a result row so the table is never ragged.
    this.dnfRemaining();
    this.race.results.sort((a, b) => a.position - b.position);

    if (this.mode === 'gp' && this.cupActive) {
      this.standings.recordRace(this.race.results);
      if (this.standings.isComplete) {
        const s = this.standings.summary();
        const winner = s.winner;
        bus.emit('ui:message', {
          text: winner === this.playerId ? 'CUP WON!' : 'CUP COMPLETE',
          seconds: 3.0,
          style: 'final',
        });
        this.cupActive = false;
      }
    }

    callOpt(this.physics, 'setFrozen', true);
    callOpt(this.audio, 'setMusicIntensity', RACE_TUNING.musicResults);
    callOpt(this.camera, 'setMode', 'results');
    bus.emit('race:complete', { results: this.race.results });
  }

  private stepResults(dt: number): void {
    void dt;
    this.updateRanking();
  }

  // =========================================================================
  //  Ranking
  // =========================================================================

  /**
   * Insertion sort over the reused id array. n <= 12 and the list is almost
   * always already sorted, so this is O(n) in practice and never allocates.
   */
  private updateRanking(): void {
    const list = this.roster?.karts;
    if (!list) return;

    // Keep `rank` in sync with the roster without rebuilding it every tick.
    if (this.rank.length !== list.length) {
      this.rank.length = 0;
      for (let i = 0; i < list.length; i++) if (list[i]) this.rank.push(list[i].id);
    }

    const n = this.rank.length;
    for (let i = 1; i < n; i++) {
      const id = this.rank[i];
      let j = i - 1;
      while (j >= 0 && this.better(id, this.rank[j])) {
        this.rank[j + 1] = this.rank[j];
        j--;
      }
      this.rank[j + 1] = id;
    }

    for (let i = 0; i < n; i++) {
      const id = this.rank[i];
      const pos = i + 1;
      const tr = this.race.trackers.get(id);
      if (tr && !tr.finished) tr.position = pos;
      const k = this.kartById(id);
      if (k && !k.finished) k.racePosition = pos;
      const prev = this.prevPosition.get(id);
      if (prev !== pos) {
        this.prevPosition.set(id, pos);
        if (prev !== undefined && this.race.is('racing', 'finished')) {
          bus.emit('race:positionChange', { kartId: id, from: prev, to: pos });
        }
      }
    }
  }

  /** Strict "a ranks ahead of b". */
  private better(a: number, b: number): boolean {
    const ta = this.race.trackers.get(a);
    const tb = this.race.trackers.get(b);
    if (!ta) return false;
    if (!tb) return true;
    if (ta.finished !== tb.finished) return ta.finished;
    if (ta.finished && tb.finished) {
      if (ta.position > 0 && tb.position > 0 && ta.position !== tb.position) {
        return ta.position < tb.position;
      }
      return ta.finishTime < tb.finishTime;
    }
    const pa = isFinite(ta.progress) ? ta.progress : -1;
    const pb = isFinite(tb.progress) ? tb.progress : -1;
    if (pa !== pb) return pa > pb;
    return a < b;
  }

  // =========================================================================
  //  Display step — player control bridge, item input, spectate autopilot
  // =========================================================================

  update(ctx: FrameContext): void {
    const dt = clamp(ctx.dt, 0, 1 / 15);
    const phase = this.race.phase;

    // Start button skips the flyby.
    if (phase === 'intro' && (this.input?.startPressed || this.input?.driftPressed)) {
      this.skipIntro();
    }
    // Sample the throttle at display rate so the rocket-start window is honest
    // even when a frame runs zero fixed steps.
    if (this.race.phase === 'countdown') this.sampleStartInput();

    this.driveKarts(dt);
    this.debug.raceTime = this.race.raceTime;
    this.debug.countdown = this.race.countdown;
  }

  private driveKarts(dt: number): void {
    const list = this.roster?.karts;
    if (!list) return;
    const racing = this.race.is('racing', 'finished');

    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (!k || !k.isPlayer) continue;

      if (!racing) {
        // Frozen field: still let the throttle be *heard* during the countdown,
        // but never let it reach the tyres.
        this.pushControlFor(k.id, IDLE_CONTROL);
        continue;
      }

      if (k.finished) {
        this.autopilot(k, dt);
        continue;
      }

      const burnt = this.burnoutTime > 0;
      _ctrl.steer = clamp(this.input?.steer ?? 0, -1, 1);
      _ctrl.accel = burnt ? 0 : clamp01(this.input?.accel ?? 0);
      _ctrl.brake = burnt ? 0.25 : clamp01(this.input?.brake ?? 0);
      _ctrl.drift = this.input?.drift === true;
      _ctrl.driftPressed = this.input?.driftPressed === true;
      this.pushControlFor(k.id, _ctrl);

      // Item button: `requestHold` fires on release for a tap and throws the
      // shield forward on a long press, which is the MK8 behaviour.
      if (methodOf(this.items, 'requestHold')) {
        callOpt(this.items, 'requestHold', k.id, this.input?.item === true);
      } else if (this.input?.itemPressed) {
        callOpt(this.items, 'requestUse', k.id);
      }
    }
  }

  /** Keep a finished kart driving so it rolls out of the finish cinematic. */
  private autopilot(k: KartState, dt: number): void {
    void dt;
    let steer = 0;
    if (this.canRacingLine && this.canProject) {
      try {
        const s = this.track.project(k.position);
        const ahead = this.track.racingLineAt(s.t, RACE_TUNING.autopilotLookahead);
        // Signed lateral error, in the track plane, without allocating.
        const dx = ahead.x - k.position.x;
        const dz = ahead.z - k.position.z;
        // Forward from the direction of travel; the tangent when nearly stopped.
        let vx = k.velocity.x, vz = k.velocity.z;
        const vl = Math.hypot(vx, vz);
        if (vl < 0.5) { vx = s.tangent.x; vz = s.tangent.z; }
        const nl = Math.hypot(vx, vz) || 1;
        vx /= nl; vz /= nl;
        // `right = travel x up = (-vz, 0, vx)`, so `target . right` is this
        // cross term: positive means the line is off to the driver's right,
        // which is exactly the sign convention for `steer`.
        const cross = vx * dz - vz * dx;
        const dl = Math.hypot(dx, dz) || 1;
        steer = clamp((cross / dl) * RACE_TUNING.autopilotGain, -1, 1);
      } catch {
        this.canRacingLine = false;
      }
    }
    _ctrl.steer = steer;
    _ctrl.accel = 0.8;
    _ctrl.brake = 0;
    _ctrl.drift = false;
    _ctrl.driftPressed = false;
    this.pushControlFor(k.id, _ctrl);
  }

  private pushControl(c: ControlPacket): void {
    const list = this.roster?.karts;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k?.isPlayer) this.pushControlFor(k.id, c);
    }
  }

  private pushControlFor(kartId: number, c: ControlPacket): void {
    callOpt(this.physics, 'setControl', kartId, c);
  }

  // =========================================================================
  //  Helpers
  // =========================================================================

  private normaliseCc(cc: number | undefined): number {
    if (typeof cc !== 'number' || !isFinite(cc)) return 150;
    const options = [50, 100, 150, 200];
    let best = 150;
    let bestD = Infinity;
    for (const o of options) {
      const d = Math.abs(o - cc);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  private trackLapCount(): number {
    const n = (this.track as unknown as { lapCount?: unknown } | null)?.lapCount;
    return typeof n === 'number' && isFinite(n) && n > 0 ? Math.round(n) : RACE.laps;
  }

  private checkpointCount(): number {
    const t = this.track as unknown as Record<string, unknown> | null;
    const n = t?.['checkpointCount'];
    if (typeof n === 'number' && isFinite(n) && n >= 2) return Math.floor(n);
    const list = t?.['checkpoints'];
    if (Array.isArray(list) && list.length >= 2) return list.length;
    const fn = methodOf(this.track, 'getCheckpointCount');
    if (fn) {
      try {
        const v = fn.call(this.track);
        if (typeof v === 'number' && isFinite(v) && v >= 2) return Math.floor(v);
      } catch { /* fall through */ }
    }
    return DEFAULT_CHECKPOINTS;
  }

  /**
   * Normalised lap progress for a kart. Prefers `track.project()`; falls back
   * to integrating forward speed over the lap length so lap counting still
   * works against a track service that hasn't got a projector yet.
   */
  private progressOf(k: KartState | null, dt = 0): number | null {
    if (!k) return null;
    const p = k.position;
    if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return null;

    if (this.canProject) {
      try {
        const s = this.track.project(p);
        const t = s?.t;
        if (typeof t === 'number' && isFinite(t)) {
          const nt = ((t % 1) + 1) % 1;
          this.fallbackT.set(k.id, nt);
          // A track that also publishes an explicit progress hook wins.
          return nt;
        }
      } catch {
        this.canProject = false;
      }
    }

    if (dt <= 0) return this.fallbackT.get(k.id) ?? 0;
    const lapLength = (() => {
      const l = (this.track as unknown as { lapLength?: unknown } | null)?.lapLength;
      return typeof l === 'number' && isFinite(l) && l > 1 ? l : 1000;
    })();
    const prev = this.fallbackT.get(k.id) ?? 0;
    const speed = typeof k.speed === 'number' && isFinite(k.speed) ? k.speed : 0;
    let nt = prev + (speed * dt) / lapLength;
    nt = ((nt % 1) + 1) % 1;
    this.fallbackT.set(k.id, nt);
    return nt;
  }

  private resolvePlayer(): void {
    const list = this.roster?.karts;
    this.playerId = -1;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.isPlayer) { this.playerId = list[i].id; return; }
    }
    if (list.length > 0) this.playerId = list[0].id;
  }

  private playerKart(): KartState | null {
    return this.kartById(this.playerId);
  }

  private kartById(id: number): KartState | null {
    const list = this.roster?.karts;
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.id === id) return list[i];
    }
    return null;
  }

  private indexOf(id: number): number {
    const list = this.roster?.karts;
    if (!list) return 0;
    for (let i = 0; i < list.length; i++) if (list[i]?.id === id) return i;
    return 0;
  }

  private kartCount(): number {
    return this.roster?.karts?.length ?? 0;
  }

  private placeOnGrid(): void {
    const list = this.roster?.karts;
    if (!list) return;
    // Let the kart manager do it if it knows how; otherwise drive the track's
    // grid ourselves through physics.
    if (callOpt(this.roster, 'placeOnGrid') !== undefined) return;
    if (!this.canStartPositions) return;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (!k) continue;
      try {
        const slot = this.track.getStartPosition(i);
        if (!slot || !slot.position) continue;
        if (callOpt(this.physics, 'place', k.id, slot.position, slot.quaternion) === undefined) {
          k.position.copy(slot.position);
          if (slot.quaternion) {
            k.quaternion.copy(slot.quaternion);
            k.groundQuaternion.copy(slot.quaternion);
          }
        }
      } catch {
        this.canStartPositions = false;
        return;
      }
    }
  }

  /** Zero every per-race field we own on a KartState. */
  private resetKartState(k: KartState, index: number): void {
    k.lap = 0;
    k.progress = 0;
    k.racePosition = index + 1;
    k.finished = false;
    k.finishTime = 0;
    k.lapTimes.length = 0;
    k.boostTime = 0;
    k.boostStrength = 0;
    k.stunned = false;
    k.stunTime = 0;
    k.starTime = 0;
    k.invulnerable = false;
    k.heldItem = null;
    k.itemCount = 0;
    if (!this.physics) {
      // No physics to reset the body for us.
      k.velocity.set(0, 0, 0);
      k.speed = 0;
      k.speedRatio = 0;
      k.angularVelocity = 0;
    }
  }

  private writeDebug(): void {
    const d = this.debug;
    d.phase = this.race.phase;
    d.countdown = this.race.countdown;
    d.raceTime = this.race.raceTime;
    d.leader = this.leader;
    d.finished = this.finishedCount;
    d.rocketStart = this.rocketStart;
    d.burnout = this.burnoutTime;
    if (this.playerId >= 0) {
      d.playerPosition = this.getPosition(this.playerId);
      d.playerLap = this.getLap(this.playerId);
      d.wrongWay = this.isWrongWay(this.playerId);
    }
  }

  // -------------------------------------------------------------------------
  //  QA hooks — used by src/dev/camera.ts, harmless in production.
  // -------------------------------------------------------------------------

  /** Force a phase without running the transitions. Tests only. */
  debugSetPhase(phase: RacePhase): void {
    this.race.set(phase);
    this.debug.phase = phase;
  }

  /** Player finish time, or -1. */
  get playerTime(): number { return this.playerFinishTime; }
}
