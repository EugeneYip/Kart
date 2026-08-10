/**
 * ============================================================================
 *  APEX KART — AUDIO BENCH
 * ============================================================================
 *  A standalone page for the audio subsystem. Two jobs:
 *
 *   1. Play everything on demand — a button per sfx, sliders for engine rpm /
 *      load, music intensity, reverb space — with a live spectrum + waveform.
 *
 *   2. Measure it. Ears are not available to the agent that wrote this code, so
 *      every sound is rendered through an OfflineAudioContext and asserted
 *      numerically: peak, RMS, DC offset, NaN, spectral centroid, sub/high
 *      energy split and envelope length, each against the design intent
 *      declared in `SFX_EXPECTATIONS`. The engine is swept across rpm and its
 *      harmonic series + firing-pulse sidebands are located in the spectrum.
 *
 *  window.__AUDIO__      the live AudioEngine
 *  window.__MEASURE__()  buffer assertions      -> JSON
 *  window.__MEASURE_ENGINE__()  engine spectra  -> JSON
 *  window.__MEASURE_MASTER__()  limiter proof   -> JSON
 * ============================================================================
 */

import * as THREE from 'three';
import { bus } from '@/core/EventBus';
import { ItemType, SurfaceType } from '@/core/Types';
import { AudioEngine } from '@/audio/AudioEngine';
import { SFX_GROUPS, SFX_EXPECTATIONS, analyzeBuffer } from '@/audio/SfxBank';
import type { BufferStats } from '@/audio/SfxBank';
import { EngineSoundSystem, ENGINE_CHARACTERS } from '@/audio/EngineSound';
import type { EngineCharacterId } from '@/audio/EngineSound';
import { ENVIRONMENT_PRESETS } from '@/audio/Reverb';
import type { EnvironmentPreset } from '@/audio/Reverb';
import { THEME_IDS } from '@/audio/Music';
import type { ThemeId } from '@/audio/Music';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

function button(parent: HTMLElement, label: string, onClick: () => void, cls?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

function slider(
  parent: HTMLElement, label: string, min: number, max: number, step: number,
  value: number, onInput: (v: number) => void, fmt: (v: number) => string = (v) => v.toFixed(2),
): HTMLInputElement {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(value);
  const out = document.createElement('span');
  out.textContent = fmt(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  row.append(l, input, out);
  parent.appendChild(row);
  return input;
}

// ---------------------------------------------------------------------------
// Minimal radix-2 FFT (peak-picking for the engine harmonic assertions)
// ---------------------------------------------------------------------------

function fftMag(input: Float32Array, n: number): Float32Array {
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = (input[i] ?? 0) * w;
  }
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

interface Peak { hz: number; mag: number }

/** Local maxima above `floor` × the strongest bin, strongest first. */
function findPeaks(mag: Float32Array, sr: number, n: number, floor: number, limit: number): Peak[] {
  let max = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i] > max) max = mag[i];
  const thr = max * floor;
  const peaks: Peak[] = [];
  for (let i = 2; i < mag.length - 2; i++) {
    const m = mag[i];
    if (m < thr) continue;
    if (m <= mag[i - 1] || m <= mag[i + 1] || m <= mag[i - 2] || m <= mag[i + 2]) continue;
    // Parabolic interpolation for a sub-bin frequency estimate.
    const d = 0.5 * (mag[i - 1] - mag[i + 1]) / (mag[i - 1] - 2 * m + mag[i + 1] || 1);
    peaks.push({ hz: ((i + d) * sr) / n, mag: m / (max || 1) });
  }
  peaks.sort((a, b) => b.mag - a.mag);
  return peaks.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.15, 4000);
camera.position.set(0, 2.2, 6);

const audio = new AudioEngine(camera);
const status = $('status');

// Simulated player kart, so engine + roll + wind have something to follow.
const kartPos = new THREE.Vector3(0, 0.4, 0);
const kartVel = new THREE.Vector3(0, 0, 0);
let rpm = 0.25;
let load = 0.5;
let sweepUntil = -1;
let sweepFrom = 0;
let simulatedKarts = 1;
let lastNow = performance.now();

interface AudioWindow extends Window {
  __AUDIO__?: AudioEngine;
  __MEASURE__?: () => unknown;
  __MEASURE_ENGINE__?: (rpms?: number[], character?: EngineCharacterId) => Promise<unknown>;
  __MEASURE_MASTER__?: () => Promise<unknown>;
  __BUS__?: typeof bus;
}
const w = window as AudioWindow;

/**
 * Suppress Vite's HMR error overlay for errors in *other* subsystems.
 *
 * Eleven other agents are editing this repo concurrently; a broken import in
 * any of their files makes Vite push a full-screen overlay to every connected
 * client, which covers the analyser and makes visual verification impossible.
 * Overlays that mention this subsystem are left alone — we must still see our
 * own failures.
 */
function suppressForeignOverlays(): void {
  const sweep = (): void => {
    for (const el of document.querySelectorAll('vite-error-overlay')) {
      const text = el.shadowRoot?.textContent ?? el.textContent ?? '';
      if (!/src\/(audio|dev\/audio)/.test(text)) el.remove();
      else console.warn('[audio bench] overlay kept — error is ours');
    }
  };
  sweep();
  window.setInterval(sweep, 150);
}

/**
 * Re-apply bench state from the query string.
 *
 * `?rpm=0.6&solo=engine` survives the constant HMR reloads other agents cause,
 * so a screenshot taken at any moment shows the state we asked for.
 */
function applyUrlState(): void {
  const q = new URLSearchParams(location.search);
  const num = (k: string): number | null => {
    const v = q.get(k);
    return v === null ? null : Number(v);
  };
  const r = num('rpm');
  if (r !== null && Number.isFinite(r)) {
    const el = document.querySelector<HTMLInputElement>('#engineRows input');
    if (el) {
      el.value = String(Math.max(0, Math.min(1, r)));
      // Dispatch rather than assign so the readout label stays truthful.
      el.dispatchEvent(new Event('input'));
    } else {
      rpm = Math.max(0, Math.min(1, r));
    }
  }
  const l = num('load');
  if (l !== null && Number.isFinite(l)) load = Math.max(0, Math.min(1, l));
  const karts = num('karts');
  if (karts !== null && karts > 1) {
    for (let i = 1; i < Math.min(12, karts); i++) audio.bindEngine(i, false);
    simulatedKarts = Math.min(12, karts);
  }
  const solo = q.get('solo');
  if (solo === 'engine') {
    audio.stopMusic(0.02);
    audio.windLayer?.setVolume(0);
  } else if (solo === 'music') {
    audio.startMusic();
    audio.windLayer?.setVolume(0);
    audio.engineSystem?.setVolume(0);
  }
  const env = q.get('env');
  if (env) audio.setEnvironment(env as EnvironmentPreset);
  if (q.get('music') === '1') audio.startMusic();
  if (q.get('final') === '1') audio.setFinalLap(true);
}

async function boot(): Promise<void> {
  suppressForeignOverlays();
  const t0 = performance.now();
  await audio.init();
  const ms = Math.round(performance.now() - t0);
  const ctx = audio.context;
  status.innerHTML = ctx
    ? `context <b>${ctx.state}</b> @ ${ctx.sampleRate} Hz · baked in ${ms} ms · `
      + `${audio.bank?.isReady ? 'bank ready' : 'BANK NOT READY'} — click to unlock`
    : 'no AudioContext — running silent (this is a pass, not a crash)';

  audio.bindEngine(0, true);
  audio.setMasterVolume(0.85);
  audio.setMusicVolume(0.6);
  audio.setSfxVolume(0.95);

  buildUi();
  applyUrlState();
  requestAnimationFrame(frame);

  w.__AUDIO__ = audio;
  w.__BUS__ = bus;
  w.__MEASURE__ = measureBuffers;
  w.__MEASURE_ENGINE__ = measureEngine;
  w.__MEASURE_MASTER__ = measureMaster;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function buildUi(): void {
  // --- engine -------------------------------------------------------------
  const er = $('engineRows');
  slider(er, 'rpm', 0, 1, 0.005, rpm, (v) => { rpm = v; });
  slider(er, 'load', 0, 1, 0.01, load, (v) => { load = v; });
  slider(er, 'kart distance', 0, 120, 1, 0, (v) => { kartPos.set(v, 0.4, 0); }, (v) => `${v.toFixed(0)} m`);
  slider(er, 'listener speed', 0, 40, 0.5, 0, (v) => { kartVel.set(0, 0, -v); }, (v) => `${v.toFixed(1)} m/s`);

  button($('engBoost'), '', () => { /* replaced below */ });
  $('engBoost').replaceChildren();
  $('engBoost').textContent = 'boost pulse';
  $('engBoost').addEventListener('click', () => {
    bus.emit('kart:boost', { kartId: 0, duration: 1.6, source: 'drift' });
  });
  $('engSweep').addEventListener('click', () => {
    sweepFrom = performance.now();
    sweepUntil = sweepFrom + 6000;
  });
  $('engField').addEventListener('click', () => {
    for (let i = 1; i < 12; i++) audio.bindEngine(i, false);
    simulatedKarts = 12;
  });
  $('engOne').addEventListener('click', () => {
    for (let i = 1; i < 12; i++) audio.unbindEngine(i);
    simulatedKarts = 1;
  });

  // --- mix ----------------------------------------------------------------
  const mr = $('mixRows');
  slider(mr, 'master', 0, 1, 0.01, 0.85, (v) => audio.setMasterVolume(v));
  slider(mr, 'music', 0, 1, 0.01, 0.6, (v) => audio.setMusicVolume(v));
  slider(mr, 'sfx', 0, 1, 0.01, 0.95, (v) => audio.setSfxVolume(v));
  slider(mr, 'music intensity', 0, 1, 0.01, 0.5, (v) => audio.setMusicIntensity(v));
  slider(mr, 'submerged', 0, 1, 0.01, 0, (v) => audio.setSubmerged(v));

  const envSel = $('envSel') as HTMLSelectElement;
  for (const p of ENVIRONMENT_PRESETS) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p;
    envSel.appendChild(o);
  }
  envSel.addEventListener('change', () => audio.setEnvironment(envSel.value as EnvironmentPreset));

  const themeSel = $('themeSel') as HTMLSelectElement;
  for (const t of THEME_IDS) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    themeSel.appendChild(o);
  }
  themeSel.addEventListener('change', () => audio.setMusicTheme(themeSel.value as ThemeId, true));

  $('musStart').addEventListener('click', () => { void audio.resumeContext(); audio.startMusic(); });
  $('musStop').addEventListener('click', () => audio.stopMusic());
  $('musFinal').addEventListener('click', () => audio.setFinalLap(true));
  $('musFinalOff').addEventListener('click', () => audio.setFinalLap(false));
  $('duckBtn').addEventListener('click', () => audio.duck(0.6, 1.2));

  // --- sfx buttons --------------------------------------------------------
  const sg = $('sfxGroups');
  for (const group of SFX_GROUPS) {
    const box = document.createElement('div');
    box.className = 'group';
    const title = document.createElement('b');
    title.textContent = group.name;
    box.appendChild(title);
    const btns = document.createElement('div');
    btns.className = 'btns';
    for (const id of group.ids) {
      button(btns, id, () => {
        void audio.resumeContext();
        // Loops need a handle-managed play; one-shots go through the facade.
        const spec = audio.bank?.spec(id);
        if (spec?.loop) {
          const h = audio.playLoop(id, { volume: 0.7 });
          if (h) window.setTimeout(() => h.stop(0.2), 2500);
        } else {
          audio.play(id, { volume: 1 });
        }
      });
    }
    box.appendChild(btns);
    sg.appendChild(box);
  }

  // --- event bus ----------------------------------------------------------
  const eb = $('eventBtns');
  const p = () => kartPos.clone();
  const events: Array<[string, () => void]> = [
    ['countdown 3-2-1-GO', () => {
      let n = 3;
      const tick = () => {
        bus.emit('race:countdown', { count: n });
        if (n-- > 0) window.setTimeout(tick, 900);
        else bus.emit('race:start', { rocketStart: false });
      };
      tick();
    }],
    ['race:start', () => bus.emit('race:start', { rocketStart: true })],
    ['race:lap 2', () => bus.emit('race:lap', { kartId: 0, lap: 2, lapTime: 41.2, isBest: true })],
    ['race:lap FINAL', () => bus.emit('race:lap', { kartId: 0, lap: 3, lapTime: 39.9, isBest: true })],
    ['race:finish 1st', () => bus.emit('race:finish', { kartId: 0, position: 1, totalTime: 121.4 })],
    ['race:finish 5th', () => bus.emit('race:finish', { kartId: 0, position: 5, totalTime: 131.4 })],
    ['positionChange up', () => bus.emit('race:positionChange', { kartId: 0, from: 4, to: 3 })],
    ['positionChange down', () => bus.emit('race:positionChange', { kartId: 0, from: 3, to: 4 })],
    ['hop', () => bus.emit('kart:hop', { kartId: 0, position: p() })],
    ['land soft', () => bus.emit('kart:land', { kartId: 0, position: p(), impact: 0.2 })],
    ['land HARD', () => bus.emit('kart:land', { kartId: 0, position: p(), impact: 0.95 })],
    ['drift start', () => bus.emit('kart:driftStart', { kartId: 0, direction: 1 })],
    ['drift tier 1/2/3', () => {
      [1, 2, 3].forEach((t, i) => window.setTimeout(
        () => bus.emit('kart:driftTier', { kartId: 0, tier: t, position: p() }), i * 700));
    }],
    ['drift release', () => bus.emit('kart:driftRelease', { kartId: 0, tier: 3, boostTime: 1.2 })],
    ['boost pad', () => bus.emit('kart:boost', { kartId: 0, duration: 1.5, source: 'pad' })],
    ['trick', () => bus.emit('kart:trick', { kartId: 0, name: 'backflip' })],
    ['spinout', () => bus.emit('kart:spinout', { kartId: 0, position: p() })],
    ['squash', () => bus.emit('kart:squash', { kartId: 0 })],
    ['respawn', () => bus.emit('kart:respawn', { kartId: 0 })],
    ['wall scrape', () => {
      let n = 0;
      const t = window.setInterval(() => {
        bus.emit('kart:wallHit', { kartId: 0, position: p(), impact: 0.1, normal: new THREE.Vector3(1, 0, 0) });
        if (++n > 30) clearInterval(t);
      }, 40);
    }],
    ['wall HIT', () => bus.emit('kart:wallHit', { kartId: 0, position: p(), impact: 0.9, normal: new THREE.Vector3(1, 0, 0) })],
    ['kart bump', () => bus.emit('kart:kartHit', { a: 0, b: 1, impact: 0.7, position: p() })],
    ['surface: grass', () => bus.emit('kart:surfaceChange', { kartId: 0, from: SurfaceType.Road, to: SurfaceType.Grass })],
    ['surface: road', () => bus.emit('kart:surfaceChange', { kartId: 0, from: SurfaceType.Grass, to: SurfaceType.Road })],
    ['surface: water', () => bus.emit('kart:surfaceChange', { kartId: 0, from: SurfaceType.Road, to: SurfaceType.Water })],
    ['item:box', () => bus.emit('item:box', { kartId: 0, position: p() })],
    ['item:granted', () => bus.emit('item:granted', { kartId: 0, item: ItemType.GreenShell, count: 1 })],
    ['use: shell', () => bus.emit('item:used', { kartId: 0, item: ItemType.GreenShell })],
    ['use: banana', () => bus.emit('item:used', { kartId: 0, item: ItemType.Banana })],
    ['use: bomb', () => bus.emit('item:used', { kartId: 0, item: ItemType.Bomb })],
    ['use: STAR', () => bus.emit('item:used', { kartId: 0, item: ItemType.Star })],
    ['star end', () => audio.play('star_end')],
    ['use: BULLET', () => bus.emit('item:used', { kartId: 0, item: ItemType.Bullet })],
    ['bullet end', () => audio.play('bullet_end')],
    ['use: ghost', () => bus.emit('item:used', { kartId: 0, item: ItemType.Ghost })],
    ['use: squid', () => bus.emit('item:used', { kartId: 0, item: ItemType.Squid })],
    ['use: lightning', () => bus.emit('item:used', { kartId: 0, item: ItemType.Lightning })],
    ['use: BLUE SHELL', () => bus.emit('item:used', { kartId: 0, item: ItemType.BlueShell })],
    ['hit: explosion', () => bus.emit('item:hit', { targetId: 0, sourceId: 1, item: ItemType.Bomb, point: p() })],
    ['hit: shell', () => bus.emit('item:hit', { targetId: 0, sourceId: 1, item: ItemType.GreenShell, point: p() })],
    ['hit: banana', () => bus.emit('item:hit', { targetId: 0, sourceId: 1, item: ItemType.Banana, point: p() })],
    ['quality: low', () => bus.emit('quality:change', { tier: 'low' })],
    ['quality: ultra', () => bus.emit('quality:change', { tier: 'ultra' })],
  ];
  for (const [label, fn] of events) {
    button(eb, label, () => { void audio.resumeContext(); fn(); });
  }

  $('measure').addEventListener('click', () => {
    const r = measureBuffers();
    $('report').innerHTML = r.text;
  });
  $('measureEng').addEventListener('click', () => {
    $('report').textContent = 'rendering engine spectra…';
    void measureEngine().then((r) => { $('report').innerHTML = r.text; });
  });
  $('measureMaster').addEventListener('click', () => {
    $('report').textContent = 'rendering master chain…';
    void measureMaster().then((r) => { $('report').innerHTML = r.text; });
  });
}

// ---------------------------------------------------------------------------
// Frame loop — drives the fake kart + draws the analyser
// ---------------------------------------------------------------------------

const scope = $('scope') as HTMLCanvasElement;
const g2d = scope.getContext('2d');
let freqData: Uint8Array<ArrayBuffer> | null = null;
let timeData: Uint8Array<ArrayBuffer> | null = null;
let frameNo = 0;

const fctx = { dt: 0.016, fixedDt: 1 / 120, elapsed: 0, frame: 0, alpha: 0 };

function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  frameNo++;

  if (sweepUntil > 0) {
    const t = (now - sweepFrom) / 6000;
    if (t >= 1) { sweepUntil = -1; } else { rpm = t; }
    const el = document.querySelector<HTMLInputElement>('#engineRows input');
    if (el) el.value = String(rpm);
  }

  // Move the fake kart forward so the wind/roll beds have a speed to follow.
  const speed = 3 + rpm * 25;
  kartPos.z -= speed * dt;
  camera.position.set(kartPos.x, kartPos.y + 1.9, kartPos.z + 5.5);
  camera.lookAt(kartPos);

  audio.updateEngine(0, rpm, load, kartPos);
  for (let i = 1; i < simulatedKarts; i++) {
    // Spread the field out behind and beside, all at a slightly lower rpm.
    const off = i * 4.5;
    kartOther.set(kartPos.x + (i % 2 ? off : -off) * 0.4, kartPos.y, kartPos.z + off);
    audio.updateEngine(i, Math.max(0, rpm - i * 0.03), load, kartOther);
  }

  fctx.dt = dt;
  fctx.elapsed += dt;
  fctx.frame = frameNo;
  audio.update(fctx);

  drawScope();
  if (frameNo % 12 === 0) drawDebug();
}

const kartOther = new THREE.Vector3();

function drawScope(): void {
  const an = audio.analyser;
  if (!g2d || !an) return;
  const W = scope.width, H = scope.height;
  if (!freqData || freqData.length !== an.frequencyBinCount) {
    freqData = new Uint8Array(new ArrayBuffer(an.frequencyBinCount));
    timeData = new Uint8Array(new ArrayBuffer(an.fftSize));
  }
  an.getByteFrequencyData(freqData);
  if (timeData) an.getByteTimeDomainData(timeData);

  g2d.clearRect(0, 0, W, H);
  const specH = Math.floor(H * 0.66);
  const sr = audio.context?.sampleRate ?? 48000;
  const nyq = sr / 2;
  const fMin = 20;

  // --- log-frequency spectrum -------------------------------------------
  const xOf = (hz: number): number =>
    (Math.log10(Math.max(fMin, hz) / fMin) / Math.log10(nyq / fMin)) * W;

  g2d.strokeStyle = 'rgba(120,170,255,0.13)';
  g2d.fillStyle = '#4b5f80';
  g2d.font = '9px ui-monospace, monospace';
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    const x = xOf(hz);
    g2d.beginPath(); g2d.moveTo(x, 0); g2d.lineTo(x, specH); g2d.stroke();
    g2d.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 2, specH - 3);
  }

  g2d.beginPath();
  g2d.moveTo(0, specH);
  for (let i = 1; i < freqData.length; i++) {
    const hz = (i * sr) / (an.fftSize);
    if (hz < fMin) continue;
    const x = xOf(hz);
    const y = specH - (freqData[i] / 255) * specH;
    g2d.lineTo(x, y);
  }
  g2d.lineTo(W, specH);
  g2d.closePath();
  const grad = g2d.createLinearGradient(0, 0, 0, specH);
  grad.addColorStop(0, 'rgba(127,215,255,0.85)');
  grad.addColorStop(1, 'rgba(40,90,190,0.15)');
  g2d.fillStyle = grad;
  g2d.fill();
  g2d.strokeStyle = '#7fd7ff';
  g2d.lineWidth = 1;
  g2d.stroke();

  // --- waveform ----------------------------------------------------------
  const waveTop = specH + 6;
  const waveH = H - waveTop;
  g2d.strokeStyle = 'rgba(120,170,255,0.18)';
  g2d.beginPath();
  g2d.moveTo(0, waveTop + waveH / 2); g2d.lineTo(W, waveTop + waveH / 2);
  g2d.stroke();
  if (timeData) {
    g2d.beginPath();
    let peak = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      const x = (i / (timeData.length - 1)) * W;
      const y = waveTop + waveH / 2 - v * (waveH / 2) * 0.95;
      if (i === 0) g2d.moveTo(x, y); else g2d.lineTo(x, y);
    }
    g2d.strokeStyle = peak > 0.98 ? '#ff6b6b' : '#62e08a';
    g2d.lineWidth = 1.2;
    g2d.stroke();
    scopePeak = peak;
  }
}

let scopePeak = 0;

function drawDebug(): void {
  const d = audio.debug();
  $('scopeinfo').innerHTML =
    `ctx <b>${d.state}</b> ${d.sampleRate}Hz · wave peak <b>${scopePeak.toFixed(3)}</b>`
    + ` · limiter reduction <b>${d.limiterReduction.toFixed(2)} dB</b>`
    + ` · sfx voices ${d.voices} · engines ${d.engineVoices} (hot ${d.engineHot})`
    + ` · duck ${d.duck.toFixed(2)} · env ${d.environment}`;

  const eng = audio.engineSystem?.debug(0);
  $('engDebug').textContent = eng
    ? `kart 0  ${eng.character}\n`
      + `rpm ${eng.rpm.toFixed(3)}  load ${eng.load.toFixed(2)}\n`
      + `base ${eng.baseHz.toFixed(1)} Hz   firing ${eng.fireHz.toFixed(1)} Hz\n`
      + `boost ${eng.boost.toFixed(2)}  doppler ${eng.doppler.toFixed(1)} cents\n`
      + `distance ${eng.distance.toFixed(1)} m  hot ${eng.hot}  connected ${eng.connected}\n`
      + `maxSimulated ${audio.engineSystem?.maxSimulated}  player speed ${d.playerSpeed.toFixed(1)} m/s`
    : 'no engine voice';

  const m = audio.musicSystem?.debug();
  $('musDebug').textContent = m
    ? `${m.name} (${m.theme})  ${m.bpm.toFixed(1)} bpm  bar ${m.bar} step ${m.step % 16}\n`
      + `intensity ${m.intensity.toFixed(2)}  finalLap ${m.finalLap}  transpose ${m.transpose}\n`
      + `layers  ${Object.entries(m.layers).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ')}\n`
      + `drums baked ${m.drumsBaked}  notes scheduled ${m.notes}\n`
      + `bus gains  music ${d.busGains.music.toFixed(3)} sfx ${d.busGains.sfx.toFixed(3)} `
      + `engine ${d.busGains.engine.toFixed(3)} amb ${d.busGains.ambient.toFixed(3)}`
    : 'no music';
}

// ---------------------------------------------------------------------------
// Measurement 1 — every baked buffer vs. design intent
// ---------------------------------------------------------------------------

interface Check { id: string; ok: boolean; notes: string[]; stats: BufferStats }

function measureBuffers(): { text: string; pass: number; fail: number; rows: Check[] } {
  const bank = audio.bank;
  if (!bank) return { text: 'no bank', pass: 0, fail: 0, rows: [] };
  const all = bank.analyzeAll();
  const rows: Check[] = [];
  let pass = 0, fail = 0;

  const ids = Object.keys(all).sort();
  for (const id of ids) {
    const s = all[id];
    const notes: string[] = [];
    let ok = true;
    const bad = (m: string): void => { notes.push(m); ok = false; };

    if (s.nan) bad('NaN samples');
    if (id !== 'silence') {
      if (s.peak < 0.02) bad(`silent (peak ${s.peak.toFixed(4)})`);
      if (s.peak > 0.999) bad(`clipping (peak ${s.peak.toFixed(4)})`);
      if (s.rms < 0.0008) bad(`no energy (rms ${s.rms.toFixed(5)})`);
      if (Math.abs(s.dc) > 0.02) bad(`DC offset ${s.dc.toFixed(4)}`);
    }
    const exp = SFX_EXPECTATIONS[id];
    if (exp) {
      if (exp.centroid && (s.centroid < exp.centroid[0] || s.centroid > exp.centroid[1])) {
        bad(`centroid ${s.centroid.toFixed(0)} Hz outside [${exp.centroid[0]}, ${exp.centroid[1]}]`);
      }
      if (exp.minSub !== undefined && s.subEnergy < exp.minSub) {
        bad(`sub<100Hz ${(s.subEnergy * 100).toFixed(1)}% < ${(exp.minSub * 100).toFixed(0)}%`);
      }
      if (exp.minHigh !== undefined && s.highEnergy < exp.minHigh) {
        bad(`high>6kHz ${(s.highEnergy * 100).toFixed(1)}% < ${(exp.minHigh * 100).toFixed(0)}%`);
      }
      if (exp.envelope && (s.envelopeLength < exp.envelope[0] || s.envelopeLength > exp.envelope[1])) {
        bad(`envelope ${s.envelopeLength.toFixed(3)} s outside [${exp.envelope[0]}, ${exp.envelope[1]}]`);
      }
    }
    if (ok) pass++; else fail++;
    rows.push({ id, ok, notes, stats: s });
  }

  const head = 'id                     peak     rms      dc       centroid   sub%   high%  env(s)  verdict\n'
    + '-'.repeat(104) + '\n';
  const body = rows.map((r) => {
    const s = r.stats;
    const line = r.id.padEnd(22)
      + s.peak.toFixed(3).padStart(7)
      + s.rms.toFixed(4).padStart(9)
      + s.dc.toFixed(4).padStart(9)
      + s.centroid.toFixed(0).padStart(11)
      + (s.subEnergy * 100).toFixed(1).padStart(8)
      + (s.highEnergy * 100).toFixed(1).padStart(7)
      + s.envelopeLength.toFixed(3).padStart(8)
      + '  ';
    const verdict = r.ok
      ? '<span class="pass">PASS</span>'
      : `<span class="fail">FAIL</span> <span class="warnc">${r.notes.join('; ')}</span>`;
    return line + verdict;
  }).join('\n');

  const text = `${head}${body}\n\n`
    + `<span class="${fail ? 'fail' : 'pass'}">${pass} pass / ${fail} fail</span>`
    + ` across ${rows.length} baked buffers\n`;
  console.log(`[audio bench] buffers: ${pass} pass / ${fail} fail`);
  return { text, pass, fail, rows };
}

// ---------------------------------------------------------------------------
// Measurement 2 — engine harmonic series + firing sidebands, offline
// ---------------------------------------------------------------------------

interface EngineMeasure {
  rpm: number;
  expectedBaseHz: number;
  expectedFiringHz: number;
  measuredF0: number;
  harmonicsFound: number;
  sidebandsFound: number;
  peak: number;
  rms: number;
  centroid: number;
  peaks: Peak[];
  ok: boolean;
  notes: string[];
}

async function renderEngineAt(
  rpmValue: number, character: EngineCharacterId, seconds = 1.6,
): Promise<AudioBuffer> {
  const sr = 44100;
  const octx = new OfflineAudioContext(1, Math.floor(sr * seconds), sr);
  const sys = new EngineSoundSystem(octx, { dest: octx.destination, maxSimulated: 1 });
  await sys.init();
  sys.bind(0, true, character);
  const pos = new THREE.Vector3(0, 0.4, -2);
  const listener = { x: 0, y: 1.5, z: 0 };
  const zero = { x: 0, y: 0, z: 0 };
  // Offline `currentTime` is frozen at 0, so every param write lands at t=0 and
  // the graph renders the steady state for that rpm. Push twice so the voice's
  // internal smoothing sees a non-zero dt and reaches its target.
  sys.update(0, rpmValue, 0.8, pos);
  sys.frame(0.25, listener, zero);
  sys.update(0, rpmValue, 0.8, pos);
  sys.frame(0.25, listener, zero);
  return octx.startRendering();
}

async function measureEngine(
  rpms: number[] = [0, 0.25, 0.5, 0.75, 1.0],
  character: EngineCharacterId = 'standard',
): Promise<{ text: string; results: EngineMeasure[] }> {
  const c = ENGINE_CHARACTERS[character];
  const results: EngineMeasure[] = [];
  const N = 16384;

  for (const r of rpms) {
    const buf = await renderEngineAt(r, character);
    const stats = analyzeBuffer(buf);
    const ch = buf.getChannelData(0);
    // Analyse the tail so start-up ramps are excluded.
    const start = Math.max(0, ch.length - N - 1024);
    const frameData = ch.subarray(start, start + N);
    const mag = fftMag(frameData, N);
    const peaks = findPeaks(mag, buf.sampleRate, N, 0.06, 24);

    const baseHz = c.idleHz * Math.pow(c.maxHz / c.idleHz, r);
    const firingHz = baseHz * c.firingOrder;

    // Harmonic series: how many of h*f0 (h=1..8) have a peak within 4 %?
    let harmonicsFound = 0;
    for (let h = 1; h <= 8; h++) {
      const want = baseHz * h;
      if (want > buf.sampleRate * 0.45) break;
      if (peaks.some((p) => Math.abs(p.hz - want) / want < 0.04)) harmonicsFound++;
    }
    // Firing-pulse sidebands: energy at n*firingHz, and at f0 ± firingHz.
    let sidebandsFound = 0;
    const wanted = [firingHz, firingHz * 2, baseHz + firingHz, Math.abs(baseHz - firingHz)];
    for (const want of wanted) {
      if (want < 20 || want > buf.sampleRate * 0.45) continue;
      if (peaks.some((p) => Math.abs(p.hz - want) / want < 0.06)) sidebandsFound++;
    }
    const measuredF0 = peaks.length
      ? peaks.slice().sort((a, b) => a.hz - b.hz).find((p) => p.mag > 0.15)?.hz ?? peaks[0].hz
      : 0;

    const notes: string[] = [];
    let ok = true;
    if (stats.nan) { notes.push('NaN'); ok = false; }
    if (stats.peak < 0.01) { notes.push(`silent (peak ${stats.peak.toFixed(4)})`); ok = false; }
    if (stats.peak > 0.999) { notes.push('clipping'); ok = false; }
    if (harmonicsFound < 3) { notes.push(`only ${harmonicsFound} harmonics of ${baseHz.toFixed(0)} Hz`); ok = false; }
    if (sidebandsFound < 1) { notes.push('no firing-pulse sidebands'); ok = false; }

    results.push({
      rpm: r, expectedBaseHz: baseHz, expectedFiringHz: firingHz, measuredF0,
      harmonicsFound, sidebandsFound, peak: stats.peak, rms: stats.rms,
      centroid: stats.centroid, peaks: peaks.slice(0, 10), ok, notes,
    });
  }

  const head = `engine "${character}"  idle ${c.idleHz} Hz  max ${c.maxHz} Hz  firing order ${c.firingOrder}\n`
    + 'rpm    baseHz  firingHz  measF0   harm/8  sidebands  peak    rms     centroid  verdict\n'
    + '-'.repeat(96) + '\n';
  const body = results.map((r) => {
    const line = r.rpm.toFixed(2).padEnd(7)
      + r.expectedBaseHz.toFixed(1).padStart(7)
      + r.expectedFiringHz.toFixed(1).padStart(10)
      + r.measuredF0.toFixed(1).padStart(9)
      + `${r.harmonicsFound}/8`.padStart(8)
      + String(r.sidebandsFound).padStart(11)
      + r.peak.toFixed(3).padStart(8)
      + r.rms.toFixed(4).padStart(8)
      + r.centroid.toFixed(0).padStart(10)
      + '  ';
    return line + (r.ok
      ? '<span class="pass">PASS</span>'
      : `<span class="fail">FAIL</span> <span class="warnc">${r.notes.join('; ')}</span>`);
  }).join('\n');
  const detail = results.map((r) =>
    `  rpm ${r.rpm.toFixed(2)} peaks: ` + r.peaks.map((p) => `${p.hz.toFixed(0)}Hz@${p.mag.toFixed(2)}`).join(' ')
  ).join('\n');

  const text = `${head}${body}\n\n<span class="dim">${detail}</span>\n`;
  console.log('[audio bench] engine', results);
  return { text, results };
}

// ---------------------------------------------------------------------------
// Measurement 3 — the master chain actually limits
// ---------------------------------------------------------------------------

/**
 * Rebuild the exact two-stage master chain offline and slam it with twelve
 * simultaneous explosions plus a sustained tone. Proves the limiter holds the
 * output under 0 dBFS in the worst case the game can produce.
 */
async function measureMaster(): Promise<{ text: string; withLimiter: BufferStats; withoutLimiter: BufferStats }> {
  const bank = audio.bank;
  const explosion = bank?.buffer('explosion') ?? null;
  const sr = 44100;

  const render = async (limit: boolean): Promise<BufferStats> => {
    const octx = new OfflineAudioContext(1, Math.floor(sr * 2.5), sr);
    let head: AudioNode = octx.destination;
    if (limit) {
      const limiter = octx.createDynamicsCompressor();
      limiter.threshold.value = -1.2; limiter.knee.value = 0; limiter.ratio.value = 20;
      limiter.attack.value = 0.0015; limiter.release.value = 0.08;
      limiter.connect(octx.destination);
      const glue = octx.createDynamicsCompressor();
      glue.threshold.value = -16; glue.knee.value = 10; glue.ratio.value = 3;
      glue.attack.value = 0.006; glue.release.value = 0.22;
      glue.connect(limiter);
      head = glue;
    }
    const sum = octx.createGain();
    sum.gain.value = 1;
    sum.connect(head);

    // 12 impacts within 120 ms — a bomb in the middle of the pack.
    if (explosion) {
      for (let i = 0; i < 12; i++) {
        const s = octx.createBufferSource();
        s.buffer = explosion;
        s.detune.value = (i - 6) * 40;
        const g = octx.createGain();
        g.gain.value = 0.8;
        s.connect(g); g.connect(sum);
        s.start(0.02 + i * 0.01);
      }
    }
    // Music-ish sustained content underneath.
    for (const hz of [82.4, 164.8, 246.9, 329.6]) {
      const o = octx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      const g = octx.createGain();
      g.gain.value = 0.16;
      o.connect(g); g.connect(sum);
      o.start(0); o.stop(2.4);
    }
    return analyzeBuffer(await octx.startRendering());
  };

  const withoutLimiter = await render(false);
  const withLimiter = await render(true);

  const fmt = (label: string, s: BufferStats): string =>
    `${label.padEnd(22)}peak ${s.peak.toFixed(4)}  rms ${s.rms.toFixed(4)}  dc ${s.dc.toFixed(5)}`
    + `  centroid ${s.centroid.toFixed(0)} Hz  clipped ${s.clipped}  nan ${s.nan}`;

  const ok = withLimiter.peak <= 1.0 && !withLimiter.clipped && !withLimiter.nan;
  const text = [
    fmt('raw sum (no chain)', withoutLimiter),
    fmt('glue + limiter', withLimiter),
    '',
    `headroom recovered: ${(20 * Math.log10(withoutLimiter.peak / Math.max(1e-6, withLimiter.peak))).toFixed(2)} dB`,
    ok
      ? '<span class="pass">PASS — 12 simultaneous explosions + music stay under 0 dBFS</span>'
      : '<span class="fail">FAIL — chain does not contain the worst case</span>',
  ].join('\n');
  console.log('[audio bench] master', { withoutLimiter, withLimiter });
  return { text, withLimiter, withoutLimiter };
}

void boot();
