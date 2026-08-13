/**
 * ============================================================================
 *  RACE STATE — the phase machine and per-kart lap bookkeeping
 * ============================================================================
 *  Split out of `RaceDirector` because lap counting is where racing games
 *  quietly break: the t-wrap at the start line, reversing over the line,
 *  cutting the course, a kart that spawns *past* the line rather than behind
 *  it. All of that lives in `LapTracker`, in one place, testable on its own.
 * ============================================================================
 */

import type { KartState } from '@/core/Types';
import { RACE } from '@/core/Config';

export type RacePhase =
  | 'idle'
  | 'intro'
  | 'countdown'
  | 'racing'
  | 'finished'
  | 'results'
  | 'paused';

/** Structural view of the kart roster — `KartManager` satisfies it. */
export interface IKartRoster {
  readonly karts: ReadonlyArray<KartState>;
}

export interface RaceResult {
  kartId: number;
  position: number;
  time: number;
  bestLap: number;
  laps: number;
  dnf: boolean;
}

/** What `LapTracker.step` observed this tick. */
export type LapEvent = 'none' | 'start' | 'lap' | 'finish' | 'invalid' | 'back';

/** Fraction of a lap's checkpoints that must be collected for it to count. */
export const CHECKPOINT_FRACTION = 0.75;
/** Default virtual checkpoint count when the track doesn't publish any. */
export const DEFAULT_CHECKPOINTS = 8;

/** Normalised progress → checkpoint region index. */
export function checkpointIndex(t: number, count: number): number {
  const i = Math.floor(((t % 1) + 1) % 1 * count);
  return i >= count ? count - 1 : i < 0 ? 0 : i;
}

/**
 * Per-kart lap and checkpoint state.
 *
 * `lap` is 0 while the kart is still behind the start line on the grid, then
 * 1..totalLaps while racing, and totalLaps + 1 the instant it finishes.
 * `progress = lap + t` is the monotonic ranking key.
 */
export class LapTracker {
  readonly kartId: number;

  lap = 0;
  /** Last normalised progress along the lap, [0,1). */
  t = 0;
  progress = 0;
  lapStartTime = 0;
  readonly lapTimes: number[] = [];
  bestLap = Infinity;

  finished = false;
  finishTime = 0;
  dnf = false;
  position = 0;

  /** Raw line crossings, including ones that didn't count. */
  lineCrossings = 0;
  invalidCrossings = 0;
  backwardCrossings = 0;

  wrongWay = false;
  wrongWayTime = 0;

  checkpointsHit = 0;
  private readonly visited: Uint8Array;
  private expected = 0;
  private readonly count: number;
  private readonly required: number;
  private primed = false;

  constructor(kartId: number, checkpointCount = DEFAULT_CHECKPOINTS) {
    this.kartId = kartId;
    this.count = Math.max(2, Math.floor(checkpointCount));
    this.required = Math.max(2, Math.ceil(this.count * CHECKPOINT_FRACTION));
    this.visited = new Uint8Array(this.count);
  }

  get checkpointCount(): number { return this.count; }
  get checkpointsRequired(): number { return this.required; }
  /** Would a line crossing right now count as a lap? */
  get lapValid(): boolean { return this.checkpointsHit >= this.required; }

  /**
   * Prepare for a race. `startT` is where the kart sits on the grid: behind the
   * line (t ≈ 0.97) is the normal case, but a track that puts the grid *past*
   * the line must not cost the driver a lap.
   */
  reset(startT: number, raceTime = 0): void {
    this.t = ((startT % 1) + 1) % 1;
    // Grids are laid out just behind the line. Anything in the first 40 % of
    // the lap is treated as already racing.
    this.lap = this.t < 0.4 ? 1 : 0;
    this.progress = this.lap + this.t;
    this.lapStartTime = raceTime;
    this.lapTimes.length = 0;
    this.bestLap = Infinity;
    this.finished = false;
    this.finishTime = 0;
    this.dnf = false;
    this.position = 0;
    this.lineCrossings = 0;
    this.invalidCrossings = 0;
    this.backwardCrossings = 0;
    this.wrongWay = false;
    this.wrongWayTime = 0;
    this.primed = true;
    this.beginLap();
  }

  private beginLap(): void {
    this.visited.fill(0);
    this.checkpointsHit = 0;
    const start = checkpointIndex(this.t, this.count);
    this.visited[start] = 1;
    this.checkpointsHit = 1;
    this.expected = (start + 1) % this.count;
  }

  /** Credit checkpoints only when they're reached in order. */
  private markCheckpoint(index: number): void {
    if (index === this.expected && this.visited[index] === 0) {
      this.visited[index] = 1;
      this.checkpointsHit++;
      this.expected = (index + 1) % this.count;
    }
  }

  /**
   * Advance with this tick's normalised progress.
   * `totalLaps` is needed so the tracker can tell a lap from the finish.
   */
  step(t: number, raceTime: number, totalLaps: number): LapEvent {
    const nt = ((t % 1) + 1) % 1;
    if (!this.primed) {
      this.reset(nt, raceTime);
      return 'none';
    }
    if (this.finished) {
      this.t = nt;
      return 'none';
    }

    const prev = this.t;
    const delta = nt - prev;
    this.t = nt;
    this.markCheckpoint(checkpointIndex(nt, this.count));

    let event: LapEvent = 'none';

    if (delta < -0.5) {
      // Crossed the line forwards.
      this.lineCrossings++;
      if (this.lap === 0) {
        this.lap = 1;
        this.lapStartTime = raceTime;
        this.beginLap();
        event = 'start';
      } else if (this.lapValid) {
        const lapTime = Math.max(0, raceTime - this.lapStartTime);
        this.lapTimes.push(lapTime);
        if (lapTime < this.bestLap) this.bestLap = lapTime;
        this.lapStartTime = raceTime;
        this.lap++;
        this.beginLap();
        if (this.lap > totalLaps) {
          this.finished = true;
          this.finishTime = raceTime;
          event = 'finish';
        } else {
          event = 'lap';
        }
      } else {
        // Shortcut / missed sector: the crossing doesn't count. Checkpoints are
        // deliberately *not* reset, so completing the loop properly validates.
        this.invalidCrossings++;
        event = 'invalid';
      }
    } else if (delta > 0.5) {
      // Reversed over the line — give the lap back.
      this.backwardCrossings++;
      if (this.lap > 0) this.lap--;
      // Treat the lap as complete-but-uncrossed so driving forward again
      // immediately re-counts it.
      this.visited.fill(1);
      this.checkpointsHit = this.count;
      this.expected = checkpointIndex(nt, this.count);
      event = 'back';
    }

    this.progress = this.lap + this.t;
    return event;
  }

  /**
   * Re-seat `t` after a teleport (respawn, rescue, item warp) so the jump is
   * never mistaken for a line crossing. Lap and checkpoints are untouched.
   */
  resync(t: number): void {
    this.t = ((t % 1) + 1) % 1;
    this.progress = this.lap + this.t;
    this.primed = true;
  }

  /** Force a finish (timeout / DNF). */
  markDnf(raceTime: number): void {
    if (this.finished) return;
    this.finished = true;
    this.dnf = true;
    this.finishTime = raceTime;
  }

  /**
   * Force a finish for a kart that was still racing normally when the race closed
   * out — the leader took the flag and the grace window expired underneath it.
   *
   * This is NOT a DNF, and it must not reuse `markDnf`. `markDnf` stamps
   * `raceTime`, which is correct for a genuine timeout but gave EVERY remaining
   * kart an identical total when the player won: with a 16 s grace window and a
   * comfortable win, eight or nine cars all showed the same time. That is the
   * "many of the NPC racers' time records are repeated ... makes it feel a bit
   * fake" the owner reported.
   *
   * The projection uses the kart's OWN measured pace — mean completed lap time
   * multiplied by the laps it still owed. Preferred over the simpler
   * `raceTime / fractionDone` because that window includes the standing start and
   * so flatters every kart by the same systematic amount, which would reintroduce
   * clustering, just at a different value.
   *
   * Returns the projected total so the caller can enforce ordering across karts;
   * this method deliberately knows nothing about the rest of the field.
   */
  projectFinish(raceTime: number, totalLaps: number): number {
    if (this.finished) return this.finishTime;
    this.finished = true;
    this.dnf = false;
    // `progress` is `lap + t` with `lap` starting at 1 on a normal grid, so laps
    // actually completed is `progress - 1`. Clamped because a kart still sitting
    // behind the line has lap 0 and would otherwise read as negative.
    const done = Math.max(0, this.progress - 1);
    const owed = Math.max(0, totalLaps - done);
    let pace = 0;
    if (this.lapTimes.length > 0) {
      let sum = 0;
      for (let i = 0; i < this.lapTimes.length; i++) sum += this.lapTimes[i];
      pace = sum / this.lapTimes.length;
    } else if (done > 1e-3) {
      // No completed lap to average yet: fall back to elapsed pace so far.
      pace = raceTime / done;
    }
    this.finishTime = pace > 0 ? raceTime + owed * pace : raceTime;
    return this.finishTime;
  }

  /** Displayed lap number, clamped to the race length. */
  displayLap(totalLaps: number): number {
    return Math.max(1, Math.min(totalLaps, this.lap === 0 ? 1 : this.lap));
  }
}

/**
 * Phase machine plus the per-kart trackers. Deliberately dumb: the transitions
 * themselves live in `RaceDirector`, which is what makes them readable.
 */
export class RaceState {
  phase: RacePhase = 'idle';
  /** Seconds spent in the current phase. */
  phaseTime = 0;
  /** Seconds since the phase machine started (all phases). */
  clock = 0;
  countdown = 0;
  raceTime = 0;
  totalLaps: number = RACE.laps;

  /** Kart ids in the order they crossed the line. */
  readonly finishOrder: number[] = [];
  readonly results: RaceResult[] = [];
  readonly trackers = new Map<number, LapTracker>();
  /** Current ranking, best first. */
  readonly order: number[] = [];

  private resumePhase: RacePhase = 'racing';

  set(phase: RacePhase): void {
    if (phase === this.phase) return;
    if (phase === 'paused') this.resumePhase = this.phase;
    this.phase = phase;
    this.phaseTime = 0;
  }

  /** Phase to return to after a pause. */
  get pausedFrom(): RacePhase { return this.resumePhase; }

  is(...phases: RacePhase[]): boolean {
    for (const p of phases) if (this.phase === p) return true;
    return false;
  }

  /** True while the world should be simulating. */
  get simulating(): boolean {
    return this.is('countdown', 'racing', 'finished');
  }

  tick(dt: number): void {
    this.phaseTime += dt;
    this.clock += dt;
    if (this.phase === 'racing' || this.phase === 'finished') this.raceTime += dt;
  }

  tracker(kartId: number, checkpointCount = DEFAULT_CHECKPOINTS): LapTracker {
    let t = this.trackers.get(kartId);
    if (!t) {
      t = new LapTracker(kartId, checkpointCount);
      this.trackers.set(kartId, t);
    }
    return t;
  }

  resetAll(): void {
    this.phaseTime = 0;
    this.clock = 0;
    this.countdown = RACE.countdownSeconds;
    this.raceTime = 0;
    this.finishOrder.length = 0;
    this.results.length = 0;
    this.order.length = 0;
    this.trackers.clear();
  }
}
