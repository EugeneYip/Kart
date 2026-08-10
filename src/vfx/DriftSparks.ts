/**
 * ============================================================================
 *  DRIFT SPARKS — the most iconic effect in the game
 * ============================================================================
 *  Four escalating states, each a distinct read at a glance:
 *
 *    Charging  faint white-blue wisps trailing off the inside rear wheel
 *    Blue      bright blue sparks spraying back from BOTH rear wheels, hot
 *              white core + soft glow, stretched along velocity, skipping once
 *              off the tarmac, plus a blue rim glow washing over the chassis
 *    Orange    denser, larger, orange/yellow, lofted embers + heat shimmer
 *    Purple    violent magenta sparks, electric arcs, and a swirling ribbon of
 *              light orbiting the kart
 *
 *  Every tier-up fires a ring shockwave + radial burst so the moment lands.
 *  Sparks originate at the *wheel contact points*, spray in an arc opposing the
 *  drift direction, and inherit ~60 % of the kart's velocity.
 * ============================================================================
 */

import * as THREE from 'three';
import { DriftStage, type KartState } from '@/core/Types';
import { clamp01 } from '@/core/MathUtils';
import { CURVE, RAMP, SPRITE } from './sprites/Atlas';
import {
  makeDesc, PFLAG, socketPos,
  type EmitterDesc, type KartSource, type SocketName, type VfxContext,
} from './ParticleSystem';

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const F_LOCAL = new THREE.Vector3(0, 0, -1);
const R_LOCAL = new THREE.Vector3(1, 0, 0);
const U_LOCAL = new THREE.Vector3(0, 1, 0);

/** Rear-wheel fallback offsets in chassis space (used if sockets are absent). */
const REAR_L: [number, number, number] = [-0.60, -0.26, 0.62];
const REAR_R: [number, number, number] = [0.60, -0.26, 0.62];

interface KartFx {
  stage: DriftStage;
  accL: number;
  accR: number;
  accWisp: number;
  accEmber: number;
  accArc: number;
  accRibbon: number;
  ribbonPhase: number;
  glowPulse: number;
  /** ctx.time of the last tier celebration — debounces state vs. event. */
  lastTier: number;
}

export class DriftSparks {
  private ctx: VfxContext;
  private src: KartSource;
  private state = new Map<number, KartFx>();

  // --- emitter library ------------------------------------------------------
  private dWisp: EmitterDesc;
  private dSparkBlue: EmitterDesc;
  private dSparkOrange: EmitterDesc;
  private dSparkPurple: EmitterDesc;
  private dGlowBlue: EmitterDesc;
  private dGlowOrange: EmitterDesc;
  private dGlowPurple: EmitterDesc;
  private dEmber: EmitterDesc;
  private dShimmer: EmitterDesc;
  private dArc: EmitterDesc;
  private dRibbon: EmitterDesc;
  private dRim: EmitterDesc;
  private dRing: EmitterDesc;
  private dRingInner: EmitterDesc;
  private dFlare: EmitterDesc;
  private dBurstSpark: EmitterDesc;

  constructor(ctx: VfxContext, src: KartSource) {
    this.ctx = ctx;
    this.src = src;

    this.dWisp = makeDesc({
      sprite: SPRITE.MIST, ramp: RAMP.CHARGE_WISP, curve: CURVE.GROW,
      flags: PFLAG.TURB,
      size: 0.30, sizeVar: 0.35, life: 0.42, lifeVar: 0.3,
      speed: 1.1, speedVar: 0.6, cone: 0.9,
      drift: new THREE.Vector3(0, 1.4, 0), inherit: 0.35, jitter: 0.06,
      gravity: -1.2, drag: 2.4, turbAmp: 0.22, turbFreq: 1.6,
      spin: 1.6, stretch: 0, soft: 0.35,
      additive: 0.75, alpha: 0.7, intensity: 1.0,
    });

    // Short life + low velocity inheritance is what keeps the spray a tight
    // twin jet raking off the tyres. Inherit too much and the sparks travel
    // WITH the kart, which reads as a sparkler going off around the chassis;
    // live too long and they smear across half the track.
    const spark = (ramp: number, size: number, speed: number, life: number): EmitterDesc =>
      makeDesc({
        sprite: SPRITE.SPARK, ramp, curve: CURVE.SHRINK,
        flags: PFLAG.STRETCH | PFLAG.BOUNCE,
        size, sizeVar: 0.45, life, lifeVar: 0.30,
        speed, speedVar: 0.5, cone: 0.40,
        inherit: 0.28, jitter: 0.045,
        gravity: 16, drag: 1.4, restitution: 0.42,
        stretch: 0.026, soft: 0.18,
        additive: 1, alpha: 1, intensity: 1,
      });
    this.dSparkBlue = spark(RAMP.BLUE_SPARK, 0.155, 7.0, 0.26);
    this.dSparkOrange = spark(RAMP.ORANGE_SPARK, 0.20, 8.5, 0.30);
    this.dSparkPurple = spark(RAMP.PURPLE_SPARK, 0.235, 10.0, 0.34);

    const glow = (ramp: number, size: number): EmitterDesc => makeDesc({
      sprite: SPRITE.GLOW, ramp, curve: CURVE.SPIKE,
      size, sizeVar: 0.3, life: 0.16, lifeVar: 0.3,
      speed: 2.2, speedVar: 0.7, cone: 0.9,
      inherit: 0.3, jitter: 0.05,
      gravity: 2, drag: 3.0, soft: 0.4,
      additive: 1, alpha: 0.85, intensity: 0.85,
    });
    this.dGlowBlue = glow(RAMP.BLUE_SPARK, 0.42);
    this.dGlowOrange = glow(RAMP.ORANGE_SPARK, 0.52);
    this.dGlowPurple = glow(RAMP.PURPLE_SPARK, 0.60);

    this.dEmber = makeDesc({
      sprite: SPRITE.EMBER, ramp: RAMP.EMBER, curve: CURVE.SHRINK,
      flags: PFLAG.TURB,
      size: 0.10, sizeVar: 0.5, life: 1.05, lifeVar: 0.45,
      speed: 3.2, speedVar: 0.7, cone: 1.1,
      drift: new THREE.Vector3(0, 1.6, 0), inherit: 0.35, jitter: 0.08,
      gravity: 2.2, drag: 1.5, turbAmp: 0.5, turbFreq: 1.1,
      soft: 0.2, additive: 1, alpha: 1, intensity: 1.1,
    });

    this.dShimmer = makeDesc({
      sprite: SPRITE.SMOKE, ramp: RAMP.EMBER, curve: CURVE.PUFF,
      flags: PFLAG.TURB,
      size: 0.55, sizeVar: 0.4, life: 0.42, lifeVar: 0.3,
      speed: 1.4, speedVar: 0.6, cone: 1.2,
      drift: new THREE.Vector3(0, 2.6, 0), inherit: 0.45, jitter: 0.12,
      gravity: -3.0, drag: 2.2, turbAmp: 0.55, turbFreq: 2.1,
      spin: 2.2, soft: 0.6, additive: 0.9, alpha: 0.22, intensity: 0.5,
    });

    this.dArc = makeDesc({
      sprite: SPRITE.BOLT, ramp: RAMP.ELECTRIC, curve: CURVE.CONST,
      flags: PFLAG.STRETCH | PFLAG.HARD,
      size: 0.55, sizeVar: 0.45, life: 0.075, lifeVar: 0.4,
      speed: 5.0, speedVar: 0.8, cone: 2.4,
      inherit: 0.9, jitter: 0.45,
      stretch: 0.02, additive: 1, alpha: 1, intensity: 1.3,
    });

    // Spawned with the kart's own velocity and ZERO drag, so each bead travels
    // with the chassis and the orbit phase draws a ribbon around it. With drag
    // the beads decelerate and smear into a 7 m dotted line behind the kart.
    this.dRibbon = makeDesc({
      sprite: SPRITE.GLOW, ramp: RAMP.PURPLE_SPARK, curve: CURVE.BELL,
      size: 0.34, sizeVar: 0.15, life: 0.15, lifeVar: 0.12,
      speed: 0, speedVar: 0, cone: 0,
      inherit: 1, drag: 0, soft: 0.5,
      additive: 1, alpha: 0.85, intensity: 1.0,
    });

    // A broad, very faint halo bigger than the chassis. It has to stay wider
    // than the kart: any smaller and it reads as a glowing blob stuck to the
    // roof rather than the body being charged up.
    this.dRim = makeDesc({
      sprite: SPRITE.GLOW, ramp: RAMP.WHITE, curve: CURVE.BELL,
      size: 2.8, sizeVar: 0.1, life: 0.12, lifeVar: 0.1,
      speed: 0, cone: 0, inherit: 1.0, jitter: 0.1,
      soft: 1.4, additive: 1, alpha: 0.11, intensity: 0.7,
    });

    // --- tier-up celebration -------------------------------------------------
    this.dRing = makeDesc({
      sprite: SPRITE.RING, ramp: RAMP.WHITE_SHARP, curve: CURVE.PUFF,
      flags: PFLAG.PLANE,
      size: 3.4, sizeVar: 0, life: 0.40, lifeVar: 0,
      spin: 1.2, spinVar: 0, soft: 0.5,
      additive: 1, alpha: 0.95, intensity: 1.4,
    });
    this.dRingInner = makeDesc({
      sprite: SPRITE.GLOW, ramp: RAMP.WHITE_SHARP, curve: CURVE.POP,
      flags: PFLAG.PLANE,
      size: 2.2, sizeVar: 0, life: 0.22, lifeVar: 0,
      soft: 0.5, additive: 1, alpha: 0.8, intensity: 1.6,
    });
    this.dFlare = makeDesc({
      sprite: SPRITE.FLARE, ramp: RAMP.WHITE_SHARP, curve: CURVE.SPIKE,
      size: 2.6, sizeVar: 0.2, life: 0.26, lifeVar: 0.2,
      speed: 0.6, cone: 3.14, jitter: 0.2, drag: 2,
      soft: 0, flags: PFLAG.HARD,
      additive: 1, alpha: 0.9, intensity: 1.5,
    });
    this.dBurstSpark = makeDesc({
      sprite: SPRITE.SPARK, ramp: RAMP.WHITE_SHARP, curve: CURVE.SHRINK,
      flags: PFLAG.STRETCH | PFLAG.BOUNCE,
      size: 0.24, sizeVar: 0.5, life: 0.55, lifeVar: 0.4,
      speed: 13, speedVar: 0.6, cone: 1.5,
      inherit: 0.45, gravity: 16, drag: 1.0, restitution: 0.4,
      stretch: 0.026, soft: 0.2,
      additive: 1, alpha: 1, intensity: 1.15,
    });
  }

  private fx(id: number): KartFx {
    let s = this.state.get(id);
    if (!s) {
      s = {
        stage: DriftStage.None, accL: 0, accR: 0, accWisp: 0,
        accEmber: 0, accArc: 0, accRibbon: 0, ribbonPhase: 0, glowPulse: 0,
        lastTier: -99,
      };
      this.state.set(id, s);
    }
    return s;
  }

  // -------------------------------------------------------------------------

  update(): void {
    const { ctx } = this;
    const dt = ctx.dt;
    const karts = this.src.karts;
    if (!karts) return;

    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      const s = this.fx(k.id);

      // Distance LOD — far karts still spark, but cheaply.
      const dist = ctx.camera.position.distanceTo(k.position);
      if (dist > 140) { s.stage = k.driftStage; continue; }
      const lod = dist < 28 ? 1 : dist < 65 ? 0.55 : 0.22;
      const rate = lod * ctx.throttle;

      if (k.driftStage !== s.stage) {
        if (k.driftStage > s.stage && k.driftStage >= DriftStage.Blue) {
          this.tierBurst(k, k.driftStage - 1);
        }
        s.stage = k.driftStage;
      }

      if (!k.drifting || !k.grounded || k.driftStage === DriftStage.None) {
        s.accL = s.accR = s.accWisp = s.accEmber = s.accArc = 0;
        continue;
      }

      tmpFwd.copy(F_LOCAL).applyQuaternion(k.quaternion);
      tmpRight.copy(R_LOCAL).applyQuaternion(k.quaternion);
      tmpUp.copy(U_LOCAL).applyQuaternion(k.quaternion);

      const dirSign = k.driftDirection >= 0 ? 1 : -1;
      const speedF = clamp01(Math.abs(k.speed) / 18);

      // Spray arc: backwards, kicked outward against the drift, lifted a little.
      tmpDir.copy(tmpFwd).multiplyScalar(-0.78)
        .addScaledVector(tmpRight, -dirSign * 0.46)
        .addScaledVector(tmpUp, 0.34)
        .normalize();

      if (k.driftStage === DriftStage.Charging) {
        this.emitCharge(k, s, dirSign, rate * speedF, dt);
        continue;
      }

      const stage = k.driftStage;
      const sparkDesc = stage === DriftStage.Blue ? this.dSparkBlue
        : stage === DriftStage.Orange ? this.dSparkOrange : this.dSparkPurple;
      const glowDesc = stage === DriftStage.Blue ? this.dGlowBlue
        : stage === DriftStage.Orange ? this.dGlowOrange : this.dGlowPurple;
      const baseRate = stage === DriftStage.Blue ? 150
        : stage === DriftStage.Orange ? 210 : 270;
      const perWheel = baseRate * (0.45 + 0.55 * speedF) * rate;

      this.emitWheel(k, s, 'wheelRL', REAR_L, sparkDesc, glowDesc, perWheel, dt, true);
      this.emitWheel(k, s, 'wheelRR', REAR_R, sparkDesc, glowDesc, perWheel, dt, false);

      // Rim glow wash over the chassis — sells "the kart itself is charged".
      s.glowPulse += dt;
      if (s.glowPulse > 0.055 && dist < 60) {
        s.glowPulse = 0;
        const rim = this.dRim;
        rim.tint.copy(sparkDesc.tint);
        rim.ramp = sparkDesc.ramp;
        rim.size = stage === DriftStage.Purple ? 3.1 : 2.7;
        rim.alpha = stage === DriftStage.Blue ? 0.08 : stage === DriftStage.Orange ? 0.10 : 0.13;
        tmpA.copy(k.position);
        this.ctx.particles.spawn(rim, tmpA, k.velocity, tmpA.y - 1, 1, 1);
      }

      if (stage === DriftStage.Orange || stage === DriftStage.Purple) {
        s.accEmber += (stage === DriftStage.Orange ? 26 : 34) * rate * dt;
        while (s.accEmber >= 1) {
          s.accEmber -= 1;
          socketPos(this.src, k, 'rearCentre', 0, -0.1, 0.75, tmpA);
          this.ctx.particles.emit(this.dEmber, 1, tmpA, tmpDir, k.velocity, tmpA.y - 0.5, 1);
        }
        if (Math.random() < 12 * dt * rate) {
          socketPos(this.src, k, 'rearCentre', 0, 0.0, 0.8, tmpA);
          this.ctx.particles.emit(this.dShimmer, 1, tmpA, tmpUp, k.velocity, tmpA.y - 1, 1);
        }
      }

      if (stage === DriftStage.Purple) {
        // Electric arcs crawling around the rear.
        s.accArc += 34 * rate * dt;
        while (s.accArc >= 1) {
          s.accArc -= 1;
          const side = Math.random() < 0.5 ? -1 : 1;
          tmpA.copy(k.position)
            .addScaledVector(tmpRight, side * (0.35 + Math.random() * 0.55))
            .addScaledVector(tmpFwd, -0.2 - Math.random() * 0.8)
            .addScaledVector(tmpUp, -0.1 + Math.random() * 0.5);
          tmpB.copy(tmpRight).multiplyScalar(side).addScaledVector(tmpUp, 0.6);
          this.ctx.particles.emit(this.dArc, 1, tmpA, tmpB, k.velocity, tmpA.y - 2, 1);
        }
        // Swirling ribbon of light orbiting the chassis.
        s.ribbonPhase += dt * 7.5;
        s.accRibbon += 120 * rate * dt;
        while (s.accRibbon >= 1) {
          s.accRibbon -= 1;
          for (let a = 0; a < 2; a++) {
            const ang = s.ribbonPhase + a * Math.PI;
            tmpA.copy(k.position)
              .addScaledVector(tmpRight, Math.cos(ang) * 0.88)
              .addScaledVector(tmpFwd, Math.sin(ang) * 1.05)
              .addScaledVector(tmpUp, 0.18 + 0.34 * Math.sin(s.ribbonPhase * 1.7 + a));
            this.ctx.particles.spawn(this.dRibbon, tmpA, k.velocity, tmpA.y - 2, 1, 1);
          }
        }
      }
    }
  }

  private emitCharge(k: KartState, s: KartFx, dirSign: number, rate: number, dt: number): void {
    s.accWisp += 46 * rate * dt;
    if (s.accWisp < 1) return;
    const name: SocketName = dirSign > 0 ? 'wheelRR' : 'wheelRL';
    const off = dirSign > 0 ? REAR_R : REAR_L;
    socketPos(this.src, k, name, off[0], off[1], off[2], tmpA);
    const groundY = tmpA.y - 0.30;
    tmpA.y = groundY + 0.06;
    while (s.accWisp >= 1) {
      s.accWisp -= 1;
      tmpB.copy(tmpUp).multiplyScalar(0.6).addScaledVector(tmpFwd, -0.6).normalize();
      this.ctx.particles.emit(this.dWisp, 1, tmpA, tmpB, k.velocity, groundY, 1);
    }
  }

  private emitWheel(
    k: KartState, s: KartFx, name: SocketName, off: [number, number, number],
    sparkDesc: EmitterDesc, glowDesc: EmitterDesc,
    perSecond: number, dt: number, left: boolean,
  ): void {
    const acc = left ? 'accL' : 'accR';
    s[acc] += perSecond * dt;
    if (s[acc] < 1) return;

    socketPos(this.src, k, name, off[0], off[1], off[2], tmpC);
    const groundY = tmpC.y - 0.30;
    tmpC.y = groundY + 0.05;

    let n = Math.floor(s[acc]);
    s[acc] -= n;
    if (n > 24) n = 24;
    this.ctx.particles.emit(sparkDesc, n, tmpC, tmpDir, k.velocity, groundY, 1);
    // Roughly one soft glow per two sparks. Without these the spray reads as a
    // scatter of thin lines; with them the contact patch is a hot mass.
    const g = Math.max(1, Math.round(n * 0.45));
    this.ctx.particles.emit(glowDesc, g, tmpC, tmpDir, k.velocity, groundY, 1);
  }

  /**
   * `tier` is 0-based: 0 = blue, 1 = orange, 2 = purple.
   *
   * Both the `kart:driftTier` event and this module's own `driftStage` watcher
   * want to fire this, and they land on the same frame — so the celebration is
   * debounced rather than doubled.
   */
  tierBurst(k: KartState, tier: number): void {
    const s = this.fx(k.id);
    if (this.ctx.time - s.lastTier < 0.14) return;
    s.lastTier = this.ctx.time;
    socketPos(this.src, k, 'rearCentre', 0, -0.05, 0.85, tmpA);
    this.tierBurstAt(tmpA, tier, k.velocity, 1);
    if (k.isPlayer) this.ctx.shake(0.10 + tier * 0.045, 0.16 + tier * 0.04);
  }

  tierBurstAt(pos: THREE.Vector3, tier: number, vel: THREE.Vector3 | null, scale: number): void {
    const t = Math.max(0, Math.min(2, tier | 0));
    const ramp = t === 0 ? RAMP.BLUE_SPARK : t === 1 ? RAMP.ORANGE_SPARK : RAMP.PURPLE_SPARK;
    const p = this.ctx.particles;

    tmpUp.set(0, 1, 0);
    const groundY = pos.y - 0.35;
    tmpB.set(pos.x, groundY + 0.05, pos.z);

    this.dRing.ramp = ramp;
    this.dRing.size = (3.0 + t * 0.9) * scale;
    p.spawnPlane(this.dRing, tmpB, tmpUp, 1, 1);
    this.dRingInner.ramp = ramp;
    this.dRingInner.size = (1.8 + t * 0.5) * scale;
    p.spawnPlane(this.dRingInner, tmpB, tmpUp, 1, 1);

    this.dFlare.ramp = ramp;
    this.dFlare.size = (2.2 + t * 0.7) * scale;
    p.emit(this.dFlare, 2, pos, tmpUp, vel, groundY, 1);

    this.dBurstSpark.ramp = ramp;
    this.dBurstSpark.size = (0.20 + t * 0.045) * scale;
    this.dBurstSpark.speed = 12 + t * 4;
    p.emit(this.dBurstSpark, Math.round((18 + t * 10) * this.ctx.throttle), pos, tmpUp, vel, groundY, 1);

    // A second, flatter fan so the burst hugs the ground like MK8's does.
    tmpC.copy(tmpUp).multiplyScalar(0.25).normalize();
    this.dBurstSpark.cone = 1.9;
    p.emit(this.dBurstSpark, Math.round((14 + t * 8) * this.ctx.throttle), tmpB, tmpC, vel, groundY, 1);
    this.dBurstSpark.cone = 1.5;
  }

  dispose(): void { this.state.clear(); }
}
