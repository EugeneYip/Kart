/**
 * ============================================================================
 *  FOXY KART — AUDIO ENGINE (facade)
 * ============================================================================
 *  One AudioContext, one master chain, one place that listens to the EventBus.
 *
 *  Signal flow
 *  -----------
 *    SfxBank        ─► sfxBus     ┐
 *    EngineSounds   ─► engineBus  ├─► preSum ─► submerge ─► duck ─► masterVol
 *    Music          ─► musicBus   │                                    │
 *    WindLayer      ─► ambientBus │                                    ▼
 *    ReverbBus.out  ─► wetBus     ┘                            glue compressor
 *                                                                      │
 *                            analyser ◄── limiter ◄────────────────────┘
 *                                            │
 *                                            ▼
 *                                       destination
 *
 *  The two dynamics stages are NOT optional. Twelve engine voices, a music bed
 *  and a dozen impacts all summing into one bus will pin the output at 0 dBFS
 *  and sound like a blown speaker. The glue compressor keeps the mix dense, the
 *  limiter guarantees nothing ever leaves above -1 dBFS.
 *
 *  Autoplay policy
 *  ---------------
 *  The context is created immediately but starts `suspended`. We bake every
 *  buffer regardless (OfflineAudioContext needs no gesture), then resume on the
 *  first pointerdown/keydown. `init()` is written so that *every* failure path
 *  — no WebAudio at all, blocked autoplay, a bake that throws — leaves the game
 *  booting normally, silently. Audio must never be the reason the game is a
 *  black screen.
 * ============================================================================
 */

import * as THREE from 'three';
import { bus } from '@/core/EventBus';
import type { FrameContext, IAudioService, ISubsystem } from '@/core/Types';
import { ItemType, SurfaceType } from '@/core/Types';
import { RACE, SURFACES } from '@/core/Config';
import { clamp, clamp01, damp } from '@/core/MathUtils';

import { SfxBank, SFX_IDS } from './SfxBank';
import type { SfxHandle } from './SfxBank';
import { Music } from './Music';
import type { ThemeId } from './Music';
import { EngineSoundSystem } from './EngineSound';
import type { EngineCharacterId } from './EngineSound';
import { ReverbBus, SubmergeFilter, WindLayer } from './Reverb';
import type { EnvironmentPreset } from './Reverb';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MAX_KARTS = 16;

/** Per-bus static trims. Volume sliders multiply on top of these. */
const TRIM = {
  music: 0.82,
  sfx: 1.0,
  engine: 0.78,
  ambient: 0.5,
  wet: 1.0,
} as const;

/** Reference top speed used to normalise "how fast am I going" into 0..1. */
const REF_TOP_SPEED = 28;

/**
 * Minimum gap between two plays of the same buffer, seconds.
 *
 * Two independent paths can request the same sound in the same frame (the
 * EventBus mapping here, plus ItemSystem/HUD calling `play()` directly). Two
 * identical buffers a few samples apart comb-filter into a thin flange, which
 * is instantly recognisable as an amateur mix. This guard collapses them.
 */
const DEFAULT_RETRIGGER = 0.035;
const RETRIGGER: Record<string, number> = {
  shell_bounce: 0.015,
  coin: 0.012,
  ui_move: 0.02,
  kart_bump: 0.022,
  hop: 0.02,
  land_soft: 0.03,
  land_hard: 0.05,
  wall_hit_hard: 0.06,
  position_gain: 0.3,
  position_lose: 0.3,
  lap_complete: 0.5,
  final_lap: 1.0,
  explosion: 0.05,
};

/** Sounds that automatically pull the music down: [amount, release seconds]. */
const DUCK_SFX: Record<string, readonly [number, number]> = {
  explosion: [0.5, 0.9],
  lightning_strike: [0.55, 1.2],
  countdown_go: [0.3, 0.55],
  countdown_beep_1: [0.16, 0.3],
  countdown_beep_2: [0.16, 0.3],
  countdown_beep_3: [0.16, 0.3],
  lap_complete: [0.32, 0.75],
  final_lap: [0.6, 1.5],
  finish_1st: [0.62, 1.7],
  finish_other: [0.48, 1.3],
  blue_shell_alarm: [0.28, 0.7],
  squash: [0.32, 0.6],
  spin_out: [0.26, 0.55],
  shrink: [0.3, 0.6],
  respawn: [0.24, 0.5],
};

/** Surfaces that get the extra low-frequency scrub layer on top of the roll. */
const OFFROAD_SURFACES: ReadonlySet<SurfaceType> = new Set([
  SurfaceType.OffRoad, SurfaceType.Grass, SurfaceType.Sand, SurfaceType.Dirt,
]);

// Module-level scratch — nothing in update() allocates.
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _vel = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

interface Vec3Like { x: number; y: number; z: number }

// ---------------------------------------------------------------------------

export interface AudioDebugInfo {
  state: string;
  sampleRate: number;
  ready: boolean;
  voices: number;
  engineVoices: number;
  engineHot: number;
  musicPlaying: boolean;
  musicBpm: number;
  musicIntensity: number;
  finalLap: boolean;
  environment: EnvironmentPreset;
  duck: number;
  playerSpeed: number;
  busGains: { music: number; sfx: number; engine: number; ambient: number };
  masterGain: number;
  limiterReduction: number;
}

/**
 * The single audio service the rest of the game talks to.
 *
 * Everything reactive is wired through the EventBus in `init()` — nothing here
 * polls gameplay state. The only per-frame inputs are the listener transform
 * (from the camera) and `updateEngine()` pushes from the kart manager.
 */
export class AudioEngine implements IAudioService, ISubsystem {
  // --- context + master chain ---------------------------------------------
  private camera: THREE.PerspectiveCamera;
  private actx: AudioContext | null = null;

  private preSum: GainNode | null = null;
  private submerge: SubmergeFilter | null = null;
  private duckGain: GainNode | null = null;
  private masterVol: GainNode | null = null;
  private glue: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private analyserNode: AnalyserNode | null = null;

  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private wetBus: GainNode | null = null;

  // --- subsystems ----------------------------------------------------------
  private sfx: SfxBank | null = null;
  private music: Music | null = null;
  private engines: EngineSoundSystem | null = null;
  private reverb: ReverbBus | null = null;
  private wind: WindLayer | null = null;

  // --- volumes -------------------------------------------------------------
  private volMaster = 0.9;
  private volMusic = 0.62;
  private volSfx = 0.95;

  // --- duck envelope -------------------------------------------------------
  private duckAmount = 0;
  private duckTotal = 1;
  private duckTimer = 0;
  private duckLevel = 0;

  // --- listener ------------------------------------------------------------
  private listenerPos = { x: 0, y: 0, z: 0 };
  private listenerVel = { x: 0, y: 0, z: 0 };
  private lastListenerPos = { x: 0, y: 0, z: 0 };
  private listenerValid = false;
  private explicitListener = false;

  // --- karts ---------------------------------------------------------------
  private playerId = -1;
  private bound = new Uint8Array(MAX_KARTS);
  private boostUntil = new Float64Array(MAX_KARTS);
  private boostOn = new Uint8Array(MAX_KARTS);
  private playerSpeed = 0;
  private playerRpm = 0;
  private playerLoad = 0;
  private playerPos = { x: 0, y: 0, z: 0 };
  private playerPosTime = -1;

  // --- continuous loops ----------------------------------------------------
  private rollHandle: SfxHandle | null = null;
  private rollId = 'roll_asphalt';
  private rollWanted = 'roll_asphalt';
  private offroadHandle: SfxHandle | null = null;
  private offroadWanted = false;
  private driftHandle: SfxHandle | null = null;
  private driftTier = 0;
  private scrapeHandle: SfxHandle | null = null;
  private scrapeTimer = 0;
  private scrapeStrength = 0;
  private starHandle: SfxHandle | null = null;
  private bulletHandle: SfxHandle | null = null;
  private alarmHandle: SfxHandle | null = null;

  // --- state ---------------------------------------------------------------
  private environment: EnvironmentPreset = 'outdoor';
  private theme: ThemeId = 'coastal';
  private raceLive = false;
  private intensityExternal = false;
  private wantMusic = false;
  private submergeAmount = 0;

  private initStarted = false;
  private initDone = false;
  private disposed = false;
  private resumeAttached = false;
  private warned = new Set<string>();
  private lastPlayAt = new Map<string, number>();
  private offs: Array<() => void> = [];

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Build the context, bake every buffer, subscribe to the bus.
   *
   * Idempotent: Game calls this explicitly, then Engine.initAll() calls it a
   * second time for every registered subsystem.
   *
   * Never throws, never hangs. A bake that wedges is abandoned after 15 s and
   * the game continues with whatever finished.
   */
  async init(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;

    // Events are wired first and unconditionally: even with a dead context the
    // handlers must exist so nothing downstream sees a half-live service.
    this.subscribe();

    try {
      this.buildContext();
    } catch (err) {
      console.warn('[AudioEngine] no usable AudioContext — running silent:', err);
      this.initDone = true;
      return;
    }

    this.attachResumeGesture();

    try {
      await this.withTimeout(this.bakeAll(), 15000, 'bake');
    } catch (err) {
      console.warn('[AudioEngine] asset bake incomplete:', err);
    }

    this.applyVolumes();
    this.initDone = true;

    // If the browser already granted audio (returning visitor, or a gesture
    // landed during the bake) start the persistent beds right away.
    if (this.actx && this.actx.state === 'running') this.onContextRunning();
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
    let timer = 0;
    const guard = new Promise<null>((resolve) => {
      timer = window.setTimeout(() => {
        console.warn(`[AudioEngine] ${label} timed out after ${ms} ms`);
        resolve(null);
      }, ms);
    });
    try {
      return await Promise.race([p, guard]);
    } finally {
      clearTimeout(timer);
    }
  }

  private buildContext(): void {
    type Ctor = new (o?: AudioContextOptions) => AudioContext;
    const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) throw new Error('AudioContext unavailable');

    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.actx = ctx;

    // --- master chain, built back to front ---------------------------------
    // Brickwall. ratio 20 + 1.5 ms attack behaves as a limiter in practice.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.0015;
    limiter.release.value = 0.08;
    limiter.connect(ctx.destination);
    this.limiter = limiter;

    // Glue: gentle, slow, keeps 12 engines + music from fighting.
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 10;
    glue.ratio.value = 3;
    glue.attack.value = 0.006;
    glue.release.value = 0.22;
    glue.connect(limiter);
    this.glue = glue;

    // Verification tap. Sits post-limiter so the harness measures what the
    // speaker gets, not what we hoped to send it.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.55;
    analyser.minDecibels = -110;
    analyser.maxDecibels = -6;
    limiter.connect(analyser);
    this.analyserNode = analyser;

    const masterVol = ctx.createGain();
    masterVol.gain.value = 0.9;
    masterVol.connect(glue);
    this.masterVol = masterVol;

    const duckGain = ctx.createGain();
    duckGain.gain.value = 1;
    duckGain.connect(masterVol);
    this.duckGain = duckGain;

    const submerge = new SubmergeFilter(ctx);
    submerge.output.connect(duckGain);
    this.submerge = submerge;

    const preSum = ctx.createGain();
    preSum.gain.value = 1;
    preSum.connect(submerge.input);
    this.preSum = preSum;

    const mkBus = (g: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = g;
      n.connect(preSum);
      return n;
    };
    this.musicBus = mkBus(TRIM.music);
    this.sfxBus = mkBus(TRIM.sfx);
    this.engineBus = mkBus(TRIM.engine);
    this.ambientBus = mkBus(TRIM.ambient);
    this.wetBus = mkBus(TRIM.wet);

    // --- reverb send/return -------------------------------------------------
    const reverb = new ReverbBus(ctx);
    reverb.output.connect(this.wetBus);
    this.reverb = reverb;

    // --- sources -----------------------------------------------------------
    this.sfx = new SfxBank(ctx, {
      dest: this.sfxBus,
      reverbSend: reverb.input,
      maxTotalVoices: 40,
    });
    this.music = new Music(ctx, { dest: this.musicBus, reverbSend: reverb.input });
    this.engines = new EngineSoundSystem(ctx, {
      dest: this.engineBus,
      reverbSend: reverb.input,
      maxSimulated: 5,
    });
    this.wind = new WindLayer(ctx, this.ambientBus);

    this.updateListenerNode(0, 1.6, 0, 0, 0, -1, 0, 1, 0);
  }

  private async bakeAll(): Promise<void> {
    // IRs are synchronous maths (~15 ms each) — do them first so the very first
    // sound already lands in a space.
    try {
      this.reverb?.init();
    } catch (err) {
      console.warn('[AudioEngine] reverb IR bake failed:', err);
    }

    // The two heavy async bakes run concurrently; both are self-contained and
    // already batch their own yields to the event loop.
    const jobs: Array<Promise<void>> = [];
    if (this.sfx) {
      jobs.push(
        this.sfx.init().catch((err: unknown) => {
          console.warn('[AudioEngine] sfx bake failed:', err);
        }),
      );
    }
    if (this.music) {
      jobs.push(
        this.music.init().catch((err: unknown) => {
          console.warn('[AudioEngine] music bake failed:', err);
        }),
      );
    }
    if (this.engines) {
      jobs.push(
        this.engines.init().catch((err: unknown) => {
          console.warn('[AudioEngine] engine bake failed:', err);
        }),
      );
    }
    await Promise.all(jobs);
  }

  // -------------------------------------------------------------------------
  // Autoplay unlock
  // -------------------------------------------------------------------------

  private attachResumeGesture(): void {
    if (this.resumeAttached) return;
    this.resumeAttached = true;

    const unlock = (): void => {
      void this.resumeContext();
    };
    const opts: AddEventListenerOptions = { once: true, capture: true, passive: true };
    // Any of these may fire; whichever lands first wins and the rest are
    // harmless no-ops because resumeContext() is idempotent.
    for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) {
      window.addEventListener(ev, unlock, opts);
      this.offs.push(() => window.removeEventListener(ev, unlock, { capture: true }));
    }

    const onVisibility = (): void => {
      const ctx = this.actx;
      if (!ctx) return;
      if (document.hidden) {
        if (ctx.state === 'running') void ctx.suspend().catch(() => { /* noop */ });
      } else if (ctx.state === 'suspended' && this.wantMusic) {
        void ctx.resume().catch(() => { /* noop */ });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.offs.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }

  /**
   * Bring the context out of `suspended`. Safe to call any number of times,
   * from anywhere; resolves even when the browser refuses.
   */
  async resumeContext(): Promise<void> {
    const ctx = this.actx;
    if (!ctx) return;
    if (this.contextState() === 'running') { this.onContextRunning(); return; }
    try {
      await ctx.resume();
    } catch {
      // Autoplay still blocked. Not an error — we simply stay silent and the
      // next gesture will try again via the listener below.
      this.reattachUnlock();
      return;
    }
    if (this.contextState() === 'running') this.onContextRunning();
    else this.reattachUnlock();
  }

  /**
   * Read the live context state.
   *
   * Deliberately a method call: `AudioContext.state` is declared readonly, so
   * reading it twice off a `const` narrows the type permanently and the second
   * check would be compiled away. It genuinely changes underneath us.
   */
  private contextState(): AudioContextState | 'none' {
    return this.actx ? this.actx.state : 'none';
  }

  /** Alias used by the UI layer's structural `AudioLike` type. */
  resume(): void { void this.resumeContext(); }

  private reattachUnlock(): void {
    this.resumeAttached = false;
    this.attachResumeGesture();
  }

  /** Everything that can only happen once the clock is actually moving. */
  private onContextRunning(): void {
    if (!this.actx || this.actx.state !== 'running') return;
    try {
      this.wind?.start();
    } catch { /* noop */ }
    if (this.wantMusic && this.music && !this.music.isPlaying) {
      this.music.setTheme(this.theme, true);
      this.music.start();
    }
  }

  // =========================================================================
  // Per-frame
  // =========================================================================

  update(ctx: FrameContext): void {
    if (!this.actx || this.disposed) return;
    const dt = ctx.dt > 0 ? Math.min(ctx.dt, 0.1) : 0.016;

    // --- listener ----------------------------------------------------------
    if (!this.explicitListener) this.syncListenerFromCamera(dt);
    this.explicitListener = false;

    // --- duck envelope -----------------------------------------------------
    if (this.duckTimer > 0) {
      this.duckTimer = Math.max(0, this.duckTimer - dt);
      const k = this.duckTimer / Math.max(1e-3, this.duckTotal);
      this.duckLevel = this.duckAmount * k * k; // quick release, long tail
      if (this.duckTimer === 0) { this.duckLevel = 0; this.duckAmount = 0; }
      this.applyVolumes();
    }

    // --- boost tails -------------------------------------------------------
    const now = this.actx.currentTime;
    for (let i = 0; i < MAX_KARTS; i++) {
      if (this.boostOn[i] && now >= this.boostUntil[i]) {
        this.boostOn[i] = 0;
        this.engines?.setBoost(i, false);
      }
    }

    // --- engines -----------------------------------------------------------
    this.engines?.frame(dt, this.listenerPos, this.listenerVel);

    // --- music -------------------------------------------------------------
    if (this.music) {
      if (!this.intensityExternal) {
        const speed01 = clamp01(this.playerSpeed / REF_TOP_SPEED);
        const auto = this.raceLive
          ? clamp01(0.34 + 0.44 * speed01 + (this.music.isFinalLap ? 0.22 : 0))
          : 0.2;
        this.music.setIntensity(auto);
      }
      this.music.update(dt);
    }

    // --- ambience ----------------------------------------------------------
    if (this.wind) {
      this.wind.setSpeed(this.playerSpeed / REF_TOP_SPEED);
      this.wind.update(dt);
    }

    // --- continuous surface / drift / scrape layers ------------------------
    this.syncRollLoop(dt);
    this.syncScrape(dt);
  }

  private syncListenerFromCamera(dt: number): void {
    const cam = this.camera;
    cam.getWorldPosition(_pos);
    cam.getWorldQuaternion(_quat);

    if (this.listenerValid && dt > 1e-4) {
      const inv = 1 / dt;
      this.listenerVel.x = damp(this.listenerVel.x, (_pos.x - this.lastListenerPos.x) * inv, 0.05, dt);
      this.listenerVel.y = damp(this.listenerVel.y, (_pos.y - this.lastListenerPos.y) * inv, 0.05, dt);
      this.listenerVel.z = damp(this.listenerVel.z, (_pos.z - this.lastListenerPos.z) * inv, 0.05, dt);
    } else {
      this.listenerVel.x = 0; this.listenerVel.y = 0; this.listenerVel.z = 0;
    }
    this.lastListenerPos.x = _pos.x;
    this.lastListenerPos.y = _pos.y;
    this.lastListenerPos.z = _pos.z;
    this.listenerValid = true;

    _fwd.copy(FORWARD).applyQuaternion(_quat);
    _up.copy(UP).applyQuaternion(_quat);
    this.commitListener(_pos, _fwd, _up);
  }

  private commitListener(p: THREE.Vector3, fwd: THREE.Vector3, up: THREE.Vector3): void {
    this.listenerPos.x = p.x; this.listenerPos.y = p.y; this.listenerPos.z = p.z;
    this.sfx?.setListenerPosition(p.x, p.y, p.z);
    this.updateListenerNode(p.x, p.y, p.z, fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
  }

  /** Handles both the AudioParam listener and the legacy setPosition API. */
  private updateListenerNode(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
  ): void {
    const l = this.actx?.listener;
    if (!l) return;
    type Legacy = AudioListener & {
      setPosition?(x: number, y: number, z: number): void;
      setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
    };
    if (l.positionX) {
      l.positionX.value = px; l.positionY.value = py; l.positionZ.value = pz;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
    } else {
      const legacy = l as Legacy;
      legacy.setPosition?.(px, py, pz);
      legacy.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  // -------------------------------------------------------------------------
  // Rolling / drift / scrape beds
  // -------------------------------------------------------------------------

  private syncRollLoop(dt: number): void {
    if (!this.sfx || !this.sfx.isReady) return;
    const speed01 = clamp01(this.playerSpeed / REF_TOP_SPEED);
    const active = this.playerId >= 0 && speed01 > 0.015;

    // Surface swap: kill the old loop with a short fade, start the new one.
    if (this.rollWanted !== this.rollId) {
      this.rollHandle?.stop(0.12);
      this.rollHandle = null;
      this.rollId = this.rollWanted;
    }

    if (active && !this.rollHandle) {
      this.rollHandle = this.sfx.play(this.rollId, { volume: 0.0001, fadeIn: 0.1, loop: true });
    } else if (!active && this.rollHandle) {
      this.rollHandle.stop(0.18);
      this.rollHandle = null;
    }

    if (this.rollHandle) {
      // Rolling noise is mostly amplitude, but the brightness rising with speed
      // is what sells "tyres on tarmac" instead of "looping hiss".
      const vol = 0.62 * Math.pow(speed01, 0.72);
      this.rollHandle.setVolume(vol, 0.06);
      this.rollHandle.setFilter(600 + 9000 * Math.pow(speed01, 0.85), 0.8, 0.09);
      this.rollHandle.setRate(0.86 + 0.32 * speed01, 0.1);
    }

    // Off-road scrub layer.
    const wantOffroad = this.offroadWanted && speed01 > 0.05;
    if (wantOffroad && !this.offroadHandle) {
      this.offroadHandle = this.sfx.play('offroad_loop', { volume: 0.0001, fadeIn: 0.12, loop: true });
    } else if (!wantOffroad && this.offroadHandle) {
      this.offroadHandle.stop(0.2);
      this.offroadHandle = null;
    }
    this.offroadHandle?.setVolume(0.5 * Math.pow(speed01, 0.6), 0.08);

    // Drift loop brightness tracks the charge tier.
    if (this.driftHandle) {
      const tierBoost = this.driftTier * 0.16;
      this.driftHandle.setVolume(clamp01(0.42 + tierBoost) * (0.35 + 0.65 * speed01), 0.07);
      this.driftHandle.setFilter(1400 + 2600 * this.driftTier + 4000 * speed01, 1.1, 0.12);
    }
    void dt;
  }

  private syncScrape(dt: number): void {
    if (this.scrapeTimer > 0) {
      this.scrapeTimer -= dt;
      if (this.scrapeTimer <= 0) {
        this.scrapeHandle?.stop(0.14);
        this.scrapeHandle = null;
        this.scrapeStrength = 0;
      } else if (this.scrapeHandle) {
        this.scrapeStrength = damp(this.scrapeStrength, 0, 0.25, dt);
        this.scrapeHandle.setVolume(0.5 * this.scrapeStrength, 0.05);
      }
    }
  }

  // =========================================================================
  // IAudioService
  // =========================================================================

  /**
   * Fire a one-shot (or a spec-declared loop) by id.
   *
   * Unknown ids warn exactly once and are otherwise ignored — a typo in another
   * subsystem must never take the frame down.
   */
  play(id: string, opts?: { position?: THREE.Vector3; volume?: number; rate?: number }): void {
    const bank = this.sfx;
    if (!bank || this.disposed) return;

    // Control ids that manage a sustained loop rather than firing a one-shot.
    if (this.handleLoopControl(id)) return;

    const key = bank.resolve(id);
    if (!bank.has(key)) {
      if (!this.warned.has(id)) {
        this.warned.add(id);
        console.warn(`[AudioEngine] unknown sfx id "${id}" (ignored)`);
      }
      return;
    }

    const ctx = this.actx;
    const now = ctx ? ctx.currentTime : 0;
    const gap = RETRIGGER[key] ?? DEFAULT_RETRIGGER;
    const last = this.lastPlayAt.get(key);
    if (last !== undefined && now - last < gap) return;
    this.lastPlayAt.set(key, now);

    bank.play(key, {
      position: opts?.position,
      volume: opts?.volume,
      rate: opts?.rate,
      loop: false,
    });

    const d = DUCK_SFX[key];
    if (d) this.duck(d[0], d[1]);
  }

  /** Explicit looping play with a handle, for callers that manage their own. */
  playLoop(id: string, opts?: { position?: THREE.Vector3; volume?: number }): SfxHandle | null {
    if (!this.sfx) return null;
    const key = this.sfx.resolve(id);
    if (!this.sfx.has(key)) return null;
    return this.sfx.play(key, { ...opts, loop: true, fadeIn: 0.08 });
  }

  bindEngine(kartId: number, isPlayer: boolean): void {
    if (kartId < 0 || kartId >= MAX_KARTS) return;
    this.bound[kartId] = 1;
    if (isPlayer) this.playerId = kartId;
    this.engines?.bind(kartId, isPlayer);
  }

  unbindEngine(kartId: number): void {
    if (kartId < 0 || kartId >= MAX_KARTS) return;
    this.bound[kartId] = 0;
    this.boostOn[kartId] = 0;
    this.engines?.unbind(kartId);
    if (this.playerId === kartId) this.playerId = -1;
  }

  /** Per-chassis engine timbre. Optional — bind() picks a default. */
  setEngineCharacter(kartId: number, character: EngineCharacterId): void {
    this.engines?.setCharacter(kartId, character);
  }

  updateEngine(kartId: number, rpm: number, load: number, position: THREE.Vector3): void {
    if (this.disposed) return;
    if (kartId === this.playerId) {
      this.playerRpm = rpm;
      this.playerLoad = load;
      const now = this.actx ? this.actx.currentTime : 0;
      if (this.playerPosTime >= 0) {
        const dt = now - this.playerPosTime;
        if (dt > 1e-4) {
          const dx = position.x - this.playerPos.x;
          const dy = position.y - this.playerPos.y;
          const dz = position.z - this.playerPos.z;
          const inst = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
          this.playerSpeed = damp(this.playerSpeed, Math.min(inst, 90), 0.07, Math.min(dt, 0.1));
        }
      }
      this.playerPos.x = position.x;
      this.playerPos.y = position.y;
      this.playerPos.z = position.z;
      this.playerPosTime = now;
    }
    this.engines?.update(kartId, rpm, load, position);
  }

  setMusicIntensity(v: number): void {
    this.intensityExternal = true;
    this.music?.setIntensity(clamp01(v));
  }

  /** Hand intensity control back to the automatic speed-driven model. */
  releaseMusicIntensity(): void { this.intensityExternal = false; }

  setMusicTheme(id: ThemeId, immediate = false): void {
    this.theme = id;
    this.music?.setTheme(id, immediate);
  }

  startMusic(): void {
    this.wantMusic = true;
    if (this.actx?.state === 'running' && this.music && !this.music.isPlaying) {
      this.music.setTheme(this.theme, true);
      this.music.start();
    }
  }

  stopMusic(fade = 0.5): void {
    this.wantMusic = false;
    this.music?.stop(fade);
  }

  setFinalLap(on: boolean): void { this.music?.setFinalLap(on); }

  /**
   * Global duck. The strongest active duck wins — a small overtake duck must
   * never cut short the big explosion duck that is already running.
   */
  duck(amount: number, seconds: number): void {
    const a = clamp01(amount);
    const s = Math.max(0.05, seconds);
    if (a <= this.duckLevel) return;
    this.duckAmount = a;
    this.duckTotal = s;
    this.duckTimer = s;
    this.duckLevel = a;
    this.applyVolumes();
  }

  setMasterVolume(v: number): void { this.volMaster = clamp01(v); this.applyVolumes(); }
  setMusicVolume(v: number): void { this.volMusic = clamp01(v); this.applyVolumes(); }
  setSfxVolume(v: number): void { this.volSfx = clamp01(v); this.applyVolumes(); }
  /** Alias — MenuSystem probes for a generic `setVolume`. */
  setVolume(v: number): void { this.setMasterVolume(v); }

  get masterVolume(): number { return this.volMaster; }
  get musicVolume(): number { return this.volMusic; }
  get sfxVolume(): number { return this.volSfx; }

  private applyVolumes(): void {
    const d = this.duckLevel;
    // Music takes the full duck; the rest only leans back a little so impacts
    // stay physical instead of the whole mix pumping.
    if (this.musicBus) this.musicBus.gain.value = this.volMusic * TRIM.music * (1 - d);
    if (this.sfxBus) this.sfxBus.gain.value = this.volSfx * TRIM.sfx;
    if (this.engineBus) this.engineBus.gain.value = this.volSfx * TRIM.engine * (1 - d * 0.35);
    if (this.ambientBus) this.ambientBus.gain.value = this.volSfx * TRIM.ambient * (1 - d * 0.5);
    if (this.wetBus) this.wetBus.gain.value = TRIM.wet * (1 - d * 0.3);
    // Perceptual taper on the master fader.
    if (this.masterVol) this.masterVol.gain.value = Math.pow(this.volMaster, 1.5) * 0.95;
    this.engines?.setVolume(1);
  }

  setListener(position: THREE.Vector3, quaternion: THREE.Quaternion, velocity: THREE.Vector3): void {
    this.explicitListener = true;
    _fwd.copy(FORWARD).applyQuaternion(quaternion);
    _up.copy(UP).applyQuaternion(quaternion);
    this.listenerVel.x = velocity.x;
    this.listenerVel.y = velocity.y;
    this.listenerVel.z = velocity.z;
    this.lastListenerPos.x = position.x;
    this.lastListenerPos.y = position.y;
    this.lastListenerPos.z = position.z;
    this.listenerValid = true;
    this.commitListener(position, _fwd, _up);
  }

  setEnvironment(preset: EnvironmentPreset): void {
    if (preset === this.environment) return;
    this.environment = preset;
    // 0.5 s is short enough to feel like the tunnel mouth and long enough that
    // the two convolvers never click against each other.
    this.reverb?.setPreset(preset, 0.5);
  }

  get currentEnvironment(): EnvironmentPreset { return this.environment; }

  /** 0 = dry air, 1 = fully submerged. Master insert. */
  setSubmerged(v: number): void {
    this.submergeAmount = clamp01(v);
    this.submerge?.set(this.submergeAmount, 0.3);
  }

  // =========================================================================
  // Event wiring — everything reactive lives here
  // =========================================================================

  private isPlayer(kartId: number): boolean {
    return kartId === this.playerId;
  }

  /** Positional plays get a light distance trim for non-player karts. */
  private at(kartId: number, id: string, position?: THREE.Vector3, volume = 1, rate = 1): void {
    const v = this.isPlayer(kartId) ? volume : volume * 0.7;
    this.play(id, { position, volume: v, rate });
  }

  private subscribe(): void {
    /** Register a bus subscription so `dispose()` can tear it down. */
    const own = (off: () => void): void => { this.offs.push(off); };

    // --- race flow ---------------------------------------------------------
    own(bus.on('race:countdown', ({ count }) => {
      this.startMusic();
      if (count >= 3) this.play('countdown_beep_1');
      else if (count === 2) this.play('countdown_beep_2');
      else if (count === 1) this.play('countdown_beep_3');
      else this.play('countdown_go');
      if (count >= 3) this.play('crowd_cheer', { volume: 0.35 });
    }));

    own(bus.on('race:start', ({ rocketStart }) => {
      this.raceLive = true;
      this.startMusic();
      this.setFinalLap(false);
      if (!this.intensityExternal) this.music?.setIntensity(0.55);
      if (rocketStart) this.play('boost_release', { volume: 1 });
    }));

    own(bus.on('race:lap', ({ kartId, lap, isBest }) => {
      if (!this.isPlayer(kartId)) return;
      if (lap >= RACE.laps) {
        this.play('final_lap');
        this.setFinalLap(true);
        this.play('crowd_cheer', { volume: 0.45 });
      } else {
        this.play('lap_complete', { volume: isBest ? 1 : 0.85 });
      }
    }));

    own(bus.on('race:finish', ({ kartId, position }) => {
      if (!this.isPlayer(kartId)) {
        this.play('finish_other', { volume: 0.35 });
        return;
      }
      this.play(position === 1 ? 'finish_1st' : 'finish_other');
      this.play('crowd_cheer', { volume: position <= 3 ? 0.9 : 0.5 });
      if (!this.intensityExternal) this.music?.setIntensity(0.35);
    }));

    own(bus.on('race:complete', () => {
      this.raceLive = false;
      this.setFinalLap(false);
      this.stopContinuous();
      this.music?.setIntensity(0.25);
    }));

    own(bus.on('race:positionChange', ({ kartId, from, to }) => {
      if (!this.isPlayer(kartId)) return;
      this.play(to < from ? 'position_gain' : 'position_lose', { volume: 0.85 });
    }));

    // --- kart chassis ------------------------------------------------------
    own(bus.on('kart:hop', ({ kartId, position }) => {
      this.at(kartId, 'hop', position, 0.85);
    }));

    own(bus.on('kart:land', ({ kartId, position, impact }) => {
      const i = clamp01(impact);
      if (i > 0.45) this.at(kartId, 'land_hard', position, 0.55 + 0.6 * i);
      else this.at(kartId, 'land_soft', position, 0.4 + 0.7 * i);
    }));

    own(bus.on('kart:driftStart', ({ kartId, direction }) => {
      this.at(kartId, 'drift_start', undefined, 0.8, 1 + direction * 0.02);
      if (this.isPlayer(kartId)) {
        this.driftTier = 0;
        if (!this.driftHandle) {
          this.driftHandle = this.playLoop('drift_loop', { volume: 0.0001 });
        }
      }
    }));

    own(bus.on('kart:driftTier', ({ kartId, tier, position }) => {
      const id = tier >= 3 ? 'drift_charge_purple' : tier === 2 ? 'drift_charge_orange' : 'drift_charge_blue';
      this.at(kartId, id, position, 0.9);
      if (this.isPlayer(kartId)) this.driftTier = tier;
    }));

    own(bus.on('kart:driftRelease', ({ kartId }) => {
      if (!this.isPlayer(kartId)) return;
      this.driftTier = 0;
      this.driftHandle?.stop(0.1);
      this.driftHandle = null;
    }));

    own(bus.on('kart:boost', ({ kartId, duration, source }) => {
      const id = source === 'pad' ? 'boost_pad' : 'boost_release';
      this.at(kartId, id, undefined, source === 'start' ? 1 : 0.92);
      if (kartId >= 0 && kartId < MAX_KARTS) {
        this.boostOn[kartId] = 1;
        this.boostUntil[kartId] = (this.actx?.currentTime ?? 0) + Math.max(0.2, duration);
        this.engines?.setBoost(kartId, true);
      }
    }));

    own(bus.on('kart:trick', ({ kartId }) => {
      this.at(kartId, 'trick', undefined, 0.9);
    }));

    own(bus.on('kart:spinout', ({ kartId, position }) => {
      this.at(kartId, 'spin_out', position, 1);
      if (this.isPlayer(kartId)) this.stopDriftAndScrape();
    }));

    own(bus.on('kart:squash', ({ kartId }) => {
      this.at(kartId, 'squash', undefined, 1);
    }));

    own(bus.on('kart:respawn', ({ kartId }) => {
      this.at(kartId, 'respawn', undefined, 0.9);
      if (this.isPlayer(kartId)) this.stopContinuous();
    }));

    own(bus.on('kart:wallHit', ({ kartId, position, impact }) => {
      const i = clamp01(impact);
      if (i > 0.32) {
        this.at(kartId, 'wall_hit_hard', position, 0.5 + 0.65 * i);
      } else if (this.isPlayer(kartId)) {
        // Glancing contact: a sustained scrape, refreshed by each event.
        this.scrapeStrength = Math.max(this.scrapeStrength, 0.35 + i * 2);
        this.scrapeTimer = 0.18;
        if (!this.scrapeHandle) this.scrapeHandle = this.playLoop('wall_scrape', { volume: 0.0001 });
      } else {
        this.at(kartId, 'wall_hit_hard', position, 0.28);
      }
    }));

    own(bus.on('kart:kartHit', ({ a, b, impact, position }) => {
      const near = this.isPlayer(a) || this.isPlayer(b);
      this.play('kart_bump', { position, volume: (near ? 0.95 : 0.6) * (0.5 + clamp01(impact)) });
    }));

    own(bus.on('kart:surfaceChange', ({ kartId, to }) => {
      if (!this.isPlayer(kartId)) return;
      const surface = to as SurfaceType;
      const props = SURFACES[surface];
      this.rollWanted = props ? props.sfx : 'roll_asphalt';
      this.offroadWanted = OFFROAD_SURFACES.has(surface);
      this.setSubmerged(surface === SurfaceType.Water ? 0.3 : 0);
    }));

    // --- items -------------------------------------------------------------
    own(bus.on('item:box', ({ position }) => {
      this.play('item_box', { position, volume: 0.9 });
    }));

    own(bus.on('item:granted', ({ kartId }) => {
      if (this.isPlayer(kartId)) this.play('item_get');
    }));

    own(bus.on('item:used', ({ kartId, item }) => {
      this.onItemUsed(kartId, item);
    }));

    own(bus.on('item:hit', ({ targetId, item, point }) => {
      this.onItemHit(targetId, item, point);
    }));

    // --- presentation ------------------------------------------------------
    own(bus.on('camera:shake', ({ amount }) => {
      // Big shakes are always paired with something loud; a touch of duck
      // makes the impact read as impact instead of just "louder".
      if (amount > 0.55) this.duck(clamp01(amount * 0.3), 0.4);
    }));

    own(bus.on('quality:change', ({ tier }) => {
      const low = tier === 'low';
      const medium = tier === 'medium';
      this.engines?.setMaxSimulated(low ? 2 : medium ? 4 : 6);
      this.reverb?.setWetScale(low ? 0.55 : 1);
      this.sfx?.setSendLevel(low ? 0.6 : 1);
    }));

    own(bus.on('engine:ready', () => {
      // Menu bed: quiet, no percussion until the race starts.
      this.startMusic();
      if (!this.intensityExternal) this.music?.setIntensity(0.18);
    }));
  }

  private onItemUsed(kartId: number, item: ItemType): void {
    const player = this.isPlayer(kartId);
    switch (item) {
      case ItemType.Boost:
      case ItemType.TripleBoost:
        this.at(kartId, 'boost_release', undefined, 0.9);
        break;
      case ItemType.GreenShell:
      case ItemType.TripleGreenShell:
        this.at(kartId, 'shell_fire', undefined, 0.9);
        break;
      case ItemType.RedShell:
      case ItemType.TripleRedShell:
        this.at(kartId, 'shell_fire', undefined, 0.9, 0.94);
        if (player) this.play('red_shell_lock', { volume: 0.7 });
        break;
      case ItemType.Banana:
      case ItemType.TripleBanana:
        this.at(kartId, 'banana_drop', undefined, 0.8);
        break;
      case ItemType.Bomb:
        this.at(kartId, 'bomb_throw', undefined, 0.9);
        break;
      case ItemType.Star:
        this.at(kartId, 'star_start', undefined, 1);
        if (player) this.startStar();
        break;
      case ItemType.Lightning:
        this.play('lightning_strike', { volume: 1 });
        break;
      case ItemType.Ghost:
        this.at(kartId, 'boo', undefined, 0.9);
        break;
      case ItemType.Bullet:
        this.at(kartId, 'bullet_start', undefined, 1);
        if (player) this.startBullet();
        break;
      case ItemType.BlueShell:
        this.at(kartId, 'blue_launch', undefined, 1);
        this.startAlarm();
        break;
      case ItemType.Coin:
        this.at(kartId, 'coin', undefined, 0.8);
        break;
      case ItemType.Squid:
        this.at(kartId, 'squid', undefined, 0.9);
        break;
      default:
        this.at(kartId, 'item_get', undefined, 0.7);
        break;
    }
  }

  private onItemHit(targetId: number, item: ItemType, point: THREE.Vector3): void {
    switch (item) {
      case ItemType.Bomb:
      case ItemType.BlueShell:
        this.play('explosion', { position: point });
        this.stopAlarm();
        break;
      case ItemType.Banana:
      case ItemType.TripleBanana:
        this.play('banana_slip', { position: point });
        break;
      case ItemType.Lightning:
        this.play('shrink', { position: point });
        break;
      case ItemType.Star:
        this.play('star_hit', { position: point });
        break;
      case ItemType.Squid:
        this.play('squid', { position: point, volume: 0.8 });
        break;
      case ItemType.Bullet:
        this.play('kart_bump', { position: point, volume: 1 });
        break;
      default:
        this.play('shell_hit', { position: point });
        break;
    }
    if (this.isPlayer(targetId)) {
      this.stopDriftAndScrape();
      this.duck(0.35, 0.6);
    }
  }

  // -------------------------------------------------------------------------
  // Loop control ids (start/stop pairs the item system fires as one-shots)
  // -------------------------------------------------------------------------

  private handleLoopControl(id: string): boolean {
    switch (id) {
      case 'star_end': this.stopStar(); return true;
      case 'bullet_end': this.stopBullet(); return true;
      case 'blue_shell_alarm': this.startAlarm(); return true;
      case 'blue_shell_alarm_end': this.stopAlarm(); return true;
      default: return false;
    }
  }

  private startStar(): void {
    if (this.starHandle) return;
    this.starHandle = this.playLoop('star_loop', { volume: 0.55 });
    this.duck(0.3, 0.5);
  }

  private stopStar(): void {
    this.starHandle?.stop(0.25);
    this.starHandle = null;
  }

  private startBullet(): void {
    if (this.bulletHandle) return;
    this.bulletHandle = this.playLoop('bullet_loop', { volume: 0.6 });
  }

  private stopBullet(): void {
    this.bulletHandle?.stop(0.25);
    this.bulletHandle = null;
  }

  private startAlarm(): void {
    if (this.alarmHandle) return;
    this.alarmHandle = this.playLoop('blue_shell_alarm', { volume: 0.42 });
  }

  private stopAlarm(): void {
    this.alarmHandle?.stop(0.3);
    this.alarmHandle = null;
  }

  private stopDriftAndScrape(): void {
    this.driftHandle?.stop(0.08);
    this.driftHandle = null;
    this.driftTier = 0;
    this.scrapeHandle?.stop(0.1);
    this.scrapeHandle = null;
    this.scrapeTimer = 0;
    this.scrapeStrength = 0;
  }

  /** Kill every sustained voice — race reset, respawn, results screen. */
  stopContinuous(): void {
    this.stopDriftAndScrape();
    this.stopStar();
    this.stopBullet();
    this.stopAlarm();
    this.rollHandle?.stop(0.15);
    this.rollHandle = null;
    this.offroadHandle?.stop(0.15);
    this.offroadHandle = null;
    this.offroadWanted = false;
    this.rollWanted = 'roll_asphalt';
    this.rollId = 'roll_asphalt';
  }

  // =========================================================================
  // Introspection (dev harness + QA)
  // =========================================================================

  get context(): AudioContext | null { return this.actx; }
  get analyser(): AnalyserNode | null { return this.analyserNode; }
  get bank(): SfxBank | null { return this.sfx; }
  get musicSystem(): Music | null { return this.music; }
  get engineSystem(): EngineSoundSystem | null { return this.engines; }
  get reverbBus(): ReverbBus | null { return this.reverb; }
  get windLayer(): WindLayer | null { return this.wind; }
  get isReady(): boolean { return this.initDone; }
  get isRunning(): boolean { return this.actx?.state === 'running'; }
  /** Which tyre-roll loop the player's surface currently selects. */
  get rollLoopId(): string { return this.rollId; }
  get rollLoopActive(): boolean { return this.rollHandle !== null; }
  /** Every id `play()` accepts, aliases included. */
  ids(): readonly string[] { return SFX_IDS; }

  debug(): AudioDebugInfo {
    return {
      state: this.actx?.state ?? 'none',
      sampleRate: this.actx?.sampleRate ?? 0,
      ready: this.initDone,
      voices: this.sfx?.voiceCount ?? 0,
      engineVoices: this.engines?.voiceCount ?? 0,
      engineHot: this.engines?.hotCount ?? 0,
      musicPlaying: this.music?.isPlaying ?? false,
      musicBpm: this.music?.bpm ?? 0,
      musicIntensity: this.music?.debug().intensity ?? 0,
      finalLap: this.music?.isFinalLap ?? false,
      environment: this.environment,
      duck: this.duckLevel,
      playerSpeed: this.playerSpeed,
      busGains: {
        music: this.musicBus?.gain.value ?? 0,
        sfx: this.sfxBus?.gain.value ?? 0,
        engine: this.engineBus?.gain.value ?? 0,
        ambient: this.ambientBus?.gain.value ?? 0,
      },
      masterGain: this.masterVol?.gain.value ?? 0,
      limiterReduction: this.limiter?.reduction ?? 0,
    };
  }

  // =========================================================================

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) {
      try { off(); } catch { /* noop */ }
    }
    this.offs.length = 0;

    this.stopContinuous();
    this.music?.dispose();
    this.engines?.dispose();
    this.sfx?.dispose();
    this.reverb?.dispose();
    this.wind?.dispose();
    this.submerge?.dispose();

    for (const n of [
      this.preSum, this.duckGain, this.masterVol, this.musicBus, this.sfxBus,
      this.engineBus, this.ambientBus, this.wetBus,
    ]) {
      if (n) { try { n.disconnect(); } catch { /* noop */ } }
    }
    for (const n of [this.glue, this.limiter]) {
      if (n) { try { n.disconnect(); } catch { /* noop */ } }
    }
    if (this.analyserNode) { try { this.analyserNode.disconnect(); } catch { /* noop */ } }

    const ctx = this.actx;
    this.actx = null;
    if (ctx) void ctx.close().catch(() => { /* noop */ });
  }
}

// Documented-but-unused imports kept so the palette is discoverable in-file.
void _vel; void clamp;
