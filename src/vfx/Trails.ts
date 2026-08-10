/**
 * ============================================================================
 *  TRAILS — camera-facing ribbon strips
 * ============================================================================
 *  A rolling ring buffer of samples per ribbon, expanded into a tapering strip
 *  in the vertex shader (`right = cross(segmentDir, toCamera)`), so the ribbon
 *  always faces the camera without any CPU cross products and never flips.
 *
 *  Every ribbon in the game lives in ONE geometry and ONE draw call; inactive
 *  slots collapse to zero width and cost nothing but a few vertex invocations.
 *
 *  Kart ribbons (boost, star rainbow, anti-gravity) are driven automatically
 *  from KartState. Items get an explicit handle API so a shell or bullet can
 *  own a ribbon for its lifetime.
 * ============================================================================
 */

import * as THREE from 'three';
import { LAYERS, RENDER_ORDER } from '@/core/Config';
import { CURVE, RAMP, SPRITE } from './sprites/Atlas';
import {
  makeDesc, PFLAG, socketPos,
  type EmitterDesc, type KartSource, type VfxContext,
} from './ParticleSystem';

export type TrailKind = 'boost' | 'star' | 'antigravity' | 'shell' | 'bullet' | 'ghost';

interface KindDef {
  ramp: number;
  width: number;
  life: number;
  intensity: number;
  alpha: number;
  /** Sideways wobble amplitude, metres. */
  wobble: number;
}

/**
 * `intensity` multiplies a ramp that already carries HDR values of 2–7, and the
 * ribbons are fully ADDITIVE, so the product lands straight on top of an
 * already-bright scene in the HDR buffer before AgX.
 *
 * Retuned against the current post chain (bloom luminanceSmoothing 0.1 —
 * i.e. almost no soft knee, so anything over ~1.0 blooms immediately — radius
 * 0.62, intensity 0.72, plus a punchy saturating grade). The old values were
 * authored against a much more forgiving bloom (smoothing 0.3) and now read as
 * white mush: a ribbon whose peak is 2.8+ linear loses its entire hue gradient
 * to the bloom and the grade's saturation lift has nothing left to work with.
 *
 * Rule of thumb here: peak linear (ramp head × intensity) should land around
 * 1.6–2.2 for a coloured ribbon. That still blooms clearly but keeps the hue.
 */
const KINDS: Record<TrailKind, KindDef> = {
  // ramp head 3.0 × 0.62 ≈ 1.9
  boost: { ramp: RAMP.TRAIL_BOOST, width: 0.20, life: 0.42, intensity: 0.62, alpha: 0.85, wobble: 0.03 },
  // RAINBOW is a flat 3.0 across every hue; 0.62 keeps all six readable.
  star: { ramp: RAMP.RAINBOW, width: 0.34, life: 0.65, intensity: 0.62, alpha: 0.95, wobble: 0.10 },
  // ELECTRIC head is 7.0 — by far the hottest ramp. 0.8 was 5.6 linear, pure white.
  antigravity: { ramp: RAMP.ELECTRIC, width: 0.22, life: 0.55, intensity: 0.30, alpha: 0.8, wobble: 0.05 },
  // GRASS head is only 1.2, so this one was never blown.
  shell: { ramp: RAMP.GRASS, width: 0.14, life: 0.30, intensity: 0.8, alpha: 0.6, wobble: 0.02 },
  // Bullet Bill is *meant* to be a white streak, but 2.6 × 1.2 = 3.1 was a
  // solid bloom slab with no visible ribbon shape inside it.
  bullet: { ramp: RAMP.WHITE_SHARP, width: 0.45, life: 0.42, intensity: 0.72, alpha: 1.0, wobble: 0.06 },
  ghost: { ramp: RAMP.GHOST, width: 0.5, life: 0.7, intensity: 0.9, alpha: 0.5, wobble: 0.08 },
};

const SEGMENTS = 26;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const F_LOCAL = new THREE.Vector3(0, 0, -1);
const U_LOCAL = new THREE.Vector3(0, 1, 0);

const TRAIL_VERT = /* glsl */ `
precision highp float;
attribute vec3 aPos;
attribute vec3 aDir;
attribute vec4 aParam;   // side(-1/+1), width, age01, alpha
attribute vec2 aMeta;    // rampRow, intensity

varying vec2 vUv;
varying float vEdge;
varying float vAlpha;
varying float vRow;
varying float vIntensity;

void main() {
  vEdge = aParam.x;
  vUv = vec2(aParam.z, 0.0);
  vAlpha = aParam.w;
  vRow = aMeta.x;
  vIntensity = aMeta.y;

  vec3 toCam = normalize(cameraPosition - aPos);
  vec3 right = cross(aDir, toCam);
  float l = length(right);
  right = l > 1e-4 ? right / l : vec3(1.0, 0.0, 0.0);

  vec3 wp = aPos + right * (aParam.x * aParam.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const TRAIL_FRAG = /* glsl */ `
precision highp float;
#include <common>
uniform sampler2D uRamp;
uniform float uRampV;
varying vec2 vUv;
varying float vEdge;
varying float vAlpha;
varying float vRow;
varying float vIntensity;

void main() {
  float edge = 1.0 - abs(vEdge);
  // Soft core with a bright centre line — reads as energy, not as a flat band.
  float a = pow(edge, 1.6) * (0.55 + 0.45 * pow(edge, 6.0));
  a *= vAlpha;
  if (a <= 0.004) discard;
  vec4 c = texture2D(uRamp, vec2(clamp(vUv.x, 0.0, 1.0), (vRow + 0.5) * uRampV));
  a *= c.a;
  if (a <= 0.004) discard;
  vec3 rgb = c.rgb * vIntensity;
  gl_FragColor = vec4(rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, 0.0);
}
`;

interface Ribbon {
  active: boolean;
  kind: TrailKind;
  count: number;
  sx: Float32Array; sy: Float32Array; sz: Float32Array;
  birth: Float32Array;
  lastPush: number;
  fade: number;
  /** Set false to fade out and free. */
  held: boolean;
  widthMul: number;
  alphaMul: number;
}

export class Trails {
  private ctx: VfxContext;
  private src: KartSource;

  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private aPos: THREE.BufferAttribute;
  private aDir: THREE.BufferAttribute;
  private aParam: THREE.BufferAttribute;
  private aMeta: THREE.BufferAttribute;

  private ribbons: Ribbon[] = [];
  private maxRibbons: number;
  /** kartId → ribbon slot, per stream. */
  private kartSlots = new Map<number, [number, number, number]>();

  private dSparkle: EmitterDesc;
  private dStarBit: EmitterDesc;

  constructor(ctx: VfxContext, src: KartSource, ramp: THREE.Texture, rampRows: number) {
    this.ctx = ctx;
    this.src = src;
    this.maxRibbons = ctx.quality.tier === 'low' ? 12 : ctx.quality.tier === 'medium' ? 24 : 40;

    const verts = this.maxRibbons * SEGMENTS * 2;
    this.geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.aDir = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.aParam = new THREE.BufferAttribute(new Float32Array(verts * 4), 4);
    this.aMeta = new THREE.BufferAttribute(new Float32Array(verts * 2), 2);
    for (const a of [this.aPos, this.aDir, this.aParam, this.aMeta]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aDir', this.aDir);
    this.geo.setAttribute('aParam', this.aParam);
    this.geo.setAttribute('aMeta', this.aMeta);

    const idx: number[] = [];
    for (let r = 0; r < this.maxRibbons; r++) {
      const base = r * SEGMENTS * 2;
      for (let i = 0; i < SEGMENTS - 1; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
    this.geo.setIndex(idx);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      uniforms: {
        uRamp: { value: ramp },
        uRampV: { value: 1 / rampRows },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'vfx-trails';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = RENDER_ORDER.PARTICLE_ADDITIVE - 3;
    this.mesh.castShadow = false;
    this.mesh.layers.enable(LAYERS.BLOOM);
    ctx.root.add(this.mesh);

    for (let r = 0; r < this.maxRibbons; r++) {
      this.ribbons.push({
        active: false, kind: 'boost', count: 0,
        sx: new Float32Array(SEGMENTS), sy: new Float32Array(SEGMENTS), sz: new Float32Array(SEGMENTS),
        birth: new Float32Array(SEGMENTS),
        lastPush: -1, fade: 1, held: false, widthMul: 1, alphaMul: 1,
      });
    }

    this.dSparkle = makeDesc({
      sprite: SPRITE.FLARE, ramp: RAMP.RAINBOW, curve: CURVE.SPIKE,
      flags: PFLAG.HARD,
      size: 0.55, sizeVar: 0.5, life: 0.5, lifeVar: 0.4,
      speed: 2.2, speedVar: 0.8, cone: 3.14,
      inherit: 0.25, jitter: 0.4, gravity: 1.2, drag: 1.6,
      soft: 0, additive: 1, alpha: 1, intensity: 1.4,
    });
    this.dStarBit = makeDesc({
      sprite: SPRITE.STAR, ramp: RAMP.STAR_YELLOW, curve: CURVE.BELL,
      size: 0.42, sizeVar: 0.5, life: 0.85, lifeVar: 0.4,
      speed: 3.0, speedVar: 0.7, cone: 2.2,
      inherit: 0.2, jitter: 0.35, gravity: 3.5, drag: 1.2,
      spin: 7, soft: 0.3, additive: 1, alpha: 1, intensity: 1.2,
    });
  }

  // -------------------------------------------------------------------------
  // Public handle API (items, or anything else that owns a moving emitter)
  // -------------------------------------------------------------------------

  acquire(kind: TrailKind): number {
    for (let r = 0; r < this.ribbons.length; r++) {
      const rb = this.ribbons[r];
      if (!rb.active) {
        rb.active = true; rb.held = true; rb.kind = kind; rb.count = 0;
        rb.fade = 1; rb.lastPush = -1; rb.widthMul = 1; rb.alphaMul = 1;
        return r;
      }
    }
    return -1;
  }

  push(handle: number, pos: THREE.Vector3, widthMul = 1, alphaMul = 1): void {
    if (handle < 0 || handle >= this.ribbons.length) return;
    const rb = this.ribbons[handle];
    if (!rb.active) return;
    rb.widthMul = widthMul;
    rb.alphaMul = alphaMul;
    this.pushSample(rb, pos);
  }

  release(handle: number): void {
    if (handle < 0 || handle >= this.ribbons.length) return;
    this.ribbons[handle].held = false;
  }

  // -------------------------------------------------------------------------

  private pushSample(rb: Ribbon, pos: THREE.Vector3): void {
    const t = this.ctx.time;
    const n = rb.count;
    if (n > 0) {
      const dx = pos.x - rb.sx[n - 1];
      const dy = pos.y - rb.sy[n - 1];
      const dz = pos.z - rb.sz[n - 1];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 64) { rb.count = 0; }                      // teleport: restart
      else if (d2 < 0.055 && t - rb.lastPush < 0.05) {
        // Not enough movement: just slide the head so the tip stays glued on.
        rb.sx[n - 1] = pos.x; rb.sy[n - 1] = pos.y; rb.sz[n - 1] = pos.z;
        return;
      }
    }
    if (rb.count >= SEGMENTS) {
      rb.sx.copyWithin(0, 1); rb.sy.copyWithin(0, 1);
      rb.sz.copyWithin(0, 1); rb.birth.copyWithin(0, 1);
      rb.count = SEGMENTS - 1;
    }
    const i = rb.count++;
    rb.sx[i] = pos.x; rb.sy[i] = pos.y; rb.sz[i] = pos.z;
    rb.birth[i] = t;
    rb.lastPush = t;
  }

  private kartSlot(id: number): [number, number, number] {
    let s = this.kartSlots.get(id);
    if (!s) { s = [-1, -1, -1]; this.kartSlots.set(id, s); }
    return s;
  }

  update(): void {
    const { ctx } = this;
    const karts = this.src.karts;

    // --- automatic kart ribbons --------------------------------------------
    if (karts) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const slots = this.kartSlot(k.id);
        const dist = ctx.camera.position.distanceTo(k.position);
        const near = dist < 120;

        tmpFwd.copy(F_LOCAL).applyQuaternion(k.quaternion);
        tmpUp.copy(U_LOCAL).applyQuaternion(k.quaternion);

        // 0/1: twin boost ribbons off the exhausts.
        const boosting = k.boostTime > 0 && near;
        for (let side = 0; side < 2; side++) {
          if (boosting) {
            if (slots[side] < 0) slots[side] = this.acquire(k.starTime > 0 ? 'star' : 'boost');
            if (slots[side] >= 0) {
              const rb = this.ribbons[slots[side]];
              rb.kind = k.starTime > 0 ? 'star' : 'boost';
              socketPos(this.src, k, side === 0 ? 'exhaustL' : 'exhaustR',
                side === 0 ? -0.42 : 0.42, -0.02, 0.9, tmpA);
              this.push(slots[side], tmpA, 1, Math.min(1, k.boostTime * 4));
            }
          } else if (slots[side] >= 0) {
            this.release(slots[side]);
            slots[side] = -1;
          }
        }

        // 2: anti-gravity energy trail from the chassis centre.
        const ag = k.antiGravity && near && Math.abs(k.speed) > 3;
        if (ag) {
          if (slots[2] < 0) slots[2] = this.acquire('antigravity');
          if (slots[2] >= 0) {
            tmpA.copy(k.position).addScaledVector(tmpUp, -0.28);
            this.ribbons[slots[2]].kind = 'antigravity';
            this.push(slots[2], tmpA, 1, 1);
          }
        } else if (slots[2] >= 0) {
          this.release(slots[2]);
          slots[2] = -1;
        }

        // Star power: rainbow sparkles + trailing stars.
        if (k.starTime > 0 && near) {
          if (Math.random() < 26 * ctx.dt * ctx.throttle) {
            tmpA.copy(k.position).addScaledVector(tmpFwd, -0.6 - Math.random() * 0.6);
            ctx.particles.emit(this.dSparkle, 1, tmpA, tmpUp, k.velocity, tmpA.y - 1.5, 1);
          }
          if (Math.random() < 12 * ctx.dt * ctx.throttle) {
            tmpA.copy(k.position).addScaledVector(tmpFwd, -0.9);
            ctx.particles.emit(this.dStarBit, 1, tmpA, tmpUp, k.velocity, tmpA.y - 1.5, 1);
          }
        }
      }
    }

    this.writeGeometry();
  }

  private writeGeometry(): void {
    const t = this.ctx.time;
    const pos = this.aPos.array as Float32Array;
    const dir = this.aDir.array as Float32Array;
    const par = this.aParam.array as Float32Array;
    const met = this.aMeta.array as Float32Array;
    let touched = 0;

    for (let r = 0; r < this.ribbons.length; r++) {
      const rb = this.ribbons[r];
      const base = r * SEGMENTS * 2;
      if (!rb.active) continue;

      const def = KINDS[rb.kind];
      if (!rb.held) {
        rb.fade -= this.ctx.dt / 0.28;
        if (rb.fade <= 0) {
          rb.active = false;
          rb.count = 0;
          // Collapse the slot so no stale geometry lingers.
          for (let v = 0; v < SEGMENTS * 2; v++) par[(base + v) * 4 + 1] = 0;
          touched = Math.max(touched, base + SEGMENTS * 2);
          continue;
        }
      }

      // Drop samples that have aged out.
      let drop = 0;
      while (drop < rb.count && t - rb.birth[drop] > def.life) drop++;
      if (drop > 0) {
        rb.sx.copyWithin(0, drop); rb.sy.copyWithin(0, drop);
        rb.sz.copyWithin(0, drop); rb.birth.copyWithin(0, drop);
        rb.count -= drop;
      }
      if (rb.count < 2) {
        for (let v = 0; v < SEGMENTS * 2; v++) par[(base + v) * 4 + 1] = 0;
        touched = Math.max(touched, base + SEGMENTS * 2);
        if (!rb.held && rb.count === 0) rb.active = false;
        continue;
      }

      const n = rb.count;
      const last = n - 1;
      for (let i = 0; i < SEGMENTS; i++) {
        const v0 = (base + i * 2) * 3;
        const v1 = v0 + 3;
        const p0 = (base + i * 2) * 4;
        const p1 = p0 + 4;
        const m0 = (base + i * 2) * 2;
        const m1 = m0 + 2;

        if (i >= n) {
          par[p0 + 1] = 0; par[p1 + 1] = 0;
          continue;
        }
        const x = rb.sx[i], y = rb.sy[i], z = rb.sz[i];
        // Direction from the neighbouring samples (central where possible).
        const ia = Math.max(0, i - 1);
        const ib = Math.min(last, i + 1);
        let dx = rb.sx[ib] - rb.sx[ia];
        let dy = rb.sy[ib] - rb.sy[ia];
        let dz = rb.sz[ib] - rb.sz[ia];
        const dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl; dy /= dl; dz /= dl;

        const u = i / last;                       // 0 = oldest, 1 = newest
        const age = 1 - u;                        // ramp lookup: 0 at source
        const taper = Math.pow(u, 0.45);
        const wob = def.wobble * Math.sin(u * 14 + t * 9 + r);
        const w = (def.width * rb.widthMul * (0.18 + 0.82 * taper) + wob) * rb.fade;
        const alpha = def.alpha * rb.alphaMul * rb.fade;

        pos[v0] = x; pos[v0 + 1] = y; pos[v0 + 2] = z;
        pos[v1] = x; pos[v1 + 1] = y; pos[v1 + 2] = z;
        dir[v0] = dx; dir[v0 + 1] = dy; dir[v0 + 2] = dz;
        dir[v1] = dx; dir[v1 + 1] = dy; dir[v1 + 2] = dz;
        par[p0] = -1; par[p0 + 1] = w; par[p0 + 2] = age; par[p0 + 3] = alpha;
        par[p1] = 1; par[p1 + 1] = w; par[p1 + 2] = age; par[p1 + 3] = alpha;
        met[m0] = def.ramp; met[m0 + 1] = def.intensity;
        met[m1] = def.ramp; met[m1 + 1] = def.intensity;
      }
      touched = Math.max(touched, base + SEGMENTS * 2);
    }

    if (touched > 0) {
      this.aPos.clearUpdateRanges(); this.aPos.addUpdateRange(0, touched * 3); this.aPos.needsUpdate = true;
      this.aDir.clearUpdateRanges(); this.aDir.addUpdateRange(0, touched * 3); this.aDir.needsUpdate = true;
      this.aParam.clearUpdateRanges(); this.aParam.addUpdateRange(0, touched * 4); this.aParam.needsUpdate = true;
      this.aMeta.clearUpdateRanges(); this.aMeta.addUpdateRange(0, touched * 2); this.aMeta.needsUpdate = true;
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const r of this.ribbons) if (r.active) n++;
    return n;
  }

  clear(): void {
    for (const rb of this.ribbons) { rb.active = false; rb.held = false; rb.count = 0; }
    for (const s of this.kartSlots.values()) { s[0] = -1; s[1] = -1; s[2] = -1; }
    const par = this.aParam.array as Float32Array;
    for (let i = 1; i < par.length; i += 4) par[i] = 0;
    this.aParam.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.kartSlots.clear();
  }
}
