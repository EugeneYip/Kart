/**
 * ============================================================================
 *  FOXY KART — PROCEDURAL CONVOLUTION REVERB + AIR LAYER
 * ============================================================================
 *  There are no impulse-response WAVs here. Every IR is synthesised sample by
 *  sample from:
 *
 *    - a sparse set of **early reflection taps** (the part your ear uses to
 *      judge room size — get these right and the space reads instantly)
 *    - an **exponentially decaying diffuse tail** built from noise, shaped by a
 *      one-pole lowpass whose cutoff *falls over time* so highs die before lows
 *      (real rooms absorb treble faster; a flat-decay IR sounds like a spring)
 *    - optional **recursive comb resonance** for tunnels, which is what gives a
 *      concrete underpass that hollow ringing pitch
 *
 *  Two ConvolverNodes are kept alive so a preset change can crossfade instead
 *  of hard-cutting — driving into a tunnel and hearing the space *swell* is one
 *  of the most satisfying details in a racing game.
 *
 *  Also here: `WindLayer`, the speed-dependent air rush, because it belongs to
 *  the same "what does the world sound like around you" job.
 * ============================================================================
 */

import { clamp, clamp01, lerp } from '@/core/MathUtils';
import { Rand, noiseBuffer } from './Synth';

export type EnvironmentPreset = 'outdoor' | 'tunnel' | 'city' | 'cave' | 'indoor';

export const ENVIRONMENT_PRESETS: readonly EnvironmentPreset[] = [
  'outdoor', 'tunnel', 'city', 'cave', 'indoor',
];

// ---------------------------------------------------------------------------
// IR specification
// ---------------------------------------------------------------------------

interface EarlyTap {
  /** Seconds after the direct sound. */
  t: number;
  /** Signed gain (sign flips avoid a "chorus of identical slaps"). */
  g: number;
  /** Lowpass corner applied to this individual reflection, Hz. */
  hz: number;
  /** -1..1 stereo placement. */
  pan: number;
}

interface IRSpec {
  /** Total IR length, seconds. Directly drives convolution cost. */
  seconds: number;
  /** Gap before the diffuse tail begins, seconds. Big rooms = longer. */
  preDelay: number;
  /** RT60 of the diffuse tail, seconds. */
  decay: number;
  /** Tail lowpass corner at t=0, Hz. */
  hfStart: number;
  /** Tail lowpass corner at t=RT60, Hz. Lower = darker, more absorbent. */
  hfEnd: number;
  /** One-pole highpass on the tail, Hz — keeps mud out of the mix. */
  lfCut: number;
  /** Seconds for the diffuse tail to fade *in*. Fake diffusion build-up. */
  buildUp: number;
  /** Early reflections. */
  taps: readonly EarlyTap[];
  /** Recursive comb resonances (Hz, feedback) — tunnel/pipe character. */
  combs?: ReadonlyArray<readonly [hz: number, fb: number]>;
  /** How much the two channels decorrelate. 0 = mono IR, 1 = fully separate. */
  width: number;
  /** Target wet level after energy normalisation. */
  wet: number;
  /** Send-path tone shaping. */
  sendLowpass: number;
  sendHighpass: number;
  seed: number;
}

/** Generate an even spread of early taps with pseudo-random jitter. */
function makeTaps(
  seed: number,
  count: number,
  firstMs: number,
  lastMs: number,
  gain0: number,
  hzHigh: number,
  hzLow: number,
): EarlyTap[] {
  const rng = new Rand(seed);
  const taps: EarlyTap[] = [];
  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 0 : i / (count - 1);
    // Cluster taps toward the start (u^1.6) — early reflections bunch up.
    const t = lerp(firstMs, lastMs, Math.pow(u, 1.6)) / 1000 + rng.range(-0.0012, 0.0012);
    const g = gain0 * Math.pow(0.72, i * 0.75) * (rng.next() < 0.35 ? -1 : 1) * rng.range(0.7, 1.15);
    taps.push({
      t: Math.max(0.0005, t),
      g,
      hz: lerp(hzHigh, hzLow, u) * rng.range(0.8, 1.25),
      pan: rng.bi() * 0.9,
    });
  }
  return taps;
}

const SPECS: Record<EnvironmentPreset, IRSpec> = {
  // Wide open sky. Almost no tail — just ground bounce and distant treelines.
  outdoor: {
    seconds: 0.85, preDelay: 0.012, decay: 0.42,
    hfStart: 9000, hfEnd: 2600, lfCut: 130, buildUp: 0.010,
    taps: makeTaps(11, 7, 5, 90, 0.55, 8000, 2200),
    width: 0.85, wet: 0.20, sendLowpass: 9500, sendHighpass: 170, seed: 101,
  },
  // Concrete underpass: long, resonant, strongly comb-coloured, dark tail.
  tunnel: {
    seconds: 2.5, preDelay: 0.008, decay: 1.85,
    hfStart: 5200, hfEnd: 700, lfCut: 70, buildUp: 0.006,
    taps: makeTaps(23, 12, 3, 150, 0.85, 5200, 900),
    combs: [[112, 0.80], [149, 0.72], [223.5, 0.62], [67, 0.55]],
    width: 0.45, wet: 0.62, sendLowpass: 6200, sendHighpass: 90, seed: 202,
  },
  // City canyon: hard slap-back off far facades, moderately bright tail.
  city: {
    seconds: 1.6, preDelay: 0.026, decay: 1.05,
    hfStart: 7600, hfEnd: 1700, lfCut: 110, buildUp: 0.018,
    taps: makeTaps(37, 10, 14, 210, 0.72, 7200, 1500),
    combs: [[85, 0.42]],
    width: 0.95, wet: 0.34, sendLowpass: 8200, sendHighpass: 140, seed: 303,
  },
  // Lava cave: huge, very dark, slow build. Feels like volume, not surfaces.
  cave: {
    seconds: 3.1, preDelay: 0.034, decay: 2.6,
    hfStart: 4200, hfEnd: 420, lfCut: 55, buildUp: 0.055,
    taps: makeTaps(53, 9, 22, 330, 0.62, 3800, 600),
    combs: [[41, 0.58], [58.5, 0.5]],
    width: 0.8, wet: 0.55, sendLowpass: 5000, sendHighpass: 75, seed: 404,
  },
  // Pit garage / indoor hall: short, tight, boxy, plenty of early energy.
  indoor: {
    seconds: 1.0, preDelay: 0.006, decay: 0.62,
    hfStart: 6800, hfEnd: 1500, lfCut: 120, buildUp: 0.006,
    taps: makeTaps(67, 14, 2, 70, 0.9, 6500, 1600),
    combs: [[196, 0.5], [261, 0.42]],
    width: 0.6, wet: 0.40, sendLowpass: 7600, sendHighpass: 150, seed: 505,
  },
};

/** One-pole lowpass coefficient for a given corner frequency. */
function onePole(hz: number, sr: number): number {
  return 1 - Math.exp((-2 * Math.PI * Math.max(1, hz)) / sr);
}

/**
 * Synthesise a stereo impulse response.
 *
 * The tail is white noise multiplied by exp(-6.908 t / RT60), then run through
 * a time-varying one-pole lowpass (cutoff glides hfStart -> hfEnd across the
 * RT60) and a fixed one-pole highpass. Early reflections are added as short
 * lowpassed noise "slaps" rather than bare impulses, which reads as a surface
 * rather than a click.
 */
export function generateImpulseResponse(
  ctx: BaseAudioContext,
  spec: IRSpec,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(64, Math.floor(spec.seconds * sr));
  const buf = ctx.createBuffer(2, n, sr);

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    // Decorrelate the two channels by `width`; a shared seed keeps them fused.
    const seed = spec.seed + (c === 0 ? 0 : Math.floor(1 + spec.width * 9973));
    const rng = new Rand(seed * 2246822519);

    // ---- diffuse tail -----------------------------------------------------
    const pre = Math.floor(spec.preDelay * sr);
    const build = Math.max(1, Math.floor(spec.buildUp * sr));
    const k60 = 6.907755; // ln(1000) => -60 dB
    let lp = 0;
    let hp = 0;
    let hpState = 0;
    const hpA = onePole(spec.lfCut, sr);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp((-k60 * t) / spec.decay);
      if (env < 1e-5) break;
      const rise = i - pre < build ? (i - pre) / build : 1;
      const cutoff = lerp(spec.hfStart, spec.hfEnd, clamp01(t / spec.decay));
      const a = onePole(cutoff, sr);
      lp += a * (rng.bi() - lp);
      // one-pole highpass = signal minus its lowpassed self
      hpState += hpA * (lp - hpState);
      hp = lp - hpState;
      d[i] += hp * env * rise * rise;
    }

    // ---- early reflections ------------------------------------------------
    for (const tap of spec.taps) {
      const start = Math.floor((tap.t + spec.preDelay * 0.25) * sr);
      const slapLen = Math.max(6, Math.floor(sr * 0.0022));
      // Constant-power pan; `width` scales how asymmetric the pair gets.
      const panw = c === 0 ? (1 - tap.pan) * 0.5 : (1 + tap.pan) * 0.5;
      const gain = tap.g * lerp(0.5, panw, spec.width) * 2;
      const a = onePole(tap.hz, sr);
      let s = 0;
      for (let i = 0; i < slapLen; i++) {
        const j = start + i;
        if (j >= n) break;
        s += a * (rng.bi() - s);
        const w = 1 - i / slapLen;
        d[j] += s * gain * w * w;
      }
    }

    // ---- comb resonance (the tunnel's hollow ring) ------------------------
    if (spec.combs) {
      for (let ci = 0; ci < spec.combs.length; ci++) {
        const [hz, fb] = spec.combs[ci];
        // Slight per-channel detune so the ring isn't dead-centre mono.
        const detune = 1 + (c === 0 ? -1 : 1) * spec.width * 0.006;
        const delay = Math.max(2, Math.round(sr / (hz * detune)));
        const g = clamp(fb, 0, 0.94) * (1 / Math.sqrt(spec.combs.length));
        for (let i = delay; i < n; i++) d[i] += d[i - delay] * g;
      }
    }
  }

  // ---- normalise by energy so every preset returns the same wet loudness --
  let energy = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) energy += d[i] * d[i];
  }
  const rms = Math.sqrt(energy / Math.max(1, n * 2));
  // Convolution gain scales with sqrt(IR length * IR power); dividing by the
  // total energy keeps a 3 s cave from being 8x louder than a 0.8 s outdoor.
  const target = 0.55 / Math.sqrt(Math.max(1e-9, energy));
  const scale = clamp(target, 0, 4 / Math.max(1e-6, rms));
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      d[i] *= scale;
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  // Guard against a runaway comb producing an IR that will blow the limiter.
  if (peak > 1.6) {
    const k = 1.6 / peak;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// The reverb bus
// ---------------------------------------------------------------------------

interface ConvSlot {
  conv: ConvolverNode;
  gain: GainNode;
  preset: EnvironmentPreset | null;
  /** Bumped on every assignment so a stale retire-timer can't free a live IR. */
  epoch: number;
}

/**
 * A send/return reverb with two convolvers that crossfade.
 *
 * Sources connect to `input` at whatever send level they want. `output` is
 * pure wet — the caller sums it back next to the dry path.
 */
export class ReverbBus {
  readonly input: GainNode;
  readonly output: GainNode;

  private ctx: BaseAudioContext;
  private sendLp: BiquadFilterNode;
  private sendHp: BiquadFilterNode;
  private wetTrim: GainNode;
  private slots: [ConvSlot, ConvSlot];
  private active = 0;
  private irs = new Map<EnvironmentPreset, AudioBuffer>();
  private current: EnvironmentPreset = 'outdoor';
  private wetScale = 1;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;

    this.input = ctx.createGain();
    // Mono send: halves convolution cost and is what a real send bus does.
    this.input.channelCount = 1;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers';

    this.sendHp = ctx.createBiquadFilter();
    this.sendHp.type = 'highpass';
    this.sendHp.frequency.value = 170;
    this.sendLp = ctx.createBiquadFilter();
    this.sendLp.type = 'lowpass';
    this.sendLp.frequency.value = 9000;

    this.input.connect(this.sendHp);
    this.sendHp.connect(this.sendLp);

    this.wetTrim = ctx.createGain();
    this.wetTrim.gain.value = 0.2;
    this.output = ctx.createGain();
    this.wetTrim.connect(this.output);

    const mk = (): ConvSlot => {
      const conv = ctx.createConvolver();
      conv.normalize = false; // we normalise the IRs ourselves, predictably
      const gain = ctx.createGain();
      gain.gain.value = 0;
      this.sendLp.connect(conv);
      conv.connect(gain);
      gain.connect(this.wetTrim);
      return { conv, gain, preset: null, epoch: 0 };
    };
    this.slots = [mk(), mk()];
  }

  /** Bake every IR. ~15 ms of maths per preset; all synchronous. */
  init(): void {
    for (const p of ENVIRONMENT_PRESETS) {
      this.irs.set(p, generateImpulseResponse(this.ctx, SPECS[p]));
    }
    const spec = SPECS.outdoor;
    const slot = this.slots[0];
    slot.conv.buffer = this.irs.get('outdoor') ?? null;
    slot.preset = 'outdoor';
    slot.gain.gain.value = 1;
    this.wetTrim.gain.value = spec.wet * this.wetScale;
    this.sendLp.frequency.value = spec.sendLowpass;
    this.sendHp.frequency.value = spec.sendHighpass;
    this.current = 'outdoor';
  }

  get preset(): EnvironmentPreset { return this.current; }

  /** Crossfade to a new space. Idempotent if already there. */
  setPreset(preset: EnvironmentPreset, fadeSeconds = 0.55): void {
    if (preset === this.current) return;
    const ir = this.irs.get(preset);
    if (!ir) return;
    const now = this.ctx.currentTime;
    const fade = Math.max(0.02, fadeSeconds);

    const from = this.slots[this.active];
    const to = this.slots[1 - this.active];
    to.conv.buffer = ir;
    to.preset = preset;
    to.epoch++;

    // A ConvolverNode keeps convolving while its buffer is set, even behind a
    // gain of zero — with a 2.5 s tunnel IR that is the single most expensive
    // node in the graph, paid twice for the rest of the race. Drop the retired
    // slot's buffer once the crossfade has finished. The epoch guard stops a
    // late timer from clearing a slot that has since been reassigned.
    const retiredEpoch = ++from.epoch;
    window.setTimeout(() => {
      if (from.epoch === retiredEpoch && from.gain.gain.value < 0.001) {
        from.conv.buffer = null;
        from.preset = null;
      }
    }, fade * 1000 + 120);

    to.gain.gain.cancelScheduledValues(now);
    to.gain.gain.setValueAtTime(to.gain.gain.value, now);
    to.gain.gain.linearRampToValueAtTime(1, now + fade);
    from.gain.gain.cancelScheduledValues(now);
    from.gain.gain.setValueAtTime(from.gain.gain.value, now);
    from.gain.gain.linearRampToValueAtTime(0, now + fade);

    const spec = SPECS[preset];
    const trim = this.wetTrim.gain;
    trim.cancelScheduledValues(now);
    trim.setValueAtTime(trim.value, now);
    trim.linearRampToValueAtTime(spec.wet * this.wetScale, now + fade);

    for (const [param, target] of [
      [this.sendLp.frequency, spec.sendLowpass],
      [this.sendHp.frequency, spec.sendHighpass],
    ] as Array<[AudioParam, number]>) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.exponentialRampToValueAtTime(Math.max(20, target), now + fade);
    }

    this.active = 1 - this.active;
    this.current = preset;
  }

  /** Global wet multiplier (settings slider / cinematic overrides). */
  setWetScale(v: number): void {
    this.wetScale = clamp(v, 0, 3);
    const spec = SPECS[this.current];
    const now = this.ctx.currentTime;
    this.wetTrim.gain.cancelScheduledValues(now);
    this.wetTrim.gain.setTargetAtTime(spec.wet * this.wetScale, now, 0.05);
  }

  /** Measured IR properties — used by the verification harness. */
  irInfo(preset: EnvironmentPreset): { seconds: number; peak: number; rms: number } | null {
    const ir = this.irs.get(preset);
    if (!ir) return null;
    let peak = 0;
    let sumSq = 0;
    let count = 0;
    for (let c = 0; c < ir.numberOfChannels; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
        sumSq += d[i] * d[i];
        count++;
      }
    }
    return { seconds: ir.duration, peak, rms: Math.sqrt(sumSq / Math.max(1, count)) };
  }

  dispose(): void {
    for (const s of this.slots) {
      try { s.conv.disconnect(); } catch { /* noop */ }
      try { s.gain.disconnect(); } catch { /* noop */ }
      s.conv.buffer = null;
    }
    try { this.input.disconnect(); } catch { /* noop */ }
    try { this.sendHp.disconnect(); } catch { /* noop */ }
    try { this.sendLp.disconnect(); } catch { /* noop */ }
    try { this.wetTrim.disconnect(); } catch { /* noop */ }
    this.irs.clear();
  }
}

// ---------------------------------------------------------------------------
// Wind / air rush
// ---------------------------------------------------------------------------

/**
 * Speed-dependent air noise. Three stacked bands so the character *changes*
 * with speed instead of just getting louder:
 *
 *   - a brown-noise rumble that fills in as you build speed (body buffeting)
 *   - a broad band-passed hiss whose corner rises with speed
 *   - a narrow high-Q whistle that only appears near top speed / boost
 *
 * All of it is one looping buffer per band, so the cost is three
 * BufferSources and six filters, permanently.
 */
export class WindLayer {
  private ctx: BaseAudioContext;
  private out: GainNode;
  private started = false;

  private rumbleSrc: AudioBufferSourceNode;
  private rumbleGain: GainNode;
  private hissSrc: AudioBufferSourceNode;
  private hissBp: BiquadFilterNode;
  private hissGain: GainNode;
  private whistleSrc: AudioBufferSourceNode;
  private whistleBp: BiquadFilterNode;
  private whistleGain: GainNode;

  private level = 0;
  private target = 0;

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dest);

    const mkSrc = (type: 'brown' | 'pink' | 'white', seed: number) => {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuffer(ctx, type, 3.1, 2, seed);
      s.loop = true;
      return s;
    };

    this.rumbleSrc = mkSrc('brown', 31);
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.value = 320;
    rlp.Q.value = 0.7;
    this.rumbleSrc.connect(rlp);
    rlp.connect(this.rumbleGain);
    this.rumbleGain.connect(this.out);

    this.hissSrc = mkSrc('pink', 32);
    this.hissBp = ctx.createBiquadFilter();
    this.hissBp.type = 'bandpass';
    this.hissBp.frequency.value = 700;
    this.hissBp.Q.value = 0.55;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.hissSrc.connect(this.hissBp);
    this.hissBp.connect(this.hissGain);
    this.hissGain.connect(this.out);

    this.whistleSrc = mkSrc('white', 33);
    this.whistleBp = ctx.createBiquadFilter();
    this.whistleBp.type = 'bandpass';
    this.whistleBp.frequency.value = 3200;
    this.whistleBp.Q.value = 7.5;
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    this.whistleSrc.connect(this.whistleBp);
    this.whistleBp.connect(this.whistleGain);
    this.whistleGain.connect(this.out);
  }

  start(when = 0): void {
    if (this.started) return;
    this.started = true;
    const t = Math.max(when, this.ctx.currentTime);
    for (const s of [this.rumbleSrc, this.hissSrc, this.whistleSrc]) {
      try { s.start(t); } catch { /* already started */ }
    }
  }

  /** `v` is roughly speed / topSpeed; values above 1 are boost territory. */
  setSpeed(v: number): void { this.target = clamp(v, 0, 1.45); }

  update(dt: number): void {
    // Smooth in the audio thread's terms: setTargetAtTime on each param would
    // be 6 scheduled events per frame. One JS lerp + direct assignment is far
    // cheaper and inaudible at 60 Hz for a broadband noise bed.
    const k = 1 - Math.exp(-dt / 0.14);
    this.level += (this.target - this.level) * k;
    const v = this.level;
    const v2 = v * v;

    this.rumbleGain.gain.value = 0.22 * v2;
    this.hissGain.gain.value = 0.16 * Math.pow(v, 2.4);
    this.hissBp.frequency.value = lerp(420, 2600, Math.pow(clamp01(v / 1.2), 0.8));
    const whistle = clamp01((v - 0.72) / 0.6);
    this.whistleGain.gain.value = 0.085 * whistle * whistle;
    this.whistleBp.frequency.value = lerp(2600, 5200, whistle);
  }

  setVolume(v: number): void { this.out.gain.value = clamp(v, 0, 2); }

  /** Current summed wind gain — verification harness reads this. */
  get debugLevels(): { rumble: number; hiss: number; whistle: number; hissHz: number } {
    return {
      rumble: this.rumbleGain.gain.value,
      hiss: this.hissGain.gain.value,
      whistle: this.whistleGain.gain.value,
      hissHz: this.hissBp.frequency.value,
    };
  }

  dispose(): void {
    for (const s of [this.rumbleSrc, this.hissSrc, this.whistleSrc]) {
      try { s.stop(); } catch { /* noop */ }
      try { s.disconnect(); } catch { /* noop */ }
    }
    try { this.out.disconnect(); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Underwater / submerged filtering
// ---------------------------------------------------------------------------

/**
 * A master-insert "everything is muffled" filter. Water kills treble hard and
 * adds a slight resonance around 400–700 Hz; at v=0 it is a transparent pass.
 */
export class SubmergeFilter {
  readonly input: GainNode;
  readonly output: GainNode;
  private lp: BiquadFilterNode;
  private peak: BiquadFilterNode;
  private ctx: BaseAudioContext;
  private amount = 0;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 20000;
    this.lp.Q.value = 0.4;
    this.peak = ctx.createBiquadFilter();
    this.peak.type = 'peaking';
    this.peak.frequency.value = 520;
    this.peak.Q.value = 1.1;
    this.peak.gain.value = 0;
    this.input.connect(this.lp);
    this.lp.connect(this.peak);
    this.peak.connect(this.output);
  }

  /** 0 = dry air, 1 = fully submerged. */
  set(v: number, seconds = 0.25): void {
    const a = clamp01(v);
    if (Math.abs(a - this.amount) < 0.001) return;
    this.amount = a;
    const now = this.ctx.currentTime;
    const hz = lerp(20000, 480, Math.pow(a, 0.55));
    this.lp.frequency.cancelScheduledValues(now);
    this.lp.frequency.setValueAtTime(this.lp.frequency.value, now);
    this.lp.frequency.exponentialRampToValueAtTime(Math.max(60, hz), now + seconds);
    this.lp.Q.setTargetAtTime(lerp(0.4, 1.4, a), now, seconds * 0.4);
    this.peak.gain.setTargetAtTime(a * 5.5, now, seconds * 0.4);
  }

  get value(): number { return this.amount; }
  get cutoffHz(): number { return this.lp.frequency.value; }

  dispose(): void {
    try { this.input.disconnect(); } catch { /* noop */ }
    try { this.lp.disconnect(); } catch { /* noop */ }
    try { this.peak.disconnect(); } catch { /* noop */ }
    try { this.output.disconnect(); } catch { /* noop */ }
  }
}
