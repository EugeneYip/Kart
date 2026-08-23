# Foxy Kart — verification

**How to know a change is good, and what counts as evidence.**

This document is provider-neutral. It states the *capability* a check needs —
"a browser you can drive and screenshot", "a real phone" — never a particular
tool or vendor. Adapter examples for one specific toolchain are in
[`../AGENTS.md`](../AGENTS.md) and are clearly labelled as such.

See also: [`../PROJECT_STATE.md`](../PROJECT_STATE.md) ·
[`ARCHITECTURE.md`](ARCHITECTURE.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md) ·
[`DECISIONS.md`](DECISIONS.md)

---

## 0. There is no test runner

> **`npm test` does not exist. Do not invent it, and do not imply it exists.**

`package.json` declares exactly four scripts:

```bash
npm run dev        # vite — dev server on 127.0.0.1:5173
npm run build      # tsc --noEmit && vite build
npm run typecheck  # tsc --noEmit
npm run preview    # vite preview --port 4173  (serves the BUILT dist/)
```

Everything else is a **probe**: a script that measures something specific and
prints numbers. Probes run through the headless runner (§2) or in a browser
harness page (§3). That is the whole verification surface. It is deliberate —
the failures this project actually has are geometric, numeric, and visual, and
none of them is caught by a unit test of a pure function.

---

## 1. The philosophy — read before you report anything

These are not style preferences. Every one of them was written after a real
failure in this repository, and most are traceable to a commit body.

### 1.1 Label the kind of evidence you have

Three kinds, and they are not interchangeable:

| Kind | What it means | Example |
|---|---|---|
| **Measured** | A number came out of a probe you can re-run | "20 rising-edge wall contacts in 25 s" |
| **Visually judged** | A person looked at a frame and formed an opinion | "the fur reads as plastic" |
| **Intentionally accepted** | A known deviation, accepted on purpose, with a reason | "the HUD is exempt from the legibility floor" |

Never promote one to another. A screenshot is not a measurement. A measurement
that nobody has looked at is not a judgment that the game looks right.

### 1.2 A test that cannot fail is worthless

**This is the project's defining QA rule**, and it has been violated enough
times to be treated as the default suspicion about any green result.

Three recorded instances:

- **`896c997`** — a depth-calibration arm reported `worst error 0.000 m` and
  `PASS` even with the bisection deliberately sabotaged, because every inset
  chosen for the test (0.25, 0.5, 1, 2, 4, 8) was an exact multiple of the
  march's 0.25 m step, so the crippled search landed on all six by
  construction. Off-grid insets separated them immediately: healthy 0.004 m,
  sabotaged 0.180 m.
- **`7810e8b`** — a shoulder probe asserted that ground truth was "a different
  code path from the resampler under test". It was the same code path: three
  functions, one number. It recorded `worst |Δ| 0.000 m` on 8/8 circuits and
  *could not have recorded anything else*. In the same commit, a roster guard
  was found to be grading a hand-transcribed copy of the function it guarded,
  having never imported it.
- **`6233437`** — a pointer guard was written, could not be made to fail even
  with the guard deliberately disabled, and was therefore **deleted rather than
  shipped**. The comment explaining why ships instead.

**Practice:** before you trust a green probe, break the thing it tests on
purpose and confirm the probe goes red. If it does not, you have learned nothing
and the probe is the defect.

### 1.3 A failing probe may mean the probe is wrong

The symmetric rule. A red result is a claim about *the probe plus the code*, and
you do not know which half is broken until you look.

`95d910e` is the cautionary case in both directions: every geometric audit in
the project had been running at the `low` quality tier, because prop scatter
density follows the tier — 7476 instances at low against 8889 at ultra, so
**15.9 % of the shipping world had never been audited.** The methodology debt
was real; re-run at `ultra`, the conclusion survived. Fix the instrument, then
re-ask the question. Do not assume either answer.

### 1.4 Never widen a tolerance to make something pass

If a threshold is failing, the acceptable moves are: fix the code, fix the
probe, or **document the deviation as intentionally accepted with a reason and a
reopening rule**. Editing the expected range so the number fits is none of
those. It destroys the only signal the check ever had.

### 1.5 Do not wave away an unexplained nonzero

`G2` in the archived handoff is the example: a probe flagged 24 occlusion
samples and an agent dismissed them as "likely a false positive of a flat-road
test on tube geometry". The owner later confirmed they were real. The dismissal
was a guess dressed as an analysis.

If a number is not zero and you cannot say *why*, the honest report is "nonzero
and unexplained", not "probably fine".

### 1.6 Verify the built artifact, not only the source

Source-level greps do not tell you what shipped. Several properties of this
project are only true of `dist/`:

- that app asset URLs are relative;
- that `__QA__` and `__POST__` are absent;
- that `public/` was copied;
- that the metadata in `<head>` survived the build.

`33651d1`, `b4832ab` and `627401c` all check the **built** `dist/index.html`
explicitly, not `index.html`. Do the same.

### 1.7 Real hardware outranks synthetic evidence for touch

For touch UX this is a hard ordering, not a preference. Synthetic pointer events
have repeatedly failed to reproduce what a thumb does:

- `2062cda` records "Not verified" for simultaneous steer + drift/item/brake
  because synthetic `pointerdown` on the button did not register in the harness
  — and says so rather than claiming a pass.
- `4638be6` exists *because* a hardware test rejected three rounds of numeric
  tuning that all looked correct on paper.

**If you cannot test on a device, say the finding is unverified and delegate
it.** Do not upgrade a plausible synthetic result into a claim.

### 1.8 Report honestly, including what you did not do

A false "complete" costs more than an admitted gap, because it removes the next
person's reason to look. State what you verified, how, and what you could not.

---

## 2. Baseline build validation

**Run this first, before you change anything, and again before you report.** It
establishes that the tree was green when you arrived.

```bash
rm -rf node_modules
npm ci
npm run build
```

**The clean install is not ceremony.** `b4832ab` records the first real CI run
failing at `tsc --noEmit` because `@types/node` was absent from the lockfile,
while a locally drifted `node_modules` compiled fine. The stated defect in that
commit is not the missing dependency — it is that *the readiness test was not
reproducing CI*. `npm install` and a warm `node_modules` do not reproduce CI;
`npm ci` from an empty tree does.

Expected at the current baseline — `Directly verified:`, run 2026-08-23:

```
npm ci     → exit 0    added 32 packages, audited 33, 0 vulnerabilities
npm build  → exit 0    157 modules transformed
```

A chunk-size warning above 500 kB is expected and accepted; see
[`DECISIONS.md`](DECISIONS.md).

### Typecheck

`npm run build` already gates on `tsc --noEmit`, so a green build implies a
green typecheck. `npm run typecheck` runs it alone when you want the faster
loop.

**No `any`, strict mode, and the typecheck is part of the build by design** — a
type error must fail the deploy rather than ship. Do not "temporarily" replace
`npm run build` with a bare `vite build`.

### The scoped typecheck configs

Ten `tsconfig.*-check.json` files at the repo root narrow the compile to one
subsystem (`ai`, `audio`, `camera`, `items`, `karts`, `physics`, `render`,
`track`, `vfx`, `world`):

```bash
npx tsc -p tsconfig.physics-check.json
```

They are **not wired into any npm script** and are optional. They exist because
`tsc --noEmit` reports errors across the whole project including other people's
in-progress files, and during the parallel build it mattered to see only your
own.

`Directly verified:` all ten exit 0. One of them did not until recently, for a
reason worth knowing before you add a scoped config of your own — §4.2 below
keeps it as a worked example, and
[`../PROJECT_STATE.md` §4.2](../PROJECT_STATE.md) has the full derivation.

---

## 3. Scripted / headless QA

No browser, no bundler, no dev server. This is the cheapest real evidence
available and it should be your first instinct for anything numeric.

```bash
node src/dev/node-run.mjs <module.ts> [args…]
```

`src/dev/node-run.mjs` resolves the `@/…` alias, runs TypeScript through Node's
own transform, and shims a 2-D canvas so procedural texture code runs as a
no-op. **The spline, the geometry, and every `ITrackService` query are the real
thing**; only textures come out blank.

> Its header records why it exists: three shipped mechanics — gliders,
> anti-gravity, ramp tricks — were authored, wired, and had **never once run**.
> A mechanic that never fires renders identically to one that does not exist, so
> no screenshot could ever have caught it. Simulating laps and counting is the
> only thing that can.

> ⚠️ **Never import `node-run.mjs` from a probe.** It holds a pending top-level
> `await import(entry)` for the whole run, so importing it deadlocks the module
> graph — Node exits 13 with no output at all. Shared helpers live in
> `src/dev/headless.ts` for exactly this reason.

### The physics assertion battery

```bash
node src/dev/node-run.mjs src/dev/physics-run.ts
```

DOM-free, runs against `TestTrack` (a complete analytic `ITrackService`), and
prints a `PASS`/`FAIL` line per assertion plus the measured value and the
expected range. Covers acceleration and top speed, drift and mini-turbo, jumps
and tunnelling, banked-surface stability, surfaces, stuns, respawn, mass,
a 60-second fuzz for NaN, and a fixed-step budget.

`Directly verified:` **34 passed / 8 failed** at the current baseline. Read
[§4](#4-two-worked-examples-diagnose-the-probe-before-the-code) before acting on
that.

### The circuit probes

**63 files are tracked in `.probe-tmp/` — 38 `.ts` probes and 25 `.txt` capture
logs.** `Directly verified:` `git ls-files .probe-tmp | wc -l` = 63, `*.ts` = 38,
`*.txt` = 25.

> ### ⚠️ The tracked `.txt` files are historical evidence, not live failures
>
> Names like `CERT-breaksoup.txt`, `SHFIX-red.txt`,
> `MINIMAP-red-stale-transform.txt` and `DRIFTBAIL-before.txt` are deliberate
> **red / before** captures — proof that a probe *could* fail, or a record of the
> defect before it was fixed. They are committed on purpose, because a red result
> is the only thing that makes the matching green result meaningful. **They read
> exactly like current failure reports and are not.** Check the matching entry in
> [`PROJECT_STATE.md`](../PROJECT_STATE.md) §3 before treating one as work.

**This is easy to miss**:
`.probe-tmp/` is listed in `.gitignore`, but these files were force-added and
*are* in the repository, so a fresh clone has them. The rest of that directory
(~450 files, mostly captured `.txt` output) is untracked scratch.

```bash
node src/dev/node-run.mjs .probe-tmp/pintest.ts
node src/dev/node-run.mjs .probe-tmp/sightline.ts all --tier=ultra
```

Representative examples — `loopdet.ts`, `wallab.ts`, `pintest.ts` (AI wall
contact), `sightline.ts`, `roadintrude.ts` (prop intrusion), `shoulder.ts`,
`shoulderfix.ts`, `ribbon.ts` (road geometry), `roster.ts`, `itematlas.ts`,
`kartsize.ts`, `rideheight.ts`, `minimap-arcwalk.ts`, `driftpay.ts`.

> **Two invocation traps recorded in `95d910e`, both still worth knowing.**
> Probes default to the `low` quality tier because generating eight circuits of
> procedural texture without a GPU is slow — but **prop scatter density follows
> the tier**, so any claim of the form "no prop intrudes on any circuit"
> requires `--tier=ultra` to mean what it says. And `sightline.ts all` once
> measured *one* circuit while printing `=== all ===`, because `all` fell
> through as an unknown circuit id and `getTrackDef()` **falls back silently**.

That silent fallback is a general hazard: `getTrackDef()` returns the default
circuit for any unknown id, with no error. A probe that names a circuit wrongly
reports a real measurement of the wrong thing.

---

## 4. Two worked examples: diagnose the probe before the code

Both are live at the current baseline. Detail and numbers are in
[`../PROJECT_STATE.md` §4](../PROJECT_STATE.md) — not repeated here. What
matters here is the *method*.

### 4.1 The physics battery: 34 passed / 8 failed

Four of the eight failures report `Infinity %` or `-Infinity %`.

**That is not a physics reading. That is a division by a zero baseline.** Until
the denominator is explained, those four say nothing about the kart model, and
they also contaminate the reading of the other four — you cannot rank severity
across a set when half the numbers are non-finite.

The correct order of work:

1. Find what the four `Infinity` cases divide by, and why it is zero. Likely the
   probe's own free-speed reference, not the physics.
2. Fix the instrument. Re-run.
3. *Then* read the remaining failures, which now mean something.

The two rules in tension here both apply, and neither wins by default: §1.3
says a red result may be the probe's fault, and §1.5 says you may not dismiss it
on that suspicion alone. The resolution is to **go and look**, not to pick the
convenient reading. And under no circumstances §1.4 — do not widen a range.

### 4.2 When two configs disagree about one file

Resolved, and kept here because the reasoning generalises. `src/dev/physics-run.ts`
compiled clean under `tsconfig.json` and errored under
`tsconfig.render-check.json` with `TS2591 Cannot find name 'node:process'`.

**Two configs disagreeing about one file is a statement about the configs**, not
about the file. The shipped artifact was never affected — CI uses the root
config and `npm run build` was green — so the correct classification was
"optional gate is broken", not "the code is broken".

The wrong move, and it is tempting because **the compiler suggests it by name**:
add `"node"` to the scoped config's `types` array. That widens the ambient
global surface so gameplay code can see `process`, which `b4832ab` deliberately
prevented. `TS2591` is the *global-name* diagnostic, and TypeScript 7 reports it
against a module specifier — so its remedy text is advice for a different
problem. Read the remedy text as a hypothesis, never as an instruction.

What it actually was: `node:process` resolves through an *ambient module
declaration* in `@types/node`, not through file lookup, so it type-checks only
in programs that already contain `@types/node`. `types: ["vite/client"]` blocks
the automatic inclusion, and the sole remaining route into the program is
`vite.config.ts` → `vite`'s `index.d.ts` → `/// <reference types="node" />`.
The root config includes `vite.config.ts`; the scoped one did not. The fix was
one `include` entry, narrowing `src/dev/**/*.ts` to the render harness
`src/dev/textures.ts`. Full derivation in
[`../PROJECT_STATE.md`](../PROJECT_STATE.md) §4.2.

**The transferable technique:** hold `compilerOptions` fixed and bisect
`include`. A scoped config that passes only because some unrelated file drags a
`/// <reference types="…" />` into the program is passing by accident, and the
gate that catches it is worth more than the green checkmark it cost.

```bash
for f in tsconfig.*-check.json; do
  npx tsc -p "$f" >/dev/null 2>&1; printf '%-32s exit=%s\n' "$f" "$?"
done
```

`Directly verified:` all ten exit 0. They are optional and not wired into any
npm script; `npm run typecheck` and `npm run build` use the root config, and
that is what gates CI.

---

## 5. Browser visual QA

**Capability needed:** a browser you can navigate, resize, screenshot, execute
JavaScript in, and read the console from.

### Getting the game running

```bash
npm run dev     # then open http://127.0.0.1:5173
```

Standalone subsystem harnesses are served by the same dev server —
`http://127.0.0.1:5173/src/dev/vfx.html`, and likewise `ui`, `camera`, `items`,
`audio`, `karts`, `world`, `physics`, `textures`, `track`.

### Two traps, both recorded from real failures

> **The 0×0 viewport trap.** `requestAnimationFrame` never fires at a 0×0
> viewport. Any init path that yields on rAF hangs forever and the boot screen
> sits at "Initializing". **This is not a broken build.** Give the viewport a
> real size *before* loading. The corollary for your own code: never assume rAF
> will fire — race it against a `setTimeout` fallback so a hidden or zero-size
> tab cannot deadlock startup.

> **The resolution trap.** Some automation panes render the page 1:1 only at a
> specific size, and a larger request is downscaled into the same buffer — which
> destroys exactly the fine surface detail you are trying to judge. **Either
> capture at the pane's native 1:1 size (commonly 800×450), or force a larger
> backing store yourself** with `renderer.setPixelRatio(2.4)` for a true
> 1920×1080 buffer. Confirm which you have before judging surface quality.

### Sequence

1. Size the viewport first (see above).
2. Load the page; wait for the boot overlay to reach "Ready" — up to ~20 s on a
   cold shader cache.
3. Start a race: `window.__GAME__.startRace({})`.
4. `window.__QA__.validateShots()` — **once, at the start of every review run.**
5. Set a framing, screenshot, judge.
6. Read the console. Expect **zero** errors.

### `window.__QA__` — reproducible framing

Dev builds only. From `src/qa/CaptureHarness.ts`.

| Member | Purpose |
|---|---|
| `shot(name)` | Jump to a canonical framing, settle, **and verify the subject is in frame** |
| `validateShots()` | Run every framing and report which contain the subject |
| `benchmark(seconds = 5)` | medianFps, p95, 1 % low, draw calls, triangles |
| `stats()` | Current renderer stats |
| `setQuality(tier)` | `low` / `medium` / `high` / `ultra` |
| `setSky(preset)`, `setHud(bool)` | Scene and HUD state |
| `shots`, `harness` | The framing list, and the harness object itself |

Framings: `chase-straight`, `chase-corner-drift`, `chase-boost`, `kart-hero`,
`grid-wide`, `pack-battle`, `scenery-vista`, `hud-full`, `driver-eye`.

> **Always check the returned `subject.inFrame`.** If it is `false` the capture
> failed and **the image says nothing about the game** — re-run, do not judge
> it. Framings are positioned in the kart's own basis for exactly this reason;
> an earlier revision positioned off a track `t` value and 5 of 8 shots
> contained no kart at all. `shot()` warns to the console when this happens.

Use these rather than placing the camera by hand. Two runs are then comparable,
which is the difference between proving a change helped and believing it did.

### `window.__POST__` — render-pipeline instrumentation

Dev builds only. From `src/render/PostQA.ts`. Announces its own surface on
install:

`probe(source?)` · `frameCost()` · `passCost()` · `gpuCost()` · `toneMap()` ·
`exposure(v)` · `passes()` · `autoRun()` · `glValidate()` · `shadowMaps()` ·
`boundTextures()` · `mbArm()` · `mbFrame(shot, speed, boost, mode)` ·
`mbRelease()` · `stats()`

Two are worth singling out:

- **`shadowMaps()`** — does every shadow-casting light own a depth map *right
  now*, answered synchronously. Added in `5bea189` precisely because previously
  only the *consequence* was observable, via `glValidate()` counting GL errors
  across frames. **Run it after any change to the shadow cascade cadence, and at
  frame 0** — frame 0 is the case that failed.
- **`glValidate()`** — counts GL errors over frames. A nonzero count is never
  cosmetic.

### `window.__GAME__` — and the thing to get right

`__GAME__` is assigned **unconditionally** in `src/main.ts` and **ships in
production**. `__QA__` and `__POST__` do not.

`Directly verified:` in the current `dist/assets/*.js` — `__QA__` **0**,
`__POST__` **0**, `installCaptureHarness` **0**, `installPostQA` **0**,
`validateShots` **0**, `src/dev` **0**; `__GAME__` **1**.

The gate is `if (import.meta.env.DEV)` around a **dynamic** `import()`. Vite
replaces the constant with `false`, the block is dropped, and the module is
tree-shaken entirely — no chunk is emitted. The same mechanism gates `__POST__`
inside `RenderPipeline`.

Re-check it on any build that changes the entry path:

```bash
for t in __QA__ __POST__ installCaptureHarness installPostQA validateShots; do
  printf '%-22s %s\n' "$t" "$(grep -o "$t" dist/assets/*.js | wc -l)"
done
```

The subsystem harness globals — `__UIQA__`, `__PHYS__`, `__CAM__`, `__WORLD__`,
`__KARTS__`, `__ITEMS__`, `__VFX__`, `__TRACK__`, `__AUDIO__`, `__LAB__` — live
in `src/dev/*` pages, which are not build inputs, and are likewise absent.

`__UIQA__.matrix()` in the UI harness is worth knowing: it sweeps race states ×
viewports × positions and names every widget that overflows.

---

## 6. Performance

The whole frame must fit **16.6 ms**. The standing per-subsystem budget is in
[`../AGENTS.md`](../AGENTS.md) §5b and is normative.

```js
await window.__QA__.benchmark(5)   // medianFps, p95Ms, 1 % low, draws, tris
window.__POST__.frameCost()        // per-pass GPU timing, including shadows
```

> **`benchmark()` refuses to report a verdict from a hidden tab.** Chrome clamps
> rAF to a few Hz when the tab is not visible, which once produced a bogus
> "5 fps" reading while the renderer was finishing frames in well under 10 ms.
> **Do not quote `medianFps` when the `valid` flag is false.**

> **Watch the multiplier, not just the scene.** Every shadow cascade and every
> planar reflection re-renders the scene. If `renderer.info.render.triangles` is
> several times the triangle count actually in the scene graph, the real bug is
> too many full-scene passes, not the geometry.

Two structural facts that dominate frame cost, both `Historical only:` as
figures and not re-measured here: the pipeline runs multiple passes over the
scene per frame, and a large share of triangles have `frustumCulled = false`, so
they cannot be culled at all. Re-measure before quoting either.

Related: the engine's adaptive resolution ratchet will quietly lower resolution
under load. A "fast" reading taken while the ratchet has stepped down is not a
reading at full resolution — check `stats()`.

---

## 7. Real-device verification

**Capability needed:** a physical phone or tablet, and a way to reach the dev
server or a deployed build from it.

Required for anything touching touch controls, safe-area insets, portrait
layout, or on-screen control feel. Per §1.7, hardware findings **outrank**
synthetic ones here, and the entire touch control history of this project is a
record of that.

Checklist, derived from the fixes that were needed:

- Both **portrait and landscape**, and rotating between them mid-session.
  Portrait is supported, not warned against; an orientation change re-runs the
  responsive layout.
- All three control styles: **SWIPE** (default), **JOYSTICK**, **D-PAD**.
- **Simultaneous steer + drift/item/brake.** `2062cda` records this as *not
  verified* by synthetic events. It needs a real hand.
- A **notched device**, to confirm no UI sits under a cutout.
- A touch that starts on a control and drags off it, and a second touch that
  interrupts the first — `135d9a0` fixed a stolen touch leaving the stick
  claimed and at full lock.
- Double-tap on a menu row, which could once zoom the page (`6a26854`).
- The character grid at **375 px**, which must re-column rather than overflow.

If you have no device: run everything else, then **state plainly that touch and
hardware behaviour is unverified and must be checked by someone who has one.**
That is a complete and useful report. A guess is not.

---

## 8. Deployment smoke

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the pipeline itself.

### Verifiable locally, from the repo

```bash
npm run build
npm run preview     # serves the real dist/ at http://localhost:4173
```

Then check the **built** artifact, not the source:

| Check | Why |
|---|---|
| App asset URLs in `dist/index.html` are **relative** (`./assets/…`) | An absolute `/assets/…` is the one guaranteed failure on a Pages project subpath |
| Canonical / `og:url` / image URLs are **absolute** | A crawler resolves them out of context. **Both styles are correct — do not "fix" either to match the other** |
| `__QA__` / `__POST__` absent from `dist/assets/*.js` | §5 |
| `public/` files present in `dist/` | Vite copies them unaided; no post-build asset step exists |
| `site.webmanifest` parses as JSON, `sitemap.xml` as XML | A malformed one fails silently |
| Zero 404s and zero console errors on load | The five app requests must all be 200 |

**The subpath rehearsal.** Serving `dist/` at the origin root hides exactly the
class of bug `base: './'` exists to prevent. Copy `dist/` into a subdirectory and
serve *that* over static HTTP — `.gitignore` reserves `served/` for this. It is
what originally caught the absolute-path failure.

### Needs production or GitHub access

Not verifiable from a clone; do not claim these without access:

- That the Actions workflow succeeded and Pages published.
- That <https://kart.eugeneyip.com/> serves the new commit.
- That the custom domain, DNS, and TLS certificate are healthy.
- That the origin-root `/favicon.ico` returns 200.
- Anything about crawler rendering of the social card.

---

## 9. Reporting

State, in this order:

1. **The baseline** you verified — SHA, branch, clean or not.
2. **What you changed**, by file.
3. **What you measured**, with the command and the numbers. Label each claim
   measured / visually judged / intentionally accepted.
4. **What you did not verify**, and why — no browser, no device, no production
   access. Delegate it explicitly.
5. **Known gaps** and anything you need from another subsystem.

A false "complete" wastes the next person's entire loop. An honest "I could not
check X" costs one sentence.
