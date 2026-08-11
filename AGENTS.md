# FOXY KART — Build Contract

You are one of ~12 agents building a Mario Kart 8 Deluxe–class racing game in Three.js.
**Read this file completely before writing code.** It is the law.

---

## 0. The bar

Every pixel is judged against **Mario Kart 8 Deluxe running at 4K**. A separate
adversarial critic agent screenshots the game and compares it blind against real
MK8DX frames. "Looks like a decent WebGL demo" is a **failure**. The target is
"I genuinely can't tell which one is the Nintendo game."

Concretely that means:
- **No flat/untextured surfaces.** Everything has albedo + roughness + normal detail.
- **No default `MeshStandardMaterial` with a solid colour.** Ever.
- **Readable silhouettes**, saturated but controlled colour, strong key/rim lighting.
- **Motion is animated**, never linear-lerped. Anticipation, overshoot, settle.
- **60 fps at 1080p** on an M-series Mac. Budget matters as much as beauty.

---

## 1. Hard rules

1. **Own only your files.** The file list in your task is yours exclusively.
   Never edit another agent's files. Never edit `src/core/*` or `src/game/Game.ts`
   (report needed changes instead — they'll be integrated centrally).
2. **Contracts are in `src/core/Types.ts`.** Import types from there. Do not
   invent parallel interfaces. Do not import another subsystem's internals —
   you receive everything you need via your constructor.
3. **Zero network requests at runtime.** No CDN textures, no external models,
   no fonts fetched at runtime. Everything is **generated procedurally in code**
   (canvas 2D, DataTexture, noise, shaders) or authored as geometry in TS.
   This is non-negotiable — the game must run fully offline from `dist/`.
4. **No `any`.** Strict TypeScript. `npx tsc --noEmit` must pass.
5. **Zero allocations in hot loops.** Reuse vectors from `@/core/MathUtils`'s
   `scratch`, or your own module-level temporaries. No `new THREE.Vector3()`
   inside `update()`/`fixedUpdate()`.
6. **Dispose properly.** Every geometry/material/texture you create is released
   in `dispose()`.
7. **Respect `QualitySettings`.** Your subsystem must degrade on `low` and look
   its best on `ultra`.
8. **Frame-rate independence.** Use `damp()` from MathUtils, not naive
   `lerp(a,b,0.1)` per frame.

---

## 2. Units & conventions

- **Metres and seconds.** A kart is ~1.9 m long, ~1.4 m wide. Road is ~22 m wide.
- **Y is up. -Z is forward.** Karts face -Z in local space.
- Top speed ~ **28 m/s** base (≈100 km/h), ~40 m/s with boost.
- Colours authored in **sRGB**; set `texture.colorSpace = THREE.SRGBColorSpace`
  on albedo/emissive maps only. Normal/roughness/AO maps stay linear (`NoColorSpace`).
- Tone mapping is **AgX** with exposure 1.0 — author materials for that.
  Emissive values above 1.0 are expected for anything that should bloom.

---

## 3. Procedural asset guidance (this is where AAA is won or lost)

You cannot download textures. Generate them. Techniques that work:

- **Canvas 2D → CanvasTexture** for anything with shapes, logos, decals, road
  markings, character faces, UI atlases. Draw at 1024–2048 px, use gradients,
  `globalCompositeOperation`, and multi-pass noise stippling.
- **Procedural normal maps**: build a height field (Float32Array), then Sobel it
  into an RGB DataTexture. A helper for this belongs in your own module unless
  `src/render/TextureFactory.ts` already exposes it — **check there first**,
  it is the shared texture library.
- **Detail-normal blending**: a 4× tiled fine normal on top of a 0.25× tiled
  macro normal kills the "plastic" look instantly.
- **Triplanar mapping** for terrain avoids stretched UVs on slopes.
- **Vertex colour + AO baking** into geometry is cheap and enormously effective.
- **Onshader gradients / ramps** beat flat colours: even a 2 % hue shift across
  a surface reads as "art directed".

Anti-patterns that instantly fail review: uniform flat colour, tiling so obvious
you can count the repeats, mirror-smooth roughness everywhere, no ambient
occlusion in crevices, geometry with visible hard-edged low-poly silhouettes
where MK8 would have a smooth chamfer.

---

## 4. Shared texture library

`src/render/TextureFactory.ts` is owned by the **Render Pipeline agent** and
exports procedural texture helpers (noise, normal-from-height, checker, gradient
ramps, tri-planar helpers, anisotropy application). If it does not exist yet
when you start, **write your own local helpers** — do not block. Integration
will de-duplicate later.

---

## 5. Verification you must do yourself

Before you report done:

```bash
npx tsc --noEmit          # must be clean for YOUR files
```

Note: `npx tsc --noEmit` reports errors across the whole project, including
other agents' in-progress files. **Only fix errors in files you own.**

### ⚠️ THE BROWSER PANE IS A SINGLE SHARED RESOURCE

There is **one** Browser pane for the whole session, shared by every agent. If
two agents drive it at once they fight over tabs — one navigates away, the other
finds the game tab gone, and both stall waiting on a pane that no longer shows
what they expect. This has already deadlocked four agents simultaneously.

Rules:
- **Only one agent does visual verification at a time.** The integrator
  serialises this. If you were dispatched alongside other agents, assume you may
  NOT have the pane unless your task says you have exclusive access.
- If you need reference images, open them in a **new tab** (`tabs_create`) and
  **close it when done** (`tabs_close`). Never navigate the game tab away.
- Always re-assert your tab with `tabs_select` and confirm with `tabs_context`
  before screenshotting — another agent may have fronted something else.
- If the pane is not showing what you expect, **do not retry in a loop.** Report
  that the pane was contended and move on to work that doesn't need it.

### Running the real game — EXACT SEQUENCE

**⚠️ THE 0×0 VIEWPORT TRAP.** The preview tab opens at a 0×0 viewport, and
`requestAnimationFrame` never fires at 0×0. Any init path that yields on rAF
will hang forever and the boot screen sits at "Initializing". This is *not* a
broken build — it is a sized-viewport problem. Always resize first:

**⚠️ RESOLUTION TRAP — read this before you set a viewport.** The pane renders
the page 1:1 **only at 800×450**. Ask for 1600×900 or 960×540 and it renders
into a ~560×315 sub-region of an 800×450 screenshot — a 0.28–0.44× downscale
that destroys exactly the fine surface detail you are trying to judge. Either
capture at 800×450, or force a larger backing store yourself:
`renderer.setPixelRatio(2.4)` gives a true 1920×1080 buffer.

1. `mcp__Claude_Browser__preview_start` → `{ "name": "kart" }`
2. `mcp__Claude_Browser__resize_window` → `{ "width": 800, "height": 450 }`
3. Wait for the boot overlay to reach "Ready" (~20 s on a cold shader cache).
4. Start a race via `mcp__Claude_Browser__javascript_tool`:
   `window.__GAME__.startRace({})`
5. `mcp__Claude_Browser__computer` → `{"action":"screenshot"}`
6. `mcp__Claude_Browser__read_console_messages` — **zero errors from your files.**

Corollary for your own code: **never assume rAF will fire.** If you yield
during `init()`, race it against a `setTimeout` fallback so a hidden or
zero-size tab cannot deadlock startup.

### The QA harness

`window.__GAME__` exposes the whole game. `window.__QA__` (dev builds only,
see `src/qa/CaptureHarness.ts`) gives you reproducible measurement:

- `__QA__.shot(name)` — jump to a canonical framing, settle, and **verify the
  subject is in frame**. Names: `chase-straight`, `chase-corner-drift`,
  `chase-boost`, `kart-hero`, `grid-wide`, `pack-battle`, `scenery-vista`,
  `hud-full`, `driver-eye`.
  **Always check the returned `subject.inFrame`.** If it is `false` the capture
  failed and the image says nothing about the game — re-run, don't judge it.
  (Framings are positioned in the kart's own basis for exactly this reason; an
  earlier revision positioned off a track `t` value and 5 of 8 shots contained
  no kart at all.)
- `__QA__.validateShots()` — run every framing and report which contain the
  subject. **Do this once at the start of any review run.**
- `__QA__.benchmark(5)` — medianFps, p95Ms, 1 % low, draw calls, triangles.
- `__QA__.stats()`, `__QA__.setSky(preset)`, `__QA__.setQuality(tier)`.

Use these rather than ad-hoc camera placement — two runs are then comparable,
so you can prove a change helped instead of guessing.

If your subsystem isn't visible yet because another agent's part isn't done,
build a temporary standalone harness page under `src/dev/<yourname>.html` +
`.ts` so you can still see and iterate on your own work. Delete it when done.

## 5b. Performance budget (measured on the real game, 1600×900, ultra)

The whole frame must fit **16.6 ms**. Current standing budget:

| Subsystem   | Draw calls | Triangles | Frame cost |
|-------------|-----------:|----------:|-----------:|
| Environment |       ≤120 |     ≤1.2M |      ≤6 ms |
| Karts (×12) |       ≤120 |      ≤300k|      ≤2 ms |
| Track       |        ≤40 |      ≤400k|      ≤2 ms |
| VFX         |        ≤30 |       ≤50k|      ≤3 ms |
| HUD         |          — |         — |    ≤0.4 ms |

**Watch the multiplier, not just the scene.** Every shadow cascade and every
planar reflection re-renders the scene. If `renderer.info.render.triangles` is
several times the triangle count actually present in the scene graph, you have
too many full-scene passes — that is usually the real bug, not the geometry.

---

## 6. Reporting

When finished, report: files created, what's implemented, what you verified
visually, known gaps, and anything you need from another subsystem. Be honest
about what isn't done — a false "complete" wastes everyone's next loop.
