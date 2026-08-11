/**
 * ============================================================================
 *  FOXY KART — RUBBER BANDING (must be INVISIBLE)
 * ============================================================================
 *  Visible rubber-banding is a cardinal sin. If the player can *see* that the
 *  AI sped up because they pulled away, the whole race stops mattering.
 *
 *  So this module is built on one principle:
 *
 *      MODULATE RISK, NOT SPEED.
 *
 *  A kart that is behind gets a *tiny* speed allowance (≤ +7 %) but a *large*
 *  increase in willingness to take risk: it attacks the overtaking line, brakes
 *  later, drifts corners it would otherwise take gripping, and commits to gaps
 *  it would normally refuse. That reads as "they're really trying now", which
 *  is exactly what a good rival looks like. Raw speed reads as cheating.
 *
 *  The leader slowdown is deliberately weaker still and only applies to the
 *  front runners once the player is a long way back — enough to keep the pack
 *  on screen, not enough to notice.
 *
 *  Every constant lives at the top of this file.
 * ============================================================================
 */

import { clamp, clamp01, smoothstep } from '@/core/MathUtils';
import type { SkillProfile } from './AIPersonality';

// ---------------------------------------------------------------------------
//  TUNING — all of it, right here.
// ---------------------------------------------------------------------------

export const RUBBERBAND = {
  enabled: true,

  /** Hard clamps on the speed multiplier. Never widen these. */
  speedMulMin: 0.94,
  speedMulMax: 1.07,

  // ---- behind the player -------------------------------------------------
  /** Metres of gap inside which nothing at all happens. */
  behindDeadZone: 25,
  /** Metres behind at which the behind-effect saturates. */
  behindFullDistance: 300,
  /** Speed multiplier at full saturation. */
  behindSpeedMul: 1.07,
  /** Extra risk appetite at full saturation, 0..1. This is the real lever. */
  behindRiskMax: 1.0,
  /** Extra aggression at full saturation, 0..1. */
  behindAggressionMax: 0.55,

  // ---- ahead of the player ----------------------------------------------
  /** Metres of lead before the leader is asked to wait at all. */
  aheadDeadZone: 85,
  /** Metres of lead at which the ahead-effect saturates. */
  aheadFullDistance: 380,
  /** Speed multiplier at full saturation. */
  aheadSpeedMul: 0.955,
  /** Risk reduction at full saturation (negative = plays it safe). */
  aheadRiskMin: -0.4,
  /** Only karts in the top N positions are ever slowed. */
  leaderPositions: 3,

  /** Half-life of the smoothing applied to both outputs, seconds.
   *  Long on purpose: a fast-changing multiplier is visible. */
  smoothHalfLife: 2.2,

  /** First N seconds of the race are untouched — no early cheating. */
  graceSeconds: 6.0,

  /** The `rival` personality gets a tighter, symmetric band centred on the
   *  player so it stays in the mirror all race. */
  rivalDeadZone: 12,
  rivalFullDistance: 150,
  rivalSpeedMulMax: 1.06,
  rivalSpeedMulMin: 0.95,
} as const;

/** Per-CC skill profiles. 50cc is genuinely bad; 200cc is genuinely scary. */
export const CC_PROFILES: Record<50 | 100 | 150 | 200, SkillProfile> = {
  50: {
    pace: 0.80,
    error: 2.35,
    drift: 0.40,
    reaction: 1.75,
    item: 0.45,
    lineAccuracy: 0.5,
    brakeMargin: 1.3,
  },
  100: {
    pace: 0.905,
    error: 1.5,
    drift: 0.78,
    reaction: 1.3,
    item: 0.75,
    lineAccuracy: 0.74,
    brakeMargin: 1.12,
  },
  150: {
    pace: 1.0,
    error: 1.0,
    drift: 1.0,
    reaction: 1.0,
    item: 1.0,
    lineAccuracy: 1.0,
    brakeMargin: 1.0,
  },
  200: {
    pace: 1.055,
    error: 0.5,
    drift: 1.45,
    reaction: 0.68,
    item: 1.3,
    lineAccuracy: 1.18,
    brakeMargin: 0.9,
  },
};

export type CCClass = 50 | 100 | 150 | 200;

// ---------------------------------------------------------------------------

export interface BandOutput {
  /** Multiplier on the target speed. Always inside [speedMulMin, speedMulMax]. */
  speedMul: number;
  /**
   * -1..+1. Positive = take more risk (attack the outside line, brake later,
   * drift more, commit to gaps). Negative = consolidate.
   */
  risk: number;
  /** 0..1 additive aggression bias. */
  aggression: number;
}

export function createBandOutput(): BandOutput {
  return { speedMul: 1, risk: 0, aggression: 0 };
}

// ---------------------------------------------------------------------------

export class Rubberband {
  private cc: CCClass = 150;
  private enabled: boolean = RUBBERBAND.enabled;
  /** Race clock, used for the grace period. */
  private raceTime = 0;
  /** Per-kart smoothed state so the multiplier never steps. */
  private readonly smoothSpeed = new Map<number, number>();
  private readonly smoothRisk = new Map<number, number>();

  setCC(cc: CCClass): void {
    this.cc = CC_PROFILES[cc] ? cc : 150;
  }

  get ccClass(): CCClass {
    return this.cc;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** The CC skill profile the drivers read. */
  profile(): SkillProfile {
    return CC_PROFILES[this.cc] ?? CC_PROFILES[150];
  }

  /** Call once per fixed step, before evaluating drivers. */
  tick(dt: number, raceStarted: boolean): void {
    this.raceTime = raceStarted ? this.raceTime + dt : 0;
  }

  reset(): void {
    this.raceTime = 0;
    this.smoothSpeed.clear();
    this.smoothRisk.clear();
  }

  forget(kartId: number): void {
    this.smoothSpeed.delete(kartId);
    this.smoothRisk.delete(kartId);
  }

  /**
   * Evaluate the band for one kart.
   *
   * @param kartId       the AI kart
   * @param gapMetres    signed gap to the player along the track: POSITIVE when
   *                     the AI is AHEAD of the player.
   * @param racePosition 1-based current position
   * @param isRival      true for the `rival` personality (tighter band)
   * @param dt           fixed step, for the smoothing
   */
  evaluate(
    kartId: number,
    gapMetres: number,
    racePosition: number,
    isRival: boolean,
    dt: number,
    out: BandOutput,
  ): BandOutput {
    let targetSpeed = 1;
    let targetRisk = 0;
    let aggression = 0;

    const active = this.enabled && this.raceTime >= RUBBERBAND.graceSeconds;

    if (active) {
      if (isRival) {
        // The rival tracks the player symmetrically — it wants to be *right
        // there*, not to win by a mile or trail off.
        const g = gapMetres;
        const dz = RUBBERBAND.rivalDeadZone;
        const full = RUBBERBAND.rivalFullDistance;
        if (g < -dz) {
          const x = smoothstep((-g - dz) / Math.max(1, full - dz));
          targetSpeed = 1 + (RUBBERBAND.rivalSpeedMulMax - 1) * x;
          targetRisk = x;
          aggression = RUBBERBAND.behindAggressionMax * x;
        } else if (g > dz) {
          const x = smoothstep((g - dz) / Math.max(1, full - dz));
          targetSpeed = 1 + (RUBBERBAND.rivalSpeedMulMin - 1) * x;
          targetRisk = -0.25 * x;
        }
      } else if (gapMetres < -RUBBERBAND.behindDeadZone) {
        // Behind: mostly risk, barely any speed.
        const x = smoothstep(
          (-gapMetres - RUBBERBAND.behindDeadZone) /
            Math.max(1, RUBBERBAND.behindFullDistance - RUBBERBAND.behindDeadZone),
        );
        targetSpeed = 1 + (RUBBERBAND.behindSpeedMul - 1) * x;
        targetRisk = RUBBERBAND.behindRiskMax * x;
        aggression = RUBBERBAND.behindAggressionMax * x;
      } else if (
        gapMetres > RUBBERBAND.aheadDeadZone &&
        racePosition <= RUBBERBAND.leaderPositions
      ) {
        // Ahead and leading: a whisper of a slowdown so the pack stays on TV.
        const x = smoothstep(
          (gapMetres - RUBBERBAND.aheadDeadZone) /
            Math.max(1, RUBBERBAND.aheadFullDistance - RUBBERBAND.aheadDeadZone),
        );
        targetSpeed = 1 + (RUBBERBAND.aheadSpeedMul - 1) * x;
        targetRisk = RUBBERBAND.aheadRiskMin * x;
      }
    }

    targetSpeed = clamp(targetSpeed, RUBBERBAND.speedMulMin, RUBBERBAND.speedMulMax);
    targetRisk = clamp(targetRisk, -1, 1);

    // Frame-rate independent smoothing — a stepping multiplier is visible.
    const f = Math.pow(2, -dt / RUBBERBAND.smoothHalfLife);
    const prevS = this.smoothSpeed.get(kartId);
    const prevR = this.smoothRisk.get(kartId);
    const s = prevS === undefined ? targetSpeed : targetSpeed + (prevS - targetSpeed) * f;
    const r = prevR === undefined ? targetRisk : targetRisk + (prevR - targetRisk) * f;
    this.smoothSpeed.set(kartId, s);
    this.smoothRisk.set(kartId, r);

    out.speedMul = clamp(s, RUBBERBAND.speedMulMin, RUBBERBAND.speedMulMax);
    out.risk = clamp(r, -1, 1);
    out.aggression = clamp01(aggression);
    return out;
  }

  /** Debug readout. */
  debug(kartId: number): { speedMul: number; risk: number } {
    return {
      speedMul: this.smoothSpeed.get(kartId) ?? 1,
      risk: this.smoothRisk.get(kartId) ?? 0,
    };
  }
}
