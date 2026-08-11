/**
 * ============================================================================
 *  SURFACE PARTICLES — what the tyres throw up
 * ============================================================================
 *  Driven entirely by `SURFACES[surface].particle`, so a new surface type in
 *  Config automatically gets the right spray with no changes here.
 *
 *    dust    billowing tan smoke with curl turbulence + flicked pebbles
 *    grass   green clippings + a light pale dust wash
 *    sand    fine golden spray + a lingering low cloud
 *    spray   white droplets + a rooster tail + hanging mist
 *    sparks  bright metal sparks that skip off the surface
 *    snow    soft powder puffs + glittering ice crystals
 *
 *  Emission is per-wheel, gated on `wheelGrounded`, and scales with both speed
 *  and lateral slip — a straight-line cruise barely dusts, a full drift throws
 *  a wall of it.
 * ============================================================================
 */

import * as THREE from 'three';
import { SURFACES } from '@/core/Config';
import type { KartState, SurfaceProperties } from '@/core/Types';
import { clamp01 } from '@/core/MathUtils';
import { CURVE, RAMP, SPRITE } from './sprites/Atlas';
import {
  makeDesc, PFLAG, socketPos,
  type EmitterDesc, type KartSource, type SocketName, type VfxContext,
} from './ParticleSystem';

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const F_LOCAL = new THREE.Vector3(0, 0, -1);
const R_LOCAL = new THREE.Vector3(1, 0, 0);
const U_LOCAL = new THREE.Vector3(0, 1, 0);

const WHEEL_NAMES: SocketName[] = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'];
const WHEEL_OFF: Array<[number, number, number]> = [
  [-0.60, -0.26, -0.62], [0.60, -0.26, -0.62],
  [-0.60, -0.26, 0.62], [0.60, -0.26, 0.62],
];

type Family = SurfaceProperties['particle'];

interface FamilyFx {
  /** Coarse "chunky" element — pebbles, clippings, droplets, sparks. */
  bits: EmitterDesc | null;
  /** Soft volumetric element — dust, mist, powder. */
  cloud: EmitterDesc | null;
  /** Extra flourish (rooster tail, glitter). */
  extra: EmitterDesc | null;
  bitsRate: number;
  cloudRate: number;
  extraRate: number;
  /** Rear wheels only for the flourish. */
  extraRearOnly: boolean;
}

interface KartFx {
  acc: Float32Array;   // 4 wheels × 3 streams
  lastSurface: number;
}

export class SurfaceParticles {
  private ctx: VfxContext;
  private src: KartSource;
  private families = new Map<Family, FamilyFx>();
  private state = new Map<number, KartFx>();

  constructor(ctx: VfxContext, src: KartSource) {
    this.ctx = ctx;
    this.src = src;

    // --- dust ---------------------------------------------------------------
    this.families.set('dust', {
      bits: makeDesc({
        sprite: SPRITE.CHIP, ramp: RAMP.DEBRIS, curve: CURVE.CONST,
        flags: PFLAG.BOUNCE,
        size: 0.075, sizeVar: 0.6, life: 0.85, lifeVar: 0.4,
        speed: 5.5, speedVar: 0.7, cone: 0.65,
        inherit: 0.45, jitter: 0.08,
        gravity: 20, drag: 0.5, restitution: 0.3,
        spin: 12, soft: 0.15, additive: 0, alpha: 1, intensity: 1,
      }),
      cloud: makeDesc({
        sprite: SPRITE.DUST, ramp: RAMP.DUST, curve: CURVE.PUFF,
        flags: PFLAG.TURB,
        size: 0.62, sizeVar: 0.45, life: 1.25, lifeVar: 0.4,
        speed: 2.1, speedVar: 0.7, cone: 1.0,
        drift: new THREE.Vector3(0, 1.5, 0), inherit: 0.32, jitter: 0.14,
        gravity: -1.1, drag: 1.5, turbAmp: 0.75, turbFreq: 0.85,
        spin: 1.5, soft: 1.1, additive: 0, alpha: 0.62, intensity: 1,
      }),
      extra: null,
      bitsRate: 26, cloudRate: 62, extraRate: 0, extraRearOnly: false,
    });

    // --- grass --------------------------------------------------------------
    this.families.set('grass', {
      bits: makeDesc({
        sprite: SPRITE.LEAF, ramp: RAMP.GRASS, curve: CURVE.CONST,
        flags: PFLAG.BOUNCE,
        size: 0.13, sizeVar: 0.5, life: 1.15, lifeVar: 0.45,
        speed: 6.5, speedVar: 0.75, cone: 0.8,
        inherit: 0.5, jitter: 0.09,
        gravity: 17, drag: 1.6, restitution: 0.2,
        spin: 16, soft: 0.15, additive: 0, alpha: 1, intensity: 1,
      }),
      cloud: makeDesc({
        sprite: SPRITE.DUST, ramp: RAMP.SMOKE_LIGHT, curve: CURVE.PUFF,
        flags: PFLAG.TURB,
        size: 0.42, sizeVar: 0.4, life: 0.8, lifeVar: 0.35,
        speed: 1.6, speedVar: 0.7, cone: 1.1,
        drift: new THREE.Vector3(0, 1.0, 0), inherit: 0.3, jitter: 0.12,
        gravity: -0.6, drag: 1.8, turbAmp: 0.5, turbFreq: 1.1,
        spin: 1.2, soft: 0.9, additive: 0, alpha: 0.34, intensity: 1,
      }),
      extra: null,
      bitsRate: 44, cloudRate: 30, extraRate: 0, extraRearOnly: false,
    });

    // --- sand ---------------------------------------------------------------
    this.families.set('sand', {
      bits: makeDesc({
        sprite: SPRITE.MIST, ramp: RAMP.SAND, curve: CURVE.GROW,
        size: 0.20, sizeVar: 0.5, life: 0.75, lifeVar: 0.4,
        speed: 7.0, speedVar: 0.65, cone: 0.55,
        inherit: 0.55, jitter: 0.07,
        gravity: 12, drag: 1.9, soft: 0.35,
        additive: 0, alpha: 0.85, intensity: 1.05,
      }),
      cloud: makeDesc({
        sprite: SPRITE.DUST, ramp: RAMP.SAND, curve: CURVE.PUFF,
        flags: PFLAG.TURB,
        size: 0.72, sizeVar: 0.45, life: 1.9, lifeVar: 0.4,
        speed: 1.5, speedVar: 0.7, cone: 1.2,
        drift: new THREE.Vector3(0, 0.8, 0), inherit: 0.25, jitter: 0.16,
        gravity: -0.35, drag: 1.2, turbAmp: 0.6, turbFreq: 0.7,
        spin: 1.0, soft: 1.3, additive: 0, alpha: 0.5, intensity: 1,
      }),
      extra: null,
      bitsRate: 55, cloudRate: 48, extraRate: 0, extraRearOnly: false,
    });

    // --- water spray --------------------------------------------------------
    this.families.set('spray', {
      bits: makeDesc({
        sprite: SPRITE.DROPLET, ramp: RAMP.WATER, curve: CURVE.CONST,
        flags: PFLAG.STRETCH,
        size: 0.13, sizeVar: 0.6, life: 0.7, lifeVar: 0.45,
        speed: 8.5, speedVar: 0.7, cone: 0.7,
        inherit: 0.6, jitter: 0.08,
        gravity: 21, drag: 0.35, stretch: 0.012, soft: 0.12,
        additive: 0.35, alpha: 1, intensity: 1.2,
      }),
      cloud: makeDesc({
        sprite: SPRITE.MIST, ramp: RAMP.SPRAY, curve: CURVE.PUFF,
        flags: PFLAG.TURB,
        size: 0.6, sizeVar: 0.4, life: 1.0, lifeVar: 0.4,
        speed: 2.2, speedVar: 0.7, cone: 1.1,
        drift: new THREE.Vector3(0, 1.2, 0), inherit: 0.3, jitter: 0.14,
        gravity: -0.8, drag: 2.0, turbAmp: 0.55, turbFreq: 1.2,
        spin: 1.1, soft: 1.0, additive: 0.3, alpha: 0.4, intensity: 1.1,
      }),
      // Rooster tail: a tall fan of water thrown straight up behind the rears.
      extra: makeDesc({
        sprite: SPRITE.MIST, ramp: RAMP.WATER, curve: CURVE.SWELL,
        flags: PFLAG.STRETCH,
        size: 0.42, sizeVar: 0.45, life: 0.55, lifeVar: 0.35,
        speed: 12.5, speedVar: 0.4, cone: 0.22,
        inherit: 0.35, jitter: 0.06,
        gravity: 24, drag: 0.5, stretch: 0.010, soft: 0.5,
        additive: 0.3, alpha: 0.8, intensity: 1.3,
      }),
      bitsRate: 90, cloudRate: 55, extraRate: 70, extraRearOnly: true,
    });

    // --- metal sparks -------------------------------------------------------
    this.families.set('sparks', {
      bits: makeDesc({
        sprite: SPRITE.SPARK, ramp: RAMP.METAL_SPARK, curve: CURVE.SHRINK,
        flags: PFLAG.STRETCH | PFLAG.BOUNCE,
        size: 0.16, sizeVar: 0.5, life: 0.45, lifeVar: 0.4,
        speed: 9.0, speedVar: 0.6, cone: 0.5,
        inherit: 0.55, jitter: 0.05,
        gravity: 17, drag: 1.0, restitution: 0.45,
        stretch: 0.028, soft: 0.18,
        additive: 1, alpha: 1, intensity: 1,
      }),
      cloud: makeDesc({
        sprite: SPRITE.GLOW, ramp: RAMP.METAL_SPARK, curve: CURVE.SPIKE,
        size: 0.3, sizeVar: 0.35, life: 0.16, lifeVar: 0.3,
        speed: 1.8, speedVar: 0.7, cone: 1.0,
        inherit: 0.5, jitter: 0.05, drag: 3, soft: 0.35,
        additive: 1, alpha: 0.7, intensity: 0.9,
      }),
      extra: null,
      bitsRate: 60, cloudRate: 18, extraRate: 0, extraRearOnly: false,
    });

    // --- snow ---------------------------------------------------------------
    this.families.set('snow', {
      bits: makeDesc({
        sprite: SPRITE.DUST, ramp: RAMP.SNOW, curve: CURVE.PUFF,
        flags: PFLAG.TURB,
        size: 0.40, sizeVar: 0.5, life: 0.95, lifeVar: 0.4,
        speed: 4.5, speedVar: 0.7, cone: 0.85,
        drift: new THREE.Vector3(0, 1.0, 0), inherit: 0.4, jitter: 0.1,
        gravity: 3.0, drag: 2.2, turbAmp: 0.5, turbFreq: 1.3,
        spin: 1.6, soft: 0.8, additive: 0.2, alpha: 0.8, intensity: 1.1,
      }),
      cloud: makeDesc({
        sprite: SPRITE.MIST, ramp: RAMP.SNOW, curve: CURVE.PUFF,
        flags: PFLAG.TURB,
        size: 0.7, sizeVar: 0.4, life: 1.4, lifeVar: 0.4,
        speed: 1.3, speedVar: 0.7, cone: 1.2,
        drift: new THREE.Vector3(0, 0.9, 0), inherit: 0.25, jitter: 0.15,
        gravity: -0.4, drag: 1.4, turbAmp: 0.6, turbFreq: 0.9,
        spin: 0.9, soft: 1.2, additive: 0.15, alpha: 0.36, intensity: 1.05,
      }),
      extra: makeDesc({
        sprite: SPRITE.FLARE, ramp: RAMP.WHITE, curve: CURVE.SPIKE,
        flags: PFLAG.HARD,
        size: 0.16, sizeVar: 0.6, life: 0.5, lifeVar: 0.5,
        speed: 5.0, speedVar: 0.8, cone: 1.1,
        inherit: 0.4, jitter: 0.1, gravity: 6, drag: 1.2,
        soft: 0, additive: 1, alpha: 0.9, intensity: 1.4,
      }),
      bitsRate: 40, cloudRate: 34, extraRate: 8, extraRearOnly: false,
    });
  }

  private fx(id: number): KartFx {
    let s = this.state.get(id);
    if (!s) { s = { acc: new Float32Array(12), lastSurface: -1 }; this.state.set(id, s); }
    return s;
  }

  update(): void {
    const { ctx } = this;
    const dt = ctx.dt;
    const karts = this.src.karts;
    if (!karts) return;

    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (!k.grounded) continue;
      const props = SURFACES[k.surface];
      if (!props) continue;
      const fam = this.families.get(props.particle);
      if (!fam) continue;

      // Never cull the player — see the same note in DriftSparks.update().
      const dist = ctx.camera.position.distanceTo(k.position);
      if (!k.isPlayer && dist > 150) continue;
      const lodRaw = dist < 30 ? 1 : dist < 70 ? 0.5 : 0.2;
      const lod = k.isPlayer ? (lodRaw < 0.6 ? 0.6 : lodRaw) : lodRaw;

      const speed = Math.abs(k.speed);
      const speedF = clamp01(speed / 16);
      if (speedF < 0.04) continue;

      tmpFwd.copy(F_LOCAL).applyQuaternion(k.quaternion);
      tmpRight.copy(R_LOCAL).applyQuaternion(k.quaternion);
      tmpUp.copy(U_LOCAL).applyQuaternion(k.quaternion);

      // Lateral slip drives the "wall of dust" look.
      const lateral = Math.abs(k.velocity.dot(tmpRight));
      let slip = clamp01(lateral / 7);
      if (k.drifting) slip = Math.max(slip, 0.75);
      if (k.stunned) slip = Math.max(slip, 0.6);

      const s = this.fx(k.id);
      // Even straight-line running throws a visible cloud on loose surfaces;
      // slip is what turns it into a wall of it.
      const rateScale = lod * ctx.throttle * (0.22 + 0.78 * speedF) * (0.55 + 1.15 * slip);

      // Spray opposite to travel, kicked up and outward from the contact patch.
      const dirSign = lateral > 0.3 ? (k.velocity.dot(tmpRight) > 0 ? -1 : 1) : (Math.random() < 0.5 ? -1 : 1);

      for (let w = 0; w < 4; w++) {
        if (!k.wheelGrounded?.[w]) continue;
        const isRear = w >= 2;
        socketPos(this.src, k, WHEEL_NAMES[w], WHEEL_OFF[w][0], WHEEL_OFF[w][1], WHEEL_OFF[w][2], tmpA);
        const groundY = tmpA.y - 0.30;
        tmpA.y = groundY + 0.07;

        tmpDir.copy(tmpFwd).multiplyScalar(-0.72)
          .addScaledVector(tmpRight, dirSign * 0.32)
          .addScaledVector(tmpUp, 0.52)
          .normalize();

        const wheelScale = isRear ? 1 : 0.62;
        const base = w * 3;

        if (fam.bits) {
          s.acc[base] += fam.bitsRate * rateScale * wheelScale * dt;
          if (s.acc[base] >= 1) {
            let n = Math.floor(s.acc[base]);
            s.acc[base] -= n;
            if (n > 14) n = 14;
            ctx.particles.emit(fam.bits, n, tmpA, tmpDir, k.velocity, groundY, 1);
          }
        }
        if (fam.cloud) {
          s.acc[base + 1] += fam.cloudRate * rateScale * wheelScale * dt;
          if (s.acc[base + 1] >= 1) {
            let n = Math.floor(s.acc[base + 1]);
            s.acc[base + 1] -= n;
            if (n > 8) n = 8;
            ctx.particles.emit(fam.cloud, n, tmpA, tmpDir, k.velocity, groundY, 1);
          }
        }
        if (fam.extra && (!fam.extraRearOnly || isRear)) {
          s.acc[base + 2] += fam.extraRate * rateScale * wheelScale * dt;
          if (s.acc[base + 2] >= 1) {
            let n = Math.floor(s.acc[base + 2]);
            s.acc[base + 2] -= n;
            if (n > 10) n = 10;
            // Rooster tail goes almost straight up, trailing behind.
            tmpB.copy(tmpUp).multiplyScalar(0.85).addScaledVector(tmpFwd, -0.5).normalize();
            ctx.particles.emit(fam.extra, n, tmpA, tmpB, k.velocity, groundY, 1);
          }
        }
      }
    }
  }

  /** One-shot puff of the surface's own material — used by burst('surfacePuff'). */
  puff(family: Family, pos: THREE.Vector3, normal: THREE.Vector3, scale: number): void {
    const fam = this.families.get(family);
    if (!fam) return;
    const groundY = pos.y - 0.05;
    if (fam.cloud) {
      this.ctx.particles.emit(fam.cloud, Math.round(10 * this.ctx.throttle), pos, normal, null, groundY, scale);
    }
    if (fam.bits) {
      this.ctx.particles.emit(fam.bits, Math.round(12 * this.ctx.throttle), pos, normal, null, groundY, scale);
    }
  }

  dispose(): void { this.state.clear(); }
}
