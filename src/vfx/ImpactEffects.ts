/**
 * ============================================================================
 *  IMPACT EFFECTS — every one-shot in the game
 * ============================================================================
 *  Collisions, explosions, item hits, race-flow flourishes. Nothing here polls
 *  state: VfxManager routes the event bus into these methods.
 *
 *  The rule for every effect in this file is LAYERS. A single expanding sprite
 *  is what a WebGL demo does. An explosion here is:
 *
 *      1  a 2-frame white flash (no depth fade, blows out the exposure)
 *      2  a core that pops open, then an expanding turbulent fireball
 *      3  a faint fast-expanding pressure shell (the distortion read)
 *      4  a ground shockwave: two rings, one tight and bright, one wide and soft
 *      5  lofted physics debris that actually bounces and settles (CPU pool)
 *      6  sparks + embers thrown on ballistic arcs
 *      7  a smoke column that keeps rising for two more seconds
 *      8  a scorch decal that stays on the tarmac
 *
 *  Layers 7/8 arrive *after* the bang, which is what makes it read as an event
 *  rather than a sprite. That timing comes from a small preallocated scheduler
 *  (no allocation, no setTimeout, frame-rate independent).
 * ============================================================================
 */

import * as THREE from 'three';
import { ItemType, type KartState, type SurfaceProperties } from '@/core/Types';
import { clamp01 } from '@/core/MathUtils';
import { CURVE, RAMP, SPRITE } from './sprites/Atlas';
import {
  makeDesc, PFLAG,
  type EmitterDesc, type KartSource, type VfxContext,
} from './ParticleSystem';

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Loose contracts so this module never imports its siblings' classes. */
export interface SurfacePuffLike {
  puff(family: SurfaceProperties['particle'], pos: THREE.Vector3, normal: THREE.Vector3, scale: number): void;
}
export interface DecalsLike {
  scorch(pos: THREE.Vector3, normal: THREE.Vector3, size: number): void;
  splat(pos: THREE.Vector3, normal: THREE.Vector3, size: number, life: number, alpha: number,
    r: number, g: number, b: number): void;
}
export interface OverlayLike {
  ink(seconds: number): void;
  impactFrame(amount: number): void;
}

// ---------------------------------------------------------------------------
// Deferred sub-effects
// ---------------------------------------------------------------------------

const enum Kind {
  Column = 0,
  Ember = 1,
  Arc = 2,
  Sparkle = 3,
  Confetti = 4,
  Bolt = 5,
  Aftershock = 6,
  Ring = 7,
}

interface Pending {
  active: boolean;
  at: number;
  kind: Kind;
  scale: number;
  /** Follow this kart instead of the stored point when >= 0. */
  kartId: number;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
}

const SCHEDULE_CAP = 160;

export class ImpactEffects {
  private ctx: VfxContext;
  private src: KartSource;
  private surf: SurfacePuffLike;
  private decals: DecalsLike;
  private overlay: OverlayLike;

  private queue: Pending[] = [];
  private queueHead = 0;

  // --- fire / explosion -----------------------------------------------------
  private dFlash: EmitterDesc;
  private dCore: EmitterDesc;
  private dFireball: EmitterDesc;
  private dFireLick: EmitterDesc;
  private dPressure: EmitterDesc;
  private dShockTight: EmitterDesc;
  private dShockWide: EmitterDesc;
  private dDebris: EmitterDesc;
  private dColumn: EmitterDesc;
  private dSpark: EmitterDesc;
  private dEmber: EmitterDesc;

  // --- collisions -----------------------------------------------------------
  private dWallSpark: EmitterDesc;
  private dWallGlow: EmitterDesc;
  private dPuff: EmitterDesc;
  private dCompress: EmitterDesc;
  private dStar: EmitterDesc;
  private dStunRing: EmitterDesc;
  /** Rate limit for the pinned wall-contact flash — see `wallHit`. */
  private lastWallFlash = -1;
  private readonly lastWallPos = new THREE.Vector3();
  private dGroundRing: EmitterDesc;
  private dChip: EmitterDesc;

  // --- items ----------------------------------------------------------------
  private dShard: EmitterDesc;
  private dSparkle: EmitterDesc;
  private dGoldStar: EmitterDesc;
  private dRainbow: EmitterDesc;
  private dBolt: EmitterDesc;
  private dArc: EmitterDesc;
  private dInkDrop: EmitterDesc;
  private dInkSplat: EmitterDesc;
  private dConfetti: EmitterDesc;
  private dSmokePuff: EmitterDesc;
  private dGhost: EmitterDesc;
  private dStreak: EmitterDesc;

  constructor(
    ctx: VfxContext,
    src: KartSource,
    surf: SurfacePuffLike,
    decals: DecalsLike,
    overlay: OverlayLike,
  ) {
    this.ctx = ctx;
    this.src = src;
    this.surf = surf;
    this.decals = decals;
    this.overlay = overlay;

    for (let i = 0; i < SCHEDULE_CAP; i++) {
      this.queue.push({
        active: false, at: 0, kind: Kind.Column, scale: 1, kartId: -1,
        pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0),
      });
    }

    // ======================= explosion ====================================

    // 1 — the flash. Two frames of pure white, no depth fade, big enough to
    //     take over the exposure for an instant.
    this.dFlash = makeDesc({
      sprite: SPRITE.FLARE, ramp: RAMP.WHITE_SHARP, curve: CURVE.SPIKE,
      flags: PFLAG.HARD,
      size: 6.0, sizeVar: 0.12, life: 0.10, lifeVar: 0.15,
      speed: 0.8, cone: 3.14, drag: 4, soft: 0,
      additive: 1, alpha: 1, intensity: 3.4,
    });

    // 2 — the core, then the fireball proper.
    this.dCore = makeDesc({
      sprite: SPRITE.GLOW, ramp: RAMP.FIREBALL, curve: CURVE.POP,
      size: 3.2, sizeVar: 0.15, life: 0.26, lifeVar: 0.12,
      speed: 1.4, speedVar: 0.6, cone: 3.14, jitter: 0.25, drag: 3.2,
      gravity: -1.5, soft: 0.8,
      additive: 1, alpha: 1, intensity: 2.2,
    });
    // DUST, not SMOKE: the body of a fireball has to be a dense round puff.
    // The wispy smoke sprite reads as a dirty cloud rather than burning fuel.
    this.dFireball = makeDesc({
      sprite: SPRITE.DUST, ramp: RAMP.FIREBALL, curve: CURVE.SWELL,
      flags: PFLAG.TURB,
      size: 1.6, sizeVar: 0.42, life: 0.58, lifeVar: 0.3,
      speed: 8.5, speedVar: 0.65, cone: 3.14,
      drift: new THREE.Vector3(0, 2.6, 0), jitter: 0.3,
      gravity: -3.2, drag: 3.4, turbAmp: 0.9, turbFreq: 0.9,
      spin: 1.6, soft: 1.2,
      additive: 0.62, alpha: 1, intensity: 1.75,
    });
    this.dFireLick = makeDesc({
      sprite: SPRITE.FLAME, ramp: RAMP.FLAME, curve: CURVE.SHRINK,
      flags: PFLAG.STRETCH,
      size: 0.9, sizeVar: 0.5, life: 0.26, lifeVar: 0.4,
      speed: 15.0, speedVar: 0.6, cone: 3.14,
      drag: 4.5, stretch: 0.013, soft: 0.35,
      additive: 1, alpha: 0.95, intensity: 1.7,
    });

    // 3 — the pressure shell. A near-invisible bright membrane racing outward:
    //     the cheap, honest stand-in for a refraction pass.
    this.dPressure = makeDesc({
      sprite: SPRITE.MIST, ramp: RAMP.WHITE, curve: CURVE.SWELL,
      size: 5.5, sizeVar: 0.1, life: 0.30, lifeVar: 0.1,
      speed: 0.5, cone: 3.14, drag: 2, soft: 1.4,
      additive: 0.65, alpha: 0.16, intensity: 1.6,
    });

    // 4 — ground shockwave.
    this.dShockTight = makeDesc({
      sprite: SPRITE.RING, ramp: RAMP.WHITE_SHARP, curve: CURVE.PUFF,
      flags: PFLAG.PLANE,
      size: 6.0, sizeVar: 0, life: 0.34, lifeVar: 0,
      spin: 0.8, spinVar: 0, soft: 0.6,
      additive: 1, alpha: 0.9, intensity: 1.5,
    });
    this.dShockWide = makeDesc({
      sprite: SPRITE.RING, ramp: RAMP.ORANGE_SPARK, curve: CURVE.SWELL,
      flags: PFLAG.PLANE,
      size: 9.5, sizeVar: 0, life: 0.58, lifeVar: 0,
      spin: -0.5, spinVar: 0, soft: 0.7,
      additive: 0.85, alpha: 0.55, intensity: 1.2,
    });

    // 5 — debris. CPU-simulated so the chips genuinely settle on the road.
    this.dDebris = makeDesc({
      sprite: SPRITE.CHIP, ramp: RAMP.DEBRIS, curve: CURVE.CONST,
      flags: PFLAG.CPU,
      size: 0.19, sizeVar: 0.6, life: 2.4, lifeVar: 0.4,
      speed: 13.0, speedVar: 0.75, cone: 1.35,
      gravity: 24, drag: 0.35, restitution: 0.34,
      spin: 15, soft: 0.2,
      additive: 0, alpha: 1, intensity: 1,
    });

    // 7 — smoke column.
    this.dColumn = makeDesc({
      sprite: SPRITE.SMOKE, ramp: RAMP.SMOKE_DARK, curve: CURVE.SWELL,
      flags: PFLAG.TURB,
      size: 1.5, sizeVar: 0.4, life: 2.5, lifeVar: 0.35,
      speed: 2.0, speedVar: 0.7, cone: 0.75, jitter: 0.35,
      drift: new THREE.Vector3(0, 3.0, 0),
      gravity: -1.5, drag: 0.85, turbAmp: 1.15, turbFreq: 0.55,
      spin: 0.8, soft: 1.8,
      additive: 0.04, alpha: 0.5, intensity: 1,
    });

    // 6 — sparks + embers.
    this.dSpark = makeDesc({
      sprite: SPRITE.SPARK, ramp: RAMP.ORANGE_SPARK, curve: CURVE.SHRINK,
      flags: PFLAG.STRETCH | PFLAG.BOUNCE,
      size: 0.26, sizeVar: 0.55, life: 0.62, lifeVar: 0.45,
      speed: 19.0, speedVar: 0.7, cone: 3.14,
      gravity: 18, drag: 0.9, restitution: 0.36,
      stretch: 0.027, soft: 0.2,
      additive: 1, alpha: 1, intensity: 1.25,
    });
    this.dEmber = makeDesc({
      sprite: SPRITE.EMBER, ramp: RAMP.EMBER, curve: CURVE.SHRINK,
      flags: PFLAG.TURB,
      size: 0.12, sizeVar: 0.6, life: 1.5, lifeVar: 0.5,
      speed: 5.5, speedVar: 0.8, cone: 2.4,
      drift: new THREE.Vector3(0, 2.2, 0),
      gravity: 2.0, drag: 1.1, turbAmp: 0.8, turbFreq: 0.9,
      soft: 0.25, additive: 1, alpha: 1, intensity: 1.2,
    });

    // ======================= collisions ===================================

    this.dWallSpark = makeDesc({
      sprite: SPRITE.SPARK, ramp: RAMP.METAL_SPARK, curve: CURVE.SHRINK,
      flags: PFLAG.STRETCH | PFLAG.BOUNCE,
      size: 0.19, sizeVar: 0.5, life: 0.5, lifeVar: 0.4,
      speed: 13.0, speedVar: 0.7, cone: 1.05,
      inherit: 0.25, jitter: 0.12,
      gravity: 19, drag: 1.0, restitution: 0.4,
      stretch: 0.030, soft: 0.18,
      additive: 1, alpha: 1, intensity: 1.15,
    });
    this.dWallGlow = makeDesc({
      sprite: SPRITE.GLOW, ramp: RAMP.METAL_SPARK, curve: CURVE.SPIKE,
      size: 0.9, sizeVar: 0.3, life: 0.18, lifeVar: 0.25,
      speed: 2.2, speedVar: 0.7, cone: 1.2, jitter: 0.16, drag: 3.5,
      soft: 0.5, additive: 1, alpha: 0.9, intensity: 1.5,
    });
    this.dPuff = makeDesc({
      sprite: SPRITE.DUST, ramp: RAMP.DUST, curve: CURVE.PUFF,
      flags: PFLAG.TURB,
      size: 0.85, sizeVar: 0.45, life: 1.1, lifeVar: 0.4,
      speed: 4.0, speedVar: 0.7, cone: 1.3, jitter: 0.18,
      drift: new THREE.Vector3(0, 1.1, 0),
      gravity: -0.8, drag: 2.4, turbAmp: 0.7, turbFreq: 0.9,
      spin: 1.4, soft: 1.2,
      additive: 0, alpha: 0.6, intensity: 1,
    });
    this.dCompress = makeDesc({
      sprite: SPRITE.RING, ramp: RAMP.WHITE_SHARP, curve: CURVE.PUFF,
      flags: PFLAG.PLANE,
      size: 3.2, sizeVar: 0, life: 0.26, lifeVar: 0,
      soft: 0.5, additive: 1, alpha: 0.95, intensity: 1.8,
    });
    this.dStar = makeDesc({
      sprite: SPRITE.STAR, ramp: RAMP.STAR_YELLOW, curve: CURVE.BELL,
      size: 0.55, sizeVar: 0.35, life: 0.85, lifeVar: 0.3,
      speed: 4.5, speedVar: 0.6, cone: 2.0, jitter: 0.2,
      gravity: 6.5, drag: 1.0, spin: 9, spinVar: 0.6,
      soft: 0.3, additive: 1, alpha: 1, intensity: 1.3,
    });
    /**
     * The stunned ring. Separate from `dStar` because it is a different effect
     * with a different job: `dStar` is the impact spray (ballistic, brief),
     * this one has to READ as a ring circling the victim's head for as long as
     * the spin-out lasts, and it has to do that without covering the kart.
     *
     * Size is 0.26 against dStar's 0.45-at-emit. A 0.45 m billboard 4 m from a
     * chase camera is ~60 px tall in an 800x450 frame and there were seven of
     * them landing on the kart's own silhouette; 0.26 m on a 0.62 m orbit puts
     * them clear of the roofline and each one around 35 px.
     */
    this.dStunRing = makeDesc({
      sprite: SPRITE.STAR, ramp: RAMP.STAR_YELLOW, curve: CURVE.BELL,
      flags: PFLAG.ORBIT,
      size: 0.26, sizeVar: 0.12, life: 1.05, lifeVar: 0.12,
      spin: 5.5, spinVar: 0.3,
      soft: 0.3, additive: 1, alpha: 0.9, intensity: 1.25,
    });
    // Dust displaced by a landing/spin, laid flat on the road. `additive` and
    // `alpha` were 0.15/0.70 over a sprite whose bright band was a tenth of the
    // cell wide: a near-opaque brown annulus painted on the tarmac. With the
    // band widened in `paintRing` this also wants to sit lighter — dust scatters
    // light, it does not coat the road.
    this.dGroundRing = makeDesc({
      sprite: SPRITE.RING, ramp: RAMP.DUST, curve: CURVE.SWELL,
      flags: PFLAG.PLANE,
      size: 4.2, sizeVar: 0, life: 0.5, lifeVar: 0,
      spin: 0.4, spinVar: 0, soft: 0.7,
      additive: 0.28, alpha: 0.46, intensity: 1,
    });
    this.dChip = makeDesc({
      sprite: SPRITE.CHIP, ramp: RAMP.DEBRIS, curve: CURVE.CONST,
      flags: PFLAG.BOUNCE,
      size: 0.09, sizeVar: 0.6, life: 1.0, lifeVar: 0.45,
      speed: 6.5, speedVar: 0.7, cone: 1.0,
      gravity: 21, drag: 0.4, restitution: 0.3,
      spin: 14, soft: 0.15, additive: 0, alpha: 1, intensity: 1,
    });

    // ======================= items ========================================

    // Height-budgeted like the drift tier burst: 9.0 m/s with speedVar 0.7 tops
    // out at 15.3 m/s, i.e. v^2/2g = 6.9 m of ballistic rise off a 1.9 m kart —
    // a column of white shards towering ~400 px over the roof in a chase frame.
    // 6.2 m/s peaks near 2.7 m, which reads as debris off the shell rather than
    // a firework.
    this.dShard = makeDesc({
      sprite: SPRITE.CHIP, ramp: RAMP.WHITE_SHARP, curve: CURVE.SHRINK,
      flags: PFLAG.BOUNCE,
      size: 0.24, sizeVar: 0.55, life: 0.6, lifeVar: 0.4,
      speed: 6.2, speedVar: 0.55, cone: 3.14,
      gravity: 17, drag: 0.9, restitution: 0.4,
      spin: 13, soft: 0.25,
      additive: 0.55, alpha: 1, intensity: 1.5,
    });
    this.dSparkle = makeDesc({
      sprite: SPRITE.FLARE, ramp: RAMP.WHITE_SHARP, curve: CURVE.SPIKE,
      flags: PFLAG.HARD,
      size: 0.7, sizeVar: 0.6, life: 0.55, lifeVar: 0.45,
      speed: 4.0, speedVar: 0.8, cone: 3.14, jitter: 0.35,
      gravity: 2.5, drag: 1.8, soft: 0,
      additive: 1, alpha: 1, intensity: 1.7,
    });
    this.dGoldStar = makeDesc({
      sprite: SPRITE.STAR, ramp: RAMP.GOLD, curve: CURVE.BELL,
      size: 0.4, sizeVar: 0.5, life: 0.9, lifeVar: 0.4,
      speed: 3.2, speedVar: 0.7, cone: 2.6, jitter: 0.2,
      drift: new THREE.Vector3(0, 1.6, 0),
      gravity: 3.5, drag: 1.2, spin: 8,
      soft: 0.3, additive: 1, alpha: 1, intensity: 1.4,
    });
    this.dRainbow = makeDesc({
      sprite: SPRITE.GLOW, ramp: RAMP.RAINBOW, curve: CURVE.POP,
      size: 1.1, sizeVar: 0.5, life: 0.55, lifeVar: 0.4,
      speed: 8.0, speedVar: 0.7, cone: 3.14, jitter: 0.2,
      gravity: -1.0, drag: 2.6, soft: 0.6,
      additive: 1, alpha: 1, intensity: 1.6,
    });
    // Near-static, heavily stretched segment — used to draw bolt paths.
    this.dBolt = makeDesc({
      sprite: SPRITE.BOLT, ramp: RAMP.ELECTRIC, curve: CURVE.CONST,
      flags: PFLAG.STRETCH | PFLAG.HARD,
      size: 1.1, sizeVar: 0.25, life: 0.13, lifeVar: 0.3,
      speed: 3.2, speedVar: 0.2, cone: 0.05,
      stretch: 0.95, soft: 0,
      additive: 1, alpha: 1, intensity: 2.0,
    });
    this.dArc = makeDesc({
      sprite: SPRITE.BOLT, ramp: RAMP.ELECTRIC, curve: CURVE.CONST,
      flags: PFLAG.STRETCH | PFLAG.HARD,
      size: 0.5, sizeVar: 0.5, life: 0.08, lifeVar: 0.4,
      speed: 4.5, speedVar: 0.8, cone: 2.6, jitter: 0.5,
      stretch: 0.05, soft: 0,
      additive: 1, alpha: 1, intensity: 1.5,
    });
    this.dInkDrop = makeDesc({
      sprite: SPRITE.DROPLET, ramp: RAMP.INK, curve: CURVE.CONST,
      flags: PFLAG.STRETCH,
      size: 0.28, sizeVar: 0.6, life: 0.9, lifeVar: 0.4,
      speed: 8.0, speedVar: 0.7, cone: 1.6,
      gravity: 20, drag: 0.5, stretch: 0.010, soft: 0.3,
      additive: 0, alpha: 1, intensity: 1,
    });
    this.dInkSplat = makeDesc({
      sprite: SPRITE.SPLAT, ramp: RAMP.INK, curve: CURVE.PUFF,
      flags: PFLAG.PLANE,
      size: 2.6, sizeVar: 0.3, life: 1.4, lifeVar: 0.3,
      spin: 0.6, soft: 0.4, additive: 0, alpha: 0.95, intensity: 1,
    });
    this.dConfetti = makeDesc({
      sprite: SPRITE.CONFETTI, ramp: RAMP.RAINBOW, curve: CURVE.CONST,
      flags: PFLAG.BOUNCE | PFLAG.TURB,
      size: 0.30, sizeVar: 0.5, life: 3.4, lifeVar: 0.35,
      speed: 9.0, speedVar: 0.7, cone: 1.15,
      gravity: 7.0, drag: 1.5, restitution: 0.2,
      turbAmp: 1.3, turbFreq: 0.8,
      spin: 11, soft: 0.35,
      additive: 0.2, alpha: 1, intensity: 1.15,
    });
    this.dSmokePuff = makeDesc({
      sprite: SPRITE.SMOKE, ramp: RAMP.SMOKE, curve: CURVE.PUFF,
      flags: PFLAG.TURB,
      size: 0.95, sizeVar: 0.4, life: 1.0, lifeVar: 0.35,
      speed: 3.0, speedVar: 0.7, cone: 1.5, jitter: 0.2,
      drift: new THREE.Vector3(0, 1.6, 0),
      gravity: -1.2, drag: 2.2, turbAmp: 0.8, turbFreq: 1.0,
      spin: 1.6, soft: 1.3,
      additive: 0.08, alpha: 0.55, intensity: 1,
    });
    this.dGhost = makeDesc({
      sprite: SPRITE.MIST, ramp: RAMP.GHOST, curve: CURVE.SWELL,
      flags: PFLAG.TURB,
      size: 1.3, sizeVar: 0.4, life: 0.75, lifeVar: 0.3,
      speed: 3.5, speedVar: 0.7, cone: 3.14, jitter: 0.25,
      drift: new THREE.Vector3(0, 2.0, 0),
      gravity: -2.0, drag: 2.4, turbAmp: 0.7, turbFreq: 1.1,
      spin: 1.2, soft: 1.0,
      additive: 0.7, alpha: 0.55, intensity: 1.2,
    });
    this.dStreak = makeDesc({
      sprite: SPRITE.SPARK, ramp: RAMP.WHITE_SHARP, curve: CURVE.SHRINK,
      flags: PFLAG.STRETCH,
      size: 0.34, sizeVar: 0.5, life: 0.4, lifeVar: 0.4,
      speed: 26.0, speedVar: 0.5, cone: 0.55,
      drag: 1.4, stretch: 0.024, soft: 0.2,
      additive: 1, alpha: 1, intensity: 1.6,
    });
  }

  // =========================================================================
  // Scheduler
  // =========================================================================

  private schedule(
    kind: Kind, delay: number, pos: THREE.Vector3 | null,
    dir: THREE.Vector3 | null, scale: number, kartId = -1,
  ): void {
    // Ring-buffer allocation: a dropped tail effect is never worth a GC pause.
    const q = this.queue[this.queueHead];
    this.queueHead = (this.queueHead + 1) % SCHEDULE_CAP;
    q.active = true;
    q.at = this.ctx.time + delay;
    q.kind = kind;
    q.scale = scale;
    q.kartId = kartId;
    if (pos) q.pos.copy(pos);
    if (dir) q.dir.copy(dir); else q.dir.set(0, 1, 0);
  }

  private kartById(id: number): KartState | null {
    const karts = this.src.karts;
    if (!karts) return null;
    for (let i = 0; i < karts.length; i++) if (karts[i].id === id) return karts[i];
    return null;
  }

  update(): void {
    const now = this.ctx.time;
    for (let i = 0; i < SCHEDULE_CAP; i++) {
      const q = this.queue[i];
      if (!q.active || q.at > now) continue;
      q.active = false;

      if (q.kartId >= 0) {
        const k = this.kartById(q.kartId);
        if (!k) continue;
        q.pos.copy(k.position);
      }
      const p = this.ctx.particles;

      switch (q.kind) {
        case Kind.Column:
          p.emit(this.dColumn, Math.max(1, Math.round(3 * this.ctx.throttle)),
            q.pos, UP, null, q.pos.y - 0.4, q.scale);
          break;
        case Kind.Ember:
          p.emit(this.dEmber, Math.max(1, Math.round(4 * this.ctx.throttle)),
            q.pos, UP, null, q.pos.y - 0.4, q.scale);
          break;
        case Kind.Arc: {
          const n = Math.max(1, Math.round(3 * this.ctx.throttle));
          tmpA.copy(q.pos).y += 0.35;
          p.emit(this.dArc, n, tmpA, UP, null, tmpA.y - 3, q.scale);
          break;
        }
        case Kind.Sparkle:
          p.emit(this.dSparkle, Math.max(1, Math.round(4 * this.ctx.throttle)),
            q.pos, UP, null, q.pos.y - 1, q.scale);
          break;
        case Kind.Confetti:
          this.confettiWave(q.pos, q.scale);
          break;
        case Kind.Bolt:
          this.boltPath(q.pos, q.scale);
          break;
        case Kind.Aftershock:
          p.emit(this.dFireball, Math.max(2, Math.round(5 * this.ctx.throttle)),
            q.pos, UP, null, q.pos.y - 0.5, q.scale * 0.7);
          p.emit(this.dSpark, Math.max(2, Math.round(6 * this.ctx.throttle)),
            q.pos, UP, null, q.pos.y - 0.5, q.scale * 0.6);
          break;
        case Kind.Ring:
          this.dShockWide.size = 7.5 * q.scale;
          p.spawnPlane(this.dShockWide, q.pos, q.dir, 1, 1);
          break;
      }
    }
  }

  // =========================================================================
  // Explosion
  // =========================================================================

  /**
   * The full eight-layer blast. `scale` 1 = a bomb; shells use ~0.7, a blue
   * shell ~1.5.
   */
  explosion(pos: THREE.Vector3, normal: THREE.Vector3 | null, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    const s = Math.max(0.25, scale);
    tmpN.copy(normal ?? UP);
    if (tmpN.lengthSq() < 1e-6) tmpN.copy(UP);
    tmpN.normalize();

    // Ground plane for bounces / rings: a little below the blast centre.
    const groundY = pos.y - 0.75 * s;
    tmpC.set(pos.x, groundY + 0.06, pos.z);

    // 1 — flash
    this.dFlash.size = 5.5 * s;
    p.emit(this.dFlash, 2, pos, UP, null, groundY, 1);

    // 2 — core + fireball + licks
    this.dCore.size = 2.8 * s;
    p.emit(this.dCore, 3, pos, UP, null, groundY, 1);
    this.dFireball.size = 1.7 * s;
    this.dFireball.speed = 10.0 * (0.7 + 0.3 * s);
    p.emit(this.dFireball, Math.round(20 * th * Math.min(1.6, s)), pos, UP, null, groundY, 1);
    this.dFireLick.size = 0.85 * s;
    p.emit(this.dFireLick, Math.round(14 * th), pos, UP, null, groundY, 1);

    // 3 — pressure shell
    this.dPressure.size = 5.0 * s;
    p.emit(this.dPressure, 1, pos, UP, null, groundY, 1);

    // 4 — shockwave rings, flat on the ground
    this.dShockTight.size = 5.0 * s;
    p.spawnPlane(this.dShockTight, tmpC, UP, 1, 1);
    this.dShockWide.size = 9.0 * s;
    p.spawnPlane(this.dShockWide, tmpC, UP, 1, 1);
    this.schedule(Kind.Ring, 0.14, tmpC, UP, s * 1.25);

    // 5 — debris (CPU pool, genuinely settles)
    this.dDebris.size = 0.17 * s;
    this.dDebris.speed = 12 * (0.75 + 0.35 * s);
    p.emit(this.dDebris, Math.round(14 * th * Math.min(1.4, s)), pos, UP, null, groundY, 1);

    // 6 — sparks + embers
    this.dSpark.size = 0.24 * s;
    this.dSpark.speed = 18 * (0.8 + 0.3 * s);
    p.emit(this.dSpark, Math.round(30 * th * Math.min(1.5, s)), pos, UP, null, groundY, 1);
    p.emit(this.dEmber, Math.round(12 * th), pos, UP, null, groundY, s);

    // 7 — smoke column. Deliberately NOT emitted on frame 0: if the smoke is
    //     already there when the fireball opens, the fireball reads as dirty
    //     grey instead of hot. It arrives as the fire dies back.
    this.dColumn.size = 1.4 * s;
    for (let i = 1; i <= 6; i++) {
      tmpA.copy(pos).y += 0.32 * i * s;
      this.schedule(Kind.Column, 0.10 + 0.11 * i, tmpA, UP, s * (0.9 + 0.12 * i));
    }
    this.schedule(Kind.Ember, 0.22, pos, UP, s);
    this.schedule(Kind.Aftershock, 0.10, pos, UP, s);

    // 8 — scorch on the deck
    this.decals.scorch(tmpC, tmpN, 3.4 * s);

    this.ctx.flash(0xffd9a0, clamp01(0.30 * s), 0.14);
    this.ctx.shake(clamp01(0.55 * s), 0.34 + 0.1 * s);
  }

  // =========================================================================
  // Collisions
  // =========================================================================

  /** `impact` 0..1. Sparks rake along the wall, dust puffs off it. */
  /**
   * A wall contact.
   *
   * SUSTAINED CONTACT IS THE COMMON CASE, NOT THE RARE ONE. On volcanoRush 99 %
   * of wall contacts are drift excursions the AI cannot end, so this fires every
   * frame for seconds at a time from several karts at once. Each call used to
   * pin another `dCompress` plane — an additive ring up to 3.6 m across at alpha
   * 0.95 and intensity 1.8 — flat against the barrier. A plane seen at the
   * grazing angle a chase camera has on a wall it is scraping projects to a long
   * bright band, and dozens of them overlapping is the "enormous flat white
   * ribbons sweeping across ~35 % of the frame".
   *
   * So the contact flash is now rate-limited per location. Sparks and dust still
   * emit every call (they are small, short-lived and they are what sells the
   * scrape); the big pinned plane is allowed roughly four times a second, and
   * a continuing scrape gets a much smaller, dimmer one.
   */
  wallHit(pos: THREE.Vector3, normal: THREE.Vector3, impact: number, isPlayer: boolean): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    const f = clamp01(impact);
    if (f < 0.03) return;
    const now = this.ctx.time;
    const sustained = now - this.lastWallFlash < 0.24
      && pos.distanceToSquared(this.lastWallPos) < 90;
    tmpN.copy(normal);
    if (tmpN.lengthSq() < 1e-6) tmpN.set(0, 0, 1);
    tmpN.normalize();

    // Tangent along the wall — sparks rake sideways, they don't spray outward.
    tmpT.crossVectors(tmpN, UP);
    if (tmpT.lengthSq() < 1e-4) tmpT.set(1, 0, 0);
    tmpT.normalize();
    const side = Math.random() < 0.5 ? -1 : 1;
    tmpA.copy(tmpT).multiplyScalar(side * 0.82).addScaledVector(tmpN, 0.35)
      .addScaledVector(UP, 0.28).normalize();

    const groundY = pos.y - 0.55;
    this.dWallSpark.size = 0.16 + 0.10 * f;
    this.dWallSpark.speed = 8 + 14 * f;
    p.emit(this.dWallSpark, Math.round((10 + 26 * f) * th), pos, tmpA, null, groundY, 1);
    this.dWallGlow.size = 0.6 + 0.7 * f;
    p.emit(this.dWallGlow, Math.round((2 + 4 * f) * th), pos, tmpA, null, groundY, 1);

    // Dust off the barrier, pushed back along the surface normal.
    this.dPuff.size = 0.6 + 0.6 * f;
    p.emit(this.dPuff, Math.round((3 + 7 * f) * th), pos, tmpN, null, groundY, 1);
    p.emit(this.dChip, Math.round(5 * th * f), pos, tmpN, null, groundY, 1);

    // A flat flash pinned to the wall reads as the point of contact — once.
    if (!sustained) {
      this.lastWallFlash = now;
      this.lastWallPos.copy(pos);
      this.dCompress.size = (1.4 + 2.2 * f);
      this.dCompress.alpha = 0.95;
      this.dCompress.ramp = RAMP.METAL_SPARK;
      p.spawnPlane(this.dCompress, pos, tmpN, 1, 1);
      this.dCompress.ramp = RAMP.WHITE_SHARP;
      this.dCompress.alpha = 0.95;
    }

    if (isPlayer) this.ctx.shake(0.12 + 0.55 * f * f, 0.16 + 0.16 * f);
  }

  /** Kart-on-kart: a star burst plus a compression ring on the impact axis. */
  kartHit(pos: THREE.Vector3, normal: THREE.Vector3 | null, impact: number, isPlayer: boolean): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    const f = clamp01(impact);
    if (f < 0.05) return;

    tmpN.copy(normal ?? UP);
    if (tmpN.lengthSq() < 1e-6) tmpN.copy(UP);
    tmpN.normalize();
    const groundY = pos.y - 0.7;

    this.dStar.size = 0.4 + 0.35 * f;
    p.emit(this.dStar, Math.round((4 + 8 * f) * th), pos, UP, null, groundY, 1);
    this.dSparkle.size = 0.5 + 0.5 * f;
    p.emit(this.dSparkle, Math.round((3 + 6 * f) * th), pos, UP, null, groundY, 1);

    // Two rings on the impact axis: one tight and instant, one wide and soft.
    this.dCompress.size = 2.0 + 2.6 * f;
    p.spawnPlane(this.dCompress, pos, tmpN, 1, 1);
    this.dShockWide.size = 3.0 + 3.0 * f;
    this.dShockWide.ramp = RAMP.WHITE;
    p.spawnPlane(this.dShockWide, pos, tmpN, 1, 0.55);
    this.dShockWide.ramp = RAMP.ORANGE_SPARK;

    this.dSmokePuff.size = 0.55 + 0.5 * f;
    p.emit(this.dSmokePuff, Math.round(4 * th), pos, tmpN, null, groundY, 1);

    if (isPlayer) this.ctx.shake(0.16 + 0.5 * f, 0.2);
  }

  /** Landing: an expanding dust ring in the surface's own material. */
  land(
    pos: THREE.Vector3, impact: number, family: SurfaceProperties['particle'],
    isPlayer: boolean,
  ): void {
    const f = clamp01(impact);
    if (f < 0.06) return;
    const p = this.ctx.particles;
    const th = this.ctx.throttle;

    tmpA.set(pos.x, pos.y + 0.05, pos.z);
    this.dGroundRing.size = 2.4 + 4.4 * f;
    this.dGroundRing.ramp = family === 'spray' ? RAMP.SPRAY
      : family === 'grass' ? RAMP.SMOKE_LIGHT
        : family === 'snow' ? RAMP.SNOW
          : family === 'sparks' ? RAMP.METAL_SPARK : RAMP.DUST;
    p.spawnPlane(this.dGroundRing, tmpA, UP, 1, 0.7 + 0.6 * f);

    // A low, wide skirt of the real surface material.
    if (family !== 'none') {
      this.surf.puff(family, tmpA, UP, 0.7 + 1.1 * f);
      tmpB.copy(UP).multiplyScalar(0.25).normalize();
      this.surf.puff(family, tmpA, tmpB, 0.5 + 0.9 * f);
    } else {
      this.dPuff.size = 0.5 + 0.7 * f;
      p.emit(this.dPuff, Math.round((4 + 8 * f) * th), tmpA, UP, null, pos.y, 1);
    }
    if (f > 0.35) p.emit(this.dChip, Math.round(6 * th * f), tmpA, UP, null, pos.y, 1);

    if (isPlayer) this.ctx.shake(0.08 + 0.42 * f * f, 0.14 + 0.1 * f);
  }

  /** Generic small hit — the `burst('impact')` workhorse. */
  impact(pos: THREE.Vector3, normal: THREE.Vector3 | null, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    tmpN.copy(normal ?? UP);
    if (tmpN.lengthSq() < 1e-6) tmpN.copy(UP);
    tmpN.normalize();
    const groundY = pos.y - 0.5;

    this.dWallSpark.size = 0.17 * scale;
    this.dWallSpark.speed = 11 * scale;
    p.emit(this.dWallSpark, Math.round(14 * th * scale), pos, tmpN, null, groundY, 1);
    this.dWallGlow.size = 0.75 * scale;
    p.emit(this.dWallGlow, Math.round(3 * th), pos, tmpN, null, groundY, 1);
    this.dCompress.size = 1.8 * scale;
    p.spawnPlane(this.dCompress, pos, tmpN, 1, 1);
    this.dSmokePuff.size = 0.5 * scale;
    p.emit(this.dSmokePuff, Math.round(3 * th), pos, tmpN, null, groundY, scale);
  }

  sparks(pos: THREE.Vector3, normal: THREE.Vector3 | null, scale: number): void {
    tmpN.copy(normal ?? UP);
    if (tmpN.lengthSq() < 1e-6) tmpN.copy(UP);
    tmpN.normalize();
    this.dWallSpark.size = 0.16 * scale;
    this.dWallSpark.speed = 12 * scale;
    this.ctx.particles.emit(this.dWallSpark, Math.round(16 * this.ctx.throttle * scale),
      pos, tmpN, null, pos.y - 0.5, 1);
    this.dWallGlow.size = 0.6 * scale;
    this.ctx.particles.emit(this.dWallGlow, Math.round(3 * this.ctx.throttle),
      pos, tmpN, null, pos.y - 0.5, 1);
  }

  /** A shell popping: glowing shards, a ring, a puff. */
  shellBreak(pos: THREE.Vector3, normal: THREE.Vector3 | null, scale: number, tint: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    const groundY = pos.y - 0.45;

    this.dFlash.size = 2.0 * scale;
    p.emit(this.dFlash, 1, pos, UP, null, groundY, 1);
    this.dShard.size = 0.22 * scale;
    this.dShard.tint.setHex(tint);
    p.emit(this.dShard, Math.round(14 * th * scale), pos, UP, null, groundY, 1);
    this.dShard.tint.setRGB(1, 1, 1);
    this.dSparkle.size = 0.55 * scale;
    p.emit(this.dSparkle, Math.round(6 * th), pos, UP, null, groundY, 1);
    this.dCompress.size = 2.2 * scale;
    p.spawnPlane(this.dCompress, pos, normal && normal.lengthSq() > 1e-6 ? normal : UP, 1, 1);
    this.dSmokePuff.size = 0.6 * scale;
    p.emit(this.dSmokePuff, Math.round(5 * th), pos, UP, null, groundY, scale);
    this.dFlash.size = 6.0;
  }

  /** Banana squashed under a wheel. */
  bananaSplat(pos: THREE.Vector3, normal: THREE.Vector3 | null, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    tmpN.copy(normal ?? UP).normalize();
    const groundY = pos.y - 0.05;

    this.dShard.size = 0.19 * scale;
    this.dShard.ramp = RAMP.GOLD;
    p.emit(this.dShard, Math.round(10 * th * scale), pos, tmpN, null, groundY, 1);
    this.dShard.ramp = RAMP.WHITE_SHARP;
    this.dPuff.size = 0.45 * scale;
    p.emit(this.dPuff, Math.round(5 * th), pos, tmpN, null, groundY, scale);
    // A yellow-brown smear left on the tarmac.
    this.decals.splat(pos, tmpN, 1.5 * scale, 9, 0.5, 0.30, 0.22, 0.05);
  }

  /**
   * The victim's reaction to a banana: puff plus a ring of stars orbiting the
   * head.
   *
   * This used to emit `dStar` as a 2.0 rad cone at 2.2 m/s under gravity 1.5 —
   * a ballistic scatter of seven 0.45 m billboards centred 1.15 m above the
   * kart's origin, which is roughly where the kart itself is. In a chase frame
   * they covered the vehicle. Stars over a stunned racer are meant to ORBIT on
   * a legible ring, which is also what keeps them off the silhouette.
   */
  slip(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    this.dPuff.size = 0.7 * scale;
    p.emit(this.dPuff, Math.round(8 * th), pos, UP, null, pos.y - 0.5, scale);
    // Clear of the roofline, not level with it.
    tmpA.copy(pos).y += 1.42 * scale;
    this.dStunRing.size = 0.26 * scale;
    p.spawnOrbit(
      this.dStunRing, tmpA, Math.max(3, Math.round(5 * th)),
      0.62 * scale, 7.2, 0.32, 1, 1,
    );
  }

  spinout(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    const groundY = pos.y - 0.55;
    this.dSmokePuff.size = 0.8 * scale;
    p.emit(this.dSmokePuff, Math.round(10 * th), pos, UP, null, groundY, scale);
    this.dGroundRing.ramp = RAMP.SMOKE_LIGHT;
    this.dGroundRing.size = 3.2 * scale;
    tmpA.set(pos.x, groundY + 0.05, pos.z);
    p.spawnPlane(this.dGroundRing, tmpA, UP, 1, 1);
    this.dGroundRing.ramp = RAMP.DUST;
    this.slip(pos, scale);
  }

  squash(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    tmpA.set(pos.x, pos.y - 0.5, pos.z);
    this.dGroundRing.size = 4.0 * scale;
    p.spawnPlane(this.dGroundRing, tmpA, UP, 1, 1);
    this.dPuff.size = 0.7 * scale;
    p.emit(this.dPuff, Math.round(12 * th), tmpA, UP, null, tmpA.y - 0.05, scale);
    this.dChip.speed = 4;
    p.emit(this.dChip, Math.round(8 * th), tmpA, UP, null, tmpA.y, 1);
    this.dChip.speed = 6.5;
  }

  respawn(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    this.dGhost.size = 1.1 * scale;
    p.emit(this.dGhost, Math.round(8 * th), pos, UP, null, pos.y - 0.6, scale);
    this.dSparkle.size = 0.6 * scale;
    p.emit(this.dSparkle, Math.round(10 * th), pos, UP, null, pos.y - 0.6, 1);
    this.dCompress.size = 2.6 * scale;
    this.dCompress.ramp = RAMP.CHARGE_WISP;
    p.spawnPlane(this.dCompress, pos, UP, 1, 1.6);
    this.dCompress.ramp = RAMP.WHITE_SHARP;
  }

  // =========================================================================
  // Items
  // =========================================================================

  /** Item box shatter: glowing panels, a sparkle cloud, a bright ring. */
  itemBox(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    const groundY = pos.y - 1.0;

    this.dFlash.size = 2.6 * scale;
    p.emit(this.dFlash, 1, pos, UP, null, groundY, 1);
    this.dShard.size = 0.30 * scale;
    this.dShard.ramp = RAMP.RAINBOW;
    this.dShard.speed = 7.5;
    p.emit(this.dShard, Math.round(16 * th), pos, UP, null, groundY, scale);
    this.dShard.ramp = RAMP.WHITE_SHARP;
    this.dShard.speed = 9;

    this.dSparkle.size = 0.55 * scale;
    p.emit(this.dSparkle, Math.round(12 * th), pos, UP, null, groundY, 1);
    this.dGoldStar.size = 0.34 * scale;
    p.emit(this.dGoldStar, Math.round(6 * th), pos, UP, null, groundY, 1);

    this.dCompress.size = 2.8 * scale;
    p.spawnPlane(this.dCompress, pos, UP, 1, 1.3);
    this.dFlash.size = 6.0;

    // A second sparkle wave as the shards fly out.
    this.schedule(Kind.Sparkle, 0.09, pos, UP, scale);
    this.schedule(Kind.Sparkle, 0.19, pos, UP, scale * 0.7);
  }

  coin(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    this.dGoldStar.size = 0.32 * scale;
    p.emit(this.dGoldStar, Math.round(7 * th), pos, UP, null, pos.y - 1.2, 1);
    this.dSparkle.size = 0.42 * scale;
    p.emit(this.dSparkle, Math.round(5 * th), pos, UP, null, pos.y - 1.2, 1);
  }

  /** Star power engaging: rainbow shell + ring + stars. */
  starPop(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    const groundY = pos.y - 0.7;
    this.dFlash.size = 3.6 * scale;
    p.emit(this.dFlash, 2, pos, UP, null, groundY, 1);
    this.dFlash.size = 6.0;
    this.dRainbow.size = 1.0 * scale;
    p.emit(this.dRainbow, Math.round(18 * th), pos, UP, null, groundY, 1);
    this.dGoldStar.size = 0.5 * scale;
    p.emit(this.dGoldStar, Math.round(10 * th), pos, UP, null, groundY, 1);
    this.dShockTight.ramp = RAMP.RAINBOW;
    this.dShockTight.size = 4.5 * scale;
    tmpA.set(pos.x, groundY + 0.06, pos.z);
    p.spawnPlane(this.dShockTight, tmpA, UP, 1, 1.2);
    this.dShockTight.ramp = RAMP.WHITE_SHARP;
    this.overlay.impactFrame(0.35 * scale);
  }

  starHit(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    this.dRainbow.size = 0.8 * scale;
    p.emit(this.dRainbow, Math.round(12 * th), pos, UP, null, pos.y - 0.6, 1);
    this.dGoldStar.size = 0.45 * scale;
    p.emit(this.dGoldStar, Math.round(8 * th), pos, UP, null, pos.y - 0.6, 1);
    this.dCompress.ramp = RAMP.RAINBOW;
    this.dCompress.size = 2.4 * scale;
    p.spawnPlane(this.dCompress, pos, UP, 1, 1);
    this.dCompress.ramp = RAMP.WHITE_SHARP;
  }

  /** Bullet Bill launch: a forward cone of streaks and a hard white frame. */
  bulletLaunch(pos: THREE.Vector3, forward: THREE.Vector3 | null, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    tmpN.copy(forward ?? UP);
    if (tmpN.lengthSq() < 1e-6) tmpN.set(0, 0, -1);
    tmpN.normalize();
    tmpB.copy(tmpN).multiplyScalar(-1);

    this.dFlash.size = 4.5 * scale;
    p.emit(this.dFlash, 2, pos, UP, null, pos.y - 0.7, 1);
    this.dFlash.size = 6.0;
    this.dStreak.size = 0.32 * scale;
    p.emit(this.dStreak, Math.round(26 * th), pos, tmpB, null, pos.y - 0.7, 1);
    this.dCompress.size = 3.6 * scale;
    p.spawnPlane(this.dCompress, pos, tmpN, 1, 1.4);
    this.dSmokePuff.size = 0.9 * scale;
    p.emit(this.dSmokePuff, Math.round(8 * th), pos, tmpB, null, pos.y - 0.7, scale);
    this.overlay.impactFrame(0.6);
  }

  /**
   * Lightning: a jagged bolt out of the sky into the kart, a ground flash, then
   * arcs crawling over the chassis for the next half second.
   */
  lightning(pos: THREE.Vector3, scale: number, kartId: number): void {
    this.boltPath(pos, scale);
    const p = this.ctx.particles;
    const th = this.ctx.throttle;

    this.dFlash.size = 4.0 * scale;
    p.emit(this.dFlash, 2, pos, UP, null, pos.y - 0.6, 1);
    this.dFlash.size = 6.0;
    this.dShockTight.ramp = RAMP.ELECTRIC;
    this.dShockTight.size = 5.0 * scale;
    tmpA.set(pos.x, pos.y - 0.55, pos.z);
    p.spawnPlane(this.dShockTight, tmpA, UP, 1, 1);
    this.dShockTight.ramp = RAMP.WHITE_SHARP;
    this.dSparkle.size = 0.6 * scale;
    p.emit(this.dSparkle, Math.round(10 * th), pos, UP, null, pos.y - 0.6, 1);

    // Arcs crawl over the body afterwards, following the kart if we know it.
    for (let i = 1; i <= 7; i++) {
      this.schedule(Kind.Arc, 0.05 + i * 0.075, pos, UP, scale, kartId);
    }
    // A second, weaker strike — real lightning flickers.
    this.schedule(Kind.Bolt, 0.11, pos, UP, scale * 0.6);
  }

  /** A single jagged bolt from ~34 m up down to `pos`. */
  private boltPath(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const segs = this.ctx.quality.tier === 'low' ? 6 : 10;
    const top = 30 * Math.max(0.6, scale);
    const jitter = 1.5 * scale;

    let px = pos.x + (Math.random() * 2 - 1) * jitter * 1.5;
    let py = pos.y + top;
    let pz = pos.z + (Math.random() * 2 - 1) * jitter * 1.5;

    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      // Converge on the target: jitter shrinks to nothing at the ground.
      const j = jitter * (1 - t) * (1 - t);
      const nx = pos.x + (Math.random() * 2 - 1) * j;
      const ny = pos.y + top * (1 - t);
      const nz = pos.z + (Math.random() * 2 - 1) * j;

      const mx = (px + nx) * 0.5, my = (py + ny) * 0.5, mz = (pz + nz) * 0.5;
      const dx = nx - px, dy = ny - py, dz = nz - pz;
      const len = Math.hypot(dx, dy, dz) || 1;

      tmpA.set(mx, my, mz);
      // Velocity is only used for the stretch axis; keep the magnitude tiny so
      // the segment barely moves during its 0.13 s life.
      tmpB.set(dx / len, dy / len, dz / len).multiplyScalar(3.2);
      this.dBolt.size = (len / 3.4) * (0.5 + 0.5 * scale);
      p.spawn(this.dBolt, tmpA, tmpB, tmpA.y - 100, 1, 1);

      px = nx; py = ny; pz = nz;
    }
  }

  /** Squid ink: a splat on the deck, a spray of drops, and the lens splat. */
  ink(pos: THREE.Vector3, scale: number, isPlayer: boolean): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    tmpA.set(pos.x, pos.y - 0.5, pos.z);
    this.dInkSplat.size = 2.4 * scale;
    p.spawnPlane(this.dInkSplat, tmpA, UP, 1, 1);
    this.dInkDrop.size = 0.26 * scale;
    p.emit(this.dInkDrop, Math.round(16 * th), pos, UP, null, tmpA.y, 1);
    this.decals.splat(tmpA, UP, 3.0 * scale, 12, 0.75, 0.02, 0.015, 0.04);
    if (isPlayer) this.overlay.ink(3.2);
  }

  /** Countdown light: a hard flare plus a ring, amber then green on GO. */
  countdownFlare(pos: THREE.Vector3, count: number): void {
    const p = this.ctx.particles;
    const go = count <= 0;
    const ramp = go ? RAMP.GRASS : RAMP.ORANGE_SPARK;

    this.dFlash.ramp = ramp;
    this.dFlash.size = go ? 5.5 : 3.0;
    this.dFlash.intensity = go ? 3.8 : 2.4;
    p.emit(this.dFlash, 2, pos, UP, null, pos.y - 2, 1);
    this.dFlash.ramp = RAMP.WHITE_SHARP;
    this.dFlash.size = 6.0;
    this.dFlash.intensity = 3.4;

    this.dCompress.ramp = ramp;
    this.dCompress.size = go ? 6.0 : 3.4;
    p.spawnPlane(this.dCompress, pos, UP, 1, go ? 1.8 : 1.1);
    this.dCompress.ramp = RAMP.WHITE_SHARP;

    if (go) {
      this.dSparkle.size = 0.8;
      p.emit(this.dSparkle, Math.round(14 * this.ctx.throttle), pos, UP, null, pos.y - 2, 1);
      this.overlay.impactFrame(0.4);
    }
  }

  /** Lap / finish confetti — three waves so it keeps falling. */
  confetti(pos: THREE.Vector3, scale: number): void {
    this.confettiWave(pos, scale);
    this.schedule(Kind.Confetti, 0.18, pos, UP, scale * 0.85);
    this.schedule(Kind.Confetti, 0.42, pos, UP, scale * 0.7);
  }

  private confettiWave(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const n = Math.round(26 * this.ctx.throttle * scale);
    tmpA.copy(pos).y += 2.6;
    this.dConfetti.size = 0.28 * scale;
    p.emit(this.dConfetti, n, tmpA, UP, null, pos.y - 0.5, 1);
    this.dSparkle.size = 0.5 * scale;
    p.emit(this.dSparkle, Math.round(6 * this.ctx.throttle), tmpA, UP, null, pos.y - 0.5, 1);
  }

  /** Air trick: a sparkle arc off the kart. */
  trick(pos: THREE.Vector3, scale: number): void {
    const p = this.ctx.particles;
    const th = this.ctx.throttle;
    this.dSparkle.size = 0.55 * scale;
    p.emit(this.dSparkle, Math.round(10 * th), pos, UP, null, pos.y - 2, 1);
    this.dRainbow.size = 0.55 * scale;
    p.emit(this.dRainbow, Math.round(6 * th), pos, UP, null, pos.y - 2, 1);
  }

  dust(pos: THREE.Vector3, normal: THREE.Vector3 | null, scale: number): void {
    tmpN.copy(normal ?? UP);
    if (tmpN.lengthSq() < 1e-6) tmpN.copy(UP);
    tmpN.normalize();
    this.dPuff.size = 0.7 * scale;
    this.ctx.particles.emit(this.dPuff, Math.round(9 * this.ctx.throttle),
      pos, tmpN, null, pos.y - 0.08, scale);
  }

  smoke(pos: THREE.Vector3, scale: number): void {
    this.dSmokePuff.size = 0.8 * scale;
    this.ctx.particles.emit(this.dSmokePuff, Math.round(7 * this.ctx.throttle),
      pos, UP, null, pos.y - 0.5, scale);
  }

  /** Per-item reaction at the victim. */
  itemHit(item: ItemType, pos: THREE.Vector3, isPlayer: boolean, kartId: number): void {
    switch (item) {
      case ItemType.Banana:
      case ItemType.TripleBanana:
        this.bananaSplat(pos, UP, 1);
        this.slip(pos, 1);
        if (isPlayer) this.ctx.shake(0.2, 0.22);
        break;
      case ItemType.GreenShell:
      case ItemType.TripleGreenShell:
        this.shellBreak(pos, UP, 0.9, 0x8cff6a);
        this.spinout(pos, 0.9);
        if (isPlayer) this.ctx.shake(0.3, 0.26);
        break;
      case ItemType.RedShell:
      case ItemType.TripleRedShell:
        this.shellBreak(pos, UP, 1.0, 0xff5a44);
        this.spinout(pos, 1.0);
        if (isPlayer) this.ctx.shake(0.34, 0.28);
        break;
      case ItemType.Bomb:
        this.explosion(pos, UP, 1.0);
        break;
      case ItemType.BlueShell:
        this.explosion(pos, UP, 1.6);
        if (isPlayer) this.ctx.flash(0x9fd8ff, 0.5, 0.3);
        break;
      case ItemType.Lightning:
        this.lightning(pos, 1.0, kartId);
        break;
      case ItemType.Squid:
        this.ink(pos, 1.0, isPlayer);
        break;
      case ItemType.Star:
        this.starHit(pos, 1.1);
        break;
      case ItemType.Bullet:
        this.impact(pos, UP, 1.3);
        this.spinout(pos, 1.0);
        break;
      case ItemType.Coin:
        this.coin(pos, 0.9);
        break;
      default:
        this.impact(pos, UP, 1.0);
        this.spinout(pos, 0.8);
        break;
    }
  }

  clear(): void {
    for (let i = 0; i < SCHEDULE_CAP; i++) this.queue[i].active = false;
  }

  dispose(): void { this.clear(); }
}
