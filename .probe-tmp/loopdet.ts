/**
 * ============================================================================
 *  LOOP DETECTOR — "can an NPC enter wall -> failed recovery -> wall again?"
 * ============================================================================
 *
 *  WHY THIS EXISTS, AND WHY `wallgrind.ts` + `wallab.ts` COULD NOT ANSWER IT
 *  -----------------------------------------------------------------------
 *  `wallab.ts` reports `WallReport.totalContacts`, which `wallgrind.ts` counts
 *  on the RISING EDGE of barrier contact. That number is monotonically WRONG in
 *  the direction of the complaint:
 *
 *      a kart that taps a kerb and drives on              -> 1
 *      a kart pinned against a barrier for twenty seconds -> 1
 *
 *  The failure the owner describes — "continuously hits walls, fails to follow
 *  the course" — is the second one, and it scores the same as the first. Worse:
 *  a change that converts bouncing into grinding LOWERS the headline number.
 *  `wallgrind` does record `contactSeconds` / `pinned` / `longestContact`;
 *  `wallab.ts` folds none of them, so the 24.8 -> 2.2 headline is a rising-edge
 *  count and nothing else.
 *
 *  This probe measures the LOOP directly, and runs the race the owner plays:
 *
 *    - twelve distinct characters (the real `CHARACTERS` roster, one each)
 *    - THREE FULL LAPS, not a 200 s sample (`laps` arg), with a generous cap
 *    - ITEMS ON: a real `ItemSystem` (boxes, roulette, projectiles, hazards)
 *      wired into `AIManager`, so `collectHazards()` returns non-zero and the
 *      avoidance branch actually executes. Asserted, not assumed — see
 *      `hazardTicks` / `hazardSeen` in the report.
 *    - a HUMAN-LIKE player in the pack that brakes unpredictably, so the field
 *      is compressed and the AI meets traffic rather than clean air
 *    - DISPLACEMENT: scripted lateral shoves that knock a random AI off its
 *      line, which is the state the complaint is about. Off by default; `-d`.
 *
 *  WHAT A "LOOP" IS HERE
 *  ---------------------
 *  A loop event = `LOOP_N` distinct contact episodes by the SAME kart, all
 *  inside `LOOP_WINDOW` seconds and all within `LOOP_ARC` metres of centreline
 *  arc of each other. That is the limit cycle: hit, peel off, come back, hit
 *  again, in one place. Loops are reported with circuit, arc, racer, and the
 *  AI `DriveMode` histogram over the loop, because "which state" is the
 *  question.
 *
 *  Separately: a PIN is a single continuous contact longer than `PIN_SECONDS`
 *  (the sustained scrape), and a STALL is `STALL_SECONDS` of wall contact
 *  inside any `STALL_WINDOW`-second window regardless of episode structure —
 *  which catches the grind that a rising-edge counter scores as 1.
 *
 *  RED CONTROL
 *  -----------
 *  `--red` drives kart 5 into the barrier on a fixed cycle (steer hard at the
 *  wall, back off, repeat). If the detector does not light up on that, the
 *  detector is broken and every green result from it is worthless.
 * ============================================================================
 */

import * as THREE from 'three';
import { loadTrack, makeField, makeCtx } from '@/dev/headless';
import { AIManager } from '@/ai/AIManager';
import { AIDriver, type DriveMode, type DriverWorld } from '@/ai/AIDriver';
import { personalityById, personalityForKart } from '@/ai/AIPersonality';
import { createBandOutput, type CCClass } from '@/ai/Rubberband';
import { FIXED_DT } from '@/core/Config';
import { makeTuning } from '@/physics/Tuning';
import type { Track } from '@/track/Track';
import { CHARACTERS } from '@/karts/Characters';
import { ItemSystem } from '@/items/ItemSystem';
import { Rng } from '@/core/MathUtils';
import { bus } from '@/core/EventBus';

const FIELD = 12;
const GAME_ROSTER = CHARACTERS.slice(0, 12).map((c) => c.id);

/** Loop = this many episodes ... */
export const LOOP_N = 3;
/** ... inside this many seconds ... */
export const LOOP_WINDOW = 10;
/** ... and inside this much centreline arc, metres. */
export const LOOP_ARC = 40;

/** A single continuous contact longer than this is a PIN (sustained scrape). */
const PIN_SECONDS = 1.0;
/** STALL: this many seconds of contact ... */
const STALL_SECONDS = 2.5;
/** ... inside this window, seconds. */
const STALL_WINDOW = 8;
/** Metres past the drivable edge that counts as "off the course". */
const OFF_DEPTH = 1.0;
/** An excursion this long is not a wheel on the kerb. */
const OFF_LONG = 1.5;

const BUCKET = 20;

export interface Episode {
  kart: number;
  t0: number;
  dur: number;
  /** Centreline arc at first touch, metres. */
  arc: number;
  /** AI drive mode at first touch. */
  mode: DriveMode;
  /** Speed at first touch, m/s. */
  speed: number;
  /** Deepest penetration in the episode, metres. */
  depth: number;
}

export interface LoopEvent {
  kart: number;
  character: string;
  personality: string;
  gridSlot: number;
  t0: number;
  t1: number;
  arcLo: number;
  arcHi: number;
  episodes: number;
  /** Contact seconds inside the loop. */
  seconds: number;
  /** Seconds spent in each drive mode across the loop span. */
  modeSeconds: Record<string, number>;
  /** Recovery entries (transitions into reverse/realign) inside the span. */
  recoveryEntries: number;
  /** Mean speed across the span, m/s. */
  meanSpeed: number;
  /** Did the kart ask to be respawned during the span? */
  respawned: boolean;
}

export interface KartLoop {
  id: number;
  character: string;
  personality: string;
  gridSlot: number;
  laps: number;
  finished: boolean;
  raceSeconds: number;
  episodes: number;
  contactSeconds: number;
  longestContact: number;
  pins: number;
  pinSeconds: number;
  stallEpisodes: number;
  stallSeconds: number;
  /** Excursions past the drivable edge — "failed to follow the course". */
  offEpisodes: number;
  longestOff: number;
  /** Excursions longer than OFF_LONG seconds. */
  bigOff: number;
  /** Peak metres past the drivable edge. */
  worstOffDepth: number;
  loops: number;
  worstLoopEpisodes: number;
  worstLoopArc: number;
  modeSeconds: Record<string, number>;
  recoveryEntries: number;
  respawns: number;
  offTrack: number;
  recovery: number;
  stuckEpisodes: number;
  meanSpeed: number;
  isPlayer: boolean;
}

export interface LoopReport {
  trackId: string;
  seed: number;
  lapLength: number;
  seconds: number;
  targetLaps: number;
  itemsOn: boolean;
  /** Ticks on which at least one live hazard/projectile existed. */
  hazardTicks: number;
  hazardPeak: number;
  /** Summed `AIDriver.hazardAvoidCount` — ticks the hazard AVOIDANCE branch fired. */
  hazardAvoidTicks: number;
  hazardAvoidPeak: number;
  itemsUsed: number;
  boxPickups: number;
  itemHits: number;
  karts: KartLoop[];
  loops: LoopEvent[];
  episodes: Episode[];
  /** arc bucket -> contact seconds over the AI field. */
  arcSeconds: Float64Array;
  /** arc bucket -> off-road seconds over the AI field. */
  offArcSeconds: Float64Array;
  bucket: number;
  aiFinished: number;
  wallMs: number;
}

export interface LoopOptions {
  trackId: string;
  seed?: number;
  cc?: CCClass;
  targetLaps?: number;
  /** Hard stop, seconds. */
  capSeconds?: number;
  items?: boolean;
  /** Human-like player: brakes and wanders. */
  humanPlayer?: boolean;
  /** Pace of the player stand-in. Below ~0.85 it becomes a rolling roadblock. */
  playerPace?: number;
  playerGridSlot?: number;
  /** Periodic lateral shoves that knock an AI off line. */
  displace?: boolean;
  /** Red control: drive kart 5 into the barrier repeatedly. */
  red?: boolean;
  keepEpisodes?: boolean;
  /**
   * THE SHIPPING SEQUENCE. Build the AIManager while circuit `staleLineFrom` is
   * loaded, then `Track.loadTrack(trackId)` and `AIManager.resetRace()` — which
   * is exactly what `RaceDirector.beginRace()` does. Every other probe in this
   * repo constructs the AIManager AFTER the track it measures is loaded, which
   * is the one order the game never uses.
   */
  staleLineFrom?: string;
}

const _probe = new THREE.Vector3();
const _imp = new THREE.Vector3();

function blankModes(): Record<string, number> {
  return { grid: 0, race: 0, reverse: 0, realign: 0 };
}

export async function runLoopRace(opts: LoopOptions): Promise<LoopReport> {
  const cc: CCClass = opts.cc ?? 150;
  const seed = opts.seed ?? 12345;
  const targetLaps = opts.targetLaps ?? 3;
  const itemsOn = opts.items !== false;
  // `loadTrack` reuses ONE shared `Track` instance and reloads it in place —
  // exactly like the game, where `PhysicsWorld` and `AIManager` are built once
  // and the road spline is swapped under them by `RaceDirector.beginRace`.
  const track: Track = await loadTrack(opts.staleLineFrom ?? opts.trackId);
  const { physics, karts } = makeField(track, FIELD, cc);

  // --- AI, possibly built against the PREVIOUS circuit ---------------------
  const ai = new AIManager(track, { states: karts }, undefined, {});
  ai.init();

  if (opts.staleLineFrom) {
    // The swap. Nothing else in the game happens between these two lines.
    await loadTrack(opts.trackId);
  }

  for (let i = 0; i < FIELD; i++) physics.setTuning(i, makeTuning(GAME_ROSTER[i], cc));

  // --- grid ---------------------------------------------------------------
  const slotOf = new Array<number>(FIELD);
  const pSlot = Math.min(FIELD - 1, Math.max(0, opts.playerGridSlot ?? 5));
  slotOf[0] = pSlot;
  let next = 0;
  for (let i = 1; i < FIELD; i++) {
    if (next === pSlot) next++;
    slotOf[i] = next++;
  }
  for (let i = 0; i < FIELD; i++) {
    const st = track.getStartPosition(slotOf[i]);
    physics.place(i, st.position, st.quaternion);
  }

  // --- items --------------------------------------------------------------
  let items: ItemSystem | null = null;
  if (itemsOn) {
    const scene = new THREE.Scene();
    items = new ItemSystem(
      scene,
      track as unknown as ConstructorParameters<typeof ItemSystem>[1],
      { karts, player: karts[0] },
      physics as unknown as ConstructorParameters<typeof ItemSystem>[3],
      {},
    );
    await items.init();
  }

  if (items) ai.setItems(items);
  ai.setPhysics(physics);
  ai.setDifficulty(cc);
  // `RaceDirector.beginRace` calls exactly this after `loadTrack`.
  ai.resetRace();
  ai.setRaceStarted(true);
  ai.newFieldSeed(seed);
  const line = ai.racingLine;
  if (!line) throw new Error('no racing line');

  // --- player stand-in ----------------------------------------------------
  const pPers = personalityById('clean') ?? personalityForKart(2);
  const player = new AIDriver(0, pPers, ai.rubberband.profile());
  player.setState(karts[0]);
  player.enabled = true;
  player.setForm({ pace: opts.playerPace ?? 0.97, mistake: 1, error: 1, drift: 1 });
  const neutral = createBandOutput();
  const pWorld: DriverWorld = {
    line,
    walls: track,
    karts,
    hazards: [],
    hazardCount: 0,
    elapsed: 0,
    raceStarted: true,
    countdown: 0,
    playerProgress: 0,
    playerId: 0,
    lapLength: line.lapLength,
    fieldSize: FIELD,
    cc: ai.rubberband.profile(),
  };
  const humanRng = new Rng(seed ^ 0x9e37);
  let humanBrakeUntil = -1;
  let humanNext = 4 + humanRng.range(0, 6);

  // --- accumulators -------------------------------------------------------
  const L = track.lapLength;
  const nBuckets = Math.max(1, Math.ceil(L / BUCKET));
  const arcSeconds = new Float64Array(nBuckets);

  const rep: KartLoop[] = karts.map((k, i) => ({
    id: i,
    character: GAME_ROSTER[i],
    personality: i === 0 ? pPers.id : (ai.getDriver(i)?.personality.id ?? '?'),
    gridSlot: slotOf[i],
    laps: 0,
    finished: false,
    raceSeconds: 0,
    episodes: 0,
    contactSeconds: 0,
    longestContact: 0,
    pins: 0,
    pinSeconds: 0,
    stallEpisodes: 0,
    stallSeconds: 0,
    offEpisodes: 0,
    longestOff: 0,
    bigOff: 0,
    worstOffDepth: 0,
    loops: 0,
    worstLoopEpisodes: 0,
    worstLoopArc: -1,
    modeSeconds: blankModes(),
    recoveryEntries: 0,
    respawns: 0,
    offTrack: 0,
    recovery: 0,
    stuckEpisodes: 0,
    meanSpeed: 0,
    isPlayer: k.isPlayer,
  }));

  const touching = new Array<boolean>(FIELD).fill(false);
  const touchTime = new Array<number>(FIELD).fill(0);
  const offNow = new Array<boolean>(FIELD).fill(false);
  const offStart = new Array<number>(FIELD).fill(0);
  const offArcSeconds = new Float64Array(nBuckets);
  const wallRadius = new Array<number>(FIELD).fill(1);
  const probeZ = new Array<number>(FIELD).fill(1);
  for (let i = 0; i < FIELD; i++) {
    const t = physics.tuningOf(i);
    wallRadius[i] = (t?.halfExtents.x ?? 0.72) * 1.04;
    probeZ[i] = (t?.halfExtents.z ?? 0.97) * 0.58;
  }

  /** Per-kart episode list, kept for the loop scan. */
  const eps: Episode[][] = [];
  for (let i = 0; i < FIELD; i++) eps.push([]);
  const cur: Array<Episode | null> = new Array(FIELD).fill(null);

  /** Ring of contact seconds over STALL_WINDOW, for the grind test. */
  const stallTicks = Math.max(2, Math.round(STALL_WINDOW / FIXED_DT));
  const stallRing: Float32Array[] = [];
  for (let i = 0; i < FIELD; i++) stallRing.push(new Float32Array(stallTicks));
  const stallSum = new Float64Array(FIELD);
  const inStall = new Array<boolean>(FIELD).fill(false);

  /** Mode tracking. */
  const prevMode: DriveMode[] = new Array(FIELD).fill('grid');
  /** Per-tick mode samples for the loop-span histogram: (t, mode) is expensive to
   *  keep per tick, so accumulate into 0.5 s slots. */
  const SLOT = 0.5;
  const nSlots = Math.ceil(((opts.capSeconds ?? 400) + 2) / SLOT);
  const modeSlot: Uint8Array[] = [];
  for (let i = 0; i < FIELD; i++) modeSlot.push(new Uint8Array(nSlots));
  const MODE_IDX: Record<string, number> = { grid: 0, race: 1, reverse: 2, realign: 3 };
  const MODE_NAME = ['grid', 'race', 'reverse', 'realign'];
  const speedSlotSum = new Float64Array(FIELD * nSlots);
  const speedSlotN = new Float64Array(nSlots);
  const recoveryEntryT: number[][] = [];
  for (let i = 0; i < FIELD; i++) recoveryEntryT.push([]);
  const respawnT: number[][] = [];
  for (let i = 0; i < FIELD; i++) respawnT.push([]);

  const lastCross = new Array<number>(FIELD).fill(-1);
  const speedSum = new Array<number>(FIELD).fill(0);
  let sampleN = 0;
  let hazardTicks = 0;
  let hazardPeak = 0;
  let itemsUsed = 0;
  let boxPickups = 0;
  let itemHits = 0;
  const unsub: Array<() => void> = [];
  if (items) {
    unsub.push(bus.on('item:used', () => { itemsUsed++; }));
    unsub.push(bus.on('item:box', () => { boxPickups++; }));
    unsub.push(bus.on('item:hit', () => { itemHits++; }));
  }

  const ctx = makeCtx(FIXED_DT);
  const cap = opts.capSeconds ?? 400;
  const steps = Math.round(cap / FIXED_DT);
  const wall0 = Date.now();
  const order = new Array<number>(FIELD);
  for (let i = 0; i < FIELD; i++) order[i] = i;
  const rankNow = (): void => {
    order.sort((a, b) => karts[b].progress - karts[a].progress);
    for (let i = 0; i < FIELD; i++) karts[order[i]].racePosition = i + 1;
  };
  rankNow();

  const dispRng = new Rng(seed ^ 0x51de);
  let nextDisplace = 8;

  const redRng = new Rng(seed ^ 0xbad);
  void redRng;

  let elapsed = 0;
  let s = 0;
  for (; s < steps; s++) {
    const t = s * FIXED_DT;
    elapsed = t;

    // --- player stand-in ---------------------------------------------------
    pWorld.elapsed = t;
    pWorld.playerProgress = karts[0].progress;
    const pc = player.step(FIXED_DT, pWorld, neutral);
    if (opts.humanPlayer !== false) {
      // A human in the pack: occasional early braking + a lift, which compresses
      // the field behind and is what puts the AI into traffic.
      if (t >= humanNext) {
        humanBrakeUntil = t + 0.35 + humanRng.range(0, 0.7);
        humanNext = t + 3 + humanRng.range(0, 7);
      }
      if (t < humanBrakeUntil) {
        pc.accel = 0;
        pc.brake = 0.85;
        pc.drift = false;
      }
    }
    physics.setControl(0, pc);

    // --- field -------------------------------------------------------------
    ai.fixedUpdate(ctx);
    if (items && s % 4 === 0) {
      // Independent count of what the AI *could* see this tick: static track
      // hazards plus live projectiles. Not read back from the AI, on purpose —
      // if this is 0 the experiment has no items in it whatever the AI reports.
      let hz = items.hazards.count;
      items.projectiles.forEachActive(() => { hz++; });
      if (hz > 0) hazardTicks++;
      if (hz > hazardPeak) hazardPeak = hz;
    }

    // --- red control: kart 5 steers into the nearest barrier ---------------
    if (opts.red) {
      const phase = t % 4;
      if (phase < 2.2) {
        const b = physics.getBody(5);
        if (b) {
          // Which side is the wall on? Probe both.
          _probe.copy(b.position).addScaledVector(b.right, 6);
          const hr = track.collideWalls(_probe, 1.0);
          _probe.copy(b.position).addScaledVector(b.right, -6);
          const hl = track.collideWalls(_probe, 1.0);
          const dir = hr.hit ? 1 : hl.hit ? -1 : 1;
          physics.setControl(5, {
            steer: dir * 0.85,
            accel: 1,
            brake: 0,
            drift: false,
            driftPressed: false,
          });
        }
      }
      // else: leave the AI's own control in place, so it peels off and returns.
    }

    if (items) items.fixedUpdate(ctx);
    physics.fixedUpdate(ctx);
    (ctx as { elapsed: number }).elapsed += FIXED_DT;
    (ctx as { frame: number }).frame++;

    // --- displacement: shove a random AI sideways --------------------------
    if (opts.displace && t >= nextDisplace) {
      nextDisplace = t + 2 + dispRng.range(0, 3);
      const victim = 1 + Math.floor(dispRng.range(0, FIELD - 1));
      const b = physics.getBody(victim);
      if (b && !karts[victim].finished) {
        const sgn = dispRng.range(0, 1) > 0.5 ? 1 : -1;
        _imp.copy(b.right).multiplyScalar(sgn * 190);
        physics.applyImpulse(victim, _imp);
      }
    }

    // --- progress / laps ---------------------------------------------------
    for (let i = 0; i < FIELD; i++) {
      const k = karts[i];
      const lapped = track.updateProgress(k);
      if (lapped) {
        if (lastCross[i] >= 0) rep[i].laps++;
        lastCross[i] = t;
        if (rep[i].laps >= targetLaps && !rep[i].finished) {
          rep[i].finished = true;
          rep[i].raceSeconds = t;
          k.finished = true;
        }
      }
    }
    rankNow();

    // --- WALL CONTACT ------------------------------------------------------
    for (let i = 0; i < FIELD; i++) {
      const b = physics.getBody(i);
      if (!b) continue;
      let hitNow = false;
      let depth = 0;
      for (let p = 0; p < 2; p++) {
        const sgn = p === 0 ? 1 : -1;
        _probe.copy(b.position).addScaledVector(b.forward, sgn * probeZ[i]);
        const h = track.collideWalls(_probe, wallRadius[i]);
        if (h.hit && h.depth > 1e-4) {
          hitNow = true;
          if (h.depth > depth) depth = h.depth;
        }
      }
      const d = i === 0 ? player : ai.getDriver(i);
      const mode: DriveMode = d ? d.currentMode : 'race';

      // --- OFF THE ROAD, using the driver's own view of where the road is ----
      if (d) {
        const depth = Math.abs(d.latFromCentre) - d.nearHalfWidth;
        if (depth > OFF_DEPTH) {
          if (!offNow[i]) {
            offNow[i] = true;
            offStart[i] = t;
            rep[i].offEpisodes++;
          }
          const dur = t - offStart[i];
          if (dur > rep[i].longestOff) rep[i].longestOff = dur;
          if (dur >= OFF_LONG && dur - FIXED_DT < OFF_LONG) rep[i].bigOff++;
          if (depth > rep[i].worstOffDepth) rep[i].worstOffDepth = depth;
          if (i !== 0) {
            const oarc = (karts[i].progress - Math.floor(karts[i].progress)) * L;
            const ob = Math.min(nBuckets - 1, Math.max(0, Math.floor(oarc / BUCKET)));
            offArcSeconds[ob] += FIXED_DT;
          }
        } else if (offNow[i]) {
          offNow[i] = false;
        }
      }

      // stall ring
      const slot = s % stallTicks;
      stallSum[i] -= stallRing[i][slot];
      stallRing[i][slot] = hitNow ? FIXED_DT : 0;
      stallSum[i] += stallRing[i][slot];
      if (stallSum[i] >= STALL_SECONDS) {
        rep[i].stallSeconds += FIXED_DT;
        if (!inStall[i]) {
          inStall[i] = true;
          rep[i].stallEpisodes++;
        }
      } else if (stallSum[i] < STALL_SECONDS * 0.5) {
        inStall[i] = false;
      }

      if (hitNow) {
        rep[i].contactSeconds += FIXED_DT;
        const arc = (karts[i].progress - Math.floor(karts[i].progress)) * L;
        const bkt = Math.min(nBuckets - 1, Math.max(0, Math.floor(arc / BUCKET)));
        if (i !== 0) arcSeconds[bkt] += FIXED_DT;
        if (!touching[i]) {
          touching[i] = true;
          touchTime[i] = 0;
          rep[i].episodes++;
          const e: Episode = {
            kart: i,
            t0: t,
            dur: 0,
            arc,
            mode,
            speed: Math.abs(karts[i].speed),
            depth,
          };
          cur[i] = e;
          eps[i].push(e);
        }
        const e = cur[i];
        if (e) {
          e.dur += FIXED_DT;
          if (depth > e.depth) e.depth = depth;
        }
        touchTime[i] += FIXED_DT;
        if (touchTime[i] > rep[i].longestContact) rep[i].longestContact = touchTime[i];
        if (touchTime[i] >= PIN_SECONDS) {
          rep[i].pinSeconds += FIXED_DT;
          if (touchTime[i] - FIXED_DT < PIN_SECONDS) rep[i].pins++;
        }
      } else if (touching[i]) {
        touching[i] = false;
        touchTime[i] = 0;
        cur[i] = null;
      }

      // mode accounting
      rep[i].modeSeconds[mode] = (rep[i].modeSeconds[mode] ?? 0) + FIXED_DT;
      if (mode !== prevMode[i]) {
        if ((mode === 'reverse' || mode === 'realign') && prevMode[i] === 'race') {
          rep[i].recoveryEntries++;
          recoveryEntryT[i].push(t);
        }
        prevMode[i] = mode;
      }
      const sl = Math.min(nSlots - 1, Math.floor(t / SLOT));
      modeSlot[i][sl] = MODE_IDX[mode] ?? 1;
      speedSlotSum[i * nSlots + sl] += Math.abs(karts[i].speed);
      if (i === 0) speedSlotN[sl] += 1;
      if (d && d.wantsRespawn) respawnT[i].push(t);
    }

    if (s % 15 === 0) {
      sampleN++;
      for (let i = 0; i < FIELD; i++) speedSum[i] += Math.abs(karts[i].speed);
    }

    // --- early exit: every AI has done its laps ----------------------------
    if (s % 60 === 0) {
      let done = 0;
      for (let i = 1; i < FIELD; i++) if (rep[i].finished) done++;
      if (done === FIELD - 1) {
        s++;
        break;
      }
    }
  }

  const wallMs = Date.now() - wall0;
  const raceSeconds = elapsed;

  for (const u of unsub) u();

  let hazardAvoidTicks = 0;
  let hazardAvoidPeak = 0;
  for (let i = 1; i < FIELD; i++) {
    const d = ai.getDriver(i);
    if (!d) continue;
    hazardAvoidTicks += d.hazardAvoidCount;
    hazardAvoidPeak = Math.max(hazardAvoidPeak, d.hazardAvoidPeakBias);
  }

  // --- finalise -----------------------------------------------------------
  for (let i = 0; i < FIELD; i++) {
    const r = rep[i];
    r.meanSpeed = sampleN ? speedSum[i] / sampleN : 0;
    if (!r.finished) r.raceSeconds = raceSeconds;
    const d = i === 0 ? player : ai.getDriver(i);
    if (d) {
      r.offTrack = d.offTrackSeconds;
      r.recovery = d.recoveryLifetime;
      r.stuckEpisodes = d.stuckEpisodeCount;
    }
    // Respawn requests are latched every tick they are true; collapse to edges.
    let n = 0;
    let last = -99;
    for (const tt of respawnT[i]) {
      if (tt - last > 0.5) n++;
      last = tt;
    }
    r.respawns = n;
  }

  // --- LOOP SCAN ----------------------------------------------------------
  const loops: LoopEvent[] = [];
  for (let i = 1; i < FIELD; i++) {
    const list = eps[i];
    let j = 0;
    while (j < list.length) {
      // Greedy: grow a run of episodes that satisfy the window + arc test.
      let k = j;
      let lo = list[j].arc;
      let hi = list[j].arc;
      while (k + 1 < list.length) {
        const nx = list[k + 1];
        if (nx.t0 - list[j].t0 > LOOP_WINDOW) break;
        const nlo = Math.min(lo, nx.arc);
        const nhi = Math.max(hi, nx.arc);
        // Arc wraps; compare on the shorter way round.
        const span = Math.min(nhi - nlo, L - (nhi - nlo));
        if (span > LOOP_ARC) break;
        lo = nlo;
        hi = nhi;
        k++;
      }
      const count = k - j + 1;
      if (count >= LOOP_N) {
        const t0 = list[j].t0;
        const t1 = list[k].t0 + list[k].dur;
        const modeSeconds = blankModes();
        const sl0 = Math.floor(t0 / SLOT);
        const sl1 = Math.min(nSlots - 1, Math.floor(t1 / SLOT));
        for (let sl = sl0; sl <= sl1; sl++) {
          const nm = MODE_NAME[modeSlot[i][sl]] ?? 'race';
          modeSeconds[nm] += SLOT;
        }
        let secs = 0;
        for (let q = j; q <= k; q++) secs += list[q].dur;
        let spd = 0;
        let sn = 0;
        for (let sl = sl0; sl <= sl1; sl++) {
          spd += speedSlotSum[i * nSlots + sl];
          sn += Math.max(1, speedSlotN[sl]);
        }
        loops.push({
          kart: i,
          character: rep[i].character,
          personality: rep[i].personality,
          gridSlot: rep[i].gridSlot,
          t0,
          t1,
          arcLo: lo,
          arcHi: hi,
          episodes: count,
          seconds: secs,
          modeSeconds,
          recoveryEntries: recoveryEntryT[i].filter((x) => x >= t0 && x <= t1).length,
          meanSpeed: sn ? spd / sn : 0,
          respawned: respawnT[i].some((x) => x >= t0 && x <= t1),
        });
        rep[i].loops++;
        if (count > rep[i].worstLoopEpisodes) {
          rep[i].worstLoopEpisodes = count;
          rep[i].worstLoopArc = lo;
        }
        j = k + 1;
      } else {
        j++;
      }
    }
  }

  let aiFinished = 0;
  for (let i = 1; i < FIELD; i++) if (rep[i].finished) aiFinished++;

  const allEps: Episode[] = [];
  if (opts.keepEpisodes) for (let i = 1; i < FIELD; i++) allEps.push(...eps[i]);

  ai.dispose();
  items?.dispose();
  physics.dispose();

  return {
    trackId: opts.trackId,
    seed,
    lapLength: L,
    seconds: raceSeconds,
    targetLaps,
    itemsOn,
    hazardTicks,
    hazardPeak,
    hazardAvoidTicks,
    hazardAvoidPeak,
    itemsUsed,
    boxPickups,
    itemHits,
    karts: rep,
    loops,
    episodes: allEps,
    arcSeconds,
    offArcSeconds,
    bucket: BUCKET,
    aiFinished,
    wallMs,
  };
}

export function printLoopReport(r: LoopReport, label: string): void {
  console.log(
    `\n=== ${label} — ${r.trackId} seed ${r.seed} (lap ${r.lapLength.toFixed(0)} m, ` +
      `${r.targetLaps} laps, ran ${r.seconds.toFixed(0)} s, ${r.wallMs} ms) ===`,
  );
  console.log(
    `items ${r.itemsOn ? 'ON' : 'off'}: live-hazard samples ${r.hazardTicks} (peak ${r.hazardPeak}), ` +
      `AI hazard-avoid ticks ${r.hazardAvoidTicks} (peak bias ${r.hazardAvoidPeak.toFixed(2)} m), ` +
      `boxes ${r.boxPickups}, used ${r.itemsUsed}, hits ${r.itemHits}, AI finished ${r.aiFinished}/11`,
  );
  console.log(
    'id char     pers        slot laps  eps  cSec  long  pin pSec | offEp longOff big deep | LOOP worst @arc | rec ent resp | off  recS  stuck  vAvg',
  );
  for (const k of r.karts) {
    console.log(
      `${String(k.id).padStart(2)} ${k.character.padEnd(8)} ${k.personality.padEnd(11)}` +
        ` ${String(k.gridSlot).padStart(4)} ${String(k.laps).padStart(4)} ` +
        `${String(k.episodes).padStart(4)} ${k.contactSeconds.toFixed(1).padStart(5)} ` +
        `${k.longestContact.toFixed(1).padStart(5)} ${String(k.pins).padStart(4)} ` +
        `${k.pinSeconds.toFixed(1).padStart(4)} |` +
        ` ${String(k.offEpisodes).padStart(5)} ${k.longestOff.toFixed(1).padStart(7)} ` +
        `${String(k.bigOff).padStart(3)} ${k.worstOffDepth.toFixed(1).padStart(4)} |` +
        ` ${String(k.loops).padStart(4)} ${String(k.worstLoopEpisodes).padStart(5)} ` +
        `${String(Math.round(k.worstLoopArc)).padStart(5)} |` +
        ` ${String(k.recoveryEntries).padStart(7)} ${String(k.respawns).padStart(4)} |` +
        ` ${k.offTrack.toFixed(1).padStart(4)} ${k.recovery.toFixed(1).padStart(5)} ` +
        `${String(k.stuckEpisodes).padStart(5)} ${k.meanSpeed.toFixed(1).padStart(5)}` +
        (k.isPlayer ? '  <- player' : ''),
    );
  }
  if (r.loops.length) {
    console.log(`LOOPS (${LOOP_N}+ contacts inside ${LOOP_WINDOW} s and ${LOOP_ARC} m):`);
    const sorted = r.loops.slice().sort((a, b) => b.episodes - a.episodes);
    for (const lp of sorted.slice(0, 14)) {
      const ms = Object.entries(lp.modeSeconds)
        .filter(([, v]) => v > 0)
        .map(([m, v]) => `${m} ${v.toFixed(1)}s`)
        .join(', ');
      console.log(
        `   k${String(lp.kart).padStart(2)} ${lp.character.padEnd(8)} ${lp.personality.padEnd(10)}` +
          ` t ${lp.t0.toFixed(1)}..${lp.t1.toFixed(1)}  arc ${Math.round(lp.arcLo)}..${Math.round(lp.arcHi)} m` +
          `  ${lp.episodes} hits / ${lp.seconds.toFixed(1)} s contact  v ${lp.meanSpeed.toFixed(1)}` +
          `  recEntries ${lp.recoveryEntries}${lp.respawned ? ' RESPAWN' : ''}  [${ms}]`,
      );
    }
  } else {
    console.log('LOOPS: none');
  }
  // Arc hotspots by CONTACT SECONDS, not episode count.
  const hs: Array<{ arc: number; sec: number }> = [];
  for (let b = 0; b < r.arcSeconds.length; b++) {
    if (r.arcSeconds[b] > 0.05) hs.push({ arc: b * r.bucket, sec: r.arcSeconds[b] });
  }
  hs.sort((a, b) => b.sec - a.sec);
  if (hs.length) {
    console.log('contact SECONDS by arc (top 8):');
    for (const h of hs.slice(0, 8)) {
      console.log(
        `   ${String(Math.round(h.arc)).padStart(5)}..${String(Math.round(h.arc + r.bucket)).padStart(5)} m` +
          `  t=${(h.arc / r.lapLength).toFixed(3)}  ${h.sec.toFixed(2)} s`,
      );
    }
  }
  const os: Array<{ arc: number; sec: number }> = [];
  for (let b = 0; b < r.offArcSeconds.length; b++) {
    if (r.offArcSeconds[b] > 0.05) os.push({ arc: b * r.bucket, sec: r.offArcSeconds[b] });
  }
  os.sort((a, b) => b.sec - a.sec);
  if (os.length) {
    console.log('OFF-ROAD seconds by arc (top 8):');
    for (const h of os.slice(0, 8)) {
      console.log(
        `   ${String(Math.round(h.arc)).padStart(5)}..${String(Math.round(h.arc + r.bucket)).padStart(5)} m` +
          `  t=${(h.arc / r.lapLength).toFixed(3)}  ${h.sec.toFixed(2)} s`,
      );
    }
  }
}
