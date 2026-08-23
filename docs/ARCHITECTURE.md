# Foxy Kart — architecture

**Purpose: answer "if I need to change X, where do I look first?"**

Everything here was read from the source at baseline
`627401c24ad7e4ea114f25e828234a286c171277`. Line counts are approximate and
drift; file paths and responsibilities are the durable part.

See also: [`../PROJECT_STATE.md`](../PROJECT_STATE.md) ·
[`../AGENTS.md`](../AGENTS.md) · [`DECISIONS.md`](DECISIONS.md) ·
[`QA.md`](QA.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md)

---

## 0. Shape of the thing

106 TypeScript modules (92 build inputs; the 14 under `src/dev/` are not), ~114 k lines, in fifteen subsystems under `src/` plus
`src/main.ts`. No framework. The path alias `@/*` → `./src/*` is declared in
both `vite.config.ts` and `tsconfig.json`.

```
index.html  →  src/main.ts  →  Game  →  Engine (loop)  →  every subsystem
```

### The two dependency idioms, and why both exist

This is the single most important structural fact in the codebase.

- **Hard dependencies are constructor-injected**: `new PhysicsWorld(track)`,
  `new KartManager(scene, renderer, track, physics, quality)`.
- **Anything that would create a cycle — or that another author might not have
  built yet — arrives through an optional setter** and is only ever called
  through a feature-probing helper: `wire()` in `src/game/Game.ts`,
  `callOpt()` / `methodOf()` in `src/game/RaceDirector.ts`, `callOptional()` in
  `src/camera/CameraRig.ts`, `resolve*()` in `src/ai/AIManager.ts`.

A missing setter is never fatal; the caller degrades. This follows directly from
the parallel multi-agent build contract in [`../AGENTS.md`](../AGENTS.md), and
it is why so many collaborators are typed as narrow structural interfaces rather
than concrete classes. **Do not "clean this up" into direct imports** — it is
what lets one subsystem be replaced without breaking the build.

The other cross-module channel is the typed event bus (§3).

### Subsystem sizes

| Directory | Files | ~Lines | What it owns |
|---|---:|---:|---|
| `src/world/` | 11 | 24 400 | Terrain, props, foliage, sky, water, weather, crowd, lighting |
| `src/karts/` | 8 | 12 700 | Chassis, drivers, wheels, materials, roster, portraits |
| `src/track/` | 8 | 9 200 | Spline, road mesh, decals, checkpoints, circuit definitions |
| `src/ui/` | 10 | 8 700 | Menus, HUD, minimap, touch controls, results, prefs |
| `src/items/` | 6 | 7 300 | Boxes, roulette, projectiles, hazards, item models |
| `src/audio/` | 6 | 7 000 | Synthesis, engine sound, music, reverb, SFX bank |
| `src/render/` | 6 | 6 900 | Pipeline, post FX, texture and material factories |
| `src/ai/` | 5 | 6 500 | Drivers, racing line, personalities, rubber-band |
| `src/vfx/` | 10 | 6 000 | Particles, sparks, flames, trails, decals, speed lines |
| `src/physics/` | 6 | 3 500 | Kart body, suspension, drift, collision, tuning |
| `src/game/` | 4 | 2 100 | Composition root, race director, race state, standings |
| `src/camera/` | 3 | 2 100 | Chase camera, cinematics, rig |
| `src/core/` | 6 | 1 400 | Engine loop, shared types, input, config, math, event bus |
| `src/qa/` | 1 | 500 | The `__QA__` capture harness |
| `src/dev/` | 25 | 10 700 | Standalone harnesses. **Not build inputs** — see §16 |

---

## 1. Entry point and boot

**Files:** `index.html` (284 lines), `src/main.ts` (72 lines)

`index.html` carries the render host `<div id="app">` and a **boot overlay
written entirely in parser-visible HTML and inline CSS** — no script, no
`<img>`, no canvas, no fetch. That is a deliberate fix, stated in the file: a
previous version hung at "Initializing" because `requestAnimationFrame` never
fires at a 0×0 viewport, so anything depending on the module graph, WebGL, or
rAF went down with it. The parser paints the overlay before `main.ts` is
reached.

**The boot contract — do not rename these ids:** `#app`, `#boot` (gets
`.hidden`, then is removed), `#boot-bar`, `#boot-fill` (`style.width` written as
a percentage), `#boot-msg` (`textContent`, `role="status" aria-live="polite"`).

`src/main.ts` in order:

1. `detectTier()` — a cheap GPU probe. No WebGL2 → `low`. Mobile UA → `medium`.
   SwiftShader/llvmpipe/software or old Intel HD/UHD 5xx/6xx → `low`. A modern
   discrete or Apple-silicon renderer **and** ≥8 cores → `ultra`; ≥8 cores →
   `high`; otherwise `medium`.
2. Subscribes `bus.on('engine:progress')` to drive the bar and status text.
3. `new Game(container, tier)`, then `globalThis.__GAME__ = game`.
4. `await game.init()` in a try/catch that reports failure into `#boot-msg`.
5. **Dev only:** `if (import.meta.env.DEV)` → dynamic-import and install the
   capture harness. See §15.
6. `game.start()`, then a nested rAF + `setTimeout` that holds the boot screen
   one beat so the first frames can warm the shader cache.

> **`__GAME__` is assigned unconditionally and ships in production.** Only
> `__QA__` and `__POST__` are dev-gated. See §15 — the distinction matters and
> is easy to get wrong.

**Change X → look here:** boot visuals or copy → `index.html` `<style>` and
`#boot*` markup. Tier heuristics → `detectTier()`. What the progress bar counts
→ `Game.init()`.

---

## 2. Orchestration — the composition root

**File:** `src/game/Game.ts` (235 lines)

The constructor builds only `Engine` and `Input`. `async init()` runs a strictly
ordered, awaited, 14-step build emitting `engine:progress` at each step:

```
Input → Sky → Lighting → Track → Environment → Physics → Karts
      → physics.setKarts(karts.karts)
      → Effects (VFX) → Camera → Items → Opponents (AI) → Audio → Race → Ready
```

Then late-wiring via `wire<T>(target, method, dep)`, then registration of 17
subsystems in an order the file documents as load-bearing:

| Group | Subsystems | Why here |
|---|---|---|
| Simulation | `input, physics, ai, items, race` | Produce this frame's truth |
| Visual transform | `karts, camera` | **The camera must run before anything that reads it**, or shadow cascades, VFX billboards and the audio listener are a frame stale |
| World dressing | `track, environment, sky, lighting, vfx, audio` | Consume the transformed state |
| Presentation | `hud, menus, pipeline` | Draw last |
| Shim | `input.endFrame()` | Consumes rising-edge flags, must be last |

**Change X → look here:** adding a subsystem, or changing what runs before what
→ `Game.ts` `ordered`. Wiring an optional dependency → the `wire()` calls.

---

## 3. Core — loop, types, config, bus

**Directory:** `src/core/` — `Engine.ts` (426), `Types.ts` (384), `Input.ts`
(250), `MathUtils.ts` (119), `Config.ts` (115), `EventBus.ts` (85)

### The frame loop and fixed timestep

`Engine.loop` in `src/core/Engine.ts`. Constants in `src/core/Config.ts`:

```ts
FIXED_DT      = 1 / 120     // physics ticks at 120 Hz
MAX_SUBSTEPS  = 8
MAX_FRAME_DT  = 0.1
```

Per frame: clamp raw dt, accumulate, run `fixedUpdate` up to `MAX_SUBSTEPS`
times, **zero any backlog beyond that** so a stall cannot spiral, publish
`ctx.alpha = accumulator / FIXED_DT`, then run every `update`, then reset
`renderer.info` and hand off to the render callback.

`Engine` does not interpolate — it publishes `alpha`. `KartManager.update` is
the consumer (§9).

The renderer itself is built here, not in `src/render/`: `antialias: false` (AA
is SMAA in the post chain), `SRGBColorSpace` output, `PCFShadowMap`,
`renderer.info.autoReset = false`, and a **pixel budget** rather than a raw DPR
cap — `baseRatio = max(1, min(min(devicePixelRatio, 2), sqrt(1920*1080 / (cssW*cssH))))`.

Also here: the **adaptive resolution ratchet** (60-frame median, step down above
16.6 ms held 1 s, step up below 10.5 ms held 4 s, floor 0.65, and after
`MAX_REVERSALS = 3` the ceiling is nailed for the session), and
`webglcontextlost`/`restored` handling.

### `Types.ts` — the contract surface

Its header states the rule: subsystems import from `@/core/Types` and receive
dependencies via constructor or `update()` context; they do not import each
other's internals.

The load-bearing exports:

- `FrameContext` — `{ dt, fixedDt, elapsed, frame, alpha }`, all seconds.
- `InputState` — the blended device readout.
- `enum SurfaceType` (13 members) and `SurfaceProperties`.
- **`ITrackService`** — the collision and navigation service. `lapLength`,
  `sampleAt`, `sampleAtDistance`, `project`, `raycastGround`, `collideWalls`,
  `surfaceAt`, `racingLineAt`, `getStartPosition`, `getRespawn`,
  `isOutOfBounds`. **Physics and AI depend on this, never on the track's
  meshes.** This is the most important interface in the project.
- **`KartState`** — the ~40-field per-frame readout that VFX, audio, camera, UI
  and AI all consume.
- `KartTuning`, `enum DriftStage`, `enum ItemType`, `ItemHitEvent`.
- `IAudioService`, `IVfxService`, `QualityTier`, `QualitySettings`, `ISubsystem`.

**Ownership rule, and it is strict:** only `PhysicsWorld` /
`KartPhysics.writeState` writes physics fields on `KartState`;
`KartManager.update` is visual-only; `RaceDirector` writes only race-progress
fields (`lap`, `progress`, `racePosition`, `finished`, `finishTime`, `lapTimes`).

### `Config.ts`

Timestep constants, world and race constants, the `SURFACES` table, and
`QUALITY_PRESETS`. A documented gotcha: `ultra` declares the same
`shadowMapSize: 2048, cascadeCount: 3` as `high` because `Lighting` clamps to
those; ultra differs by `ssr`, `particleBudget: 20000`, `anisotropy: 16`, and
`foliageDensity: 1.0`.

### `EventBus.ts`

One process-wide typed singleton `bus`, keyed by the `GameEvents` map, with each
handler individually try/caught. **Never `emit('some-string')` ad hoc** — add
the event to `GameEvents` first.

### `MathUtils.ts`

`damp(current, target, halfLife, dt) = target + (current-target) * 2^(-dt/halfLife)`
— frame-rate-independent smoothing, and the reason `AGENTS.md` rule 8 forbids
naive per-frame `lerp`. Plus `clamp`, `smoothstep`, `moveTowards`, `angleDelta`,
hashes, a xorshift `Rng`, and frozen `UP`/`FORWARD`/`RIGHT`.

> **Note on `scratch`.** `MathUtils` exports a `scratch` object of shared
> temporaries and `AGENTS.md` rule 5 names it. `Directly verified:` **no file in
> `src/` imports it.** Every hot module declares its own module-level
> temporaries instead (`_v1.._v4` in `Suspension.ts`, `_ctrl` in
> `RaceDirector.ts`, and so on). The *rule* — zero allocations in hot loops — is
> honoured throughout; the named mechanism is not the one in use. Follow the
> local pattern of the file you are editing.

### Input

`src/core/Input.ts`. Three devices blended **loudest-source-wins**, so an unused
device is all-zero and adding one cannot change existing behaviour:

1. **Keyboard** — `KEY_MAP`: WASD/arrows, Space/Shift drift, E/Ctrl/F item, Q
   look back, Enter/Escape start.
2. **Gamepad** — polled in `update()`; 0.14 radial dead zone, 0.35 expo.
3. **`virtualController`** — an exported *module-level* object written by
   `src/ui/TouchControls.ts`. It is module-level because `Input` is constructed
   inside `Game` and never handed to the UI; the keyboard reads `window` and the
   pad reads `navigator`, so a third published device is the existing pattern,
   not a new one.

Steering is rate-limited here, but only as an anti-step smoother —
**`KartPhysics` owns the authoritative rate limiter** on the fixed 120 Hz step.

**Change X → look here:** tick rate or substep policy → `Config.ts` +
`Engine.loop`. A new cross-module field → `Types.ts`. A new event →
`GameEvents`. Quality knobs → `QUALITY_PRESETS`. Control mapping → `KEY_MAP`,
the gamepad block, or `virtualController`.

---

## 4. Physics

**Directory:** `src/physics/` — `KartPhysics.ts` (1370), `KartCollision.ts`
(709), `Suspension.ts` (423), `DriftSystem.ts` (416), `PhysicsWorld.ts` (388),
`Tuning.ts` (243)

`PhysicsWorld` is the only entry point. `new PhysicsWorld(track: ITrackService)`,
then `setKarts(karts)` adopts the authoritative `KartState[]` created by
`KartManager` and builds one `KartBody` each. Header claim: **zero allocations
after `setKarts`.**

Step order per fixed tick, per body:

```
Suspension → DriftSystem → stepKart → resolveWalls → checkBounds
then once:  resolveKartPairs(bodies, dt)
then:       writeState for every body
```

`writeState` last "so nobody ever observes a half-resolved frame".

`setControl` **latches** `driftPressed` (OR-ed, never overwritten) so a press
cannot be lost when a frame runs zero fixed steps, nor consumed twice when it
runs two.

### The model

Explicitly *not* a vehicle simulation. Three axes:

- **Longitudinal** — drive curve tapering to a **soft** speed cap, so boost can
  exceed it and bleed back.
- **Lateral** — the chassis yaws freely; velocity direction chases it via a
  **magnitude-preserving rotation** limited by a tyre-load curve. At extreme
  slip it crossfades to plain lateral damping so momentum cannot be laundered
  into forward speed.
- **Vertical** — delegated entirely to `Suspension.ts`: four independent
  raycast spring-dampers, forces applied at contact points so weight transfer
  falls out of Σ r×F, anti-roll bars stiffer at the rear for an oversteer bias,
  and the load-weighted average contact normal becomes the chassis `up`.

Conventions: **−Z forward, +Y up**; positive yaw rate turns **left**;
`driftDirection` +1 is right.

`applyStunTo` is the single choke point for all damage and grants
`POST_HIT_GRACE = 1.5 s` of invulnerability.

### Collision — and where `three-mesh-bvh` actually is

**Runtime kart collision does not raycast triangles.** `ITrackService.collideWalls`
and `raycastGround` are **analytic**: project onto the centreline, evaluate the
cross-section function, solve against the local tangent plane. Zero allocations.

Three contact classes in `KartCollision.ts`:

| Class | Behaviour |
|---|---|
| **Verge** (track edge) | Friction only — no impulse, no yaw kick, not counted as an impact. `vergeAllow = 0.16 m` of penetration is left unresolved on purpose so the contact survives to the next query |
| **Solid** (building, rock) | Soft collider, stiffer drag, positional push-out; one-time cost only for a near-head-on shunt |
| **Out of bounds** | Recovery in `checkBounds` after a `voidGrace` window |

Kart-vs-kart is an O(n²) sphere test with a vertical clearance check and
mass-weighted push-apart.

`three-mesh-bvh` appears in exactly three places, none of them per-frame kart
collision: built in `TrackBuilder.ts` and stored as `Track.bvh`, whose only
consumer is the QA cross-check `Track.verifyAgainstBvh()`; and in
`KartBodies.ts` to bake ambient occlusion into vertex colours at init.

**Change X → look here:** handling feel → the `PHYS` block at the top of
`KartPhysics.ts`. Wall or edge behaviour → the `COLL` block and
`classifyContact()` in `KartCollision.ts`. Ride height or body roll → the `SUSP`
block. Per-character balance → `Tuning.ts`. Step ordering → `PhysicsWorld.ts`.

---

## 5. Drift, boost, and items

### Drift

**File:** `src/physics/DriftSystem.ts`. Its own header calls drift *the single
most important system in the game*.

Press **arms** the drift and the arm stays live while held; it **commits** on
the first tick that is grounded, above `minSpeed 4.0`, and steering at least
`engageSteer` — **0.12, lowered from 0.26**, which was the fix for the owner's
"too hard to perform" complaint (see [`DECISIONS.md`](DECISIONS.md)). Then a
real hop (2.6 m/s, ~0.32 s of air), a commanded slip angle of 12°–38°, and a
charge that scales with inward steer and speed through the tiers in
`KartTuning.driftTiers`/`driftBoosts`. Releasing below Blue pays nothing.

Ramp tricks arm off the same button (`trickGrace 0.26`, `trickBoost 0.55`).

### Boost

`applyBoostTo` in `KartPhysics.ts` stacks duration (capped at 6 s) and takes the
**max** strength, grants brief off-road immunity, and emits `kart:boost`. Drift
mini-turbos are the primary source; boost pads and the Battery item are the
others.

### Items

**Directory:** `src/items/` — `ItemModels.ts` (2886), `Projectiles.ts` (1271),
`ItemSystem.ts` (1165), `Hazards.ts` (842), `ItemBox.ts` (732),
`ItemRoulette.ts` (374)

`ItemSystem` is the facade; all four collaborators are narrow structural
interfaces with feature detection. Its `fixedUpdate` runs at 120 Hz:
collect boxes → advance roulettes → tick status → update orbits → projectiles →
star contacts → hazards → boxes.

Input contract with `RaceDirector`: `requestHold(kartId, down)` — a tap uses on
release, a long press (≥0.16 s) enters shield/drop mode.

**Five live items** (`LIVE_ITEMS` in `ItemRoulette.ts`): Plastic Bottle
(banana), Battery (boost), Rocket (red shell), Ninja (ghost), Star. The other
eleven `ItemType` members have weight zero in every row of the position-weighted
table and cannot come out of a box, though `grantItem()` and `use()` still
handle them.

Status effects live here, not in physics: `STAR_TIME 7.5`, `BULLET_TIME 7.0`,
`GHOST_TIME 6.0`.

`Hazards.ts` owns non-item track hazards. The `'oil'` kind still exists but is
**placed on no circuit** — removed at the owner's request; see
[`DECISIONS.md`](DECISIONS.md).

**Change X → look here:** drop rates → the `ItemRoulette.ts` table. Flight
behaviour → `Projectiles.ts`. How using an item is triggered →
`ItemSystem.requestHold`/`use`. Box placement → `ItemBox.ts`. Item art and the
HUD icon atlas → `ItemModels.ts`.

---

## 6. Race director and race state

**Files:** `src/game/RaceDirector.ts` (1353), `RaceState.ts` (347),
`Standings.ts` (143)

`RaceState.ts` is deliberately dumb — it holds `phase`
(`idle | intro | countdown | racing | finished | results | paused`), clocks,
finish order, and one `LapTracker` per kart. **The transitions live in
`RaceDirector`.**

**`LapTracker` is the lap-counting core**, split out on the stated grounds that
lap counting is where racing games quietly break. The ±0.5 delta rule on
normalised progress detects a crossing; `DEFAULT_CHECKPOINTS = 8` and
`CHECKPOINT_FRACTION = 0.75` mean a crossing only counts with ≥75 % of
in-order checkpoints, and a failed crossing deliberately does **not** reset
them. Reversing over the line gives the lap back. `projectFinish()` derives a
non-finisher's total from *its own* mean lap time — the fix for the "every NPC
has the same time" symptom, which came from stamping everyone with one clock.

`RaceDirector` constructor takes `(karts, track, input)`; **everything else
arrives via optional setters and is only ever feature-probed.** `RACE_TUNING` at
the top of the file holds the whole flow: intro 6.2 s, countdown 3.6 s, rocket
window 0.35 s, burnout threshold 0.45, finish grace 16 s, results delay 2.4 s,
wrong-way 1.1 s.

Live standings are an in-place **insertion sort** of a reused array — finished
beats unfinished, then finishing position/time, then `progress = lap + t`, ties
by id. Allocation-free.

Finished karts get `autopilot()` — pure pursuit on `track.racingLineAt`.

`Standings.ts` is Grand Prix: `GP_POINTS = [15,12,10,9,8,7,6,5,4,3,2,1]`,
`CUP_RACES = 4`, MK8's tie-break order.

**Change X → look here:** phase transitions, countdown, rocket start, DNF →
`RaceDirector.ts`. Lap validity rules → `RaceState.LapTracker`. Who is 1st →
`RaceDirector.updateRanking`/`better`. Cup points → `Standings.ts`.

---

## 7. AI

**Directory:** `src/ai/` — `AIDriver.ts` (2750), `RacingLine.ts` (1301),
`AIManager.ts` (1208), `AIPersonality.ts` (834), `Rubberband.ts` (379)

`AIManager` owns the line, the drivers, and the rubber-band. Collaborators are
typed `object` and resolved once by `resolve*()` probes, cached, so the per-tick
path does no reflection.

`AIDriver` runs five loops per tick: perception → tactics (line variant
`optimal | inside | outside | shortcut`, lateral bias for avoidance and
blocking) → steering (pure pursuit at a 0.55 s lookahead clamped 6–28 m, plus PD
on lateral error, then a low-pass) → speed (PI with anti-windup against the
line's speed profile) → drift and items. Zero allocation per tick.

> `setChassis()` feeds the kart's real `turnRate` into the yaw-authority
> divisor. Its header records at length that a wrong divisor was the cause of
> "the AI repeatedly crashes into walls at turns". If AI cornering regresses,
> check this first.

`RacingLine` builds ~600 stations by minimum-curvature relaxation, done
multigrid-style (coarse strides 64/32/16… then fine), then a speed-weighted
refinement; the speed profile is `v = sqrt(a_lat · r)` followed by a backward
braking pass and a forward acceleration pass. Flat `Float64Array` storage; every
query writes into a caller-owned out object.

**`Rubberband`'s stated principle is "modulate risk, not speed"** — speed
multipliers are hard-clamped to 0.94–1.05. Catch-up shows up as willingness to
take a riskier line, not as a speed cheat.

`AIPersonality` holds eight personalities plus a per-race `DriverForm` assigned
as an **even pace ladder** rather than independent draws. Its header records a
real bug worth remembering: mistake events had never once fired, because the
Bernoulli sample was drawn from smooth noise (minimum 0.147 over 36 000 samples)
instead of a uniform.

**Change X → look here:** difficulty → `Rubberband.CC_PROFILES` +
`AIManager.setDifficulty`. Where the AI drives → `RacingLine.ts`. How it drives
→ the `STEER`/speed/drift blocks in `AIDriver.ts`. Who the rivals are →
`AIPersonality.PERSONALITIES`.

---

## 8. Track

**Directory:** `src/track/` — `TrackBuilder.ts` (2233), `CityDefs.ts` (1931),
`TrackSpline.ts` (1033), `TrackDefs.ts` (984), `RoadMaterial.ts` (940),
`Track.ts` (883), `Decals.ts` (869), `Checkpoints.ts` (311)

### The eight circuits

| id | Name | Theme | Defined in |
|---|---|---|---|
| `sunsetCoastline` | Sunset Coastline | coastal | `TrackDefs.ts` |
| `neonMetropolis` | Neon Metropolis | city | `TrackDefs.ts` |
| `volcanoRush` | Volcano Rush | volcano | `TrackDefs.ts` |
| `bostonHarbor` | Boston Harbor | city | `CityDefs.ts` |
| `taipeiCircuit` | Taipei Circuit | city | `CityDefs.ts` |
| `tokyoNeon` | Tokyo Neon | city | `CityDefs.ts` |
| `hongKongHarbour` | Hong Kong Harbour | city | `CityDefs.ts` |
| `newYorkCircuit` | New York Circuit | city | `CityDefs.ts` |

`TRACK_ORDER` = the three originals then `...CITY_TRACK_ORDER`.
`DEFAULT_TRACK = 'sunsetCoastline'`.

> **`getTrackDef(id)` falls back silently to the default on an unknown id.**
> This has caused real bugs — it is precisely why `src/ui/Catalogue.ts` exists.
> A new circuit must be added to `CITY_TRACK_ORDER`/`TRACK_ORDER` or it will
> simply never appear, with no error.

### How a circuit becomes geometry

- **`TrackSpline.ts`** — closed centripetal Catmull-Rom (α = 0.5) with
  arc-length reparameterisation (≥2048-entry LUT, ~0.5 m spacing),
  rotation-minimising frames with periodic-twist correction, and O(1) projection
  via a chamfer-propagated XZ bucket grid (4 seeds per cell, so stacked road
  resolves in 3-D) plus damped Newton.
- **`TrackBuilder.ts`** — **one cross-section function, `surfaceHeight()`,
  drives both the visual mesh and the physics ground probe**, so geometry and
  collision structurally cannot disagree. Crown camber, genuine 3-D kerbs with
  an analytic rumble sawtooth, smoothstep shoulder falloff, adaptive
  tessellation from ~1.7 m on straights to 0.4 m in a hairpin.
- **`Track.ts`** — the `ITrackService` facade. Everyone else depends on the
  interface, never on a mesh.
- **`RoadMaterial.ts`** — world-scale UV0 for tiling, track-space UV1 (u across,
  v along the lap) for non-tiling decals, and a baked per-vertex mask carrying
  tyre polish on the ideal line, standing water, and kerb/paint.
- **`Decals.ts`** (track) — a 512×4096 track-space stain atlas sampled through
  UV1, plus crisp quads merged into one geometry, one atlas, one draw call.
  **Distinct from `src/vfx/Decals.ts`**, which is the dynamic skid-mark layer.
- **`Checkpoints.ts`** — ~40 invisible ordered planes for lap validation and
  anti-skip, plus the grid and respawn table.

**Change X → look here:** add or edit a circuit → `TrackDefs.ts` or
`CityDefs.ts`, and remember the order array. Road feel, kerb height, camber →
`TrackBuilder.surfaceHeight()` — **this changes visuals and physics
simultaneously, by design.** Lap counting geometry → `Checkpoints.ts`.

---

## 9. Karts, camera, audio

### Karts

**Directory:** `src/karts/` — `Driver.ts` (4059), `KartBodies.ts` (2329),
`KartMaterials.ts` (2310), `KartManager.ts` (1221), `Portrait.ts` (1129),
`KartModel.ts` (820), `Wheels.ts` (561), `Characters.ts` (278)

`KartManager` **creates the `KartState` objects** that `PhysicsWorld.setKarts`
then adopts — this is the authoritative record everything else reads.

The division of labour is strict and worth memorising:

- `fixedUpdate` **only** snapshots `prevPos/curPos`, `prevQuat/curQuat`, steer,
  and per-wheel suspension and spin.
- `update` is **visual only** and does the interpolation:
  `lerpVectors(prev, cur, alpha)` and `slerpQuaternions(..., alpha)`. This is
  the sole consumer of the Engine's interpolation alpha.

`assignLods` is a four-guard stable LOD selector (temporally smoothed distance,
sticky rank sort, ±14 % threshold band, minimum dwell). Measured in-source: 12
karts all at LOD 0 costs 375 draw calls / 0.291 M tris against 92 / 0.164 M with
the shipped tiers.

`Characters.ts` holds the roster of ten; ids must match `CHARACTER_STATS` in
`src/physics/Tuning.ts`, where the balance actually lives.

### Camera

**Directory:** `src/camera/` — `ChaseCamera.ts` (960), `CinematicCamera.ts`
(573), `CameraRig.ts` (525)

The central idea, stated first in the header: **camera yaw follows the kart's
velocity direction, not its facing.** That is why drifts read.

`ChaseCamera` decides where the camera wants to be; `CameraRig` is the mechanism
(springs with carried velocity, shake, final pose commit) and allocates nothing
after construction; `CinematicCamera` owns authored shots. `CINEMATIC_TUNING.introSeconds`
and `RACE_TUNING.introSeconds` are both 6.2 and must stay in step.

### Audio

**Directory:** `src/audio/` — `SfxBank.ts` (1842), `AudioEngine.ts` (1321),
`Synth.ts` (1145), `Music.ts` (1038), `EngineSound.ts` (1038), `Reverb.ts` (627)

`AudioEngine` takes only the camera in its constructor — it needs nothing else
because **it listens to the event bus** (~27 handlers). Every sound is
synthesised and baked to an `AudioBuffer` at init; nothing is loaded (rule 3).
Reverb impulse responses are procedurally synthesised too.

Signal flow: sources → preSum → submerge → duck → masterVol → glue compressor →
limiter → analyser → destination. The two dynamics stages are described as
non-optional.

`init()` is failure-tolerant by design: events are wired first and
unconditionally, a failed context means "running silent", and baking is wrapped
in a 15 s timeout. Autoplay policy is handled by creating the context suspended,
baking anyway (`OfflineAudioContext` needs no gesture), and resuming on the
first pointer or key press.

**Change X → look here:** kart look → `KartModel.ts` for the hierarchy, then
`KartBodies.ts`/`Wheels.ts`/`Driver.ts`. Animation and LOD →
`KartManager.animate`/`assignLods`. Camera feel → `ChaseCamera.buildChaseTargets`
+ `CameraRig` springs. A new sound → `SfxBank.ts` plus a `bus.on(...)` in
`AudioEngine.subscribe`.

---

## 10. Render pipeline

**Directory:** `src/render/` — `RenderPipeline.ts` (2342), `TextureFactory.ts`
(2210), `PostQA.ts` (1674), `effects/GradeEffect.ts` (968),
`MaterialFactory.ts` (641), `effects/MotionBlurEffect.ts` (349),
`effects/SubjectMask.ts` (219)

The `WebGLRenderer` is built in `src/core/Engine.ts`, not here (§3).

### Pass order

```
1  RenderPass                        scene → HDR half-float
2  NormalPass  (0.5 scale)           only when quality.ssao
3  SSAOEffect
4  DepthOfFieldEffect                boost only
5  MotionBlurEffect                  custom
6  EffectPass(bloom, grade, vignette)   merged
7  ChromaticAberrationEffect
8  SMAAEffect                        always terminal
```

Composer: `HalfFloatType`, depth buffer on, `multisampling: 0`.

An adaptive **post pixel budget** of 1920×1080 with 0.12 hysteresis and a 2.5 s
settle progressively drops NormalPass, water reflections, DoF + CA, and finally
motion blur as cost rises.

### Tone mapping — two things, and the distinction matters

1. `Engine.ts` sets `THREE.AgXToneMapping` at exposure 1.0. Its comment states
   this **only takes effect on the no-post fallback path**.
2. **The real shipping tone map is owned by `GradeEffect`**, which implements
   AgX itself in GLSL. The default preset is `agx-punchy` — AgX sigmoid *plus*
   the Blender-style look transform that three's implementation omits. Two
   stated reasons: three's AgX lands bright scenes as flat milky grey, and its
   chunk reads `toneMappingExposure` only on `refreshMaterial`, so exposure
   changes did not reliably reach the shader.

Full grade chain: exposure → tone map (+look) → black/white point → lift/gamma/gain
→ pivot S-curve → saturation + vibrance → 32³ 3-D LUT → flash → shake.

### The texture library

`TextureFactory.ts` is the shared surface library — "every material in the game
comes from here". Everything is periodic noise plus canvas 2-D. It packs ORM
into one RGBA texture (r = AO, g = roughness, b = metalness, glTF convention)
and hands the same object back for all three map slots. Results are cached by
`(name, size, variant)`.

`MaterialFactory.ts` turns a `PbrSet` into a shader-injected
`MeshStandardMaterial` via `onBeforeCompile` with a stable
`customProgramCacheKey`, and provides reoriented-normal-mapping detail blending,
triplanar mapping, and packed-ORM sampling.

> `src/world/WorldTextures.ts` (2478 lines) is a **parallel, duplicate**
> procedural texture library for the world modules. Its own header says it
> predates `TextureFactory` and should be de-duplicated at integration time.
> That has not happened.

**Caveat on the numbers in `RenderPipeline.ts`'s header:** it contains an
extensive measured cost table sourced to probe scripts, and the header itself
disclaims some figures as unmeasured extrapolations. Treat them as
"documented in-source", not as independently verified.

**Change X → look here:** pass order or adaptive quality →
`RenderPipeline.build()` and `chooseBudget()`. Image look → `GradeEffect.ts`
presets. A new procedural surface → `TextureFactory.ts`, then shader injection
in `MaterialFactory.ts`.

---

## 11. Lighting and shadows

**File:** `src/world/Lighting.ts` (1739) — note it lives in `world/`, not
`render/`.

three has no CSM, so `patchCsmChunks()` rewrites three's directional-light
shader block so exactly one cascade contributes per fragment, cross-faded.
`cascadeCount` is clamped 1–3; each cascade is a `DirectionalLight` named
`KeyCascade0..2`; only cascade 0 keeps `shadow.autoUpdate`.

### The 1 / 2 / 4 phased cadence — do not change this casually

```ts
const intervalFor = (i) => (i === 0 ? 1 : i === 1 ? 2 : 4);
const phaseFor    = (i) => (i === 1 ? 1 : i === 2 ? 2 : 0);
```

The cadence used to be 1/2/3 with no phase. Because `due` tests
`frame % interval === 0`, cascades 1 and 2 both came due whenever
`frame % 6 === 0` — rasterising all three cascades (3 × 2048² = 12.6 Mpx) on
that frame. With 1/2/4 at offsets 0/1/2 the due sets are disjoint, the worst
frame is two cascades, and the amortised rate *falls* to 1 + ½ + ¼ = **1.75**.

### The warm-up, and the bug it fixes

`fitCascades()` runs from inside the shadow hook — after anything that asked for
a warm-up render and before the depth pass — so its `needsUpdate = false` was
the last word. The due test now begins with `c.light.shadow.map === null`, and
`RenderPipeline.warmShadowMaps()` renders one throwaway frame into a 1×1 target
to force allocation. Full causal account in
[`../PROJECT_STATE.md` §3.1](../PROJECT_STATE.md) and
[`DECISIONS.md`](DECISIONS.md).

`Lighting.ts` also installs global height fog by patching three's fog chunks,
manages a pooled set of local emitters, and exports `SHADOW_LAYER` — the
per-cascade visibility-mask convention.

**Change X → look here:** shadow quality, shimmer, acne → `fitCascades()` and
the cascade builder. A black or GL-error-flooded frame at boot →
`RenderPipeline.warmShadowMaps()` and `verifyShadowBinds()`.

---

## 12. World

**Directory:** `src/world/` — `Props.ts` (12 025 — the largest file in the
repo), `WorldTextures.ts` (2478), `Foliage.ts` (1719), `Lighting.ts` (1739),
`Water.ts` (1309), `Sky.ts` (1297), `Environment.ts` (1167), `Terrain.ts` (966),
`Weather.ts` (898), `Crowd.ts` (805)

`Environment.ts` is the facade `Game` builds. It owns and sequences
`TerrainField` → `Terrain` → `Water` → `Foliage` → `Props` → `Crowd` →
`Weather`. It consumes `Track` **defensively** (`typeof` feature detection,
range checks) and **never throws out of `init()`** — a broken layer degrades to
"missing" rather than taking the game down.

The recurring performance pattern across all of these is the same: **one draw
call, animation in the vertex shader, zero CPU per frame.**

- **`Props.ts`** — everything man-made. Nothing is a `Mesh`: each prop type is
  merged once into a single vertex-coloured geometry, then drawn as one
  `InstancedMesh` across ~8 shared materials — roughly 30 draw calls for a full
  city dress instead of ~3000. Cloth sway, balloon bob, neon flicker and
  per-window lit/unlit are all vertex-shader from a per-instance phase;
  `update()` writes four uniforms and allocates nothing. Distance culling is
  per-instance in the vertex shader.
- **`Terrain.ts`** — one draw call out to 900 m: a single radially-warped
  camera-following grid reading Y from a baked float height texture that
  **already has the road corridor blended in**, so terrain cannot gap against
  the road.
- **`Foliage.ts`** — grass as three camera-following instanced rings reading
  ground height in the vertex shader; six procedural tree species with a
  cross-faded billboard imposter atlas baked at init.
- **`Sky.ts`** — analytic Preetham/Rayleigh-Mie atmosphere, parallaxed clouds,
  star field, normal-mapped moon. Renders itself to a cube target and runs
  `PMREMGenerator` to produce `scene.environment`.
- **`Water.ts`** — one camera-following radial disc: 5-wave Gerstner with
  analytic normals, per-fragment depth from the terrain height texture,
  advancing foam line, planar reflections on high/ultra.
- **`Weather.ts`** — rain/snow/ash/leaves/heat shimmer, entirely vertex-shader.
  Rain also overrides road roughness, storing and restoring the originals.
- **`Crowd.ts`** — one `InstancedMesh`, up to 2000 spectators, zero CPU per
  frame, including an arc-length-travelling Mexican wave.

**Change X → look here:** a new scenery object → `Props.ts` (respect the
`Builder`/instancing contract). Terrain shape or splat blending → `Terrain.ts` +
`TerrainField` in `WorldTextures.ts`. Sky or environment lighting → `Sky.ts`.

---

## 13. VFX

**Directory:** `src/vfx/` — `ImpactEffects.ts` (1168), `ParticleSystem.ts`
(1006), `VfxManager.ts` (993), `BoostFlame.ts` (689), `sprites/Painters.ts`
(522), `DriftSparks.ts` (522), `Trails.ts` (493), `Decals.ts` (433),
`sprites/Atlas.ts` (393), `SpeedLines.ts` (358), `SurfaceParticles.ts` (347),
`sprites/Noise.ts` (86)

`VfxManager` is the single facade; it owns the sprite atlas, LUTs, particle
engine and every effect module, and subscribes to the event bus. Kart access is
structural. Stated budget: particles 2 draw calls, flames 1, trails 1, decals 1,
overlay 1.

**`ParticleSystem` does zero per-frame CPU simulation.** Each particle stores
spawn state once and the vertex shader evaluates the closed-form
ballistic-with-linear-drag solution, plus an optional single closed-form ground
bounce and curl-noise turbulence.

`DriftSparks` has four escalating states — Charging → Blue → Orange → Purple —
each with a distinct read, and every tier-up fires a ring shockwave.

`ImpactEffects`'s stated rule is **layering**: an explosion is eight layers
(flash, core, pressure shell, two ground rings, debris, embers, smoke column,
scorch decal).

`SurfaceParticles` is driven entirely by `SURFACES[surface].particle` in Config,
so a new surface type gets the right spray with no changes here.

`sprites/Painters.ts` authors every sprite as **white RGB with all detail in
alpha**, and alpha must never reach the sprite boundary at full opacity.

**Change X → look here:** a new effect or event → `VfxManager.ts` (bus
subscriptions and the `burst` id table). Particle motion → `ParticleSystem.ts`.
Sprite artwork → `sprites/Painters.ts`, then register the cell in
`sprites/Atlas.ts`.

---

## 14. UI, menus, and touch

**Directory:** `src/ui/` — `ui.css` (2853), `Widgets.ts` (1990), `HUD.ts`
(1980), `MenuSystem.ts` (1616), `TouchControls.ts` (1312), `Catalogue.ts` (707),
`Minimap.ts` (563), `Results.ts` (300), `Fonts.ts` (171), `Prefs.ts` (88)

DOM and CSS over the WebGL canvas, with canvas 2-D only for the minimap and the
radial speedometer. Host subsystems are typed **structurally** — `Widgets.ts`
declares the minimum shape it reads — so the UI never imports `KartManager`,
`RaceDirector` or `Track` and cannot hard-fail the build.

`MenuSystem` runs Title → Main → Character → Kart → Track → CC → race, plus
Options, Controls, Pause and Results, with one focus model serving keyboard,
polled gamepad and mouse.

> **`Catalogue.ts` exists because of a real bug.** It derives all roster,
> chassis and circuit data from the real tables. The previous hardcoded copy
> caused 6 of 8 racers to drive as Nova and every course card to load Sunset
> Coastline, because **every id lookup falls back silently**. Never retype an id
> into the UI.

`HUD.ts`'s performance contract: every value cached, DOM touched only on change,
only `transform`/`opacity`/`filter` animated, one-shot punches via the Web
Animations API. `hud.costMs` reports measured cost against a 0.4 ms budget.

`Fonts.ts` downloads nothing — system stack plus a two-span chunky numeral.
Importing it pulls in `ui.css`, which is how the stylesheet is guaranteed
present exactly once.

### Touch controls

`TouchControls.ts` defines three styles:

```ts
export type TouchControlStyle = 'swipe' | 'joystick' | 'dpad';
```

| Style | Behaviour |
|---|---|
| **SWIPE** (default) | Draws no steering control. A gesture may begin anywhere that is not an action control, and **that touchdown point is its origin**. Only `clientX` *differences* ever reach the maths — no `getBoundingClientRect`, no screen fraction — which is exactly why it behaves identically in portrait and landscape. 110 px to full lock, 8 px dead zone, curve 1.7 |
| **JOYSTICK** | The floating stick. The pad is much larger than the drawn stick and it re-centres to wherever the thumb lands; `setPointerCapture` on touchdown so dragging off-pad keeps steering. Full lock at 76 px |
| **D-PAD** | Two arrows whose hold **ramps** toward lock rather than snapping (2.2/s out, 6.0/s back, 6.0/s across centre) |

All three write only `virtualController.steer` and share the same DRIFT / ITEM /
BRAKE cluster and pointer-ownership rules.

**The default `'swipe'` is written in two field initialisers that must agree** —
`TouchControls.ts:456` and `MenuSystem.ts:197`. The constructor's
`readChoice(PREF_KEYS.controlStyle, TOUCH_CONTROL_STYLES, this.controlStyle)`
inherits the `MenuSystem` one as its fallback rather than restating it, so
changing the default means changing both initialisers and nothing else.

Two design points that are easy to break:

- **Up/Down arrows are deliberately absent from the D-Pad.** Throttle is
  automatic while racing; the countdown's launch control is DRIFT because
  `RaceDirector` times the rocket start from when the hold *begins*; and BRAKE
  already owns zeroing accel so `KartPhysics` can reverse. An Up arrow would be
  a second, conflicting throttle.
- **Auto-throttle waits for the green light**, so a touch player is not handed
  an automatic burnout penalty.

`touchIsPrimary()` uses `(pointer: coarse) && (hover: none)`, deliberately not
width, and is corrected reversibly: a genuine touch `pointerdown` turns controls
on, a key or mouse press turns them off. So a touchscreen laptop shows nothing
until a real finger arrives.

`applyStyle()` uses `display: none`, not `opacity: 0`, so hidden controls leave
the hit test.

### Preferences

`Prefs.ts` — namespace `fk.v1.`, exactly three persisted keys:
`touch.controlStyle`, `touch.layout`, `touch.steerSensitivity`. `readChoice`
validates every read against the values *this build* understands, so a stale
entry cannot select a mode with no code behind it. Every `localStorage` access
is wrapped, because Safari Lockdown and private mode throw on the property
access itself. Reads happen in the `MenuSystem` constructor **before** `build()`
so a player who chose D-PAD never sees one frame of joystick.

Quality, volumes and FOV are deliberately **not** persisted.

### Layout scaling

The UI scale factor `--u` derives from the render **container**, not the window,
with a `--u-min` legibility floor. **The in-race HUD is exempt from that floor**
(`--u-min: 0` on `.ak-hud`) and the menus carry it — a measured decision, see
[`DECISIONS.md`](DECISIONS.md). `ui.css` explicitly forbids answering a layout
problem with a window-keyed media query.

`viewport-fit=cover` plus `env(safe-area-inset-*)` on every edge-anchored
element keeps UI out from under a notch. **If you add a new edge-anchored
element, add the inset too.**

**Change X → look here:** touch feel → the `SWIPE_STEER`/`TOUCH_STEER`/`DPAD_STEER`
blocks in `TouchControls.ts`. A new persisted setting → `Prefs.ts` `PREF_KEYS`
plus one `readChoice`/`writeChoice` pair. Menu content → `Catalogue.ts`. Layout
scaling → `--u`/`--u-min` at the top of `ui.css`.

---

## 15. QA hooks — what ships and what does not

**This is the single easiest thing in the codebase to state wrongly.** There are
three tiers, and only two are dev-only.

| Global | Installed at | In production? |
|---|---|---|
| `__GAME__` | `src/main.ts:43`, **unguarded** | **Yes — it ships** |
| `__QA__` | `src/qa/CaptureHarness.ts`, via `if (import.meta.env.DEV)` in `src/main.ts` | No |
| `__POST__` | `src/render/PostQA.ts`, via `if (import.meta.env.DEV)` in `src/render/RenderPipeline.ts` | No |
| `__UIQA__`, `__PHYS__`, `__CAM__`, `__WORLD__`, `__KARTS__`, `__ITEMS__`, `__VFX__`, `__TRACK__`, `__AUDIO__`, `__LAB__` | `src/dev/*` harness pages | No |

The gating mechanism: Vite statically replaces `import.meta.env.DEV` with
`false`, the `if (false)` block is dropped, and because the only reference to
each module is a **dynamic** `import()` inside that block, the whole module is
tree-shaken — no separate chunk is even emitted.

`Directly verified:` in the current `dist/assets/*.js`, `__QA__`, `__POST__`,
`installCaptureHarness`, `installPostQA`, `validateShots` and `src/dev` all have
**zero** occurrences; `__GAME__` has **one**, in `dist/assets/index-*.js`.

`__GAME__` in production exposes the whole live `Game` object on `window`.
Whether that is intended is not stated in the code — the trailing comment only
says "for the debug console + automated QA". Nothing in the shipped app reads
it. Full surfaces are documented in [`QA.md`](QA.md).

---

## 16. `src/dev/` — harnesses, not build inputs

25 files. Ten `.html` + `.ts` pairs (ui, camera, items, audio, vfx, karts,
world, physics, textures, track), plus the headless tooling.

**Three independent confirmations that none of it ships:**

1. No file outside `src/dev/` imports `@/dev` or `./dev` — only six comments
   mention them.
2. `vite.config.ts` sets no `build.rollupOptions.input`, so the only HTML entry
   is the root `index.html`. Each `src/dev/*.html` is reachable only through the
   dev server, e.g. `http://localhost:5173/src/dev/vfx.html`.
3. Empirically: zero occurrences of any dev global in the built bundles.

The headless side:

- **`node-run.mjs`** — runs any `src/**` TypeScript module under plain Node, no
  browser, no bundler, no dev server. Its header records why it exists: three
  shipped mechanics (gliders, anti-gravity, ramp tricks) were authored, wired,
  and had **never once run** — and a mechanic that never fires renders
  identically to one that does not exist.
- **`headless.ts`** — shared bootstrap returning the *real* `Track` and physics.
- **`physics-tests.ts` / `physics-run.ts`** — the DOM-free assertion battery,
  including `TestTrack`, a complete analytic `ITrackService`.
- **`trackqa.ts`** — explicitly marked TEMPORARY; its header says to delete it
  when the track defects are closed.

Usage is in [`QA.md`](QA.md).

---

## 17. Page metadata and `public/`

`index.html` carries the web identity: title, description, canonical, robots,
Open Graph and Twitter card, and JSON-LD `VideoGame`.

`public/` holds only page-level presentation and discovery assets: `favicon.ico`
(16+32+48, PNG payloads), `favicon-16x16.png`, `favicon-32x32.png`,
`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest`,
`robots.txt`, `sitemap.xml`, plus the masters under `brand/` and `og/`.

**Two URL styles coexist here on purpose.** Icon and manifest hrefs are
**relative** (`./favicon.ico`) so they survive `base: './'` at any subpath;
canonical, `og:url` and the image URLs are **absolute**, because a crawler
resolves them out of context. Do not "fix" either to match the other — see
[`DECISIONS.md`](DECISIONS.md).

The social card is **1731×909** and declares exactly those dimensions. The icon
master is **1254×1254** despite being named `...-1024.png`.

`site.webmanifest` declares no `orientation` key — no orientation lock, because
portrait is supported.

**No gameplay code reads any of this.** See
[`../PROJECT_STATE.md` §2](../PROJECT_STATE.md).
