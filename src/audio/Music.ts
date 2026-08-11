/**
 * ============================================================================
 *  FOXY KART — ADAPTIVE PROCEDURAL SOUNDTRACK
 * ============================================================================
 *  Three fully composed themes, played by a synthesiser built from oscillators
 *  and baked drum buffers. Nothing is randomly generated: the chord
 *  progressions, bass lines, melodies and counter-melodies below are written
 *  out note by note, because a random-note generator sounds exactly like a
 *  random-note generator.
 *
 *  NOTATION
 *  --------
 *  Each part is an array of bar strings. A bar is 16 whitespace-separated
 *  tokens (one per sixteenth note):
 *      "D2  .  .  D2 .  . A2 .  D3 .  .  A2 .  . F#2 ."
 *  `.` is a rest, `-` extends the previous note by one sixteenth, anything else
 *  is a note name. Fewer than 16 tokens is fine — the bar is rest-padded.
 *
 *  TIMING
 *  ------
 *  A `setTimeout` loop wakes every 25 ms and schedules every note that starts
 *  within the next 150 ms against `ctx.currentTime`. JS timer jitter therefore
 *  never touches the music; the notes are sample-accurate. `setInterval` is
 *  never used for note timing.
 *
 *  ADAPTIVE LAYERING
 *  -----------------
 *  `setIntensity(v)` fades whole arrangement layers in and out:
 *      0.00  bass + kick        (the "cruising" groove)
 *      0.22  + full percussion
 *      0.45  + chord stabs
 *      0.62  + lead melody
 *      0.82  + counter-melody / marimba
 *
 *  FINAL LAP
 *  ---------
 *  A one-bar drum fill and a noise riser, then tempo +12 % and everything
 *  transposed up a whole tone. It is a cheap trick and it works every time.
 * ============================================================================
 */

import { clamp, clamp01, lerp } from '@/core/MathUtils';
import {
  Harmonics, Rand, cachedWave, chorus, fmPair, harmonicWave, makeShaper,
  noiseBuffer, noteToMidi, normalizeBuffer, perc, renderOffline, sweep, tone,
} from './Synth';

// ---------------------------------------------------------------------------
// Notation
// ---------------------------------------------------------------------------

interface Note {
  /** Absolute sixteenth-note index within the loop. */
  step: number;
  midi: number;
  /** Length in sixteenths. */
  steps: number;
  vel: number;
}

type DrumId = 'kick' | 'snare' | 'hat' | 'open' | 'clap' | 'tom' | 'shaker' | 'crash';

interface DrumNote { step: number; id: DrumId; vel: number; }

const DRUM_CHARS: Record<string, DrumId> = {
  k: 'kick', s: 'snare', h: 'hat', H: 'open', c: 'clap', t: 'tom', r: 'shaker', C: 'crash',
};

const STEPS_PER_BAR = 16;

function parseMelody(bars: readonly string[], vel = 1): Note[] {
  const out: Note[] = [];
  for (let b = 0; b < bars.length; b++) {
    const toks = bars[b].trim().split(/\s+/);
    let curIndex = -1;
    for (let i = 0; i < Math.min(toks.length, STEPS_PER_BAR); i++) {
      const tok = toks[i];
      if (tok === '.') { curIndex = -1; continue; }
      if (tok === '-') { if (curIndex >= 0) out[curIndex].steps++; continue; }
      out.push({ step: b * STEPS_PER_BAR + i, midi: noteToMidi(tok), steps: 1, vel });
      curIndex = out.length - 1;
    }
  }
  return out;
}

function parseDrums(bars: readonly string[]): DrumNote[] {
  const out: DrumNote[] = [];
  for (let b = 0; b < bars.length; b++) {
    const toks = bars[b].trim().split(/\s+/);
    for (let i = 0; i < Math.min(toks.length, STEPS_PER_BAR); i++) {
      const tok = toks[i];
      if (tok === '.') continue;
      for (const ch of tok) {
        const id = DRUM_CHARS[ch];
        if (!id) continue;
        // Downbeats and backbeats get a little more push.
        const accent = i % 4 === 0 ? 1.0 : i % 2 === 0 ? 0.85 : 0.7;
        out.push({ step: b * STEPS_PER_BAR + i, id, vel: accent });
      }
    }
  }
  return out;
}

function parseChords(bars: readonly string[]): number[][] {
  return bars.map((b) => b.trim().split(/\s+/).map(noteToMidi));
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export type ThemeId = 'coastal' | 'metro' | 'volcano';

interface Theme {
  id: ThemeId;
  name: string;
  bpm: number;
  bars: number;
  /** Chord voicing per bar. */
  chords: number[][];
  /** Sixteenth positions within a bar where the chord stabs land. */
  stabSteps: readonly number[];
  bass: Note[];
  lead: Note[];
  counter: Note[];
  /** Coastal-only FM marimba ostinato; empty elsewhere. */
  marimba: Note[];
  /** Two-bar core groove, tiled across the loop. */
  drumsA: DrumNote[];
  drumsB: DrumNote[];
  /** One-bar fill used for the last bar of the loop and the final-lap transition. */
  drumsFill: DrumNote[];
  /** Continuous sixteenth shaker layer (intensity >= 0.22). */
  shaker: DrumNote[];
  leadWave: 'lead' | 'brass' | 'saw' | 'square';
  bassCutoff: [number, number];
  /** Overall mix trim. */
  trim: number;
  /** Lead detune spread in cents — synthwave wants more. */
  leadSpread: number;
}

// ===========================================================================
//  THEME 1 — "SUNSET BAY"   Coastal.  D major, 152 BPM, 8 bars.
//  I - V - vi - IV | I - V - IV - V.  Bright, syncopated, island lilt.
// ===========================================================================

const COASTAL: Theme = {
  id: 'coastal',
  name: 'Sunset Bay',
  bpm: 152,
  bars: 8,
  chords: parseChords([
    'D4 F#4 A4', 'C#4 E4 A4', 'B3 D4 F#4', 'B3 D4 G4',
    'D4 F#4 A4', 'C#4 E4 A4', 'B3 D4 G4', 'C#4 E4 A4',
  ]),
  stabSteps: [2, 6, 10, 14],
  bass: parseMelody([
    'D2  .  .  D2 .  .  A2 .  D3 .  .  A2 .  . F#2 . ',
    'A2  .  .  A2 .  .  E3 .  A2 .  .  E3 .  . C#3 . ',
    'B2  .  .  B2 .  . F#2 .  B2 .  . F#2 .  .  A2 . ',
    'G2  .  .  G2 .  .  D3 .  G2 .  .  D3 .  .  A2 . ',
    'D2  .  .  D2 .  .  A2 .  D3 .  .  A2 .  . F#2 . ',
    'A2  .  .  A2 .  .  E3 .  A2 .  .  E3 .  . C#3 . ',
    'G2  .  .  G2 .  .  D3 .  G2 .  .  B2 .  .  D3 . ',
    'A2  .  .  A2 .  .  E3 . C#3 .  .  E3 .  A2 . A2 ',
  ], 0.95),
  lead: parseMelody([
    ' .   .   .   .  F#5 -   . E5  . D5  -   -   .   . A4  . ',
    'B4   -   -   .  D5  -   . E5  -  -   -   . C#5  . B4  . ',
    'D5   -   -   . F#5  -   . E5  . D5  -   . B4   -  .   . ',
    'G4   .  B4   .  D5  -   -  .  E5  -   . D5  .  B4  .   . ',
    'F#5  -   -   .  A5  -   . G5  . F#5 -   -   . E5  .   . ',
    'E5   -   . C#5  .  E5  -  -   . A5  -   -   -   .  .   . ',
    'G5   -   . F#5  .  E5  -  .  D5  -   . B4  .  D5  .   . ',
    'C#5  -   -   .  E5  -   -  .  A4  -   -   -   .  .  .   . ',
  ], 1.0),
  counter: parseMelody([
    ' .   .   .   .  D5  -   . C#5 . B4  -   -   .   .  .   . ',
    'G4   -   -   .  B4  -   . C#5 -  -   -   . A4   .  G4  . ',
    'B4   -   -   .  D5  -   . C#5 . B4  -   . G4   -  .   . ',
    'B3   .  D4   .  G4  -   -  .  C#5 -   . B4  .  G4  .   . ',
    'A4   -   -   .  D5  -   . B4  . A4  -   -   . C#5 .   . ',
    'C#5  -   . A4   .  C#5 -  -   . E5  -   -   -   .  .   . ',
    'B4   -   . A4   .  C#5 -  .  B4  -   . G4  .  B4  .   . ',
    'A4   -   -   . C#5  -   -  .  E4  -   -   -   .  .  .   . ',
  ], 0.62),
  marimba: parseMelody([
    'D5  . A5  . F#5 . A5  . D6  . A5  . F#5 . A5  . ',
    'C#5 . A5  . E5  . A5  . C#6 . A5  . E5  . A5  . ',
    'B4  . F#5 . D5  . F#5 . B5  . F#5 . D5  . F#5 . ',
    'G4  . D5  . B4  . D5  . G5  . D5  . B4  . D5  . ',
    'D5  . A5  . F#5 . A5  . D6  . A5  . F#5 . A5  . ',
    'C#5 . A5  . E5  . A5  . C#6 . A5  . E5  . A5  . ',
    'G4  . D5  . B4  . D5  . G5  . D5  . B4  . D5  . ',
    'C#5 . A5  . E5  . A5  . C#6 . E5  . A5  . E5  . ',
  ], 0.5),
  drumsA: parseDrums(['kh h  .  h  sh h  k  h  kh h  .  h  s  h  .  H ']),
  drumsB: parseDrums(['kh h  .  h  sh h  k  h  kh h  k  h  s  h  s  H ']),
  drumsFill: parseDrums(['k  h  s  s  t  t  s  s  k  t  t  s  s  C  .  . ']),
  shaker: parseDrums(['r r r r r r r r r r r r r r r r']),
  leadWave: 'lead',
  bassCutoff: [420, 1900],
  trim: 1.0,
  leadSpread: 9,
};

// ===========================================================================
//  THEME 2 — "NEON METROPOLIS"   Driving minor synthwave. A minor, 132 BPM.
//  i - VI - III - VII | i - VI - iv - V.  Pumping sixteenth bass, gated snare.
// ===========================================================================

const METRO: Theme = {
  id: 'metro',
  name: 'Neon Metropolis',
  bpm: 132,
  bars: 8,
  chords: parseChords([
    'A3 C4 E4', 'A3 C4 F4', 'G3 C4 E4', 'G3 B3 D4',
    'A3 C4 E4', 'A3 C4 F4', 'A3 D4 F4', 'G#3 B3 E4',
  ]),
  stabSteps: [0, 10],
  bass: parseMelody([
    'A1 A1  . A1 A1  . A1  . A1 A1  . A1 A2  . G1  . ',
    'F1 F1  . F1 F1  . F1  . F1 F1  . F1 F2  . E1  . ',
    'C2 C2  . C2 C2  . C2  . C2 C2  . C2 C3  . B1  . ',
    'G1 G1  . G1 G1  . G1  . G1 G1  . G1 G2  . A1  . ',
    'A1 A1  . A1 A1  . A1  . A1 A1  . A1 A2  . G1  . ',
    'F1 F1  . F1 F1  . F1  . F1 F1  . F1 F2  . E1  . ',
    'D2 D2  . D2 D2  . D2  . D2 D2  . D2 D3  . C2  . ',
    'E2 E2  . E2 E2  . E2  . E2 E2  . G#2 B2 . E2  . ',
  ], 1.0),
  lead: parseMelody([
    'E5  -  -  -   .  . A5  -  -  . G5  -  . E5  -  - ',
    'F5  -  -  -   .  . C6  -  -  . A5  -  . F5  -  - ',
    'E5  -  -  .  G5  -  . E5  . C5  -  -  . D5  -  . ',
    'D5  -  -  .  B4  -  . D5  . G5  -  -  -  .  .  . ',
    'A5  -  -  -   .  . E5  -  -  . C5  -  . A4  -  - ',
    'C6  -  -  -   .  . A5  -  -  . F5  -  . C5  -  - ',
    'D5  -  .  F5  .  A5 -  . D6  -  -  . A5  -  . F5 ',
    'E5  -  -  . G#5  -  . B5  -  -  -  .  .  .  .  . ',
  ], 1.0),
  counter: parseMelody([
    'A4  . C5  . E5  . C5  . A4  . C5  . E5  . C5  . ',
    'A4  . C5  . F5  . C5  . A4  . C5  . F5  . C5  . ',
    'G4  . C5  . E5  . C5  . G4  . C5  . E5  . C5  . ',
    'G4  . B4  . D5  . B4  . G4  . B4  . D5  . B4  . ',
    'A4  . C5  . E5  . C5  . A4  . C5  . E5  . C5  . ',
    'A4  . C5  . F5  . C5  . A4  . C5  . F5  . C5  . ',
    'A4  . D5  . F5  . D5  . A4  . D5  . F5  . D5  . ',
    'G#4 . B4  . E5  . B4  . G#4 . B4  . E5  . D5  . ',
  ], 0.5),
  marimba: [],
  drumsA: parseDrums(['kh h  h  h  sh h  h  h  kh h  h  h  sh h  h  H ']),
  drumsB: parseDrums(['kh h  h  h  sh h  h  h  kh h  k  h  sh h  s  H ']),
  drumsFill: parseDrums(['k  h  s  h  k  s  s  h  k  t  t  s  s  C  .  . ']),
  shaker: parseDrums(['r . r r . r r . r . r r . r r .']),
  leadWave: 'saw',
  bassCutoff: [300, 2400],
  trim: 0.98,
  leadSpread: 16,
};

// ===========================================================================
//  THEME 3 — "ASHFALL RIDGE"   Tense modal. E Phrygian, 158 BPM.
//  i - bII - i - bVII(Dm) ... resolving bII -> i, the Phrygian cadence.
//  The flat second is what makes this feel like something is wrong.
// ===========================================================================

const VOLCANO: Theme = {
  id: 'volcano',
  name: 'Ashfall Ridge',
  bpm: 158,
  bars: 8,
  chords: parseChords([
    'E3 G3 B3', 'F3 A3 C4', 'E3 G3 B3', 'D3 F3 A3',
    'E3 G3 B3', 'F3 A3 C4', 'D3 F3 A3', 'F3 A3 C4',
  ]),
  stabSteps: [0, 6, 12],
  bass: parseMelody([
    'E1  .  . E1  . E1  .  . E1  .  . E1  . E1  .  . ',
    'F1  .  . F1  . F1  .  . F1  .  . F1  . E1  .  . ',
    'E1  .  . E1  . E1  .  . E1  .  . G1  . E1  .  . ',
    'D1  .  . D1  . D1  .  . D1  .  . D1  . F1  .  . ',
    'E1  .  . E1  . E1  .  . E1  .  . E1  . E1  .  . ',
    'F1  .  . F1  . F1  .  . F1  .  . F1  . C2  .  . ',
    'D1  .  . D1  . D1  .  . D1  .  . A1  . D1  .  . ',
    'F1  .  . F1  . F1  .  . E1  -  -  -  .  .  .  . ',
  ], 1.0),
  lead: parseMelody([
    ' .   . B4  . E5  -  . G5  -  . F5  -  . E5  -  . ',
    'F5   -  -  . A5  -  . G5  . F5  -  -  . C5  -  . ',
    'E5   -  . G5  . B5  -  . A5  -  . G5  . E5  -  . ',
    'D5   -  -  . F5  -  . A5  -  -  . G5  -  . F5  . ',
    'E5   -  . B4  . E5  -  . G5  -  . B5  -  -  -  . ',
    'C6   -  -  . A5  -  . F5  -  . G5  -  . A5  -  . ',
    'D5   -  . F5  . A5  -  . D6  -  -  . C6  -  . A5 ',
    'F5   -  -  . E5  -  -  -  .  .  .  .  .  .  .  . ',
  ], 1.0),
  counter: parseMelody([
    'E4  -  -  -  .  . G4  -  . B4  -  -  .  .  .  . ',
    'F4  -  -  -  .  . A4  -  . C5  -  -  .  .  .  . ',
    'E4  -  -  . G4  -  . B4  -  . E5  -  -  .  .  . ',
    'D4  -  -  . F4  -  . A4  -  -  . D5  -  .  .  . ',
    'E4  -  -  -  .  . B4  -  . G4  -  -  .  .  .  . ',
    'F4  -  -  -  .  . C5  -  . A4  -  -  .  .  .  . ',
    'D4  -  . A4  . F4  -  . D5  -  -  . A4  -  .  . ',
    'F4  -  -  . E4  -  -  -  .  .  .  .  .  .  .  . ',
  ], 0.6),
  marimba: [],
  drumsA: parseDrums(['kt h  .  t  sh .  k  t  kh h  .  t  s  t  .  H ']),
  drumsB: parseDrums(['kt h  .  t  sh .  k  t  kh t  k  t  s  s  t  H ']),
  drumsFill: parseDrums(['t  t  s  t  k  t  s  s  t  t  s  s  k  C  .  . ']),
  shaker: parseDrums(['r . . r . r . . r . . r . r . .']),
  leadWave: 'square',
  bassCutoff: [260, 1600],
  trim: 1.02,
  leadSpread: 12,
};

export const THEMES: Record<ThemeId, Theme> = { coastal: COASTAL, metro: METRO, volcano: VOLCANO };
export const THEME_IDS: readonly ThemeId[] = ['coastal', 'metro', 'volcano'];

// ---------------------------------------------------------------------------
// Layer thresholds
// ---------------------------------------------------------------------------

const LAYER_THRESHOLDS = {
  groove: 0.0,   // bass + kick, always on
  perc: 0.22,
  chords: 0.45,
  lead: 0.62,
  counter: 0.82,
} as const;

type LayerId = keyof typeof LAYER_THRESHOLDS;
const LAYER_IDS: readonly LayerId[] = ['groove', 'perc', 'chords', 'lead', 'counter'];

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

export interface MusicOptions {
  dest: AudioNode;
  reverbSend?: AudioNode;
}

export class Music {
  private ctx: BaseAudioContext;
  private out: GainNode;
  private duckGain: GainNode;
  private buses: Record<LayerId, GainNode>;
  private drumBus: GainNode;
  private sendGain: GainNode | null = null;
  private leadChorus: ReturnType<typeof chorus> | null = null;
  private drums = new Map<DrumId, AudioBuffer>();
  private rng = new Rand(0x51ced);

  private theme: Theme = COASTAL;
  private pendingTheme: ThemeId | null = null;
  private intensity = 0;
  private targetIntensity = 0;
  private layerGain: Record<LayerId, number>;

  private playing = false;
  private timer: number | null = null;
  private step = 0;
  private nextStepTime = 0;
  private tempoScale = 1;
  private transpose = 0;

  private finalLap = false;
  private finalLapArmed = false;
  private fillBar = -1;
  private applyFinalAtStep = -1;

  private readonly lookahead = 0.15;
  private readonly tickMs = 25;

  /** Diagnostics for the dev harness. */
  scheduledNotes = 0;

  constructor(ctx: BaseAudioContext, o: MusicOptions) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1;
    this.out.connect(this.duckGain);
    this.duckGain.connect(o.dest);
    if (o.reverbSend) {
      this.sendGain = ctx.createGain();
      this.sendGain.gain.value = 0.18;
      this.duckGain.connect(this.sendGain);
      this.sendGain.connect(o.reverbSend);
    }

    const mkBus = (g: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = g;
      n.connect(this.out);
      return n;
    };
    this.buses = {
      groove: mkBus(1),
      perc: mkBus(0),
      chords: mkBus(0),
      lead: mkBus(0),
      counter: mkBus(0),
    };
    this.drumBus = mkBus(1);
    this.layerGain = { groove: 1, perc: 0, chords: 0, lead: 0, counter: 0 };
  }

  // -------------------------------------------------------------------------
  // Init — bake the drum kit
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    const sr = this.ctx.sampleRate;

    const bake = async (id: DrumId, seconds: number, build: (c: OfflineAudioContext, out: GainNode) => void, peak: number) => {
      try {
        const buf = await renderOffline(sr, 1, seconds, (c, out) => build(c, out));
        normalizeBuffer(buf, peak);
        this.drums.set(id, buf);
      } catch (err) {
        console.error(`[Music] drum bake "${id}" failed:`, err);
      }
    };

    await Promise.all([
      // Kick: pitch-swept sine plus a click for definition on small speakers.
      bake('kick', 0.5, (c, out) => {
        tone(c, out, 0, 0.4, { type: 'sine', freq: 155, freqEnd: 42, gain: 1.0, attack: 0.002, decay: 0.34 });
        tone(c, out, 0, 0.06, { type: 'triangle', freq: 320, freqEnd: 90, gain: 0.28, attack: 0.001, decay: 0.05 });
        const ws = makeShaper(c, 'soft', 0.35);
        ws.connect(out);
        tone(c, ws, 0, 0.2, { type: 'sine', freq: 62, gain: 0.5, attack: 0.003, decay: 0.18 });
      }, 0.95),

      // Snare: noise body + two tuned tones, the classic recipe.
      bake('snare', 0.4, (c, out) => {
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c, 'white', 0.5, 1, 801);
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
        const g = c.createGain(); g.gain.value = 0;
        perc(g.gain, 0, 0.85, 0.0015, 0.17);
        src.connect(bp); bp.connect(g); g.connect(out);
        src.start(0); src.stop(0.4);
        tone(c, out, 0, 0.13, { type: 'triangle', freq: 190, freqEnd: 160, gain: 0.4, attack: 0.001, decay: 0.11 });
        tone(c, out, 0, 0.1, { type: 'triangle', freq: 278, freqEnd: 240, gain: 0.26, attack: 0.001, decay: 0.09 });
        const hp = c.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 6000;
        const src2 = c.createBufferSource();
        src2.buffer = noiseBuffer(c, 'white', 0.3, 1, 802);
        const g2 = c.createGain(); g2.gain.value = 0;
        perc(g2.gain, 0, 0.3, 0.001, 0.06);
        src2.connect(hp); hp.connect(g2); g2.connect(out);
        src2.start(0); src2.stop(0.3);
      }, 0.9),

      // Closed hat: short, bright, band-limited noise. Must sit above 6 kHz.
      bake('hat', 0.14, (c, out) => {
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c, 'white', 0.2, 1, 803);
        const hp = c.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 7800; hp.Q.value = 0.8;
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 10500; bp.Q.value = 1.1;
        const g = c.createGain(); g.gain.value = 0;
        perc(g.gain, 0, 0.9, 0.0008, 0.045);
        src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(out);
        src.start(0); src.stop(0.14);
      }, 0.75),

      bake('open', 0.5, (c, out) => {
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c, 'white', 0.6, 1, 804);
        const hp = c.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 6800;
        const g = c.createGain(); g.gain.value = 0;
        perc(g.gain, 0, 0.8, 0.001, 0.38);
        src.connect(hp); hp.connect(g); g.connect(out);
        src.start(0); src.stop(0.5);
      }, 0.7),

      bake('clap', 0.3, (c, out) => {
        // Four closely-spaced bursts = the classic handclap smear.
        for (let i = 0; i < 4; i++) {
          const t = i * 0.011;
          const src = c.createBufferSource();
          src.buffer = noiseBuffer(c, 'white', 0.3, 1, 805 + i);
          const bp = c.createBiquadFilter();
          bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 1.4;
          const g = c.createGain(); g.gain.value = 0;
          perc(g.gain, t, i === 3 ? 0.8 : 0.45, 0.001, i === 3 ? 0.14 : 0.02);
          src.connect(bp); bp.connect(g); g.connect(out);
          src.start(t); src.stop(0.3);
        }
      }, 0.85),

      bake('tom', 0.32, (c, out) => {
        tone(c, out, 0, 0.26, { type: 'sine', freq: 260, freqEnd: 130, gain: 0.9, attack: 0.002, decay: 0.22 });
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c, 'white', 0.3, 1, 809);
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.8;
        const g = c.createGain(); g.gain.value = 0;
        perc(g.gain, 0, 0.3, 0.001, 0.08);
        src.connect(bp); bp.connect(g); g.connect(out);
        src.start(0); src.stop(0.32);
      }, 0.9),

      bake('shaker', 0.12, (c, out) => {
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c, 'white', 0.2, 1, 810);
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 6200; bp.Q.value = 1.6;
        const g = c.createGain(); g.gain.value = 0;
        perc(g.gain, 0, 0.7, 0.004, 0.05);
        src.connect(bp); bp.connect(g); g.connect(out);
        src.start(0); src.stop(0.12);
      }, 0.55),

      bake('crash', 1.4, (c, out) => {
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c, 'white', 1.6, 1, 811);
        const hp = c.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 4200;
        const g = c.createGain(); g.gain.value = 0;
        perc(g.gain, 0, 0.9, 0.004, 1.3);
        src.connect(hp); hp.connect(g); g.connect(out);
        src.start(0); src.stop(1.4);
        // a bit of metallic body so it isn't pure hiss
        for (const f of [3100, 4700, 6300]) {
          tone(c, out, 0, 1.1, { type: 'sine', freq: f, gain: 0.05, attack: 0.003, decay: 1.0 });
        }
      }, 0.8),
    ]);

    // One chorus unit for the whole lead bus.
    this.leadChorus = chorus(this.ctx, { voices: 3, baseDelay: 0.011, depth: 0.0035, rate: 0.42, mix: 0.45 });
    this.leadChorus.output.connect(this.buses.lead);
    this.leadChorus.start(this.ctx.currentTime);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  get isPlaying(): boolean { return this.playing; }
  get currentTheme(): ThemeId { return this.theme.id; }
  get bpm(): number { return this.theme.bpm * this.tempoScale; }
  get bar(): number { return Math.floor(this.step / STEPS_PER_BAR); }

  setTheme(id: ThemeId, immediate = false): void {
    if (!THEMES[id]) return;
    if (id === this.theme.id) return;
    if (immediate || !this.playing) {
      this.theme = THEMES[id];
      this.step = 0;
      this.pendingTheme = null;
      this.out.gain.value = this.theme.trim;
    } else {
      // Swap at the next loop boundary so we never cut a phrase in half.
      this.pendingTheme = id;
    }
  }

  start(): void {
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextStepTime = this.ctx.currentTime + 0.08;
    this.out.gain.value = this.theme.trim;
    this.pump();
  }

  stop(fadeSeconds = 0.4): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0.0001, t + Math.max(0.02, fadeSeconds));
  }

  setIntensity(v: number): void { this.targetIntensity = clamp01(v); }

  setDuck(v: number, seconds = 0.08): void {
    const t = this.ctx.currentTime;
    const g = this.duckGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(clamp(1 - v, 0.02, 1), t + Math.max(0.01, seconds));
  }

  /** Arm the final-lap transition: fill next bar, then tempo + transpose. */
  setFinalLap(on: boolean): void {
    if (on && !this.finalLap && !this.finalLapArmed) {
      this.finalLapArmed = true;
    } else if (!on) {
      this.finalLap = false;
      this.finalLapArmed = false;
      this.fillBar = -1;
      this.applyFinalAtStep = -1;
      this.tempoScale = 1;
      this.transpose = 0;
    }
  }

  get isFinalLap(): boolean { return this.finalLap; }

  /** Smooth the layer gains. Call from the render loop. */
  update(dt: number): void {
    this.intensity += (this.targetIntensity - this.intensity) * (1 - Math.exp(-dt / 0.5));
    for (const id of LAYER_IDS) {
      const thr = LAYER_THRESHOLDS[id];
      // 0.12 of intensity above the threshold to reach full level.
      const target = id === 'groove' ? 1 : clamp01((this.intensity - thr) / 0.12);
      const cur = this.layerGain[id];
      const next = cur + (target - cur) * (1 - Math.exp(-dt / 0.35));
      this.layerGain[id] = next;
      this.buses[id].gain.value = next;
    }
    // Drums live on their own bus but follow the percussion layer for
    // everything except the kick, which is scheduled on `groove`.
    this.drumBus.gain.value = 1;
  }

  // -------------------------------------------------------------------------
  // Look-ahead scheduler
  // -------------------------------------------------------------------------

  private pump = (): void => {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime + this.lookahead;
    let guard = 0;
    while (this.nextStepTime < horizon && guard++ < 256) {
      this.scheduleStep(this.step, this.nextStepTime);
      const secondsPerStep = 60 / (this.theme.bpm * this.tempoScale) / 4;
      this.nextStepTime += secondsPerStep;
      this.step++;
      const total = this.theme.bars * STEPS_PER_BAR;
      if (this.step >= total) {
        this.step = 0;
        if (this.pendingTheme) {
          this.theme = THEMES[this.pendingTheme];
          this.pendingTheme = null;
          this.out.gain.value = this.theme.trim;
        }
      }
      if (this.applyFinalAtStep >= 0 && this.step === this.applyFinalAtStep) {
        this.finalLap = true;
        this.finalLapArmed = false;
        this.tempoScale = 1.12;
        this.transpose = 2;
        this.applyFinalAtStep = -1;
        this.fillBar = -1;
      }
    }
    this.timer = window.setTimeout(this.pump, this.tickMs);
  };

  private scheduleStep(step: number, when: number): void {
    const theme = this.theme;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const inBar = step % STEPS_PER_BAR;
    const secondsPerStep = 60 / (theme.bpm * this.tempoScale) / 4;

    // --- final-lap arming: the fill lands on the next bar boundary ----------
    if (inBar === 0 && this.finalLapArmed && this.applyFinalAtStep < 0) {
      this.fillBar = bar;
      const total = theme.bars * STEPS_PER_BAR;
      this.applyFinalAtStep = ((bar + 1) * STEPS_PER_BAR) % total;
      this.riser(when, secondsPerStep * STEPS_PER_BAR);
    }

    const L = this.layerGain;
    const isFill = bar === this.fillBar;

    // --- drums -------------------------------------------------------------
    // The kick and the backbeat snare belong to the base groove; hats, toms,
    // shaker and crashes only appear once the percussion layer is up.
    const pattern = isFill ? theme.drumsFill : (bar % 2 === 0 ? theme.drumsA : theme.drumsB);
    const patternLen = STEPS_PER_BAR;
    for (const d of pattern) {
      if (d.step % patternLen !== inBar) continue;
      const isCore = d.id === 'kick' || d.id === 'snare';
      const layer: LayerId = isCore ? 'groove' : 'perc';
      if (L[layer] < 0.02) continue;
      this.drum(d.id, when, d.vel * (isFill ? 1.05 : 1), layer);
    }
    if (L.perc > 0.02 && !isFill) {
      for (const d of theme.shaker) {
        if (d.step % patternLen !== inBar) continue;
        this.drum('shaker', when, d.vel * 0.5, 'perc');
      }
    }

    // --- bass --------------------------------------------------------------
    for (const n of theme.bass) {
      if (n.step !== step) continue;
      this.bassNote(when, n.midi + this.transpose, n.steps * secondsPerStep, n.vel);
    }

    // --- chord stabs -------------------------------------------------------
    if (L.chords > 0.02 && !isFill) {
      for (const s of theme.stabSteps) {
        if (s !== inBar) continue;
        const chord = theme.chords[bar % theme.chords.length];
        this.stab(when, chord, secondsPerStep * 2.2, 0.8);
      }
    }

    // --- lead --------------------------------------------------------------
    if (L.lead > 0.02) {
      for (const n of theme.lead) {
        if (n.step !== step) continue;
        this.leadNote(when, n.midi + this.transpose, n.steps * secondsPerStep, n.vel);
      }
    }

    // --- counter-melody / marimba -----------------------------------------
    if (L.counter > 0.02) {
      for (const n of theme.counter) {
        if (n.step !== step) continue;
        this.counterNote(when, n.midi + this.transpose, n.steps * secondsPerStep, n.vel);
      }
      for (const n of theme.marimba) {
        if (n.step !== step) continue;
        this.marimbaNote(when, n.midi + this.transpose, n.vel);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  private drum(id: DrumId, when: number, vel: number, layer: LayerId): void {
    const buf = this.drums.get(id);
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Humanise: a couple of percent of pitch keeps a 16th hat pattern alive.
    src.detune.value = this.rng.bi() * (id === 'hat' || id === 'shaker' ? 140 : 45);
    const g = ctx.createGain();
    const level: Record<DrumId, number> = {
      kick: 0.85, snare: 0.5, hat: 0.2, open: 0.2, clap: 0.32, tom: 0.4, shaker: 0.13, crash: 0.3,
    };
    g.gain.value = level[id] * vel * (0.92 + this.rng.next() * 0.16);
    src.connect(g);
    g.connect(layer === 'groove' ? this.buses.groove : this.buses.perc);
    src.start(when);
    src.stop(when + buf.duration + 0.02);
    src.onended = () => { src.onended = null; try { src.disconnect(); } catch { /* noop */ } try { g.disconnect(); } catch { /* noop */ } };
  }

  /** Filtered saw + sub sine, with a filter envelope. The engine of the groove. */
  private bassNote(when: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    const [lo, hi] = this.theme.bassCutoff;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 4.2;
    lp.frequency.setValueAtTime(hi, when);
    lp.frequency.exponentialRampToValueAtTime(Math.max(60, lo), when + Math.min(0.22, dur * 0.9));
    const g = ctx.createGain();
    g.gain.value = 0;
    const hold = Math.max(0.03, dur * 0.82);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.42 * vel, when + 0.006);
    g.gain.setValueAtTime(0.42 * vel, when + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, when + hold + 0.05);

    const shaper = makeShaper(ctx, 'tube', 0.3);
    lp.connect(shaper);
    shaper.connect(g);
    g.connect(this.buses.groove);

    const oscs: OscillatorNode[] = [];
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(cachedWave(ctx, 'msaw', () => harmonicWave(ctx, Harmonics.saw(16))));
      o.frequency.value = hz;
      o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = hz * 0.5;
    const subg = ctx.createGain();
    subg.gain.value = 0.55;
    sub.connect(subg); subg.connect(g);
    oscs.push(sub);

    const end = when + hold + 0.1;
    for (const o of oscs) { o.start(when); o.stop(end); }
    oscs[0].onended = () => {
      for (const o of oscs) { try { o.disconnect(); } catch { /* noop */ } }
      for (const n of [lp, shaper, g, subg]) { try { n.disconnect(); } catch { /* noop */ } }
    };
    this.scheduledNotes++;
  }

  private leadWaveFor(): PeriodicWave {
    const ctx = this.ctx;
    switch (this.theme.leadWave) {
      case 'brass': return cachedWave(ctx, 'mbrass', () => harmonicWave(ctx, Harmonics.brass(22)));
      case 'saw': return cachedWave(ctx, 'msaw', () => harmonicWave(ctx, Harmonics.saw(16)));
      case 'square': return cachedWave(ctx, 'modd', () => harmonicWave(ctx, Harmonics.odd(13)));
      default: return cachedWave(ctx, 'mlead', () => harmonicWave(ctx, Harmonics.lead(18)));
    }
  }

  private leadNote(when: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    const wave = this.leadWaveFor();
    const spread = this.theme.leadSpread;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(hz * 9, 1200, 12000);
    lp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.value = 0;
    const hold = Math.max(0.05, dur * 0.86);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.3 * vel, when + 0.012);
    g.gain.linearRampToValueAtTime(0.24 * vel, when + Math.min(hold, 0.09));
    g.gain.setValueAtTime(0.24 * vel, when + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, when + hold + 0.09);
    lp.connect(g);
    g.connect(this.leadChorus ? this.leadChorus.input : this.buses.lead);

    const oscs: OscillatorNode[] = [];
    for (const det of [-spread, spread]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.frequency.value = hz;
      o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    const end = when + hold + 0.15;
    for (const o of oscs) { o.start(when); o.stop(end); }
    oscs[0].onended = () => {
      for (const o of oscs) { try { o.disconnect(); } catch { /* noop */ } }
      try { lp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
    this.scheduledNotes++;
  }

  private counterNote(when: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    const o = ctx.createOscillator();
    o.setPeriodicWave(cachedWave(ctx, 'mtri', () => harmonicWave(ctx, Harmonics.odd(7, 1.6))));
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = 0;
    const hold = Math.max(0.04, dur * 0.8);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.26 * vel, when + 0.02);
    g.gain.setValueAtTime(0.26 * vel, when + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, when + hold + 0.08);
    o.connect(g);
    g.connect(this.buses.counter);
    o.start(when);
    o.stop(when + hold + 0.12);
    o.onended = () => {
      try { o.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
    this.scheduledNotes++;
  }

  /** FM marimba / steel drum — the coastal signature. */
  private marimbaNote(when: number, midi: number, vel: number): void {
    const ctx = this.ctx;
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    const pair = fmPair(ctx, {
      carrierHz: hz, ratio: 4.0, index: 1.8, indexDecay: 0.06, carrierType: 'sine',
    });
    const g = ctx.createGain();
    g.gain.value = 0;
    perc(g.gain, when, 0.24 * vel, 0.003, 0.34);
    pair.out.connect(g);
    g.connect(this.buses.counter);
    pair.start(when);
    pair.stop(when + 0.45);
    pair.carrier.onended = () => {
      try { pair.carrier.disconnect(); } catch { /* noop */ }
      try { pair.mod.disconnect(); } catch { /* noop */ }
      try { pair.modGain.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
    this.scheduledNotes++;
  }

  /** Detuned saw pad stab — three notes, two oscillators each. */
  private stab(when: number, chord: readonly number[], dur: number, vel: number): void {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200, when);
    lp.frequency.exponentialRampToValueAtTime(1300, when + dur);
    lp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.value = 0;
    perc(g.gain, when, 0.2 * vel, 0.008, dur);
    lp.connect(g);
    g.connect(this.buses.chords);

    const wave = cachedWave(ctx, 'msaw', () => harmonicWave(ctx, Harmonics.saw(16)));
    const oscs: OscillatorNode[] = [];
    for (const midi of chord) {
      const hz = 440 * Math.pow(2, (midi + this.transpose - 69) / 12);
      for (const det of [-11, 11]) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(wave);
        o.frequency.value = hz;
        o.detune.value = det;
        o.connect(lp);
        oscs.push(o);
      }
    }
    const end = when + dur + 0.1;
    for (const o of oscs) { o.start(when); o.stop(end); }
    if (oscs.length) {
      oscs[0].onended = () => {
        for (const o of oscs) { try { o.disconnect(); } catch { /* noop */ } }
        try { lp.disconnect(); } catch { /* noop */ }
        try { g.disconnect(); } catch { /* noop */ }
      };
    }
    this.scheduledNotes++;
  }

  /** Rising noise sweep under the final-lap fill. */
  private riser(when: number, dur: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 'white', Math.max(1.2, dur + 0.3), 1, 820);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    sweep(bp.frequency, when, 500, 8000, dur);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.34, when + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.06);
    src.connect(bp); bp.connect(g); g.connect(this.buses.perc);
    src.start(when);
    src.stop(when + dur + 0.15);
    // rising pitch layer for extra lift
    const o = ctx.createOscillator();
    o.setPeriodicWave(cachedWave(ctx, 'msaw', () => harmonicWave(ctx, Harmonics.saw(16))));
    const og = ctx.createGain();
    og.gain.value = 0;
    sweep(o.frequency, when, 180, 1400, dur);
    og.gain.setValueAtTime(0.0001, when);
    og.gain.exponentialRampToValueAtTime(0.12, when + dur * 0.9);
    og.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.06);
    o.connect(og); og.connect(this.buses.perc);
    o.start(when); o.stop(when + dur + 0.15);
    src.onended = () => {
      for (const n of [src, bp, g, o, og]) { try { n.disconnect(); } catch { /* noop */ } }
    };
  }

  // -------------------------------------------------------------------------

  debug(): {
    theme: ThemeId; name: string; bpm: number; bar: number; step: number;
    intensity: number; layers: Record<LayerId, number>; finalLap: boolean;
    transpose: number; drumsBaked: number; notes: number;
  } {
    return {
      theme: this.theme.id,
      name: this.theme.name,
      bpm: this.bpm,
      bar: this.bar,
      step: this.step,
      intensity: this.intensity,
      layers: { ...this.layerGain },
      finalLap: this.finalLap,
      transpose: this.transpose,
      drumsBaked: this.drums.size,
      notes: this.scheduledNotes,
    };
  }

  drumBuffer(id: DrumId): AudioBuffer | undefined { return this.drums.get(id); }
  static drumIds(): readonly DrumId[] {
    return ['kick', 'snare', 'hat', 'open', 'clap', 'tom', 'shaker', 'crash'];
  }

  /** Note-count sanity check used by the harness — proves content exists. */
  static themeStats(id: ThemeId): {
    name: string; bpm: number; bars: number; bass: number; lead: number;
    counter: number; marimba: number; chords: number; drums: number;
  } {
    const t = THEMES[id];
    return {
      name: t.name, bpm: t.bpm, bars: t.bars,
      bass: t.bass.length, lead: t.lead.length, counter: t.counter.length,
      marimba: t.marimba.length, chords: t.chords.length,
      drums: t.drumsA.length + t.drumsB.length,
    };
  }

  dispose(): void {
    this.stop(0.05);
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.leadChorus?.stop(this.ctx.currentTime);
    for (const id of LAYER_IDS) { try { this.buses[id].disconnect(); } catch { /* noop */ } }
    try { this.drumBus.disconnect(); } catch { /* noop */ }
    try { this.out.disconnect(); } catch { /* noop */ }
    try { this.duckGain.disconnect(); } catch { /* noop */ }
    if (this.sendGain) { try { this.sendGain.disconnect(); } catch { /* noop */ } }
    this.drums.clear();
  }
}

void lerp;
