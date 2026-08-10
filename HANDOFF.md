# APEX KART — open items handoff

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
- **`src/track/Decals.ts`** — the road "FINISH" marking was mirrored too. That's
  a separate file with separate code, so it needs its own check. Note the road
  decal is projected in track space (U across width, V along arc length), so the
  reasoning differs from `plate()` — work it out from first principles rather
  than copying the swap above.

Verify with a screenshot in which trackside boards AND the road marking both
read left-to-right.

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

## 4. Crowd figures are too blocky

**Owner: `src/world/Crowd.ts` (world agent)**

Spectators currently read as rectangular blocks with visible hard corners at
mid distance. MK8's crowds are simple but rounded and readable. They're already
correctly instanced and masked to `SHADOW_LAYER.NEAR_ONLY`, so there is budget
for a slightly better silhouette — chamfer the forms and vary the poses.

---

## 5. Grandstand / architecture lacks detail

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
