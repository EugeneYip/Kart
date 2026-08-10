/**
 * ============================================================================
 *  APEX KART — POST-CHAIN QA PROBE  (development only)
 * ============================================================================
 *  Installs `window.__POST__`, a set of measurement tools for the render
 *  pipeline. This exists because "the image looks washed out" is not something
 *  you can tune by eye through a screenshot pipeline — you need numbers.
 *
 *  The important one is `probe()`: it reads the finished frame back off the
 *  default framebuffer and reports a histogram summary. Those numbers are what
 *  proved the original chain shipped a frame whose darkest 1 % of pixels sat at
 *  0.41 luma (i.e. no shadows at all) with a mean saturation of 0.13 (i.e. very
 *  nearly greyscale), and they are what the current grade was tuned against.
 *
 *    __POST__.probe()             -> histogram summary of the current frame
 *    __POST__.passCost(name?)     -> ms/frame attributable to each post pass
 *    __POST__.toneMap(name)       -> A/B a tone-mapping operator live
 *    __POST__.exposure(v)         -> exposure trim
 *
 *  Tree-shaken out of production builds — the only import site is guarded by
 *  `import.meta.env.DEV`.
 * ============================================================================
 */

import type { RenderPipeline } from './RenderPipeline';
import type { ToneMapName } from './effects/GradeEffect';

interface ProbeResult {
  meanLuma: number;
  stdLuma: number;
  meanSat: number;
  p1: number;
  p5: number;
  p50: number;
  p95: number;
  p99: number;
  blown: number;
  crushed: number;
}

interface EngineLike {
  renderer: {
    getContext(): WebGL2RenderingContext;
    setRenderTarget(t: null): void;
  };
}

/** Wait two frames, then read the composited frame back and summarise it. */
function probe(engine: EngineLike): Promise<ProbeResult> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const gl = engine.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      engine.renderer.setRenderTarget(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

      const step = 4;
      const lumas: number[] = [];
      let sumL = 0;
      let sumS = 0;
      let n = 0;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          const r = buf[i] / 255;
          const g = buf[i + 1] / 255;
          const b = buf[i + 2] / 255;
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          sumL += l;
          sumS += mx <= 1e-4 ? 0 : (mx - mn) / mx;
          lumas.push(l);
          n++;
        }
      }
      lumas.sort((a, b) => a - b);
      const q = (p: number): number => +lumas[Math.min(n - 1, Math.floor(n * p))].toFixed(4);
      const mean = sumL / n;
      let v = 0;
      for (const l of lumas) v += (l - mean) * (l - mean);
      resolve({
        meanLuma: +mean.toFixed(4),
        stdLuma: +Math.sqrt(v / n).toFixed(4),
        meanSat: +(sumS / n).toFixed(4),
        p1: q(0.01), p5: q(0.05), p50: q(0.5), p95: q(0.95), p99: q(0.99),
        blown: +(lumas.filter((l) => l > 0.98).length / n).toFixed(4),
        crushed: +(lumas.filter((l) => l < 0.02).length / n).toFixed(4),
      });
    }));
  });
}

/** Median frame time over `frames` presented frames. */
async function frameTime(frames: number): Promise<number> {
  const samples: number[] = [];
  let last = performance.now();
  for (let i = 0; i < frames; i++) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const now = performance.now();
    samples.push(now - last);
    last = now;
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

export function installPostQA(pipeline: RenderPipeline, engine: EngineLike): void {
  const api = {
    pipeline,
    probe: () => probe(engine),

    /**
     * Per-pass cost. Measures median frame time with every pass on, then with
     * each pass individually disabled; the difference is that pass's share.
     * `emptyScene` swaps the RenderPass scene for an empty one first so the
     * scene's own cost stops dominating the measurement.
     */
    async passCost(frames = 40, emptyScene = false): Promise<Record<string, number>> {
      const composer = pipeline.composer;
      const rp = composer.passes[0] as unknown as { mainScene: unknown };
      const savedScene = rp.mainScene;
      if (emptyScene) {
        const THREE = await import('three');
        rp.mainScene = new THREE.Scene();
      }
      const out: Record<string, number> = {};
      await frameTime(20);
      const base = await frameTime(frames);
      out['ALL'] = +base.toFixed(2);

      for (const pass of composer.passes) {
        // The terminal pass carries renderToScreen; disabling it shows nothing.
        if (pass === composer.passes[composer.passes.length - 1]) continue;
        if (pass === composer.passes[0]) continue;
        if (!pass.enabled) continue;
        const label = describe(pass);
        pass.enabled = false;
        const t = await frameTime(frames);
        pass.enabled = true;
        out[label] = +(base - t).toFixed(2);
      }
      rp.mainScene = savedScene;
      return out;
    },

    /**
     * True per-pass GPU cost, in milliseconds, via
     * `EXT_disjoint_timer_query_webgl2`. Each pass's `render` is wrapped in a
     * TIME_ELAPSED query for a few frames; one pass at a time, because a context
     * may only have one active query.
     *
     * This is measured rather than inferred from frame rate on purpose: a hidden
     * or backgrounded tab has requestAnimationFrame throttled to a few Hz, which
     * makes every wall-clock frame-time measurement meaningless.
     */
    async gpuCost(framesPerPass = 6): Promise<Record<string, number | string>> {
      const gl = engine.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as
        { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
      if (!ext) return { error: 'EXT_disjoint_timer_query_webgl2 unavailable' };

      const out: Record<string, number | string> = {};
      for (const pass of pipeline.composer.passes) {
        const label = describe(pass);
        if (!pass.enabled) { out[label] = 'disabled'; continue; }

        const target = pass as unknown as { render: (...a: unknown[]) => void };
        const orig = target.render.bind(pass);
        const queries: WebGLQuery[] = [];
        target.render = (...args: unknown[]): void => {
          const q = gl.createQuery();
          if (q === null) { orig(...args); return; }
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          orig(...args);
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          queries.push(q);
        };

        await settleFrames(framesPerPass);
        target.render = orig;
        // Give the GPU a couple of frames to retire the last queries.
        await settleFrames(2);

        const times: number[] = [];
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
        for (const q of queries) {
          if (!disjoint && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) === true) {
            times.push((gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6);
          }
          gl.deleteQuery(q);
        }
        if (disjoint || times.length === 0) { out[label] = 'no sample'; continue; }
        times.sort((a, b) => a - b);
        out[label] = +times[Math.floor(times.length / 2)].toFixed(3);
      }
      let total = 0;
      for (const v of Object.values(out)) if (typeof v === 'number') total += v;
      out['TOTAL_post_ms'] = +total.toFixed(3);
      return out;
    },

    toneMap(name: ToneMapName): string {
      pipeline.setToneMap(name);
      return name;
    },

    /**
     * Exposure ladder on a locked camera. The one number that has to be
     * re-trimmed whenever world lighting changes, so it gets its own fast mode
     * with no shader recompiles.
     */
    async autoExposure(shot = 'chase-straight'): Promise<unknown> {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.exp.status', 'running');
      try {
        const qa = await waitFor(() => (globalThis as unknown as Record<string, QaLike | undefined>).__QA__, 60000);
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        if (!qa || !game) throw new Error('no __QA__/__GAME__');
        if (game.race?.state === 'idle') game.startRace?.({});
        game.menus?.hideAll?.();
        await waitFor(() => (game.race?.state === 'racing' ? true : undefined), 40000);
        game.menus?.hideAll?.();
        await applyShot(qa, shot);

        const look = pipeline.gradeEffect.uniforms.get('gkLook')!.value as { x: number; z: number };
        const shipped = { x: look.x, z: look.z };
        const out: Record<string, unknown> = { shot, shipped };
        // Ladder around the shipped value. Read `meanSat` and `stdLuma` as well
        // as `meanLuma`: on this scene both *fall* as exposure rises, because
        // more of the image lands in the AgX shoulder where it desaturates.
        for (const e of [0.6, 0.7, 0.85, 1.0, 1.2, 1.5]) {
          look.x = e;
          await settleFrames(2);
          out['exposure_' + e] = await probe(engine);
        }
        look.x = shipped.x;
        look.z = shipped.z;
        await settleFrames(2);
        out['stats'] = qa.stats?.() ?? null;
        store('postqa.exp.result', out);
        store('postqa.exp.status', 'done');
        return out;
      } catch (err) {
        store('postqa.exp.status', 'error: ' + (err as Error).message);
        return { error: (err as Error).message };
      }
    },

    /**
     * The full post-chain report: histogram of the shipped frame, per-pass GPU
     * cost, which passes are live, and the buffer format/size. Written to
     * sessionStorage so it survives the dev server's reloads.
     */
    async autoReport(shot = 'chase-straight'): Promise<unknown> {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.report.status', 'running');
      try {
        const qa = await waitFor(() => (globalThis as unknown as Record<string, QaLike | undefined>).__QA__, 60000);
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        if (!qa || !game) throw new Error('no __QA__/__GAME__');
        if (game.race?.state === 'idle') game.startRace?.({});
        game.menus?.hideAll?.();
        await waitFor(() => (game.race?.state === 'racing' ? true : undefined), 40000);
        game.menus?.hideAll?.();
        // Free-fly, so the chase camera cannot drift between measurements.
        qa.harness?.takeCameraControl?.();
        await applyShot(qa, shot);

        const buf = pipeline.composer.inputBuffer;
        const out = {
          shot,
          visibility: document.visibilityState,
          probe: await probe(engine),
          gpuMs: await api.gpuCost(6),
          passes: pipeline.composer.passes.map((p) => ({ n: describe(p), on: p.enabled })),
          buffer: {
            width: buf.width,
            height: buf.height,
            type: buf.texture.type,
            isHalfFloat: buf.texture.type === 1016,
          },
          toneMap: pipeline.toneMap,
          stats: qa.stats?.() ?? null,
        };
        store('postqa.report.result', out);
        store('postqa.report.status', 'done');
        return out;
      } catch (err) {
        store('postqa.report.status', 'error: ' + (err as Error).message);
        return { error: (err as Error).message };
      }
    },

    /**
     * Everything the look needs to be judged on, in one unattended run:
     * a reference probe with the grade bypassed (what plain three.js AgX would
     * have produced on this exact frame), an exposure ladder, a tone-mapping
     * operator comparison, and an on/off probe for each expensive effect.
     * Results land in sessionStorage under `postqa.sweep.result`.
     */
    async autoSweep(shot = 'chase-straight'): Promise<unknown> {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.sweep.status', 'running');
      try {
        const qa = await waitFor(() => (globalThis as unknown as Record<string, QaLike | undefined>).__QA__, 40000);
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        if (!qa || !game) throw new Error('no __QA__/__GAME__');
        if (game.race?.state === 'idle') game.startRace?.({});
        game.menus?.hideAll?.();
        await waitFor(() => (game.race?.state === 'racing' ? true : undefined), 40000);
        game.menus?.hideAll?.();
        await applyShot(qa, shot);

        const grade = pipeline.gradeEffect;
        const look = grade.uniforms.get('gkLook')!.value as { x: number; z: number; w: number };
        const range = grade.uniforms.get('gkRange')!.value as { x: number; y: number; z: number };
        const tone = grade.uniforms.get('gkTone')!.value as { x: number; y: number; w: number };
        const saved = {
          x: look.x, z: look.z, w: look.w,
          rx: range.x, ry: range.y, rz: range.z,
          tx: tone.x, ty: tone.y, tw: tone.w,
        };
        const out: Record<string, unknown> = { shot, preset: { ...saved } };

        // Reference: grade fully bypassed, plain AgX. The "before" column.
        look.x = 1; look.z = 1; look.w = 1;
        range.x = 0; range.y = 1; range.z = 1;
        tone.x = 1; tone.y = 0; tone.w = 0;
        out['REF_plainAgX_noGrade'] = await probe(engine);

        // Tone-mapping operators, still ungraded, so the operator is isolated.
        for (const tm of ['agx', 'aces', 'neutral'] as ToneMapName[]) {
          pipeline.setToneMap(tm);
          await settleFrames(3);
          out['REF_' + tm] = await probe(engine);
        }
        pipeline.setToneMap('agx-punchy');
        await settleFrames(3);
        out['REF_agxPunchy_noGrade'] = await probe(engine);

        // Restore the real grade, then walk exposure.
        look.x = saved.x; look.z = saved.z; look.w = saved.w;
        range.x = saved.rx; range.y = saved.ry; range.z = saved.rz;
        tone.x = saved.tx; tone.y = saved.ty; tone.w = saved.tw;
        for (const e of [0.9, 1.05, 1.2, 1.35, 1.5]) {
          look.x = e;
          await settleFrames(2);
          out['exposure_' + e] = await probe(engine);
        }
        look.x = saved.x;
        await settleFrames(2);
        out['GRADED_asShipped'] = await probe(engine);

        // Per-effect image contribution.
        for (const pass of pipeline.composer.passes) {
          const label = describe(pass);
          if (!pass.enabled) { out['off_' + label] = 'already disabled'; continue; }
          if (pass === pipeline.composer.passes[0]) continue;
          if (pass === pipeline.composer.passes[pipeline.composer.passes.length - 1]) continue;
          pass.enabled = false;
          await settleFrames(2);
          out['without_' + label] = await probe(engine);
          pass.enabled = true;
        }
        await settleFrames(2);

        out['stats'] = qa.stats?.() ?? null;
        store('postqa.sweep.result', out);
        store('postqa.sweep.status', 'done');
        return out;
      } catch (err) {
        store('postqa.sweep.status', 'error: ' + (err as Error).message);
        return { error: (err as Error).message };
      }
    },

    /**
     * Orientation test for the canvas-texture helpers, used to settle the
     * "canvas text renders mirrored" report.
     *
     * Builds a texture whose left half is RED and right half is BLUE (plus
     * "ABC"), puts it on a stock `PlaneGeometry` facing the camera, and reads
     * the framebuffer back to decide which side the red half landed on. A
     * correct helper + correct UVs puts canvas-left on screen-left.
     *
     * Also reports the track frame's handedness and which world side a positive
     * lateral offset corresponds to, because that — not the texture — is what
     * mirrors geometry built from the track frame.
     */
    async uvTest(): Promise<Record<string, unknown>> {
      const game = (globalThis as unknown as { __GAME__?: Record<string, unknown> }).__GAME__;
      if (!game) return { error: 'need window.__GAME__' };

      const [THREE, tf, wt] = await Promise.all([
        import('three'),
        import('./TextureFactory'),
        import('../world/WorldTextures').catch(() => null),
      ]);

      const draw = (ctx: CanvasRenderingContext2D, w: number, h: number): void => {
        ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, w / 2, h);          // canvas LEFT
        ctx.fillStyle = '#0000ff'; ctx.fillRect(w / 2, 0, w / 2, h);      // canvas RIGHT
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(h * 0.5)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('ABC', w / 2, h / 2);
      };

      const eng = game.engine as { camera: import('three').PerspectiveCamera; scene: import('three').Scene };
      const cam = eng.camera;
      const scene = eng.scene;
      const prev = scene.getObjectByName('__UVTEST__');
      if (prev) scene.remove(prev);

      const results: Record<string, unknown> = {};
      const variants: Array<[string, import('three').Texture]> = [
        ['render/TextureFactory.canvasTexture', tf.canvasTexture(512, 256, draw)],
      ];
      if (wt?.canvasTexture) {
        variants.push(['world/WorldTextures.canvasTexture', wt.canvasTexture(512, draw, { height: 256 })]);
      }

      for (const [label, tex] of variants) {
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(8, 4),
          new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false, depthTest: false }),
        );
        mesh.name = '__UVTEST__';
        mesh.renderOrder = 100000;
        // Parented to the camera, so a moving chase camera cannot leave it
        // behind between the setup and the read-back.
        mesh.position.set(0, 0, -5);
        cam.add(mesh);
        await settleFrames(3);
        results[label] = await readSides(engine);
        cam.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as import('three').Material).dispose();
        tex.dispose();
      }

      // Track frame handedness + which way a positive lateral offset points.
      const track = game.track as {
        sampleAt?: (t: number) => {
          position: import('three').Vector3; tangent: import('three').Vector3;
          normal: import('three').Vector3; binormal: import('three').Vector3;
        };
      } | undefined;
      if (typeof track?.sampleAt === 'function') {
        const s = track.sampleAt(0.1);
        const txn = new THREE.Vector3().crossVectors(s.tangent, s.normal);
        results['trackFrame'] = {
          // +1 => binormal == tangent x normal (right-handed as built)
          // -1 => binormal is the mirror of that
          sign_of_binormal_vs_tangentCrossNormal: +txn.dot(s.binormal).toFixed(3),
          binormalPointsDriverRight: +new THREE.Vector3()
            .crossVectors(s.tangent, new THREE.Vector3(0, 1, 0)).dot(s.binormal).toFixed(3),
          tangent: s.tangent.toArray().map((v) => +v.toFixed(3)),
          normal: s.normal.toArray().map((v) => +v.toFixed(3)),
          binormal: s.binormal.toArray().map((v) => +v.toFixed(3)),
        };

        // Does the field actually drive along +tangent? Anything that derives an
        // orientation from the track frame (road decals, trackside signage) is
        // mirrored end-for-end if the answer is no — regardless of which canvas
        // helper drew the texture.
        const karts = game.karts as {
          player?: { position?: import('three').Vector3; yaw?: number; speed?: number };
        } | undefined;
        const p = karts?.player;
        if (p?.position) {
          // Nearest spline sample to the kart, by brute-force scan.
          let bestT = 0;
          let bestD = Infinity;
          for (let i = 0; i < 400; i++) {
            const t = i / 400;
            const d = track.sampleAt(t).position.distanceToSquared(p.position);
            if (d < bestD) { bestD = d; bestT = t; }
          }
          const near = track.sampleAt(bestT);
          const info: Record<string, unknown> = { nearestT: +bestT.toFixed(4) };
          if (typeof p.yaw === 'number') {
            const fwd = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
            info['dot_kartYawFwd_tangent'] = +fwd.dot(near.tangent).toFixed(3);
            const fwdNeg = fwd.clone().negate();
            info['dot_negKartYawFwd_tangent'] = +fwdNeg.dot(near.tangent).toFixed(3);
          }
          results['driveDirection'] = info;
        }
      }
      await settleFrames(2);

      // Bisection: blit the LIVE atlases straight into a DOM overlay. This shows
      // the source canvas with no geometry, no UVs and no shader in the way, so
      // it separates "the texture was painted mirrored" from "the texture was
      // mapped mirrored".
      results['atlasOverlay'] = showAtlasOverlay(scene, [
        ['apx-decals', 14, 4, 4],   // Decals FINISH cell, 4x4 atlas
        ['prop-atlas', 0, 4, 2],    // Props sponsor board cell, 4x2 atlas
      ]);
      return results;
    },

    /**
     * Drive the game to a canonical framing and probe it, writing the result to
     * sessionStorage. Runs itself on load when `postqa.auto` is set, so a
     * measurement survives the Vite reloads that a shared dev server produces
     * constantly — poll `postqa.status` instead of holding an await open.
     */
    async autoRun(shot = 'chase-straight'): Promise<unknown> {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.status', 'running');
      try {
        const qa = await waitFor(() => (globalThis as unknown as Record<string, QaLike | undefined>).__QA__, 30000);
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        if (!qa || !game) throw new Error('no __QA__/__GAME__');
        if (game.race?.state === 'idle') game.startRace?.({});
        game.menus?.hideAll?.();
        await waitFor(() => (game.race?.state === 'racing' ? true : undefined), 30000);
        game.menus?.hideAll?.();
        // Apply the shot's framing but settle on a wall clock, not a frame
        // count: CaptureHarness settles for 60 frames, which is two minutes when
        // the scene is running at 0.5 fps.
        qa.harness?.setHudVisible?.(true);
        await applyShot(qa, shot);
        const p = await probe(engine);
        const result = { shot, probe: p, stats: qa.stats?.() ?? null, toneMap: pipeline.toneMap };
        store('postqa.result', result);
        store('postqa.status', 'done');
        return result;
      } catch (err) {
        store('postqa.status', 'error: ' + (err as Error).message);
        return { error: (err as Error).message };
      }
    },
    exposure(v: number): number {
      pipeline.setExposure(v);
      return v;
    },
    passes(): Array<{ name: string; enabled: boolean }> {
      return pipeline.composer.passes.map((p) => ({ name: describe(p), enabled: p.enabled }));
    },
    stats: () => pipeline.getStats(),
  };

  (globalThis as unknown as Record<string, unknown>).__POST__ = api;
  console.info('[PostQA] window.__POST__ ready — probe() passCost() toneMap() exposure() passes() autoRun()');

  let auto = '';
  try { auto = sessionStorage.getItem('postqa.auto') ?? ''; } catch { /* ignore */ }
  const shot = (() => { try { return sessionStorage.getItem('postqa.shot') ?? 'chase-straight'; } catch { return 'chase-straight'; } })();
  if (auto === '1') void api.autoRun(shot);
  else if (auto === 'sweep') void api.autoSweep(shot);
  else if (auto === 'report') void api.autoReport(shot);
  else if (auto === 'exposure') void api.autoExposure(shot);
  else if (auto === 'uv') {
    void (async () => {
      const store = (k: string, v: unknown): void => {
        try { sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* ignore */ }
      };
      store('postqa.uv.status', 'running');
      try {
        const game = (globalThis as unknown as Record<string, GameLike | undefined>).__GAME__;
        await waitFor(() => (globalThis as unknown as Record<string, unknown>).__QA__, 60000);
        if (game?.race?.state === 'idle') game.startRace?.({});
        game?.menus?.hideAll?.();
        await waitFor(() => (game?.race?.state === 'racing' ? true : undefined), 30000);
        store('postqa.uv.result', await api.uvTest());
        store('postqa.uv.status', 'done');
      } catch (err) {
        store('postqa.uv.status', 'error: ' + (err as Error).message);
      }
    })();
  }
}

/** Wait n presented frames. */
async function settleFrames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

/**
 * Find named materials in the scene, crop one atlas cell out of each one's map
 * canvas, and blit them into a fixed DOM overlay at the top of the page.
 *
 * The point is to look at the *source* pixels. If text is already reversed here
 * then whatever painted the canvas is at fault; if it reads correctly here but
 * reversed in the world, the UVs or the quad orientation are at fault.
 */
function showAtlasOverlay(
  scene: import('three').Scene,
  want: Array<[string, number, number, number]>,
): string[] {
  const found: string[] = [];
  document.getElementById('__ATLASDBG__')?.remove();
  const host = document.createElement('div');
  host.id = '__ATLASDBG__';
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;display:flex;gap:8px;'
    + 'background:#000;padding:6px;font:12px monospace;color:#fff';

  const maps = new Map<string, HTMLCanvasElement>();
  scene.traverse((o) => {
    const mats = (o as { material?: unknown }).material;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const mat = m as { name?: string; map?: { image?: unknown } } | undefined;
      const img = mat?.map?.image;
      if (mat?.name && img instanceof HTMLCanvasElement && !maps.has(mat.name)) {
        maps.set(mat.name, img);
      }
    }
  });

  for (const [name, cell, cols, rows] of want) {
    const src = maps.get(name);
    const wrap = document.createElement('div');
    if (!src) {
      wrap.textContent = name + ': not found';
      host.appendChild(wrap);
      continue;
    }
    found.push(`${name} ${src.width}x${src.height}`);
    const cw = src.width / cols;
    const ch = src.height / rows;
    const sx = (cell % cols) * cw;
    const sy = Math.floor(cell / cols) * ch;
    const out = document.createElement('canvas');
    out.width = 360;
    out.height = Math.round(360 * (ch / cw));
    const c = out.getContext('2d');
    if (c) {
      c.fillStyle = '#222';
      c.fillRect(0, 0, out.width, out.height);
      c.drawImage(src, sx, sy, cw, ch, 0, 0, out.width, out.height);
    }
    out.style.cssText = 'border:1px solid #0f0;display:block';
    const label = document.createElement('div');
    label.textContent = `${name} cell ${cell}`;
    wrap.appendChild(label);
    wrap.appendChild(out);
    host.appendChild(wrap);
  }
  document.body.appendChild(host);
  return found;
}

/**
 * Read the finished frame and report the mean red/blue of its left and right
 * thirds. Used by `uvTest` to decide, without human eyes, which way round a
 * texture landed on screen.
 */
function readSides(engine: EngineLike): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const gl = engine.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      engine.renderer.setRenderTarget(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

      const band = (x0: number, x1: number): { r: number; b: number } => {
        let r = 0; let b = 0; let n = 0;
        const y0 = Math.floor(h * 0.4);
        const y1 = Math.floor(h * 0.6);
        for (let y = y0; y < y1; y += 2) {
          for (let x = Math.floor(w * x0); x < Math.floor(w * x1); x += 2) {
            const i = (y * w + x) * 4;
            r += buf[i]; b += buf[i + 2]; n++;
          }
        }
        return { r: +(r / n / 255).toFixed(3), b: +(b / n / 255).toFixed(3) };
      };
      const left = band(0.30, 0.45);
      const right = band(0.55, 0.70);
      const redIsLeft = left.r - left.b > right.r - right.b;
      resolve({
        screenLeft: left,
        screenRight: right,
        // The texture's red half is the CANVAS LEFT half.
        canvasLeftLandedOn: redIsLeft ? 'screen-LEFT (correct)' : 'screen-RIGHT (MIRRORED)',
        mirrored: !redIsLeft,
      });
    }));
  });
}

interface HarnessLike {
  releaseCameraControl?: () => void;
  takeCameraControl?: () => void;
  onTrack?: (t: number, opts?: Record<string, number>) => void;
  setHudVisible?: (v: boolean) => void;
}
interface QaLike {
  shot(name: string): Promise<Record<string, number | string>>;
  harness?: HarnessLike;
  stats?: () => Record<string, number | string>;
}

/** The camera framings we care about, without CaptureHarness's frame-count settle. */
const FRAMINGS: Record<string, { chase: boolean; t: number; opts: Record<string, number> }> = {
  'chase-straight': { chase: true, t: 0.08, opts: { back: 7.5, up: 2.6, lookAhead: 30 } },
  'chase-boost': { chase: true, t: 0.35, opts: { back: 6.5, up: 2.3, lookAhead: 40 } },
  'pack-battle': { chase: true, t: 0.5, opts: { back: 11, up: 4.2, lookAhead: 26 } },
  'scenery-vista': { chase: false, t: 0.62, opts: { back: 4, up: 24, side: 40, lookAhead: 10, fov: 55 } },
  'grid-wide': { chase: false, t: 0.985, opts: { back: -26, up: 13, lookAhead: 60, fov: 48 } },
};

async function applyShot(qa: QaLike, name: string): Promise<void> {
  const f = FRAMINGS[name];
  const h = qa.harness;
  if (f && h) {
    // Always end in free-fly. `onTrack` gives us the chase-like framing we want,
    // but leaving the camera in chase mode lets the controller move it between
    // successive probes — which silently invalidates any A/B comparison.
    h.takeCameraControl?.();
    h.onTrack?.(f.t, f.opts);
  } else {
    // Not one of ours (e.g. kart-hero needs the live kart) — fall back.
    await qa.shot(name);
    return;
  }
  // Wall-clock settle, capped, plus a couple of frames so the camera lands.
  const end = Date.now() + 1200;
  do {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  } while (Date.now() < end);
}
interface GameLike {
  race?: { state?: string };
  menus?: { hideAll?: () => void };
  startRace?: (opts: Record<string, unknown>) => void;
}

/** Poll `fn` until it returns something truthy, or give up after `ms`. */
async function waitFor<T>(fn: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await new Promise<void>((r) => setTimeout(r, 250));
  }
}

function describe(pass: { name?: string; effects?: Array<{ name: string }> }): string {
  const fx = pass.effects;
  if (fx && fx.length > 0) return fx.map((e) => e.name.replace('Effect', '')).join('+');
  return pass.name ?? 'Pass';
}
