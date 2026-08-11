/**
 * ============================================================================
 *  APEX KART — CONTACT MODEL
 * ============================================================================
 *  Three jobs: track contact, karts, and falling off the world.
 *
 *  ── THE DESIGN CHANGE THIS FILE NOW IMPLEMENTS (P0b-5 / P0b-6) ─────────────
 *  A human playtester's own model, and it is better than what we had:
 *
 *    "Touching the edge of the track should not be considered a collision
 *     penalty. Perhaps it could instead cause friction and slow the player
 *     down. Only when the player goes outside the boundary should they need to
 *     be pulled back onto the track."
 *    "Buildings should perhaps only slow the player down when touched; having
 *     contact immediately result in a penalty would reduce the gameplay
 *     experience."
 *
 *  An earlier pass made walls *forgiving* (a 5° graze retained 97.7 %) but kept
 *  them **collisions**: there was still a discrete impact, an angle-scaled speed
 *  cut, a yaw kick and a spark burst. That is not what is being asked for. Track
 *  contact is now THREE DISTINCT CLASSES, and only one of them is a collision at
 *  all:
 *
 *   1. `Contact.Verge` — **THE TRACK EDGE. FRICTION ONLY.**
 *      No impulse. No yaw kick. No discrete impact. No speed-scrub event. No
 *      spark burst keyed to an impact. `wallImpacts` is NOT incremented — a
 *      verge contact is not a penalty and must never be counted as one.
 *      What happens instead:
 *        • the inward momentum is REDIRECTED along the edge (`vergeGlide`),
 *          not absorbed and not bounced, so the barrier can never take your
 *          speed away just for being there;
 *        • a continuous, `dt`-scaled drag is charged for as long as you overlap
 *          (`vergeContactDrag`), plus the wider verge-band drag in
 *          `KartPhysics` (`PHYS.vergeDrag`) for the kerb/apron itself;
 *        • a low-intensity `kart:wallHit` is published on a short cooldown. The
 *          audio layer reads `impact < 0.32` as a *sustained scrape loop* and
 *          the VFX layer scales its spark count by it, so this reads as a
 *          continuous scrape + rumble rather than an impact. See
 *          `vergeScrapeMax` — it is deliberately kept under that threshold.
 *      Net: riding the edge costs you TIME, steadily and predictably. It never
 *      spins you and never stops you.
 *
 *   2. Out of bounds — **RECOVERY**, in `checkBounds`. The pull-back only
 *      engages once the kart has genuinely left the playable surface, and the
 *      trigger is deliberately far outside the friction band. `voidGrace` is
 *      what buys that margin: the old code respawned on the FIRST tick the
 *      loaded wheel reported `Void`, which on the shipping track is 0.4 m past
 *      the shoulder edge — being yanked back while still nearly on the road.
 *
 *   3. `Contact.Solid` — **SOFT COLLIDER** for buildings, rock faces and other
 *      architecture. Costs speed through the same continuous drag (a stiffer
 *      one) plus a firm positional push-out so you cannot tunnel, and it still
 *      redirects rather than absorbs. It does **not** spin you: there is no yaw
 *      kick anywhere in this file any more. Only a genuine near-head-on shunt
 *      (`solidKnee`) is charged a one-time cost, so scraping past a building at
 *      10–30° is essentially free while driving square into one at speed is not.
 *
 *  ── WHY THERE IS NO YAW KICK ANY MORE ─────────────────────────────────────
 *  The old off-centre impulse existed to rotate the kart parallel to the wall.
 *  `PHYS.wallAlignRate` in KartPhysics already does that as a *constraint* — it
 *  only ever yaws the nose OUT of the barrier, every tick, and cannot overshoot.
 *  The impulse version could, which is the one way a graze could still cost you
 *  the nose. Removing it also removes two cross products per tick.
 *
 *  ── HOW A CONTACT IS CLASSIFIED ───────────────────────────────────────────
 *  `ITrackService.collideWalls()` returns `{hit, point, normal, depth}` and
 *  nothing else — it cannot currently tell us whether we touched a kerbside
 *  guardrail or a nine-metre building façade, even though `Track` knows exactly
 *  that (it picked the `WallStyle`). Until it reports it, `classifyContact()`
 *  infers it from three cheap signals; see that function. If `WallHit` ever
 *  gains a `style`/`solid` field this file prefers it automatically.
 *
 *  Kart↔kart is unchanged: a mass-weighted elastic push-apart. Inverse-mass
 *  distribution means a 280 kg heavyweight genuinely shoves a 148 kg
 *  featherweight, and a bump-boost rewards the aggressor. In anti-gravity,
 *  contact instead grants BOTH karts a spin-boost.
 * ============================================================================
 */

import * as THREE from 'three';
import type { ITrackService, WallHit } from '@/core/Types';
import { SurfaceType } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { clamp01, smoothstep } from '@/core/MathUtils';
import type { KartBody } from './KartPhysics';
import {
  DriftPhase,
  applyBoostTo,
  beginRespawn,
  cancelDrift,
  syncVelocityReadouts,
} from './KartPhysics';

/** What the kart is touching. Published on `KartBody.contactClass`. */
export const enum Contact {
  None = 0,
  /** Track edge / verge barrier. Friction only — never a penalty. */
  Verge = 1,
  /** Building, rock face, or any other solid scenery. Soft collider. */
  Solid = 2,
}

/**
 * `WallHit` plus the fields we would LIKE the track service to publish. Reading
 * them structurally means `src/track/*` can start reporting a contact class
 * without a single change here, and costs nothing while it doesn't.
 */
interface WallHitEx extends WallHit {
  /** `WallStyle` of the barrier that was hit, if the track reports it. */
  style?: string;
  /** True for scenery that should behave as a soft collider, not an edge. */
  solid?: boolean;
}

/** `WallStyle` values that are architecture rather than a track edge. */
const SOLID_STYLES = ['building', 'rock'] as const;

export const COLL = {
  /** Wall probe sphere radius as a fraction of the chassis half-width. */
  wallRadius: 1.04,
  /** Nose/tail probe offset as a fraction of the chassis half-length. */
  wallProbe: 0.58,

  // --- class 1: the verge ---------------------------------------------------
  /**
   * Penetration deliberately left unresolved at the track edge, metres. Two
   * reasons it is much larger than a collision skin would be:
   *   • every edge behaviour that depends on knowing you are touching — the
   *     alignment constraint, the scrape drag, the scrape VFX — needs the
   *     contact to SURVIVE to the next query, and pushing out to zero depth
   *     loses it (that bug shipped once: a kart visibly scraping a barrier with
   *     none of the scraping behaviour running);
   *   • it turns the edge into a band you can be *inside* rather than a plane
   *     you bounce off, which is the whole point of "friction, not collision".
   * 0.16 m of probe depth ≈ 0.13 m of chassis overlap: you lean on the rail.
   */
  vergeAllow: 0.16,
  /**
   * Fraction of the inward momentum that is RE-AIMED along the edge instead of
   * absorbed. This is the single number that makes the edge friction-only: at
   * 0.9 a 60° arrival keeps ~95 % of its speed (pointed down the barrier)
   * instead of the ~50 % that simply deleting the normal component would cost.
   */
  vergeGlide: 0.9,
  /** Whisper of a bounce, so a square arrival is nudged free instead of glued. */
  vergeRest: 0.05,
  /**
   * Continuous scrape drag while overlapping the edge barrier, 1/s at full
   * lean. Scaled by how hard you are insisting on it (steering into it, sitting
   * nose-in, or buried in the band) and by nothing else. Deliberately NOT
   * driven by residual inward velocity: the alignment constraint suppresses
   * that to near zero, which would make edge-riding free.
   */
  vergeContactDrag: 0.55,
  /** Floor on that lean, so merely touching the edge still costs steadily. */
  vergePressFloor: 0.35,

  // --- class 3: solid scenery ----------------------------------------------
  /** Architecture gets a firm push-out. 12 mm keeps the contact alive. */
  solidSkin: 0.012,
  /** As `vergeGlide`, a little less generous — a wall is a wall. */
  solidGlide: 0.6,
  /** Bounce off a building. 0.22 of the closing speed comes back. */
  solidRest: 0.22,
  /**
   * One-time cost of a near-head-on shunt into scenery:
   * `retain = 1 - solidScrub · smoothstep((sin A - solidKnee)/solidSpan)`.
   * The knee is what makes a scrape free: at 10° and 30° this term is 0 and
   * ~0.09, at 60° and 90° it is the full cost. Charged ONCE per contact.
   */
  solidScrub: 0.5,
  solidKnee: 0.35,
  solidSpan: 0.55,
  /** Continuous drag while scraping along architecture, 1/s at full lean. */
  solidContactDrag: 1.15,

  // --- classification -------------------------------------------------------
  /**
   * Height above the chassis at which we re-probe to ask "is this thing tall?".
   * `Track.collideWalls` rejects a query more than 0.7 m above the wall top, so
   * a probe 3.6 m up clears every edge barrier in the game (guardrail 0.62,
   * concrete 0.95, timber 1.0, energy rail 1.15, chain-link 2.5) and still hits
   * a rock face (6.5) or a building façade (9.0). One extra query, only while
   * actually in contact.
   */
  solidProbeLift: 3.6,
  /** |n·roadNormal| above this: the contact normal is tilted out of the road
   *  plane, so it is not a lateral track boundary. Scenery. */
  solidTiltDot: 0.35,
  /** |n·roadBinormal| below this: the contact normal does not point across the
   *  road, so it is not a track edge either. Scenery. */
  vergeAlignDot: 0.8,

  // --- sustained contact bookkeeping ---------------------------------------
  /** Seconds after the last touch before a new solid IMPACT can be charged. */
  contactGrace: 0.25,
  /** Extra grace (and so extra chassis-alignment help) for a square hit. */
  graceAngleBonus: 0.55,
  /** Inside the grace, a hit this many times harder still counts as an impact. */
  reHitFactor: 1.6,
  reHitFloor: 3.0,
  /** Nose-in angle, in units of `-forward·n`, that counts as a full lean. */
  rubNoseRef: 0.9,
  /** Below this along-wall speed the wall-plane direction is numerically junk. */
  glideMinTan: 0.5,

  // --- events ---------------------------------------------------------------
  /**
   * A verge scrape publishes `kart:wallHit` with an intensity BELOW the audio
   * layer's 0.32 "hard hit" threshold, which is what turns it into a sustained
   * scrape loop plus a light continuous spark rake instead of an impact bang.
   * `impact = vergeScrapeBase + alongWallSpeed · vergeScrapeScale`, capped.
   */
  vergeScrapeBase: 0.1,
  vergeScrapeScale: 0.006,
  vergeScrapeMax: 0.3,
  /** Along-wall speed below which a scrape is silent. */
  scrapeMinTan: 3.0,
  /** The player's scrape must retrigger inside the audio scrape's 0.18 s tail. */
  scrapeCooldownPlayer: 0.15,
  /** AI karts scrape far less often — 12 of them at 0.15 s is a wall of noise. */
  scrapeCooldownAi: 0.45,
  /** Impact (m/s) below which a solid hit doesn't bother the VFX/audio layer. */
  wallEventMin: 1.6,
  wallEventCooldown: 0.18,

  /** A shunt squarer than this, above `driftBreakSpeed` of top speed, breaks a
   *  drift. SOLID CONTACT ONLY — the verge must never break a drift. */
  driftBreakSin: 0.85,
  driftBreakSpeed: 0.5,

  /** Kart↔kart collision radius as a fraction of the chassis half-length. */
  kartRadius: 0.88,
  kartRestitution: 0.5,
  /** Extra shove the heavier kart gets, on top of the inverse-mass split. */
  massShove: 0.4,
  /** Positional correction per step — under 1 to avoid pumping/jitter. */
  separation: 0.65,
  bumpBoost: 0.24,
  bumpStrength: 0.5,
  /** Anti-gravity contact: both karts get a real spin-boost. */
  agBoost: 0.75,
  agStrength: 0.9,
  hitEventCooldown: 0.22,

  /**
   * Seconds the loaded wheel must sit on `Void` ground before recovery engages.
   * THIS IS THE MARGIN the playtester asked for. `Track.raycastGround` only
   * answers at all out to `corridor + 0.4 m`, so without a grace the respawn
   * fired 0.4 m past the shoulder edge — while the kart was still, to the
   * player, on the track. 0.45 s is ~11 m of travel at racing speed.
   */
  voidGrace: 0.45,
  /** ...and it drains at this multiple of real time once you are back on. */
  voidRecover: 2.0,

  /** Airborne for this long with no ground beneath → respawn. */
  fallTimeout: 2.4,
  fallSpeed: 5.0,
} as const;

// --- module-level scratch --------------------------------------------------
const _probe = new THREE.Vector3();
const _lift = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _d = new THREE.Vector3();
const _hitPos = new THREE.Vector3();
const _push = new THREE.Vector3();
const _hitN = new THREE.Vector3();
const _hitP = new THREE.Vector3();
const _vergeN = new THREE.Vector3();
const _vergeP = new THREE.Vector3();
const _solidN = new THREE.Vector3();
const _solidP = new THREE.Vector3();

// ---------------------------------------------------------------------------
//  Classification
// ---------------------------------------------------------------------------

/**
 * Verge (track edge) or Solid (architecture)? Three signals, cheapest first:
 *
 *  1. **Whatever the track service tells us.** `WallHit` has no class field
 *     today; if it gains `solid` or `style` we use it and stop guessing. This is
 *     the change requested from `src/track/*` — see the report.
 *
 *  2. **Normal orientation, in the road's own frame.** Every track-boundary
 *     barrier in `Track.collideWalls` has its normal exactly along ∓binormal:
 *     horizontal, and pointing across the road. A normal that is tilted out of
 *     the road plane, or that does not point across the road, cannot be a track
 *     edge — so any future prop/mesh collider classifies as Solid for free.
 *
 *  3. **Is the thing tall?** One extra `collideWalls` 3.6 m up. Every edge
 *     barrier the game authors is under 2.5 m; a rock face is 6.5 m and a
 *     building façade 9.0 m. This is the signal that separates P0b-6's
 *     "buildings" from P0b-5's "edge of the track" without a track change.
 *
 * @param hint  the hit we are classifying — read BEFORE any re-query, because
 *              `collideWalls` returns a shared mutable object.
 */
function classifyContact(
  b: KartBody,
  track: ITrackService,
  hint: WallHitEx,
  probe: THREE.Vector3,
  radius: number,
  n: THREE.Vector3,
): Contact {
  // 1 — the track service's own answer, if it has one.
  if (hint.solid === true) return Contact.Solid;
  if (hint.solid === false) return Contact.Verge;
  const style = hint.style;
  if (typeof style === 'string') {
    return (SOLID_STYLES as readonly string[]).includes(style) ? Contact.Solid : Contact.Verge;
  }

  // 2 — geometry. `roadNormal` / `roadBinormal` were published by
  // `resolveSurface` earlier in this same tick, so this costs no projection.
  if (Math.abs(n.dot(b.roadNormal)) > COLL.solidTiltDot) return Contact.Solid;
  if (Math.abs(n.dot(b.roadBinormal)) < COLL.vergeAlignDot) return Contact.Solid;

  // 3 — tall mass?
  _lift.copy(probe).addScaledVector(b.up, COLL.solidProbeLift);
  const hi = track.collideWalls(_lift, radius);
  if (hi.hit && hi.depth > 1e-4 && Math.abs(hi.normal.dot(n)) > 0.7) return Contact.Solid;

  return Contact.Verge;
}

// ---------------------------------------------------------------------------
//  Track contact
// ---------------------------------------------------------------------------

export function resolveWalls(b: KartBody, track: ITrackService, dt: number): void {
  if (b.respawnTime > 0) return;
  if (b.wallCooldown > 0) b.wallCooldown = Math.max(0, b.wallCooldown - dt);
  if (b.wallGrace > 0) b.wallGrace = Math.max(0, b.wallGrace - dt);

  const t = b.tuning;
  const radius = t.halfExtents.x * COLL.wallRadius;
  const probeZ = t.halfExtents.z * COLL.wallProbe;

  // ---- gather: two probes (nose + tail), ONE resolution --------------------
  // Two probes rather than one sphere at the CoM so the kart cannot clip a
  // corner in. The positional push takes the deepest residual PER NORMAL (never
  // the sum), so two probes on one barrier don't eject the chassis twice as far
  // as it needs — which used to bounce it straight back into the barrier.
  _push.set(0, 0, 0);
  let vergeDepth = 0;
  let solidDepth = 0;

  for (let p = 0; p < 2; p++) {
    const s = p === 0 ? 1 : -1; // +1 = nose, -1 = tail
    _probe.copy(b.position).addScaledVector(b.forward, s * probeZ);

    const hit = track.collideWalls(_probe, radius) as WallHitEx;
    if (!hit.hit || hit.depth <= 1e-4) continue;

    // Copy everything out FIRST: `collideWalls` hands back a shared mutable
    // object and `classifyContact` queries it again.
    const depth = hit.depth;
    _hitN.copy(hit.normal);
    const nl = _hitN.lengthSq();
    if (nl < 1e-8) continue;
    if (Math.abs(nl - 1) > 1e-3) _hitN.multiplyScalar(1 / Math.sqrt(nl));
    _hitP.copy(hit.point);

    const cls = classifyContact(b, track, hit, _probe, radius, _hitN);

    const allow = cls === Contact.Solid ? COLL.solidSkin : COLL.vergeAllow;
    const residual = depth - allow - _push.dot(_hitN);
    if (residual > 0) _push.addScaledVector(_hitN, residual);

    if (cls === Contact.Solid) {
      if (depth > solidDepth) {
        solidDepth = depth;
        _solidN.copy(_hitN);
        _solidP.copy(_hitP);
      }
    } else if (depth > vergeDepth) {
      vergeDepth = depth;
      _vergeN.copy(_hitN);
      _vergeP.copy(_hitP);
    }
  }

  if (solidDepth <= 0 && vergeDepth <= 0) {
    b.wallContact = false;
    b.contactClass = Contact.None;
    return;
  }

  b.wallContact = true;
  b.position.add(_push);

  // Both at once (nose in a rail, tail in a wall) is rare; the harder
  // constraint wins the velocity response.
  const solid = solidDepth > 0;
  b.contactClass = solid ? Contact.Solid : Contact.Verge;
  _n.copy(solid ? _solidN : _vergeN);
  _hitPos.copy(solid ? _solidP : _vergeP);
  // Published for the yaw model: see PHYS.wallAlignRate in KartPhysics.
  b.wallNormal.copy(_n);

  const speed = b.velocity.length();
  const vn = b.velocity.dot(_n);
  const impact = vn < 0 ? -vn : 0;
  const sinA = speed > 0.05 ? clamp01(impact / speed) : 0;
  const depth = solid ? solidDepth : vergeDepth;

  // Everything that isn't going into the barrier. The kart leaves along this.
  _tan.copy(b.velocity).addScaledVector(_n, -vn);
  const tanLen = _tan.length();

  let fresh = false;
  if (solid) {
    fresh = solidImpact(b, speed, vn, impact, sinA, tanLen);
  } else {
    // ---- CLASS 1: THE VERGE. Friction only, every tick, no exceptions. -----
    // Redirect rather than absorb, so the edge can never take your speed for
    // free. `budget = speed` — there is no scrub here at all.
    redirect(b, speed, vn, tanLen, COLL.vergeGlide, COLL.vergeRest);
  }

  // ---- continuous drag ----------------------------------------------------
  if (!fresh) {
    const press = leanOnBarrier(b, depth, radius);
    if (press > 1e-3) {
      const rate = solid ? COLL.solidContactDrag : COLL.vergeContactDrag;
      // In-plane only: the vertical component is suspension business, not the
      // barrier's, and rubbing it would fight the springs on any slope.
      const rub = 1 - Math.exp(-rate * press * dt);
      const vUpC = b.velocity.dot(b.up);
      b.velocity.addScaledVector(b.up, -vUpC).multiplyScalar(1 - rub);
      b.velocity.addScaledVector(b.up, vUpC);
    }
    b.wallGrace = COLL.contactGrace;
  }

  syncVelocityReadouts(b);
  publishContact(b, fresh, impact, tanLen);
}

/**
 * Take the momentum aimed INTO the barrier and re-aim `glide` of it along the
 * barrier, keeping the rest as a small bounce. Magnitude is clamped so this can
 * never add energy — the fuzz test depends on that being provably true.
 */
function redirect(
  b: KartBody,
  speed: number,
  vn: number,
  tanLen: number,
  glide: number,
  rest: number,
  budget = speed,
): void {
  if (vn >= 0) return;
  if (tanLen > COLL.glideMinTan) {
    let newTan = tanLen + glide * (budget - tanLen);
    if (newTan > budget) newTan = budget;
    if (newTan < 0) newTan = 0;
    _tan.multiplyScalar(newTan / tanLen);
  } else {
    // Dead square onto the barrier: no usable in-plane direction. Pure bounce.
    _tan.set(0, 0, 0);
  }
  b.velocity.copy(_tan).addScaledVector(_n, -vn * rest);
  const outSq = b.velocity.lengthSq();
  const cap = Math.max(speed, budget);
  if (outSq > cap * cap && outSq > 1e-8) b.velocity.multiplyScalar(cap / Math.sqrt(outSq));
}

/**
 * CLASS 3, impact half. A genuine near-head-on shunt into architecture, charged
 * once per contact. Returns true if this tick WAS that shunt (so the caller
 * skips the continuous drag — the two must not stack).
 *
 * Everything shallower falls through to `redirect` + drag, i.e. scraping along a
 * building is a friction contact just like the verge, only stiffer.
 */
function solidImpact(
  b: KartBody,
  speed: number,
  vn: number,
  impact: number,
  sinA: number,
  tanLen: number,
): boolean {
  const fresh =
    impact > 0 &&
    speed > 0.05 &&
    sinA > COLL.solidKnee &&
    (b.wallGrace <= 0 || impact > b.wallImpactRef * COLL.reHitFactor + COLL.reHitFloor);

  if (!fresh) {
    redirect(b, speed, vn, tanLen, COLL.solidGlide, COLL.solidRest);
    return false;
  }

  const retain =
    1 - COLL.solidScrub * smoothstep((sinA - COLL.solidKnee) / COLL.solidSpan);
  redirect(b, speed, vn, tanLen, COLL.solidGlide, COLL.solidRest, speed * retain);

  b.wallImpacts++;
  b.solidImpacts++;
  b.wallImpactRef = impact;
  b.wallGrace = COLL.contactGrace + COLL.graceAngleBonus * sinA;

  // Only a near-head-on shunt at speed breaks a drift. Never the verge.
  if (
    b.driftPhase === DriftPhase.Drifting &&
    sinA > COLL.driftBreakSin &&
    speed > b.tuning.maxSpeed * COLL.driftBreakSpeed
  ) {
    cancelDrift(b, false);
  }
  return true;
}

/**
 * How hard the kart is *insisting* on the barrier, 0..1 — the multiplier on the
 * continuous drag. Whichever is largest of: how far into the band you are,
 * how much lock you are holding into it, and how nose-in you are lying against
 * it. Floored at `vergePressFloor` so mere contact still costs time steadily,
 * which is the "scrubbing through gravel" the design asks for.
 */
function leanOnBarrier(b: KartBody, depth: number, radius: number): number {
  _cross.crossVectors(b.up, b.forward);
  const outward = _cross.dot(_n) >= 0 ? 1 : -1;
  const lean = clamp01(b.steerCmd * outward);
  const noseIn = clamp01(-b.forward.dot(_n) / COLL.rubNoseRef);
  const buried = clamp01(depth / Math.max(0.05, radius));
  let press = lean > noseIn ? lean : noseIn;
  if (buried > press) press = buried;
  return COLL.vergePressFloor + (1 - COLL.vergePressFloor) * press;
}

/**
 * One `kart:wallHit` per contact tick group. The verge deliberately publishes a
 * LOW intensity so downstream reads it as a sustained scrape (see the audio
 * layer's 0.32 threshold) — a continuous rake of sparks and a rumble, never an
 * impact burst. A solid shunt publishes the real closing speed.
 */
function publishContact(b: KartBody, fresh: boolean, impact: number, tanLen: number): void {
  if (b.wallCooldown > 0) return;

  // The ONLY impact burst left in the game: the one-time near-head-on shunt into
  // architecture. Everything else — including a 30° scrape along a building —
  // publishes a scrape.
  if (fresh) {
    if (impact > COLL.wallEventMin) {
      b.wallCooldown = COLL.wallEventCooldown;
      bus.emit('kart:wallHit', { kartId: b.id, position: _hitPos, impact, normal: _n });
    }
    return;
  }

  if (tanLen < COLL.scrapeMinTan) return;
  b.wallCooldown = b.state.isPlayer ? COLL.scrapeCooldownPlayer : COLL.scrapeCooldownAi;
  b.scrapeEvents++;
  const ev = Math.min(
    COLL.vergeScrapeMax,
    COLL.vergeScrapeBase + tanLen * COLL.vergeScrapeScale,
  );
  bus.emit('kart:wallHit', { kartId: b.id, position: _hitPos, impact: ev, normal: _n });
}

// ---------------------------------------------------------------------------
//  Kart ↔ kart
// ---------------------------------------------------------------------------

export function resolveKartPairs(bodies: KartBody[], dt: number): void {
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    if (a.bumpCooldown > 0) a.bumpCooldown = Math.max(0, a.bumpCooldown - dt);
  }

  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    if (a.respawnTime > 0) continue;
    const ra = a.tuning.halfExtents.z * COLL.kartRadius;

    for (let j = i + 1; j < n; j++) {
      const c = bodies[j];
      if (c.respawnTime > 0) continue;

      _d.copy(c.position).sub(a.position);
      const rSum = ra + c.tuning.halfExtents.z * COLL.kartRadius;
      const distSq = _d.lengthSq();
      if (distSq > rSum * rSum || distSq < 1e-8) continue;

      // Vertical separation check: one kart flying over another must not shove.
      const vertical = Math.abs(_d.dot(a.up));
      const clearance = a.tuning.halfExtents.y + c.tuning.halfExtents.y + 0.45;
      if (vertical > clearance) continue;

      const dist = Math.sqrt(distSq);
      _n.copy(_d).multiplyScalar(1 / dist); // a → c
      const pen = rSum - dist;

      const ma = a.tuning.mass;
      const mc = c.tuning.mass;
      const ia = 1 / ma;
      const ic = 1 / mc;
      const iSum = ia + ic;

      // --- separate ---------------------------------------------------------
      const push = pen * COLL.separation;
      a.position.addScaledVector(_n, -push * (ia / iSum));
      c.position.addScaledVector(_n, push * (ic / iSum));

      // --- impulse ----------------------------------------------------------
      const vaN = a.velocity.dot(_n);
      const vcN = c.velocity.dot(_n);
      const closing = vaN - vcN; // > 0 → approaching
      if (closing > 0) {
        const e = COLL.kartRestitution;
        const jm = ((1 + e) * closing) / iSum;
        a.velocity.addScaledVector(_n, -jm * ia);
        c.velocity.addScaledVector(_n, jm * ic);

        // Mass authority: the heavier kart also gets a free extra shove, so
        // weight reads as *presence* and not just as a slower separation.
        const bias = ((ma - mc) / (ma + mc)) * COLL.massShove * closing;
        if (bias > 0) c.velocity.addScaledVector(_n, bias);
        else a.velocity.addScaledVector(_n, bias);

        syncVelocityReadouts(a);
        syncVelocityReadouts(c);

        // --- rewards --------------------------------------------------------
        if (a.antiGravity || c.antiGravity) {
          // Anti-gravity: contact is a *mechanic*, not a mistake.
          applyBoostTo(a, COLL.agBoost, COLL.agStrength, 'item');
          applyBoostTo(c, COLL.agBoost, COLL.agStrength, 'item');
        } else if (closing > 2.5) {
          // Aggressor = whoever was driving into the other one harder.
          const aggressor = vaN > -vcN ? a : c;
          if (aggressor.bumpCooldown <= 0) {
            aggressor.bumpCooldown = 0.5;
            applyBoostTo(aggressor, COLL.bumpBoost, COLL.bumpStrength, 'item');
          }
        }

        if (closing > 1.4 && a.wallCooldown <= 0) {
          a.wallCooldown = COLL.hitEventCooldown;
          _hitPos.copy(a.position).addScaledVector(_n, ra);
          bus.emit('kart:kartHit', { a: a.id, b: c.id, impact: closing, position: _hitPos });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  CLASS 2 — out of bounds / recovery
// ---------------------------------------------------------------------------

/**
 * The ONLY path that pulls a kart back. Nothing here fires while the kart is
 * merely scraping the edge — that is `Contact.Verge`'s job and it costs speed,
 * not the run.
 *
 * Three triggers, in order of certainty:
 *   • `isOutOfBounds` — the track says the kart is outside the playable volume.
 *     On the shipping track that is ~9 m beyond the barrier, i.e. far outside
 *     the friction band.
 *   • grounded on `Void` for longer than `voidGrace`. The grace is the point:
 *     `Track.raycastGround` still answers 0.4 m past the shoulder edge and
 *     classifies it `Void`, so the old first-tick respawn yanked karts back
 *     while they were, to the player, still on the road.
 *   • a long fall with nothing underneath. Gliding and anti-gravity are exempt.
 */
export function checkBounds(b: KartBody, track: ITrackService, dt: number): void {
  if (b.respawnTime > 0) {
    b.voidTime = 0;
    return;
  }

  if (track.isOutOfBounds(b.position)) {
    beginRespawn(b, track);
    return;
  }

  if (b.grounded && b.surface === SurfaceType.Void) {
    b.voidTime += dt;
    if (b.voidTime > COLL.voidGrace) {
      b.voidTime = 0;
      beginRespawn(b, track);
      return;
    }
  } else if (b.voidTime > 0) {
    b.voidTime = Math.max(0, b.voidTime - dt * COLL.voidRecover);
  }

  if (!b.grounded && !b.gliding && !b.antiGravity) {
    b.fallTime += dt;
    const falling = b.velocity.y < -COLL.fallSpeed;
    if (b.fallTime > COLL.fallTimeout && falling) {
      beginRespawn(b, track);
    }
  } else {
    b.fallTime = 0;
  }
}
