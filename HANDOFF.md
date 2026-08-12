# FOXY KART — open items handoff

---

## 🔴 P0e — FOURTH PLAYTEST: what is still open after `cd390f5`

### Fixed and verified in `cd390f5`
Kart deformation (the squash spring was unstable above 78.67 ms/frame while
`Engine.MAX_FRAME_DT` is 100 ms — one slow frame detonated it to 1.47e6, which is
why "lag" and "deforming" were the same bug); item icons un-crossed; battery boost
1.30× → 1.61× a mini-turbo; volcano fog density 0.00240 → 0.00145 (the darkness was
fog, not the key — `volcanic` keyI 2.90 is *stronger* than `night`'s 1.75); tunnel
bore interiors ~5× brighter with a portal reveal lamp; coins removed; kart LOD-0
total 305,830 → 283,368 tris, under the §5b ceiling for the first time.

### 🔴 Still open, highest value first

**E1 — The volcano tunnel portal is buried 4.48 m.** At `t=0.805`: road y 5.88,
ground y 10.36, portal seated at road level, so the bore mouth is cut into rising
ground and the portal structure sits inside the hillside. The `t=0.865` portal is
fine (−0.18 m). Measured but not fixed. **Most visible remaining item.**

**E2 — Portraits are unverified AND the probe for them crashes.**
`.probe-tmp/bust-eye.ts` dies on `sheet.width = S * COLS` — "Cannot set properties
of null", because the headless shim returns no canvas. This is structural, not
accidental: a fake renderer cannot rasterise, so **the only way to know a portrait
has pixels is to look at it.** Everything the portrait agent changed is committed
and unproven. Owner's report was that all ten cards render blank.

**E3 — Half-buried spectators near the start line.** Found while hunting the
owner's "half-buried item boxes": `Crowd` figures at −2.02, −2.00, −1.88, −1.12,
−1.10 m and `authored:basaltcolumn` at −1.05, −0.90 m. Rocks at −4.09/−3.04/−2.30 m
bed by design. Nobody has fixed the crowd.

**E4 — The "half-buried item box" is NOT an item box.** Third independent
confirmation: no item box appears in the buried-object sweep at the start line;
clearance measures 1.70 m at rest and 0.28 m at the bob animation's lowest point on
both spawn paths, all three circuits; and the nearest authored row is 154 m from the
finish line. Previous two reports of this turned out to be a marshal's booth and
then nothing. **Ask the owner where exactly it sits relative to the start banner
before spending more measurement on it** — likely candidates are now the buried
crowd (E3) or the boost-pad decals, which sit flat on the tarmac.

**E5 — Perf beyond the spring.** Two leads measured and still unactioned: single
frame is ~**3.15× the scene-graph triangle count** (505 calls / 2.92 M tris on neon)
which `AGENTS.md` §5b says means too many full-scene passes; and the
`GL_INVALID_OPERATION: Mismatch between texture format and sampler type` flood
(`HANDOFF.md` item 2) still reproduces every boot — per-draw validation failures
make Chrome's command decoder crawl. Prime suspect remains the `DepthTexture` bound
to a plain `sampler2D` around `VfxManager.ts:516`. Also unexplained: a
**picture-in-picture inset rendering a copy of the scene** bottom-right in one
owner screenshot.

**E6 — Boot screen.** Owner judged the hand-authored SVG busts "almost
unbearable" and reported hairline artifacts across the logotype. Removal is
explicitly acceptable to them ("if you can't remove the character directly, that's
also a decent option"); a static image is not available under rule 3. State in
`cd390f5` is unverified.

### Owner's wishlist — after the above

**E7 — Trackside billboards for the owner's brands.** "CAPY LAB" and "TINY TRIP
CLUB", replacing some APEX/SLIP cells, **sparse not dense**. The sponsor atlas is a
4×2 procedural canvas in `Props.ts` with 2:1 cells; "TINY TRIP CLUB" is far longer
than the existing one-word brands and needs a layout that fits. **Read the §0b `u`-axis
conclusion in this file first and do not "fix" the plate UVs.**

**E8 — A city series: Boston, Taipei, Tokyo.** Creative freedom on layout, but each
must carry recognisable landmark buildings. This is a content feature, not a fix:
three splines in `TrackDefs.ts`, three theme builders in `Props.ts`, and landmark
geometry authored procedurally (rule 3 — no models). Scope it as its own milestone;
the owner explicitly placed it after the defects above.

---

## 🔴 P0d — THIRD HUMAN PLAYTEST + DESIGN DIRECTION (current priority)

Owner's own words, translated into defects and scoped work. **Nothing in this
section has been started.** Two agents were killed mid-task by a session limit
immediately after this was filed.

The through-line, again: **too punishing, too cluttered, too hard to read.** When
in doubt, choose forgiving and legible. This is the third playtest to say so.

### D1 — Obstacles are still too punishing. Owner: `src/items/Hazards.ts`

> *"When two boulders move across the path simultaneously — firstly, the speed is
> still relatively fast; secondly, if they overlap in the same location, the
> player keeps getting hit and cannot move."*

A stun-lock. Two hazards occupying the same span re-hit on every recovery, so the
player is pinned with no input authority. Two acceptable fixes, and the owner
would take either:

1. **One boulder per span, not two** — and slower again. P0b-3 already cut speeds
   ~35–50 %; that was not enough.
2. **A post-hit forgiveness window.** The owner explicitly accepts being immune
   to *both* obstacles and other players' items during it.

**The machinery for (2) already exists** — `PhysicsWorld.setInvulnerable(kartId,
seconds)` sets `b.invulnTime`, and `KartState.invulnerable` is already published.
So this is wiring plus a duration, not new systems. Check every hazard and item
damage path actually consults it before applying a stun.

> *"I also do not like non-race vehicles suddenly appearing from behind; this type
> can be removed."*

**Remove the `traffic` hazard kind entirely**, not just slow it. It is authored on
neon (`{ kind: 'traffic', t: 0.29, lat: 9, span: 30, speed: 8 }`) and is the one
hazard that arrives from outside the player's field of view, which is why it feels
unfair rather than hard.

### D2 — The AI field is undifferentiated. Owner: `src/ai/*`

> *"Opponents have too similar abilities and are not randomized, which causes a
> player to lose many positions at once if overtaken, and it is too difficult to
> overtake vehicles in front."*

Both halves of that sentence are the same bug: if all twelve karts have near-equal
pace they travel as one block, so a single mistake costs six places and there is
no gap to overtake into. Wants per-racer variation in pace and mistake rate, and
a rubber-band that opens up overtaking lanes rather than closing them.
`src/ai/AIPersonality.ts` and `src/ai/Rubberband.ts` already exist — find out
whether the personalities are actually *applied* or whether this is another
authored-but-never-fires case. Given this project's history, check that first.

### D3 — Item boxes at the start line, STILL reported buried. Owner: `src/items/*`

> *"The item boxes partially embedded in the ground at the starting line still
> appear unresolved."*

**Treat this as unresolved and measure it directly.** Two prior fixes are NOT
this:
- `P0b-2` lifted the `ItemSystem` fallback spawn path to `ITEM_BOX_LIFT`.
- The buried object found in `2e90c88` was `marshalPost`, a *different* object,
  and the visual critic since measured `marshalPost gap = 0.00` on every instance
  of all three circuits.

So this is plausibly a **third** distinct object or path. Measure the real
`getItemBoxSpawns()` positions against the road surface on all three circuits,
including the authored `TrackBuilder` path and not just the fallback, and account
for the box's tumble+bob animation reaching 1.47 m below centre.

### D4 — Rain courses are unreadable. Owner: `src/world/Weather.ts`, `src/world/Lighting.ts`

> *"The scene on rainy courses is difficult to view; it is overall too dark, and
> simulating a wet screen also makes it inconvenient to see."*

**Independently corroborated by the visual critic**, which flagged it unprompted:
*"50+ large soft grey circles across the whole frame plus grey spiral artifacts
near the bottom edge. It reads as a dirty lens, not weather."* So the droplet
overlay is both too heavy and visually wrong.

Note this interacts with the mood fix in `f350e37`: until that commit every
circuit rendered under flat noon `'day'` light, so neon has only just started
rendering at its authored `'night'` preset — **it may now be darker than when the
owner played it.** Re-judge brightness after that change, not before.

> *"Decorative buildings also need to be carefully designed to avoid obstructing
> the track."*

Distinct from the road-volume guard (which handles props *inside* tunnels and
bridges). This is about props that clear the corridor geometrically but still
block sightlines through a corner. Needs a camera-relative test, not a lateral one.

### D5 — Item set: cut the duplication. Owner: `src/items/*`

Deliberate content reduction, *"to facilitate smoother production"*. Collapse
every tiered item to a single tier and re-skin:

| Current | Becomes | Visual | Ability |
|---|---|---|---|
| Red Shell ×1/×3 | **single only** | **Rocket** | homes on the kart ahead |
| Banana ×1/×3 | **single only** | **Plastic Bottle** | small obstacle |
| Mushroom ×1/×3 | **single only** | **Battery** | speed boost |
| Boo | retained | **Ninja** | steals an item from another racer |
| Star | retained | — | **now ignores ALL item attacks and obstacles** |
| Ink | **REMOVED** | — | — |
| Lightning | **REMOVED** | — | — |

Star's new behaviour is a genuine gameplay change, not a re-skin: it must grant
immunity to hazards as well as items, which is the same immunity path D1 needs —
**do D1 and Star together.**

Removing Ink also removes the reason for the `squid`/ink VFX and audio; removing
Lightning removes the `shock` stun kind's only source. Check `ItemRoulette`
weights still sum sanely with four items instead of seven, and that `AIDriver`
does not reference a removed `ItemType`.

### D6 — The leaderboard clips off the top of the screen. Owner: `src/ui/*`

> *"When the rankings are lower, the leaderboard is displayed incompletely, with
> the top portion off the screen."*

Reproduce at 11th/12th specifically — `P0-4` established that this HUD's bugs
show at the *bottom* of the field, and the fix then was to test `11TH`/`12TH`
rather than `1ST`. Likely the rival tracker growing upward from a bottom-anchored
origin without clamping to the viewport.

Related but separate, from the visual critic: menu supporting copy measures
**4.17–5.42 px** at the pane's 1:1 800×450 viewport, because `uiScale()` has a
0.34 floor making `--u = 0.4167px`. `.ak-stats__sub` is now *less* legible than
before its rule was added. Wants a `max(11px, …)` floor on the text classes.

### D7 — An item-free race mode

> *"The gameplay mode could perhaps be set to a version without items."*

`RaceDirector` already carries a `raceMode`; check whether a no-items value
already exists before adding one. Needs a menu entry and must suppress item
boxes, the roulette and AI item use — not merely hide the HUD slot.

### D8 — Loading screen, redesigned around the two characters

Owner supplied reference art for Foxy (fox: mustard beret, round glasses, blue
knit sweater, bushy cream-tipped tail) and Capy (capybara: rust bucket hat,
blue-grey scarf, heavy rounded silhouette) and wants the boot screen built around
them. **Rule 3 still applies — no image files.** Draw it procedurally, or render
the existing 3-D drivers to a canvas.

### D9 — Real portraits for Foxy and Capy on racer select. Owner: `src/karts/*`

Owner wants the select-screen portraits to match the reference art. This is
already a known hard defect: **`KartManager.renderPortrait(id)` does not exist**,
so `MenuSystem` falls through to `characterPortrait()` and the critic confirmed
**all ten portraits are the same grey visor ellipse** with only the tint and a
corner letter differing. Implementing `renderPortrait` fixes the whole roster,
not just the two animals, and is the single highest-value UI change available.

---

## 🔴 P0c — THE PHYSICS BATTERY IS NOT GREEN (9 failing assertions)

`node src/dev/node-run.mjs src/dev/physics-run.ts` → **34 passed / 8 failed**.
The suite now runs headlessly (the WebGL bench split out into `src/dev/physics.ts`;
assertions live in `physics-tests.ts`). Triaged, most-actionable first:

**1. Four wall tests are STALE, not regressed. Owner: `src/dev/physics-tests.ts`**

`30° wall scrub`, `10° graze`, `60° hit` and `steeper hit costs more` all report
`Infinity %`. `hitAt()` detects contact by watching the `wallImpacts` **penalty
counter** — which the new P0b-5 friction model deliberately never increments for
verge contact. So `before` stays `0`, `after` stays `-1`, and the loss formula
divides by zero. Rewrite it to measure **contact** (a `grounded`/contact flag or
a lateral-velocity discontinuity), and guard `before === 0` instead of dividing
by it. Note `one penalty per impact` and `a grind is not re-penalised per tick`
both PASS at `0` penalties, which is the new model working as designed.

**2. `grinding a wall is not a crash` — a real number that needs a decision.**
3 s of leaning on the guardrail at 18 m/s entry retains **14.33 of 27.72 m/s =
51.7 %**; the assertion wants > 60 %. The playtester did ask for friction that
"slows the player down", so a cost is intended — this is a tuning call on *how
much*, not a bug. Pick a target and move the assertion to match it.

**3. ✅ RESPAWN IS FINE IN THE GAME — the bench lies. Root cause found.**

Classified, so nobody else has to panic about it. **Respawn works correctly on
all three shipping circuits**: a kart put 120 m to the side, or 60 m below the
road, gets `isOutOfBounds() === true` and raises `kart:respawn` with
`respawnTime = 0.95` on the **very first step**. The fuzz test independently
logs 3 respawns over 60 s × 12 karts. Nobody is getting stuck.

Two separate bench bugs were making the assertion lie, both now fixed:

- The teleport target was `(0, 8, 0)`, "dead centre of the infield" — the one
  point on an oval where the projection is degenerate (equidistant from both
  straights). `isOutOfBounds` was **true** at the teleport and **false one step
  later**, because the kart was flung from x=0 to x=−40.9 inside the first 8 ms.
- `offset` was read as `G.u` *after* `track.project()`, but `project` leaves `G`
  describing the nearest **centreline** point, where `u ≈ 0` by construction. So
  `offset` was always ~0.01 and `offset < ROAD` was trivially true — it measured
  nothing. `isOutOfBounds()` calls `geoAt` on the position you give it, so asking
  it is both the real question and a correct way to leave `G` on the kart.

`respawn at ~40 % speed` now PASSES. Suite is **34 passed / 8 failed**.

### 🔴 What the fix uncovered — a TestTrack bug that taints other measurements

`out of bounds → respawn` still fails, and now for an understood reason. Even
from `x = R + 80` on a clean straight (`|u| = 80 m`, unambiguous projection, well
past `OOB_LIMIT` 34), the kart is **snapped laterally back to `|u| = 11.8 m`
before `checkBounds` ever runs** — `stepKart` is called before `checkBounds` in
`PhysicsWorld.fixedUpdate`, and something in the TestTrack's road-frame
resolution "corrects" the position first. So the kart is never out of bounds at
the moment the bounds test looks.

This does **not** reproduce on the shipping circuits (which respawn at step 0
from 120 m out), so it is the `TestTrack`'s own `project`/`sampleAt`, not the
physics. **Why it matters beyond this one assertion: every bench measurement
taken far from the centreline is suspect**, which plausibly includes the wall
tests (they drive at the guardrail) and item 4 below. Fix `TestTrack.project`
before trusting any of them.

**4b. The off-road test is broken more deeply than a stale threshold.** Measured
while investigating the above, all on the apron straight:
- A kart at **lat 0** (middle of the road) with full throttle for 4 s settles at
  **14.97 m/s** against a 28.7 m/s cap — so `< 20.7` passes for the wrong reason.
  Nothing in this setup ever gets fast.
- `body.surface` is non-monotonic in lateral offset: lat 12 → Grass, 15 → Grass,
  18 → **Road**, 22 → Grass, 26 → **Road**, 32 → **Road**.
- Every run ends back at `|u| ≈ 12` (i.e. Road) inside an arc, whatever lateral
  offset it started at — the kart does not stay off-road for the measurement.
- Worst signal: from `place(APRON + 5, …)` the kart covers **169 m in 3 s while
  reporting 15.8 m/s**. Displacement and `forwardSpeed` disagree by ~3.7×, which
  is almost certainly the same lateral snap. Start here — it is the clearest
  handle on the TestTrack bug.

Deliberately left failing rather than tuned green: making this assertion pass
without understanding the snap would hide exactly the kind of bug that let three
mechanics ship dead.

**4. `off-road slows you` — classification readback, not grip.**
Grass settles at 15.27 m/s (correctly slow, the cap is 28.7), but the assertion
also requires `grassSurf === SurfaceType.Grass` and `surfaceAt()` reports
**surface id 0** there. Either the probe samples a different position than the
kart occupies, or `surfaceAt` mis-classifies. The speed is right, so this is a
reporting bug — but it is the same *family* as the glider `TF.Gap`/`TF.Glider`
ordering bug, so worth a careful look.

**5. `banked 25°: all wheels planted` — one corner lifts at rest.**
Ride-height band is 5.00 mm and it does not slither or jitter, so this is
cosmetic-adjacent, but a wheel off the ground on a static bank is wrong.

---

## ✅ 22 of 44 AUTHORED PROP TYPES WERE BEING DROPPED — FIXED

**Owner was `src/world/Props.ts`. Done in `3a85e4b`.**

`TrackDefs` authors 44 distinct prop types; `normaliseType()` had aliases for 22
and returned `null` for the other 22, so `collectAuthored()` discarded those
placements behind a single `console.info`. Per circuit, spec entries dropped:

| circuit | dropped | distinct types |
|---|---:|---:|
| coastal | 0/30 | 0 |
| **city** | **17/25** | 14 |
| **volcano** | **14/21** | 9 |

Two of the three circuits were missing ~two thirds of their authored scenery.
**This is most of why Neon Metropolis and Volcano Rush read as bare while the
coastal track looks finished** — coastal lost nothing, so it was never a clue.

Four types now fold into geometry the theme builders already emit, via
`takeAuthored` (skyscraper, neonSign, trafficLight → `buildCity`;
obsidianSpire → `buildVolcano`'s shard cluster) at **zero extra draw calls**.
Anchors must be appended *after* each block's `a.scale` jitter or the authored
scale is overwritten. The other 18 are new `authoredSpec` recipes.

Verified with `.probe-tmp/props.ts` (real `Environment`, all three circuits):
22/22 types produce geometry, every new body has **positive signed volume** (so
none repeats the §0 inside-out bug), and the fold-ins are proven by *position
match* rather than by name — skyscraper 14/14 authored positions present,
neonSign 14/14, trafficLight 1/1, obsidianSpire 18/18. Budget before → after:
city 60→82 scene meshes / 0.35→0.44 M tris, volcano 55→66 / 0.24→0.28 M,
coastal unchanged (control). Ceiling is 120 draw calls / 1.2 M tris.

### Seen on screen — first pass done, art pass still needed

Both circuits were finally looked at in the real game (chase + vista framings,
800×450). **Everything renders, zero console errors, zero WebGL warnings**, and
both circuits go from bare to genuinely populated — the city in particular now
reads as a city, with lit `towerBlock` window grids down both sides and the
folded-in `neonSign` posts blooming at their authored lat-17 positions.

What still wants an art pass, in priority order:

1. **`ashPlume` is the weakest recipe and should be redone.** It reads as a stack
   of dark opaque lumps rather than a column of ash — the 9-puff sphere stack
   with a 0x4a4340→0x9a9088 vertical gradient is too solid and too dark against
   the volcanic sky, and at 1728 tris/instance it is also the most expensive new
   prop. It probably wants soft camera-facing plates with real transparency (or
   to move to `Weather`/VFX entirely) rather than opaque geometry.
2. **Distant towers read as flat dark boxes against a bright sky.** The authored
   `skyscraper` run sits at lat 74, scale 1.6 (≈74 m), and at that distance the
   silhouettes go dark and featureless. The geometry is pre-existing — this
   change only added 14 more anchors to it — but adding them made the problem
   prominent, so it is now worth fixing. Wants rim light, or a paler distance
   tint, or emissive window density that survives at range.
3. `arcologyTower`, `bridgePylon`, `spiralPylon` and `warningPost` were not seen
   close up. Judge them from a driver's eye before trusting them.

**⚠️ Method note for whoever reads counts next — this cost real time.**
`mesh.count` on a prop `InstancedMesh` is **not** the instance total. `emit()`
hands any mesh with `n >= CHUNK_MIN_INSTANCES` to `InstanceChunks`, which
rewrites `count` and the instance attributes **every frame** from camera
position, and passes `!mesh.castShadow` so non-casters (every `glow` / `sign` /
`windows` companion) cull more aggressively than the body they belong to.
Reading `count` mid-frame therefore shows wildly different numbers for the same
anchor set — `Prop:skyscraper` 66 vs `Prop:skyscraperWindows` 28, and
`warningpost:glow` sitting at 0 — none of which is a bug. To count instances,
read `instanceMatrix.count` (the capacity) or count anchors before emit.
- **`bridgePylon` / `spiralPylon` have a documented compromise.** They are
  authored *below* the deck (`up: -12` city flyover, `-22` volcano bridge, `-18`
  spiral) and one geometry cannot reach all three depths — sized to meet the deck
  at −12 it would stand 10 m proud of the road at −22. The shaft's capital sits at
  the anchor and descends 46 m, leaving an intentional gap to the deck underside
  that is invisible from the road but shows in a distant side-on view. A real fix
  needs a per-anchor height query, which `authoredSpec` cannot reach.

---

## 🔴 P0b — SECOND HUMAN PLAYTEST (current priority)

The through-line is explicit and should be treated as a **design direction, not
six separate bugs**: *the game is too punishing and too cluttered.* When in
doubt on anything below, choose forgiving and legible.

### Fixed directly by the integrator (config/numeric, verified by typecheck)

| # | Report | What it actually was |
|---|---|---|
| ~~P0b-1~~ | Items far too dense, "impossible to have a normal race" | **26–31 boxes/lap across 6–7 rows**, respawning every 3 s. Now **3 rows/lap** (11–13 boxes) and `BOX_RESPAWN` 3.0 → **6.0 s**. MK8 uses 2–3 rows. |
| ~~P0b-2~~ | Item box half buried at the start | `ItemSystem`'s **fallback** spawn path lifted boxes only **1.35 m**, but a tumbling+bobbing 1.72 m box reaches **1.47 m** below centre — so it cut ~12 cm through the tarmac. The authored `TrackBuilder` path correctly used 1.70 m; the two disagreed. Now both use the new exported `ITEM_BOX_LIFT`. The fallback also emitted **40 boxes** (8 rows × 5), more than the authored layout — now 2–3 rows × 3. |
| ~~P0b-3~~ | Boulders/obstacles in the middle of the road | Three hazards were authored at **`lat: 0`, dead centre**: a 40 m traffic sweep (coastal), a slider (neon), and an 8 m/s boulder over a 20 m span (volcano — the worst). **Nothing sits on the racing line now**; hazards 14 → 9, speeds down ~35–50 %, spans cut. |
| ~~P0b-4~~ | Fallen leaves too thick, hard to see the track | 620 leaves in a 40×22×40 box at 0.95 opacity. Now **180** in a wider 56×26×56 box at **0.62** opacity, size 0.20 → 0.16. Ambient weather must never compete with the racing line for attention. |

### 🔴 Still open — these need an agent

**P0b-5 — Edge contact should be FRICTION, not a collision. Owner: `src/physics/KartCollision.ts`**

The playtester's own model, and it is a better design than what we have:
> *"Touching the edge of the track should not be considered a collision penalty.
> Perhaps it could instead cause friction and slow the player down. Only when the
> player goes outside the boundary should they need to be pulled back."*

The previous pass made walls *forgiving* (5° graze now retains 97.7 %) but kept
them **collisions**. This asks for a different model entirely:
- **Edge/verge contact** → a continuous friction/drag term while touching. No
  impulse, no yaw kick, no spark-and-scrub event, no discrete penalty at all.
- **Only leaving the playable surface** triggers the recovery/pull-back path.
- Reserve genuine collision response for real solid geometry (barriers, walls,
  buildings), and even there see P0b-6.

**P0b-6 — Buildings should slow you, not penalise you. Owner: `src/physics/*`**
> *"Even outside the tunnel, buildings should perhaps only slow the player down
> when touched; having contact immediately result in a penalty would reduce the
> gameplay experience."*

Introduce a **soft-collider** class: scenery you can scrape along with a drag
cost, distinct from track-boundary walls. Same spirit as P0b-5.

**P0b-7 — Tunnel scene clipping. IMPLEMENTED, NOT YET VERIFIED. Owner: `src/world/Props.ts`**
> *"During the tunnel section, buildings were clipping through the walls and
> appearing inside the tunnel. This creates unnecessary additional obstacles."*

A volume test against tunnel/bridge/anti-gravity segments landed in commit
`4d3f979`, with `insideRoadVolume` / `clearAuthored` and `volumeDrops` /
`volumePushes` counters. It reports live numbers per circuit:

| circuit | pushed clear | instances dropped | volumes |
|---|---:|---:|---:|
| coastal | 13 | 13 | 35 |
| city | 2 | 15 | 76 |
| volcano | 0 | 21 | 129 |

**What is still missing is the verification the item asked for**: nobody has
walked the tunnel arc-length range and tested prop bounding boxes against the
bore interior. The counters prove the guard *fires*, not that it fires in the
right places or catches everything. Do that before closing this.

---

---

## ✅ P0 — HUMAN PLAYTEST REPORT — ALL 7 FIXED

All seven defects from the play session are resolved and measured. Two of them
uncovered **entirely dead mechanics** that no test had ever caught (see "dead
mechanics" below).

A person actually played the build. These are their words, translated into
defects. **Playability beats polish** — a beautiful game that isn't fun to drive
has failed. Do these first.

| # | Defect | Owner |
|---|---|---|
| ~~P0-1~~ | Start-line audience seating is mispositioned and **visually extends onto the road**. **DONE** — `Track.getDecorationHints()` applied the *gate* yaw formula to every authored prop. Clearance violations: coastal 19→0, neon 5→0, volcano 5→0. | `src/world/Props.ts` |
| ~~P0-2~~ | The **start/finish gate** and sometimes a **balloon arch** sit **parallel to the road, running down its middle**, instead of spanning across it. Yaw ~90° out. **DONE** — two opposite conventions, each path using the wrong one. Gate angle off the binormal 90.0°→0.0°. | `src/world/Props.ts` |
| ~~P0-3~~ | An **item box is stuck in the middle of the road** at the start. **DONE** — it was *height*, not lateral position. A tumbling+bobbing 1.72 m box reaches 1.47 m below centre; authored at 1.50 m left 3 cm over the road crown. Now 1.70 m. Spawns also now publish `normal` (was `undefined`, so boxes ignored bank). | `src/track/*` (`getItemBoxSpawns`) |
| ~~P0-4~~ | ~~The **position/ranking plate clips its own text** — the plate edge cuts into the numeral.~~ **DONE** — see item 6. Measured before: at 1080p `11TH`/`12TH` lost **9.1 px of glyph and 35.1 px of outline off each side**; even `1ST` lost 10.8 px below. After: zero clipped ink across 340 configurations. | `src/ui/*` |
| ~~P0-5~~ | **"Touching the edge equals a crash" is far too harsh** — makes the game too difficult. Walls must SLIDE. **DONE** — the per-event response was fine; it ran **per tick, twice** (nose+tail probe) at 120 Hz with no notion of "still touching the same wall". Measured before: 3 s of light steering pressure against a wall took **18 m/s → 0.03 m/s, a 99.9 % loss**. After: 6.2 % loss, **1 penalty instead of ~325–650**. Retained speed 5°/15°/30°/60°/90° = 97.7 / 93.3 / 87.3 / 58.5 / 34.0 %. | `src/physics/KartCollision.ts` |
| ~~P0-6~~ | A road section **containing a boost pad is incomplete and nearly impassable**. **DONE** — three causes, incl. `surfaceAt()` returning `Void` for `TF.Gap` before testing `TF.Glider`, so **no kart on any circuit had ever deployed a glider**. Crossings 0/12 → 8/8 at 22/28/34/40 m/s on all three tracks. | `src/track/*` |
| ~~P0-7~~ | **Steering is too sensitive / over-reacts**, making the kart hard to control. **DONE** — the old curve bottomed out at 73 % authority; at 38 m/s it demanded **7.28 g** against a 5.6 g tyre budget, and the surplus came back as slip — "twitchy input, then mushy slide". New square falloff keeps every speed inside budget. Yaw at 38 m/s 1.880 → 0.839 rad/s (−55 %); **5 m/s unchanged (−0.3 %)**, so low-speed agility survives. Drift now holds **97.0 %** of entry speed (was 63.2 %). | `src/physics/*` (+ `Input.ts` by request) |

### 🔴 NEW — DEAD MECHANICS uncovered while fixing the above

Two features exist in code, are authored into tracks, and **have never once run**.
Both were found by numeric probing, not by looking — no screenshot would reveal
a mechanic that simply never fires.

| Mechanic | Status | Owner |
|---|---|---|
| **Gliders** | `surfaceAt()` returned `Void` for `TF.Gap` **before** testing `TF.Glider`, and every authored glider volume sits on a Gap segment. No kart on any circuit had ever deployed one. **FIXED** — crossings 0/12 → 8/8. | `src/track/*` |
| **Anti-gravity** | Never engages. Confirmed by A/B against original physics, so it is pre-existing, not a regression. Authored AG zones exist on Neon Metropolis. | `src/physics/*` + `src/track/*` |
| ~~**Ramp tricks**~~ | **FIXED** — `DriftSystem.tricks()` gated arming on `velocity.dot(b.up) >= 1.6`, but a kart riding a ramp travels *along* the surface, so that dot product reads ~0 exactly when a kicker is throwing it upward. Bench ramp lip: `dot(b.up)` **−0.41** vs `velocity.y` **+6.07**. Now measured against world up. Bench reports trick "frontflip" / 0.55 s boost (was none / 0.00). Kerb blips measure 0.24 m/s and are still rejected, so the 1.6 threshold keeps its job. AG left alone: there the meaningful axis is the ground normal, which has the same along-the-surface problem and needs a departing-plane test. | `src/physics/DriftSystem.ts` |

**Suspicion worth acting on — now FIVE instances, so treat it as a rule.**
Three became five while fixing the above:

4. **22 of 44 authored prop types were silently dropped** (see the section
   below). `normaliseType()` returned null and `collectAuthored` discarded the
   placement behind one `console.info`.
5. **`takeAuthored()` was written, documented, and never called by anything** —
   the whole "fold authored anchors into an existing InstancedMesh" mechanism
   was dead.

Anything gated on a surface-flag test, a zone lookup, **or a name-to-builder
table** deserves an explicit "does this ever become true during a real lap?"
probe. Add such a probe for boost pads, item boxes, checkpoints, respawn
triggers and every `SurfaceType`. The generalisable lesson: a lookup that
returns null/undefined on a miss and logs instead of throwing will hide a
whole subsystem indefinitely. Prefer an exhaustive switch or a startup
assertion that every authored name resolves.

### Shared root cause for P0-1 / P0-2 — CONFIRMED

P0-2's 90°-out gates and the `sponsorBoard`'s mirrored text (item 0b below,
where the UV path was independently verified **correct**) both point at the
**prop anchor/yaw derivation from the spline**. Suspect `tangent` vs `binormal`
confusion or swapped `Math.atan2` arguments. A gate spanning the road must have
its long axis along the **binormal**; a trackside board must face along
**−tangent** toward oncoming karts. **Fix the shared derivation once** and
re-check the sign mirroring afterwards — it may resolve for free.

### These are all numerically checkable — prefer that over screenshots
The browser pane is a single shared resource and is contended.
- Road continuity: step the spline at ~0.5 m, raycast down, report arc-length
  ranges with no hit or a height discontinuity.
- Prop clearance: project bounding-box corners via `track.project()`, assert
  lateral distance > `halfWidth`.
- Gate orientation: assert long axis is within a few degrees of the local
  `binormal`, not the `tangent`.
- Wall harshness: fire a kart at 5/15/30/60/90° and report retained speed %.
  Also count collision events for a kart parked against a wall for 3 s — at
  120 Hz a naive implementation penalises it ~360 times.
- Text clipping: `el.scrollWidth <= el.clientWidth`, rects inside the viewport,
  no two HUD rects intersecting. Test `11TH`/`12TH`, not just `1ST`.

---

---

## ⚠️ 0. READ FIRST — every closed primitive in `Props.ts` was inside-out

`Builder.box`, `prism`, `tube`, `sphere` and `torus` all emitted
clockwise-from-outside triangles **with matching inward normals**. Against
`FrontSide` materials every near face was back-face culled, so what actually
rendered was the far interior wall. Proof by signed volume: `crate` **−1.654**,
`pillar` **−17.1**, `arch` **−53.6**, at 100 % normal/winding agreement.
All five now measure positive volume. `quad`/`plate`/`banner` were already
correct.

**This single bug plausibly explains several defects previously filed as
unrelated art problems** — the grandstand reading as "a plain white box" despite
already emitting nine tiers, the **black-void house roofs**, the **untextured
flat-blue sponsor boards**, and the "grey untextured wedge". Every prop in the
file is affected: gantry, floodlights, buildings, palms, rocks, boats, tyre
stacks.

**Consequences for everyone:**
1. **Re-verify the whole prop set visually before fixing any individual prop.**
   Several open items below may already be resolved. Do not "fix" a prop that is
   now correct.
2. Any other hand-built geometry in the project deserves the same check. It is a
   ~10-line test: sum the signed volume of the triangle fan and confirm it is
   positive, and confirm face normals agree with winding.

## 0b. CLOSED — both axes confirmed correct by screenshot

**Confirmed on screen at the repro coordinates below:** the road decal reads
**"FINISH"** left-to-right and the trackside boards read **"VOLT"** correctly, in
the same frame, from a driver's viewpoint. Both `u` and `v` are now right.

**The integrator's earlier `u` swap was WRONG and has been correctly reverted.**
Recording why, so nobody re-applies it: a viewer at an object's local +z looking
down −z sees that object's local **+x on their RIGHT** (that is the default
three.js camera basis — a camera at +z looking at the origin puts world +x at
screen-right). Text therefore reads left-to-right only when `u` increases along
local +x, i.e. `-hw → uMin` — the *ascending* range. The integrator reasoned +x
appeared on the viewer's left, which inverted the conclusion.

The "runtime `u` mirror made the boards read TORQUE/AXP/EMBER" experiment that
motivated the bad fix predates the current sponsor list (APEX/NITRO/TURBO/GRIP/
VOLT/SLIP/DRIFT/KART), so it was run against a different revision. Corroborating
evidence for the ascending range: `flapAcross` in the same function always used
it and the mast cloths were never reported mirrored.

**Lesson for this codebase:** an empirical UV test is only valid against the
revision it was run on, and "I flipped it and it looked better" is weaker
evidence than deriving the camera basis. Prefer the derivation, then confirm.

<details><summary>Original investigation (kept for the reasoning trail)</summary>

**Owner: `src/world/Props.ts` (world agent)**

Screenshot test done. Result differed from the prediction, so read this before
acting.

**`plate()`'s `v` convention is CORRECT and `V_TOP_FIRST` should stay `true`.**
Do not flip the shared helper. The bug was in three **callers** passing an
ascending `v` range, which sends the geometry's top edge to the canvas bottom:

| line | sign | was | now |
|---|---|---|---|
| ~1397 | `sponsorBoard` | `[0.02, 0.06, 0.98, 0.94]` | `[0.02, 0.94, 0.98, 0.06]` |
| ~1450 | (billboard face) | `[0, 0, 1, 1]` | `[0, 1, 1, 0]` |
| ~1603 | `roadSign` | `[0.05, 0.1, 0.95, 0.9]` | `[0.05, 0.9, 0.95, 0.1]` |

**Verified by observation:** before the change the small "APEX KART
CHAMPIONSHIP" caption rendered at the **top** of the board; it is drawn at
`y + ch * 0.82`, i.e. near the cell **bottom**. After the change it renders at
the bottom. Vertical layout is now correct. `atlasRect()` was already right —
new signage built through it needs no change.

**`u` — FIXED in the placement pass, WANTS ONE SCREENSHOT to confirm.**

It was **not** the anchor yaw. `roadside()` computes
`yaw = atan2(-bx*side, -bz*side)`, which sends the prop's local **+Z at the
road**; a driver therefore looks at `plate()`'s **front** (+z) face, not its back.
Checked numerically over every trackside anchor on all three circuits.

It was the front face's `u` range. A viewer standing at an object's local +z
looking down −z sees that object's local **+x on their RIGHT** — that is the
default three.js camera basis (camera at +z looking at the origin puts world +x
at screen-right). Text reads left-to-right only when `u` increases along local
+x, i.e. `-hw -> uMin`. `plate()`'s front quad was carrying the *back* face's
descending range (and `banner()` the same), which is exactly the reported
symptom. Front and back ranges are now swapped back; `flapAcross` in the same
function always used the ascending mapping, and the mast cloths were never
reported mirrored — that is the corroborating evidence. `flipY` affects `v`
only, so it does not enter into the `u` argument.

The "runtime `u` mirror made the boards read TORQUE/AXP/EMBER correctly"
experiment cited above predates the current sponsor list (APEX/NITRO/TURBO/GRIP/
VOLT/SLIP/DRIFT/KART), so it was run against a different revision — treat it as
stale rather than as evidence for the descending range.

Confirm at: camera `(-6, 2.2, 2.3)` looking at `(-17, 1.5, 2.3)`, fov 32,
`day` sky, HUD off. `sponsorBoard` instance 0 sits at `(-17, -0.2, 2.3)`.
`Prop:gantryBanner` and `Prop:standBanner` go through `banner()` and changed with
it, so check one of those in the same frame.

</details>

---

Written by the integrator. Each item names the file owner. Agents: read the
section for **your** files, then delete that section when it's done.

---

## 1. Mirrored text — PARTIALLY FIXED, verify the rest

**Owner: `src/world/Props.ts` (world agent), `src/track/Decals.ts` (track agent)**

**Diagnosis (proven empirically, don't re-derive it):** `PropBuilder.plate()` lays
the plate along local **+x** with a **+z** face normal. A viewer looking at that
front face stands at +z looking down −z, and therefore sees world +x running to
their **left**. Mapping `uMin → -hw` consequently renders every texture
horizontally mirrored. Combined with `flipY = true` on the canvas texture, the
net result was a 180° rotation — which is why "FINISH" rendered as "HꙄINI∃".

Evidence, read off the live `Prop:sponsorBoard` geometry:

| local vertex | position | uv (before fix) |
|---|---|---|
| bottom-left  | (−3.2, 0.5, 0.06) | (0.02, 0.94) |
| bottom-right | ( 3.2, 0.5, 0.06) | (0.98, 0.94) |
| top-right    | ( 3.2, 2.6, 0.06) | (0.98, 0.06) |
| top-left     | (−3.2, 2.6, 0.06) | (0.02, 0.06) |

Confirmed by mirroring `u` at runtime on every `prop-atlas` geometry: the
trackside boards then read **"TORQUE" / "AXP" / "EMBER"** correctly.

**Done:** `plate()` front/back uv ranges swapped.

**Still to check — same class of bug is likely present in:**
- `PropBuilder.banner()` — `Prop:gantryBanner` uses it and shares the atlas.
- Any other `quad()` caller that draws atlas text.
- **`src/track/Decals.ts` — PROBABLY NOT A BUG. Verify before changing anything.**
  Independently confirmed since: the road "FINISH" marking **reads correctly from
  the driving direction** in a chase-camera screenshot. It reads reversed only
  from the intro fly-over and from the `grid-wide` canonical shot — and
  `grid-wide` deliberately frames the start line from the far end (`back: -26`),
  i.e. looking back up the track against the racing direction. Painted road text
  is directional by nature; reading it reversed from the wrong end is correct.
  The original report was made from the fly-over frame, which was the wrong frame
  to judge it from. Only fix what is reversed as a *driver* sees it.

Verify with a chase-camera screenshot, in the racing direction, in which
trackside boards AND the road markings both read left-to-right.

---

## 2. WebGL sampler mismatch — NOT FIXED, was in flight when quota hit

**Owner: `src/vfx/VfxManager.ts` / `ParticleSystem.ts` (vfx agent)**

Every scene draw call was failing validation with:

```
GL_INVALID_OPERATION: Mismatch between texture format and sampler type
```

Floods until Chrome silences the context; per-draw validation failures make
Chrome's command decoder crawl. The post agent ruled out `src/render/`. Prime
suspect is the `DepthTexture` handed to `ParticleSystem.setDepthTexture()` around
`VfxManager.ts:516` — binding a depth texture to a plain `sampler2D` produces
exactly this message. Prefer correctness over the effect: if the bind can't be
made valid, fall back to `depthWrite:false` + sorted alpha and log one warning.

**Re-confirm whether it still reproduces** before doing surgery — several
material and shadow changes have landed since it was reported.

---

## 3. Road surface reads as coarse gold/tan at speed

**Owner: `src/track/RoadMaterial.ts` (track agent)**

In a chase screenshot mid-lap the road reads as a noisy gold/tan surface rather
than asphalt, while the start/finish area reads correctly as blue-grey paving.
Either a sand/off-road material is bleeding onto the drivable surface, the
surface-type blend is mis-sampling, or the asphalt macro-variation is far too
strong and too warm. The player was at 101 km/h (full speed) at the time, so
physics considered it road, not off-road — i.e. this is a *material* bug, not the
kart being off-track.

---

## 4. ~~Crowd figures are too blocky~~ — DONE

**Owner: `src/world/Crowd.ts` (world agent)**

Spectators currently read as rectangular blocks with visible hard corners at
mid distance. MK8's crowds are simple but rounded and readable. They're already
correctly instanced and masked to `SHADOW_LAYER.NEAR_ONLY`, so there is budget
for a slightly better silhouette — chamfer the forms and vary the poses.

---

## 5. ~~Grandstand / architecture lacks detail~~ — DONE

**Owner: `src/world/Props.ts` (world agent)**

The main grandstand is a plain white box structure. MK8 dresses its stands with
roof trusses, exposed supports, tiered seating rows, signage, railings and shade
panels. This is the largest man-made silhouette on the start straight and it is
currently the weakest large object in frame.

---

## 6. ~~HUD does not scale down for small viewports~~ — DONE (with P0-4)

**Owner: `src/ui/ui.css`, `src/ui/HUD.ts` (ui agent)**

Same root cause as **P0-4**, fixed together. `ui.css` already derived every size
from one unit (`--u`), but its fallback was `calc(1px * var(--ak-scale, 1))` — so
any frame before `HUD.resize()` had run drew a 1920×1080-sized HUD at 1:1
whatever the viewport (position plate **22.3 %** of an 800×450 frame, speedometer
**29 % × 52 %**, top-right stack **84 % of frame height**). `--u` now falls back
to a pure-CSS viewport `clamp()`, so it is right with no JS at all; JS still
refines it from the *container* size for the embedded/letterboxed case.

Three per-element media queries were deleted (`.ak-hud__tc`, `.ak-timer`,
`.ak-rivals { display: none }`) — they keyed off the **window** while the HUD is
sized from the **container**, so the rival tracker silently vanished from a
full-size HUD in the preview pane. Don't reintroduce HUD breakpoints.

Verified by DOM measurement, not screenshots: 340 configurations (7 race states ×
4 viewports × 12 positions, plus the results board) with zero overflow, zero
clipped ink, zero rect intersections and the plate at 8.79 % of frame width at
every size. Harness kept at `src/dev/ui.{html,ts}` — `window.__UIQA__.summary()`.
HUD frame cost 0.04–0.06 ms (budget 0.4 ms).

### Two notes for the track owner (`src/track/*`)

Neither is fixed in `src/track/*` — the HUD works around both, but the API is
misleading and the next consumer will hit it too:

1. **`Track.getMinimapPath()` returns bounding-box-normalised 0..1 coordinates**
   (`TrackBuilder.ts` ~line 993), while its `TrackLike` doc comment says "the
   centreline in world XZ". The minimap fitted its transform to a span of ~1 and
   then plotted karts at ±200 m, which is why **the map showed no racer dots at
   all**. `HUD.refreshTrackPath()` now builds its own world-space ribbon from
   `sampleAtDistance()` and only falls back to the normalised path (ribbon only,
   dots suppressed, one console warning). Either rename it or return metres.
2. **`getItemBoxPositions()` does not exist** — the HUD had been probing for that
   name; the real one is `getItemBoxSpawns()`, returning `{position: Vector3}[]`.
   Item-box markers had therefore never appeared on the map. Now handled.

Also worth knowing: `Game` awaits `hud.init()` **before** `engine.initAll()` runs
`Track.init()`, so any subsystem that pulls track geometry during its own `init()`
gets an empty result and must retry. The HUD now retries twice a second until the
ribbon arrives.

---

## 7. Quality-of-life notes for everyone

- **Frame-rate measurement**: the preview pane frequently reports
  `visibilityState === 'hidden'`, and Chrome then throttles rAF to a few Hz.
  `__QA__.benchmark()` now returns `valid` + `warning` — **never quote
  `medianFps` when `valid` is false.** Judge cost by `renderer.info` instead.
- **The pane also resizes itself** (observed dropping to ~560 px wide mid-session).
  Re-assert `resize_window` before any measurement or screenshot you intend to
  judge quality from.
- **`race.skipIntro()`** exists and is the fast way to reach `racing` without
  waiting out the rAF-throttled cinematic.
- Synthetic input works: `window.dispatchEvent(new KeyboardEvent('keydown', {code:'ArrowUp'}))`
  drives the player, so you can photograph the game at real speed.
