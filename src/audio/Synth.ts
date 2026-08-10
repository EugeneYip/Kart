/**
 * ============================================================================
 *  APEX KART — SYNTH TOOLKIT
 * ============================================================================
 *  Every sound in this game is generated from maths. There are no audio files
 *  and no network requests. This module is the primitive library that the
 *  engine / sfx / music layers are built from:
 *
 *    - noise generators (white, pink via Voss-McCartney, brown, blue, velvet)
 *    - wavetable construction (`PeriodicWave` from harmonic series)
 *    - ADSR / percussive envelope helpers that write to `AudioParam`s
 *    - FM operator pairs, waveshaper distortion curves
 *    - biquad chains, formant banks, comb / allpass, chorus & flange
 *    - an "offline render to AudioBuffer" baker so complex one-shots are
 *      computed ONCE at init and then played back as a single buffer source
 *    - granular / pitch-shifted playback
 *
 *  Design rule: build graphs at BAKE time, never per-shot at runtime.
 * ============================================================================
 */

import { clamp, clamp01, lerp } from '@/core/MathUtils';

// ---------------------------------------------------------------------------
// Deterministic RNG (self-contained so bakes are reproducible)
// ---------------------------------------------------------------------------

export class Rand {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = (seed >>> 0) || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  /** Uniform in [a,b). */
  range(a: number, b: number): number { return a + this.next() * (b - a); }
  /** Uniform in [-1,1). */
  bi(): number { return this.next() * 2 - 1; }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  /** Box-Muller gaussian. */
  gauss(mean = 0, sd = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

// ---------------------------------------------------------------------------
// Musical helpers
// ---------------------------------------------------------------------------

export const A4_HZ = 440;

/** MIDI note number -> Hz. */
export function mtof(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - 69) / 12);
}

const LETTER_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C#4" / "Eb3" / "A4" -> MIDI number (C4 = 60). */
export function noteToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) return 60;
  let semi = LETTER_SEMITONE[m[1].toUpperCase()];
  if (m[2] === '#') semi += 1;
  else if (m[2] === 'b') semi -= 1;
  return semi + (parseInt(m[3], 10) + 1) * 12;
}

export function noteToFreq(name: string): number { return mtof(noteToMidi(name)); }

/** Decibels -> linear gain. */
export function dbToGain(db: number): number { return Math.pow(10, db / 20); }
/** Linear gain -> decibels. */
export function gainToDb(g: number): number { return 20 * Math.log10(Math.max(1e-9, g)); }

// ---------------------------------------------------------------------------
// Noise — raw sample data is cached module-wide so 60 offline bakes don't each
// regenerate a megabyte of pink noise.
// ---------------------------------------------------------------------------

export type NoiseType = 'white' | 'pink' | 'brown' | 'blue' | 'velvet';

const rawNoiseCache = new Map<string, Float32Array<ArrayBuffer>>();

/** Remove DC and normalise to `peak` in place. */
export function normalizeArray(a: Float32Array, peak = 1): Float32Array {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i];
  mean /= Math.max(1, a.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    a[i] -= mean;
    const v = Math.abs(a[i]);
    if (v > max) max = v;
  }
  if (max > 1e-9) {
    const k = peak / max;
    for (let i = 0; i < a.length; i++) a[i] *= k;
  }
  return a;
}

/**
 * Generate `n` samples of noise. Cached by (type,n,seed).
 *
 * Pink noise uses the true Voss-McCartney algorithm: 16 independent random
 * "rows", the k-th of which is re-rolled every 2^k samples. The running sum
 * has a 1/f spectrum by construction.
 */
export function rawNoise(type: NoiseType, n: number, seed = 1): Float32Array<ArrayBuffer> {
  const key = `${type}|${n}|${seed}`;
  const hit = rawNoiseCache.get(key);
  if (hit) return hit;

  const rng = new Rand(seed * 2654435761);
  const out = new Float32Array(n);

  switch (type) {
    case 'white': {
      for (let i = 0; i < n; i++) out[i] = rng.bi();
      break;
    }
    case 'pink': {
      const ROWS = 16;
      const rows = new Float32Array(ROWS);
      let running = 0;
      for (let i = 0; i < ROWS; i++) { rows[i] = rng.bi(); running += rows[i]; }
      for (let i = 0; i < n; i++) {
        // index of the row to update = number of trailing zero bits of i
        let k = 0;
        let m = i;
        if (m !== 0) { while ((m & 1) === 0 && k < ROWS - 1) { m >>= 1; k++; } }
        running -= rows[k];
        rows[k] = rng.bi();
        running += rows[k];
        out[i] = running + rng.bi() * 0.6;
      }
      break;
    }
    case 'brown': {
      let last = 0;
      for (let i = 0; i < n; i++) {
        last = last * 0.9965 + rng.bi() * 0.045;
        out[i] = last;
      }
      break;
    }
    case 'blue': {
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const w = rng.bi();
        out[i] = w - prev;
        prev = w;
      }
      break;
    }
    case 'velvet': {
      // Sparse +/-1 impulses: perceptually "smooth" noise, great for
      // reverb tails, gravel ticks and debris.
      const density = 1400; // impulses per second at 48k
      const step = Math.max(2, Math.floor(48000 / density));
      for (let i = 0; i < n; i += step) {
        const j = i + Math.floor(rng.next() * step);
        if (j < n) out[j] = rng.next() < 0.5 ? -1 : 1;
      }
      break;
    }
  }

  normalizeArray(out, 1);
  rawNoiseCache.set(key, out);
  return out;
}

/** Wrap cached raw noise into an AudioBuffer belonging to `ctx`. */
export function noiseBuffer(
  ctx: BaseAudioContext,
  type: NoiseType,
  seconds: number,
  channels = 1,
  seed = 1,
): AudioBuffer {
  const n = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(channels, n, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    buf.copyToChannel(rawNoise(type, n, seed + c * 977), c);
  }
  return buf;
}

/** A looping noise source, ready to `start()`. */
export function noiseSource(
  ctx: BaseAudioContext,
  type: NoiseType,
  seconds = 2,
  seed = 1,
  channels = 1,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, type, seconds, channels, seed);
  src.loop = true;
  return src;
}

// ---------------------------------------------------------------------------
// Wavetables
// ---------------------------------------------------------------------------

/**
 * Build a PeriodicWave from harmonic amplitudes (index 0 = fundamental).
 * `phases` are optional, in turns [0,1). Randomised phases keep the peak
 * factor low, which means we can run these hotter before the limiter bites.
 */
export function harmonicWave(
  ctx: BaseAudioContext,
  amps: readonly number[],
  phases?: readonly number[],
): PeriodicWave {
  const n = amps.length + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < amps.length; i++) {
    const a = amps[i];
    const p = (phases ? phases[i] : 0.25) * Math.PI * 2;
    real[i + 1] = a * Math.cos(p);
    imag[i + 1] = a * Math.sin(p);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** Harmonic amplitude table generators. */
export const Harmonics = {
  /** 1/n saw-like. */
  saw(n: number, tilt = 1): number[] {
    const a: number[] = [];
    for (let i = 1; i <= n; i++) a.push(1 / Math.pow(i, tilt));
    return a;
  },
  /** Odd harmonics only, 1/n — hollow/clarinet/square-ish. */
  odd(n: number, tilt = 1): number[] {
    const a: number[] = [];
    for (let i = 1; i <= n; i++) a.push(i % 2 === 1 ? 1 / Math.pow(i, tilt) : 0);
    return a;
  },
  /** Band-limited pulse train: all harmonics equal, gently rolled off. */
  pulse(n: number, rolloff = 0.35): number[] {
    const a: number[] = [];
    for (let i = 1; i <= n; i++) a.push(Math.pow(i, -rolloff));
    return a;
  },
  /**
   * Internal-combustion engine spectrum. The waveform repeats once per
   * ENGINE CYCLE (two crank revolutions on a four-stroke), so the fundamental
   * is rpm/120 Hz and the dominant partial sits on the firing order
   * (harmonic index == cylinder count).
   */
  engine(cylinders: number, n = 48, brightness = 1, rasp = 0.35): number[] {
    const a: number[] = [];
    for (let h = 1; h <= n; h++) {
      // Broad resonant peak on the firing harmonic and its multiples.
      const d = Math.abs(h - cylinders) / cylinders;
      const firing = Math.exp(-d * d * 2.4) * 1.0;
      const firing2 = Math.exp(-Math.pow((h - cylinders * 2) / (cylinders * 1.4), 2)) * 0.55;
      const firing3 = Math.exp(-Math.pow((h - cylinders * 3) / (cylinders * 1.9), 2)) * 0.3;
      // Half-order "lumpiness" — what makes a V8 burble.
      const half = h % 2 === 1 ? 0.42 : 0.24;
      const tilt = Math.pow(h, -0.85 / Math.max(0.35, brightness));
      const grit = 1 + rasp * Math.sin(h * 2.3994) * 0.5;
      a.push((firing + firing2 + firing3 + half * 0.5) * tilt * grit);
    }
    return a;
  },
  /** Bright brass: strong low harmonics with a formant bump around h=5..8. */
  brass(n = 24): number[] {
    const a: number[] = [];
    for (let h = 1; h <= n; h++) {
      const bump = Math.exp(-Math.pow((h - 6) / 4.5, 2)) * 0.7;
      a.push((1 / Math.pow(h, 0.9)) * (1 + bump));
    }
    return a;
  },
  /** Bowed strings — dense, slightly detuned-feeling spectrum. */
  strings(n = 32): number[] {
    const a: number[] = [];
    for (let h = 1; h <= n; h++) {
      a.push((1 / Math.pow(h, 1.15)) * (1 + 0.18 * Math.sin(h * 1.7)));
    }
    return a;
  },
  /** Chiptune-ish bright lead: odd-dominant with a bit of even sparkle. */
  lead(n = 20): number[] {
    const a: number[] = [];
    for (let h = 1; h <= n; h++) {
      const odd = h % 2 === 1 ? 1 : 0.32;
      a.push((odd / Math.pow(h, 0.78)) * (1 + 0.25 * Math.exp(-Math.pow((h - 9) / 4, 2))));
    }
    return a;
  },
  /** Round synth bass: fundamental heavy, a few upper partials for definition. */
  bass(n = 14): number[] {
    const a: number[] = [];
    for (let h = 1; h <= n; h++) a.push(1 / Math.pow(h, 1.45));
    return a;
  },
  /** Metallic / bell — inharmonic-ish emphasis on high partials. */
  bell(n = 20): number[] {
    const a: number[] = [];
    for (let h = 1; h <= n; h++) {
      const w = [1, 0.0, 0.62, 0.0, 0.41, 0.0, 0.33, 0.28][h - 1] ?? 0.9 / Math.pow(h, 1.2);
      a.push(w);
    }
    return a;
  },
  /** Randomised phases so the wave isn't a spiky impulse. */
  scatterPhases(n: number, seed = 7): number[] {
    const rng = new Rand(seed);
    const p: number[] = [];
    for (let i = 0; i < n; i++) p.push(rng.next());
    return p;
  },
};

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

/** Cache a PeriodicWave per (context, key) — building them is not free. */
export function cachedWave(
  ctx: BaseAudioContext,
  key: string,
  make: () => PeriodicWave,
): PeriodicWave {
  let m = waveCache.get(ctx);
  if (!m) { m = new Map(); waveCache.set(ctx, m); }
  let w = m.get(key);
  if (!w) { w = make(); m.set(key, w); }
  return w;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface ADSR {
  /** Attack seconds. */
  a: number;
  /** Decay seconds. */
  d: number;
  /** Sustain level 0..1 (relative to peak). */
  s: number;
  /** Release seconds. */
  r: number;
}

const EPS = 1e-4;

/**
 * Schedule a full ADSR on an AudioParam. Returns the time the envelope ends.
 * `hold` is the time between the end of decay and the start of release.
 */
export function adsr(
  param: AudioParam,
  t0: number,
  peak: number,
  env: ADSR,
  hold: number,
  exponential = true,
): number {
  const sustain = Math.max(EPS, peak * env.s);
  const pk = Math.max(EPS, peak);
  param.cancelScheduledValues(t0);
  param.setValueAtTime(EPS, t0);
  if (exponential) {
    param.exponentialRampToValueAtTime(pk, t0 + Math.max(0.0008, env.a));
    param.exponentialRampToValueAtTime(sustain, t0 + env.a + Math.max(0.001, env.d));
  } else {
    param.linearRampToValueAtTime(pk, t0 + Math.max(0.0008, env.a));
    param.linearRampToValueAtTime(sustain, t0 + env.a + Math.max(0.001, env.d));
  }
  const rel = t0 + env.a + env.d + Math.max(0, hold);
  param.setValueAtTime(sustain, rel);
  param.exponentialRampToValueAtTime(EPS, rel + Math.max(0.002, env.r));
  return rel + env.r;
}

/**
 * Percussive envelope: near-instant attack, exponential decay to silence.
 * The workhorse for impacts, drums, clicks and sparkles.
 */
export function perc(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
): number {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(EPS, t0);
  param.exponentialRampToValueAtTime(Math.max(EPS, peak), t0 + Math.max(0.0005, attack));
  param.exponentialRampToValueAtTime(EPS, t0 + attack + Math.max(0.004, decay));
  param.setValueAtTime(0, t0 + attack + decay + 0.001);
  return t0 + attack + decay;
}

/** Linear ramp helper that also stamps the start value (avoids param drift). */
export function ramp(param: AudioParam, t0: number, from: number, to: number, time: number): void {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(from, t0);
  param.linearRampToValueAtTime(to, t0 + Math.max(0.001, time));
}

/** Exponential (musical) sweep; both endpoints are clamped away from zero. */
export function sweep(param: AudioParam, t0: number, from: number, to: number, time: number): void {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(Math.max(EPS, from), t0);
  param.exponentialRampToValueAtTime(Math.max(EPS, to), t0 + Math.max(0.001, time));
}

/** Multi-point exponential curve: [[timeOffset, value], ...]. */
export function multiSweep(param: AudioParam, t0: number, points: Array<[number, number]>): void {
  if (!points.length) return;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(Math.max(EPS, points[0][1]), t0 + points[0][0]);
  for (let i = 1; i < points.length; i++) {
    param.exponentialRampToValueAtTime(Math.max(EPS, points[i][1]), t0 + points[i][0]);
  }
}

// ---------------------------------------------------------------------------
// Waveshaping / distortion
// ---------------------------------------------------------------------------

export type ShaperType = 'soft' | 'hard' | 'tube' | 'fold' | 'crush' | 'asym';

/**
 * Build a transfer-function curve for a WaveShaperNode.
 * `amount` 0..1 drives the aggressiveness.
 */
export function distortionCurve(type: ShaperType, amount: number, n = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(n);
  const k = clamp01(amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y = x;
    switch (type) {
      case 'soft': {
        const drive = 1 + k * 14;
        y = Math.tanh(x * drive) / Math.tanh(drive);
        break;
      }
      case 'hard': {
        const lim = lerp(1, 0.12, k);
        y = clamp(x, -lim, lim) / lim;
        break;
      }
      case 'tube': {
        // Asymmetric: even harmonics on the positive half, warmth.
        const drive = 1 + k * 9;
        y = x >= 0
          ? Math.tanh(x * drive) / Math.tanh(drive)
          : Math.tanh(x * drive * 0.62) / Math.tanh(drive);
        break;
      }
      case 'fold': {
        const drive = 1 + k * 5;
        y = Math.sin(x * drive * Math.PI * 0.5);
        break;
      }
      case 'crush': {
        const steps = Math.max(2, Math.round(lerp(64, 3, k)));
        y = Math.round(x * steps) / steps;
        break;
      }
      case 'asym': {
        const drive = 1 + k * 20;
        y = (Math.tanh(x * drive) + 0.22 * k * Math.tanh(x * x * drive)) / (1 + 0.22 * k);
        break;
      }
    }
    curve[i] = clamp(y, -1, 1);
  }
  return curve;
}

export function makeShaper(ctx: BaseAudioContext, type: ShaperType, amount: number): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  ws.curve = distortionCurve(type, amount);
  ws.oversample = '4x';
  return ws;
}

// ---------------------------------------------------------------------------
// Filters / effects
// ---------------------------------------------------------------------------

export interface FilterSpec {
  type: BiquadFilterType;
  freq: number;
  q?: number;
  gain?: number;
}

/** Serial biquad chain. Returns {input, output}. */
export function filterChain(
  ctx: BaseAudioContext,
  specs: readonly FilterSpec[],
): { input: AudioNode; output: AudioNode; filters: BiquadFilterNode[] } {
  const filters: BiquadFilterNode[] = [];
  let prev: AudioNode | null = null;
  let input: AudioNode | null = null;
  for (const s of specs) {
    const f = ctx.createBiquadFilter();
    f.type = s.type;
    f.frequency.value = s.freq;
    if (s.q !== undefined) f.Q.value = s.q;
    if (s.gain !== undefined) f.gain.value = s.gain;
    filters.push(f);
    if (prev) prev.connect(f); else input = f;
    prev = f;
  }
  if (!input || !prev) {
    const pass = ctx.createGain();
    return { input: pass, output: pass, filters };
  }
  return { input, output: prev, filters };
}

/**
 * Parallel formant bank — three (or more) resonant band-passes summed.
 * This is what makes noise sound like a crowd/voice instead of a hiss.
 */
export function formantBank(
  ctx: BaseAudioContext,
  formants: ReadonlyArray<readonly [freq: number, q: number, gain: number]>,
): { input: GainNode; output: GainNode; filters: BiquadFilterNode[] } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const filters: BiquadFilterNode[] = [];
  for (const [freq, q, g] of formants) {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const vg = ctx.createGain();
    vg.gain.value = g;
    input.connect(f); f.connect(vg); vg.connect(output);
    filters.push(f);
  }
  return { input, output, filters };
}

export const VOWEL_FORMANTS: Record<string, ReadonlyArray<readonly [number, number, number]>> = {
  a: [[730, 6, 1.0], [1090, 8, 0.62], [2440, 10, 0.28]],
  e: [[530, 6, 1.0], [1840, 9, 0.55], [2480, 11, 0.3]],
  i: [[270, 7, 1.0], [2290, 10, 0.5], [3010, 12, 0.32]],
  o: [[570, 6, 1.0], [840, 8, 0.6], [2410, 11, 0.16]],
  u: [[300, 7, 1.0], [870, 9, 0.42], [2240, 12, 0.12]],
};

/**
 * Feedback comb filter — the metallic-ring maker. Used for wall scrapes,
 * metal surfaces, hollow wood and the resonant part of tunnel reverb.
 */
export function comb(
  ctx: BaseAudioContext,
  delaySeconds: number,
  feedback: number,
  dampHz = 6000,
): { input: GainNode; output: GainNode; delay: DelayNode; fb: GainNode } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  // A delay inside a cycle is silently floored at one render quantum by the
  // implementation. Do it explicitly so the resonant frequency we get is the
  // resonant frequency we asked for.
  const minDelay = 128 / ctx.sampleRate;
  const d = Math.max(minDelay, delaySeconds);
  const delay = ctx.createDelay(Math.max(0.001, d * 4 + 0.05));
  delay.delayTime.value = d;
  const fb = ctx.createGain();
  fb.gain.value = clamp(feedback, 0, 0.97);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = dampHz;
  // CRITICAL: Butterworth Q. A BiquadFilter lowpass defaults to Q = 1, which
  // has ~+1.3 dB of passband overshoot around the corner. Inside a feedback
  // loop that multiplies the loop gain: at feedback 0.9 the loop hits 1.04 and
  // the comb *diverges* — measured as an exponentially growing 6.5 kHz howl
  // that peaked at 0.94 (full scale) 0.7 s into the blue-shell launch bake.
  // At Q = 1/sqrt(2) the response is monotonic with max |H| = 1, so the loop
  // gain can never exceed `feedback` and the comb is unconditionally stable.
  lp.Q.value = Math.SQRT1_2;

  input.connect(delay);
  delay.connect(lp);
  lp.connect(fb);
  fb.connect(delay);
  delay.connect(output);
  input.connect(output);
  return { input, output, delay, fb };
}

/** Sum of N combs at inharmonic ratios — a convincing "struck metal" body. */
export function metalBody(
  ctx: BaseAudioContext,
  baseHz: number,
  partials: readonly number[],
  feedback = 0.86,
  dampHz = 7000,
): { input: GainNode; output: GainNode } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  for (const r of partials) {
    const c = comb(ctx, 1 / (baseHz * r), feedback, dampHz);
    const g = ctx.createGain();
    g.gain.value = 1 / partials.length;
    input.connect(c.input);
    c.output.connect(g);
    g.connect(output);
  }
  return { input, output };
}

/** Schroeder allpass — diffusion without colouration. */
export function allpass(
  ctx: BaseAudioContext,
  delaySeconds: number,
  g = 0.7,
): { input: GainNode; output: GainNode } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const delay = ctx.createDelay(Math.max(0.002, delaySeconds * 4));
  delay.delayTime.value = delaySeconds;
  const fwd = ctx.createGain(); fwd.gain.value = -g;
  const fb = ctx.createGain(); fb.gain.value = g;

  input.connect(fwd); fwd.connect(output);
  input.connect(delay);
  delay.connect(output);
  delay.connect(fb); fb.connect(delay);
  return { input, output };
}

/**
 * Chorus / flanger: N modulated delay lines with independent LFO phases.
 * Used on the music lead and the anti-gravity surface hum.
 */
export function chorus(
  ctx: BaseAudioContext,
  opts: { voices?: number; baseDelay?: number; depth?: number; rate?: number; feedback?: number; mix?: number } = {},
): { input: GainNode; output: GainNode; lfos: OscillatorNode[]; start(t: number): void; stop(t: number): void } {
  const voices = opts.voices ?? 3;
  const baseDelay = opts.baseDelay ?? 0.014;
  const depth = opts.depth ?? 0.0042;
  const rate = opts.rate ?? 0.5;
  const feedback = opts.feedback ?? 0;
  const mix = opts.mix ?? 0.5;

  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1 - mix * 0.5;
  const wet = ctx.createGain(); wet.gain.value = mix;
  input.connect(dry); dry.connect(output);
  wet.connect(output);

  const lfos: OscillatorNode[] = [];
  for (let i = 0; i < voices; i++) {
    const d = ctx.createDelay(0.2);
    d.delayTime.value = baseDelay * (1 + i * 0.31);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rate * (1 + i * 0.27);
    const amt = ctx.createGain();
    amt.gain.value = depth * (1 - i * 0.15);
    lfo.connect(amt); amt.connect(d.delayTime);
    input.connect(d);
    if (feedback > 0) {
      const fb = ctx.createGain(); fb.gain.value = feedback;
      d.connect(fb); fb.connect(d);
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = voices > 1 ? (i / (voices - 1)) * 2 - 1 : 0;
    d.connect(pan); pan.connect(wet);
    lfos.push(lfo);
  }

  return {
    input, output, lfos,
    start(t: number) { for (const l of lfos) l.start(t); },
    stop(t: number) { for (const l of lfos) { try { l.stop(t); } catch { /* already stopped */ } } },
  };
}

// ---------------------------------------------------------------------------
// FM
// ---------------------------------------------------------------------------

export interface FmOpts {
  carrierHz: number;
  /** modulator / carrier frequency ratio */
  ratio: number;
  /** modulation index (peak deviation in multiples of the modulator freq) */
  index: number;
  carrierType?: OscillatorType;
  modType?: OscillatorType;
  /** Index envelope decay in seconds (index falls to ~0 over this time). */
  indexDecay?: number;
  detune?: number;
}

/**
 * A classic 2-operator FM pair. Returns the carrier plus start/stop so the
 * caller owns the scheduling. Great for bells, marimbas, steel drums, clangs.
 */
export function fmPair(
  ctx: BaseAudioContext,
  o: FmOpts,
): { out: AudioNode; carrier: OscillatorNode; mod: OscillatorNode; modGain: GainNode; start(t: number): void; stop(t: number): void } {
  const carrier = ctx.createOscillator();
  carrier.type = o.carrierType ?? 'sine';
  carrier.frequency.value = o.carrierHz;
  if (o.detune) carrier.detune.value = o.detune;

  const mod = ctx.createOscillator();
  mod.type = o.modType ?? 'sine';
  mod.frequency.value = o.carrierHz * o.ratio;

  const modGain = ctx.createGain();
  modGain.gain.value = o.carrierHz * o.ratio * o.index;
  mod.connect(modGain);
  modGain.connect(carrier.frequency);

  return {
    out: carrier,
    carrier, mod, modGain,
    start(t: number) {
      if (o.indexDecay && o.indexDecay > 0) {
        const peak = o.carrierHz * o.ratio * o.index;
        modGain.gain.setValueAtTime(peak, t);
        modGain.gain.exponentialRampToValueAtTime(Math.max(EPS, peak * 0.02), t + o.indexDecay);
      }
      mod.start(t); carrier.start(t);
    },
    stop(t: number) {
      try { mod.stop(t); } catch { /* noop */ }
      try { carrier.stop(t); } catch { /* noop */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Offline baking
// ---------------------------------------------------------------------------

/**
 * Render a graph to an AudioBuffer once, so playback later costs a single
 * AudioBufferSourceNode. This is THE performance trick of this module.
 */
export async function renderOffline(
  sampleRate: number,
  channels: number,
  seconds: number,
  build: (ctx: OfflineAudioContext, out: GainNode) => void,
): Promise<AudioBuffer> {
  const length = Math.max(128, Math.ceil(seconds * sampleRate));
  const ctx = new OfflineAudioContext(channels, length, sampleRate);
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);
  build(ctx, out);
  return ctx.startRendering();
}

/** Peak-normalise an AudioBuffer in place and strip DC. */
export function normalizeBuffer(buf: AudioBuffer, peak = 0.9): AudioBuffer {
  let max = 0;
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    chans.push(d);
    let mean = 0;
    for (let i = 0; i < d.length; i++) mean += d[i];
    mean /= Math.max(1, d.length);
    for (let i = 0; i < d.length; i++) {
      d[i] -= mean;
      const v = Math.abs(d[i]);
      if (v > max) max = v;
    }
  }
  if (max > 1e-7) {
    const k = peak / max;
    for (const d of chans) for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return buf;
}

/** Fade the first/last `seconds` to zero — kills clicks on one-shots. */
export function fadeEdges(buf: AudioBuffer, seconds = 0.004): AudioBuffer {
  const n = Math.max(1, Math.floor(seconds * buf.sampleRate));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    const m = Math.min(n, Math.floor(d.length / 2));
    for (let i = 0; i < m; i++) {
      const g = i / m;
      d[i] *= g;
      d[d.length - 1 - i] *= g;
    }
  }
  return buf;
}

/**
 * Turn a buffer into a click-free loop by crossfading its tail into its head.
 * The result is `fade` seconds shorter than the input.
 */
export function makeSeamlessLoop(ctx: BaseAudioContext, buf: AudioBuffer, fade = 0.12): AudioBuffer {
  const f = Math.max(1, Math.floor(fade * buf.sampleRate));
  const newLen = buf.length - f;
  if (newLen <= f * 2) return buf;
  const out = ctx.createBuffer(buf.numberOfChannels, newLen, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, newLen));
    for (let i = 0; i < f; i++) {
      const t = i / f;
      // equal-power crossfade
      const a = Math.cos(t * Math.PI * 0.5);
      const b = Math.sin(t * Math.PI * 0.5);
      dst[i] = src[i] * b + src[newLen + i] * a;
    }
  }
  return out;
}

/** Concatenate/mix a buffer into another at a sample offset (mono-safe). */
export function mixInto(dst: AudioBuffer, src: AudioBuffer, offsetSeconds: number, gain = 1): void {
  const off = Math.floor(offsetSeconds * dst.sampleRate);
  for (let c = 0; c < dst.numberOfChannels; c++) {
    const d = dst.getChannelData(c);
    const s = src.getChannelData(Math.min(c, src.numberOfChannels - 1));
    for (let i = 0; i < s.length; i++) {
      const j = off + i;
      if (j >= 0 && j < d.length) d[j] += s[i] * gain;
    }
  }
}

/** Slice a region out of a buffer into a new one. */
export function sliceBuffer(
  ctx: BaseAudioContext, buf: AudioBuffer, startSeconds: number, seconds: number,
): AudioBuffer {
  const s = Math.max(0, Math.floor(startSeconds * buf.sampleRate));
  const n = Math.max(1, Math.floor(seconds * buf.sampleRate));
  const out = ctx.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < n; i++) dst[i] = src[s + i] ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Granular / pitch shifting
// ---------------------------------------------------------------------------

export interface GrainOpts {
  /** Playback speed of the grain read head (time-stretch). */
  rate?: number;
  /** Pitch shift in semitones. */
  pitch?: number;
  grainSeconds?: number;
  overlap?: number;
  duration: number;
  gain?: number;
  seed?: number;
  jitter?: number;
}

/**
 * Overlap-add granular playback. Time and pitch are independent, which is how
 * the drift scrub and bullet-bill roar stay convincing while their pitch is
 * being dragged around.
 */
export function granular(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  dest: AudioNode,
  t0: number,
  o: GrainOpts,
): void {
  const grain = o.grainSeconds ?? 0.08;
  const overlap = o.overlap ?? 2;
  const hop = grain / overlap;
  const rate = o.rate ?? 1;
  const pitch = Math.pow(2, (o.pitch ?? 0) / 12);
  const rng = new Rand(o.seed ?? 4242);
  const jitter = o.jitter ?? 0.3;
  const g0 = o.gain ?? 1;

  let t = t0;
  let read = 0;
  const end = t0 + o.duration;
  while (t < end) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(g0, t + grain * 0.5);
    g.gain.linearRampToValueAtTime(0.0001, t + grain);
    src.connect(g); g.connect(dest);
    const offset = Math.max(0, Math.min(buffer.duration - grain * pitch - 0.001,
      read + rng.bi() * jitter * grain));
    src.start(t, offset, grain * pitch + 0.002);
    src.stop(t + grain + 0.01);
    t += hop;
    read += hop * rate;
    if (read > buffer.duration - grain * pitch - 0.01) read = 0;
  }
}

// ---------------------------------------------------------------------------
// Small conveniences used all over the sfx bank
// ---------------------------------------------------------------------------

/** osc -> gain, started/stopped, returns the gain node so you can env it. */
export function tone(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  dur: number,
  opts: {
    type?: OscillatorType;
    wave?: PeriodicWave;
    freq: number;
    freqEnd?: number;
    freqCurve?: 'exp' | 'lin';
    detune?: number;
    gain?: number;
    attack?: number;
    decay?: number;
    env?: ADSR;
    hold?: number;
  },
): GainNode {
  const osc = ctx.createOscillator();
  if (opts.wave) osc.setPeriodicWave(opts.wave);
  else osc.type = opts.type ?? 'sine';
  osc.frequency.value = opts.freq;
  if (opts.detune) osc.detune.value = opts.detune;
  if (opts.freqEnd !== undefined) {
    if ((opts.freqCurve ?? 'exp') === 'exp') sweep(osc.frequency, t0, opts.freq, opts.freqEnd, dur);
    else ramp(osc.frequency, t0, opts.freq, opts.freqEnd, dur);
  }
  const g = ctx.createGain();
  g.gain.value = 0;
  if (opts.env) {
    adsr(g.gain, t0, opts.gain ?? 1, opts.env, opts.hold ?? 0);
  } else {
    perc(g.gain, t0, opts.gain ?? 1, opts.attack ?? 0.004, opts.decay ?? dur);
  }
  osc.connect(g); g.connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + (opts.env ? opts.env.r : 0) + 0.08);
  return g;
}

/** A one-shot filtered noise burst — the backbone of most impacts. */
export function noiseBurst(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  dur: number,
  opts: {
    type?: NoiseType;
    filter?: BiquadFilterType;
    freq?: number;
    freqEnd?: number;
    q?: number;
    gain?: number;
    attack?: number;
    decay?: number;
    seed?: number;
    shaper?: { type: ShaperType; amount: number };
  } = {},
): GainNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.type ?? 'white', Math.max(0.25, dur + 0.1), 1, opts.seed ?? 3);
  const f = ctx.createBiquadFilter();
  f.type = opts.filter ?? 'bandpass';
  f.frequency.value = opts.freq ?? 1200;
  f.Q.value = opts.q ?? 1;
  if (opts.freqEnd !== undefined) sweep(f.frequency, t0, opts.freq ?? 1200, opts.freqEnd, dur);
  const g = ctx.createGain();
  g.gain.value = 0;
  perc(g.gain, t0, opts.gain ?? 1, opts.attack ?? 0.003, opts.decay ?? dur);
  src.connect(f);
  if (opts.shaper) {
    const ws = makeShaper(ctx, opts.shaper.type, opts.shaper.amount);
    f.connect(ws); ws.connect(g);
  } else {
    f.connect(g);
  }
  g.connect(dest);
  src.start(t0);
  src.stop(t0 + dur + 0.12);
  return g;
}

/** Stereo widener via a tiny Haas delay on one side. */
export function haasWiden(ctx: BaseAudioContext, ms = 12): { input: GainNode; output: GainNode } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const l = ctx.createStereoPanner(); l.pan.value = -0.85;
  const r = ctx.createStereoPanner(); r.pan.value = 0.85;
  const d = ctx.createDelay(0.1);
  d.delayTime.value = ms / 1000;
  input.connect(l); l.connect(output);
  input.connect(d); d.connect(r); r.connect(output);
  return { input, output };
}

// ---------------------------------------------------------------------------
// Measurement — used by the dev harness for objective verification
// ---------------------------------------------------------------------------

export interface BufferStats {
  peak: number;
  rms: number;
  dc: number;
  /** Spectral centroid in Hz (brightness). */
  centroid: number;
  /** Fraction of energy below 100 Hz. */
  subEnergy: number;
  /** Fraction of energy above 6 kHz. */
  highEnergy: number;
  duration: number;
  /** Time from start to the last sample above -50 dBFS. */
  envelopeLength: number;
  nan: boolean;
  clipped: boolean;
}

/** Real-input FFT via a simple radix-2 complex FFT on a Hann-windowed frame. */
function fftMagnitudes(data: Float32Array, size: number): Float32Array {
  const n = size;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = (data[i] ?? 0) * w;
  }
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mag = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/** Objective measurement of a rendered buffer. Used by the verification page. */
export function analyzeBuffer(buf: AudioBuffer): BufferStats {
  const ch = buf.getChannelData(0);
  let peak = 0, sum = 0, sumSq = 0, nan = false;
  for (let i = 0; i < ch.length; i++) {
    const v = ch[i];
    if (!Number.isFinite(v)) { nan = true; continue; }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, ch.length));
  const dc = sum / Math.max(1, ch.length);

  // envelope length: last sample above -50 dBFS relative to full scale
  const thr = peak * 0.0032;
  let last = 0;
  for (let i = ch.length - 1; i >= 0; i--) {
    if (Math.abs(ch[i]) > thr) { last = i; break; }
  }

  // spectral centroid, averaged over up to 8 frames
  const N = 4096;
  const frames = Math.max(1, Math.min(8, Math.floor(ch.length / N)));
  let centroidNum = 0, centroidDen = 0, subE = 0, highE = 0, totE = 0;
  for (let f = 0; f < frames; f++) {
    const start = Math.floor((f * (ch.length - N)) / Math.max(1, frames - 1 || 1));
    const frame = ch.subarray(Math.max(0, start), Math.max(0, start) + N);
    if (frame.length < N) break;
    const mag = fftMagnitudes(frame, N);
    for (let k = 1; k < mag.length; k++) {
      const hz = (k * buf.sampleRate) / N;
      const e = mag[k] * mag[k];
      centroidNum += hz * mag[k];
      centroidDen += mag[k];
      totE += e;
      if (hz < 100) subE += e;
      if (hz > 6000) highE += e;
    }
  }
  return {
    peak,
    rms,
    dc,
    centroid: centroidDen > 0 ? centroidNum / centroidDen : 0,
    subEnergy: totE > 0 ? subE / totE : 0,
    highEnergy: totE > 0 ? highE / totE : 0,
    duration: buf.duration,
    envelopeLength: last / buf.sampleRate,
    nan,
    clipped: peak > 0.999,
  };
}
