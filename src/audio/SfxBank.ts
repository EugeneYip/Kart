/**
 * ============================================================================
 *  FOXY KART — SFX BANK
 * ============================================================================
 *  Every one of these sounds is synthesised from oscillators, noise and
 *  filters, rendered ONCE into an AudioBuffer through an OfflineAudioContext
 *  at init, and then played back as a single BufferSource.
 *
 *  Why bake? A convincing explosion is a 20-node graph (sub sine sweep, brown
 *  noise body, hard-clipped mid crack, HF transient, velvet-noise debris tail,
 *  comb slap). Building that per hit, twelve karts deep, would blow the audio
 *  thread. Baking makes each hit cost exactly one BufferSource + one Gain.
 *
 *  Runtime variation comes from per-play random `detune` and gain, so 30 shell
 *  bounces in a lap never sound like the same sample 30 times.
 * ============================================================================
 */

import type * as THREE from 'three';
import { clamp, clamp01, lerp } from '@/core/MathUtils';
import {
  Harmonics, Rand, adsr, cachedWave, comb, distortionCurve, fadeEdges, fmPair,
  formantBank, harmonicWave, makeSeamlessLoop, makeShaper, metalBody, multiSweep,
  noiseBuffer, noiseBurst, noteToFreq, normalizeBuffer, perc, ramp, renderOffline,
  sweep, tone, analyzeBuffer, VOWEL_FORMANTS,
} from './Synth';
import type { BufferStats } from './Synth';

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

export interface SfxPlayOptions {
  position?: THREE.Vector3;
  volume?: number;
  rate?: number;
  /** Fade-in, seconds. Loops usually want ~0.08. */
  fadeIn?: number;
  /** Force loop on/off, overriding the spec default. */
  loop?: boolean;
  /** Delay before start, seconds. */
  delay?: number;
}

export interface SfxHandle {
  readonly id: string;
  readonly active: boolean;
  setVolume(v: number, seconds?: number): void;
  setRate(v: number, seconds?: number): void;
  /** Lowpass corner for loops whose brightness is gameplay-driven. */
  setFilter(hz: number, q?: number, seconds?: number): void;
  setPosition(p: THREE.Vector3): void;
  stop(fadeSeconds?: number): void;
}

// ---------------------------------------------------------------------------
// Local synthesis helpers (offline-context only)
// ---------------------------------------------------------------------------

type Build = (ctx: OfflineAudioContext, out: GainNode, sr: number) => void;

/** Amplitude-modulate a gain param with an oscillator: gain = base + depth*osc. */
function am(
  ctx: BaseAudioContext,
  target: AudioParam,
  t0: number,
  dur: number,
  hz: number,
  depth: number,
  type: OscillatorType = 'sine',
  wave?: PeriodicWave,
): OscillatorNode {
  const lfo = ctx.createOscillator();
  if (wave) lfo.setPeriodicWave(wave);
  else lfo.type = type;
  lfo.frequency.value = hz;
  const g = ctx.createGain();
  g.gain.value = depth;
  lfo.connect(g);
  g.connect(target);
  lfo.start(t0);
  lfo.stop(t0 + dur + 0.05);
  return lfo;
}

/** A looping noise source through a biquad, with its own gain. */
function noiseBed(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  dur: number,
  o: {
    type?: 'white' | 'pink' | 'brown' | 'blue' | 'velvet';
    filter?: BiquadFilterType;
    hz: number;
    q?: number;
    gain?: number;
    seed?: number;
  },
): { gain: GainNode; filter: BiquadFilterNode; src: AudioBufferSourceNode } {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, o.type ?? 'pink', Math.max(2.2, dur + 0.3), 1, o.seed ?? 5);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = o.filter ?? 'bandpass';
  f.frequency.value = o.hz;
  f.Q.value = o.q ?? 1;
  const g = ctx.createGain();
  g.gain.value = o.gain ?? 1;
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
  return { gain: g, filter: f, src };
}

/** Struck-metal ring: an impulse of noise driven into a bank of combs. */
function metalRing(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  baseHz: number,
  partials: readonly number[],
  gain: number,
  decay: number,
  fb = 0.9,
): void {
  const body = metalBody(ctx, baseHz, partials, fb, 6500);
  const exciter = noiseBurst(ctx, body.input, t0, 0.012, {
    type: 'white', filter: 'bandpass', freq: baseHz * 3, q: 0.5, gain: 1, decay: 0.01,
  });
  void exciter;
  const g = ctx.createGain();
  g.gain.value = 0;
  perc(g.gain, t0, gain, 0.001, decay);
  body.output.connect(g);
  g.connect(dest);
}

/** A short percussive "blip" — the atom of every UI and pickup sound. */
function blip(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  hz: number,
  gain: number,
  decay: number,
  wave?: PeriodicWave,
): void {
  tone(ctx, dest, t0, decay + 0.02, {
    wave, type: wave ? undefined : 'triangle', freq: hz, gain, attack: 0.002, decay,
  });
}

/** FM bell / marimba / steel-drum voice — the sparkle in every pickup. */
function fmHit(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  hz: number,
  o: { ratio?: number; index?: number; gain?: number; decay?: number; indexDecay?: number; carrier?: OscillatorType },
): void {
  const dur = o.decay ?? 0.4;
  const pair = fmPair(ctx, {
    carrierHz: hz,
    ratio: o.ratio ?? 3.5,
    index: o.index ?? 2.2,
    indexDecay: o.indexDecay ?? dur * 0.35,
    carrierType: o.carrier ?? 'sine',
  });
  const g = ctx.createGain();
  g.gain.value = 0;
  perc(g.gain, t0, o.gain ?? 0.6, 0.003, dur);
  pair.out.connect(g);
  g.connect(dest);
  pair.start(t0);
  pair.stop(t0 + dur + 0.1);
}

// ---------------------------------------------------------------------------
// Spec table
// ---------------------------------------------------------------------------

interface SfxSpec {
  seconds: number;
  build: Build;
  channels?: number;
  loop?: boolean;
  /** Crossfade length for seamless looping; set to one modulation period. */
  loopFade?: number;
  /** Playback gain applied on top of the (normalised) buffer. */
  gain?: number;
  /** Peak-normalise the bake to this value. 0 disables. */
  normalize?: number;
  maxVoices?: number;
  /** Random detune per play, cents. */
  pitchVar?: number;
  /** Random gain wobble per play, 0..1 fraction. */
  gainVar?: number;
  /** Reverb send amount, 0..1. UI sounds should stay dry. */
  send?: number;
  /** Fade the very edges of the bake (one-shots only). */
  edgeFade?: number;
}

const CENTS = (semi: number) => semi * 100;

/** Reusable wavetables, keyed per context. */
const W = {
  brass: (c: BaseAudioContext) => cachedWave(c, 'brass', () => harmonicWave(c, Harmonics.brass(24))),
  lead: (c: BaseAudioContext) => cachedWave(c, 'lead', () => harmonicWave(c, Harmonics.lead(20))),
  bell: (c: BaseAudioContext) => cachedWave(c, 'bell', () => harmonicWave(c, Harmonics.bell(20))),
  bass: (c: BaseAudioContext) => cachedWave(c, 'bass', () => harmonicWave(c, Harmonics.bass(14))),
  saw12: (c: BaseAudioContext) => cachedWave(c, 'saw12', () => harmonicWave(c, Harmonics.saw(12))),
  odd9: (c: BaseAudioContext) => cachedWave(c, 'odd9', () => harmonicWave(c, Harmonics.odd(9))),
  pulse16: (c: BaseAudioContext) => cachedWave(c, 'pulse16', () => harmonicWave(c, Harmonics.pulse(16, 0.3), Harmonics.scatterPhases(16, 3))),
};

const SPECS: Record<string, SfxSpec> = {

  // =========================================================================
  // DRIFT
  // =========================================================================

  /** Tyre-scrub onset: a fast-attack burst of filtered pink noise that settles
   *  into the sustained scrub, plus a rubber squeal that bends down. */
  drift_start: {
    seconds: 0.55, gain: 0.85, normalize: 0.92, maxVoices: 3, pitchVar: 90, gainVar: 0.12, send: 0.35,
    build: (ctx, out) => {
      // scrub onset — bright then darkening
      const bed = noiseBed(ctx, out, 0, 0.5, { type: 'pink', filter: 'bandpass', hz: 2600, q: 1.2, gain: 0, seed: 12 });
      perc(bed.gain.gain, 0, 0.95, 0.008, 0.44);
      sweep(bed.filter.frequency, 0, 2600, 950, 0.45);
      // rubber squeal with a little vibrato so it sounds alive
      const sq = tone(ctx, out, 0.01, 0.4, {
        type: 'sawtooth', freq: 780, freqEnd: 560, gain: 0.20, attack: 0.012, decay: 0.36,
      });
      void sq;
      const vib = ctx.createOscillator();
      vib.type = 'sine'; vib.frequency.value = 17;
      const vg = ctx.createGain(); vg.gain.value = 0.16;
      vib.connect(vg); vg.connect(out.gain);
      vib.start(0); vib.stop(0.45);
      // grit transient
      noiseBurst(ctx, out, 0, 0.06, { type: 'white', filter: 'highpass', freq: 3200, gain: 0.28, decay: 0.05 });
    },
  },

  /** Sustained scrub. The runtime lowpass tracks drift angle, so this bake is
   *  deliberately broadband — the filter does the expression. */
  drift_loop: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.5, normalize: 0.8, maxVoices: 2, send: 0.3,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.15, { type: 'pink', filter: 'bandpass', hz: 1250, q: 1.5, gain: 0.75, seed: 13 });
      // slow amplitude wobble (stick-slip) — 20 Hz divides the 0.15 s crossfade
      am(ctx, bed.gain.gain, 0, 2.15, 20, 0.22);
      am(ctx, bed.filter.frequency, 0, 2.15, 6.666667, 260);
      // tyre carcass resonance
      const c1 = comb(ctx, 1 / 190, 0.62, 3400);
      bed.filter.connect(c1.input);
      const cg = ctx.createGain(); cg.gain.value = 0.3;
      c1.output.connect(cg); cg.connect(out);
      // high scuff layer
      noiseBed(ctx, out, 0, 2.15, { type: 'white', filter: 'highpass', hz: 4200, q: 0.7, gain: 0.10, seed: 14 });
    },
  },

  /** Blue spark: a clean, bright rising sparkle. Confident, not urgent. */
  drift_charge_blue: {
    seconds: 0.6, gain: 0.55, normalize: 0.9, maxVoices: 3, pitchVar: 40, gainVar: 0.1, send: 0.3,
    build: (ctx, out) => {
      const notes = [noteToFreq('E5'), noteToFreq('B5'), noteToFreq('E6')];
      notes.forEach((f, i) => fmHit(ctx, out, i * 0.055, f, { ratio: 3.01, index: 1.6, gain: 0.5 - i * 0.06, decay: 0.34 - i * 0.05 }));
      noiseBurst(ctx, out, 0, 0.3, { type: 'white', filter: 'highpass', freq: 5200, freqEnd: 9000, gain: 0.14, decay: 0.26 });
      tone(ctx, out, 0, 0.3, { type: 'sine', freq: 180, freqEnd: 320, gain: 0.16, attack: 0.004, decay: 0.24 });
    },
  },

  /** Orange spark: higher, denser, more electric — clearly a step up. */
  drift_charge_orange: {
    seconds: 0.68, gain: 0.6, normalize: 0.92, maxVoices: 3, pitchVar: 40, gainVar: 0.1, send: 0.32,
    build: (ctx, out) => {
      const notes = [noteToFreq('A5'), noteToFreq('E6'), noteToFreq('A6'), noteToFreq('C#7')];
      notes.forEach((f, i) => fmHit(ctx, out, i * 0.048, f, { ratio: 2.005, index: 2.6, gain: 0.44 - i * 0.05, decay: 0.32 - i * 0.045 }));
      // buzzing electric layer
      const buzz = tone(ctx, out, 0.02, 0.36, {
        wave: W.odd9(ctx), freq: noteToFreq('A4'), freqEnd: noteToFreq('E6'), gain: 0.16, attack: 0.01, decay: 0.3,
      });
      void buzz;
      noiseBurst(ctx, out, 0, 0.36, { type: 'white', filter: 'bandpass', freq: 6000, freqEnd: 11000, q: 0.8, gain: 0.2, decay: 0.32 });
      tone(ctx, out, 0, 0.3, { type: 'sine', freq: 200, freqEnd: 420, gain: 0.18, attack: 0.003, decay: 0.24 });
    },
  },

  /** Purple spark: dangerous. Detuned near-tritone pair, ring modulation, a
   *  growing sub and a distorted edge. It should feel like it might bite. */
  drift_charge_purple: {
    seconds: 0.85, gain: 0.68, normalize: 0.95, maxVoices: 3, pitchVar: 30, gainVar: 0.08, send: 0.38,
    build: (ctx, out) => {
      const shaper = makeShaper(ctx, 'asym', 0.42);
      shaper.connect(out);

      // dissonant pair: root + tritone, both drifting upward
      const pairs: Array<[string, string, number]> = [['C#6', 'G6', 0], ['E6', 'A#6', 0.06], ['G#6', 'D7', 0.12]];
      for (const [a, b, dt] of pairs) {
        fmHit(ctx, shaper, dt, noteToFreq(a), { ratio: 1.414, index: 3.4, gain: 0.34, decay: 0.4, carrier: 'triangle' });
        fmHit(ctx, out, dt + 0.004, noteToFreq(b), { ratio: 2.83, index: 2.1, gain: 0.2, decay: 0.34 });
      }
      // rising electric scream
      const scream = tone(ctx, shaper, 0, 0.5, {
        wave: W.pulse16(ctx), freq: noteToFreq('C#5'), freqEnd: noteToFreq('C#7'), gain: 0.22, attack: 0.02, decay: 0.42,
      });
      void scream;
      // ring-mod shimmer
      const rm = ctx.createGain(); rm.gain.value = 0;
      const car = ctx.createOscillator(); car.type = 'sine'; car.frequency.value = 3400;
      const mod = ctx.createOscillator(); mod.type = 'sine'; mod.frequency.value = 137;
      const mg = ctx.createGain(); mg.gain.value = 1;
      mod.connect(mg); mg.connect(rm.gain);
      car.connect(rm); rm.connect(out);
      perc(rm.gain, 0, 0.001, 0.01, 0.5);
      car.start(0); car.stop(0.6); mod.start(0); mod.stop(0.6);
      // sub growl
      tone(ctx, out, 0, 0.55, { type: 'sine', freq: 62, freqEnd: 128, gain: 0.34, attack: 0.02, decay: 0.5 });
      noiseBurst(ctx, out, 0, 0.5, { type: 'white', filter: 'bandpass', freq: 3000, freqEnd: 9000, q: 0.6, gain: 0.2, decay: 0.44, shaper: { type: 'soft', amount: 0.4 } });
    },
  },

  /** Boost release: punchy whoosh + low thump + bright shimmer. */
  boost_release: {
    seconds: 1.1, gain: 0.95, normalize: 0.97, maxVoices: 4, pitchVar: 60, gainVar: 0.1, send: 0.4,
    build: (ctx, out) => {
      // low thump — the shove in the back
      tone(ctx, out, 0, 0.5, { type: 'sine', freq: 120, freqEnd: 42, gain: 0.95, attack: 0.004, decay: 0.42 });
      tone(ctx, out, 0, 0.5, { type: 'sine', freq: 58, gain: 0.6, attack: 0.008, decay: 0.44 });
      tone(ctx, out, 0, 0.3, { type: 'triangle', freq: 220, freqEnd: 70, gain: 0.3, attack: 0.002, decay: 0.24 });
      // whoosh: up then away
      const bed = noiseBed(ctx, out, 0, 0.9, { type: 'white', filter: 'bandpass', hz: 500, q: 0.85, gain: 0, seed: 21 });
      perc(bed.gain.gain, 0, 0.72, 0.02, 0.82);
      bed.filter.frequency.setValueAtTime(420, 0);
      bed.filter.frequency.exponentialRampToValueAtTime(4800, 0.16);
      bed.filter.frequency.exponentialRampToValueAtTime(700, 0.85);
      // Afterburner tail. Without this the sound dies at ~0.45 s and reads as a
      // hit rather than a sustained shove.
      const tail = noiseBed(ctx, out, 0.05, 0.9, { type: 'brown', filter: 'lowpass', hz: 700, q: 1.1, gain: 0, seed: 22 });
      multiSweep(tail.gain.gain, 0.05, [[0, 0.0], [0.1, 0.34], [0.5, 0.14], [0.88, 0.01]]);
      // bright shimmer
      for (let i = 0; i < 4; i++) {
        fmHit(ctx, out, 0.01 + i * 0.03, noteToFreq(['B5', 'F#6', 'B6', 'D#7'][i]), {
          ratio: 4.01, index: 1.3, gain: 0.14 - i * 0.02, decay: 0.4,
        });
      }
      noiseBurst(ctx, out, 0, 0.4, { type: 'white', filter: 'highpass', freq: 7000, gain: 0.08, decay: 0.32 });
      // pre-transient click for attack definition
      noiseBurst(ctx, out, 0, 0.02, { type: 'white', filter: 'bandpass', freq: 2200, q: 0.5, gain: 0.5, decay: 0.016 });
    },
  },

  boost_pad: {
    seconds: 0.9, gain: 0.85, normalize: 0.95, maxVoices: 3, pitchVar: 50, send: 0.42,
    build: (ctx, out) => {
      tone(ctx, out, 0, 0.4, { type: 'sine', freq: 90, freqEnd: 200, gain: 0.7, attack: 0.006, decay: 0.34 });
      const bed = noiseBed(ctx, out, 0, 0.75, { type: 'white', filter: 'bandpass', hz: 900, q: 1.1, gain: 0, seed: 22 });
      perc(bed.gain.gain, 0, 0.6, 0.01, 0.7);
      sweep(bed.filter.frequency, 0, 900, 6200, 0.6);
      for (let i = 0; i < 3; i++) {
        fmHit(ctx, out, i * 0.07, noteToFreq(['D5', 'A5', 'D6'][i]), { ratio: 3.0, index: 1.8, gain: 0.26, decay: 0.4 });
      }
    },
  },

  // =========================================================================
  // CHASSIS / SUSPENSION / SURFACE
  // =========================================================================

  hop: {
    seconds: 0.28, gain: 0.45, normalize: 0.85, maxVoices: 5, pitchVar: 140, gainVar: 0.18, send: 0.25,
    build: (ctx, out) => {
      // suspension unload: a quick upward "sproing"
      tone(ctx, out, 0, 0.2, { type: 'triangle', freq: 190, freqEnd: 430, gain: 0.55, attack: 0.003, decay: 0.16 });
      metalRing(ctx, out, 0, 640, [1, 2.41, 3.77], 0.14, 0.14, 0.72);
      noiseBurst(ctx, out, 0, 0.05, { type: 'white', filter: 'bandpass', freq: 1900, q: 0.8, gain: 0.22, decay: 0.04 });
    },
  },

  land_soft: {
    seconds: 0.34, gain: 0.5, normalize: 0.85, maxVoices: 5, pitchVar: 160, gainVar: 0.2, send: 0.3,
    build: (ctx, out) => {
      tone(ctx, out, 0, 0.24, { type: 'sine', freq: 140, freqEnd: 66, gain: 0.7, attack: 0.003, decay: 0.2 });
      noiseBurst(ctx, out, 0, 0.14, { type: 'pink', filter: 'lowpass', freq: 900, q: 0.7, gain: 0.32, decay: 0.12 });
    },
  },

  land_hard: {
    seconds: 0.7, gain: 0.85, normalize: 0.95, maxVoices: 5, pitchVar: 120, gainVar: 0.15, send: 0.34,
    build: (ctx, out) => {
      // suspension thunk with a hard pitch drop — the weight cue
      tone(ctx, out, 0, 0.4, { type: 'sine', freq: 150, freqEnd: 40, gain: 1.0, attack: 0.002, decay: 0.34 });
      // Dedicated sub layer. A pitch sweep alone spends most of its energy
      // above 100 Hz on the way down; a fixed 55 Hz body is what you feel.
      tone(ctx, out, 0, 0.42, { type: 'sine', freq: 55, gain: 0.85, attack: 0.006, decay: 0.36 });
      tone(ctx, out, 0, 0.16, { type: 'square', freq: 150, freqEnd: 70, gain: 0.14, attack: 0.001, decay: 0.13 });
      // tyre slap
      noiseBurst(ctx, out, 0, 0.2, { type: 'pink', filter: 'lowpass', freq: 1600, freqEnd: 420, gain: 0.55, decay: 0.17, shaper: { type: 'soft', amount: 0.3 } });
      // chassis rattle
      metalRing(ctx, out, 0.006, 174, [1, 1.83, 2.71, 4.13], 0.22, 0.34, 0.86);
      noiseBurst(ctx, out, 0.01, 0.3, { type: 'velvet', filter: 'bandpass', freq: 2600, q: 1.4, gain: 0.16, decay: 0.28 });
    },
  },

  wall_scrape: {
    seconds: 1.75, loop: true, loopFade: 0.15, gain: 0.5, normalize: 0.85, maxVoices: 2, send: 0.35,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 1.75, { type: 'white', filter: 'bandpass', hz: 2400, q: 1.1, gain: 0.4, seed: 31 });
      // comb-filtered: guardrail = a resonant metal plate
      const body = metalBody(ctx, 320, [1, 1.47, 2.09, 2.93, 4.11], 0.84, 5200);
      bed.filter.connect(body.input);
      const bg = ctx.createGain(); bg.gain.value = 0.5;
      body.output.connect(bg); bg.connect(out);
      am(ctx, bed.gain.gain, 0, 1.75, 40, 0.14);
      am(ctx, bed.filter.frequency, 0, 1.75, 13.33333, 700);
      noiseBed(ctx, out, 0, 1.75, { type: 'white', filter: 'highpass', hz: 6000, gain: 0.12, seed: 32 });
    },
  },

  wall_hit_hard: {
    seconds: 0.9, gain: 0.95, normalize: 0.97, maxVoices: 4, pitchVar: 110, gainVar: 0.14, send: 0.45,
    build: (ctx, out) => {
      tone(ctx, out, 0, 0.34, { type: 'sine', freq: 130, freqEnd: 38, gain: 1.0, attack: 0.001, decay: 0.3 });
      // Barrier body: a fixed sub so the hit has mass, not just a click.
      tone(ctx, out, 0, 0.34, { type: 'sine', freq: 52, gain: 0.9, attack: 0.004, decay: 0.3 });
      noiseBurst(ctx, out, 0, 0.13, { type: 'white', filter: 'bandpass', freq: 1300, freqEnd: 500, q: 0.7, gain: 0.55, decay: 0.11, shaper: { type: 'hard', amount: 0.55 } });
      metalRing(ctx, out, 0, 232, [1, 1.59, 2.31, 3.4, 4.9], 0.26, 0.5, 0.9);
      // debris / plastic scatter
      noiseBurst(ctx, out, 0.02, 0.55, { type: 'velvet', filter: 'bandpass', freq: 3100, q: 1.8, gain: 0.14, decay: 0.5 });
    },
  },

  kart_bump: {
    seconds: 0.42, gain: 0.62, normalize: 0.9, maxVoices: 5, pitchVar: 180, gainVar: 0.22, send: 0.3,
    build: (ctx, out) => {
      // rubbery, boxy — bodywork, not metal
      tone(ctx, out, 0, 0.22, { type: 'sine', freq: 175, freqEnd: 88, gain: 0.75, attack: 0.002, decay: 0.19 });
      const body = metalBody(ctx, 128, [1, 2.16, 3.02], 0.7, 1500);
      const ex = noiseBurst(ctx, body.input, 0, 0.03, { type: 'white', filter: 'lowpass', freq: 1200, gain: 1, decay: 0.025 });
      void ex;
      const bg = ctx.createGain(); bg.gain.value = 0; perc(bg.gain, 0, 0.35, 0.002, 0.2);
      body.output.connect(bg); bg.connect(out);
      noiseBurst(ctx, out, 0, 0.09, { type: 'pink', filter: 'bandpass', freq: 800, q: 0.6, gain: 0.4, decay: 0.08 });
    },
  },

  offroad_loop: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.55, normalize: 0.85, maxVoices: 2, send: 0.2,
    build: (ctx, out) => {
      const low = noiseBed(ctx, out, 0, 2.15, { type: 'brown', filter: 'lowpass', hz: 340, q: 1.2, gain: 0.85, seed: 41 });
      am(ctx, low.gain.gain, 0, 2.15, 20, 0.35, 'triangle');
      const grit = noiseBed(ctx, out, 0, 2.15, { type: 'white', filter: 'bandpass', hz: 900, q: 0.8, gain: 0.3, seed: 42 });
      am(ctx, grit.gain.gain, 0, 2.15, 40, 0.2);
      // gravel ticks
      noiseBed(ctx, out, 0, 2.15, { type: 'velvet', filter: 'bandpass', hz: 1900, q: 2.6, gain: 0.11, seed: 43 });
    },
  },

  // ---- rolling loops ------------------------------------------------------

  roll_asphalt: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.4, normalize: 0.78, maxVoices: 3, send: 0.18,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.15, { type: 'pink', filter: 'bandpass', hz: 420, q: 0.65, gain: 0.9, seed: 51 });
      am(ctx, bed.gain.gain, 0, 2.15, 40, 0.12);
      noiseBed(ctx, out, 0, 2.15, { type: 'pink', filter: 'bandpass', hz: 1500, q: 0.9, gain: 0.2, seed: 52 });
    },
  },
  roll_dirt: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.45, normalize: 0.8, maxVoices: 3, send: 0.18,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.15, { type: 'brown', filter: 'lowpass', hz: 560, q: 0.9, gain: 0.85, seed: 53 });
      am(ctx, bed.gain.gain, 0, 2.15, 20, 0.24, 'triangle');
      noiseBed(ctx, out, 0, 2.15, { type: 'velvet', filter: 'bandpass', hz: 1800, q: 1.6, gain: 0.28, seed: 54 });
    },
  },
  roll_grass: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.4, normalize: 0.78, maxVoices: 3, send: 0.15,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.15, { type: 'pink', filter: 'bandpass', hz: 950, q: 0.8, gain: 0.8, seed: 55 });
      am(ctx, bed.gain.gain, 0, 2.15, 26.666667, 0.3, 'triangle');
      noiseBed(ctx, out, 0, 2.15, { type: 'white', filter: 'highpass', hz: 3200, gain: 0.14, seed: 56 });
    },
  },
  roll_sand: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.42, normalize: 0.78, maxVoices: 3, send: 0.15,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.15, { type: 'white', filter: 'lowpass', hz: 1700, q: 0.7, gain: 0.62, seed: 57 });
      am(ctx, bed.gain.gain, 0, 2.15, 13.33333, 0.22, 'triangle');
      noiseBed(ctx, out, 0, 2.15, { type: 'pink', filter: 'bandpass', hz: 620, q: 0.8, gain: 0.28, seed: 58 });
    },
  },
  roll_water: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.5, normalize: 0.82, maxVoices: 3, send: 0.3,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.15, { type: 'pink', filter: 'bandpass', hz: 1450, q: 0.9, gain: 0.7, seed: 59 });
      am(ctx, bed.filter.frequency, 0, 2.15, 6.666667, 420);
      am(ctx, bed.gain.gain, 0, 2.15, 20, 0.2);
      // bubbles / droplets
      const drops = noiseBed(ctx, out, 0, 2.15, { type: 'velvet', filter: 'bandpass', hz: 2600, q: 6, gain: 0.3, seed: 60 });
      am(ctx, drops.filter.frequency, 0, 2.15, 13.33333, 900);
      noiseBed(ctx, out, 0, 2.15, { type: 'brown', filter: 'lowpass', hz: 260, gain: 0.3, seed: 61 });
    },
  },
  roll_ice: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.4, normalize: 0.76, maxVoices: 3, send: 0.35,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.15, { type: 'white', filter: 'bandpass', hz: 3600, q: 2.2, gain: 0.55, seed: 62 });
      am(ctx, bed.gain.gain, 0, 2.15, 20, 0.18);
      // faint glassy ring
      const t = tone(ctx, out, 0, 2.15, { type: 'sine', freq: 1560, gain: 0.05, attack: 0.2, decay: 2.0 });
      void t;
      noiseBed(ctx, out, 0, 2.15, { type: 'pink', filter: 'bandpass', hz: 700, q: 0.9, gain: 0.14, seed: 63 });
    },
  },
  roll_metal: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.45, normalize: 0.8, maxVoices: 3, send: 0.45,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.15, { type: 'white', filter: 'bandpass', hz: 1300, q: 1.0, gain: 0.4, seed: 64 });
      const body = metalBody(ctx, 220, [1, 1.51, 2.13, 3.07], 0.8, 6000);
      bed.filter.connect(body.input);
      const bg = ctx.createGain(); bg.gain.value = 0.55;
      body.output.connect(bg); bg.connect(out);
      am(ctx, bed.gain.gain, 0, 2.15, 40, 0.2);
      noiseBed(ctx, out, 0, 2.15, { type: 'pink', filter: 'bandpass', hz: 480, q: 0.8, gain: 0.22, seed: 65 });
    },
  },
  roll_wood: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.44, normalize: 0.8, maxVoices: 3, send: 0.28,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.15, { type: 'pink', filter: 'lowpass', hz: 900, q: 0.8, gain: 0.6, seed: 66 });
      const body = metalBody(ctx, 168, [1, 2.07, 3.11], 0.66, 1400);
      bed.filter.connect(body.input);
      const bg = ctx.createGain(); bg.gain.value = 0.6;
      body.output.connect(bg); bg.connect(out);
      am(ctx, bed.gain.gain, 0, 2.15, 20, 0.28, 'triangle');
      noiseBed(ctx, out, 0, 2.15, { type: 'velvet', filter: 'bandpass', hz: 1500, q: 3, gain: 0.2, seed: 67 });
    },
  },
  /** Anti-gravity: no tyres at all. A tonal magnetic hum with shimmer. */
  roll_ag: {
    seconds: 2.15, loop: true, loopFade: 0.15, gain: 0.42, normalize: 0.8, maxVoices: 3, send: 0.5,
    build: (ctx, out) => {
      const hum = ctx.createGain(); hum.gain.value = 0.34; hum.connect(out);
      for (const [hz, det, g] of [[110, 0, 1], [110, 11, 0.8], [220, -7, 0.5], [330, 5, 0.22]] as Array<[number, number, number]>) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(W.saw12(ctx));
        o.frequency.value = hz; o.detune.value = det;
        const g2 = ctx.createGain(); g2.gain.value = g * 0.4;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 1.4;
        o.connect(lp); lp.connect(g2); g2.connect(hum);
        am(ctx, g2.gain, 0, 2.15, 6.666667, g * 0.12);
        o.start(0); o.stop(2.2);
      }
      // electric shimmer
      const sh = noiseBed(ctx, out, 0, 2.15, { type: 'white', filter: 'bandpass', hz: 5200, q: 3.5, gain: 0.14, seed: 68 });
      am(ctx, sh.filter.frequency, 0, 2.15, 3.333333, 1400);
      noiseBed(ctx, out, 0, 2.15, { type: 'brown', filter: 'lowpass', hz: 180, gain: 0.2, seed: 69 });
    },
  },

  silence: { seconds: 0.05, gain: 0, normalize: 0, maxVoices: 1, build: () => { /* intentionally empty */ } },

  // =========================================================================
  // ITEMS
  // =========================================================================

  item_box: {
    seconds: 0.6, gain: 0.7, normalize: 0.92, maxVoices: 4, pitchVar: 70, gainVar: 0.12, send: 0.35,
    build: (ctx, out) => {
      // glassy shatter-ping
      metalRing(ctx, out, 0, 880, [1, 2.76, 5.4, 8.93], 0.5, 0.42, 0.88);
      const notes = ['D6', 'F#6', 'A6', 'D7'];
      notes.forEach((n, i) => fmHit(ctx, out, i * 0.035, noteToFreq(n), { ratio: 3.5, index: 1.4, gain: 0.34 - i * 0.05, decay: 0.36 }));
      noiseBurst(ctx, out, 0, 0.25, { type: 'white', filter: 'highpass', freq: 6500, gain: 0.24, decay: 0.2 });
      tone(ctx, out, 0, 0.2, { type: 'sine', freq: 160, freqEnd: 90, gain: 0.28, attack: 0.002, decay: 0.16 });
    },
  },

  /** Rapid tick that decelerates — the roulette winding down. */
  item_roulette: {
    seconds: 1.5, gain: 0.5, normalize: 0.9, maxVoices: 1, send: 0.15,
    build: (ctx, out) => {
      let t = 0;
      let k = 0;
      const wave = W.bell(ctx);
      while (t < 1.42 && k < 60) {
        const u = clamp01(t / 1.42);
        const hz = lerp(1100, 1850, u);
        blip(ctx, out, t, hz, 0.5 * (1 - u * 0.35), 0.028, wave);
        noiseBurst(ctx, out, t, 0.012, { type: 'white', filter: 'highpass', freq: 5000, gain: 0.12, decay: 0.01 });
        // interval grows quadratically => audible deceleration
        t += 0.026 * (1 + u * u * 9);
        k++;
      }
    },
  },

  item_get: {
    seconds: 0.7, gain: 0.62, normalize: 0.9, maxVoices: 3, pitchVar: 30, send: 0.3,
    build: (ctx, out) => {
      ['D5', 'F#5', 'A5', 'D6'].forEach((n, i) =>
        fmHit(ctx, out, i * 0.058, noteToFreq(n), { ratio: 4.0, index: 1.1, gain: 0.42 - i * 0.04, decay: 0.42, indexDecay: 0.08 }));
      noiseBurst(ctx, out, 0.02, 0.3, { type: 'white', filter: 'highpass', freq: 7500, gain: 0.13, decay: 0.26 });
    },
  },

  shell_fire: {
    seconds: 0.5, gain: 0.7, normalize: 0.92, maxVoices: 5, pitchVar: 130, gainVar: 0.16, send: 0.3,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 0.4, { type: 'white', filter: 'bandpass', hz: 700, q: 1.1, gain: 0, seed: 71 });
      perc(bed.gain.gain, 0, 0.8, 0.006, 0.34);
      sweep(bed.filter.frequency, 0, 700, 5200, 0.3);
      tone(ctx, out, 0, 0.3, { type: 'triangle', freq: 420, freqEnd: 1500, gain: 0.28, attack: 0.004, decay: 0.24 });
      tone(ctx, out, 0, 0.16, { type: 'sine', freq: 150, freqEnd: 70, gain: 0.4, attack: 0.002, decay: 0.13 });
    },
  },

  shell_bounce: {
    seconds: 0.3, gain: 0.6, normalize: 0.9, maxVoices: 6, pitchVar: 220, gainVar: 0.24, send: 0.34,
    build: (ctx, out) => {
      tone(ctx, out, 0, 0.14, { type: 'triangle', freq: 520, freqEnd: 900, gain: 0.6, attack: 0.0015, decay: 0.11 });
      metalRing(ctx, out, 0, 760, [1, 2.31, 3.9], 0.24, 0.16, 0.8);
      noiseBurst(ctx, out, 0, 0.035, { type: 'white', filter: 'bandpass', freq: 2600, q: 0.9, gain: 0.3, decay: 0.03 });
    },
  },

  shell_hit: {
    seconds: 0.7, gain: 0.85, normalize: 0.95, maxVoices: 5, pitchVar: 140, gainVar: 0.15, send: 0.42,
    build: (ctx, out) => {
      tone(ctx, out, 0, 0.28, { type: 'sine', freq: 190, freqEnd: 52, gain: 0.9, attack: 0.001, decay: 0.24 });
      noiseBurst(ctx, out, 0, 0.1, { type: 'white', filter: 'bandpass', freq: 1600, freqEnd: 600, q: 0.6, gain: 0.7, decay: 0.09, shaper: { type: 'hard', amount: 0.5 } });
      metalRing(ctx, out, 0, 430, [1, 1.71, 2.44, 3.6], 0.28, 0.34, 0.87);
      noiseBurst(ctx, out, 0.015, 0.42, { type: 'velvet', filter: 'bandpass', freq: 3400, q: 2, gain: 0.18, decay: 0.4 });
    },
  },

  /** Rising warning: two-tone beeps that get faster, higher and more detuned. */
  red_shell_lock: {
    seconds: 1.2, gain: 0.55, normalize: 0.88, maxVoices: 1, send: 0.2,
    build: (ctx, out) => {
      let t = 0;
      let i = 0;
      while (t < 1.12 && i < 14) {
        const u = clamp01(t / 1.12);
        const hz = lerp(700, 1450, u);
        const dur = 0.05;
        tone(ctx, out, t, dur + 0.02, { type: 'square', freq: hz, gain: 0.28 + u * 0.2, attack: 0.003, decay: dur });
        tone(ctx, out, t, dur + 0.02, { type: 'square', freq: hz * 1.008, gain: 0.16 + u * 0.14, attack: 0.003, decay: dur });
        t += lerp(0.16, 0.062, u);
        i++;
      }
      // tension bed
      const bed = noiseBed(ctx, out, 0, 1.15, { type: 'pink', filter: 'bandpass', hz: 1800, q: 3, gain: 0, seed: 73 });
      bed.gain.gain.setValueAtTime(0.0001, 0);
      bed.gain.gain.exponentialRampToValueAtTime(0.14, 1.0);
      bed.gain.gain.exponentialRampToValueAtTime(0.0001, 1.15);
      sweep(bed.filter.frequency, 0, 1400, 3600, 1.1);
    },
  },

  /** Genuinely stressful siren. Hard-clipped saw, wailing pitch, pulsing sub.
   *  Period = 0.42 s, so 5 cycles bake + 1-cycle crossfade loops perfectly. */
  blue_shell_alarm: {
    seconds: 2.52, loop: true, loopFade: 0.42, channels: 2, gain: 0.6, normalize: 0.9, maxVoices: 1, send: 0.4,
    build: (ctx, out) => {
      const P = 0.42;
      const dur = 2.52;
      const shaper = makeShaper(ctx, 'hard', 0.5);
      const sg = ctx.createGain(); sg.gain.value = 0.34;
      shaper.connect(sg); sg.connect(out);

      // wailing pair, a semitone apart => beating, unpleasant, urgent
      for (const [mul, det, g] of [[1, 0, 1], [1, 106, 0.7]] as Array<[number, number, number]>) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(W.saw12(ctx));
        o.frequency.value = 520 * mul;
        o.detune.value = det;
        const lfo = ctx.createOscillator();
        lfo.type = 'triangle';
        lfo.frequency.value = 1 / P;
        const amt = ctx.createGain(); amt.gain.value = 190 * mul;
        lfo.connect(amt); amt.connect(o.frequency);
        const g2 = ctx.createGain(); g2.gain.value = g;
        o.connect(g2); g2.connect(shaper);
        o.start(0); o.stop(dur + 0.05);
        lfo.start(0); lfo.stop(dur + 0.05);
      }
      // pulsing sub — the "incoming" heartbeat
      const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 58;
      const subg = ctx.createGain(); subg.gain.value = 0.22;
      sub.connect(subg); subg.connect(out);
      am(ctx, subg.gain, 0, dur, 2 / P, 0.18);
      sub.start(0); sub.stop(dur + 0.05);
      // metallic klaxon ring
      const bed = noiseBed(ctx, out, 0, dur, { type: 'white', filter: 'bandpass', hz: 2400, q: 4, gain: 0.09, seed: 74 });
      am(ctx, bed.filter.frequency, 0, dur, 1 / P, 900);
      am(ctx, bed.gain.gain, 0, dur, 1 / P, 0.05);
    },
  },

  /** Layered explosion. Real sub-100 Hz energy is non-negotiable. */
  explosion: {
    seconds: 2.0, channels: 2, gain: 1.0, normalize: 0.98, maxVoices: 4, pitchVar: 100, gainVar: 0.12, send: 0.6,
    build: (ctx, out) => {
      // 1. sub boom — most of the energy, well under 100 Hz
      tone(ctx, out, 0, 0.9, { type: 'sine', freq: 78, freqEnd: 26, gain: 1.0, attack: 0.006, decay: 0.8 });
      tone(ctx, out, 0.004, 0.5, { type: 'sine', freq: 120, freqEnd: 40, gain: 0.55, attack: 0.003, decay: 0.44 });
      // 2. low body — brown noise, heavily lowpassed
      const body = noiseBed(ctx, out, 0, 0.9, { type: 'brown', filter: 'lowpass', hz: 220, q: 1.4, gain: 0, seed: 81 });
      perc(body.gain.gain, 0, 0.9, 0.004, 0.82);
      sweep(body.filter.frequency, 0, 320, 70, 0.8);
      // 3. mid crack — the "bang"
      noiseBurst(ctx, out, 0, 0.18, {
        type: 'white', filter: 'bandpass', freq: 950, freqEnd: 340, q: 0.55, gain: 0.85, decay: 0.16,
        shaper: { type: 'hard', amount: 0.6 },
      });
      // 4. HF transient — gives it "close-up" clarity
      noiseBurst(ctx, out, 0, 0.06, { type: 'white', filter: 'highpass', freq: 5500, gain: 0.42, decay: 0.05 });
      // 5. debris tail — velvet noise, sparse, long
      const deb = noiseBed(ctx, out, 0.03, 1.4, { type: 'velvet', filter: 'bandpass', hz: 2200, q: 1.6, gain: 0, seed: 82 });
      deb.gain.gain.setValueAtTime(0.0001, 0.03);
      deb.gain.gain.exponentialRampToValueAtTime(0.3, 0.09);
      deb.gain.gain.exponentialRampToValueAtTime(0.0001, 1.4);
      sweep(deb.filter.frequency, 0.03, 3200, 900, 1.3);
      // 6. a comb slap for size, cheap pseudo-early-reflection
      const c = comb(ctx, 0.021, 0.55, 2600);
      body.filter.connect(c.input);
      const cg = ctx.createGain(); cg.gain.value = 0.28;
      c.output.connect(cg); cg.connect(out);
    },
  },

  banana_slip: {
    seconds: 0.6, gain: 0.6, normalize: 0.9, maxVoices: 4, pitchVar: 160, gainVar: 0.18, send: 0.3,
    build: (ctx, out) => {
      // comic rubber whip: bright noise sweep + rising glissando
      const bed = noiseBed(ctx, out, 0, 0.35, { type: 'white', filter: 'bandpass', hz: 900, q: 2.2, gain: 0, seed: 83 });
      perc(bed.gain.gain, 0, 0.6, 0.005, 0.3);
      sweep(bed.filter.frequency, 0, 900, 5600, 0.3);
      tone(ctx, out, 0, 0.34, { type: 'sine', freq: 320, freqEnd: 1250, gain: 0.4, attack: 0.006, decay: 0.3 });
      // squeaky formant character
      const fb = formantBank(ctx, VOWEL_FORMANTS.i);
      const sq = noiseBed(ctx, fb.input, 0.02, 0.3, { type: 'pink', filter: 'highpass', hz: 700, gain: 0, seed: 84 });
      perc(sq.gain.gain, 0.02, 1.1, 0.01, 0.26);
      const fg = ctx.createGain(); fg.gain.value = 0.3;
      fb.output.connect(fg); fg.connect(out);
      tone(ctx, out, 0.3, 0.2, { type: 'triangle', freq: 220, freqEnd: 130, gain: 0.22, attack: 0.004, decay: 0.17 });
    },
  },

  spin_out: {
    seconds: 1.0, gain: 0.72, normalize: 0.93, maxVoices: 4, pitchVar: 120, gainVar: 0.14, send: 0.4,
    build: (ctx, out) => {
      // wavering tyre screech
      const bed = noiseBed(ctx, out, 0, 0.85, { type: 'pink', filter: 'bandpass', hz: 1900, q: 3.4, gain: 0, seed: 85 });
      perc(bed.gain.gain, 0, 0.7, 0.01, 0.8);
      am(ctx, bed.filter.frequency, 0, 0.85, 7.5, 620);
      sweep(bed.filter.frequency, 0, 2200, 1100, 0.8);
      // descending "you messed up" tone
      tone(ctx, out, 0.02, 0.6, { type: 'sawtooth', freq: 620, freqEnd: 180, gain: 0.24, attack: 0.01, decay: 0.55 });
      tone(ctx, out, 0, 0.3, { type: 'sine', freq: 150, freqEnd: 60, gain: 0.42, attack: 0.003, decay: 0.26 });
      noiseBurst(ctx, out, 0, 0.5, { type: 'white', filter: 'highpass', freq: 4200, gain: 0.14, decay: 0.44 });
    },
  },

  squash: {
    seconds: 0.55, gain: 0.7, normalize: 0.92, maxVoices: 4, pitchVar: 150, send: 0.3,
    build: (ctx, out) => {
      // pfffft — a fast bright-to-dark noise collapse
      const bed = noiseBed(ctx, out, 0, 0.4, { type: 'white', filter: 'lowpass', hz: 4000, q: 1.6, gain: 0, seed: 86 });
      perc(bed.gain.gain, 0, 0.85, 0.003, 0.36);
      sweep(bed.filter.frequency, 0, 4200, 200, 0.34);
      tone(ctx, out, 0, 0.34, { type: 'triangle', freq: 480, freqEnd: 90, gain: 0.42, attack: 0.002, decay: 0.3 });
      tone(ctx, out, 0.3, 0.2, { type: 'sine', freq: 130, freqEnd: 240, gain: 0.2, attack: 0.01, decay: 0.16 });
    },
  },

  shrink: {
    seconds: 0.8, gain: 0.6, normalize: 0.9, maxVoices: 4, pitchVar: 100, send: 0.3,
    build: (ctx, out) => {
      // descending glissando with a wobbling formant — cartoon deflation
      const g = tone(ctx, out, 0, 0.7, { wave: W.odd9(ctx), freq: 980, freqEnd: 190, gain: 0.42, attack: 0.006, decay: 0.66 });
      void g;
      const fb = formantBank(ctx, VOWEL_FORMANTS.o);
      const bed = noiseBed(ctx, fb.input, 0, 0.7, { type: 'pink', filter: 'bandpass', hz: 1400, q: 1.2, gain: 0, seed: 87 });
      perc(bed.gain.gain, 0, 0.9, 0.008, 0.66);
      sweep(bed.filter.frequency, 0, 1800, 320, 0.66);
      const fg = ctx.createGain(); fg.gain.value = 0.34;
      fb.output.connect(fg); fg.connect(out);
      for (const f of fb.filters) sweep(f.frequency, 0, f.frequency.value * 1.6, f.frequency.value * 0.5, 0.66);
      tone(ctx, out, 0, 0.3, { type: 'sine', freq: 220, freqEnd: 70, gain: 0.24, attack: 0.004, decay: 0.26 });
    },
  },

  lightning_strike: {
    seconds: 2.2, channels: 2, gain: 1.0, normalize: 0.98, maxVoices: 2, pitchVar: 60, send: 0.7,
    build: (ctx, out) => {
      // 1. the crack — full-band, hard-clipped, brutally short
      noiseBurst(ctx, out, 0, 0.03, { type: 'white', filter: 'highpass', freq: 900, gain: 1.0, attack: 0.0006, decay: 0.026, shaper: { type: 'hard', amount: 0.8 } });
      noiseBurst(ctx, out, 0.001, 0.09, { type: 'white', filter: 'bandpass', freq: 2600, q: 0.5, gain: 0.7, attack: 0.0008, decay: 0.08, shaper: { type: 'hard', amount: 0.65 } });
      // 2. the descending "zap" — electric, tonal
      tone(ctx, out, 0, 0.28, { wave: W.pulse16(ctx), freq: 2400, freqEnd: 200, gain: 0.3, attack: 0.001, decay: 0.24 });
      // 3. the rumble — huge, long, dark
      const rum = noiseBed(ctx, out, 0.01, 1.9, { type: 'brown', filter: 'lowpass', hz: 130, q: 1.6, gain: 0, seed: 88 });
      rum.gain.gain.setValueAtTime(0.0001, 0.01);
      rum.gain.gain.exponentialRampToValueAtTime(1.0, 0.09);
      rum.gain.gain.exponentialRampToValueAtTime(0.28, 0.7);
      rum.gain.gain.exponentialRampToValueAtTime(0.0001, 1.85);
      sweep(rum.filter.frequency, 0.01, 200, 62, 1.8);
      tone(ctx, out, 0.01, 1.1, { type: 'sine', freq: 52, freqEnd: 28, gain: 0.6, attack: 0.02, decay: 1.05 });
      // 4. crackle tail
      const cr = noiseBed(ctx, out, 0.04, 1.2, { type: 'velvet', filter: 'bandpass', hz: 3200, q: 2.4, gain: 0, seed: 89 });
      cr.gain.gain.setValueAtTime(0.0001, 0.04);
      cr.gain.gain.exponentialRampToValueAtTime(0.26, 0.1);
      cr.gain.gain.exponentialRampToValueAtTime(0.0001, 1.2);
    },
  },

  /** Star power: a fast, relentlessly cheerful arpeggio. 150 BPM, 6 beats. */
  star_loop: {
    seconds: 2.5, loop: true, loopFade: 0.1, channels: 2, gain: 0.42, normalize: 0.9, maxVoices: 1, send: 0.3,
    build: (ctx, out) => {
      const beat = 0.4;
      const step = beat / 4; // 16ths, 0.1 s
      // E major, rising and falling sixteenths, 24 steps = 2.4 s
      const pattern = [
        'E5', 'G#5', 'B5', 'E6', 'G#6', 'B6', 'E7', 'B6',
        'G#6', 'E6', 'B5', 'G#5', 'F#5', 'A5', 'C#6', 'F#6',
        'A6', 'C#7', 'F#6', 'C#6', 'A5', 'F#5', 'B5', 'E6',
      ];
      const lead = W.lead(ctx);
      pattern.forEach((n, i) => {
        const t = i * step;
        tone(ctx, out, t, step * 1.4, { wave: lead, freq: noteToFreq(n), gain: 0.3, attack: 0.004, decay: step * 1.2 });
        fmHit(ctx, out, t, noteToFreq(n) * 2, { ratio: 3.0, index: 0.8, gain: 0.12, decay: step * 1.6 });
      });
      // pulsing bass every 8th
      for (let i = 0; i < 12; i++) {
        tone(ctx, out, i * (step * 2), 0.16, { wave: W.bass(ctx), freq: noteToFreq(i % 4 < 2 ? 'E2' : 'F#2'), gain: 0.34, attack: 0.004, decay: 0.14 });
      }
      // Sparkle bed. Kept deliberately quiet: an 8 kHz-and-up noise shelf has
      // thousands of bins and will drag the spectral centroid past 12 kHz —
      // audibly, that reads as tape hiss rather than shimmer.
      const sh = noiseBed(ctx, out, 0, 2.5, { type: 'white', filter: 'highpass', hz: 6500, gain: 0.028, seed: 90 });
      am(ctx, sh.gain.gain, 0, 2.5, 10, 0.016);
    },
  },

  /** Bullet Bill: a roaring, distorted rush with a rising whistle on top. */
  bullet_loop: {
    seconds: 2.2, loop: true, loopFade: 0.2, gain: 0.6, normalize: 0.9, maxVoices: 1, send: 0.35,
    build: (ctx, out) => {
      const shaper = makeShaper(ctx, 'soft', 0.7);
      const sg = ctx.createGain(); sg.gain.value = 0.5;
      shaper.connect(sg); sg.connect(out);
      const roar = noiseBed(ctx, shaper, 0, 2.2, { type: 'brown', filter: 'lowpass', hz: 700, q: 1.5, gain: 1.4, seed: 91 });
      am(ctx, roar.filter.frequency, 0, 2.2, 5, 160);
      // low tonal thrust
      for (const [hz, g] of [[58, 0.42], [87, 0.2], [116, 0.12]] as Array<[number, number]>) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
        const gg = ctx.createGain(); gg.gain.value = g;
        o.connect(lp); lp.connect(gg); gg.connect(out);
        o.start(0); o.stop(2.25);
      }
      // whistle
      const wh = noiseBed(ctx, out, 0, 2.2, { type: 'white', filter: 'bandpass', hz: 2200, q: 8, gain: 0.16, seed: 92 });
      am(ctx, wh.filter.frequency, 0, 2.2, 2.5, 420);
      noiseBed(ctx, out, 0, 2.2, { type: 'pink', filter: 'bandpass', hz: 1100, q: 0.8, gain: 0.18, seed: 93 });
    },
  },

  coin: {
    seconds: 0.36, gain: 0.5, normalize: 0.88, maxVoices: 6, pitchVar: 60, gainVar: 0.14, send: 0.24,
    build: (ctx, out) => {
      // the classic two-note ping
      fmHit(ctx, out, 0, noteToFreq('B5'), { ratio: 5.0, index: 1.0, gain: 0.5, decay: 0.09, indexDecay: 0.03 });
      fmHit(ctx, out, 0.065, noteToFreq('E6'), { ratio: 5.0, index: 1.0, gain: 0.5, decay: 0.26, indexDecay: 0.05 });
      metalRing(ctx, out, 0, 1975, [1, 2.7, 5.1], 0.14, 0.22, 0.86);
      noiseBurst(ctx, out, 0, 0.05, { type: 'white', filter: 'highpass', freq: 9000, gain: 0.1, decay: 0.04 });
    },
  },

  trick: {
    seconds: 0.5, gain: 0.55, normalize: 0.88, maxVoices: 4, pitchVar: 180, send: 0.3,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 0.35, { type: 'white', filter: 'bandpass', hz: 1200, q: 1.4, gain: 0, seed: 94 });
      perc(bed.gain.gain, 0, 0.55, 0.006, 0.32);
      sweep(bed.filter.frequency, 0, 1200, 6000, 0.3);
      ['A5', 'C#6', 'E6'].forEach((n, i) => fmHit(ctx, out, i * 0.04, noteToFreq(n), { ratio: 3.5, index: 1.2, gain: 0.24, decay: 0.28 }));
    },
  },

  respawn: {
    seconds: 0.9, gain: 0.6, normalize: 0.9, maxVoices: 2, send: 0.35,
    build: (ctx, out) => {
      // sucked-up-then-dropped: rising whoosh then a settle thump
      const bed = noiseBed(ctx, out, 0, 0.5, { type: 'pink', filter: 'bandpass', hz: 500, q: 1.2, gain: 0, seed: 95 });
      perc(bed.gain.gain, 0, 0.5, 0.03, 0.46);
      sweep(bed.filter.frequency, 0, 500, 4200, 0.45);
      tone(ctx, out, 0, 0.45, { type: 'triangle', freq: 260, freqEnd: 900, gain: 0.24, attack: 0.02, decay: 0.4 });
      tone(ctx, out, 0.52, 0.3, { type: 'sine', freq: 180, freqEnd: 62, gain: 0.7, attack: 0.003, decay: 0.26 });
      noiseBurst(ctx, out, 0.52, 0.14, { type: 'pink', filter: 'lowpass', freq: 1200, freqEnd: 400, gain: 0.3, decay: 0.12 });
    },
  },

  // =========================================================================
  // RACE FLOW / UI
  // =========================================================================

  lap_complete: {
    seconds: 1.0, channels: 2, gain: 0.6, normalize: 0.9, maxVoices: 2, send: 0.3,
    build: (ctx, out) => {
      const brass = W.brass(ctx);
      const beat = 0.16;
      [['D5', 0], ['F#5', 1], ['A5', 2]].forEach(([n, i]) => {
        const t = (i as number) * beat;
        tone(ctx, out, t, 0.34, { wave: brass, freq: noteToFreq(n as string), gain: 0.34, attack: 0.008, decay: 0.3 });
        tone(ctx, out, t, 0.34, { wave: brass, freq: noteToFreq(n as string) / 2, gain: 0.18, attack: 0.01, decay: 0.3 });
      });
      fmHit(ctx, out, beat * 2, noteToFreq('D6'), { ratio: 3.5, index: 1.4, gain: 0.3, decay: 0.55 });
      noiseBurst(ctx, out, 0, 0.06, { type: 'white', filter: 'highpass', freq: 6000, gain: 0.16, decay: 0.05 });
    },
  },

  /** Final lap fanfare — short, bright, and unmistakably "hurry up". */
  final_lap: {
    seconds: 2.0, channels: 2, gain: 0.72, normalize: 0.94, maxVoices: 1, send: 0.35,
    build: (ctx, out) => {
      const brass = W.brass(ctx);
      const beat = 0.15;
      // ascending fanfare in D major with a IV-V-I push
      const line: Array<[string, number, number]> = [
        ['A4', 0, 1], ['D5', 1, 1], ['F#5', 2, 1], ['A5', 3, 2], ['B5', 5, 1], ['D6', 6, 4],
      ];
      for (const [n, at, len] of line) {
        const t = at * beat;
        const d = len * beat;
        tone(ctx, out, t, d + 0.1, { wave: brass, freq: noteToFreq(n), gain: 0.3, attack: 0.01, decay: d });
        tone(ctx, out, t, d + 0.1, { wave: brass, freq: noteToFreq(n) * 1.5, gain: 0.13, attack: 0.012, decay: d });
        tone(ctx, out, t, d + 0.1, { wave: W.bass(ctx), freq: noteToFreq(n) / 4, gain: 0.2, attack: 0.008, decay: d });
      }
      // cymbal swell into the last note
      const cym = noiseBed(ctx, out, 0, 1.9, { type: 'white', filter: 'highpass', hz: 5200, gain: 0, seed: 96 });
      cym.gain.gain.setValueAtTime(0.0001, 0);
      cym.gain.gain.exponentialRampToValueAtTime(0.22, beat * 6);
      cym.gain.gain.exponentialRampToValueAtTime(0.0001, 1.85);
      // timpani
      for (const at of [0, 3, 5, 6]) {
        tone(ctx, out, at * beat, 0.24, { type: 'sine', freq: 110, freqEnd: 72, gain: 0.4, attack: 0.003, decay: 0.2 });
      }
      fmHit(ctx, out, beat * 6, noteToFreq('D7'), { ratio: 3.0, index: 1.6, gain: 0.24, decay: 0.9 });
    },
  },

  countdown_beep_1: {
    seconds: 0.45, channels: 2, gain: 0.6, normalize: 0.9, maxVoices: 2, send: 0.3,
    build: (ctx, out) => {
      tone(ctx, out, 0, 0.3, { wave: W.brass(ctx), freq: noteToFreq('D5'), gain: 0.5, attack: 0.004, decay: 0.26 });
      fmHit(ctx, out, 0, noteToFreq('D6'), { ratio: 4.0, index: 0.9, gain: 0.18, decay: 0.3 });
      noiseBurst(ctx, out, 0, 0.03, { type: 'white', filter: 'highpass', freq: 5000, gain: 0.12, decay: 0.025 });
    },
  },
  countdown_beep_2: {
    seconds: 0.45, channels: 2, gain: 0.62, normalize: 0.9, maxVoices: 2, send: 0.3,
    build: (ctx, out) => {
      tone(ctx, out, 0, 0.3, { wave: W.brass(ctx), freq: noteToFreq('E5'), gain: 0.52, attack: 0.004, decay: 0.26 });
      fmHit(ctx, out, 0, noteToFreq('E6'), { ratio: 4.0, index: 1.1, gain: 0.2, decay: 0.3 });
      noiseBurst(ctx, out, 0, 0.03, { type: 'white', filter: 'highpass', freq: 5600, gain: 0.14, decay: 0.025 });
    },
  },
  countdown_beep_3: {
    seconds: 0.45, channels: 2, gain: 0.65, normalize: 0.9, maxVoices: 2, send: 0.3,
    build: (ctx, out) => {
      tone(ctx, out, 0, 0.3, { wave: W.brass(ctx), freq: noteToFreq('F#5'), gain: 0.55, attack: 0.004, decay: 0.26 });
      fmHit(ctx, out, 0, noteToFreq('F#6'), { ratio: 4.0, index: 1.3, gain: 0.22, decay: 0.3 });
      noiseBurst(ctx, out, 0, 0.03, { type: 'white', filter: 'highpass', freq: 6200, gain: 0.16, decay: 0.025 });
    },
  },

  countdown_go: {
    seconds: 1.3, channels: 2, gain: 0.9, normalize: 0.96, maxVoices: 1, send: 0.4,
    build: (ctx, out) => {
      // bright triad stab + whoosh + a low shove
      for (const n of ['B5', 'D6', 'F#6', 'B6']) {
        tone(ctx, out, 0, 0.7, { wave: W.brass(ctx), freq: noteToFreq(n), gain: 0.3, attack: 0.004, decay: 0.62 });
        fmHit(ctx, out, 0, noteToFreq(n), { ratio: 3.0, index: 1.5, gain: 0.14, decay: 0.8 });
      }
      tone(ctx, out, 0, 0.5, { type: 'sine', freq: 150, freqEnd: 50, gain: 0.85, attack: 0.003, decay: 0.44 });
      const bed = noiseBed(ctx, out, 0, 0.8, { type: 'white', filter: 'bandpass', hz: 700, q: 0.8, gain: 0, seed: 97 });
      perc(bed.gain.gain, 0, 0.5, 0.006, 0.74);
      sweep(bed.filter.frequency, 0, 700, 6500, 0.5);
      noiseBurst(ctx, out, 0, 0.1, { type: 'white', filter: 'highpass', freq: 7000, gain: 0.3, decay: 0.09 });
    },
  },

  finish_1st: {
    seconds: 3.0, channels: 2, gain: 0.8, normalize: 0.95, maxVoices: 1, send: 0.45,
    build: (ctx, out) => {
      const brass = W.brass(ctx);
      const b = 0.19;
      // D major victory fanfare: I - V - I with a sustained tonic chord
      const melody: Array<[string, number, number]> = [
        ['D5', 0, 1], ['D5', 1, 0.5], ['D5', 1.5, 0.5], ['F#5', 2, 1], ['A5', 3, 1.5],
        ['G5', 4.5, 0.5], ['A5', 5, 3],
      ];
      for (const [n, at, len] of melody) {
        const t = at * b;
        const d = len * b;
        tone(ctx, out, t, d + 0.12, { wave: brass, freq: noteToFreq(n), gain: 0.3, attack: 0.01, decay: d });
        tone(ctx, out, t, d + 0.12, { wave: brass, freq: noteToFreq(n) * 1.2599, gain: 0.13, attack: 0.014, decay: d });
      }
      // bass movement
      for (const [n, at, len] of [['D3', 0, 2], ['A2', 2, 2], ['D3', 4, 1], ['A2', 5, 3]] as Array<[string, number, number]>) {
        tone(ctx, out, at * b, len * b + 0.1, { wave: W.bass(ctx), freq: noteToFreq(n), gain: 0.32, attack: 0.008, decay: len * b });
      }
      // bells on the resolution
      ['D6', 'F#6', 'A6', 'D7'].forEach((n, i) =>
        fmHit(ctx, out, 5 * b + i * 0.05, noteToFreq(n), { ratio: 3.5, index: 1.5, gain: 0.2, decay: 1.4 }));
      // timpani roll + crash
      for (let i = 0; i < 8; i++) {
        tone(ctx, out, i * b * 0.5, 0.16, { type: 'sine', freq: 98, freqEnd: 70, gain: 0.18 + i * 0.02, attack: 0.003, decay: 0.13 });
      }
      const cr = noiseBed(ctx, out, 5 * b, 1.6, { type: 'white', filter: 'highpass', hz: 4200, gain: 0, seed: 98 });
      perc(cr.gain.gain, 5 * b, 0.26, 0.006, 1.5);
    },
  },

  finish_other: {
    seconds: 2.0, channels: 2, gain: 0.65, normalize: 0.92, maxVoices: 1, send: 0.4,
    build: (ctx, out) => {
      const brass = W.brass(ctx);
      const b = 0.2;
      // neutral, slightly flat-footed cadence — not a punishment, not a win
      const melody: Array<[string, number, number]> = [
        ['A4', 0, 1], ['B4', 1, 1], ['D5', 2, 1], ['A4', 3, 3],
      ];
      for (const [n, at, len] of melody) {
        tone(ctx, out, at * b, len * b + 0.12, { wave: brass, freq: noteToFreq(n), gain: 0.28, attack: 0.012, decay: len * b });
      }
      for (const [n, at, len] of [['D3', 0, 3], ['G2', 3, 3]] as Array<[string, number, number]>) {
        tone(ctx, out, at * b, len * b + 0.1, { wave: W.bass(ctx), freq: noteToFreq(n), gain: 0.28, attack: 0.01, decay: len * b });
      }
      fmHit(ctx, out, 3 * b, noteToFreq('A5'), { ratio: 3.0, index: 1.1, gain: 0.16, decay: 1.0 });
    },
  },

  position_gain: {
    seconds: 0.4, gain: 0.5, normalize: 0.88, maxVoices: 3, send: 0.2,
    build: (ctx, out) => {
      fmHit(ctx, out, 0, noteToFreq('E6'), { ratio: 4.0, index: 0.9, gain: 0.4, decay: 0.1, indexDecay: 0.03 });
      fmHit(ctx, out, 0.07, noteToFreq('B6'), { ratio: 4.0, index: 0.9, gain: 0.42, decay: 0.28, indexDecay: 0.05 });
      noiseBurst(ctx, out, 0, 0.12, { type: 'white', filter: 'highpass', freq: 8000, gain: 0.1, decay: 0.1 });
    },
  },
  position_lose: {
    seconds: 0.4, gain: 0.5, normalize: 0.88, maxVoices: 3, send: 0.2,
    build: (ctx, out) => {
      fmHit(ctx, out, 0, noteToFreq('B5'), { ratio: 2.0, index: 1.4, gain: 0.4, decay: 0.1, indexDecay: 0.03 });
      fmHit(ctx, out, 0.07, noteToFreq('E5'), { ratio: 2.0, index: 1.6, gain: 0.42, decay: 0.3, indexDecay: 0.06 });
      tone(ctx, out, 0.07, 0.24, { type: 'sine', freq: 165, freqEnd: 120, gain: 0.2, attack: 0.006, decay: 0.2 });
    },
  },

  ui_move: {
    seconds: 0.16, gain: 0.34, normalize: 0.8, maxVoices: 4, pitchVar: 40, send: 0,
    build: (ctx, out) => {
      fmHit(ctx, out, 0, noteToFreq('A5'), { ratio: 6.0, index: 0.6, gain: 0.45, decay: 0.07, indexDecay: 0.02 });
      noiseBurst(ctx, out, 0, 0.02, { type: 'white', filter: 'bandpass', freq: 4200, q: 1.2, gain: 0.14, decay: 0.016 });
    },
  },
  ui_select: {
    seconds: 0.32, gain: 0.45, normalize: 0.85, maxVoices: 3, send: 0,
    build: (ctx, out) => {
      fmHit(ctx, out, 0, noteToFreq('E6'), { ratio: 4.0, index: 0.8, gain: 0.45, decay: 0.08, indexDecay: 0.02 });
      fmHit(ctx, out, 0.055, noteToFreq('A6'), { ratio: 4.0, index: 0.8, gain: 0.45, decay: 0.22, indexDecay: 0.04 });
      noiseBurst(ctx, out, 0, 0.05, { type: 'white', filter: 'highpass', freq: 7000, gain: 0.1, decay: 0.04 });
    },
  },
  ui_back: {
    seconds: 0.28, gain: 0.42, normalize: 0.85, maxVoices: 3, send: 0,
    build: (ctx, out) => {
      fmHit(ctx, out, 0, noteToFreq('A5'), { ratio: 3.0, index: 1.0, gain: 0.42, decay: 0.08, indexDecay: 0.02 });
      fmHit(ctx, out, 0.05, noteToFreq('D5'), { ratio: 3.0, index: 1.2, gain: 0.4, decay: 0.2, indexDecay: 0.04 });
    },
  },
  ui_start: {
    seconds: 1.0, channels: 2, gain: 0.6, normalize: 0.92, maxVoices: 1, send: 0.2,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 0.6, { type: 'white', filter: 'bandpass', hz: 500, q: 0.9, gain: 0, seed: 99 });
      perc(bed.gain.gain, 0, 0.45, 0.02, 0.55);
      sweep(bed.filter.frequency, 0, 500, 7000, 0.4);
      for (const n of ['D5', 'A5', 'D6', 'F#6']) {
        tone(ctx, out, 0.05, 0.6, { wave: W.brass(ctx), freq: noteToFreq(n), gain: 0.24, attack: 0.008, decay: 0.55 });
      }
      tone(ctx, out, 0.05, 0.3, { type: 'sine', freq: 120, freqEnd: 60, gain: 0.5, attack: 0.004, decay: 0.26 });
    },
  },

  /** Crowd: filtered noise swell with vowel formants so it reads as *people*.
   *  Random velvet-noise bursts on top are the claps. */
  crowd_cheer: {
    seconds: 2.8, channels: 2, gain: 0.5, normalize: 0.88, maxVoices: 2, send: 0.5,
    build: (ctx, out) => {
      const swell = (vowel: 'a' | 'e' | 'i' | 'o', delay: number, g: number, seed: number) => {
        const fb = formantBank(ctx, VOWEL_FORMANTS[vowel]);
        const bed = noiseBed(ctx, fb.input, delay, 2.6 - delay, { type: 'pink', filter: 'bandpass', hz: 900, q: 0.5, gain: 0, seed });
        bed.gain.gain.setValueAtTime(0.0001, delay);
        bed.gain.gain.exponentialRampToValueAtTime(1.4, delay + 0.35);
        bed.gain.gain.exponentialRampToValueAtTime(0.5, delay + 1.3);
        bed.gain.gain.exponentialRampToValueAtTime(0.0001, 2.7);
        const og = ctx.createGain(); og.gain.value = g;
        fb.output.connect(og); og.connect(out);
        // slow formant drift = a crowd, not a choir holding one chord
        for (const f of fb.filters) {
          const base = f.frequency.value;
          f.frequency.setValueAtTime(base * 0.9, delay);
          f.frequency.linearRampToValueAtTime(base * 1.12, delay + 1.4);
          f.frequency.linearRampToValueAtTime(base * 0.95, 2.7);
        }
        return og;
      };
      swell('a', 0.0, 0.5, 111);
      swell('e', 0.12, 0.34, 112);
      swell('o', 0.06, 0.28, 113);
      swell('i', 0.2, 0.16, 114);
      // applause
      const clap = noiseBed(ctx, out, 0.05, 2.6, { type: 'velvet', filter: 'bandpass', hz: 1900, q: 1.1, gain: 0, seed: 115 });
      clap.gain.gain.setValueAtTime(0.0001, 0.05);
      clap.gain.gain.exponentialRampToValueAtTime(0.4, 0.4);
      clap.gain.gain.exponentialRampToValueAtTime(0.14, 1.6);
      clap.gain.gain.exponentialRampToValueAtTime(0.0001, 2.65);
      am(ctx, clap.gain.gain, 0.05, 2.6, 7.3, 0.09);
      // low body of a big crowd
      const low = noiseBed(ctx, out, 0, 2.7, { type: 'brown', filter: 'lowpass', hz: 240, gain: 0, seed: 116 });
      perc(low.gain.gain, 0, 0.3, 0.4, 2.2);
    },
  },

  /** A standalone wind loop for anyone who wants to `play('wind_loop')`.
   *  The real speed-driven layer is `WindLayer` in Reverb.ts. */
  wind_loop: {
    seconds: 2.65, loop: true, loopFade: 0.15, channels: 2, gain: 0.34, normalize: 0.8, maxVoices: 1, send: 0.15,
    build: (ctx, out) => {
      const bed = noiseBed(ctx, out, 0, 2.65, { type: 'pink', filter: 'bandpass', hz: 900, q: 0.5, gain: 0.8, seed: 121 });
      am(ctx, bed.filter.frequency, 0, 2.65, 0.755, 420);
      am(ctx, bed.gain.gain, 0, 2.65, 1.51, 0.25);
      noiseBed(ctx, out, 0, 2.65, { type: 'brown', filter: 'lowpass', hz: 300, gain: 0.35, seed: 122 });
      const wh = noiseBed(ctx, out, 0, 2.65, { type: 'white', filter: 'bandpass', hz: 3400, q: 6, gain: 0.08, seed: 123 });
      am(ctx, wh.filter.frequency, 0, 2.65, 0.377, 900);
    },
  },

  // =========================================================================
  // ITEMS — second pass. These exist because the item system asks for them by
  // name and nothing already in the bank was a musically honest substitute.
  // =========================================================================

  /** Placing a banana: a soft rubbery slap on tarmac, no metal, no sparkle.
   *  Two combs at ~7 ms give the little hollow "bok" that rubber has. */
  banana_place: {
    seconds: 0.3, gain: 0.62, normalize: 0.8, maxVoices: 3, pitchVar: 140, gainVar: 0.16, send: 0.22,
    build: (ctx, out) => {
      const body = comb(ctx, 0.0071, 0.55, 2600);
      body.output.connect(out);
      noiseBurst(ctx, body.input, 0, 0.07, {
        type: 'pink', filter: 'lowpass', freq: 1500, freqEnd: 420, gain: 0.9, attack: 0.001, decay: 0.06,
      });
      // Rubber has almost no HF: a tiny tick only, then a low thud.
      noiseBurst(ctx, out, 0, 0.02, { type: 'white', filter: 'highpass', freq: 4200, gain: 0.1, decay: 0.016 });
      tone(ctx, out, 0, 0.16, { type: 'sine', freq: 190, freqEnd: 96, gain: 0.55, attack: 0.002, decay: 0.14 });
      tone(ctx, out, 0.004, 0.1, { type: 'triangle', freq: 330, freqEnd: 210, gain: 0.16, attack: 0.002, decay: 0.09 });
    },
  },

  /** Throwing a bomb: an underhand whoosh with the fuse hissing on top. The
   *  band-pass sweeping up then down is what reads as "past the camera". */
  bomb_toss: {
    seconds: 0.62, gain: 0.7, normalize: 0.86, maxVoices: 3, pitchVar: 110, gainVar: 0.12, send: 0.4,
    build: (ctx, out) => {
      const w = noiseBed(ctx, out, 0, 0.5, { type: 'pink', filter: 'bandpass', hz: 500, q: 1.5, gain: 0, seed: 141 });
      multiSweep(w.filter.frequency, 0, [[0, 420], [0.16, 1750], [0.46, 620]]);
      multiSweep(w.gain.gain, 0, [[0, 0.02], [0.1, 0.85], [0.34, 0.5], [0.5, 0.02]]);
      // Fuse: velvet noise through a tight high band = irregular sparking.
      const fuse = noiseBed(ctx, out, 0.03, 0.55, { type: 'velvet', filter: 'bandpass', hz: 5200, q: 5, gain: 0, seed: 142 });
      multiSweep(fuse.gain.gain, 0.03, [[0, 0.0], [0.06, 0.3], [0.5, 0.14]]);
      am(ctx, fuse.gain.gain, 0.03, 0.55, 17, 0.09);
      // Body of the casing leaving the hand.
      tone(ctx, out, 0, 0.2, { type: 'triangle', freq: 150, freqEnd: 92, gain: 0.3, attack: 0.004, decay: 0.18 });
    },
  },

  /** Ghost item: a vowel-morphing moan. Sliding the formant bank from 'u' to
   *  'o' to 'a' is what makes filtered noise read as a *voice*. */
  ghost_laugh: {
    seconds: 1.15, gain: 0.6, normalize: 0.82, maxVoices: 2, pitchVar: 70, gainVar: 0.1, send: 0.62,
    build: (ctx, out) => {
      const fb = formantBank(ctx, VOWEL_FORMANTS.u);
      fb.output.connect(out);
      // Glottal source: a detuned pulse pair, wobbling.
      const g1 = tone(ctx, fb.input, 0, 1.0, {
        wave: W.odd9(ctx), freq: 176, freqEnd: 132, gain: 0.5, attack: 0.09, decay: 0.9,
      });
      const g2 = tone(ctx, fb.input, 0.02, 0.98, {
        type: 'sawtooth', freq: 178, detune: -14, freqEnd: 130, gain: 0.2, attack: 0.12, decay: 0.85,
      });
      void g1; void g2;
      // Morph the formants: u -> o -> a. Three cackling swells on the way.
      const [f1, f2, f3] = fb.filters;
      multiSweep(f1.frequency, 0, [[0, 300], [0.35, 570], [0.85, 730]]);
      multiSweep(f2.frequency, 0, [[0, 870], [0.35, 840], [0.85, 1090]]);
      multiSweep(f3.frequency, 0, [[0, 2240], [0.85, 2440]]);
      am(ctx, fb.output.gain, 0, 1.1, 6.2, 0.35);
      // Breath so it isn't a pure tone.
      const air = noiseBed(ctx, fb.input, 0, 1.0, { type: 'pink', filter: 'bandpass', hz: 1100, q: 1.4, gain: 0, seed: 143 });
      multiSweep(air.gain.gain, 0, [[0, 0.0], [0.2, 0.16], [1.0, 0.02]]);
    },
  },

  /** Squid ink: a wet splat. The trick is a very fast down-sweep on a lowpass
   *  over brown noise — that descending "gloop" is the whole gag. */
  ink_splat: {
    seconds: 0.55, gain: 0.75, normalize: 0.9, maxVoices: 3, pitchVar: 160, gainVar: 0.14, send: 0.3,
    build: (ctx, out) => {
      const wet = noiseBed(ctx, out, 0, 0.4, { type: 'brown', filter: 'lowpass', hz: 3800, q: 3.6, gain: 0, seed: 144 });
      multiSweep(wet.filter.frequency, 0, [[0, 4200], [0.09, 900], [0.35, 260]]);
      multiSweep(wet.gain.gain, 0, [[0, 0.9], [0.12, 0.7], [0.4, 0.02]]);
      // The impact itself.
      noiseBurst(ctx, out, 0, 0.05, {
        type: 'white', filter: 'bandpass', freq: 2600, freqEnd: 700, q: 0.8, gain: 0.55, attack: 0.001, decay: 0.045,
        shaper: { type: 'soft', amount: 0.3 },
      });
      // Descending "bloop" pitch: a squelch, not a hit.
      tone(ctx, out, 0.005, 0.3, { type: 'sine', freq: 520, freqEnd: 74, gain: 0.6, attack: 0.003, decay: 0.26 });
      // Dribbles.
      for (let i = 0; i < 5; i++) {
        const t = 0.14 + i * 0.055;
        noiseBurst(ctx, out, t, 0.05, {
          type: 'white', filter: 'bandpass', freq: 1600 - i * 180, q: 3, gain: 0.1 - i * 0.014,
          decay: 0.04, seed: 150 + i,
        });
      }
    },
  },

  /** Grabbing a star: a fast rising major arpeggio in FM bells, plus a shimmer
   *  sweep. Deliberately brighter than `item_get` so invincibility reads. */
  star_pickup: {
    seconds: 0.8, gain: 0.8, normalize: 0.9, maxVoices: 2, pitchVar: 25, send: 0.4,
    build: (ctx, out) => {
      const notes = [0, 4, 7, 12, 16, 19, 24];
      for (let i = 0; i < notes.length; i++) {
        const t = i * 0.042;
        const hz = noteToFreq('C5') * Math.pow(2, notes[i] / 12);
        fmHit(ctx, out, t, hz, { ratio: 3.01, index: 2.6, gain: 0.34, decay: 0.34, indexDecay: 0.08 });
        blip(ctx, out, t, hz * 2, 0.07, 0.1, W.bell(ctx));
      }
      // Shimmer riding up behind the arpeggio.
      noiseBurst(ctx, out, 0, 0.6, {
        type: 'white', filter: 'bandpass', freq: 3200, freqEnd: 12000, q: 1.4, gain: 0.16, attack: 0.05, decay: 0.55,
      });
      tone(ctx, out, 0, 0.5, { type: 'sine', freq: 130, freqEnd: 262, gain: 0.22, attack: 0.01, decay: 0.45 });
    },
  },

  /** Any timed power expiring — star, bullet, mega. A downward two-note fall
   *  with the brightness collapsing: the mirror image of `star_pickup`. */
  power_down: {
    seconds: 0.6, gain: 0.6, normalize: 0.82, maxVoices: 3, pitchVar: 40, send: 0.3,
    build: (ctx, out) => {
      const notes = [12, 7, 3, 0];
      for (let i = 0; i < notes.length; i++) {
        const t = i * 0.055;
        const hz = noteToFreq('C5') * Math.pow(2, notes[i] / 12);
        fmHit(ctx, out, t, hz, { ratio: 2.0, index: 1.5, gain: 0.3 - i * 0.03, decay: 0.26, indexDecay: 0.1 });
      }
      // Air bleeding out.
      noiseBurst(ctx, out, 0.02, 0.4, {
        type: 'pink', filter: 'lowpass', freq: 6000, freqEnd: 700, gain: 0.2, attack: 0.01, decay: 0.38,
      });
      tone(ctx, out, 0.0, 0.35, { type: 'triangle', freq: 220, freqEnd: 82, gain: 0.26, attack: 0.006, decay: 0.32 });
    },
  },

  /** Bullet Bill launch: a cannon-ish thud, then a hard doppler pass. The
   *  down-sweep after the peak is the "past you" cue. */
  bullet_launch: {
    seconds: 0.9, gain: 0.85, normalize: 0.94, maxVoices: 2, pitchVar: 60, gainVar: 0.1, send: 0.5,
    build: (ctx, out) => {
      // Launch thump. The swept sine gives the "drop", the fixed 48 Hz layer
      // gives the sub-100 Hz weight a cannon actually has.
      tone(ctx, out, 0, 0.34, { type: 'sine', freq: 110, freqEnd: 38, gain: 0.9, attack: 0.002, decay: 0.3 });
      tone(ctx, out, 0, 0.45, { type: 'sine', freq: 48, gain: 1.0, attack: 0.005, decay: 0.4 });
      noiseBurst(ctx, out, 0, 0.13, {
        type: 'brown', filter: 'lowpass', freq: 900, freqEnd: 180, gain: 0.5, attack: 0.001, decay: 0.12,
        shaper: { type: 'hard', amount: 0.45 },
      });
      noiseBurst(ctx, out, 0, 0.05, { type: 'white', filter: 'highpass', freq: 3800, gain: 0.18, decay: 0.04 });
      // Doppler pass: band sweeps up into the listener and away again.
      const pass = noiseBed(ctx, out, 0.05, 0.75, { type: 'pink', filter: 'bandpass', hz: 600, q: 1.1, gain: 0, seed: 145 });
      multiSweep(pass.filter.frequency, 0.05, [[0, 520], [0.22, 2400], [0.7, 460]]);
      multiSweep(pass.gain.gain, 0.05, [[0, 0.02], [0.2, 0.6], [0.42, 0.4], [0.75, 0.02]]);
      // Metallic body of the shell, pitch-bending through the pass.
      tone(ctx, out, 0.05, 0.6, { wave: W.brass(ctx), freq: 330, freqEnd: 165, gain: 0.2, attack: 0.03, decay: 0.55 });
    },
  },

  /** Blue-shell launch: heavier and more ominous than a green shell. Rising
   *  minor-third siren over a big sub whoomph. */
  blue_shell_launch: {
    seconds: 1.0, gain: 0.85, normalize: 0.94, maxVoices: 2, pitchVar: 30, send: 0.55,
    build: (ctx, out) => {
      tone(ctx, out, 0, 0.4, { type: 'sine', freq: 105, freqEnd: 36, gain: 0.85, attack: 0.003, decay: 0.36 });
      // The dread comes from the bottom, so the sub layer is the loudest thing
      // in the bake and everything bright sits well underneath it.
      tone(ctx, out, 0, 0.55, { type: 'sine', freq: 46, gain: 1.0, attack: 0.006, decay: 0.5 });
      noiseBurst(ctx, out, 0, 0.5, {
        type: 'pink', filter: 'bandpass', freq: 700, freqEnd: 2600, q: 0.9, gain: 0.2, attack: 0.02, decay: 0.46,
      });
      // The dread: two detuned saws rising a minor third.
      const base = noteToFreq('A3');
      tone(ctx, out, 0.02, 0.8, { type: 'sawtooth', freq: base, freqEnd: base * Math.pow(2, 3 / 12), gain: 0.24, attack: 0.05, decay: 0.72 });
      tone(ctx, out, 0.02, 0.8, { type: 'sawtooth', freq: base, detune: CENTS(0.11), freqEnd: base * Math.pow(2, 3 / 12), gain: 0.2, attack: 0.06, decay: 0.72 });
      metalRing(ctx, out, 0.0, 240, [1, 2.42, 3.77, 5.1], 0.2, 0.7, 0.9);
      noiseBurst(ctx, out, 0.0, 0.06, { type: 'white', filter: 'highpass', freq: 5200, gain: 0.09, decay: 0.05 });
    },
  },
};

/** Alias ids so callers can use either the generic or numbered form. */
/**
 * Every id any other subsystem is known to ask for, mapped onto a real bake.
 *
 * Sister subsystems were authored independently and call `play()` with their own
 * vocabulary ('mushroom', 'ui_lap', 'shell_red'). Rather than force twelve
 * agents to converge on one naming scheme, the bank resolves their names here.
 * Anything left unresolved warns exactly once and is silently dropped.
 */
const ALIASES: Record<string, string> = {
  // --- historic / generic --------------------------------------------------
  countdown_beep: 'countdown_beep_1',
  roll_boost: 'roll_asphalt',
  roll_glider: 'roll_asphalt',
  roll_offroad: 'roll_dirt',
  roll_void: 'silence',
  land: 'land_soft',
  drift_charge: 'drift_charge_blue',
  explosion_big: 'explosion',

  // --- ItemSystem vocabulary ---------------------------------------------
  mushroom: 'boost_release',
  shell_green: 'shell_fire',
  shell_red: 'shell_fire',
  blue_launch: 'blue_shell_launch',
  bomb_throw: 'bomb_toss',
  banana_drop: 'banana_place',
  boo: 'ghost_laugh',
  squid: 'ink_splat',
  lightning: 'lightning_strike',
  star_start: 'star_pickup',
  star_end: 'power_down',
  star_hit: 'kart_bump',
  bullet_start: 'bullet_launch',
  bullet_end: 'power_down',
  item_hold: 'ui_move',
  item_hit: 'shell_hit',

  // --- HUD / results vocabulary ------------------------------------------
  ui_lap: 'lap_complete',
  ui_final_lap: 'final_lap',
  ui_banner: 'ui_select',
  ui_go: 'countdown_go',
  ui_beep: 'countdown_beep_1',
  ui_overtake: 'position_gain',
  ui_overtaken: 'position_lose',
  ui_page: 'ui_move',
  ui_win: 'finish_1st',
  ui_results: 'ui_select',
  ui_result_row: 'ui_move',
  ui_result_player: 'position_gain',
  blue_shell_alarm_end: 'silence',
};

/**
 * Yield to the event loop without being throttled.
 *
 * `setTimeout(0)` is clamped to roughly one second in a backgrounded tab, which
 * turned a 0.7 s bake into a 15 s one and tripped the caller's watchdog. A
 * MessageChannel message is a macrotask — it still lets the renderer breathe
 * between batches, but browsers do not throttle it.
 */
const yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
function yieldToEventLoop(): Promise<void> {
  if (!yieldChannel) return new Promise<void>((r) => setTimeout(r, 0));
  return new Promise<void>((resolve) => {
    yieldChannel.port1.onmessage = () => { yieldChannel.port1.onmessage = null; resolve(); };
    yieldChannel.port2.postMessage(0);
  });
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

interface VoiceNodes {
  src: AudioBufferSourceNode;
  gain: GainNode;
  panner: PannerNode | null;
  lp: BiquadFilterNode | null;
  send: GainNode | null;
}

class SfxVoice implements SfxHandle {
  readonly id: string;
  active = true;
  readonly startedAt: number;
  private ctx: BaseAudioContext;
  private n: VoiceNodes;
  private baseGain: number;
  private onEnd: (v: SfxVoice) => void;

  constructor(
    ctx: BaseAudioContext,
    id: string,
    nodes: VoiceNodes,
    baseGain: number,
    onEnd: (v: SfxVoice) => void,
  ) {
    this.ctx = ctx;
    this.id = id;
    this.n = nodes;
    this.baseGain = baseGain;
    this.startedAt = ctx.currentTime;
    this.onEnd = onEnd;
    nodes.src.onended = () => this.release();
  }

  setVolume(v: number, seconds = 0.04): void {
    if (!this.active) return;
    const t = this.ctx.currentTime;
    const g = this.n.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.max(0, v) * this.baseGain, t + Math.max(0.005, seconds));
  }

  setRate(v: number, seconds = 0.06): void {
    if (!this.active) return;
    const t = this.ctx.currentTime;
    const p = this.n.src.playbackRate;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(clamp(v, 0.05, 6), t + Math.max(0.005, seconds));
  }

  setFilter(hz: number, q = 0.9, seconds = 0.06): void {
    if (!this.active || !this.n.lp) return;
    const t = this.ctx.currentTime;
    const f = this.n.lp.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.exponentialRampToValueAtTime(clamp(hz, 40, 20000), t + Math.max(0.005, seconds));
    this.n.lp.Q.setTargetAtTime(clamp(q, 0.0001, 20), t, 0.05);
  }

  setPosition(p: THREE.Vector3): void {
    const pan = this.n.panner;
    if (!this.active || !pan) return;
    pan.positionX.value = p.x;
    pan.positionY.value = p.y;
    pan.positionZ.value = p.z;
  }

  stop(fadeSeconds = 0.06): void {
    if (!this.active) return;
    const t = this.ctx.currentTime;
    const g = this.n.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.0001, t + Math.max(0.005, fadeSeconds));
    try { this.n.src.stop(t + Math.max(0.006, fadeSeconds) + 0.01); } catch { /* noop */ }
  }

  /** Tear down and unlink. Called from `onended`. */
  release(): void {
    if (!this.active) return;
    this.active = false;
    const n = this.n;
    n.src.onended = null;
    try { n.src.stop(); } catch { /* already stopped */ }
    for (const node of [n.src, n.gain, n.panner, n.lp, n.send]) {
      if (node) { try { node.disconnect(); } catch { /* noop */ } }
    }
    this.onEnd(this);
  }
}

// ---------------------------------------------------------------------------
// The bank
// ---------------------------------------------------------------------------

export interface SfxBankOptions {
  /** Dry destination — the sfx bus. */
  dest: AudioNode;
  /** Reverb send input; sounds tap this according to their `send` amount. */
  reverbSend?: AudioNode;
  /** Hard cap on simultaneously playing voices across all ids. */
  maxTotalVoices?: number;
}

export class SfxBank {
  private ctx: BaseAudioContext;
  private dest: AudioNode;
  private sendTap: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private live = new Map<string, SfxVoice[]>();
  private total = 0;
  private maxTotal: number;
  private rng = new Rand(0xa11ce);
  private listener = { x: 0, y: 0, z: 0 };
  private ready = false;

  constructor(ctx: BaseAudioContext, o: SfxBankOptions) {
    this.ctx = ctx;
    this.dest = o.dest;
    this.maxTotal = o.maxTotalVoices ?? 44;
    if (o.reverbSend) {
      this.sendTap = ctx.createGain();
      this.sendTap.gain.value = 1;
      this.sendTap.connect(o.reverbSend);
    }
  }

  /** All ids the bank can play (excluding aliases). */
  static ids(): string[] { return Object.keys(SPECS); }
  static aliasIds(): string[] { return Object.keys(ALIASES); }

  get isReady(): boolean { return this.ready; }
  get voiceCount(): number { return this.total; }

  /**
   * Bake every sound. Renders in small concurrent batches so a slow machine
   * doesn't stall the main thread for a second in one go.
   */
  async init(onProgress?: (done: number, total: number, id: string) => void): Promise<void> {
    const ids = Object.keys(SPECS);
    const sr = this.ctx.sampleRate;
    const BATCH = 6;
    let done = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      await Promise.all(slice.map(async (id) => {
        const spec = SPECS[id];
        try {
          let buf = await renderOffline(sr, spec.channels ?? 1, spec.seconds, (octx, out) => {
            spec.build(octx, out, sr);
          });
          if (spec.loop) {
            buf = makeSeamlessLoop(this.ctx, buf, spec.loopFade ?? 0.12);
          } else {
            fadeEdges(buf, spec.edgeFade ?? 0.003);
          }
          // Normalise LAST. The seamless-loop crossfade sums the head and tail
          // of the render, which can push a peak-normalised buffer back over
          // 1.0 — measured at +0.7 dBFS on the alarm and bullet loops before
          // this ordering was fixed.
          if (spec.normalize && spec.normalize > 0) normalizeBuffer(buf, spec.normalize);
          this.buffers.set(id, buf);
        } catch (err) {
          console.error(`[SfxBank] failed to bake "${id}":`, err);
        }
        done++;
        onProgress?.(done, ids.length, id);
      }));
      // Yield to the event loop between batches.
      await yieldToEventLoop();
    }
    this.ready = true;
  }

  setListenerPosition(x: number, y: number, z: number): void {
    this.listener.x = x; this.listener.y = y; this.listener.z = z;
  }

  /** Global reverb-send trim for all sfx. */
  setSendLevel(v: number): void {
    if (this.sendTap) this.sendTap.gain.value = clamp(v, 0, 2);
  }

  resolve(id: string): string { return ALIASES[id] ?? id; }

  has(id: string): boolean { return this.buffers.has(this.resolve(id)); }
  buffer(id: string): AudioBuffer | undefined { return this.buffers.get(this.resolve(id)); }
  spec(id: string): SfxSpec | undefined { return SPECS[this.resolve(id)]; }

  /**
   * Fire a sound. Returns a handle for loops (or null if the id is unknown or
   * every voice slot is taken by something more recent).
   */
  play(id: string, opts: SfxPlayOptions = {}): SfxHandle | null {
    const key = this.resolve(id);
    const spec = SPECS[key];
    const buf = this.buffers.get(key);
    if (!spec || !buf) {
      if (this.ready) console.warn(`[SfxBank] unknown sfx "${id}"`);
      return null;
    }
    const loop = opts.loop ?? spec.loop ?? false;

    // --- voice limiting ----------------------------------------------------
    let list = this.live.get(key);
    if (!list) { list = []; this.live.set(key, list); }
    const maxVoices = spec.maxVoices ?? 4;
    while (list.length >= maxVoices) {
      const oldest = list[0];
      oldest.release();
      if (this.live.get(key) === list && list[0] === oldest) list.shift();
    }
    if (this.total >= this.maxTotal) {
      // Global pressure: steal the oldest voice anywhere.
      let victim: SfxVoice | null = null;
      for (const arr of this.live.values()) {
        for (const v of arr) if (!victim || v.startedAt < victim.startedAt) victim = v;
      }
      if (victim) victim.release();
      if (this.total >= this.maxTotal) return null;
    }

    // --- graph -------------------------------------------------------------
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t0 = now + Math.max(0, opts.delay ?? 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    if (loop) { src.loopStart = 0; src.loopEnd = buf.duration; }

    const pitchVar = spec.pitchVar ?? 0;
    if (pitchVar > 0) src.detune.value = this.rng.bi() * pitchVar;
    if (opts.rate !== undefined) src.playbackRate.value = clamp(opts.rate, 0.05, 6);

    const gainNode = ctx.createGain();
    const gainVar = spec.gainVar ?? 0;
    const specGain = spec.gain ?? 1;
    const varFactor = gainVar > 0 ? 1 + this.rng.bi() * gainVar : 1;
    const base = specGain * varFactor;
    const target = base * (opts.volume ?? 1);

    const fadeIn = opts.fadeIn ?? (loop ? 0.06 : 0);
    if (fadeIn > 0) {
      gainNode.gain.setValueAtTime(0.0001, t0);
      gainNode.gain.linearRampToValueAtTime(target, t0 + fadeIn);
    } else {
      gainNode.gain.value = target;
    }

    // Positional chain: panner (+ distance-driven air absorption for one-shots)
    let panner: PannerNode | null = null;
    let lp: BiquadFilterNode | null = null;
    let head: AudioNode = gainNode;
    src.connect(gainNode);

    if (loop) {
      lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 20000;
      lp.Q.value = 0.9;
      head.connect(lp);
      head = lp;
    }

    if (opts.position) {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 9;
      panner.maxDistance = 420;
      panner.rolloffFactor = 1.15;
      panner.positionX.value = opts.position.x;
      panner.positionY.value = opts.position.y;
      panner.positionZ.value = opts.position.z;
      if (!lp) {
        // Static air absorption from the spawn distance: distant hits are dull.
        const dx = opts.position.x - this.listener.x;
        const dy = opts.position.y - this.listener.y;
        const dz = opts.position.z - this.listener.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 14) {
          lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = clamp(20000 * Math.pow(0.5, (dist - 14) / 55), 700, 20000);
          lp.Q.value = 0.6;
          head.connect(lp);
          head = lp;
        }
      }
      head.connect(panner);
      head = panner;
    }

    head.connect(this.dest);

    let send: GainNode | null = null;
    const sendAmt = spec.send ?? 0.25;
    if (this.sendTap && sendAmt > 0.001) {
      send = ctx.createGain();
      send.gain.value = sendAmt;
      head.connect(send);
      send.connect(this.sendTap);
    }

    const voice = new SfxVoice(ctx, key, { src, gain: gainNode, panner, lp, send }, base, (v) => {
      const arr = this.live.get(v.id);
      if (arr) {
        const i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1);
      }
      this.total = Math.max(0, this.total - 1);
    });

    list.push(voice);
    this.total++;
    src.start(t0);
    if (!loop) {
      // Safety net: some engines don't fire `onended` reliably for very short
      // buffers, so schedule an explicit stop just past the tail.
      try { src.stop(t0 + buf.duration + 0.05); } catch { /* noop */ }
    }
    return voice;
  }

  /** Convenience: start (or return the existing) singleton loop for an id. */
  private singletons = new Map<string, SfxHandle>();

  loop(id: string, opts: SfxPlayOptions = {}): SfxHandle | null {
    const key = this.resolve(id);
    const existing = this.singletons.get(key);
    if (existing && existing.active) return existing;
    const h = this.play(key, { ...opts, loop: true });
    if (h) this.singletons.set(key, h);
    return h;
  }

  stopLoop(id: string, fade = 0.12): void {
    const key = this.resolve(id);
    const h = this.singletons.get(key);
    if (h) { h.stop(fade); this.singletons.delete(key); }
  }

  stopAll(fade = 0.05): void {
    for (const arr of [...this.live.values()]) for (const v of [...arr]) v.stop(fade);
    this.singletons.clear();
  }

  /** Objective measurement of every baked buffer — for the dev harness. */
  analyzeAll(): Record<string, BufferStats> {
    const out: Record<string, BufferStats> = {};
    for (const [id, buf] of this.buffers) out[id] = analyzeBuffer(buf);
    return out;
  }

  dispose(): void {
    this.stopAll(0.01);
    this.buffers.clear();
    this.live.clear();
    if (this.sendTap) { try { this.sendTap.disconnect(); } catch { /* noop */ } }
  }
}

/** Exported for the dev harness so it can label sliders. */
export const SFX_IDS: readonly string[] = Object.keys(SPECS);
export const SFX_GROUPS: ReadonlyArray<{ name: string; ids: readonly string[] }> = [
  { name: 'Drift & Boost', ids: ['drift_start', 'drift_loop', 'drift_charge_blue', 'drift_charge_orange', 'drift_charge_purple', 'boost_release', 'boost_pad'] },
  { name: 'Chassis', ids: ['hop', 'land_soft', 'land_hard', 'wall_scrape', 'wall_hit_hard', 'kart_bump', 'offroad_loop', 'respawn', 'trick'] },
  { name: 'Rolling', ids: ['roll_asphalt', 'roll_dirt', 'roll_grass', 'roll_sand', 'roll_water', 'roll_ice', 'roll_metal', 'roll_wood', 'roll_ag', 'silence'] },
  { name: 'Items', ids: ['item_box', 'item_roulette', 'item_get', 'shell_fire', 'shell_bounce', 'shell_hit', 'red_shell_lock', 'blue_shell_alarm', 'explosion', 'banana_slip', 'spin_out', 'squash', 'shrink', 'lightning_strike', 'star_loop', 'bullet_loop', 'coin'] },
  { name: 'Items II', ids: ['banana_place', 'bomb_toss', 'ghost_laugh', 'ink_splat', 'star_pickup', 'power_down', 'bullet_launch', 'blue_shell_launch'] },
  { name: 'Race flow', ids: ['countdown_beep_1', 'countdown_beep_2', 'countdown_beep_3', 'countdown_go', 'lap_complete', 'final_lap', 'finish_1st', 'finish_other', 'position_gain', 'position_lose'] },
  { name: 'UI & ambience', ids: ['ui_move', 'ui_select', 'ui_back', 'ui_start', 'crowd_cheer', 'wind_loop'] },
];

/** Design intent per sound, asserted numerically by the dev harness. */
export interface SfxExpectation {
  /** Expected spectral-centroid window, Hz. */
  centroid?: [number, number];
  /** Minimum fraction of energy below 100 Hz. */
  minSub?: number;
  /** Minimum fraction of energy above 6 kHz. */
  minHigh?: number;
  /** Expected envelope length window, seconds. */
  envelope?: [number, number];
}

export const SFX_EXPECTATIONS: Record<string, SfxExpectation> = {
  explosion: { minSub: 0.25, centroid: [150, 2600], envelope: [1.0, 2.0] },
  lightning_strike: { minSub: 0.20, centroid: [150, 4000], envelope: [1.2, 2.2] },
  land_hard: { minSub: 0.15, centroid: [100, 2600], envelope: [0.25, 0.72] },
  wall_hit_hard: { minSub: 0.10, centroid: [150, 3600] },
  boost_release: { centroid: [400, 5000], envelope: [0.5, 1.12] },
  drift_charge_blue: { centroid: [900, 7000] },
  drift_charge_orange: { centroid: [1200, 9000] },
  drift_charge_purple: { centroid: [900, 9000] },
  roll_ice: { centroid: [1600, 8000] },
  roll_asphalt: { centroid: [180, 2200] },
  // `subEnergy` is the real assertion for the rumble beds: the spectral
  // centroid is magnitude-weighted across ~1000 bins, so any broadband noise
  // shelf pulls it upward even when three quarters of the *energy* is sub-bass.
  offroad_loop: { minSub: 0.45, centroid: [120, 3000] },
  ui_move: { centroid: [1200, 12000], envelope: [0.02, 0.17] },
  coin: { centroid: [1200, 12000], envelope: [0.1, 0.37] },
  blue_shell_alarm: { centroid: [300, 5000] },
  crowd_cheer: { centroid: [300, 4500], envelope: [2.0, 2.85] },
  wind_loop: { centroid: [150, 3000] },
  bullet_loop: { minSub: 0.06, centroid: [80, 2600] },
  // Star power is an arpeggio plus shimmer, so it must be bright — but the
  // shimmer has to stay a garnish, hence the upper bound and the HF floor.
  star_loop: { minHigh: 0.03, centroid: [500, 10500] },
  // Second-pass item sounds.
  banana_place: { centroid: [80, 1800], envelope: [0.1, 0.32] },
  bomb_toss: { centroid: [400, 5200], envelope: [0.35, 0.64] },
  ghost_laugh: { centroid: [200, 2600], envelope: [0.8, 1.18] },
  ink_splat: { centroid: [120, 2600], envelope: [0.25, 0.58] },
  star_pickup: { minHigh: 0.05, centroid: [800, 9000], envelope: [0.4, 0.82] },
  power_down: { centroid: [200, 5000], envelope: [0.3, 0.62] },
  bullet_launch: { minSub: 0.12, centroid: [100, 3200], envelope: [0.5, 0.92] },
  blue_shell_launch: { minSub: 0.10, centroid: [150, 4200], envelope: [0.6, 1.02] },
};

/** Re-exported so the harness can measure hats/HF content thresholds. */
export { analyzeBuffer };
export type { BufferStats };

// Keep the linter honest about intentionally-unused imports that document the
// available palette for future sound work.
void adsr; void ramp; void distortionCurve; void lerp; void CENTS;
