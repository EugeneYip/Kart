# Foxy Kart — project state

**What is true right now.** Not a history. If something here disagrees with the
code, the code wins — and this file is then wrong and should be fixed.

Every claim below carries an evidence label. They mean:

| Label | Meaning |
|---|---|
| `Directly verified:` | Re-measured or re-read in the current tree while writing this |
| `Regression-tested:` | A committed probe or harness asserts it, and it was run |
| `Real-hardware accepted:` | The owner confirmed it on a physical device |
| `Rendered visual judgment:` | Someone looked at a frame and formed an opinion |
| `Intentional tradeoff:` | A known cost, accepted on purpose |
| `Historical only:` | Recorded in a prior document; **not** evidence of current state |
| `Not re-verified in this continuity pass:` | Plausible, unchecked — treat as unknown |

---

## 1. Baseline

| | |
|---|---|
| Repository | <https://github.com/EugeneYip/Kart> |
| Production URL | <https://kart.eugeneyip.com/> |
| Production branch | `main` — every push deploys |
| Baseline commit | `627401c24ad7e4ea114f25e828234a286c171277` |
| Commit subject | *Give Foxy Kart a proper web identity and social preview* |
| Baseline committed | 2026-08-18 (git author/committer date) |
| Landed since | `3bd1b3f` *Make Foxy Kart independently maintainable without conversation history* (docs only), then this commit's physics-bench fixes — see §4.1 |
| Build command | `npm ci && npm run build` (`build` = `tsc --noEmit && vite build`) |
| Output directory | `dist/` (gitignored — never committed) |

`Directly verified:` at the time of writing, `HEAD`, `origin/main`, and the SHA
above were identical, and the working tree was clean *at that commit*. A dirty
tree in your checkout means work is in progress, not that this baseline is wrong;
identify the provenance of the changes before assuming either.

`Directly verified:` the only tag is `certified-gameplay-2026-08-17`, marking the
gameplay baseline that the deployment work was deliberately kept separate from.

`Directly verified:` `origin` also carries `agent/web-identity-seo` and
`web-identity-seo` at `6233437`, one commit behind `main`. They are **stale
feature branches**, fully superseded. `main` is production.

### Toolchain

`Directly verified:` local Node **v22.15.1**, npm **10.9.2**. The Actions
workflow pins `node-version: '22'` — consistent. Vite 8 requires
`^20.19 || >=22.12`.

### Build result at this baseline

`Directly verified:` the command below was actually run from a genuinely clean
tree (`rm -rf node_modules && npm ci && npm run build`) on **2026-08-23**, five
days after the baseline commit and with no intervening work. The gap is normal —
it is the date the command ran, not a claim about when the code changed.

```
npm ci      exit 0   added 32 packages, audited 33, found 0 vulnerabilities
npm build   exit 0   157 modules transformed, built in 953 ms

dist/index.html                  15.21 kB │ gzip:   5.85 kB
dist/assets/index-YJioJpgY.css   57.36 kB │ gzip:  11.53 kB
dist/assets/three-Bz5HNAWd.js    49.95 kB │ gzip:  15.92 kB
dist/assets/post-CYwGJNSp.js    771.41 kB │ gzip: 227.04 kB
dist/assets/index-D3gEgcqw.js  1,404.73 kB │ gzip: 444.01 kB
```

Vite prints a chunk-size warning above 500 kB. `Intentional tradeoff:` this is a
single-page game that needs its whole engine before the first frame; code
splitting would trade a smaller first chunk for a longer time-to-playable. The
`manualChunks` split exists to keep vendor code in long-lived cacheable chunks,
not to reduce total bytes.

**The clean install is not optional ceremony.** `Historical only:` commit
`b4832ab` records the first real Actions run failing at `tsc --noEmit` because
`@types/node` was missing from the lockfile while a drifted local `node_modules`
compiled fine. Testing against a drifted tree is how that shipped.

---

## 2. What the product currently is

All from `Directly verified:` code inspection at this baseline.

- **A single-page browser game.** One HTML entry (`index.html`), one module
  entry (`src/main.ts`). No router, no server, no backend, no accounts, no
  analytics, no network calls at runtime.
- **Eight circuits.** `sunsetCoastline` (default), `neonMetropolis`,
  `volcanoRush` in `src/track/TrackDefs.ts`; `bostonHarbor`, `taipeiCircuit`,
  `tokyoNeon`, `hongKongHarbour`, `newYorkCircuit` in `src/track/CityDefs.ts`.
- **Ten characters** (`src/karts/Characters.ts`), **six chassis**
  (`src/karts/KartBodies.ts`), **twelve karts** on the grid.
- **Five live items**, deliberately: Plastic Bottle (banana), Battery (boost),
  Rocket (red shell), Ninja (ghost), Star. Eleven further `ItemType` members
  exist and are handled by `use()`, but carry weight zero in every row of the
  roulette table, so a box can never produce them.
- **Grand Prix** with MK8-style points `[15,12,10,9,8,7,6,5,4,3,2,1]` over
  4-race cups (`src/game/Standings.ts`).
- **Physics at a fixed 120 Hz** (`FIXED_DT = 1/120`, `MAX_SUBSTEPS = 8` in
  `src/core/Config.ts`), rendering at display rate with interpolation alpha.
- **Three input devices**, blended loudest-source-wins: keyboard, gamepad, and a
  module-level virtual controller written by the touch layer.
- **Desktop, phone, and tablet.** Portrait and landscape are both supported.
- **Four quality tiers** (`low`/`medium`/`high`/`ultra`), auto-selected by a GPU
  probe at boot and further adapted at runtime by a resolution ratchet.

### The defining constraint

`AGENTS.md` rule 3: **zero network requests at runtime.** Every texture is
canvas-2D, `DataTexture`, or noise; every model is authored TypeScript geometry;
every sound is synthesised through the Web Audio API at init. Nothing is
fetched — the game runs fully offline from `dist/`.

`Directly verified:` the one bounded exception is `public/`, which holds
page-level presentation and discovery assets only (favicons, app icons, the
social card, `site.webmanifest`, `robots.txt`, `sitemap.xml`). They are fetched
by browser chrome and by crawlers. **No gameplay code reads any of them.** Do
not delete them as rule-3 violations, and do not read them as permission to load
a texture, model, font, or sound from a file.

---

## 3. Closed systems

Each entry: what was seen → what actually caused it → what closed it → when to
reopen. **The reopening rule matters more than the history.** These are closed;
do not re-litigate them from old notes.

### 3.1 Intermittent black race scene

- **Symptom.** The race rendered as sky only, intermittently, ever since the
  phased shadow cascade cadence shipped. Console flooded with
  `GL_INVALID_OPERATION: Mismatch between texture format and sampler type`.
- **Actual root cause.** `shadow.map` is allocated lazily inside three's
  `WebGLShadowMap.render`. A cascade that has never rendered has a null map, and
  three substitutes its private `emptyShadowTexture`. The array uniform path
  `setValueT1Array` — which `directionalShadowMap[]` always uses — does not set
  `compareFunction` the way the scalar path does, so a plain depth texture ends
  up bound to a `sampler2DShadow` declaration and **every shadow-receiving draw
  fails validation**. Only materials receiving no shadow still drew, which is
  exactly why the sky survived and the world did not. Two things had to be true
  at once: `fitCascades()` runs from inside the shadow hook and its
  `needsUpdate = false` was the last word, silently cancelling
  `RenderPipeline.warmShadowMaps()`; and phase makes frame 0 the worst possible
  frame to be cancelled on, because `(0 - phase) % interval` is -1 and -2, so no
  staggered cascade is ever due on the first frame.
- **Fix.** A cascade with no map is *forced due*, in both the hook and
  `fitCascades()`. Once allocated, ordinary phase logic resumes — a one-time
  cost per cascade, not a cadence change.
- **Closure evidence.** `Regression-tested:` commits `5bea189` and `b21413d`
  record the forced failing path going from **708 GL errors with cascades 1 and
  2 NULL** to **0 errors with all three allocated**, and the stagger measured
  intact at **40 / 20 / 10 cascade renders over 40 frames** — exactly the
  intended 1 / 2 / 4. Recovery was verified too: disposing a cascade map
  mid-session on a non-due frame recovers on the next frame with 0 GL errors.
- **Reopen if.** You see a sky-only frame, or `__POST__.shadowMaps()` reports a
  shadow-casting light without a depth map. Files:
  `src/render/RenderPipeline.ts` (`warmShadowMaps`, `verifyShadowBinds`) and
  `src/world/Lighting.ts` (`fitCascades`).
- **Do not** re-stagger the cascade cadence to 1/2/3. See
  [`docs/DECISIONS.md`](docs/DECISIONS.md).

### 3.2 Bundles 404'd on GitHub Pages

- **Symptom.** Every JavaScript and CSS bundle would 404 on a Pages project site.
- **Actual root cause.** Vite's default `base: '/'` emits
  `src="/assets/index-*.js"`, which the browser resolves against the **origin**,
  not the page's subpath.
- **Fix.** `base: './'` in `vite.config.ts`.
- **Closure evidence.** `Regression-tested:` commit `33651d1` verified the
  pre-change `dist/index.html` contained exactly `src="/assets/index-B-eEl4-J.js"`
  and that a local subpath rehearsal returned 404 for that path.
  `Directly verified:` at this baseline all four app asset URLs in the built
  `dist/index.html` are relative (`./assets/…`, `./favicon.ico`, …).
- **Reopen if.** A built `dist/index.html` contains an app asset URL beginning
  with `/`. **Do not** change `base` to `'/<repo>/'`; see
  [`docs/DECISIONS.md`](docs/DECISIONS.md).

### 3.3 Clean CI could not compile the tree

- **Symptom.** The first real Actions run failed at `tsc --noEmit` with
  `Cannot find name 'process'` and `Cannot find name 'node:url'`.
- **Actual root cause.** `@types/node` was never declared in `package.json`. A
  clean `npm ci` installs exactly the lockfile; the local `node_modules` had
  drifted ahead of it and compiled fine. The real defect was that the readiness
  test was not reproducing CI.
- **Fix.** `@types/node@22` as a devDependency; `src/dev/physics-run.ts` switched
  from the bare `process` global to `import { exit } from 'node:process'`.
  `tsconfig.compilerOptions.types` deliberately stays `["vite/client"]` — that
  array gates *ambient* globals, and gameplay code has no business seeing
  `process`.
- **Closure evidence.** `Regression-tested:` commit `b4832ab` reproduced CI
  cleanly at exit 0 and confirmed the shipped artifact was byte-identical
  (same four content hashes). `Directly verified:` a clean
  `rm -rf node_modules && npm ci && npm run build` at this baseline is exit 0.
- **Reopen if.** Any clean-install build fails. Always test with a real clean
  install, never a drifted `node_modules`.

### 3.4 A phone had no usable controls

- **Symptom.** A phone player saw a game with no visible controls, and the
  invisible half-screen scheme fought back: a thumb resting on scenery was
  permanent full throttle, and low enough, permanent drift.
- **Actual root cause.** The old scheme drew nothing and listened on the canvas,
  so it fired for every touch that missed the overlay. `Input` was constructed
  inside `Game` and never handed out, so the UI had no way to act as a device.
- **Fix.** A published module-level `virtualController` device object (matching
  the existing pattern — keyboard off `window`, pad off `navigator`), plus a
  drawn control layer: steering, DRIFT / ITEM / BRAKE, pause, and back.
- **Closure evidence.** `Regression-tested:` commits `070aa23` and `41d6f21`.
  Desktop behaviour is bit-identical because an unused device is all-zero.
  `Real-hardware accepted:` refined across `2062cda`, `135d9a0`, `6a26854`,
  `0fb0e5e`, `42c9d7b`, `49938bb`, `cbf7ac1` from the owner's own device tests.
- **Reopen if.** A real device reports it. `Rendered visual judgment:` and
  synthetic pointer events are both weaker evidence than hardware here — see
  [`docs/QA.md`](docs/QA.md).

### 3.5 Touch steering oversteered

- **Symptom.** Small thumb movements produced too much steering.
- **Actual root cause.** Two causes compounding: full lock was ~47 px (about one
  thumb-width of total throw), and the map was **linear**, spending as much
  steering per pixel at dead centre as at full lock. The measurement also
  exposed a duplicate constant — `private travel = 48` was a hand-copied
  duplicate of `131 * 0.36` that outlived the constant it came from, and
  `measure()` returned early on `!this.live`, so before a race the stick used
  48 px whatever `travelFrac` said.
- **Fix.** One commented constant block; `travelFrac` 0.36 → 0.58 (full lock
  ~47 → 76 px), `deadZone` 0.07, `curve` 1.5. Every derived feel number is now a
  **getter** over the constants plus the current setting, so there is no stored
  product to go stale. Then, rather than a fourth tuning pass, three selectable
  styles.
- **Closure evidence.** `Regression-tested:` commit `2062cda` records the
  settled in-browser curve — 6 px → 0.000, 44 px → 0.405, 76 px → 1.000 steer,
  full left exactly −1.000, release exactly 0. `Real-hardware accepted:` the
  owner's test drove the move to selectable styles in `4638be6`.
- **Reopen if.** Real hardware says so. **Do not** answer a feel complaint by
  adding smoothing: it was considered and rejected because it would make
  counter-steering feel late.

### 3.6 A guard that could not fail

- **Symptom.** Validation observed that `updateSwipe`/`updateStick` write
  `virtualController.steer` outside the gate `write()` sits behind, and that the
  touch layer stays hit-testable for 220 ms after it stops being live.
- **Actual root cause.** None. `Directly verified:` commit `6233437` records
  that an `acceptsPointer()` guard was written and then **removed again**,
  because with the guard deliberately disabled a 100 px gesture one frame after
  `showPause()` still produced steer 0.0000 — `.ak-menus` is z-index 60 against
  the touch layer's 50 and takes the pointer.
- **Closure evidence.** The comment ships and the check does not. Behaviour is
  unchanged; `6233437` is comment-only.
- **Reopen if.** The z-index relationship changes. This is the project's
  clearest statement of a standing rule: **a test that cannot fail is worthless,
  and shipping one is worse than shipping nothing.**

---

## 4. Current open work

> ### No active implementation task.
>
> `Directly verified:` the tree is clean, `main` and `origin/main` agree, and a
> clean-install build is green. Nothing is mid-flight.

The items below are **observations recorded during this continuity pass**, not
an assigned backlog and not a plan. Each is measured or read directly at this
baseline. None is urgent. Do not treat this section as a queue to work through.

### 4.1 The physics battery: 6 of the 8 failures were the bench, not the kart

`Directly verified:` run on 2026-08-23, after the fixes in this commit:

```
node src/dev/node-run.mjs src/dev/physics-run.ts
→ FOXY KART — PHYSICS ASSERTIONS   44 passed / 2 failed
```

It was 34 / 8. Six of the eight were defects in `TestTrack` and in two probes —
**not** in `src/physics/*` — and two new assertions were added, plus a
`BENCH SELF-CHECK` group of two. No tolerance or expected range was changed;
every one of the four `Infinity` assertions now passes against its original
range (6–20 %, < 8 %, 45–70 %, monotonic).

`Measured:` what each failure actually was.

| Was | Root cause | Now |
|---|---|---|
| 4 × `Infinity %` (30° scrub, 10° graze, 60° hit, monotonicity) | `hitAt()` triggered on `wallImpacts`, which `KartCollision` increments only for `Contact.Solid`; the bench's guardrail is a `Contact.Verge`, documented as never a penalty. `before` kept its `0` sentinel and the probe divided by it. Two things were wrong: it waited for a penalty *and* it aimed at the wrong barrier class — the four ranges are the solid-collider shunt curve. | Triggers on `wallContact`; aims at the nine-metre facade via `TestTrack.tallWall`, which was added for this and wired to nothing. 10.4 % / 1.6 % / 53.7 % retained / monotonic. |
| `off-road slows you  14.74 m/s (surface Road)` | Two bugs. `geoAt()` gave the apron straight an arc length 110 m too large, colliding with arc B's range — so `project()` handed every kart on that straight a road frame from the far side of arc B, banked 25° where the road is flat. The test's `place()` argument was built from that wrong formula, and `place()` inverts the lap with `fillSample()`, which was always right — so the kart landed 55 m into arc B at lateral 15, outside that region's guardrail, and was pushed back onto the kerb. `Road` was the correct answer for where it actually was. | `geoAt()` corrected; probe moved to 25 m into the apron straight, where the rail has blended out to `WALL_WIDE`. 16.54 m/s on `Grass`. |
| `out of bounds → respawn  false, \|u\| 11.84 m` | `TestTrack.collideWalls` measured height under the *query point* and substituted `0` when that was NaN. Over the void that reads as "level with the barrier's foot", so a kart 80 m out at y = 8 was reported buried `radius + 67.3` m inside the guardrail; `resolveWalls` (step 4) ejected it before `checkBounds` (step 5) ever looked. `Track.collideWalls` measures against the surface at the wall face, which is defined everywhere. | Height taken at the barrier's own foot, with the same `-0.55 m` lower gate the shipping track uses. Fires; ends 0.00 m off the centreline. |
| `banked 25°: all wheels planted  no` | `TestTrack.raycastGround`'s bracket search marched `t += 0.16` while `t <= maxDist` and so never evaluated `maxDist` itself. Against the suspension's 1.228 m ray the last sample landed at 1.120 m, leaving ground from 1.120–1.228 m invisible — 36 % of suspension travel. A kart parked on the bank sits at 1.1176–1.1217 m, straddling it, so each wheel reported a miss on ~half of all ticks while the chassis moved 3.5 mm in three seconds. | The march clamps to and evaluates `maxDist`. All four planted. |

`Measured:` the two that remain are **genuine readings of the shipped model**,
not instrument faults. Both are tuning values, and both were checked for an
underlying bug first — there isn't one.

```
FAIL  hop air time                    0.000 s              expect 0.22–0.40 s
FAIL  grinding a wall is not a crash  13.05 of 27.63 m/s   expect > 60 %
```

**`hop air time`.** This was *passing* at 34/8, at 0.308 s. It was passing on the
ray-march blind band: wheels reported airborne while the kart rested on its
springs, which also let `PHYS.hopGravity` engage and roughly doubled the rise.
With the march fixed, `PHYS.hopSpeed = 2.6` cannot unload the rear springs —
`groundedWheels` bottoms out at 2, the chassis rises 0.107 m, and the kart never
leaves the ground under any tested condition (throttle or coasting, flat or
oval). `PHYS.hopGravity`'s own comment derives "≈ 0.325 s of hang time" from a
free-flight assumption the 0.11–0.13 m of available droop never permits.
`Directly verified:` removing the `!b.grounded` gate on `hopGravity` does **not**
fix it (rise 0.126 m, still 0.000 s air), so this is not an ordering bug. Air
time first appears at `hopSpeed ≈ 3.4` (0.142 s) and reaches the assertion's
lower bound at `≈ 4.2` (0.233 s).
**Decision needed:** raise `PHYS.hopSpeed` to ~4.2 (changes drift-entry feel for
every kart), or re-derive the assertion and `hopGravity`'s comment around a hop
that is a suspension flourish rather than a jump. **Do not** restore the blind
band, and do not widen the range. **Reopen/close rule:** closed only when the
0.22–0.40 s range is met by the model or replaced by a range derived from what
the suspension actually permits, with the derivation written down.

**`grinding a wall is not a crash`.** `Measured:` 3 s leaning into the guardrail
at 0.35 of lock, entry 18 m/s, full throttle — 13.05 m/s against a 27.63 m/s
free run, a 52.1 % cost against a 40 % budget. Decomposed by zeroing one term at
a time on the fixed bench: barrier scrape (`COLL.vergeContactDrag = 0.55`) is
34.0 % of it, the kerb band (`PHYS.vergeDrag = 0.9`) accounts for 3.36 m/s on its
own at steer 0, and the residual is tyre scrub from holding lock against the
rail. `leanOnBarrier()` computes `press = 0.578` here and behaves exactly as
documented — there is no bug. The baseline is also not the problem: charged
against a same-line/steer-0 run instead, the cost is still 45.5 %. The stacking
of the two drags is explicitly intended (`KartCollision.ts` header). The
regression this assertion was written to catch — a per-tick penalty — is
independently and still covered by `a grind is not re-penalised per tick`
(0 penalties over 314 contact ticks, passing).
**Decision needed:** accept ~52 % as the cost of insisting on a barrier and
re-derive the 60 % figure, or lower `COLL.vergeContactDrag` (game feel for every
player). **Reopen/close rule:** closed when the number is met, or when the 60 %
is replaced by a figure derived from the two drag constants with the arithmetic
recorded. Not to be closed by widening.

`Directly verified:` a third failure appears intermittently and is **not** a
logic failure — `fixed step budget (12 karts)` is a wall-clock measurement, so it
goes red when the machine is busy. Idle it reads 0.217–0.248 ms/step against a
1.5 ms budget; with eight competing CPU hogs on this machine it read 3.670 ms and
the run reported 43 / 2 (+1). A perf budget has to measure wall clock, so there is
nothing to fix — but do not chase it as a regression, and do not read a battery
run taken while a dev server or a build is running.

`Historical only:` the archived handoff recorded this battery at "9 failing
assertions" around 2026-08-17. Commit `4d3f979`'s message diagnosed the
`Infinity` group correctly at the time ("stale test, not a regression") and
classified the grind as "genuine number, needs tuning"; both hold. Its readings
of the other three were symptom-level and are superseded by the table above.

### 4.2 `tsconfig.render-check.json` — cause found, fixed

`Directly verified:` at this baseline all ten scoped `tsconfig.*-check.json`
files exit 0, as do `tsconfig.json` and `npm run build`. They are still not
wired into any npm script; they remain optional.

**Why the two configs disagreed.** `node:process` has no package on disk to
resolve to. It is supplied by an *ambient module declaration* —
`declare module "node:process"` at `@types/node/process.d.ts:2081`, reached from
`@types/node/index.d.ts:73`. An ambient declaration only exists if the file
carrying it is already in the program, and `types: ["vite/client"]` deliberately
blocks the automatic inclusion of `@types/node`. So the import type-checks in
exactly those programs that pull `@types/node` in by some *other* route.

This repo has exactly one such route, and it is `vite.config.ts`:

```
vite.config.ts
  → import { defineConfig } from 'vite'
    → node_modules/vite/dist/node/index.d.ts:1
      → /// <reference types="node" />        ← @types/node enters the program
```

The root `tsconfig.json` lists `vite.config.ts` in `include`.
`tsconfig.render-check.json` did not. That one entry was the entire difference —
not anything in `compilerOptions`, which were otherwise equivalent. Bisected
directly, holding `compilerOptions` fixed and varying only `include`:

| `include` | result |
|---|---|
| `["src/dev/physics-run.ts", "src/dev/physics-tests.ts"]` | exit 1 |
| the same, plus `"vite.config.ts"` | exit 0 |
| `["src/**/*.ts"]` — the root config's, minus `vite.config.ts` | **exit 1** |
| `["src/**/*.ts", "vite.config.ts"]` — the root config as shipped | exit 0 |

The third row is the one that matters: **the root config does not pass because
it is bigger.** It passes because of `vite.config.ts` specifically. No file
under `src/` carries a `/// <reference types="node" />`.

**The TS 7 diagnostic is misleading; do not follow its advice.** `TS2591 Cannot
find name 'node:process'` is the *global-name* diagnostic, reported against a
module specifier, and its remedy text — add `'node'` to the `types` field — is
the one change this repository has already refused twice: `b4832ab` rejected
widening `types`, and the comment at `src/dev/physics-run.ts:9` exists to
explain why. It is a module-resolution failure wearing a global-name error's
clothes.

**The fix.** `tsconfig.render-check.json`'s `include` was
`["src/render/**/*.ts", "src/dev/**/*.ts"]` — the only one of the ten to glob
all of `src/dev`, and so the only one to drag an unrelated Node entry point into
a render gate. The other nine name a single harness file each. It now reads
`["src/render/**/*.ts", "src/dev/textures.ts"]`, which is that same pattern:
`src/dev/textures.ts` is the only file in `src/dev` that imports from
`src/render`.

Render coverage is unchanged — `--listFiles` confirms all 7 `.ts` files under
`src/render/` are still root files of that program. Nothing was added to any
`types` array; nothing under `src/`, `vite.config.ts`, or
`.github/workflows/` was touched.

`src/dev/physics-run.ts` is unaffected and is still type-checked by the root
`tsconfig.json` — which is what `npm run typecheck` and `npm run build` run, so
it is still gated by CI. It was never a root file of any *scoped* config;
neither are `headless.ts`, `physics-tests.ts`, `trackqa.ts`, or `ui.ts`.

**Reopen if.** `vite.config.ts` stops importing `vite`, or `@types/node` stops
shipping `node:*` ambient declarations. Either would also break `node:process`
under the root config — the louder failure, and one `npm run build` catches.

**One thing this did not fix.** The comment at `src/dev/physics-run.ts:16` still
says the `node:*` import "resolves through normal module resolution against
`@types/node`". It does not — that is the imprecision that made this take a
second look, and the same wording was in [`docs/DECISIONS.md`](docs/DECISIONS.md)
(now corrected there). The comment's *conclusion* is right, and the decision it
defends is right; only the stated mechanism is wrong. It was left alone because
this change was scoped to configs and docs, and editing `src/` to reword a
comment would have put a no-op source diff in a commit whose whole claim is that
it does not touch `src/`. Worth folding into the next change that has reason to
open that file.

### 4.3 Small inconsistencies noted while reading

All `Directly verified:` by reading the current source. None affects behaviour.

- **`scratch` in `src/core/MathUtils.ts` is an unused export.** No file in
  `src/` imports it. Every hot module declares its own module-level temporaries
  instead. `AGENTS.md` rule 5 names `scratch` specifically; the *rule* (zero
  allocations in hot loops) is honoured everywhere, but the named mechanism is
  not the one in use. See the note in [`AGENTS.md`](AGENTS.md).
- **An empty portrait media query.** `src/ui/ui.css` carries an
  `@media (orientation: portrait)` block with a descriptive comment and no
  declarations, and `src/ui/MenuSystem.ts` has a matching dangling comment with
  no code. Both look like residue from removing the rotate prompt.
- **Two procedural texture libraries.** `src/render/TextureFactory.ts` and
  `src/world/WorldTextures.ts` overlap; the latter's own header calls itself a
  local fallback to be de-duplicated at integration time. That has not happened.
- **A stale in-source comment** in `src/track/TrackDefs.ts` describes the city
  series as "Boston / Taipei / Tokyo". There are five city circuits.
- **`src/world/Props.ts.bak`** (540 kB) sits untracked on disk, ignored via
  `*.bak`. Ignored rather than deleted on purpose — see `.gitignore`.
- **`tsconfig.ai-check.json` names a file that does not exist.** Its `include`
  lists `src/dev/ai.ts`; there is no such file. A non-matching `include` entry
  is silent, so the config exits 0 while gating only `src/ai/**`. Noticed while
  fixing §4.2; left alone, because guessing which harness was meant is worse
  than recording that nobody knows.

### 4.4 The last recorded owner playtest

`Historical only:` [`docs/archive/HANDOFF-legacy.md`](docs/archive/HANDOFF-legacy.md)
opens with a fifth-playtest list, items G1–G9, recorded 2026-08-18 and marked
"nothing here is started".

**Their current status is unknown, and at least two are already closed.**
`Directly verified:` the "MAIN MENUMAIN MENU" duplication was a DOM-text
artifact of a two-layer stroke effect and is fixed — the stroke layer now draws
`content: attr(data-text)` so exactly one copy of the string is in the DOM. And
the black mist-like roadblock (G7's oil slick) was removed from every hazard
list at the owner's request, with the `'oil'` kind deliberately left intact in
`src/items/Hazards.ts` in case it returns with art that reads as a hazard.

**Reopening rule for all of G1–G9: reproduce it on current `main` first.** Do
not schedule work off that list. It is fourteen commits and one full deployment
behind, and it was already wrong about at least one thing — it recorded the
black race scene as unfixed with the wrong file as prime suspect.

---

## 5. Intentional design decisions

Short list; the reasoning and the "do not change unless" conditions are in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

- **Everything procedural.** Zero runtime network requests, with a narrow
  `public/` exception for page-level presentation assets.
- **`base: './'`** in Vite, so the artifact works at a domain root, a Pages
  project subpath, and a local subdirectory rehearsal alike.
- **Relative app-asset URLs alongside absolute crawler URLs** in `index.html`.
  Both are deliberate. Do not "fix" either to match the other.
- **Actions-based Pages deploy**, so the published artifact is reproducible from
  the commit and the typecheck is non-optional.
- **No sourcemaps in the published build.** An artifact-size decision, reversible
  in one word.
- **SWIPE is the default touch style**, with JOYSTICK and D-PAD selectable.
- **Portrait is supported**, not warned against.
- **Shadow cascades run a 1 / 2 / 4 phased cadence.** Do not re-stagger.
- **Drift stays.** The owner's complaint was the input barrier, not the mechanic;
  entry was made easier (`engageSteer` 0.26 → 0.12) rather than deleting it.
- **Split-screen two-player is cancelled.**
- **Five live items**, not sixteen.
- **The in-race HUD is exempt from the text legibility floor**; menus carry it.
- **No test that cannot fail.**

---

## 6. External infrastructure

**Not captured by a clone.** A fresh clone builds and runs, but does not
reproduce the live site. Anyone taking this over needs the following, and it can
only come from the owner.

No credentials, tokens, or secrets are stored in this repository, and none
should be added.

| Thing | State | Where it lives |
|---|---|---|
| GitHub repository | `EugeneYip/Kart`, public | GitHub |
| GitHub Pages source | Must be set to **GitHub Actions**, not "Deploy from a branch" | Repo → Settings → Pages |
| Custom domain | `kart.eugeneyip.com` | Repo → Settings → Pages → Custom domain |
| `github-pages` environment | Referenced by the deploy job | Repo → Settings → Environments |
| DNS | A `CNAME` record for `kart` → GitHub Pages | The owner's DNS provider for `eugeneyip.com` |
| TLS certificate | Provisioned by GitHub Pages for the custom domain | GitHub, automatic |
| Account access | Owner: Eugene Yip | — |

`Directly verified:` **there is no `CNAME` file in `public/` or anywhere in the
repository.** With the Actions-based Pages flow the custom domain is stored in
repository settings, not in the artifact. Consequences to know:

- A fork, or a clone deployed to a different account, gets **no** custom domain
  and will serve from a Pages project subpath. `base: './'` is what makes that
  still work.
- If the custom domain is ever cleared in settings, adding `public/CNAME` is the
  alternative mechanism — but do not add one speculatively while the setting is
  in use.

`Not re-verified in this continuity pass:` every row of that table. All of it is
outside the repository and none of it was inspected; the Pages source setting,
the domain binding, and the DNS record are inferred from the workflow, the
canonical URL in `index.html`, and the fact that the site is live. Confirm with
the owner before relying on any of it.

---

## 7. What needs the owner's approval

`Directly verified:` assembled from the "Do not change unless" clauses in
[`docs/DECISIONS.md`](docs/DECISIONS.md), §6 above, and `AGENTS.md` rule 1. A
cold-start reader had to reconstruct this list from five places, so it lives here
now.

**The owner is the integrator.** There is no central integration step any more,
so "report it instead" means "ask them".

| Action | Why it is gated |
|---|---|
| Anything in `src/core/*` or `src/game/Game.ts` | The shared spine — contracts, composition root, loop, quality tiers, key map. See `AGENTS.md` rule 1, now written as a gate rather than a ban. |
| **Pushing to `main`** | `main` **is** production. A push deploys to <https://kart.eugeneyip.com/>. There is no staging step. |
| Removing or altering drift | An explicit owner decision, recorded in DECISIONS. |
| Re-adding oil-slick hazards | The owner asked for their removal twice. |
| Un-cancelling split-screen | The owner cancelled it on measured cost. |
| Changing the HUD legibility floor | Set against the owner's own screen. |
| Changing touch defaults or steering feel | Only real hardware can judge it, and the owner has the hardware — see [`docs/QA.md`](docs/QA.md) §1.7. |
| GitHub or DNS settings — Pages source, custom domain, environment, TLS | Outside the repository entirely; §6 above. Every row there is unverified. |
| Rewriting or force-pushing certified history | The tag `certified-gameplay-2026-08-17` and the closure evidence in §3 depend on those commits existing. |

Not gated: ordinary work inside a subsystem you were asked to change, local
commits, and any amount of measurement.

## Keeping this file honest

Update this document in the same commit as the change it describes. When you
close something, move it into §3 **with its closure evidence**, and delete it
from §4. When you cannot verify a claim, label it rather than dropping it — an
unlabelled guess is how the previous handoff became unusable.
