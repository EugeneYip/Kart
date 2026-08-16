/**
 * ============================================================================
 *  MINIMAP ARC WALK — regression check for the world → marker chain
 * ============================================================================
 *  Drives the REAL `Minimap` through the REAL HUD feed (`trackSignature` +
 *  `sampleCourse`, both exported from `src/ui/HUD.ts`) and walks known kart
 *  positions around every circuit, then asserts the marker path is:
 *
 *    (a) monotonic in arc     — the marker advances along the drawn ribbon,
 *                               never backwards, wrapping exactly once at the
 *                               t = 0/1 seam;
 *    (b) on the drawn course  — marker-to-ribbon distance, converted back to
 *                               metres through the map scale, matches the lane
 *                               the kart is actually in;
 *    (c) jump-free            — no step larger than the arc step it was given;
 *    (d) on the canvas        — every marker inside the map square;
 *    (e) source-consistent    — the player's arrow and an NPC dot at the SAME
 *                               world position land on the same pixel.
 *
 *  Positions come from `markerAt()`, which the Minimap records where it blits
 *  the sprite, so this measures the drawn pixel and not a re-derivation of it.
 *
 *  `--break=<mode>` deliberately breaks the chain, to prove the assertions
 *  actually fire:
 *
 *    stale-transform  the shipped defect — adopt the ribbon once, from the boot
 *                     default circuit, and never refresh it
 *    other-circuit    feed the ribbon from a fixed unrelated circuit every time
 *    wrong-deck-t     place markers by centreline-projected `t` rather than by
 *                     world position (the multi-level-deck theory)
 *
 *  Usage:
 *    node src/dev/node-run.mjs .probe-tmp/minimap-arcwalk.ts [--break=MODE]
 *                                                            [--tracks=a,b]
 * ============================================================================
 */

import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { loadTrack, makeKartState, TRACK_IDS } from '@/dev/headless';
import type { KartState } from '@/core/Types';
import type { Minimap as MinimapT } from '@/ui/Minimap';

// `src/ui/Fonts.ts` does `import './ui.css'`, which the bundler handles and
// Node does not. Stub it, then pull the UI modules in dynamically so the hook
// is installed before they resolve.
registerHooks({
  load(url: string, ctx: unknown, next: (u: string, c: unknown) => unknown) {
    if (url.startsWith('file:') && url.endsWith('.css')) {
      return { format: 'module', source: 'export default undefined;', shortCircuit: true };
    }
    return next(url, ctx);
  },
} as Parameters<typeof registerHooks>[0]);

const { sampleCourse, trackSignature } = await import('@/ui/HUD');
const { Minimap } = await import('@/ui/Minimap');
type Minimap = MinimapT;

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

/** Arc steps per lap. */
const STEPS = 200;
/** Ribbon vertices — must match `MINIMAP_SAMPLES` in HUD.ts. */
const RIBBON = 220;
/** CSS size and DPR the HUD gives the minimap at 1080p. */
const MAP_CSS = 216;
const MAP_DPR = 2;
/** Lateral lanes walked, as a fraction of the road half-width. */
const LANES = [0, 0, -0.8, 0.8];
/** Big dt so the dot smoothing settles: the geometry is what is under test. */
const SETTLE_DT = 1.0;

/** Tolerances, in METRES of map space (pixels / scale) so they are circuit-independent. */
const TOL = {
  /** Marker-to-ribbon distance vs the lane the kart is in. */
  offCourseM: 2.0,
  /** Per-step marker travel vs the arc step, centre lane. */
  jumpFactorCentre: 1.15,
  /** ...outer lanes travel further round a corner. */
  jumpFactorEdge: 1.9,
  /** Player arrow vs NPC dot at the same world point, pixels. */
  sourceSkewPx: 0.01,
  /** Glyph angle vs the kart's own forward vector, mapped independently. */
  headingDeg: 0.5,
  /**
   * Glyph angle vs the direction the marker travels between steps. Only
   * meaningful on the centreline: an offset lane's path swings relative to the
   * centreline tangent wherever the road changes width, so a kart oriented
   * along the tangent legitimately does not point along its own offset path.
   */
  travelDeg: 12,
  /** Corner-cutting of the smoothed marker at racing speed, metres. */
  smoothOffM: 3.0,
};

type BreakMode = 'none' | 'stale-transform' | 'other-circuit' | 'wrong-deck-t';

const args = process.argv.slice(3);
const argOf = (k: string): string | null => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : null;
};
const BREAK = (argOf('break') ?? 'none') as BreakMode;
const TRACKS = (argOf('tracks') ?? '').length
  ? (argOf('tracks') as string).split(',')
  : TRACK_IDS;
/** Circuit the game builds at boot, before any menu choice. */
const BOOT_TRACK = 'sunsetCoastline';

// ---------------------------------------------------------------------------
//  Geometry helpers
// ---------------------------------------------------------------------------

interface Pt { x: number; y: number }

/** Distance from `p` to segment ab, plus the fraction along ab of the foot. */
function segDist(p: Pt, a: Pt, b: Pt): { d: number; u: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let u = len2 > 1e-12 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
  if (u < 0) u = 0; else if (u > 1) u = 1;
  const dx = p.x - (a.x + vx * u);
  const dy = p.y - (a.y + vy * u);
  return { d: Math.hypot(dx, dy), u };
}

/**
 * Nearest point on the drawn (closed) ribbon: distance in pixels and the
 * position along the ribbon as a vertex-index parameter in [0, N).
 *
 * `window` restricts the search to segments within that many vertices of
 * `seed`. That matters on a multi-level circuit: Volcano Rush's helix passes
 * 1.53 m from its lava-tube straight in XZ with 39.9 m of vertical separation,
 * 49 ribbon vertices apart, so a GLOBAL nearest-vertex query flips between the
 * two decks and reports a 48-vertex leap backwards for a marker that has not
 * moved wrongly at all. A top-down map is supposed to draw stacked decks on top
 * of each other; it is this measurement, not the minimap, that has to
 * disambiguate — which it does the same way the eye does, by continuity.
 */
function nearestOnCourse(map: Minimap, p: Pt, seed = -1, window = 0): { d: number; u: number } {
  const n = map.courseLength;
  let bestD = Infinity;
  let bestU = 0;
  const a: Pt = { x: 0, y: 0 };
  const b: Pt = { x: 0, y: 0 };
  const lo = seed >= 0 && window > 0 ? Math.round(seed) - window : 0;
  const hi = seed >= 0 && window > 0 ? Math.round(seed) + window : n - 1;
  for (let s = lo; s <= hi; s++) {
    const i = ((s % n) + n) % n;
    map.courseAt(i, a);
    map.courseAt((i + 1) % n, b);
    const r = segDist(p, a, b);
    if (r.d < bestD) { bestD = r.d; bestU = i + r.u; }
  }
  return { d: bestD, u: bestU };
}

/** Vertices either side of the previous foot that the marker may advance into. */
const TRACK_WINDOW = 10;

/** Forward distance from u0 to u1 around a loop of length n. */
function fwd(u0: number, u1: number, n: number): number {
  let d = (u1 - u0) % n;
  if (d < 0) d += n;
  return d;
}

// ---------------------------------------------------------------------------
//  The feed — this is the HUD's own logic, called exactly as `tick()` calls it
// ---------------------------------------------------------------------------

class Feed {
  private key = '';

  constructor(private map: Minimap) {}

  /** One `HUD.refreshTrackPath()` poll. */
  refresh(track: unknown): void {
    const sig = trackSignature(track);
    if (sig !== '' && sig === this.key) return;
    const course = sampleCourse(track, RIBBON);
    if (!course) return;
    this.key = sig;
    this.map.setPath(course.pts, course.space);
  }

  /** The shipped defect: latch on the first course ever seen. */
  refreshLatched(track: unknown): void {
    if (this.key !== '') return;
    const course = sampleCourse(track, RIBBON);
    if (!course) return;
    this.key = 'latched';
    this.map.setPath(course.pts, course.space);
  }
}

// ---------------------------------------------------------------------------
//  Reporting
// ---------------------------------------------------------------------------

interface Fail { track: string; lane: string; what: string; detail: string }
const fails: Fail[] = [];
let checks = 0;

function check(ok: boolean, track: string, lane: string, what: string, detail: string): void {
  checks++;
  if (!ok) fails.push({ track, lane, what, detail });
}

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

// ---------------------------------------------------------------------------
//  Walk
// ---------------------------------------------------------------------------

const _pos = new THREE.Vector3();
const _bin = new THREE.Vector3();
const _fwdV = new THREE.Vector3();
const _mk: Pt = { x: 0, y: 0 };
const _hd = new THREE.Vector3();

interface LaneTrace {
  name: string;
  lat: number;
  /** Marker canvas positions, one per arc step. */
  pts: Pt[];
  /** Nearest-course parameter per step. */
  us: number[];
  /** Marker-to-course distance in pixels per step. */
  ds: number[];
  /** Angle the glyph was drawn at, canvas space, per step. */
  as: number[];
  /** Angle the glyph SHOULD be drawn at, derived independently, per step. */
  es: number[];
}

/** Smallest signed difference between two angles. */
function angDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Second pass: drive one kart round the lap at racing speed at 60 Hz, so the
 * dot smoothing is actually exercised, and report how far the smoothed marker
 * strays from the drawn course. This is the "does the marker cut corners"
 * question, which the settled walk above cannot answer.
 */
function smoothingSweep(
  map: Minimap, track: { lapLength: number; sampleAtDistance: (d: number) => {
    position: THREE.Vector3; tangent: THREE.Vector3;
  } }, pxPerM: number,
): { maxOffM: number; maxJumpPx: number } {
  const L = track.lapLength;
  const dt = 1 / 60;
  const speed = 28;                       // m/s, roughly top speed
  const k = makeKartState(90, false);
  const p: Pt = { x: 0, y: 0 };
  let prev: Pt | null = null;
  let maxOffM = 0;
  let maxJumpPx = 0;
  for (let d = 0; d < L; d += speed * dt) {
    const s = track.sampleAtDistance(d);
    k.position.set(s.position.x, s.position.y, s.position.z);
    k.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), s.tangent.clone().normalize());
    map.update([k], null, dt);
    const got = map.markerAt(k.id, p);
    if (!got) continue;
    const here = { x: got.x, y: got.y };
    maxOffM = Math.max(maxOffM, nearestOnCourse(map, here).d / pxPerM);
    if (prev) maxJumpPx = Math.max(maxJumpPx, Math.hypot(here.x - prev.x, here.y - prev.y));
    prev = here;
  }
  return { maxOffM, maxJumpPx };
}

async function walk(trackId: string, map: Minimap, feed: Feed, breakMode: BreakMode): Promise<void> {
  const track = await loadTrack(trackId);

  if (breakMode === 'stale-transform') feed.refreshLatched(track);
  else if (breakMode === 'other-circuit') {
    // Ribbon always from one unrelated circuit; karts from this one.
    const other = await loadTrack(trackId === 'volcanoRush' ? 'tokyoNeon' : 'volcanoRush');
    const course = sampleCourse(other, RIBBON);
    if (course) map.setPath(course.pts, course.space);
    await loadTrack(trackId);
  } else feed.refresh(track);

  if (map.courseLength < 3) { check(false, trackId, '-', 'ribbon', 'no course adopted'); return; }

  const lapLength = track.lapLength;
  const stepM = lapLength / STEPS;

  // Four karts at the same arc position: player + NPC on the centreline (so
  // their markers must coincide), and an NPC pinned to each road edge.
  const karts: KartState[] = LANES.map((_, i) => makeKartState(i, i === 0));
  const traces: LaneTrace[] = LANES.map((f, i) => ({
    name: i === 0 ? 'player-centre' : i === 1 ? 'npc-centre' : `npc-lat${f > 0 ? '+' : ''}${f}`,
    lat: 0,
    pts: [],
    us: [],
    ds: [],
    as: [],
    es: [],
  }));

  for (let s = 0; s < STEPS; s++) {
    const d = (s / STEPS) * lapLength;
    const smp = track.sampleAtDistance(d);
    _pos.copy(smp.position);
    _bin.copy(smp.binormal);
    _fwdV.copy(smp.tangent);
    const halfW = smp.halfWidth;

    for (let i = 0; i < karts.length; i++) {
      const lat = LANES[i] * halfW;
      traces[i].lat = Math.abs(lat);
      const k = karts[i];
      if (breakMode === 'wrong-deck-t' && s / STEPS >= 0.30 && s / STEPS < 0.45) {
        // The multi-level theory, made real: over ONE stretch of the lap — as
        // if the kart were on an upper deck and `Track.project()` were picking
        // the road underneath it — the marker is placed from a `t` belonging to
        // a different part of the lap.
        //
        // It has to be a stretch, not the whole lap. Displacing every step by
        // the same amount just phase-shifts the marker, and a phase-shifted
        // marker still traces the drawn course perfectly: that version of this
        // break PASSED all 168 assertions. What a wrong deck actually looks
        // like is the discontinuity at each end of the stretch.
        const wrongD = (d + lapLength * 0.5) % lapLength;
        const w = track.sampleAtDistance(wrongD);
        k.position.set(w.position.x, w.position.y, w.position.z);
      } else {
        k.position.set(
          _pos.x + _bin.x * lat,
          _pos.y + _bin.y * lat,
          _pos.z + _bin.z * lat,
        );
      }
      k.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), _fwdV.clone().normalize());
    }

    map.update(karts, karts[0], SETTLE_DT);

    for (let i = 0; i < karts.length; i++) {
      const got = map.markerAt(karts[i].id, _mk);
      if (!got) { check(false, trackId, traces[i].name, 'marker', `not painted at step ${s}`); return; }
      const p = { x: got.x, y: got.y };
      // Distance is a GLOBAL query — "is the marker anywhere near the course?".
      // Arc position is a CONTINUOUS one — "did it walk there?". See the note
      // on `nearestOnCourse`.
      const far = nearestOnCourse(map, p);
      const us = traces[i].us;
      const near = us.length === 0
        ? far
        : nearestOnCourse(map, p, us[us.length - 1], TRACK_WINDOW);
      traces[i].pts.push(p);
      us.push(near.u);
      traces[i].ds.push(far.d);
      traces[i].as.push(map.markerHeading(karts[i].id) ?? NaN);
      // Independent oracle for the glyph angle: take the kart's forward vector
      // with THREE's own quaternion maths, map it through the minimap's axis
      // convention (world x -> map X, world z -> map Y), and add the map
      // rotation. This checks `Minimap.forwardXZ` and the axis mapping without
      // reusing either.
      _hd.set(0, 0, -1).applyQuaternion(karts[i].quaternion);
      traces[i].es.push(Math.atan2(_hd.z, _hd.x) + map.mapRotation);
    }
  }

  // The map scale, recovered from the drawn ribbon: pixels per metre.
  const c0: Pt = { x: 0, y: 0 };
  const c1: Pt = { x: 0, y: 0 };
  map.courseAt(0, c0);
  map.courseAt(1, c1);
  const ribbonStepM = lapLength / RIBBON;
  const pxPerM = Math.hypot(c1.x - c0.x, c1.y - c0.y) / ribbonStepM;
  const N = map.courseLength;
  const S = MAP_CSS * MAP_DPR;

  const rows: string[] = [];
  for (const t of traces) {
    const isEdge = t.lat > 0.5;

    // (a) monotonic in arc
    let back = 0;
    let worstBack = 0;
    let wrapSum = 0;
    for (let s = 1; s < t.us.length; s++) {
      const du = fwd(t.us[s - 1], t.us[s], N);
      const signed = du > N * 0.5 ? du - N : du;
      wrapSum += signed;
      if (signed <= 0) { back++; worstBack = Math.min(worstBack, signed); }
    }
    check(back === 0, trackId, t.name, 'monotonic',
      `${back}/${t.us.length - 1} steps went backwards along the course (worst ${f2(worstBack)} ribbon-vertices)`);
    check(Math.abs(wrapSum - (N * (STEPS - 1)) / STEPS) < N * 0.08, trackId, t.name, 'wrap',
      `walked ${f2(wrapSum)} ribbon-vertices, expected ~${f2((N * (STEPS - 1)) / STEPS)} (one lap, no seam jump)`);

    // (b) on the drawn course
    let maxOffM = 0;
    for (const d of t.ds) maxOffM = Math.max(maxOffM, d / pxPerM);
    const allowM = t.lat + TOL.offCourseM;
    check(maxOffM <= allowM, trackId, t.name, 'on-course',
      `marker sat ${f2(maxOffM)} m from the drawn course; lane is ${f2(t.lat)} m, allowed ${f2(allowM)} m`);

    // (c) jump-free
    let maxJumpM = 0;
    for (let s = 1; s < t.pts.length; s++) {
      const j = Math.hypot(t.pts[s].x - t.pts[s - 1].x, t.pts[s].y - t.pts[s - 1].y) / pxPerM;
      maxJumpM = Math.max(maxJumpM, j);
    }
    const jumpAllow = stepM * (isEdge ? TOL.jumpFactorEdge : TOL.jumpFactorCentre);
    check(maxJumpM <= jumpAllow, trackId, t.name, 'no-jump',
      `largest step ${f2(maxJumpM)} m against an arc step of ${f2(stepM)} m (allowed ${f2(jumpAllow)} m)`);

    // (d) on the canvas
    let off = 0;
    for (const p of t.pts) if (p.x < 0 || p.y < 0 || p.x > S || p.y > S) off++;
    check(off === 0, trackId, t.name, 'on-canvas',
      `${off}/${t.pts.length} markers fell outside the ${S}x${S} map`);

    // (f) the glyph points where the kart points
    let maxHeadErrDeg = 0;
    for (let s = 0; s < t.as.length; s++) {
      if (!Number.isFinite(t.as[s])) continue;
      maxHeadErrDeg = Math.max(maxHeadErrDeg, Math.abs(angDiff(t.es[s], t.as[s])) * (180 / Math.PI));
    }
    check(maxHeadErrDeg <= TOL.headingDeg, trackId, t.name, 'heading',
      `glyph pointed ${f2(maxHeadErrDeg)} deg away from the kart's own forward vector`);

    // ...and on the centreline, that is also the direction it travels
    let maxTravelErrDeg = 0;
    if (!isEdge) {
      for (let s = 1; s < t.pts.length; s++) {
        const dx = t.pts[s].x - t.pts[s - 1].x;
        const dy = t.pts[s].y - t.pts[s - 1].y;
        if (Math.hypot(dx, dy) < 1e-6 || !Number.isFinite(t.as[s])) continue;
        const err = Math.abs(angDiff(Math.atan2(dy, dx), t.as[s])) * (180 / Math.PI);
        maxTravelErrDeg = Math.max(maxTravelErrDeg, err);
      }
      check(maxTravelErrDeg <= TOL.travelDeg, trackId, t.name, 'travel-dir',
        `glyph pointed ${f2(maxTravelErrDeg)} deg away from the direction the marker was travelling`);
    }

    rows.push(
      `    ${t.name.padEnd(14)} off-course max ${f2(maxOffM).padStart(8)} m   `
      + `jump max ${f2(maxJumpM).padStart(7)} m / step ${f2(stepM)} m   `
      + `backwards ${String(back).padStart(3)}   off-canvas ${String(off).padStart(3)}`
      + `   heading err ${maxHeadErrDeg.toExponential(1).padStart(9)} deg`
      + (isEdge ? '' : `   travel err ${f2(maxTravelErrDeg)} deg`),
    );
  }

  // (e) the player and an NPC at the same world point must agree
  let maxSkew = 0;
  for (let s = 0; s < traces[0].pts.length; s++) {
    maxSkew = Math.max(maxSkew, Math.hypot(
      traces[0].pts[s].x - traces[1].pts[s].x,
      traces[0].pts[s].y - traces[1].pts[s].y,
    ));
  }
  check(maxSkew <= TOL.sourceSkewPx, trackId, 'player-vs-npc', 'same-source',
    `player arrow and NPC dot at one world point differed by ${f2(maxSkew)} px`);

  // (g) smoothing: a full lap at 60 Hz and racing speed, not settled steps
  const sm = smoothingSweep(map, track, pxPerM);
  check(sm.maxOffM <= TOL.smoothOffM, trackId, 'smoothing', 'no-corner-cut',
    `smoothed marker at 28 m/s cut ${f2(sm.maxOffM)} m off the drawn course`);

  console.log(`  ${trackId}  (lap ${lapLength.toFixed(0)} m, ${pxPerM.toFixed(3)} px/m, ribbon ${N} pts)`);
  for (const r of rows) console.log(r);
  console.log(`    player-vs-npc skew ${maxSkew.toFixed(4)} px`
    + `   |  60 Hz sweep: corner-cut ${sm.maxOffM.toFixed(2)} m, max frame step ${sm.maxJumpPx.toFixed(2)} px`);
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(78));
  console.log(`MINIMAP ARC WALK   break=${BREAK}   ${STEPS} arc steps x ${LANES.length} lanes`);
  console.log('='.repeat(78));

  const map = new Minimap();
  map.resize(MAP_CSS, MAP_DPR);
  const feed = new Feed(map);

  // Boot exactly as the game does: Track.init() builds the default circuit and
  // the HUD samples it while the player is still in the main menu.
  const boot = await loadTrack(BOOT_TRACK);
  if (BREAK === 'stale-transform') feed.refreshLatched(boot);
  else feed.refresh(boot);

  for (const id of TRACKS) await walk(id, map, feed, BREAK);

  console.log('-'.repeat(78));
  if (fails.length === 0) {
    console.log(`PASS  ${checks} assertions over ${TRACKS.length} circuits`);
  } else {
    console.log(`FAIL  ${fails.length} of ${checks} assertions`);
    for (const f of fails) {
      console.log(`  [${f.what}] ${f.track} / ${f.lane}`);
      console.log(`      ${f.detail}`);
    }
  }
  console.log('='.repeat(78));
  process.exitCode = fails.length === 0 ? 0 : 1;
}

await main();
