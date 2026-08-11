/**
 * ============================================================================
 *  FOXY KART — ENGINE SYNTHESIS
 * ============================================================================
 *  A believable engine is not a looped sample pitched up and down. It is a set
 *  of layers that change their *relative* balance with rpm and throttle load:
 *
 *   1. BASE TONE      wavetable oscillator at the crank fundamental. Its
 *                     harmonic series is weighted so the dominant partial sits
 *                     on the firing order (h = pulses per revolution), which is
 *                     what gives an engine its identity — a flat-plane V8 and a
 *                     parallel twin differ mostly in *which harmonic wins*.
 *   2. INTAKE WHINE   a high, narrow-band partial that swells under load. This
 *                     is the layer your ear reads as "effort".
 *   3. EXHAUST RASP   filtered noise amplitude-modulated by a PULSE TRAIN at
 *                     the firing frequency. **This is the whole trick.** AM of
 *                     broadband noise by a narrow pulse train produces
 *                     sidebands at every multiple of the firing rate; the ear
 *                     fuses them into "individual combustion events". Without
 *                     it you have a synth pad. With it you have an engine.
 *   4. MECHANICAL WHIR gear/valve train hiss, always present, barely noticed
 *                     until you remove it and the engine sounds hollow.
 *   5. OVERRUN CRACKLE sparse velvet-noise pops when the throttle closes at
 *                     high rpm. Costs almost nothing, adds enormous realism.
 *   6. TURBO          a spooling whistle plus a pressure-release "psst" at the
 *                     end of boost, both baked once at init.
 *
 *  rpm is slew-limited and dithered with a slow pseudo-random flutter so it is
 *  never mathematically steady — a perfectly constant engine reads as fake
 *  instantly.
 *
 *  PERFORMANCE: only the ~5 nearest karts (plus the player, always) get a full
 *  graph. Cold voices are *disconnected* from the destination, not merely
 *  silenced — Web Audio builds its render list backwards from the destination,
 *  so a disconnected subgraph genuinely costs nothing. Everyone else feeds a
 *  single shared "field rumble" bed.
 * ============================================================================
 */

import type * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '@/core/MathUtils';
import {
  Harmonics, cachedWave, harmonicWave, makeShaper, noiseBuffer, noiseBurst,
  normalizeBuffer, perc, renderOffline, sweep, tone,
} from './Synth';

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export type EngineCharacterId = 'bike' | 'light' | 'standard' | 'heavy' | 'cruiser' | 'turbo';

interface EngineCharacter {
  /** Crank fundamental at rpm = 0, Hz. */
  idleHz: number;
  /** Crank fundamental at rpm = 1, Hz. */
  maxHz: number;
  /** Combustion pulses per crank revolution. Sets the dominant harmonic. */
  firingOrder: number;
  /** Wavetable brightness. */
  brightness: number;
  /** Wavetable grit. */
  rasp: number;
  /** Intake whine partial, as a multiple of the crank fundamental. */
  whineRatio: number;
  whineGain: number;
  subGain: number;
  raspGain: number;
  whirGain: number;
  /** Extra turbo whistle presence. */
  turboGain: number;
  /** Master trim so characters are perceptually level-matched. */
  trim: number;
}

export const ENGINE_CHARACTERS: Record<EngineCharacterId, EngineCharacter> = {
  // Small, revvy, buzzy. Sits high in the mix, almost no sub.
  bike: {
    idleHz: 74, maxHz: 330, firingOrder: 2, brightness: 1.55, rasp: 0.50,
    whineRatio: 6.5, whineGain: 0.36, subGain: 0.10, raspGain: 0.30, whirGain: 0.14,
    turboGain: 0.9, trim: 0.86,
  },
  light: {
    idleHz: 60, maxHz: 268, firingOrder: 2, brightness: 1.25, rasp: 0.42,
    whineRatio: 5.5, whineGain: 0.30, subGain: 0.18, raspGain: 0.34, whirGain: 0.12,
    turboGain: 0.7, trim: 0.92,
  },
  standard: {
    idleHz: 50, maxHz: 222, firingOrder: 2, brightness: 1.00, rasp: 0.38,
    whineRatio: 4.5, whineGain: 0.24, subGain: 0.26, raspGain: 0.38, whirGain: 0.10,
    turboGain: 0.55, trim: 1.0,
  },
  heavy: {
    idleHz: 40, maxHz: 176, firingOrder: 3, brightness: 0.85, rasp: 0.46,
    whineRatio: 3.5, whineGain: 0.18, subGain: 0.36, raspGain: 0.44, whirGain: 0.09,
    turboGain: 0.45, trim: 1.05,
  },
  // Big lazy V8 burble: low fundamental, high firing order, lots of sub.
  cruiser: {
    idleHz: 33, maxHz: 142, firingOrder: 4, brightness: 0.70, rasp: 0.56,
    whineRatio: 2.5, whineGain: 0.13, subGain: 0.46, raspGain: 0.50, whirGain: 0.08,
    turboGain: 0.35, trim: 1.08,
  },
  // Forced induction: aggressive whine, prominent turbo.
  turbo: {
    idleHz: 55, maxHz: 250, firingOrder: 2, brightness: 1.35, rasp: 0.60,
    whineRatio: 7.5, whineGain: 0.40, subGain: 0.22, raspGain: 0.42, whirGain: 0.12,
    turboGain: 1.25, trim: 0.94,
  },
};

const CHARACTER_ORDER: readonly EngineCharacterId[] = ['standard', 'light', 'heavy', 'bike', 'cruiser', 'turbo'];

/** Deterministic character for an AI kart so the field sounds varied. */
export function characterForKart(kartId: number): EngineCharacterId {
  const h = Math.abs(Math.imul(kartId + 1, 0x9e3779b1)) >>> 8;
  return CHARACTER_ORDER[h % CHARACTER_ORDER.length];
}

const SPEED_OF_SOUND = 341;
/** Doppler is clamped hard — physical accuracy sounds broken in an arcade game. */
const MAX_DOPPLER_CENTS = 260;
/**
 * Shortest interval we will differentiate position over, seconds.
 *
 * The AudioContext clock ticks one render quantum at a time (~2.7 ms at
 * 48 kHz), so anything shorter than this is not a measurement, it is noise.
 */
const MIN_PUSH_DT = 0.004;
/** Nothing in this game moves faster than this, so nothing may claim to. */
const MAX_KART_SPEED = 90;

// ---------------------------------------------------------------------------
// One kart's engine
// ---------------------------------------------------------------------------

interface SharedAssets {
  raspNoise: AudioBuffer;
  whirNoise: AudioBuffer;
  crackleNoise: AudioBuffer;
  turboSpool: AudioBuffer | null;
  turboRelease: AudioBuffer | null;
}

class EngineVoice {
  readonly kartId: number;
  readonly isPlayer: boolean;
  character: EngineCharacterId;

  // --- audio graph ---------------------------------------------------------
  private ctx: BaseAudioContext;
  private dest: AudioNode;
  private send: AudioNode | null;
  private shared: SharedAssets;

  private out: GainNode;            // per-voice master
  private tail: AudioNode;          // last node before dest (panner for AI)
  private panner: PannerNode | null = null;
  private sendGain: GainNode | null = null;
  private connected = false;

  private base: OscillatorNode;
  private baseLp: BiquadFilterNode;
  private basePeak: BiquadFilterNode;
  private baseGain: GainNode;

  private sub: OscillatorNode;
  private subGain: GainNode;

  private whine: OscillatorNode;
  private whineBp: BiquadFilterNode;
  private whineGain: GainNode;

  private raspSrc: AudioBufferSourceNode;
  private raspBp: BiquadFilterNode;
  private raspAm: GainNode;         // gated by the firing pulse train
  private raspGain: GainNode;

  private whirSrc: AudioBufferSourceNode;
  private whirHp: BiquadFilterNode;
  private whirGain: GainNode;

  private crackleSrc: AudioBufferSourceNode;
  private crackleBp: BiquadFilterNode;
  private crackleGain: GainNode;

  private pulse: OscillatorNode;    // the firing pulse train
  private pulseDepth: GainNode;
  private pulseTilt: GainNode;      // small firing modulation on the base tone

  private turbo: OscillatorNode;
  private turboBp: BiquadFilterNode;
  private turboGain: GainNode;

  // --- state ---------------------------------------------------------------
  rpmTarget = 0;
  loadTarget = 0;
  private rpm = 0;
  private load = 0;
  private flutterPhaseA: number;
  private flutterPhaseB: number;
  boost = 0;
  private boostTarget = 0;
  hot = true;
  private hotGain = 1;
  private disconnectTimer = 0;
  private lastPos = { x: 0, y: 0, z: 0 };
  private vel = { x: 0, y: 0, z: 0 };
  private posValid = false;
  private posAge = 0;
  distance = 0;
  private dopplerCents = 0;

  // Cached last-written values so we skip redundant param writes.
  private lastBaseHz = -1;

  constructor(
    ctx: BaseAudioContext,
    kartId: number,
    isPlayer: boolean,
    character: EngineCharacterId,
    dest: AudioNode,
    send: AudioNode | null,
    shared: SharedAssets,
  ) {
    this.ctx = ctx;
    this.kartId = kartId;
    this.isPlayer = isPlayer;
    this.character = character;
    this.dest = dest;
    this.send = send;
    this.shared = shared;
    this.flutterPhaseA = (kartId * 1.7159) % (Math.PI * 2);
    this.flutterPhaseB = (kartId * 4.2831 + 1.1) % (Math.PI * 2);

    const c = ENGINE_CHARACTERS[character];

    this.out = ctx.createGain();
    this.out.gain.value = 0.0001;

    // ---- base tone --------------------------------------------------------
    this.base = ctx.createOscillator();
    this.base.setPeriodicWave(EngineVoice.engineWave(ctx, character));
    this.base.frequency.value = c.idleHz;

    this.basePeak = ctx.createBiquadFilter();
    this.basePeak.type = 'peaking';
    this.basePeak.frequency.value = c.idleHz * c.firingOrder;
    this.basePeak.Q.value = 1.1;
    this.basePeak.gain.value = 0;

    this.baseLp = ctx.createBiquadFilter();
    this.baseLp.type = 'lowpass';
    this.baseLp.frequency.value = 900;
    this.baseLp.Q.value = 0.9;

    this.baseGain = ctx.createGain();
    this.baseGain.gain.value = 0.5;

    this.base.connect(this.basePeak);
    this.basePeak.connect(this.baseLp);
    this.baseLp.connect(this.baseGain);
    this.baseGain.connect(this.out);

    // ---- sub / body -------------------------------------------------------
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = c.idleHz;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = c.subGain * 0.4;
    this.sub.connect(this.subGain);
    this.subGain.connect(this.out);

    // ---- intake whine -----------------------------------------------------
    this.whine = ctx.createOscillator();
    this.whine.setPeriodicWave(cachedWave(ctx, 'whine', () => harmonicWave(ctx, [1, 0.42, 0.22, 0.1, 0.05])));
    this.whine.frequency.value = c.idleHz * c.whineRatio;
    this.whineBp = ctx.createBiquadFilter();
    this.whineBp.type = 'bandpass';
    this.whineBp.frequency.value = c.idleHz * c.whineRatio;
    this.whineBp.Q.value = 3.2;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineBp);
    this.whineBp.connect(this.whineGain);
    this.whineGain.connect(this.out);

    // ---- exhaust rasp (pulse-gated noise) ---------------------------------
    this.raspSrc = ctx.createBufferSource();
    this.raspSrc.buffer = shared.raspNoise;
    this.raspSrc.loop = true;
    this.raspBp = ctx.createBiquadFilter();
    this.raspBp.type = 'bandpass';
    this.raspBp.frequency.value = 320;
    this.raspBp.Q.value = 0.8;
    const raspShaper = makeShaper(ctx, 'tube', 0.35);
    this.raspAm = ctx.createGain();
    this.raspAm.gain.value = 0.42; // DC offset; the pulse train swings around it
    this.raspGain = ctx.createGain();
    this.raspGain.gain.value = c.raspGain * 0.5;
    this.raspSrc.connect(this.raspBp);
    this.raspBp.connect(raspShaper);
    raspShaper.connect(this.raspAm);
    this.raspAm.connect(this.raspGain);
    this.raspGain.connect(this.out);

    // ---- the firing pulse train ------------------------------------------
    this.pulse = ctx.createOscillator();
    this.pulse.setPeriodicWave(cachedWave(ctx, 'firingPulse', () =>
      harmonicWave(ctx, Harmonics.pulse(14, 0.18))));
    this.pulse.frequency.value = c.idleHz * c.firingOrder;
    this.pulseDepth = ctx.createGain();
    this.pulseDepth.gain.value = 0.5;
    this.pulse.connect(this.pulseDepth);
    this.pulseDepth.connect(this.raspAm.gain);
    // A touch of the same pulse on the tone keeps the layers phase-coherent,
    // which is what makes them read as one engine instead of two sounds.
    this.pulseTilt = ctx.createGain();
    this.pulseTilt.gain.value = 0.1;
    this.pulse.connect(this.pulseTilt);
    this.pulseTilt.connect(this.baseGain.gain);

    // ---- mechanical whir --------------------------------------------------
    this.whirSrc = ctx.createBufferSource();
    this.whirSrc.buffer = shared.whirNoise;
    this.whirSrc.loop = true;
    this.whirHp = ctx.createBiquadFilter();
    this.whirHp.type = 'bandpass';
    this.whirHp.frequency.value = 2600;
    this.whirHp.Q.value = 0.7;
    this.whirGain = ctx.createGain();
    this.whirGain.gain.value = c.whirGain * 0.4;
    this.whirSrc.connect(this.whirHp);
    this.whirHp.connect(this.whirGain);
    this.whirGain.connect(this.out);

    // ---- overrun crackle --------------------------------------------------
    this.crackleSrc = ctx.createBufferSource();
    this.crackleSrc.buffer = shared.crackleNoise;
    this.crackleSrc.loop = true;
    this.crackleBp = ctx.createBiquadFilter();
    this.crackleBp.type = 'bandpass';
    this.crackleBp.frequency.value = 1500;
    this.crackleBp.Q.value = 1.6;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    const crackleShaper = makeShaper(ctx, 'hard', 0.55);
    this.crackleSrc.connect(this.crackleBp);
    this.crackleBp.connect(crackleShaper);
    crackleShaper.connect(this.crackleGain);
    this.crackleGain.connect(this.out);

    // ---- turbo whistle ----------------------------------------------------
    this.turbo = ctx.createOscillator();
    this.turbo.type = 'triangle';
    this.turbo.frequency.value = 1800;
    this.turboBp = ctx.createBiquadFilter();
    this.turboBp.type = 'bandpass';
    this.turboBp.frequency.value = 1800;
    this.turboBp.Q.value = 6;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboBp);
    this.turboBp.connect(this.turboGain);
    this.turboGain.connect(this.out);

    // ---- output routing ---------------------------------------------------
    if (isPlayer) {
      // The player's engine is "in the car": dry, centred, a little fuller.
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'lowshelf';
      shelf.frequency.value = 160;
      shelf.gain.value = 3.5;
      this.out.connect(shelf);
      this.tail = shelf;
    } else {
      this.panner = ctx.createPanner();
      this.panner.panningModel = 'equalpower';
      this.panner.distanceModel = 'inverse';
      this.panner.refDistance = 7;
      this.panner.maxDistance = 300;
      this.panner.rolloffFactor = 1.35;
      this.panner.coneInnerAngle = 360;
      this.out.connect(this.panner);
      this.tail = this.panner;
    }

    const t = ctx.currentTime;
    this.base.start(t);
    this.sub.start(t);
    this.whine.start(t);
    this.pulse.start(t);
    this.turbo.start(t);
    this.raspSrc.start(t, (kartId * 0.37) % shared.raspNoise.duration);
    this.whirSrc.start(t, (kartId * 0.51) % shared.whirNoise.duration);
    this.crackleSrc.start(t, (kartId * 0.23) % shared.crackleNoise.duration);

    this.connect();
  }

  private static engineWave(ctx: BaseAudioContext, character: EngineCharacterId): PeriodicWave {
    const c = ENGINE_CHARACTERS[character];
    return cachedWave(ctx, `engine:${character}`, () =>
      harmonicWave(
        ctx,
        Harmonics.engine(c.firingOrder, 40, c.brightness, c.rasp),
        Harmonics.scatterPhases(40, 900 + c.firingOrder * 13),
      ));
  }

  private connect(): void {
    if (this.connected) return;
    this.tail.connect(this.dest);
    if (this.send) {
      if (!this.sendGain) {
        this.sendGain = this.ctx.createGain();
        this.sendGain.gain.value = this.isPlayer ? 0.16 : 0.34;
        this.sendGain.connect(this.send);
      }
      this.tail.connect(this.sendGain);
    }
    this.connected = true;
  }

  private disconnect(): void {
    if (!this.connected) return;
    try { this.tail.disconnect(this.dest); } catch { /* noop */ }
    if (this.sendGain) { try { this.tail.disconnect(this.sendGain); } catch { /* noop */ } }
    this.connected = false;
  }

  /** Feed a new sample of gameplay state. Called once per frame per kart. */
  push(rpm: number, load: number, position: THREE.Vector3, dt: number): void {
    this.rpmTarget = clamp01(rpm);
    this.loadTarget = clamp01(load);
    // Differentiate position for Doppler.
    //
    // `dt` comes from the AudioContext clock, which only advances one render
    // quantum at a time (~2.7 ms at 48 kHz). A caller stepping faster than that
    // — a 120 Hz fixed update, or a test loop running free — hands us two
    // samples from the same quantum, and dividing a centimetre by 20 µs reads
    // as 500 m/s. So: only differentiate over a real interval, and clamp the
    // result to something a kart can physically do. Both guards matter; the
    // smoothing below is not enough on its own because hundreds of spiked
    // samples still integrate toward the bogus value.
    if (this.posValid && dt >= MIN_PUSH_DT) {
      const inv = 1 / dt;
      const vx = clamp((position.x - this.lastPos.x) * inv, -MAX_KART_SPEED, MAX_KART_SPEED);
      const vy = clamp((position.y - this.lastPos.y) * inv, -MAX_KART_SPEED, MAX_KART_SPEED);
      const vz = clamp((position.z - this.lastPos.z) * inv, -MAX_KART_SPEED, MAX_KART_SPEED);
      const k = 1 - Math.exp(-dt / 0.07);
      this.vel.x += (vx - this.vel.x) * k;
      this.vel.y += (vy - this.vel.y) * k;
      this.vel.z += (vz - this.vel.z) * k;
    }
    // Only advance the reference sample when we actually used it, otherwise a
    // fast caller keeps resetting the baseline and velocity never resolves.
    if (!this.posValid || dt >= MIN_PUSH_DT) {
      this.lastPos.x = position.x;
      this.lastPos.y = position.y;
      this.lastPos.z = position.z;
    }
    this.posValid = true;
    this.posAge = 0;
    if (this.panner) {
      this.panner.positionX.value = position.x;
      this.panner.positionY.value = position.y;
      this.panner.positionZ.value = position.z;
    }
  }

  setBoost(on: boolean): void {
    const wasOn = this.boostTarget > 0.5;
    this.boostTarget = on ? 1 : 0;
    if (on && !wasOn) this.oneShot(this.shared.turboSpool, 0.85);
    if (!on && wasOn) this.oneShot(this.shared.turboRelease, 0.7);
  }

  /** Fire a baked transient through this voice's spatial chain. */
  private oneShot(buf: AudioBuffer | null, gain: number): void {
    if (!buf || !this.hot) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.detune.value = (this.character === 'bike' ? 260 : this.character === 'cruiser' ? -220 : 0)
      + (Math.random() - 0.5) * 160;
    const g = ctx.createGain();
    g.gain.value = gain * ENGINE_CHARACTERS[this.character].turboGain;
    src.connect(g);
    g.connect(this.out);
    const t = ctx.currentTime;
    src.start(t);
    src.stop(t + buf.duration + 0.05);
    src.onended = () => {
      src.onended = null;
      try { src.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
  }

  setHot(hot: boolean): void {
    if (hot === this.hot) return;
    this.hot = hot;
    if (hot) { this.connect(); this.disconnectTimer = 0; }
    else this.disconnectTimer = 0.28;
  }

  /**
   * Advance the voice. All params are written by direct `.value` assignment:
   * one k-rate step per frame with a slew-limited input is inaudible and costs
   * a fraction of what scheduling 12 automation events per voice would.
   */
  tick(
    dt: number,
    elapsed: number,
    listenerPos: { x: number; y: number; z: number },
    listenerVel: { x: number; y: number; z: number },
    masterGain: number,
  ): void {
    const c = ENGINE_CHARACTERS[this.character];

    // Stale positions (a kart that stopped reporting) decay to silence.
    this.posAge += dt;

    // ---- slew + flutter ---------------------------------------------------
    // Rising rpm is faster than falling: an engine picks up quicker than it
    // decays, and the asymmetry is a huge part of "responsive".
    const rising = this.rpmTarget > this.rpm;
    this.rpm = damp(this.rpm, this.rpmTarget, rising ? 0.045 : 0.075, dt);
    this.load = damp(this.load, this.loadTarget, 0.06, dt);
    this.boost = damp(this.boost, this.boostTarget, 0.05, dt);

    this.flutterPhaseA += dt * 7.31;
    this.flutterPhaseB += dt * 3.17;
    const flutter =
      Math.sin(this.flutterPhaseA) * 0.0055 +
      Math.sin(this.flutterPhaseB * 1.618) * 0.0035 +
      Math.sin(this.flutterPhaseA * 0.37 + this.flutterPhaseB) * 0.0025;
    // Idle wanders more than a screaming engine — inverse-scale the flutter.
    const rpmJ = clamp01(this.rpm + flutter * lerp(2.2, 0.7, this.rpm));

    // ---- frequencies ------------------------------------------------------
    const baseHz = c.idleHz * Math.pow(c.maxHz / c.idleHz, rpmJ);
    const fireHz = baseHz * c.firingOrder;

    // ---- Doppler ----------------------------------------------------------
    let cents = 0;
    if (!this.isPlayer) {
      const dx = this.lastPos.x - listenerPos.x;
      const dy = this.lastPos.y - listenerPos.y;
      const dz = this.lastPos.z - listenerPos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.distance = d;
      if (d > 0.4) {
        const ux = dx / d, uy = dy / d, uz = dz / d;
        // Positive = source receding along the listener->source axis.
        const vs = this.vel.x * ux + this.vel.y * uy + this.vel.z * uz;
        // Positive = listener closing on the source.
        const vl = listenerVel.x * ux + listenerVel.y * uy + listenerVel.z * uz;
        const ratio = clamp(
          (SPEED_OF_SOUND + vl) / (SPEED_OF_SOUND + vs),
          0.82, 1.22,
        );
        cents = clamp(1200 * Math.log2(ratio), -MAX_DOPPLER_CENTS, MAX_DOPPLER_CENTS);
      }
    } else {
      this.distance = 0;
    }
    this.dopplerCents = damp(this.dopplerCents, cents, 0.04, dt);
    const dopplerRatio = Math.pow(2, this.dopplerCents / 1200);

    if (Math.abs(baseHz - this.lastBaseHz) > 0.02 || Math.abs(cents) > 0.5) {
      this.base.frequency.value = baseHz;
      this.base.detune.value = this.dopplerCents;
      this.sub.frequency.value = baseHz;
      this.sub.detune.value = this.dopplerCents;
      this.pulse.frequency.value = fireHz;
      this.pulse.detune.value = this.dopplerCents;
      this.lastBaseHz = baseHz;
    }

    // Noise layers get their Doppler from playbackRate — there is no pitch to
    // detune, but shifting the sample rate shifts the whole noise band.
    const nr = clamp(dopplerRatio, 0.82, 1.22);
    this.raspSrc.playbackRate.value = nr;
    this.whirSrc.playbackRate.value = nr;

    // ---- load-dependent timbre -------------------------------------------
    const load = this.load;
    const boost = this.boost;
    const onThrottle = load;
    const offThrottle = 1 - load;

    // Base: brighter and more firing-emphasised on throttle.
    this.baseLp.frequency.value = lerp(
      lerp(520, 2600, this.rpm),
      lerp(1400, 7200, this.rpm),
      onThrottle,
    ) * (1 + boost * 0.35);
    this.basePeak.frequency.value = fireHz * dopplerRatio;
    this.basePeak.gain.value = lerp(1.5, 8.5, onThrottle) + boost * 2.5;
    this.baseGain.gain.value = lerp(0.30, 0.52, this.rpm) * lerp(0.85, 1.0, onThrottle);

    // Sub: fattest at low rpm under load (lugging), thins out at the top.
    this.subGain.gain.value = c.subGain * lerp(0.9, 0.35, this.rpm) * lerp(0.5, 1.0, onThrottle);

    // Intake whine: the "effort" layer. Scales hard with load AND rpm.
    const whineHz = baseHz * c.whineRatio * dopplerRatio;
    this.whine.frequency.value = baseHz * c.whineRatio;
    this.whine.detune.value = this.dopplerCents;
    this.whineBp.frequency.value = clamp(whineHz, 60, 14000);
    this.whineBp.Q.value = lerp(2.2, 5.5, this.rpm);
    this.whineGain.gain.value = c.whineGain * Math.pow(this.rpm, 1.35)
      * lerp(0.22, 1.0, onThrottle) * (1 + boost * 0.6);

    // Exhaust rasp: band centre tracks rpm; depth of the firing gate is deepest
    // on throttle (each combustion event punches through).
    this.raspBp.frequency.value = clamp(lerp(180, 1250, this.rpm) * (1 + onThrottle * 0.5) * dopplerRatio, 60, 9000);
    this.raspBp.Q.value = lerp(0.6, 1.1, onThrottle);
    const depth = lerp(0.30, 0.62, onThrottle) * lerp(1.0, 0.72, this.rpm);
    this.raspAm.gain.value = 0.42 + depth * 0.18;
    this.pulseDepth.gain.value = depth;
    this.pulseTilt.gain.value = lerp(0.05, 0.16, onThrottle) * lerp(1.0, 0.5, this.rpm);
    this.raspGain.gain.value = c.raspGain * lerp(0.45, 1.0, this.rpm)
      * lerp(0.5, 1.0, onThrottle) * (1 + boost * 0.45);

    // Mechanical whir: mostly rpm, indifferent to throttle.
    this.whirHp.frequency.value = lerp(1800, 5200, this.rpm);
    this.whirGain.gain.value = c.whirGain * lerp(0.5, 1.0, this.rpm);

    // Overrun crackle: closed throttle at speed. Pure decoration, huge payoff.
    const overrun = clamp01((this.rpm - 0.32) / 0.5) * Math.pow(offThrottle, 1.6);
    this.crackleGain.gain.value = overrun * 0.30;
    this.crackleBp.frequency.value = lerp(900, 2600, this.rpm);

    // Turbo: whistle rises with rpm and boost.
    const turboHz = clamp(lerp(1300, 5600, this.rpm) * (0.75 + boost * 0.45), 200, 14000);
    this.turbo.frequency.value = turboHz;
    this.turboBp.frequency.value = turboHz;
    this.turboGain.gain.value = c.turboGain * 0.055 * boost * Math.pow(this.rpm, 0.8);

    // ---- master gain ------------------------------------------------------
    if (!this.hot && this.disconnectTimer > 0) {
      this.disconnectTimer -= dt;
      if (this.disconnectTimer <= 0) this.disconnect();
    }
    this.hotGain = damp(this.hotGain, this.hot ? 1 : 0, 0.06, dt);
    const stale = this.posAge > 0.6 ? clamp01(1 - (this.posAge - 0.6) / 0.5) : 1;
    const level = masterGain * c.trim * this.hotGain * stale
      * (this.isPlayer ? 0.72 : 0.5);
    this.out.gain.value = Math.max(0.00005, level);

    void elapsed;
  }

  /** Squared distance to a point. The player is pinned to the front (-1). */
  distanceSquaredTo(l: { x: number; y: number; z: number }): number {
    if (this.isPlayer) return -1;
    const dx = this.lastPos.x - l.x;
    const dy = this.lastPos.y - l.y;
    const dz = this.lastPos.z - l.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Everything the verification harness wants to know. */
  debug(): {
    kartId: number; character: EngineCharacterId; rpm: number; load: number;
    baseHz: number; fireHz: number; boost: number; doppler: number;
    distance: number; hot: boolean; connected: boolean;
  } {
    const c = ENGINE_CHARACTERS[this.character];
    const baseHz = c.idleHz * Math.pow(c.maxHz / c.idleHz, this.rpm);
    return {
      kartId: this.kartId,
      character: this.character,
      rpm: this.rpm,
      load: this.load,
      baseHz,
      fireHz: baseHz * c.firingOrder,
      boost: this.boost,
      doppler: this.dopplerCents,
      distance: this.distance,
      hot: this.hot,
      connected: this.connected,
    };
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    for (const o of [this.base, this.sub, this.whine, this.pulse, this.turbo]) {
      try { o.stop(t); } catch { /* noop */ }
      try { o.disconnect(); } catch { /* noop */ }
    }
    for (const s of [this.raspSrc, this.whirSrc, this.crackleSrc]) {
      try { s.stop(t); } catch { /* noop */ }
      try { s.disconnect(); } catch { /* noop */ }
    }
    this.disconnect();
    for (const n of [
      this.out, this.baseGain, this.baseLp, this.basePeak, this.subGain,
      this.whineBp, this.whineGain, this.raspBp, this.raspAm, this.raspGain,
      this.whirHp, this.whirGain, this.crackleBp, this.crackleGain,
      this.pulseDepth, this.pulseTilt, this.turboBp, this.turboGain,
    ]) {
      try { n.disconnect(); } catch { /* noop */ }
    }
    if (this.sendGain) { try { this.sendGain.disconnect(); } catch { /* noop */ } }
  }
}

// ---------------------------------------------------------------------------
// Field rumble — the cheap bed for karts we aren't fully simulating
// ---------------------------------------------------------------------------

class FieldRumble {
  private ctx: BaseAudioContext;
  private src: AudioBufferSourceNode;
  private lp: BiquadFilterNode;
  private gain: GainNode;
  private drone: OscillatorNode;
  private droneLp: BiquadFilterNode;
  private droneGain: GainNode;
  private pulse: OscillatorNode;
  private pulseDepth: GainNode;
  private am: GainNode;
  private level = 0;

  constructor(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer) {
    this.ctx = ctx;
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 260;
    this.lp.Q.value = 1.2;
    this.am = ctx.createGain();
    this.am.gain.value = 0.7;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.src.connect(this.lp);
    this.lp.connect(this.am);
    this.am.connect(this.gain);
    this.gain.connect(dest);

    this.drone = ctx.createOscillator();
    this.drone.setPeriodicWave(cachedWave(ctx, 'fieldDrone', () =>
      harmonicWave(ctx, Harmonics.engine(2, 20, 0.7, 0.5))));
    this.drone.frequency.value = 60;
    this.droneLp = ctx.createBiquadFilter();
    this.droneLp.type = 'lowpass';
    this.droneLp.frequency.value = 700;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0001;
    this.drone.connect(this.droneLp);
    this.droneLp.connect(this.droneGain);
    this.droneGain.connect(this.gain);

    // Collective firing modulation — even the bed gets combustion texture.
    this.pulse = ctx.createOscillator();
    this.pulse.setPeriodicWave(cachedWave(ctx, 'firingPulse', () =>
      harmonicWave(ctx, Harmonics.pulse(14, 0.18))));
    this.pulse.frequency.value = 120;
    this.pulseDepth = ctx.createGain();
    this.pulseDepth.gain.value = 0.25;
    this.pulse.connect(this.pulseDepth);
    this.pulseDepth.connect(this.am.gain);

    const t = ctx.currentTime;
    this.src.start(t);
    this.drone.start(t);
    this.pulse.start(t);
  }

  /** `count` karts averaging `meanRpm`, nearest of them `nearest` metres away. */
  update(dt: number, count: number, meanRpm: number, nearest: number, masterGain: number): void {
    const density = clamp01(count / 7);
    const proximity = clamp01(1 - (nearest - 25) / 160);
    const target = density * proximity * 0.5;
    this.level = damp(this.level, target, 0.18, dt);
    this.gain.gain.value = Math.max(0.00005, this.level * masterGain);
    this.lp.frequency.value = lerp(140, 480, meanRpm);
    const droneHz = lerp(46, 165, meanRpm);
    this.drone.frequency.value = droneHz;
    this.droneLp.frequency.value = lerp(300, 1400, meanRpm);
    this.droneGain.gain.value = 0.55;
    this.pulse.frequency.value = droneHz * 2;
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    for (const n of [this.src, this.drone, this.pulse]) {
      try { n.stop(t); } catch { /* noop */ }
      try { n.disconnect(); } catch { /* noop */ }
    }
    for (const n of [this.lp, this.am, this.gain, this.droneLp, this.droneGain, this.pulseDepth]) {
      try { n.disconnect(); } catch { /* noop */ }
    }
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export interface EngineSystemOptions {
  dest: AudioNode;
  reverbSend?: AudioNode;
  /** How many karts get a full graph (the player is always one of them). */
  maxSimulated?: number;
}

export class EngineSoundSystem {
  private ctx: BaseAudioContext;
  private dest: AudioNode;
  private send: AudioNode | null;
  private maxSim: number;

  private voices = new Map<number, EngineVoice>();
  private order: EngineVoice[] = [];
  private shared: SharedAssets;
  private rumble: FieldRumble | null = null;

  private playerId = -1;
  private masterGain = 1;
  private elapsed = 0;
  private lastPushTime = new Map<number, number>();

  constructor(ctx: BaseAudioContext, o: EngineSystemOptions) {
    this.ctx = ctx;
    this.dest = o.dest;
    this.send = o.reverbSend ?? null;
    this.maxSim = o.maxSimulated ?? 5;
    this.shared = {
      // Reused by every voice — one AudioBuffer, many BufferSources.
      raspNoise: noiseBuffer(ctx, 'pink', 3.0, 1, 701),
      whirNoise: noiseBuffer(ctx, 'white', 2.5, 1, 702),
      crackleNoise: noiseBuffer(ctx, 'velvet', 2.0, 1, 703),
      turboSpool: null,
      turboRelease: null,
    };
  }

  /** Bake the turbo transients and bring up the field bed. */
  async init(): Promise<void> {
    const sr = this.ctx.sampleRate;
    try {
      const spool = await renderOffline(sr, 1, 0.85, (ctx, out) => {
        // Rising whistle + a broadband whoosh underneath.
        const g = tone(ctx, out, 0, 0.7, {
          type: 'triangle', freq: 900, freqEnd: 4200, gain: 0.5, attack: 0.09, decay: 0.6,
        });
        void g;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 1.1;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer(ctx, 'white', 1.0, 1, 711);
        const ng = ctx.createGain(); ng.gain.value = 0;
        perc(ng.gain, 0, 0.5, 0.06, 0.66);
        sweep(bp.frequency, 0, 900, 5200, 0.6);
        src.connect(bp); bp.connect(ng); ng.connect(out);
        src.start(0); src.stop(0.85);
        // shimmer on top
        noiseBurst(ctx, out, 0.02, 0.55, { type: 'white', filter: 'highpass', freq: 6500, gain: 0.16, decay: 0.5 });
      });
      normalizeBuffer(spool, 0.85);
      this.shared.turboSpool = spool;

      const release = await renderOffline(sr, 1, 0.5, (ctx, out) => {
        // The pressure-release "psst": bright noise, fast decay, tiny down-chirp.
        noiseBurst(ctx, out, 0, 0.26, {
          type: 'white', filter: 'bandpass', freq: 5200, freqEnd: 1600, q: 0.8,
          gain: 0.9, attack: 0.002, decay: 0.24,
        });
        noiseBurst(ctx, out, 0, 0.12, { type: 'white', filter: 'highpass', freq: 8000, gain: 0.4, decay: 0.1 });
        tone(ctx, out, 0, 0.16, { type: 'sine', freq: 420, freqEnd: 150, gain: 0.16, attack: 0.002, decay: 0.14 });
      });
      normalizeBuffer(release, 0.8);
      this.shared.turboRelease = release;
    } catch (err) {
      console.error('[EngineSound] turbo bake failed:', err);
    }
    this.rumble = new FieldRumble(
      this.ctx,
      this.dest,
      noiseBuffer(this.ctx, 'brown', 3.0, 1, 704),
    );
  }

  bind(kartId: number, isPlayer: boolean, character?: EngineCharacterId): void {
    const existing = this.voices.get(kartId);
    if (existing) {
      if (character && character !== existing.character) {
        existing.dispose();
        this.voices.delete(kartId);
        this.order = this.order.filter((v) => v !== existing);
      } else {
        if (isPlayer) this.playerId = kartId;
        return;
      }
    }
    const ch = character ?? (isPlayer ? 'standard' : characterForKart(kartId));
    const voice = new EngineVoice(this.ctx, kartId, isPlayer, ch, this.dest, this.send, this.shared);
    this.voices.set(kartId, voice);
    this.order.push(voice);
    if (isPlayer) this.playerId = kartId;
  }

  unbind(kartId: number): void {
    const v = this.voices.get(kartId);
    if (!v) return;
    v.dispose();
    this.voices.delete(kartId);
    this.order = this.order.filter((x) => x !== v);
    this.lastPushTime.delete(kartId);
  }

  setCharacter(kartId: number, character: EngineCharacterId): void {
    const v = this.voices.get(kartId);
    if (!v) return;
    const isPlayer = v.isPlayer;
    this.unbind(kartId);
    this.bind(kartId, isPlayer, character);
  }

  /** Push per-frame gameplay state. Safe to call before `bind` (ignored). */
  update(kartId: number, rpm: number, load: number, position: THREE.Vector3): void {
    const v = this.voices.get(kartId);
    if (!v) return;
    const now = this.ctx.currentTime;
    const known = this.lastPushTime.has(kartId);
    const last = this.lastPushTime.get(kartId) ?? now;
    const dt = clamp(now - last, 0, 0.25);
    // Let dt accumulate across pushes that arrive faster than the audio clock
    // can resolve, so the voice always differentiates over a real interval
    // instead of never differentiating at all.
    if (!known || dt >= MIN_PUSH_DT) this.lastPushTime.set(kartId, now);
    v.push(rpm, load, position, dt);
  }

  setBoost(kartId: number, on: boolean): void {
    this.voices.get(kartId)?.setBoost(on);
  }

  setVolume(v: number): void { this.masterGain = clamp(v, 0, 2); }

  /**
   * How many karts get a full engine graph. Everything past this folds into the
   * field-rumble bed. Driven by the quality tier — `low` gets 2, `ultra` 6.
   */
  setMaxSimulated(n: number): void {
    this.maxSim = Math.max(1, Math.min(12, Math.round(n)));
  }

  get maxSimulated(): number { return this.maxSim; }

  get voiceCount(): number { return this.voices.size; }
  get hotCount(): number {
    let n = 0;
    for (const v of this.voices.values()) if (v.hot) n++;
    return n;
  }

  /**
   * Per-frame housekeeping: pick the nearest N voices to fully simulate, tick
   * them, and fold the rest into the field bed.
   */
  frame(
    dt: number,
    listenerPos: { x: number; y: number; z: number },
    listenerVel: { x: number; y: number; z: number },
  ): void {
    this.elapsed += dt;

    // Distances are already computed inside tick(), but we need them BEFORE
    // ticking to decide who is hot. Compute cheaply here (12 karts max).
    const scored = this.order;
    const player = this.playerId;
    // Insertion-sort by distance; the array is tiny and nearly sorted between
    // frames, so this is effectively O(n) and allocation-free.
    for (let i = 1; i < scored.length; i++) {
      const v = scored[i];
      const d = v.distanceSquaredTo(listenerPos);
      let j = i - 1;
      while (j >= 0 && scored[j].distanceSquaredTo(listenerPos) > d) {
        scored[j + 1] = scored[j];
        j--;
      }
      scored[j + 1] = v;
    }

    let hotUsed = 0;
    let coldCount = 0;
    let coldRpmSum = 0;
    let coldNearest = 1e9;
    for (const v of scored) {
      const isPlayer = v.kartId === player || v.isPlayer;
      const wantHot = isPlayer || hotUsed < this.maxSim;
      if (wantHot) hotUsed++;
      v.setHot(wantHot);
      if (!wantHot) {
        coldCount++;
        coldRpmSum += v.rpmTarget;
        const d = Math.sqrt(Math.max(0, v.distanceSquaredTo(listenerPos)));
        if (d < coldNearest) coldNearest = d;
      }
      v.tick(dt, this.elapsed, listenerPos, listenerVel, this.masterGain);
    }

    if (this.rumble) {
      this.rumble.update(
        dt,
        coldCount,
        coldCount > 0 ? coldRpmSum / coldCount : 0,
        coldCount > 0 ? coldNearest : 1e9,
        this.masterGain,
      );
    }
  }

  debugAll(): Array<ReturnType<EngineVoice['debug']>> {
    const out: Array<ReturnType<EngineVoice['debug']>> = [];
    for (const v of this.order) out.push(v.debug());
    return out;
  }

  debug(kartId: number): ReturnType<EngineVoice['debug']> | null {
    return this.voices.get(kartId)?.debug() ?? null;
  }

  dispose(): void {
    for (const v of this.voices.values()) v.dispose();
    this.voices.clear();
    this.order.length = 0;
    this.rumble?.dispose();
    this.rumble = null;
  }
}
