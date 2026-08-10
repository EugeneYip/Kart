import * as THREE from 'three';
import type { Game } from '@/game/Game';

/**
 * QA capture harness.
 *
 * Installs `window.__QA__` so an automated reviewer can drive the game to a
 * set of canonical, reproducible framings and screenshot them. Every shot is
 * deterministic: same seed, same camera, same time-of-day, same kart poses —
 * so two runs are pixel-comparable and a critic can judge changes rather than
 * noise.
 *
 * This is a development tool. It is tree-shaken out of production builds by
 * the `import.meta.env.DEV` guard in main.ts.
 */

export interface Shot {
  name: string;
  description: string;
  /** Camera placement, in world space. */
  apply(game: Game, harness: CaptureHarness): void | Promise<void>;
  /** Seconds to let the simulation settle before capture. */
  settle?: number;
}

const v = new THREE.Vector3();
const v2 = new THREE.Vector3();

export class CaptureHarness {
  private game: Game;
  private freeFly = false;

  constructor(game: Game) {
    this.game = game;
  }

  // -- primitives the shots build on ----------------------------------------

  /** Detach the chase camera so we can place the camera by hand. */
  takeCameraControl(): void {
    this.freeFly = true;
    const cam = this.game.camera as unknown as { setMode?: (m: string) => void };
    cam?.setMode?.('free');
  }

  releaseCameraControl(): void {
    this.freeFly = false;
    const cam = this.game.camera as unknown as { setMode?: (m: string) => void };
    cam?.setMode?.('chase');
  }

  lookAt(from: THREE.Vector3Like, at: THREE.Vector3Like, fov = 55): void {
    const c = this.game.engine.camera;
    c.position.set(from.x, from.y, from.z);
    c.lookAt(at.x, at.y, at.z);
    c.fov = fov;
    c.updateProjectionMatrix();
  }

  /** Place the camera relative to the track centreline at progress `t`. */
  onTrack(t: number, opts: { back?: number; up?: number; side?: number; lookAhead?: number; fov?: number } = {}): void {
    const track = this.game.track as unknown as {
      sampleAt?: (t: number) => { position: THREE.Vector3; tangent: THREE.Vector3; normal: THREE.Vector3; binormal: THREE.Vector3 };
    };
    if (typeof track?.sampleAt !== 'function') return;

    const s = track.sampleAt(t);
    const back = opts.back ?? 8;
    const up = opts.up ?? 3;
    const side = opts.side ?? 0;
    const ahead = opts.lookAhead ?? 22;

    v.copy(s.position)
      .addScaledVector(s.tangent, -back)
      .addScaledVector(s.normal, up)
      .addScaledVector(s.binormal, side);

    const target = track.sampleAt!((t + ahead / 1500) % 1);
    v2.copy(target.position).addScaledVector(target.normal, 1.0);

    this.lookAt(v, v2, opts.fov ?? 58);
  }

  /** Advance the simulation by `seconds` without waiting in real time. */
  async settle(seconds: number): Promise<void> {
    const frames = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < frames; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  /** Force a kart into a visual state so effects can be photographed. */
  forceState(kartId: number, state: Partial<Record<string, unknown>>): void {
    const karts = this.game.karts?.karts;
    if (!karts?.[kartId]) return;
    Object.assign(karts[kartId], state);
  }

  setSky(preset: string): void {
    (this.game.sky as unknown as { setPreset?: (p: string) => void })?.setPreset?.(preset);
    (this.game.lighting as unknown as { setPreset?: (p: string) => void })?.setPreset?.(preset);
  }

  setHudVisible(visible: boolean): void {
    (this.game.hud as unknown as { setVisible?: (v: boolean) => void })?.setVisible?.(visible);
  }

  stats(): Record<string, number | string | boolean> {
    const info = this.game.engine.renderer.info;
    const p = this.game.karts?.player;
    return {
      /**
       * Wall-clock fps is MEANINGLESS in a background tab: Chrome throttles
       * requestAnimationFrame to ~0.5–3 Hz when visibilityState is 'hidden'.
       * Always check `throttled` before believing this number.
       */
      fps: Math.round(this.game.engine.fpsAverage * 10) / 10,
      throttled: document.visibilityState === 'hidden',
      visibility: document.visibilityState,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      quality: this.game.engine.quality.tier,
      speed: p ? Math.round(p.speed * 3.6) : 0,
      raceState: (this.game.race as unknown as { state?: string })?.state ?? 'unknown',
    };
  }
}

/**
 * The canonical shot list. These are the frames the visual critic compares
 * against Mario Kart 8 Deluxe reference. Chosen to cover the framings a player
 * actually spends their time looking at.
 */
export const SHOTS: Shot[] = [
  {
    name: 'chase-straight',
    description: 'Default gameplay framing on a straight at speed — the single most-seen frame in the game.',
    settle: 1.0,
    apply: (g, h) => { h.releaseCameraControl(); h.onTrack(0.08, { back: 7.5, up: 2.6, lookAhead: 30 }); },
  },
  {
    name: 'chase-corner-drift',
    description: 'Mid-drift through a corner with sparks at full charge.',
    settle: 0.6,
    apply: (g, h) => {
      h.forceState(0, { drifting: true, driftStage: 3, driftDirection: 1, driftCharge: 0.9, speed: 24 });
      h.onTrack(0.22, { back: 8, up: 3.0, side: -3, lookAhead: 20 });
    },
  },
  {
    name: 'chase-boost',
    description: 'Full boost — flames, speed lines, FOV kick, motion blur.',
    settle: 0.4,
    apply: (g, h) => {
      h.forceState(0, { boostTime: 2, boostStrength: 1.4, speed: 38, speedRatio: 1.3 });
      h.onTrack(0.35, { back: 6.5, up: 2.3, lookAhead: 40 });
    },
  },
  {
    name: 'kart-hero',
    description: 'Close 3/4 hero shot of the player kart — judges model, materials, clearcoat.',
    settle: 0.3,
    apply: (g, h) => {
      h.takeCameraControl();
      const p = g.karts?.player;
      if (!p) return;
      v.copy(p.position).add(new THREE.Vector3(3.2, 1.5, 3.4));
      h.lookAt(v, { x: p.position.x, y: p.position.y + 0.55, z: p.position.z }, 42);
    },
  },
  {
    name: 'grid-wide',
    description: 'Wide establishing shot of the start grid — judges environment, crowd, lighting.',
    settle: 0.5,
    apply: (g, h) => { h.takeCameraControl(); h.onTrack(0.985, { back: -26, up: 13, lookAhead: 60, fov: 48 }); },
  },
  {
    name: 'pack-battle',
    description: 'Mid-pack with several karts in frame — judges the sense of a race.',
    settle: 0.8,
    apply: (g, h) => { h.releaseCameraControl(); h.onTrack(0.5, { back: 11, up: 4.2, lookAhead: 26 }); },
  },
  {
    name: 'scenery-vista',
    description: 'The track\'s best view — judges sky, terrain, foliage, water, draw distance.',
    settle: 0.5,
    apply: (g, h) => { h.takeCameraControl(); h.onTrack(0.62, { back: 4, up: 24, side: 40, lookAhead: 10, fov: 55 }); },
  },
  {
    name: 'hud-full',
    description: 'Gameplay frame with the complete HUD — judges UI quality and readability.',
    settle: 0.5,
    apply: (g, h) => { h.setHudVisible(true); h.releaseCameraControl(); h.onTrack(0.15, { back: 7.5, up: 2.6, lookAhead: 30 }); },
  },
];

export function installCaptureHarness(game: Game): void {
  const harness = new CaptureHarness(game);

  (globalThis as Record<string, unknown>).__QA__ = {
    harness,
    shots: SHOTS.map((s) => ({ name: s.name, description: s.description })),

    /** Set up a named shot and settle. Returns stats once the frame is stable. */
    async shot(name: string) {
      const s = SHOTS.find((x) => x.name === name);
      if (!s) throw new Error(`Unknown shot "${name}". Available: ${SHOTS.map((x) => x.name).join(', ')}`);
      await s.apply(game, harness);
      await harness.settle(s.settle ?? 0.5);
      return harness.stats();
    },

    stats: () => harness.stats(),
    setSky: (p: string) => harness.setSky(p),
    setHud: (v: boolean) => harness.setHudVisible(v),
    setQuality: (t: 'low' | 'medium' | 'high' | 'ultra') => game.engine.setQuality(t),

    /**
     * Measure a stable frame rate over `seconds`, ignoring the first second.
     *
     * IMPORTANT: refuses to report a verdict from a hidden tab. Chrome clamps
     * requestAnimationFrame to a few Hz when the tab isn't visible, which once
     * produced a bogus "5 fps" reading here while the renderer was actually
     * finishing frames in well under 10 ms. The `valid` flag is the guard —
     * do not quote `medianFps` when it is false.
     */
    async benchmark(seconds = 5) {
      const hidden = document.visibilityState === 'hidden';
      await harness.settle(1);
      const samples: number[] = [];
      const end = performance.now() + seconds * 1000;
      let last = performance.now();
      while (performance.now() < end) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        const now = performance.now();
        samples.push(now - last);
        last = now;
      }
      samples.sort((a, b) => a - b);
      const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
      return {
        /** False when the tab was hidden — every timing below is then garbage. */
        valid: !hidden && document.visibilityState === 'visible',
        warning: hidden
          ? 'TAB WAS HIDDEN — rAF is throttled, timings are invalid. Foreground the tab and re-run.'
          : undefined,
        frames: samples.length,
        medianMs: +pct(0.5).toFixed(2),
        p95Ms: +pct(0.95).toFixed(2),
        worstMs: +samples[samples.length - 1].toFixed(2),
        medianFps: +(1000 / pct(0.5)).toFixed(1),
        onePercentLowFps: +(1000 / pct(0.99)).toFixed(1),
        ...harness.stats(),
      };
    },

    /**
     * GPU-side cost, which is valid even in a hidden tab because it measures
     * the renderer's own submitted work rather than frame cadence.
     * Returns null if the timer extension is unavailable.
     */
    gpuTimingAvailable(): boolean {
      const gl = game.engine.renderer.getContext() as WebGL2RenderingContext;
      return !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
    },
  };

  console.info(
    `[QA] harness ready — __QA__.shot(name) | shots: ${SHOTS.map((s) => s.name).join(', ')}`,
  );
}
