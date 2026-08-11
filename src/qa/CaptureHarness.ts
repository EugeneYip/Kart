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
const fwd = new THREE.Vector3();
const rgt = new THREE.Vector3();
const UP_AXIS = new THREE.Vector3(0, 1, 0);

export class CaptureHarness {
  private game: Game;
  private freeFly = false;

  /**
   * Per-frame "hold" callbacks, re-applied every settled frame and by a
   * persistent loop between shots.
   *
   * Two things fought the harness before this existed:
   *  - `forceState()` used a one-shot `Object.assign`, which `KartPhysics`
   *    overwrites on the very next tick — so a forced drift or boost never
   *    survived to be photographed.
   *  - The camera was placed once, then `settle()` ran frames while the kart
   *    kept driving at ~24 m/s. A capture that looked correct was actually
   *    taken 360–410 m behind the subject, which silently tripped every
   *    distance-LOD cull in the VFX system and made working effects look
   *    completely absent.
   *
   * Holds fix both: state and camera are re-asserted every frame.
   */
  private holds: Array<() => void> = [];
  private holdRaf = 0;

  constructor(game: Game) {
    this.game = game;
  }

  /** Register a callback re-run every frame until `clearHolds()`. */
  addHold(fn: () => void): void { this.holds.push(fn); }

  clearHolds(): void {
    this.holds.length = 0;
    if (this.holdRaf) { cancelAnimationFrame(this.holdRaf); this.holdRaf = 0; }
  }

  runHolds(): void {
    for (const h of this.holds) {
      try { h(); } catch { /* a hold must never break a capture */ }
    }
  }

  /**
   * Keep holds running after `shot()` returns, so the frame the reviewer
   * actually screenshots still shows the state that was set up.
   */
  startHoldLoop(): void {
    if (this.holdRaf) cancelAnimationFrame(this.holdRaf);
    const tick = () => {
      this.runHolds();
      this.holdRaf = requestAnimationFrame(tick);
    };
    this.holdRaf = requestAnimationFrame(tick);
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

  /**
   * Place the camera relative to the PLAYER KART's own frame.
   *
   * This is what the shot list must use. Positioning off a track `t` value is
   * how the original harness shipped, and it silently framed empty tarmac:
   * the kart is wherever the race has carried it, which is almost never the
   * hard-coded `t`. An earlier review found 5 of 8 framings contained no kart
   * at all. Offsets here are in the kart's basis — back/up/right — so the
   * subject is in frame by construction.
   */
  kartRelative(
    opts: { back?: number; up?: number; right?: number; lookUp?: number; lookAhead?: number; fov?: number; kartId?: number } = {},
  ): boolean {
    // Re-assert every frame: a one-shot placement drifts hundreds of metres
    // behind a kart doing 24 m/s while settle() runs.
    this.addHold(() => this.placeKartRelative(opts));
    return this.placeKartRelative(opts);
  }

  private placeKartRelative(
    opts: { back?: number; up?: number; right?: number; lookUp?: number; lookAhead?: number; fov?: number; kartId?: number },
  ): boolean {
    const kart = this.game.karts?.karts?.[opts.kartId ?? 0];
    if (!kart) return false;

    const back = opts.back ?? 7.0;
    const up = opts.up ?? 2.5;
    const right = opts.right ?? 0;

    // Kart basis. -Z is forward in local space (see AGENTS.md conventions).
    fwd.set(0, 0, -1).applyQuaternion(kart.quaternion);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.y *= 0.35; // flatten so the camera doesn't dive on slopes
    fwd.normalize();
    rgt.crossVectors(UP_AXIS, fwd).normalize();

    v.copy(kart.position)
      .addScaledVector(fwd, -back)
      .addScaledVector(UP_AXIS, up)
      .addScaledVector(rgt, right);

    // Never below ground.
    const minY = kart.position.y + 0.5;
    if (v.y < minY) v.y = minY;

    v2.copy(kart.position)
      .addScaledVector(fwd, opts.lookAhead ?? 6)
      .addScaledVector(UP_AXIS, opts.lookUp ?? 0.6);

    this.lookAt(v, v2, opts.fov ?? 60);
    return true;
  }

  /**
   * Is the subject actually inside the frame? Projects the kart's centre into
   * NDC and reports coverage, so a shot can fail loudly instead of yielding a
   * beautiful photograph of an empty road.
   */
  subjectInFrame(kartId = 0): { inFrame: boolean; ndc: [number, number]; behind: boolean; distance: number } {
    const kart = this.game.karts?.karts?.[kartId];
    const cam = this.game.engine.camera;
    if (!kart) return { inFrame: false, ndc: [NaN, NaN], behind: true, distance: NaN };

    cam.updateMatrixWorld();
    v.copy(kart.position);
    v.y += 0.5;
    const dist = v.distanceTo(cam.position);
    v.project(cam);
    const behind = v.z > 1;
    const inFrame = !behind && Math.abs(v.x) <= 0.95 && Math.abs(v.y) <= 0.95;
    return { inFrame, ndc: [+v.x.toFixed(3), +v.y.toFixed(3)], behind, distance: +dist.toFixed(2) };
  }

  /**
   * Advance the simulation by `seconds`.
   *
   * Races a rAF loop against a wall-clock fallback: rAF is throttled to a few
   * Hz in a hidden tab and can stop entirely when the pane isn't compositing,
   * which would otherwise hang a capture run indefinitely.
   */
  async settle(seconds: number): Promise<void> {
    const frames = Math.max(1, Math.round(seconds * 60));
    const deadline = performance.now() + Math.max(1000, seconds * 1000 * 3);
    for (let i = 0; i < frames; i++) {
      if (performance.now() > deadline) break;
      await new Promise<void>((r) => {
        let done = false;
        const finish = () => { if (!done) { done = true; r(); } };
        requestAnimationFrame(finish);
        setTimeout(finish, 60);
      });
      // Re-assert pinned state and camera every frame, or physics and the
      // kart's own motion undo the setup before the frame is captured.
      this.runHolds();
    }
  }

  /**
   * Pin a kart into a visual state so effects can be photographed.
   *
   * Registered as a per-frame hold, because `KartPhysics` rewrites these fields
   * every tick — a one-shot assign is gone before the next frame renders.
   */
  forceState(kartId: number, state: Partial<Record<string, unknown>>): void {
    const karts = this.game.karts?.karts;
    if (!karts?.[kartId]) return;
    const target = karts[kartId] as unknown as Record<string, unknown>;
    const apply = () => Object.assign(target, state);
    apply();
    this.addHold(apply);
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
/**
 * The canonical shot list — the review contract.
 *
 * Every gameplay framing is positioned in the PLAYER KART's basis, so the
 * subject cannot fall out of frame as the race progresses. `shot()` verifies
 * this and reports `subject.inFrame`; treat a false there as a failed capture,
 * not as a judgement about the game.
 */
export const SHOTS: Shot[] = [
  {
    name: 'chase-straight',
    description: 'Default gameplay framing at speed — the single most-seen frame in the game.',
    settle: 0.8,
    apply: (g, h) => { h.takeCameraControl(); h.kartRelative({ back: 7.5, up: 2.6, lookAhead: 14, fov: 62 }); },
  },
  {
    name: 'chase-corner-drift',
    description: 'Mid-drift at full purple charge — judges drift sparks, body lean, camera drift-lead.',
    settle: 0.6,
    apply: (g, h) => {
      h.forceState(0, {
        drifting: true, driftStage: 4, driftDirection: 1, driftCharge: 0.95,
        speed: 24, speedRatio: 0.85,
      });
      h.takeCameraControl();
      h.kartRelative({ back: 8, up: 2.8, right: -3.2, lookAhead: 10, fov: 62 });
    },
  },
  {
    name: 'chase-boost',
    description: 'Full boost — flames, speed lines, FOV kick, motion blur.',
    settle: 0.4,
    apply: (g, h) => {
      h.forceState(0, { boostTime: 2, boostStrength: 1.4, speed: 38, speedRatio: 1.3 });
      h.takeCameraControl();
      h.kartRelative({ back: 6.5, up: 2.3, lookAhead: 16, fov: 74 });
    },
  },
  {
    name: 'kart-hero',
    description: 'Close 3/4 hero shot — judges model, chamfers, clearcoat, driver, tyres.',
    settle: 0.3,
    apply: (g, h) => {
      h.takeCameraControl();
      // Kart-relative, NOT a world-axis offset: a fixed world offset swings
      // around to the wrong side of the kart as it drives round the circuit.
      h.kartRelative({ back: -3.0, up: 1.35, right: 3.2, lookAhead: 0, lookUp: 0.55, fov: 40 });
    },
  },
  {
    name: 'grid-wide',
    description: 'Wide establishing shot over the start line — judges environment, crowd, lighting.',
    settle: 0.5,
    apply: (g, h) => {
      h.takeCameraControl();
      // High and behind, looking down the track. The old version used a
      // negative `back` off the spline and ended up inside the pit wall.
      h.kartRelative({ back: 30, up: 15, lookAhead: 40, lookUp: -2, fov: 50 });
    },
  },
  {
    name: 'pack-battle',
    description: 'Several karts in frame — judges the sense of an actual race.',
    settle: 0.8,
    apply: (g, h) => { h.takeCameraControl(); h.kartRelative({ back: 13, up: 4.4, right: 4, lookAhead: 18, fov: 58 }); },
  },
  {
    name: 'scenery-vista',
    description: 'Elevated view — judges sky, clouds, terrain, foliage, water, draw distance.',
    settle: 0.5,
    apply: (g, h) => { h.takeCameraControl(); h.kartRelative({ back: 46, up: 30, right: 34, lookAhead: 30, lookUp: -6, fov: 56 }); },
  },
  {
    name: 'hud-full',
    description: 'Gameplay frame with the complete HUD — judges UI quality and readability.',
    settle: 0.5,
    apply: (g, h) => {
      h.setHudVisible(true);
      h.takeCameraControl();
      h.kartRelative({ back: 7.5, up: 2.6, lookAhead: 14, fov: 62 });
    },
  },
  {
    name: 'driver-eye',
    description: 'Low 1.2 m eye-height view down the road — the harshest test of surface detail.',
    settle: 0.5,
    apply: (g, h) => { h.takeCameraControl(); h.kartRelative({ back: 3.5, up: 1.2, lookAhead: 30, lookUp: 0.4, fov: 66 }); },
  },
];

export function installCaptureHarness(game: Game): void {
  const harness = new CaptureHarness(game);

  (globalThis as Record<string, unknown>).__QA__ = {
    harness,
    shots: SHOTS.map((s) => ({ name: s.name, description: s.description })),

    /**
     * Set up a named shot, settle, and VERIFY the subject is in frame.
     *
     * Check `subject.inFrame` before you judge the image. If it is false the
     * capture failed and the picture tells you nothing about the game.
     */
    async shot(name: string) {
      const s = SHOTS.find((x) => x.name === name);
      if (!s) throw new Error(`Unknown shot "${name}". Available: ${SHOTS.map((x) => x.name).join(', ')}`);
      harness.clearHolds();
      await s.apply(game, harness);
      await harness.settle(s.settle ?? 0.5);
      // Keep the pinned state and camera asserted after this returns, so the
      // frame the reviewer screenshots is the frame we set up.
      harness.startHoldLoop();
      await harness.settle(0.1);

      const subject = harness.subjectInFrame(0);
      if (!subject.inFrame) {
        console.warn(
          `[QA] shot "${name}": SUBJECT NOT IN FRAME (ndc=${subject.ndc}, behind=${subject.behind}, ` +
          `dist=${subject.distance}). The capture is invalid — do not judge the game from it.`,
        );
      }
      return { shot: name, subject, ...harness.stats() };
    },

    /** Capture-validate every shot at once. Use this before a review run. */
    async validateShots() {
      const out: Array<Record<string, unknown>> = [];
      for (const s of SHOTS) {
        try {
          const r = await (this as unknown as { shot(n: string): Promise<Record<string, unknown>> }).shot(s.name);
          out.push({ name: s.name, inFrame: (r.subject as { inFrame: boolean }).inFrame, ndc: (r.subject as { ndc: number[] }).ndc });
        } catch (err) {
          out.push({ name: s.name, error: String(err) });
        }
      }
      const bad = out.filter((o) => o.inFrame === false || o.error);
      console.info(`[QA] validateShots: ${out.length - bad.length}/${out.length} framings contain the subject.`);
      return { ok: bad.length === 0, results: out, failures: bad };
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
