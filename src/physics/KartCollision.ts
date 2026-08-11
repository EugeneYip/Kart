/**
 * ============================================================================
 *  APEX KART — COLLISION RESPONSE
 * ============================================================================
 *  Three jobs: walls, karts, and falling off the world.
 *
 *  THE ONE RULE: **a wall must never stop the kart dead.** Killing velocity on
 *  contact is the single worst-feeling bug a kart racer can have — it turns
 *  every barrier into a punishment wall and makes the track feel like a corridor
 *  of glue. So the response is a SLIDE: project the velocity onto the wall
 *  plane, keep almost all of it, take a cut scaled by sin(impact angle), and let
 *  part of the lost normal momentum become along-wall GLIDE so a steep hit
 *  scrapes forward instead of rebounding. 5° costs ~2 %, 30° ~15 %, and even a
 *  60° clout keeps over half its speed pointed down the barrier.
 *
 *  ── THE BUG THIS FILE WAS REWRITTEN FOR ────────────────────────────────────
 *  The response above was already per-*event* correct, and the game still felt
 *  like touching a wall ended your run. The reason was that it ran per *tick*,
 *  twice (nose probe and tail probe), at 120 Hz. A kart merely leaning on a
 *  barrier took ~240 impact penalties a second: measured, three seconds of light
 *  steering pressure against a wall took 18 m/s down to **0.03 m/s — a 99.9 %
 *  loss**, i.e. a dead stop, from contact no player would even call a mistake.
 *  Worse, the yaw kick was also applied per tick and un-scaled by `dt`, so it
 *  fed the chassis back into the wall and the loop sustained itself.
 *
 *  So contact is now explicitly two different things:
 *    • IMPACT   — the first tick of a new contact. Angle-scaled speed cut,
 *                 alignment kick, spark, drift-break check. Once.
 *    • SUSTAINED— every tick after, for `contactGrace` seconds past the last
 *                 touch. Velocity is projected onto the wall plane and charged a
 *                 small `dt`-scaled rub, proportional to how hard you are
 *                 leaning on it. No re-penalty, no kick, no drift break.
 *  A genuinely harder hit (`reHitFactor`) still escalates back to IMPACT, so
 *  brushing a wall and then slamming it is not laundered into a free pass.
 *
 *  The wall query is run at TWO probe points (nose and tail) rather than one
 *  sphere at the centre of mass. That costs one extra query and buys two things
 *  a single sphere can't give you: the kart can't clip a corner in, and the
 *  off-centre impulse produces a yaw kick that ROTATES THE KART ALONG THE WALL.
 *  That auto-alignment is why sliding down a guardrail in MK8 feels helpful
 *  instead of hostile. Both probes contribute to ONE resolution per tick: the
 *  positional push takes the deepest residual per normal (never the sum) and the
 *  alignment torques are summed, so a kart lying flat against a wall gets no net
 *  rotation instead of two competing kicks.
 *
 *  Kart↔kart is a mass-weighted elastic push-apart. Inverse-mass distribution
 *  means a 280 kg heavyweight genuinely shoves a 148 kg featherweight, and a
 *  bump-boost rewards the aggressor. In anti-gravity, contact instead grants
 *  BOTH karts a spin-boost — the MK8U rule that turns anti-grav sections from a
 *  hazard into a playground.
 * ============================================================================
 */

import * as THREE from 'three';
import type { ITrackService } from '@/core/Types';
import { SurfaceType } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { clamp, clamp01, smoothstep } from '@/core/MathUtils';
import type { KartBody } from './KartPhysics';
import {
  DriftPhase,
  applyBoostTo,
  beginRespawn,
  cancelDrift,
  syncVelocityReadouts,
} from './KartPhysics';

export const COLL = {
  /** Wall probe sphere radius as a fraction of the chassis half-width. */
  wallRadius: 1.04,
  /** Nose/tail probe offset as a fraction of the chassis half-length. */
  wallProbe: 0.58,
  /**
   * Penetration deliberately LEFT unresolved, metres. Pushing a sliding kart out
   * to exactly zero depth makes the next query return depth ≈ 0, the contact is
   * lost, and every wall-contact behaviour that depends on knowing you are
   * touching — the alignment constraint, the grind rub, the sparks — silently
   * stops working while the kart is visibly scraping along the barrier. 12 mm is
   * far inside the barrier's own art and buys a stable, persistent contact.
   */
  wallSkin: 0.012,

  // --- impact: how much speed a single hit costs ----------------------------
  /**
   * Retained speed = `1 - scrubBase·sin(A) - scrubHead·smoothstep(...)`, floored
   * at `retainFloor`. Linear in sin(A) by design: a graze is nearly free and only
   * a genuinely square hit is expensive. Measured at 30 m/s, entry → exit:
   *   5° 98 %   15° 93 %   30° 87 %   60° 59 %   90° 34 %
   */
  scrubBase: 0.26,
  scrubHead: 0.3,
  scrubHeadKnee: 0.6,
  scrubHeadSpan: 0.4,
  /** Hard floor on retention. A wall may take most of your speed, never all. */
  retainFloor: 0.4,
  /**
   * Fraction of the momentum lost to the wall that is re-aimed ALONG the wall
   * instead of thrown back at you. This is what turns a 60° clout into a scrape
   * down the barrier rather than a rebound into oncoming traffic, and it is why
   * a steep hit still keeps > 50 % of its speed.
   */
  wallGlide: 0.55,
  /** Below this along-wall speed the wall-plane direction is numerically junk. */
  glideMinTan: 0.5,
  /** Normal bounce: `restBase + restSquare·sin²(A)`. Gentle when glancing (so a
   *  graze doesn't shove you off your line) and springier when square. */
  restBase: 0.14,
  restSquare: 0.2,

  // --- sustained contact ----------------------------------------------------
  /** Seconds after the last touch before a new IMPACT can be charged. */
  contactGrace: 0.25,
  /** Extra grace (and so extra chassis-alignment help) for a square hit. */
  graceAngleBonus: 0.55,
  /** Inside the grace, a hit this many times harder still counts as an impact. */
  reHitFactor: 1.6,
  reHitFloor: 3.0,
  /**
   * Rub drag while grinding, 1/s at full lean. Scaled by how hard you are
   * *insisting* on the wall — steering into it, or sitting nose-in — and by
   * nothing else, so barely touching a barrier is barely noticeable while
   * holding full lock against one costs ~59 % over three seconds. Deliberately
   * NOT driven by the residual inward velocity: the wall-alignment constraint in
   * KartPhysics suppresses that to near zero, which would make wall-riding free.
   */
  rubDrag: 0.3,
  /** Nose-in angle, in units of `-forward·n`, that counts as a full lean. */
  rubNoseRef: 0.9,

  /** Yaw kick authority, rad/s per m/s of normal closing speed. Deliberately
   *  small and tightly clamped: this exists to ALIGN the kart with the wall, not
   *  to spin it out. A graze must never cost you the nose. */
  yawKick: 0.05,
  yawKickMax: 1.1,
  /** Impact (m/s) below which we don't bother the VFX/audio layer. */
  wallEventMin: 1.6,
  wallEventCooldown: 0.18,
  /** Along-wall speed → synthetic impact, so a grind still throws sparks. */
  scrapeEventScale: 0.12,
  /** A hit squarer than this (≈53°), above `driftBreakSpeed` of top speed, breaks
   *  a drift. Only a near-head-on shunt — scrapes and clouts must not. */
  driftBreakSin: 0.8,
  driftBreakSpeed: 0.45,

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

  /** Airborne for this long with no ground beneath → respawn. */
  fallTimeout: 2.4,
  fallSpeed: 5.0,
} as const;

// --- module-level scratch --------------------------------------------------
const _probe = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _r = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _d = new THREE.Vector3();
const _hitPos = new THREE.Vector3();
const _push = new THREE.Vector3();
const _bestN = new THREE.Vector3();

// ---------------------------------------------------------------------------
//  Walls
// ---------------------------------------------------------------------------

export function resolveWalls(b: KartBody, track: ITrackService, dt: number): void {
  if (b.respawnTime > 0) return;
  if (b.wallCooldown > 0) b.wallCooldown = Math.max(0, b.wallCooldown - dt);
  if (b.wallGrace > 0) b.wallGrace = Math.max(0, b.wallGrace - dt);

  const t = b.tuning;
  const radius = t.halfExtents.x * COLL.wallRadius;
  const probeZ = t.halfExtents.z * COLL.wallProbe;

  // ---- gather: both probes, ONE resolution -------------------------------
  _push.set(0, 0, 0);
  let bestDepth = 0;
  let torque = 0;

  for (let p = 0; p < 2; p++) {
    const s = p === 0 ? 1 : -1; // +1 = nose, -1 = tail
    _probe.copy(b.position).addScaledVector(b.forward, s * probeZ);

    const hit = track.collideWalls(_probe, radius);
    if (!hit.hit || hit.depth <= 1e-4) continue;

    _n.copy(hit.normal);
    const nl = _n.lengthSq();
    if (nl < 1e-8) continue;
    if (Math.abs(nl - 1) > 1e-3) _n.multiplyScalar(1 / Math.sqrt(nl));

    // Positional: only the residual not already covered along THIS normal, so
    // two probes on one wall don't eject the chassis twice as far as it needs
    // (which used to bounce the kart off and straight back into the barrier).
    // Two probes on DIFFERENT walls still each get their own correction.
    // `wallSkin` is left in on purpose so the contact survives to the next tick.
    const residual = hit.depth - COLL.wallSkin - _push.dot(_n);
    if (residual > 0) _push.addScaledVector(_n, residual);

    // tau = (r × F)·up, r = probe offset, F along the normal. A nose hit turns
    // the nose away from the wall, a tail hit swings the tail out. Depth-weighted
    // and SUMMED, so a kart lying flat against a wall nets ~zero rotation.
    _r.copy(b.forward).multiplyScalar(s * probeZ);
    _cross.crossVectors(_r, _n);
    torque += _cross.dot(b.up) * hit.depth;

    if (hit.depth > bestDepth) {
      bestDepth = hit.depth;
      _bestN.copy(_n);
      _hitPos.copy(hit.point);
    }
  }

  b.wallContact = bestDepth > 0;
  if (!b.wallContact) return;

  b.position.add(_push);
  _n.copy(_bestN);
  // Published for the yaw model: see PHYS.wallAlignRate in KartPhysics.
  b.wallNormal.copy(_n);

  const speed = b.velocity.length();
  const vn = b.velocity.dot(_n);
  const impact = vn < 0 ? -vn : 0;
  const sinA = speed > 0.05 ? clamp01(impact / speed) : 0;

  // Everything that isn't going into the wall. The kart leaves along this.
  _tan.copy(b.velocity).addScaledVector(_n, -vn);
  const tanLen = _tan.length();

  // A brand-new contact — or, inside the grace window, a hit genuinely harder
  // than the one that opened it. Everything else is a grind.
  const fresh =
    impact > 0 &&
    speed > 0.05 &&
    (b.wallGrace <= 0 || impact > b.wallImpactRef * COLL.reHitFactor + COLL.reHitFloor);

  if (fresh) {
    // ---- IMPACT ----------------------------------------------------------
    const retain = Math.max(
      COLL.retainFloor,
      1 -
        COLL.scrubBase * sinA -
        COLL.scrubHead *
          smoothstep((sinA - COLL.scrubHeadKnee) / COLL.scrubHeadSpan),
    );
    const budget = speed * retain;

    if (tanLen > COLL.glideMinTan) {
      // Glide: re-aim part of the lost normal momentum along the wall. For a
      // shallow hit `budget < tanLen`, so this is a scrub; for a steep one it is
      // a deflection — either way the total never exceeds `budget`.
      let newTan = tanLen + COLL.wallGlide * (budget - tanLen);
      if (newTan > budget) newTan = budget;
      if (newTan < 0) newTan = 0;
      _tan.multiplyScalar(newTan / tanLen);
    } else {
      // Dead square: no usable wall-plane direction. Pure rebound.
      _tan.set(0, 0, 0);
    }

    const rest = COLL.restBase + COLL.restSquare * sinA * sinA;
    b.velocity.copy(_tan).addScaledVector(_n, impact * rest);

    // Alignment kick. `torque / bestDepth` normalises out the depth weighting,
    // so the magnitude depends on the impact and the geometry, never on how far
    // the probe happened to be buried.
    const spin = (torque / bestDepth) * COLL.yawKick * impact;
    b.yawRate += clamp(spin, -COLL.yawKickMax, COLL.yawKickMax);

    b.wallImpacts++;
    b.wallImpactRef = impact;
    // The squarer the hit, the longer the chassis gets help aligning itself with
    // the barrier — MK8's "the wall spits you out pointing down the track".
    b.wallGrace = COLL.contactGrace + COLL.graceAngleBonus * sinA;

    // Only a near-head-on shunt at speed breaks a drift.
    if (
      b.driftPhase === DriftPhase.Drifting &&
      sinA > COLL.driftBreakSin &&
      speed > t.maxSpeed * COLL.driftBreakSpeed
    ) {
      cancelDrift(b, false);
    }
  } else {
    // ---- SUSTAINED CONTACT -----------------------------------------------
    // Kill the inward creep (never the outward part — the kart must be free to
    // leave) with NO bounce, since a bounce here would chatter at 120 Hz. Then
    // charge a rub scaled by how hard the kart is leaning on the barrier: either
    // steering into it, or lying nose-in against it.
    if (vn < 0) b.velocity.addScaledVector(_n, -vn);

    _cross.crossVectors(b.up, b.forward);
    const outward = _cross.dot(_n) >= 0 ? 1 : -1;
    const lean = clamp01(b.steerCmd * outward);
    const noseIn = clamp01(-b.forward.dot(_n) / COLL.rubNoseRef);
    const press = lean > noseIn ? lean : noseIn;
    if (press > 1e-3) {
      // In-plane only: the vertical component is suspension business, not the
      // barrier's, and rubbing it would fight the springs on any slope.
      const rub = 1 - Math.exp(-COLL.rubDrag * press * dt);
      const vUpC = b.velocity.dot(b.up);
      b.velocity.addScaledVector(b.up, -vUpC).multiplyScalar(1 - rub);
      b.velocity.addScaledVector(b.up, vUpC);
    }
    b.wallGrace = COLL.contactGrace;
  }

  syncVelocityReadouts(b);

  // Sparks. A grind reports a synthetic impact from its along-wall speed, so the
  // VFX layer keeps throwing sparks while you scrape instead of one lonely puff.
  const evImpact = fresh ? impact : Math.max(impact, tanLen * COLL.scrapeEventScale);
  if (evImpact > COLL.wallEventMin && b.wallCooldown <= 0) {
    b.wallCooldown = COLL.wallEventCooldown;
    bus.emit('kart:wallHit', {
      kartId: b.id,
      position: _hitPos,
      impact: evImpact,
      normal: _n,
    });
  }
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
//  Out of bounds
// ---------------------------------------------------------------------------

export function checkBounds(b: KartBody, track: ITrackService, dt: number): void {
  if (b.respawnTime > 0) return;

  if (track.isOutOfBounds(b.position)) {
    beginRespawn(b, track);
    return;
  }

  // Drowning / void surfaces respawn on contact.
  if (b.grounded && (b.surface === SurfaceType.Void || b.surface === SurfaceType.Water)) {
    if (b.surface === SurfaceType.Void) {
      beginRespawn(b, track);
      return;
    }
  }

  // A long fall with nothing under us. Gliding and anti-gravity are exempt —
  // both legitimately spend a long time off the deck.
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
