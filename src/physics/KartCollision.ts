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
 *  plane, keep almost all of the tangential component, take a percentage cut
 *  scaled by how square the hit was, and add a small bounce so contact reads.
 *  A glancing scrape costs you ~2 %. A 30° clout costs ~25 %. Only a genuinely
 *  head-on impact stops you, and even then you rebound rather than stick.
 *
 *  The wall query is run at TWO probe points (nose and tail) rather than one
 *  sphere at the centre of mass. That costs one extra query and buys two things
 *  a single sphere can't give you: the kart can't clip a corner in, and the
 *  off-centre impulse produces a yaw kick that ROTATES THE KART ALONG THE WALL.
 *  That auto-alignment is why sliding down a guardrail in MK8 feels helpful
 *  instead of hostile.
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
  /** How much of the normal closing speed comes back as a bounce. */
  restitution: 0.16,
  /** Tangential speed cut, linear in sin(impact angle). 0.27 → 25 % total at 30°. */
  scrubBase: 0.27,
  /** Extra cut that only bites near head-on. */
  scrubHead: 0.46,
  /** Floor on the tangential retention for anything but a square hit. */
  slideFloor: 0.34,
  /** Yaw kick authority, rad/s per m/s of normal closing speed. */
  yawKick: 0.085,
  yawKickMax: 2.2,
  /** Impact (m/s) below which we don't bother the VFX/audio layer. */
  wallEventMin: 1.6,
  wallEventCooldown: 0.18,
  /** A hit squarer than this, above 35 % of top speed, breaks a drift. */
  driftBreakSin: 0.62,

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

// ---------------------------------------------------------------------------
//  Walls
// ---------------------------------------------------------------------------

export function resolveWalls(b: KartBody, track: ITrackService, dt: number): void {
  if (b.respawnTime > 0) return;
  if (b.wallCooldown > 0) b.wallCooldown = Math.max(0, b.wallCooldown - dt);

  const t = b.tuning;
  const radius = t.halfExtents.x * COLL.wallRadius;
  const probeZ = t.halfExtents.z * COLL.wallProbe;

  let worstImpact = 0;

  for (let p = 0; p < 2; p++) {
    const s = p === 0 ? 1 : -1; // +1 = nose, -1 = tail
    _probe.copy(b.position).addScaledVector(b.forward, s * probeZ);

    const hit = track.collideWalls(_probe, radius);
    if (!hit.hit || hit.depth <= 1e-4) continue;

    _n.copy(hit.normal);
    const nl = _n.lengthSq();
    if (nl < 1e-8) continue;
    if (Math.abs(nl - 1) > 1e-3) _n.multiplyScalar(1 / Math.sqrt(nl));
    const depth = hit.depth;

    // --- positional: push straight out, no more than needed ------------------
    b.position.addScaledVector(_n, depth);

    // --- velocity: SLIDE ----------------------------------------------------
    const speed = b.velocity.length();
    const vn = b.velocity.dot(_n);
    if (vn < 0 && speed > 0.05) {
      const sinA = clamp01(-vn / speed);

      // Tangential part = everything that isn't going into the wall.
      _tan.copy(b.velocity).addScaledVector(_n, -vn);

      // Scrub: linear in the impact angle, with an extra bite near head-on so a
      // full-speed face-plant still reads as an accident.
      let keep =
        1 - COLL.scrubBase * sinA - COLL.scrubHead * smoothstep((sinA - 0.7) / 0.3);
      if (sinA < 0.92) keep = Math.max(keep, COLL.slideFloor);
      keep = clamp01(keep);

      _tan.multiplyScalar(keep);
      // Small bounce so contact is felt, never enough to launch you into traffic.
      b.velocity.copy(_tan).addScaledVector(_n, -vn * COLL.restitution);

      // --- yaw kick: rotate along the wall ---------------------------------
      // tau = (r × F)·up, with r the probe offset and F along the normal. A nose
      // hit turns the nose away from the wall; a tail hit swings the tail in.
      _r.copy(b.forward).multiplyScalar(s * probeZ);
      _cross.crossVectors(_r, _n);
      const spin = _cross.dot(b.up) * COLL.yawKick * (-vn);
      b.yawRate += clamp(spin, -COLL.yawKickMax, COLL.yawKickMax);

      const impact = -vn;
      if (impact > worstImpact) {
        worstImpact = impact;
        _hitPos.copy(hit.point);
      }

      // Heavy, square hits break the drift; scrapes must not.
      if (
        b.driftPhase === DriftPhase.Drifting &&
        sinA > COLL.driftBreakSin &&
        speed > t.maxSpeed * 0.35
      ) {
        cancelDrift(b, false);
      }
    } else if (vn < 0) {
      // Effectively stationary against the wall: just kill the inward creep.
      b.velocity.addScaledVector(_n, -vn);
    }
  }

  if (worstImpact > 0) {
    syncVelocityReadouts(b);
    if (worstImpact > COLL.wallEventMin && b.wallCooldown <= 0) {
      b.wallCooldown = COLL.wallEventCooldown;
      bus.emit('kart:wallHit', {
        kartId: b.id,
        position: _hitPos,
        impact: worstImpact,
        normal: _n,
      });
    }
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
