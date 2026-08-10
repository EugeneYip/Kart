import { Game } from '@/game/Game';
import { bus } from '@/core/EventBus';
import type { QualityTier } from '@/core/Types';

/** Pick a starting quality tier from a cheap GPU probe. */
function detectTier(): QualityTier {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) return 'low';

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') as string;
  const r = (renderer || '').toLowerCase();

  const mobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  if (mobile) return 'medium';

  // Software rasterisers and old integrated parts get the cheap path.
  if (/swiftshader|llvmpipe|software|microsoft basic/.test(r)) return 'low';
  if (/intel.*(hd|uhd) graphics (5|6)\d{2}/.test(r)) return 'low';

  const cores = navigator.hardwareConcurrency ?? 4;
  if (/rtx|radeon rx (6|7|9)|apple m[1-9]|geforce (30|40|50)/.test(r) && cores >= 8) return 'ultra';
  if (cores >= 8) return 'high';
  return 'medium';
}

const bootEl = document.getElementById('boot')!;
const fillEl = document.getElementById('boot-fill') as HTMLDivElement;
const msgEl = document.getElementById('boot-msg') as HTMLDivElement;

bus.on('engine:progress', ({ loaded, total, message }) => {
  fillEl.style.width = `${Math.round((loaded / total) * 100)}%`;
  msgEl.textContent = message;
});

async function boot() {
  const container = document.getElementById('app')!;
  const tier = detectTier();
  console.info(`[APEX KART] quality tier: ${tier}`);

  const game = new Game(container, tier);
  (globalThis as Record<string, unknown>).__GAME__ = game; // for the debug console + automated QA

  try {
    await game.init();
  } catch (err) {
    console.error('[APEX KART] init failed', err);
    msgEl.textContent = 'Failed to start — see console';
    msgEl.style.color = '#ff7a7a';
    throw err;
  }

  if (import.meta.env.DEV) {
    const { installCaptureHarness } = await import('@/qa/CaptureHarness');
    installCaptureHarness(game);
  }

  fillEl.style.width = '100%';
  msgEl.textContent = 'Ready';
  game.start();

  // Hold the boot screen one beat so the first frames can warm the shader cache.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    setTimeout(() => {
      bootEl.classList.add('hidden');
      setTimeout(() => bootEl.remove(), 700);
    }, 120);
  }));
}

boot();
