# APEX KART — open items handoff

---

## 🔴 P0 — HUMAN PLAYTEST REPORT (outranks everything below)

A person actually played the build. These are their words, translated into
defects. **Playability beats polish** — a beautiful game that isn't fun to drive
has failed. Do these first.

| # | Defect | Owner |
|---|---|---|
| P0-1 | Start-line audience seating is mispositioned and **visually extends onto the road**. | `src/world/Props.ts` |
| P0-2 | The **start/finish gate** and sometimes a **balloon arch** sit **parallel to the road, running down its middle**, instead of spanning across it. Yaw ~90° out. | `src/world/Props.ts` |
| P0-3 | An **item box is stuck in the middle of the road** at the start. | `src/track/*` (`getItemBoxSpawns`) |
| P0-4 | The **position/ranking plate clips its own text** — the plate edge cuts into the numeral. | `src/ui/*` |
| P0-5 | **"Touching the edge equals a crash" is far too harsh** — makes the game too difficult. Walls must SLIDE. | `src/physics/KartCollision.ts` |
| P0-6 | A road section **containing a boost pad is incomplete and nearly impassable**. | `src/track/*` |
| P0-7 | **Steering is too sensitive / over-reacts**, making the kart hard to control. | `src/physics/*` (+ `Input.ts` by request) |

### Likely shared root cause for P0-1 / P0-2 (and possibly the sign mirroring)

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

## 0b. The `v` axis — RESOLVED. The `u` axis on old signs — STILL OPEN.

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

**STILL OPEN — `u` on `sponsorBoard` specifically.** Its glyphs still read
horizontally mirrored after the `v` fix. Note this is *not* a general `plate()`
`u` bug: the `u` swap in `plate()` was verified earlier by a runtime `u` mirror
that made the trackside boards read "TORQUE"/"AXP"/"EMBER" correctly, and
`banner()` already carries the corrected mapping. So suspect **the instance
anchor's yaw for `sponsorBoard` being 180° out** — i.e. we are looking at the
plate's back face and reading its (correctly) mirrored reverse — rather than a
UV bug. Two checks that will settle it:
1. Emit the board with `single: true` temporarily. If it then disappears when
   viewed from the track, the anchor yaw is backwards.
2. Compare against `Prop:grandstandSign:46x6`, which goes through `atlasRect`
   and should read correctly from the track — if that one is fine and only
   `sponsorBoard` is mirrored, it is placement, not UV.

Reproduce at: camera `(-6, 2.2, 2.3)` looking at `(-17, 1.5, 2.3)`, fov 32,
`day` sky, HUD off. `sponsorBoard` instance 0 sits at `(-17, -0.2, 2.3)`.

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

## 6. HUD does not scale down for small viewports

**Owner: `src/ui/ui.css`, `src/ui/HUD.ts` (ui agent)**

At the preview pane's native size (**560 × 322**) the HUD is enormous: the
position plate, speedometer and timer each occupy roughly a quarter of the
frame and overlap the play area, leaving the kart barely visible. It was
reported as tested at 1280×720 / 1920×1080 / mobile, but this in-between
small-desktop size is clearly not covered.

Prefer scaling the whole HUD with a single root-level `font-size` /
`transform: scale()` driven by viewport size (or `clamp()` on a CSS custom
property that all element sizes derive from), rather than per-element media
queries — there are ~14 HUD elements and they must stay mutually consistent.
Verify at 560×322, 960×540, 1280×720 and 1920×1080.

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
