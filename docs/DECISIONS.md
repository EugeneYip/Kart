# Foxy Kart — decisions

**Why things are the way they are.** High-leverage only: each entry here is
something a newcomer would plausibly try to "fix", where doing so would undo
real, measured work.

Format per entry: **Status · Context · Decision · Why · Do not change unless ·
Relevant commits**.

Mined from commit bodies and in-source comments. This project writes substantial
commit messages; where an entry cites one, `git show <sha>` has the full
argument and more numbers than are reproduced here.

See also: [`../PROJECT_STATE.md`](../PROJECT_STATE.md) ·
[`ARCHITECTURE.md`](ARCHITECTURE.md) · [`QA.md`](QA.md) ·
[`DEPLOYMENT.md`](DEPLOYMENT.md)

---

## Decision: Every gameplay asset is generated procedurally in code

**Status:** Accepted, foundational. Enforced as rule 3 in
[`../AGENTS.md`](../AGENTS.md).

**Context:** A browser kart racer would ordinarily ship textures, models, fonts
and audio as files and fetch them at load.

**Decision:** **Zero network requests at runtime.** Every texture is canvas-2D,
`DataTexture`, or noise; every model is authored TypeScript geometry; every
sound is synthesised through the Web Audio API and baked to an `AudioBuffer` at
init. Reverb impulse responses are synthesised too.

**Why:** The game must run fully offline from `dist/`. It also makes the site
trivially static-hostable, removes an entire class of load-failure and CORS
bugs, and means the build has no asset pipeline at all — no post-build copy
step exists in the workflow because none is needed. It is also the reason
`base: './'` is safe (see below): there is nothing for a wrong base to 404
except the bundles themselves.

**Do not change unless** you are prepared to revisit the Vite base, the
deployment smoke test, and the offline guarantee together. A single
`fetch`/`new Audio`/`Loader` call breaks all three at once. This was **audited,
not assumed**, before `base: './'` was chosen: `src/` contains no `fetch`,
`XMLHttpRequest`, `new Audio`, three.js `Loader`, `new Worker`, or service
worker.

**Relevant commits:** `33651d1`, `b4832ab`, `627401c`

---

## Decision: `public/` is a narrow, bounded exception to rule 3

**Status:** Accepted.

**Context:** Adding real favicons, app icons, a social card, a manifest,
`robots.txt` and `sitemap.xml` meant putting files on disk for the first time in
a project whose defining rule is "fetch nothing".

**Decision:** Page-level **presentation and discovery** assets are allowed under
`public/`. They are fetched by browser chrome and by crawlers. **Gameplay code
must not depend on them or fetch them at runtime.**

**Why:** The rule exists to guarantee the *game* runs offline and that no asset
can fail to load mid-race. A favicon is not a game asset. The exception is
written into rule 3 in the exact words above, deliberately, so that a future
maintainer **neither deletes these files as rule-3 violations nor reads them as
licence to load a texture, model, font, or sound from a file**.

**Do not change unless** the asset in question is fetched by the browser or a
crawler rather than by the game. If gameplay code needs it, it is not covered.

**Relevant commits:** `627401c`

---

## Decision: Vite `base: './'` — relative, not `/` and not `/<repo>/`

**Status:** Accepted, load-bearing.

**Context:** GitHub Pages can serve from a project subpath
(`https://<user>.github.io/<repo>/`) or a custom-domain root. Vite's default
`base: '/'` emits origin-absolute asset URLs.

**Decision:** `base: './'`.

**Why:** With the default, `<script src="/assets/index-*.js">` resolves against
the **origin**, so on a project site every bundle 404s. **Verified concretely,
not reasoned about:** the pre-change `dist/index.html` contained exactly
`src="/assets/index-B-eEl4-J.js"`, and a local subpath rehearsal returned 404
for that path.

Relative rather than `'/<repo>/'` because nothing here resolves anything against
an absolute root at runtime — audited: no router, no `pushState`, no
`location.pathname` read in shipped code, no `new URL(…, import.meta.url)`, no
`BASE_URL` consumer. Hardcoding the repo name would break on a rename, on a move
to a user/org site, and under the local subdirectory rehearsal, for no benefit.
Relative base is also what makes `dist/` openable at any subdirectory depth,
which is what makes that rehearsal meaningful.

**Do not change unless** you have introduced something that resolves a runtime
URL against the root — which rule 3 forbids anyway.

**Relevant commits:** `33651d1`

---

## Decision: Relative app-asset URLs coexist with absolute crawler URLs

**Status:** Accepted. **The most likely thing in this repo to be "fixed" by
mistake.**

**Context:** `index.html` contains `href="./favicon.ico"` a few lines above
`href="https://kart.eugeneyip.com/"`. It reads like an inconsistency.

**Decision:** Icon and manifest hrefs are **relative**; canonical, `og:url`,
`og:image` and `twitter:image` are **absolute**. A comment in `index.html` says
so explicitly.

**Why:** They are resolved by different consumers. The browser fetches icons *in
the page's context*, so they must survive `base: './'` at any subpath. A crawler
resolves metadata **out of context** — from an index, a scrape, or a social card
renderer that never saw the page's directory — where a relative URL is useless.

**Do not change unless** the production URL itself changes, in which case the
absolute ones move together and the relative ones stay untouched. **Never
normalise one style to the other.**

**Relevant commits:** `627401c`

---

## Decision: Publish via GitHub Actions, not a `gh-pages` branch

**Status:** Accepted.

**Context:** Pages can serve a committed `dist/` from a branch, or an artifact
built by Actions.

**Decision:** Actions. `npm ci` → `npm run build` → upload `dist` → deploy.
Node 22, concurrency group `pages` with `cancel-in-progress: false`.

**Why:** The build is a typecheck gate in front of a bundler over 92 build-input modules (106 under `src/`, less 14 in `src/dev/`).
A committed `dist/` would mean the live site is whatever someone last built on
their laptop, with their Node, their `node_modules`, and the typecheck possibly
skipped — and `dist/` is gitignored, so it would have to come back out and
produce a diff of minified bundles on every push. Actions keeps the artifact
reproducible from the commit, keeps the typecheck non-optional, and keeps
generated output out of history.

**Do not change unless:** in particular, **do not replace `npm run build` with a
bare `vite build`.** The typecheck is part of the build by design — a type error
must fail the deploy instead of shipping. And do not switch `npm ci` to
`npm install`; `ci` is what makes the bundle a function of the commit.

**Relevant commits:** `b4832ab`, and `.github/workflows/deploy.yml`'s own header

---

## Decision: `@types/node` is a devDependency, but `types` stays `["vite/client"]`

**Status:** Accepted.

**Context:** The first real Actions run failed at `tsc --noEmit` with
`Cannot find name 'process'` and `Cannot find name 'node:url'`. `@types/node`
was never in `package.json`; the local `node_modules` had drifted ahead of the
lockfile and compiled fine.

**Decision:** Add `@types/node@22`. Keep `tsconfig.compilerOptions.types` as
`["vite/client"]`. Change `src/dev/physics-run.ts` from the bare `process`
global to `import { exit } from 'node:process'`.

**Why:** Two different mechanisms. The `types` array gates **ambient global**
typings, and restricting it to the browser surface is correct for a browser
game — gameplay code has no business seeing `process` as a global, and adding
`"node"` would widen the global surface for all 100+ files to fix two. An
explicit `node:*` **import** does not go through that array at all.

**Correction, 2026-08-23** — the original wording here said the import
"resolves through ordinary module resolution against `@types/node`". It does
not, and the imprecision cost a later reader time. `node:process` resolves
through an **ambient module declaration** inside `@types/node`, which only
exists once `@types/node` is already in the program. With `types` pinned to
`["vite/client"]`, the one thing putting it there is `vite.config.ts` →
`vite`'s `index.d.ts` → `/// <reference types="node" />`. The decision itself
is unchanged and was right; only its stated mechanism was wrong. See
[`../PROJECT_STATE.md` §4.2](../PROJECT_STATE.md).

**Do not change unless** you want every file in `src/` to see Node globals. If a
scoped config complains about `node:*`, fix its `include`, not the `types`
array — see [`QA.md` §4.2](QA.md).

**The wider lesson, stated in the commit:** the real defect was not the missing
dependency, it was that **the readiness test was not reproducing CI.** Always
verify from a genuinely clean `npm ci`.

**Relevant commits:** `b4832ab`

---

## Decision: No sourcemaps in the published build

**Status:** Accepted. Trivially reversible.

**Context:** The pre-change `dist` was 11 MB, of which **8.9 MB (81 %)** was
three `.js.map` files — more than four times the 2.2 MB actually being shipped.

**Decision:** `sourcemap: false`.

**Why:** An **artifact-size** decision, not a performance one — a browser only
fetches a map when devtools is open, so this costs a player nothing either way.
But every deploy uploads and stores those 8.9 MB. The debuggability is nearly
free to recover: this repository is the public source of the deployed site, so
the deployed commit *is* the source commit and a mapped build is one flag away.

**Do not change unless** you need to read a production stack trace — then flip
it to `true`. It is a one-word change and nothing else depends on it.

**Relevant commits:** `33651d1`

---

## Decision: SWIPE is the default touch style, with JOYSTICK and D-PAD available

**Status:** Accepted. `Real-hardware accepted:`

**Context:** A hardware test said the virtual stick still oversteered for a
first-timer **after** travel had already gone 47 → 76 px with a softened curve —
and that another sensitivity tweak was explicitly not what was wanted.

**Decision:** Ship three selectable styles rather than a fourth tuning pass.
SWIPE is the default.

**Why:** SWIPE draws no steering control at all. A gesture may begin anywhere
that is not an action control, and **that touchdown point is its origin**, so
nothing is ever mapped from an absolute screen position and the style behaves
identically in portrait and landscape. Only `clientX` *differences* reach the
maths. It has its own constant block (110 px to full lock, 8 px dead zone, curve
1.7) rather than multipliers on the joystick's, so tuning one cannot move the
other.

D-PAD's hold **ramps** toward lock (2.2/s out, 6.0/s back, 6.0/s across centre)
rather than snapping the way the keyboard's 14/s ramp would.

**Two sub-decisions worth preserving:**

- **The D-Pad ships two arrows, not four.** Throttle is automatic while racing;
  the countdown's launch control is DRIFT, because `RaceDirector` times the
  rocket start from when the hold *begins*; and BRAKE already owns zeroing accel
  so `KartPhysics` can reverse. An Up arrow would be a second, conflicting
  throttle.
- **Auto-throttle waits for the green light**, so a touch player is not handed
  an automatic burnout penalty.

**Do not change unless** real hardware says so — see
[`QA.md` §1.7](QA.md). Changing the default means editing **both** field
initialisers (`TouchControls.ts:456`, `MenuSystem.ts:197`).

**Relevant commits:** `4638be6`, `41d6f21`, `070aa23`

---

## Decision: Touch steering travel and curve are measured, not tuned by feel

**Status:** Accepted. `Regression-tested:`

**Context:** The owner reported that small thumb movements produced too much
steering. Two causes compounded: full lock was ~47 px — about one thumb-width of
total throw — and the map was **linear**, spending as much steering per pixel at
dead centre as at full lock.

**Decision:** One commented constant block. `travelFrac` 0.36 → 0.58 (full lock
~47 → 76 px), `deadZone` 0.07, `curve` 1.5. `pow` leaves 0 at 0 and 1 at 1, so
the centre softens and the outer range is untouched.

**Why:** Measured in the browser, settled, base 131 px:

```
thumb px     6     12     20     30     44     60     76    100
steer     0.000  0.029  0.095  0.206  0.405  0.681  1.000  1.000
```

Dead-centre steering per pixel is about a tenth of the old linear map's. `0.68 /
1.9` was tried and **rejected**: calmer still, but it needs 50 px just to reach
0.30 steer and puts full lock at ~89 px, past comfortable thumb reach.

**Three constraints that must survive any retune:**

- **No smoothing.** It was considered and rejected: `updateStick` maps the
  pointer on the event that reports it, so a counter-steer lands on the frame
  the thumb moves. Smoothing would have been the easy way to calm the centre and
  would have made counter-steering feel late.
- **The knob is drawn at the RAW thumb offset**, not the curved value, so it
  never lags the finger.
- **Every derived feel number is a getter** over the constants plus the current
  setting. There is no stored product to go stale — which is precisely the
  defect the measurement caught: `private travel = 48` was a hand-copied
  duplicate of `131 * 0.36` that outlived the constant it came from, and
  `measure()` returned early on `!this.live`, so before a race the stick used
  48 px whatever `travelFrac` said.

STEERING SENSITIVITY multiplies **travel** (1.30 / 1.0 / 0.78) and divides the
D-Pad press rate by the same number, leaving every dead zone and curve alone, so
only the *scale* of the response changes and not its *shape*.

**Do not change unless** you re-measure and publish the new curve the same way.

**Relevant commits:** `2062cda`, `4638be6`

---

## Decision: Portrait is a supported orientation

**Status:** Accepted. `Real-hardware accepted:`

**Context:** The app previously displayed a blocking `ROTATE TO PLAY` prompt.
The owner tested portrait, found it worked, and wanted it supported rather than
warned against.

**Decision:** The rotate prompt and its CSS are removed, and **nothing blocking
replaces it**. An orientation change simply re-runs the responsive layout.

**Why:** It works. Two in-source comments that asserted "landscape is the design
orientation" were **corrected in place rather than deleted**, so the next reader
sees what changed instead of re-deriving it.

The character grid problem this exposed was explicitly *not* answered by
hard-coding a layout that fits one phone: `MenuSystem.refitGrid()` derives the
column count from the **measured** card width against the **measured** port
width and narrows until the row fits. Measured from a real card, so it tracks
the `max(150u, 7 × u-min)` legibility floor automatically — a media query would
have to restate that floor and would drift from it. It writes **both** the CSS
columns and `Screen.cols`, because `cols` drives the focus model; updating one
alone leaves arrow and gamepad navigation walking a grid shape that is not on
screen.

**Do not change unless:** do not reintroduce an orientation lock, and do not add
`"orientation"` to `site.webmanifest`. Do not answer a layout overflow with a
window-keyed media query — `ui.css` forbids it at the foot of the file.

**Relevant commits:** `2062cda`

---

## Decision: Shadow cascades run a 1 / 2 / 4 phased cadence

**Status:** Accepted. `Regression-tested:` **Do not re-stagger.**

**Context:** Three shadow cascades at 2048² each. Re-rendering all three every
frame is 12.6 Mpx of depth pass.

**Decision:** Intervals 1 / 2 / 4 at phase offsets 0 / 1 / 2.

**Why:** The cadence used to be 1 / 2 / 3 with no phase. Because the due test is
`frame % interval === 0`, cascades 1 and 2 **both came due whenever
`frame % 6 === 0`**, rasterising all three on that frame — the exact spike the
stagger existed to prevent. With 1 / 2 / 4 at offsets 0 / 1 / 2 the due sets are
disjoint, the worst frame is two cascades, and the amortised rate *falls* to
1 + ½ + ¼ = **1.75**.

**Do not change unless** you have verified the new due sets are disjoint at
every frame index. A stale comment in `RenderPipeline.scenePasses()` describing
the pre-phase design was corrected in `5bea189` precisely because, left alone,
it invited someone to re-stagger a cadence that is already correct.

**Relevant commits:** `5bea189`, `b21413d`

---

## Decision: A cascade with no shadow map is forced due (the warm-up fix)

**Status:** Accepted. `Regression-tested:` Closed — full account in
[`../PROJECT_STATE.md` §3.1](../PROJECT_STATE.md).

**Context:** The race scene rendered as sky only, intermittently, ever since the
phased cadence shipped, with the console flooded by
`GL_INVALID_OPERATION: Mismatch between texture format and sampler type`.

**Decision:** The due test begins with `c.light.shadow.map === null` — in the
shadow hook **and** in `fitCascades()`. `RenderPipeline.warmShadowMaps()` renders
one throwaway frame into a 1×1 target to force allocation.

**Why:** `shadow.map` is allocated **lazily** inside three's
`WebGLShadowMap.render`. A never-rendered cascade has a null map, three
substitutes its private `emptyShadowTexture`, and the array uniform path
`setValueT1Array` does not set `compareFunction` the way the scalar path does —
so a plain depth texture ends up bound to a `sampler2DShadow` declaration and
every shadow-receiving draw fails validation. Only materials receiving no shadow
still drew, which is exactly why **the sky survived and the world did not**.

Two things had to be true at once: `fitCascades()` runs from inside the shadow
hook, after anything that asked for a warm-up and before the depth pass, so its
`needsUpdate = false` was the **last word** and silently cancelled the warm-up;
and phase makes frame 0 the worst possible frame to be cancelled on, because
`(0 - phase) % interval` is −1 and −2, so **no staggered cascade is ever due on
the first frame**.

The earlier guard assumed that merely *not skipping* a null-map cascade was
enough. It is not — `WebGLShadowMap.render` carries the same
`autoUpdate === false && needsUpdate === false` test, and cascades 1+ run with
`autoUpdate = false`, so handing three a not-due cascade just moves the skip one
level down and the map stays null. **Forcing it due is what actually allocates
it.**

**Evidence:** forced failing path went **708 GL errors with cascades 1 and 2
NULL → 0 errors with all three allocated**; steady-state cadence measured over
40 frames at **40 / 20 / 10**, exactly the intended 1 / 2 / 4. Recovery verified:
disposing a map mid-session on a non-due frame recovers on the next frame with 0
errors.

**Do not change unless:** the forced render is one-time per cascade, not a
cadence change — the specific risk was a warm-up that quietly made every cascade
due every frame, trading a black screen for a frame-time regression. Any change
here must re-measure the stagger. `__POST__.shadowMaps()` exists to check this
synchronously; run it at frame 0.

**Relevant commits:** `5bea189`, `b21413d`

---

## Decision: A test that cannot fail must not ship

**Status:** Accepted. **The project's defining QA rule.**

**Context:** Repeated discovery of green checks that were structurally incapable
of going red — a depth calibration whose test insets were all exact multiples of
the search step; a shoulder probe whose "independent" ground truth was the same
code path, three functions computing one number; a roster guard grading a
hand-transcribed copy of a function it never imported.

**Decision:** A check must be demonstrated to fail on broken input before it is
trusted. If it cannot be made to fail, **delete it rather than ship it.**

**Why:** A check that cannot fail is worse than no check, because it removes the
next person's reason to look. This was applied literally in `6233437`: an
`acceptsPointer()` guard was written, could not be made to fail even with the
guard deliberately disabled — a 100 px gesture one frame after `showPause()`
still produced steer 0.0000, because `.ak-menus` is z-index 60 against the touch
layer's 50 — and was therefore **removed, with the comment explaining why
shipped in its place.** That commit is comment-only.

**Corollaries, all earned:**

- **Never widen a tolerance to make something pass.**
- A **failing** probe may mean the probe is wrong — but you must go and look,
  not assume.
- Do not dismiss an unexplained nonzero result.
- Check what the probe is actually measuring: every geometric audit in this
  project once ran at the `low` tier, missing **15.9 %** of the shipping world,
  because prop scatter density follows the quality tier.

**Do not change unless:** never. Full detail in [`QA.md` §1](QA.md).

**Relevant commits:** `6233437`, `896c997`, `7810e8b`, `95d910e`

---

## Decision: `PHYS.hopSpeed` is 4.6, not the 2.6 a ballistic reading suggests

**Status:** Accepted, 2026-08-23. Owner decision.

**Context:** `hopGravity`'s comment derived the hop's hang time as
`2·hopSpeed/(g·hopGravity)` ≈ 0.325 s, and DriftSystem §1 promised "the kart is
genuinely airborne". At `hopSpeed` 2.6 **it never left the ground at all**:
`groundedWheels` bottomed out at 2 — the rear wheels stay planted under any
throttle, on the flat or on the oval — and the chassis rose 0.107 m. The
`hop air time` assertion had been *passing* at 0.308 s only because the physics
bench's `raycastGround` had a blind band at the far end of its ray that reported
the wheels airborne while the kart sat on its springs, which then let
`hopGravity` engage. Fixing the bench turned that green check red and revealed
the real behaviour.

**Decision:** `hopSpeed` = **4.6**. `Measured:` 0.283 s of air, 0.385 m rise.

**Why:** the ballistic formula is not the hang time. `hopGravity` is gated on
`!b.grounded`, so the reduced gravity cannot apply until the impulse has already
pulled the wheels through the suspension's *remaining* droop — only 0.11–0.13 m
at the settled ride height, and spent before any air time begins. Air time first
appears at all around 3.4; 4.2 passes the assertion's lower bound by 0.005 s,
which is too fine to hold. `Directly verified:` removing the `!b.grounded` gate
instead does **not** work (rise 0.126 m, still 0.000 s), so this is not an
ordering bug. Cost elsewhere is small: drift charge timings move ≤ 0.05 s
(Purple 2.76 → 2.83 s) and nothing else in the battery changes.

`Regression-tested:` confirmed against the **real** `Track`, not just the bench,
since the bench's own `raycastGround` is what hid the bug —
`node src/dev/node-run.mjs .probe-tmp/HOP-real-track.ts` gives 0.000 s of air on
all eight circuits at 2.6 (minGroundedWheels 4 on seven of them) and
0.242–0.300 s at 4.6, inside the asserted range on every circuit.

**Do not change unless** you re-measure `hop air time` after it. In particular do
not "restore" 2.6 on the strength of the ballistic arithmetic — that is the exact
reasoning that made the hop a no-op, and the suspension droop is the term it
omits.

**Consequence found afterwards, by the rendered check — and still open.** The
numbers above are right and the decision stands, but a hop that genuinely leaves
the ground exercises a path that a hop stuck on its springs never did: it **arms an
air trick that `DriftSystem.tricks()` explicitly tries to refuse**, because the
`fromHop` guard reads a `hopTime` that is already 0 by the time the wheels leave.
Every drift hop therefore flips the chassis ~90° and pays an unearned
`DRIFT.trickBoost`. `Directly verified:` all eight circuits, via
`.probe-tmp/HOP-trick-guard.ts`. Full diagnosis in
[`../PROJECT_STATE.md` §4.3](../PROJECT_STATE.md).

The lesson for this decision specifically: **the rendered check was not a
formality.** Air time, rise and the whole 46-assertion battery are green with this
bug present — it is invisible to every number the battery takes. The hop's visual
status is therefore **unverified**, not accepted.

**Relevant commits:** `8135aff` (the bench fix that exposed it)

---

## Decision: The grind assertion is anchored to respawn pace, not to a share of free speed

**Status:** Accepted, 2026-08-23. Owner decision.

**Context:** `grinding a wall is not a crash` asserted "> 60 % of free speed" and
read 52 %. The number was real — `leanOnBarrier()` computes press = 0.5775 and
behaves exactly as documented — but the comparison was not: the wall run must
start at u = −11.7 to reach a rail at 12.7 m when the asphalt ends at 11, so it
paid `PHYS.vergeDrag` for the kerb band the whole time while the baseline ran
down the centreline and paid none (`Measured:` the kerb alone is 3.4 m/s of the
gap). It also sampled one instant, and the contact is not a smooth decay: it
holds an equilibrium that oscillates ±1.5 m/s, and tick 360 landed in a trough.

**Decision:** the equilibrium — a **mean over the final second** — must exceed
`tuning.maxSpeed · 0.4`. Nothing was widened; the 60 % figure is not reproduced
in a looser form, it is replaced by a different claim.

**Why:** `maxSpeed · 0.4` is the game's own definition of a speed you can race
from — a respawn drops you back in at exactly that ("Drop back in at 40 % pace",
`KartPhysics`). So the claim is *grinding a barrier must not leave you worse off
than being fished out of the void*, which is a sharper reading of the contact
model's "it never stops you" than any percentage of a free run that bundles the
kerb. `Measured:` 13.80 m/s, 48.6 % of top speed, against an 11.4 m/s floor.

**A budget derived from the drag constants was tried first and rejected under
this file's own rule.** `vergeContactDrag · press` = 0.3176 /s, so 3 s with the
engine contributing nothing leaves exp(−0.3176·3) = 38.6 % — sound arithmetic,
and it is printed as a note every run. But a floor derived from
`vergeContactDrag` *moves with it* and therefore cannot fail: `Measured:` at
`vergeContactDrag` 4.0 the floor drops to 0.1 % and the assertion passes at
35.8 %, a barrier seven times harsher than shipped and still green. See
[A test that cannot fail must not ship](#decision-a-test-that-cannot-fail-must-not-ship).
The respawn-pace anchor is falsifiable both ways: `Measured:` `vergeContactDrag`
4.0 → 7.60 m/s red, `vergePressFloor` 1.0 with drag 1.6 → 9.28 m/s red.

**Do not change unless** you are re-deciding how expensive riding the edge should
feel, which is a design call and not something the probe can adjudicate. The
per-tick-penalty regression the block was originally written for is guarded by
`a grind is not re-penalised per tick`, which `Measured:` fails at 292 penalties
when the grace is removed — and, as its comment has always claimed, nowhere else.

**Relevant commits:** `8135aff`, `4d3f979`

---

## Decision: Drift stays; the entry barrier was lowered instead

**Status:** Accepted. Owner decision — **do not re-litigate.**

**Context:** The owner initially asked to remove drifting: *"it is really hard to
perform, it'd be better to have it removed unless it's easier to activate."*

**Decision:** Keep the mechanic; fix the input. `engageSteer` was lowered from
**0.26 to 0.12** (`src/physics/DriftSystem.ts:85`). The skill stays in the hold
and the release.

**Why:** The complaint was the **input barrier, not the mechanic**. Drift was a
two-stage timed input — press, wait out ~0.32 s of hop, and be holding
`|steer| >= 0.26` at the exact instant of touchdown, or nothing happened, with no
feedback. Removing drift would take the hop, the mini-turbo, the charge tiers,
the purple-spark payoff and **the primary source of boost** with it, would
invalidate the AI overtaking tune, and would break ramp tricks, which arm off
the same button. `DriftSystem.ts`'s own header calls it *the single most
important system in the game*.

**Do not change unless** the owner says so directly.

---

## Decision: Oil slicks are placed on no circuit; the hazard kind stays

**Status:** Accepted. Owner decision, requested twice.

**Context:** *"remove the black mist-like obstacles in the middle of the tracks,
as they negatively impact the gameplay experience."*

**Decision:** Every oil placement is removed from every circuit's `hazards`
list. The `'oil'` **kind** is left intact in `src/items/Hazards.ts`.

**Why:** `makeOil` painted a 6.2 m disc at `rgba(10,10,14,0.95)` — near-black at
95 % opacity — lying flat on the road with `depthWrite: false`. On dark asphalt
that does not read as an object you can dodge; it reads as fog, which is exactly
the word the owner reached for. It also carried `stun: 0.85` with `kick: 0`, so
it spun you with no visual warning.

Same pass: **nothing sits on the racing line any more.** `lat: 0` had put a 40 m
traffic sweep dead centre. Hazards now live off-line, where they punish a bad
line rather than blocking the good one, and speeds are down ~35 %.

**Do not change unless** it comes back with art that reads as a hazard at 25 m —
a bright rim, a raised lip, warning chevrons — **not a darker patch of dark.**
The kind was kept precisely so that is possible without rebuilding it.

---

## Decision: Split-screen two-player is cancelled

**Status:** Cancelled by the owner. `Historical only:` for the supporting
numbers.

**Context:** *"If a split screen two players mode will cost the smoothness of the
game, cancel this plan."*

**Decision:** Cancelled.

**Why:** It would. The frame already runs multiple full passes over the scene
per frame and a large share of triangles are uncullable, so a second viewport
roughly doubles an already-tight frame. `RenderPipeline` also assumes one camera
and one post chain.

**Do not change unless** the culling and pass-count work lands first and the
frame has measured headroom. `Not re-verified in this continuity pass:` the
specific pass and triangle figures — re-measure before quoting them.

---

## Decision: Five live items, not sixteen

**Status:** Accepted.

**Context:** `ItemType` has sixteen members and `use()` handles all of them.

**Decision:** Only five can come out of a box — Plastic Bottle, Battery, Rocket,
Ninja, Star. The other eleven carry **weight zero in every row** of the
position-weighted roulette table.

**Why:** A deliberate scope decision, and a mechanically clean one: the code
paths stay alive and testable, and `grantItem()` still works for any of them, so
re-enabling one is a table edit rather than an implementation.

**Do not change unless** you are also prepared to balance the roulette. Note
that an item with zero weight everywhere is **unreachable by play** — if you are
verifying one, grant it directly rather than assuming a box will ever produce
it.

---

## Decision: The in-race HUD is exempt from the text legibility floor

**Status:** Accepted. `Intentional tradeoff:` — measured.

**Context:** A `--u-min: 11px` floor was added so UI text stays readable at small
viewports. It caused text overflow in the HUD (`MASCO`, `WEIGH`, `HANDLI`…).

**Decision:** `.ak-hud { --u-min: 0px; }`. The menus and the results board carry
the floor.

**Why:** Measured across **336 configurations** (7 race states × 4 viewports ×
12 positions): `--u-min: 0` gives 0 overflow, 7px gives 2, 8px gives 4, 11px
gives 10, with up to 18.3 px of ink escaping `.ak-drift`. Every HUD label sits
in a `--u`-derived box — the rival badge is a 26u square, the nameplate a fixed
116u tag — so flooring the text makes it outgrow the box. Making all ~14 widgets
floor-aware means re-deriving their geometry from their own font size: a
redesign of the HUD layout model, not a fix, and it would break the proportional
invariant an earlier pass established and measured.

Menus carry the floor instead because their layout is content-sized and simply
grows to accommodate it — verified, they fit.

**This is an accepted deviation, not a closed bug.** Legibility at a small frame
is genuinely worse in the HUD than in the menus.

**Do not change unless** the owner asks for it — then change the one value and
run `__UIQA__.matrix()`, which names every widget that breaks. **Do not reach
for a media query.**

---

## Decision: UI reads ids from the real tables, never a hardcoded copy

**Status:** Accepted. Fixes a real, shipped bug.

**Context:** `src/ui/Catalogue.ts` exists as an adapter over the roster, chassis
and circuit tables.

**Decision:** All menu content derives from the shipping data structures.

**Why:** The previous hardcoded copy caused **6 of 8 racers to drive as Nova**
and **every course card to load Sunset Coastline** — because `getTrackDef()` and
the character lookups **fall back silently on an unknown id**. A typo produces a
plausible wrong result, never an error.

**Do not change unless:** never retype an id into the UI. This same silent
fallback bites probes too: `sightline.ts all` once measured one circuit while
printing `=== all ===`, because `all` fell through as an unknown id.

**Relevant commits:** `95d910e` (for the probe-side instance)

---

## Decision: Optional collaborators are feature-probed, never hard-imported

**Status:** Accepted, architectural.

**Context:** The project was built by ~12 parallel agents, each owning a file
set, against a shared contract in `src/core/Types.ts`.

**Decision:** Hard dependencies are constructor-injected. Anything that would
create a cycle — or that another author might not have built yet — arrives
through an **optional setter** and is called only through a probing helper
(`wire()`, `callOpt()`, `methodOf()`, `resolve*()`). Collaborators are typed as
narrow **structural interfaces**, not concrete classes.

**Why:** A missing collaborator degrades instead of crashing, and one subsystem
can be replaced without breaking the build. `Environment.init()` never throws for
the same reason: a broken layer degrades to "missing" rather than taking the
game down.

**Do not change unless:** **do not "clean this up" into direct imports.** It
looks like indirection for its own sake and is not. See
[`ARCHITECTURE.md` §0](ARCHITECTURE.md).

---

## Decision: One cross-section function drives both road mesh and physics ground

**Status:** Accepted, architectural.

**Context:** A racing game where the visual road and the collision surface are
authored separately will eventually disagree, and the bug is invisible until
someone falls through the world.

**Decision:** `TrackBuilder.surfaceHeight()` is evaluated by both the mesh
generator and the physics ground probe. Physics and AI depend on
`ITrackService`, never on the track's meshes.

**Why:** Geometry and collision **structurally cannot** diverge. It is also why
runtime kart collision is analytic rather than a BVH raycast — projection onto
the centreline plus a cross-section evaluation, allocation-free.
`three-mesh-bvh` is used only for a QA cross-check and for baking ambient
occlusion at init.

**Do not change unless** you are prepared to add a probe proving the two agree
at every station. Editing `surfaceHeight()` changes **visuals and physics
simultaneously** — that is the point, and it is a large blast radius.

---

## Decision: Rubber-banding modulates risk, not speed

**Status:** Accepted.

**Context:** Catch-up AI usually cheats with a speed multiplier, which players
detect immediately.

**Decision:** Speed multipliers are hard-clamped to **0.94–1.05**. Catch-up
expresses itself as willingness to take a riskier line.

**Why:** A visible speed cheat destroys the sense that the field is racing. The
narrow clamp makes the cheat unavailable by construction rather than by
discipline.

**Do not change unless** you widen the clamp knowingly — it is the whole
mechanism.

---

## Decision: The boot overlay contains no script, no image, and no canvas

**Status:** Accepted.

**Context:** The boot screen once hung at "Initializing" and looked like a
broken build.

**Decision:** `index.html`'s boot overlay is parser-visible HTML and inline CSS
only.

**Why:** `requestAnimationFrame` **never fires at a 0×0 viewport**, so anything
depending on the module graph, WebGL, or rAF goes down with it. The parser
paints the overlay before `main.ts` is even reached, so a stall is visible and
legible rather than blank.

**Do not change unless:** do not rename `#app`, `#boot`, `#boot-bar`,
`#boot-fill`, `#boot-msg` — `main.ts` writes all of them. The general corollary
for your own code: **never assume rAF will fire.** If you yield during `init()`,
race it against a `setTimeout` fallback so a hidden or zero-size tab cannot
deadlock startup.

---

## Decision: Chunk-size warnings above 500 kB are accepted

**Status:** Accepted. `Intentional tradeoff:`

**Context:** `vite build` warns that `index-*.js` (~1.4 MB) and `post-*.js`
(~771 kB) exceed 500 kB.

**Decision:** Accepted. `manualChunks` splits `three` and `postprocessing` into
their own chunks, but total bytes are not reduced.

**Why:** This is a single-page game that needs its whole engine before the first
frame; code splitting would trade a smaller first chunk for a **longer
time-to-playable**. The split exists to keep vendor code in long-lived cacheable
chunks so a gameplay change does not invalidate ~1.5 MB for returning players —
a caching decision, not a size one.

**Do not change unless** you have measured time-to-first-playable-frame, not
just bundle size.
