/**
 * ============================================================================
 *  FOXY KART — DRIFT, MINI-TURBO & TRICKS
 * ============================================================================
 *  The single most important system in the game. Everything about how FOXY KART
 *  *feels* comes down to the loop the player runs a thousand times a race:
 *
 *      hop → land into a drift → hold → sparks change colour → release → boost
 *
 *  Design decisions, and why:
 *
 *   1. A REAL HOP. Pressing drift launches the chassis (2.6 m/s, ~0.32 s of air
 *      at the reduced hop gravity). It isn't a canned animation — the kart is
 *      genuinely airborne, the suspension extends, and the landing squats. That
 *      physicality is why MK8's hop feels like a decision and not a button.
 *
 *   2. ONE PRESS ARMS ONE DRIFT; IT COMMITS THE MOMENT YOU ARE ACTUALLY
 *      CORNERING.  (P0g — owner: *"it is really hard to perform, it'd be better
 *      to have it removed unless it's easier to activate"*.)
 *
 *      This used to be the opposite: the drift engaged ONLY on the landing tick
 *      of the hop, and only if `|steer| >= 0.26` at that exact instant. Three
 *      things had to line up inside one 8 ms tick — press, ~0.32 s of air, and
 *      half a stick of lock at touchdown — with no feedback when they didn't, and
 *      because the press edge had already been consumed, a held button could
 *      never retry: the player had to release and press again. Measured on the
 *      entry grid (`.probe-tmp/drift-entry.ts`), 40 % of plausible attempts
 *      committed and 60 % silently did nothing.
 *
 *      Now the press ARMS the drift (`driftArmed`) and the arm stays live for as
 *      long as the button is held. The drift commits on the first tick that the
 *      kart is grounded, above `minSpeed` and steering past `engageSteer` —
 *      which may be the press tick itself (already mid-corner: instant), the
 *      landing tick (the classic hop-into-drift), or any tick after it (turn-in
 *      arrived late: the grace window is "as long as you're still holding").
 *
 *      The skill is untouched because it never lived here. It lives in the hold
 *      and the release: the charge tiers, the counter-steer cancel, and the fact
 *      that a cancel or a payoff DISARMS — so the next drift needs its own
 *      press, exactly as before. The free "cancel" is now "let go of the button"
 *      (hop straight, release: it was just a hop) rather than "land straight".
 *
 *      The hop survives as the flourish it should always have been, not the gate
 *      in front of the mechanic.
 *
 *   3. THE CHASSIS YAWS, THE VELOCITY DOESN'T (much). We command a slip angle
 *      (`driftAngle`, 12°–38°) and KartPhysics' tyre model relaxes the velocity
 *      toward it while PRESERVING MAGNITUDE. The kart is sideways; the momentum
 *      is not. Chaining drifts is therefore the fast line — which is the whole
 *      strategic core of Mario Kart.
 *
 *   4. CHARGE IS EARNED, NOT TIMED. Rate scales with how hard you're holding the
 *      drift inward and how fast you're going, so a lazy wide drift charges
 *      slowly. Counter-steering out almost stops the charge without breaking the
 *      drift, which is what lets a good player hold a line *and* a tier.
 *
 *   5. RELEASING EARLY GIVES NOTHING. No consolation boost below Blue. The tier
 *      thresholds are the difficulty curve.
 *
 *  Yaw/sign conventions (must match KartPhysics.ts):
 *    driftDir  +1 = drifting RIGHT, -1 = LEFT   (KartState convention)
 *    yawRate   positive = turning LEFT
 *    beta      slip angle, negative while drifting right
 * ============================================================================
 */

import { DriftStage } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { clamp, clamp01, damp, lerp, sign } from '@/core/MathUtils';
import type { KartBody } from './KartPhysics';
import { DriftPhase, PHYS, WORLD_UP, applyBoostTo, cancelDrift, TRICK_NAMES } from './KartPhysics';

export const DRIFT = {
  /**
   * Stick deflection that reads as "I am cornering", and so commits an armed
   * drift. **0.26 → 0.12 (P0g).**
   *
   * `Input.curve` puts a 0.14 radial dead-zone and a mild expo under this, so the
   * number is not the stick position — it is the *output*. Inverting the curve:
   * the old 0.26 needed the stick at 46 % of physical travel, held at the exact
   * tick of touchdown. 0.12 needs 30 %, which is still an unmistakable turn (a
   * dead-zone-grazing stick outputs ~0.01, and noise outputs nothing at all) but
   * is now comfortably below what anyone aiming at a corner is already holding.
   */
  engageSteer: 0.12,
  /** ...and to keep it alive once committed (hysteresis: you may straighten). */
  holdSteer: 0.04,
  /** Below this speed a drift is pointless and gets dropped. */
  minSpeed: 4.0,
  dropSpeed: 2.2,

  /** Drift angle envelope, radians. 12° (tight) .. 38° (wide, showy, slow). */
  angleMin: 0.21,
  angleMax: 0.665,
  /** How quickly the commanded angle follows the stick. */
  angleHalfLife: 0.13,
  /** The angle also opens up with speed — a 5 m/s drift can't be 38°. */
  angleSpeedFloor: 0.55,

  /** Charge rate shaping. `steer` term at full counter-steer .. full inward. */
  chargeSteerMin: 0.42,
  chargeSteerMax: 1.0,
  /** Charge rate = steerTerm * (speedBase + speedGain * speedRatio). */
  chargeSpeedBase: 0.70,
  chargeSpeedGain: 0.42,
  /** Charge still accrues mid-air during a drift-jump, slightly slower. */
  chargeAirScale: 0.85,

  /** Hop can't be re-triggered faster than this. */
  hopCooldown: 0.12,
  /** A hop that has been airborne at least this long can land into a drift. */
  hopMinAir: 0.02,

  /** Trick: a drift press within this long of leaving a lip still counts. */
  trickGrace: 0.26,
  /** Minimum upward launch speed for a ramp to be "a ramp". */
  trickLaunchSpeed: 1.6,
  /** ...and minimum total air time for the trick to pay out. */
  trickMinAir: 0.24,
  trickBoost: 0.55,
  trickStrength: 0.95,
  trickCooldown: 0.35,
} as const;

/** Drift charge accrued per second at the reference (full inward, near top speed). */
export class DriftSystem {
  /**
   * Runs AFTER Suspension (so `grounded` / `airTime` are current) and BEFORE
   * `stepKart` (so the phase, drift angle and hop impulse are in place for the
   * integration). Consumes `ctrlDriftPressed`.
   */
  update(b: KartBody, dt: number): void {
    const t = b.tuning;
    const pressed = b.ctrlDriftPressed;
    b.ctrlDriftPressed = false; // edge consumed — never twice, even at 2 substeps

    if (b.airDriftGrace > 0) b.airDriftGrace = Math.max(0, b.airDriftGrace - dt);
    if (b.hopTime > 0) b.hopTime += dt;

    const justLeftGround = !b.grounded && b.wasGrounded;
    const justLanded = b.grounded && !b.wasGrounded;

    // --- stunned / respawning: no drifting, no tricks ------------------------
    if (b.stunTime > 0 || b.respawnTime > 0) {
      if (b.driftPhase !== DriftPhase.None) cancelDrift(b, false);
      b.driftArmed = false;
      b.trickActive = false;
      b.trickArmed = false;
      b.hopTime = 0;
      b.driftAngle = damp(b.driftAngle, 0, 0.08, dt);
      return;
    }

    const speed = b.forwardSpeed;
    const absSpeed = Math.abs(speed);

    // --- tricks -------------------------------------------------------------
    this.tricks(b, dt, pressed, justLeftGround, justLanded);

    // --- press: arm the drift, then hop -------------------------------------
    if (pressed && !b.gliding) {
      b.airDriftGrace = DRIFT.trickGrace;
      // The press is the player's intent, and intent does not expire in 8 ms. It
      // stays live until the button comes up, or until a drift it produced ends.
      if (b.driftPhase === DriftPhase.None) b.driftArmed = true;
      if (b.driftPhase === DriftPhase.None && b.trickCooldown <= 0) {
        if (b.grounded) {
          // A genuine impulse. The suspension extends, the wheels leave the
          // ground, and the landing compresses — all of it emergent.
          b.velocity.addScaledVector(b.up, PHYS.hopSpeed);
          b.hopTime = 1e-6;
          b.hopHeld = true;
          bus.emit('kart:hop', { kartId: b.id, position: b.position });
          // Already turning? Then the answer to "is this a drift" is known NOW,
          // and making the player wait out the hop to be told is what made entry
          // feel unreliable. Commit on the press and let the hop happen *over*
          // the drift — `st.hopping` already reports that combination, and
          // `hopGravity` in KartPhysics keys off `hopTime`, so the flourish is
          // identical either way.
          if (this.engageReady(b, absSpeed)) this.begin(b, sign(b.ctrlSteer));
          else b.driftPhase = DriftPhase.Hop;
        } else {
          // Pressed mid-air (off a ramp, or after a bump): arm the landing so
          // you can pre-load a drift before you touch down. MK8 lets you do this
          // and it is essential for keeping speed over jumps.
          b.driftPhase = DriftPhase.Hop;
          b.hopHeld = true;
          if (b.hopTime <= 0) b.hopTime = 1e-6;
        }
      }
    }
    // Letting go always spends the arm — a fresh drift needs a fresh press.
    if (!b.ctrlDrift) b.driftArmed = false;

    // --- state machine ------------------------------------------------------
    switch (b.driftPhase) {
      case DriftPhase.Hop: {
        if (!b.ctrlDrift) {
          // Let go mid-hop: it was just a hop.
          b.driftPhase = DriftPhase.None;
          b.hopTime = 0;
          b.hopHeld = false;
          break;
        }
        const airborneEnough = b.hopTime > DRIFT.hopMinAir || !b.grounded;
        if (b.grounded && airborneEnough) {
          // The classic entry. A miss is no longer fatal: the arm survives, so
          // the `None` branch below keeps offering to commit for as long as the
          // button is down.
          if (this.engageReady(b, absSpeed)) this.begin(b, sign(b.ctrlSteer));
          else b.driftPhase = DriftPhase.None;
          b.hopTime = 0;
          b.hopHeld = false;
        }
        break;
      }

      case DriftPhase.Drifting: {
        // A drift entered on the press tick is still inside its hop for ~0.32 s;
        // the hop is over when the wheels come back down. Both `st.hopping` and
        // `PHYS.hopGravity` read `hopTime`, so it has to be closed here as well
        // as in the Hop case. (The time bound is defensive: a hop that somehow
        // never left the ground must not leave the kart flagged as hopping.)
        if (b.hopTime > 0 && (justLanded || (b.grounded && b.hopTime > 0.5))) {
          b.hopTime = 0;
          b.hopHeld = false;
        }
        if (!b.ctrlDrift) {
          cancelDrift(b, true); // release → the payoff
          break;
        }
        if (absSpeed < DRIFT.dropSpeed) {
          cancelDrift(b, false); // ground to a halt mid-drift: no reward
          break;
        }
        // Steering fully out of the drift for a sustained moment ends it
        // cleanly, but only while gripping — mid-air you keep everything.
        if (b.grounded && b.ctrlSteer * b.driftDir < -0.9 && b.driftTime > 0.25) {
          b.counterTime += dt;
          if (b.counterTime > 0.42) {
            cancelDrift(b, true);
            break;
          }
        } else {
          b.counterTime = 0;
        }

        b.driftTime += dt;

        // --- drift angle: the stick opens and closes the arc -----------------
        const inward = clamp(b.ctrlSteer * b.driftDir, -1, 1);
        const speedOpen = lerp(
          DRIFT.angleSpeedFloor,
          1,
          clamp01(absSpeed / Math.max(1, t.maxSpeed * 0.7)),
        );
        b.driftAngleTarget =
          lerp(DRIFT.angleMin, DRIFT.angleMax, (inward + 1) * 0.5) * speedOpen;
        b.driftAngle = damp(b.driftAngle, b.driftAngleTarget, DRIFT.angleHalfLife, dt);

        // --- charge ---------------------------------------------------------
        const steerTerm = lerp(DRIFT.chargeSteerMin, DRIFT.chargeSteerMax, (inward + 1) * 0.5);
        const speedRatio = clamp01(absSpeed / Math.max(1, t.maxSpeed));
        const rate =
          steerTerm *
          (DRIFT.chargeSpeedBase + DRIFT.chargeSpeedGain * speedRatio) *
          (b.grounded ? 1 : DRIFT.chargeAirScale);
        b.driftCharge += rate * dt;

        // --- tier promotion -------------------------------------------------
        const tiers = t.driftTiers;
        let stage: DriftStage = DriftStage.Charging;
        if (b.driftCharge >= tiers[2]) stage = DriftStage.Purple;
        else if (b.driftCharge >= tiers[1]) stage = DriftStage.Orange;
        else if (b.driftCharge >= tiers[0]) stage = DriftStage.Blue;
        if (stage !== b.driftStage) {
          b.driftStage = stage;
          if (stage >= DriftStage.Blue) {
            bus.emit('kart:driftTier', {
              kartId: b.id,
              tier: stage - DriftStage.Blue + 1,
              position: b.position,
            });
          }
        }
        break;
      }

      default: {
        // --- the forgiving entry --------------------------------------------
        // Button still held from an earlier press, and NOW the kart is cornering
        // fast enough: commit. This is the whole of the P0g fix — it turns a
        // one-tick timing window into "hold it and turn", and it subsumes the
        // post-landing grace window the old design needed but never had.
        if (this.engageReady(b, absSpeed)) {
          this.begin(b, sign(b.ctrlSteer));
          break;
        }
        // Not drifting: unwind the commanded angle so a re-entry starts clean.
        b.driftAngle = damp(b.driftAngle, 0, 0.09, dt);
        b.driftAngleTarget = 0;
        b.counterTime = 0;
        break;
      }
    }
  }

  // -------------------------------------------------------------------------

  /**
   * The three gates that are left, and the only three there should be: the button
   * is down and its press has not been spent, the tyres are on the ground, the
   * kart is cornering, and it is moving fast enough for a slide to mean anything.
   *
   * `ctrlSteer` (the stick) rather than `steerCmd` (the rack) on purpose — entry
   * should answer to what the player is asking for, not to the ~0.14 s the
   * steering rack takes to get there.
   */
  private engageReady(b: KartBody, absSpeed: number): boolean {
    return (
      b.driftArmed &&
      b.ctrlDrift &&
      b.grounded &&
      !b.gliding &&
      absSpeed >= DRIFT.minSpeed &&
      Math.abs(b.ctrlSteer) >= DRIFT.engageSteer
    );
  }

  private begin(b: KartBody, dir: number): void {
    b.driftPhase = DriftPhase.Drifting;
    b.driftDir = dir === 0 ? 1 : dir;
    b.driftTime = 0;
    b.driftCharge = 0;
    b.driftStage = DriftStage.Charging;
    b.counterTime = 0;
    // Seed the angle so the chassis snaps into the slide instead of easing in —
    // the instant "kick" on entry is a big part of why MK8 drifts feel crisp.
    b.driftAngle = Math.max(b.driftAngle, DRIFT.angleMin * 0.85);
    b.driftAngleTarget = b.driftAngle;
    bus.emit('kart:driftStart', { kartId: b.id, direction: b.driftDir });
  }

  /**
   * Ramp tricks. Leaving a lip with the drift button held (or tapping it within
   * `trickGrace` of the launch) arms a trick; landing pays a short boost.
   * Requires a real launch — bumps and kerbs must never pay out.
   */
  private tricks(
    b: KartBody,
    dt: number,
    pressed: boolean,
    justLeftGround: boolean,
    justLanded: boolean,
  ): void {
    if (b.trickActive) b.trickTime += dt;

    if (justLeftGround) {
      // Measure the launch against WORLD up, not the chassis/contact normal.
      // A kart riding a ramp is travelling *along* the surface, so its velocity
      // is very nearly perpendicular to that surface's normal — the dot product
      // reads ~0 at the exact instant a kicker is throwing it skyward. On the
      // bench the test ramp's lip gave `velocity.dot(b.up)` = -0.41 while the
      // kart was climbing at +6.07 m/s world-vertical, so the >= 1.6 gate could
      // never pass and no trick had ever armed on any circuit.
      //
      // The two DRIFT constants corroborate world-up as the intent: a 1.6 m/s
      // vertical launch buys 2*1.6/g ≈ 0.33 s of air, just over `trickMinAir`
      // (0.24 s). Kerb blips measure 0.24 m/s here and are still rejected.
      //
      // Under anti-gravity the meaningful axis is the ground normal rather than
      // world up; that path is left alone because it has the same along-the-
      // surface problem and needs the departing-plane fix, not this one.
      const launch = b.velocity.dot(WORLD_UP);
      const fromHop = b.hopTime > 0 && b.hopTime < 0.1;
      if (launch >= DRIFT.trickLaunchSpeed && !fromHop && b.trickCooldown <= 0) {
        if (b.ctrlDrift || b.airDriftGrace > 0) this.armTrick(b);
        else b.trickArmed = true; // eligible; a press within the grace still counts
      } else {
        b.trickArmed = false;
      }
    }

    // A late press, just after the lip, still counts.
    if (!b.grounded && pressed && b.trickArmed && !b.trickActive) this.armTrick(b);

    if (justLanded) {
      if (b.trickActive && b.airTime >= 0 && b.trickTime >= DRIFT.trickMinAir) {
        applyBoostTo(b, DRIFT.trickBoost, DRIFT.trickStrength, 'trick');
        bus.emit('kart:trick', { kartId: b.id, name: b.trickName });
        b.trickCooldown = DRIFT.trickCooldown;
      }
      b.trickActive = false;
      b.trickArmed = false;
      b.trickTime = 0;
    }
  }

  private armTrick(b: KartBody): void {
    b.trickActive = true;
    b.trickTime = 0;
    // Pick a flavour from the launch state so repeated jumps look different.
    const steer = Math.abs(b.ctrlSteer);
    const idx =
      steer > 0.5
        ? b.ctrlSteer > 0
          ? 3
          : 0
        : b.velocity.dot(b.up) > 7
          ? 1
          : b.driftPhase === DriftPhase.Drifting
            ? 4
            : 2;
    b.trickName = TRICK_NAMES[idx] ?? 'spin';
  }
}
