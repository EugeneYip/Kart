# FOXY KART — Build Contract

You are working on a Mario Kart 8 Deluxe–class racing game in Three.js.
**Read this file completely before writing code.** It is the law.

This file is **provider-neutral**. Where a check needs a capability — a browser
you can drive, a real phone — it states the capability, not a tool. Concrete
tool invocations appear only inside blocks explicitly labelled as adapter
examples, and those are illustrative: **use whatever equivalent your environment
provides.** If you have no equivalent, see
[Working without browser automation](#working-without-browser-automation) in §5.

> **Orientation for a new maintainer or model.** This document is the
> *contract*. For everything else: [`README.md`](README.md) is the front door,
> [`PROJECT_STATE.md`](PROJECT_STATE.md) is what is true right now,
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is where the code lives,
> [`docs/QA.md`](docs/QA.md) is how to verify, and
> [`docs/DECISIONS.md`](docs/DECISIONS.md) is what not to undo.
>
> The historical note that used to live here — "you are one of ~12 agents" —
> describes how the project was originally built in parallel, and it explains
> the ownership rules in §1 and the feature-probing patterns throughout the
> code. **A single maintainer working alone still follows §1**: it is what keeps
> subsystems replaceable.

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

1. **Own only your files, and treat the shared spine as owner-approval territory.**
   The file list in your task is yours exclusively; never edit another agent's
   files.

   `src/core/*` and `src/game/Game.ts` are the **shared spine**: `Types.ts` is the
   contract every subsystem imports, `Game.ts` is the composition root and the
   subsystem order, `Engine.ts` owns the loop, `Config.ts` owns the quality tiers
   and `Input.ts` the key map. A change there can move behaviour in a subsystem
   nobody is looking at.

   This rule originally read "never edit — they'll be integrated centrally",
   written when ~12 agents worked in parallel behind an integrator. **There is no
   central integrator now.** Read literally, that would forbid the most ordinary
   changes in the project — `docs/ARCHITECTURE.md` correctly routes you to
   `Config.ts` for tick rate, `Types.ts` for any new cross-module field,
   `GameEvents` for any new event, and `Game.ts` for subsystem ordering. So the
   rule is not a prohibition; it is a **gate**:

   - Say plainly, before you edit, that the change touches the shared spine, and
     why the alternative — keeping it inside your own subsystem — does not work.
   - Get the owner's agreement. They are the integrator.
   - Then make the smallest change that works, and name every subsystem that
     reads what you changed.

   Editing the spine *quietly* is the thing this rule forbids.
2. **Contracts are in `src/core/Types.ts`.** Import types from there. Do not
   invent parallel interfaces. Do not import another subsystem's internals —
   you receive everything you need via your constructor.
3. **Zero network requests at runtime.** No CDN textures, no external models,
   no fonts fetched at runtime. Everything is **generated procedurally in code**
   (canvas 2D, DataTexture, noise, shaders) or authored as geometry in TS.
   This is non-negotiable — the game must run fully offline from `dist/`.
   *Narrow exception, and it is not a gameplay exception:* page-level
   presentation and discovery assets — favicons, app icons, social-preview
   artwork, `site.webmanifest`, `robots.txt`, `sitemap.xml` — are allowed under
   `public/`. They are fetched by the browser chrome and by crawlers, never by
   the game. **Gameplay code must not depend on them or fetch them at runtime**,
   so do not delete them as rule-3 violations and do not read this as licence to
   load a texture, model, font or sound from a file.
4. **No `any`.** Strict TypeScript. `npx tsc --noEmit` must pass.
5. **Zero allocations in hot loops.** Reuse vectors from `@/core/MathUtils`'s
   `scratch`, or your own module-level temporaries. No `new THREE.Vector3()`
   inside `update()`/`fixedUpdate()`.
   *Accuracy note, 2026-08:* the rule is honoured everywhere, but **no file
   currently imports `scratch`** — every hot module declares its own
   module-level temporaries instead (`_v1.._v4` in `Suspension.ts`, `_ctrl` in
   `RaceDirector.ts`, and so on). Follow the local pattern of the file you are
   editing. The requirement — zero allocation after construction — is unchanged.
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

### ⚠️ BROWSER AUTOMATION IS USUALLY A SINGLE SHARED RESOURCE

In most agent environments there is **one** browser surface for the whole
session. If two workers drive it at once they fight over tabs — one navigates
away, the other finds the game tab gone, and both stall waiting on a view that
no longer shows what they expect. This has already deadlocked four workers
simultaneously.

Rules (capability-level — apply them with whatever browser control you have):
- **Only one worker does visual verification at a time.** Whoever integrates
  serialises this. If you were dispatched alongside others, assume you may NOT
  have the browser unless your task says you have exclusive access.
- If you need reference images, open them in a **new tab** and **close it when
  done**. Never navigate the game tab away.
- Always **re-assert and confirm which tab is fronted** before screenshotting —
  someone else may have changed it.
- If the browser is not showing what you expect, **do not retry in a loop.**
  Report that it was contended and move on to work that does not need it.

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

**Required sequence — capability level. Do this in whatever tooling you have:**

1. **Start the dev server** (`npm run dev`, serving `http://127.0.0.1:5173`) and
   open it. A launch config named `kart` exists at `.claude/launch.json` for
   environments that consume one.
2. **Resize the viewport to 800×450 before the page renders anything you intend
   to judge.** See the two traps above — this is not optional.
3. **Wait for the boot overlay to reach "Ready"** (~20 s on a cold shader cache).
4. **Start a race** by evaluating `window.__GAME__.startRace({})` in the page.
5. **Screenshot.**
6. **Read the console — zero errors from your files.**

<details>
<summary><b>Claude-specific adapter example</b> (illustrative only — substitute your own tooling)</summary>

```
1. mcp__Claude_Browser__preview_start       → { "name": "kart" }
2. mcp__Claude_Browser__resize_window       → { "width": 800, "height": 450 }
3. (wait for "Ready")
4. mcp__Claude_Browser__javascript_tool     → window.__GAME__.startRace({})
5. mcp__Claude_Browser__computer            → { "action": "screenshot" }
6. mcp__Claude_Browser__read_console_messages
```

</details>

Corollary for your own code: **never assume rAF will fire.** If you yield
during `init()`, race it against a `setTimeout` fallback so a hidden or
zero-size tab cannot deadlock startup.

### The QA harness

`window.__GAME__` exposes the whole game. `window.__QA__` (dev builds only,
see `src/qa/CaptureHarness.ts`) gives you reproducible measurement:

> **Know which of these ships.** `__GAME__` is assigned unconditionally in
> `src/main.ts` and **is present in production bundles**. `__QA__` and
> `__POST__` are behind `if (import.meta.env.DEV)` dynamic imports and are
> tree-shaken out entirely — verified zero occurrences in `dist/assets/*.js`.
> Everything under `src/dev/` is likewise absent, because those harness pages
> are not build inputs. Do not make a shipped code path depend on any of them.

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

### Working without browser automation

**Not having a browser does not excuse you from verification, and it does not
license you to guess.** It changes what you may claim.

**Still fully available to you — run all of it:**

```bash
rm -rf node_modules && npm ci && npm run build   # the real CI reproduction
npm run typecheck                                # tsc --noEmit alone
node src/dev/node-run.mjs src/dev/physics-run.ts # the physics assertion battery
node src/dev/node-run.mjs .probe-tmp/<probe>.ts  # 38 tracked circuit probes
npx tsc -p tsconfig.<subsystem>-check.json       # optional scoped typecheck
```

Plus every static check that reads the **built** artifact rather than the
source: relative app asset URLs in `dist/index.html`, `__QA__`/`__POST__` absent
from `dist/assets/*.js`, `public/` copied, manifest and sitemap parsing.

**What you must NOT do:**

- Do not report a visual or hardware property as verified.
- Do not infer "it renders correctly" from "it compiles and the numbers look
  right". A mechanic that never fires renders identically to one that does not
  exist — that is why the headless runner exists in the first place.
- Do not silently omit the gap.

**What you MUST do instead — report it as unverified and delegate it.** Name the
specific checks that need a browser or a device, and say who or what has to run
them. For example:

> Build green, physics battery 34/8, bundle checks pass. **UNVERIFIED — needs a
> browser:** on-screen appearance of the new spark tier, and console-error
> count. **UNVERIFIED — needs real hardware:** simultaneous steer + drift on a
> phone. Both delegated.

That is a complete, useful, honest report. A confident guess is not, and costs
the next person their whole loop.

**Real hardware outranks synthetic evidence for touch UX.** Synthetic pointer
events have repeatedly failed to reproduce what a thumb does — see
[`docs/QA.md` §1.7](docs/QA.md).

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

**Label every claim by the kind of evidence behind it**, because these are not
interchangeable:

- **Measured** — a number came out of a probe you can re-run. Give the command
  and the number.
- **Visually judged** — you looked at a frame and formed an opinion.
- **Intentionally accepted** — a known deviation, with the reason.
- **Unverified** — you could not check it. **Say so explicitly and name what it
  needs** (a browser, a real device, production access), so it can be
  delegated rather than silently assumed.

A screenshot is not a measurement, and a measurement nobody has looked at is not
evidence that the game looks right. See [`docs/QA.md`](docs/QA.md) for the full
standard, and update [`PROJECT_STATE.md`](PROJECT_STATE.md) in the same commit
as the change it describes.
