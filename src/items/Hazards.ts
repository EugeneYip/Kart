/**
 * ============================================================================
 *  APEX KART — TRACK HAZARDS
 * ============================================================================
 *  Everything on the track that hurts you but isn't an item: oil slicks,
 *  rolling boulders, lava fireballs, sliding blocks, snapper plants and
 *  wandering city traffic.
 *
 *  Placement comes from the track's decoration hints when it offers them
 *  (`track.getHazardHints()`); otherwise hazards are laid out procedurally
 *  from the spline with a seeded RNG, so the layout is identical every run.
 *
 *  All contact damage goes through `physics.applyStun` — hazards never touch
 *  kart state directly.
 * ============================================================================
 */

import * as THREE from 'three';
import type { KartState } from '@/core/Types';
import { bus } from '@/core/EventBus';
import { clamp01, lerp, Rng, smoothstep, wrap } from '@/core/MathUtils';
import { canvasTexture, fbm, make2d, normalFromHeight, pixelTexture, ringNoise } from './ItemModels';
import type { KartsLike, PhysicsLike, TrackLike, VfxLike } from './Projectiles';

export type HazardKind = 'oil' | 'boulder' | 'fireball' | 'slider' | 'snapper' | 'traffic';

export interface HazardHint {
  kind: HazardKind;
  /** Arc length along the lap, metres. */
  distance: number;
  /** Offset from the centreline, metres (+ = driver's right). */
  lateral?: number;
  /** Travel range for movers, metres. */
  span?: number;
  speed?: number;
}

interface TrackWithHints extends TrackLike {
  getHazardHints?(): readonly HazardHint[] | undefined;
}

const MAX_HAZARDS = 40;
const KART_RADIUS = 1.05;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _sPos = new THREE.Vector3();
const _sTan = new THREE.Vector3();
const _sBi = new THREE.Vector3();
const _sUp = new THREE.Vector3();

interface Hazard {
  kind: HazardKind;
  node: THREE.Object3D;
  /** Sub-nodes that need animating. */
  partA: THREE.Object3D | null;
  partB: THREE.Object3D | null;
  dist: number;
  lateral: number;
  span: number;
  speed: number;
  phase: number;
  radius: number;
  /** Vertical half-extent for the contact test. */
  height: number;
  pos: THREE.Vector3;
  up: THREE.Vector3;
  t: number;
  cool: number;
  stun: number;
  kick: number;
  stunKind: string;
}

export class Hazards {
  private scene: THREE.Scene;
  private track: TrackWithHints;
  private karts: KartsLike;
  private physics: PhysicsLike;
  private vfx: VfxLike;

  private group = new THREE.Group();
  private list: Hazard[] = [];
  private rng = new Rng(0xA71C3);

  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private texs: THREE.Texture[] = [];
  private enabled = true;

  constructor(
    scene: THREE.Scene,
    track: TrackLike,
    karts: KartsLike,
    physics: PhysicsLike,
    vfx: VfxLike,
  ) {
    this.scene = scene;
    this.track = track as TrackWithHints;
    this.karts = karts;
    this.physics = physics;
    this.vfx = vfx;
  }

  // -------------------------------------------------------------------------

  init(): void {
    this.group.name = 'Hazards';
    this.scene.add(this.group);

    if (typeof this.track.sampleAtDistance !== 'function') {
      // Without a spline we cannot place anything sensibly — stay silent.
      this.enabled = false;
      return;
    }

    const hints = this.gatherHints();
    for (const h of hints) {
      if (this.list.length >= MAX_HAZARDS) break;
      this.build(h);
    }
  }

  private get lapLength(): number {
    const l = this.track.lapLength;
    return typeof l === 'number' && l > 1 ? l : 800;
  }

  private gatherHints(): HazardHint[] {
    const fromTrack = typeof this.track.getHazardHints === 'function'
      ? this.track.getHazardHints()
      : undefined;
    if (fromTrack && fromTrack.length) return fromTrack.slice(0, MAX_HAZARDS);

    // Procedural fallback: walk the lap and drop a themed hazard every so often,
    // keeping the first 60 m of the lap clear so the grid start is fair.
    const out: HazardHint[] = [];
    const lap = this.lapLength;
    const step = Math.max(38, lap / 22);
    const kinds: HazardKind[] = ['oil', 'boulder', 'traffic', 'fireball', 'slider', 'snapper'];
    for (let d = 60; d < lap - 40; d += step) {
      const kind = kinds[this.rng.int(0, kinds.length - 1)];
      const jitter = this.rng.range(-step * 0.28, step * 0.28);
      out.push({
        kind,
        distance: wrap(d + jitter, lap),
        lateral: this.rng.range(-6.5, 6.5),
        span: this.rng.range(9, 17),
        speed: this.rng.range(0.55, 1.5),
      });
    }
    return out;
  }

  /** Sample the spline into module scratch. */
  private sample(d: number): boolean {
    if (typeof this.track.sampleAtDistance !== 'function') return false;
    const s = this.track.sampleAtDistance(wrap(d, this.lapLength));
    if (!s) return false;
    _sPos.copy(s.position);
    _sTan.copy(s.tangent);
    _sBi.copy(s.binormal);
    _sUp.copy(s.normal);
    return true;
  }

  private reg<T extends THREE.BufferGeometry>(g: T): T { this.geoms.push(g); return g; }
  private regM<T extends THREE.Material>(m: T): T { this.mats.push(m); return m; }
  private regT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t; }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private build(h: HazardHint): void {
    if (!this.sample(h.distance)) return;
    let node: THREE.Object3D;
    let partA: THREE.Object3D | null = null;
    let partB: THREE.Object3D | null = null;
    let radius = 1.5;
    let height = 1.6;
    let stun = 1.2;
    let kick = 0.8;
    let stunKind = 'spin';

    switch (h.kind) {
      case 'oil': {
        node = this.makeOil();
        radius = 2.7; height = 0.9; stun = 0.85; kick = 0; stunKind = 'spin';
        break;
      }
      case 'boulder': {
        node = this.makeBoulder();
        radius = 1.7; height = 2.0; stun = 1.55; kick = 1.5; stunKind = 'flip';
        break;
      }
      case 'fireball': {
        const g = this.makeFireball();
        node = g.node; partA = g.glow;
        radius = 1.05; height = 1.4; stun = 1.35; kick = 1.1; stunKind = 'flip';
        break;
      }
      case 'slider': {
        node = this.makeSlider();
        radius = 1.9; height = 1.6; stun = 1.25; kick = 1.2; stunKind = 'spin';
        break;
      }
      case 'snapper': {
        const g = this.makeSnapper();
        node = g.node; partA = g.upper; partB = g.lower;
        radius = 1.5; height = 1.8; stun = 1.45; kick = 1.3; stunKind = 'flip';
        break;
      }
      case 'traffic': {
        node = this.makeTraffic();
        radius = 1.75; height = 1.7; stun = 1.6; kick = 1.6; stunKind = 'flip';
        break;
      }
    }

    this.group.add(node);
    this.list.push({
      kind: h.kind, node, partA, partB,
      dist: h.distance,
      lateral: h.lateral ?? 0,
      span: h.span ?? 12,
      speed: h.speed ?? 1,
      phase: this.rng.next() * Math.PI * 2,
      radius, height,
      pos: new THREE.Vector3().copy(_sPos),
      up: new THREE.Vector3().copy(_sUp),
      t: 0, cool: 0, stun, kick, stunKind,
    });
  }

  private makeOil(): THREE.Object3D {
    const SZ = 512;
    const ctx = make2d(SZ);
    ctx.clearRect(0, 0, SZ, SZ);
    // Irregular slick: several overlapping blobs, iridescent film on top.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = SZ * (0.20 + Math.random() * 0.12);
      const cx = SZ / 2 + Math.cos(a) * SZ * 0.13;
      const cy = SZ / 2 + Math.sin(a) * SZ * 0.13;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(10,10,14,0.95)');
      g.addColorStop(0.7, 'rgba(14,14,20,0.75)');
      g.addColorStop(1, 'rgba(16,16,24,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = SZ * (0.10 + Math.random() * 0.16);
      const cx = SZ / 2 + Math.cos(a) * SZ * 0.15;
      const cy = SZ / 2 + Math.sin(a) * SZ * 0.15;
      const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      g.addColorStop(0, 'rgba(90,40,140,0.28)');
      g.addColorStop(0.45, 'rgba(30,120,140,0.22)');
      g.addColorStop(0.8, 'rgba(150,110,30,0.16)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    const map = this.regT(canvasTexture(ctx));
    map.wrapS = THREE.ClampToEdgeWrapping;

    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      map,
      transparent: true,
      roughness: 0.07,
      metalness: 0.25,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      iridescence: 1.0,
      iridescenceIOR: 1.5,
      iridescenceThicknessRange: [180, 900],
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      side: THREE.DoubleSide,
    }));
    const mesh = new THREE.Mesh(this.reg(new THREE.CircleGeometry(3.1, 40)), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 20;
    return mesh;
  }

  private makeBoulder(): THREE.Object3D {
    const geo = this.reg(new THREE.IcosahedronGeometry(1.55, 3));
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = fbm(v.x * 0.9 + 5, v.y * 0.9 + v.z * 0.4, 4);
      v.multiplyScalar(0.86 + n * 0.30);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const albedo = this.regT(pixelTexture(512, (u, vv, o) => {
      const base = new THREE.Color(0x6b6257);
      const n = fbm(u * 9, vv * 9, 5);
      const grit = ringNoise(u, vv, 26, 3);
      base.lerp(new THREE.Color(0x3a352f), n * 0.75);
      base.lerp(new THREE.Color(0x9c9184), Math.pow(clamp01(grit - 0.45) * 2, 1.6) * 0.5);
      base.offsetHSL(0, 0, (grit - 0.5) * 0.05);
      o.r = Math.round(clamp01(base.r) * 255);
      o.g = Math.round(clamp01(base.g) * 255);
      o.b = Math.round(clamp01(base.b) * 255);
    }));
    const nrm = this.regT(normalFromHeight(256, (u, vv) =>
      fbm(u * 12, vv * 12, 5) * 0.6 + ringNoise(u, vv, 30, 3) * 0.4, 2.6));
    const mat = this.regM(new THREE.MeshStandardMaterial({
      map: albedo, normalMap: nrm, normalScale: new THREE.Vector2(1.4, 1.4),
      roughness: 0.92, metalness: 0.02, envMapIntensity: 0.85,
    }));
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  private makeFireball(): { node: THREE.Object3D; glow: THREE.Object3D } {
    const g = new THREE.Group();
    const core = new THREE.Mesh(
      this.reg(new THREE.IcosahedronGeometry(0.72, 3)),
      this.regM(new THREE.MeshStandardMaterial({
        color: 0xff8a20,
        emissive: new THREE.Color(0xff5a08),
        emissiveIntensity: 4.2,
        roughness: 0.6,
        metalness: 0,
      })),
    );
    g.add(core);
    const glowTex = this.regT((() => {
      const ctx = make2d(128);
      const rg = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      rg.addColorStop(0, 'rgba(255,240,190,1)');
      rg.addColorStop(0.35, 'rgba(255,150,40,0.55)');
      rg.addColorStop(1, 'rgba(200,60,0,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, 128, 128);
      return canvasTexture(ctx);
    })());
    const glow = new THREE.Sprite(this.regM(new THREE.SpriteMaterial({
      map: glowTex, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, opacity: 0.9, color: 0xffffff,
    })));
    glow.scale.setScalar(3.2);
    g.add(glow);
    return { node: g, glow };
  }

  private makeSlider(): THREE.Object3D {
    const albedo = this.regT(pixelTexture(256, (u, v, o) => {
      const plate = (Math.floor(u * 4) + Math.floor(v * 4)) % 2 === 0 ? 1 : 0;
      const c = new THREE.Color(0x9aa4b4).offsetHSL(0, 0, plate * 0.05 - 0.02);
      const n = ringNoise(u, v, 18, 3);
      c.offsetHSL(0, 0, (n - 0.5) * 0.06);
      // Hazard stripes along the leading faces.
      const s = ((u * 6 + v * 6) % 1);
      if (s < 0.5) c.lerp(new THREE.Color(0xf2b21c), 0.55);
      else c.lerp(new THREE.Color(0x22262e), 0.35);
      o.r = Math.round(clamp01(c.r) * 255);
      o.g = Math.round(clamp01(c.g) * 255);
      o.b = Math.round(clamp01(c.b) * 255);
    }));
    const nrm = this.regT(normalFromHeight(256, (u, v) =>
      0.5 + (((Math.floor(u * 4) + Math.floor(v * 4)) % 2 === 0) ? 0.06 : 0)
      + ringNoise(u, v, 22, 3) * 0.06, 2.0));
    const mat = this.regM(new THREE.MeshPhysicalMaterial({
      map: albedo, normalMap: nrm, roughness: 0.38, metalness: 0.72,
      clearcoat: 0.4, envMapIntensity: 1.1,
    }));
    const geo = this.reg(new THREE.BoxGeometry(3.0, 1.9, 1.9, 2, 2, 2));
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  }

  private makeSnapper(): { node: THREE.Object3D; upper: THREE.Object3D; lower: THREE.Object3D } {
    const g = new THREE.Group();
    // Stem
    const stemMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0x2f8f3a, roughness: 0.6, metalness: 0.0,
    }));
    const stem = new THREE.Mesh(this.reg(new THREE.CylinderGeometry(0.16, 0.26, 1.1, 12)), stemMat);
    stem.position.y = -0.55;
    g.add(stem);

    const headMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xf24a3a, roughness: 0.35, metalness: 0.0,
      clearcoat: 0.9, clearcoatRoughness: 0.15,
      sheen: 0.6, sheenColor: new THREE.Color(0xff9a86),
    }));
    const mouthMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0x5c1418, roughness: 0.55, side: THREE.DoubleSide,
    }));
    const toothMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0xfffaf0, roughness: 0.18, clearcoat: 1.0,
    }));

    const jaw = (sign: number): THREE.Group => {
      const j = new THREE.Group();
      const shell = new THREE.Mesh(
        this.reg(new THREE.SphereGeometry(0.68, 26, 18, 0, Math.PI * 2, 0, Math.PI * 0.5)),
        headMat,
      );
      if (sign < 0) shell.rotation.x = Math.PI;
      j.add(shell);
      const inner = new THREE.Mesh(this.reg(new THREE.CircleGeometry(0.66, 26)), mouthMat);
      inner.rotation.x = -Math.PI / 2 * sign;
      j.add(inner);
      // Teeth around the rim.
      const toothGeo = this.reg(new THREE.ConeGeometry(0.09, 0.24, 8));
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const t = new THREE.Mesh(toothGeo, toothMat);
        t.position.set(Math.cos(a) * 0.58, sign * 0.05, Math.sin(a) * 0.58);
        t.rotation.x = sign > 0 ? Math.PI : 0;
        j.add(t);
      }
      return j;
    };
    const upper = jaw(1);
    const lower = jaw(-1);
    g.add(upper, lower);
    g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
    return { node: g, upper, lower };
  }

  private makeTraffic(): THREE.Object3D {
    const g = new THREE.Group();
    const hue = this.rng.next();
    const paint = new THREE.Color().setHSL(hue, 0.62, 0.48);
    const bodyMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: paint, roughness: 0.24, metalness: 0.35,
      clearcoat: 1.0, clearcoatRoughness: 0.06, envMapIntensity: 1.25,
    }));
    // Chassis: a chamfered box (scaled sphere-ish box keeps the silhouette soft).
    const body = new THREE.Mesh(this.reg(new THREE.BoxGeometry(1.9, 0.78, 4.0, 2, 2, 3)), bodyMat);
    const bp = body.geometry.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < bp.count; i++) {
      v.fromBufferAttribute(bp, i);
      // Round the corners a little and taper the nose.
      const taper = 1 - Math.pow(Math.abs(v.z) / 2.0, 3) * 0.22;
      bp.setXYZ(i, v.x * taper, v.y, v.z);
    }
    bp.needsUpdate = true;
    body.geometry.computeVertexNormals();
    body.position.y = 0.62;
    body.castShadow = true;
    g.add(body);

    const glassMat = this.regM(new THREE.MeshPhysicalMaterial({
      color: 0x203040, roughness: 0.06, metalness: 0.0,
      transmission: 0.55, thickness: 0.3, ior: 1.45,
      clearcoat: 1.0, transparent: true, opacity: 0.85,
    }));
    const cabin = new THREE.Mesh(this.reg(new THREE.BoxGeometry(1.68, 0.62, 1.9, 1, 1, 1)), glassMat);
    cabin.position.set(0, 1.18, -0.15);
    g.add(cabin);

    const tyreMat = this.regM(new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.88 }));
    const hubMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0xc8ced8, roughness: 0.28, metalness: 0.9,
    }));
    const tyreGeo = this.reg(new THREE.CylinderGeometry(0.42, 0.42, 0.32, 18));
    const hubGeo = this.reg(new THREE.CylinderGeometry(0.20, 0.20, 0.34, 12));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const t = new THREE.Mesh(tyreGeo, tyreMat);
        t.rotation.z = Math.PI / 2;
        t.position.set(sx * 0.92, 0.42, sz * 1.32);
        t.castShadow = true;
        g.add(t);
        const hub = new THREE.Mesh(hubGeo, hubMat);
        hub.rotation.z = Math.PI / 2;
        hub.position.set(sx * 1.0, 0.42, sz * 1.32);
        g.add(hub);
      }
    }
    const lampMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0xfff2c8, emissive: new THREE.Color(0xffe9b0), emissiveIntensity: 3.2, roughness: 0.3,
    }));
    const tailMat = this.regM(new THREE.MeshStandardMaterial({
      color: 0xff3020, emissive: new THREE.Color(0xff2010), emissiveIntensity: 2.6, roughness: 0.35,
    }));
    const lampGeo = this.reg(new THREE.SphereGeometry(0.16, 12, 8));
    for (const sx of [-1, 1]) {
      const l = new THREE.Mesh(lampGeo, lampMat);
      l.position.set(sx * 0.62, 0.68, -2.0);
      l.scale.set(1.2, 0.7, 0.5);
      g.add(l);
      const r = new THREE.Mesh(lampGeo, tailMat);
      r.position.set(sx * 0.68, 0.72, 2.0);
      r.scale.set(1.1, 0.55, 0.4);
      g.add(r);
    }
    return g;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (!this.enabled) return;
    const lap = this.lapLength;

    for (let i = 0; i < this.list.length; i++) {
      const h = this.list[i];
      h.t += dt;
      if (h.cool > 0) h.cool -= dt;

      switch (h.kind) {
        case 'oil':
          if (!this.sample(h.dist)) break;
          h.pos.copy(_sPos).addScaledVector(_sBi, h.lateral).addScaledVector(_sUp, 0.03);
          h.up.copy(_sUp);
          break;

        case 'boulder': {
          if (!this.sample(h.dist)) break;
          // Rolls across the road and wraps around, like a Thwomp on rails.
          const tri = Math.sin(h.t * h.speed * 0.55 + h.phase);
          const across = tri * (h.span * 0.5 + 4);
          h.pos.copy(_sPos).addScaledVector(_sBi, across).addScaledVector(_sUp, 1.55);
          h.up.copy(_sUp);
          h.lateral = across;
          break;
        }

        case 'fireball': {
          if (!this.sample(h.dist)) break;
          const k = Math.sin(h.t * h.speed * 1.35 + h.phase);
          const rise = Math.max(0, k) * 6.0;
          h.pos.copy(_sPos).addScaledVector(_sBi, h.lateral)
            .addScaledVector(_sUp, 0.4 + rise);
          h.up.copy(_sUp);
          break;
        }

        case 'slider': {
          if (!this.sample(h.dist)) break;
          const across = Math.sin(h.t * h.speed * 0.8 + h.phase) * h.span * 0.5;
          h.pos.copy(_sPos).addScaledVector(_sBi, across).addScaledVector(_sUp, 0.95);
          h.up.copy(_sUp);
          h.lateral = across;
          break;
        }

        case 'snapper': {
          if (!this.sample(h.dist)) break;
          // Anchored at the roadside; lunges toward the racing line when it bites.
          const cycle = (h.t * h.speed * 0.55 + h.phase / 6.28) % 1;
          const lunge = Math.pow(Math.max(0, Math.sin(cycle * Math.PI * 2)), 3);
          const side = h.lateral >= 0 ? 1 : -1;
          const anchor = side * Math.max(6.0, Math.abs(h.lateral) + 3.0);
          const reach = lerp(anchor, anchor - side * 5.5, lunge);
          h.pos.copy(_sPos).addScaledVector(_sBi, reach).addScaledVector(_sUp, 1.15);
          h.up.copy(_sUp);
          h.lateral = reach;
          // Only dangerous while lunging with the jaws open-then-shut.
          h.radius = 1.2 + lunge * 0.7;
          break;
        }

        case 'traffic': {
          // Drives along the lap in its own lane, slower than the field.
          h.dist = wrap(h.dist + (10 + h.speed * 6) * dt, lap);
          if (!this.sample(h.dist)) break;
          h.pos.copy(_sPos).addScaledVector(_sBi, h.lateral).addScaledVector(_sUp, 0.05);
          h.up.copy(_sUp);
          // Face down the track.
          _a.copy(_sTan).normalize();
          break;
        }
      }

      this.contact(h);
    }
  }

  private contact(h: Hazard): void {
    if (h.cool > 0) return;
    const list = this.karts.karts;
    const r = h.radius + KART_RADIUS;
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) {
      const k: KartState = list[i];
      if (k.finished || k.invulnerable || k.starTime > 0) continue;
      const dx = k.position.x - h.pos.x;
      const dy = k.position.y - h.pos.y;
      const dz = k.position.z - h.pos.z;
      if (Math.abs(dy) > h.height + 1.0) continue;
      if (dx * dx + dz * dz > r2) continue;
      // An oil slick only spins you if you're actually moving.
      if (h.kind === 'oil' && Math.abs(k.speed) < 5) continue;

      this.physics.applyStun?.(k.id, h.stun, h.stunKind);
      if (h.kick > 0) {
        _b.set(dx, 0, dz);
        if (_b.lengthSq() < 1e-4) _b.set(0, 0, 1);
        _b.normalize().multiplyScalar(h.kick * 130);
        _b.y = h.kick * 55;
        this.physics.applyImpulse?.(k.id, _b);
      }
      this.vfx.burst?.(h.kind === 'fireball' ? 'explosion' : 'impact', h.pos, h.up, 1.0);
      if (this.karts.player && this.karts.player.id === k.id) {
        this.vfx.screenShake?.(0.5, 0.25);
        bus.emit('ui:message', { text: 'OUCH!', seconds: 0.9, style: 'hazard' });
      }
      h.cool = 0.9;
      break;
    }
  }

  // -------------------------------------------------------------------------

  update(dt: number, elapsed: number): void {
    if (!this.enabled) return;
    for (let i = 0; i < this.list.length; i++) {
      const h = this.list[i];
      h.node.position.copy(h.pos);
      switch (h.kind) {
        case 'oil':
          _q.setFromUnitVectors(_up, h.up);
          h.node.quaternion.copy(_q);
          h.node.rotateY(h.phase);
          break;
        case 'boulder': {
          // Roll about the axis perpendicular to travel.
          _n.copy(_sBi).cross(h.up).normalize();
          const dir = Math.cos(h.t * h.speed * 0.55 + h.phase);
          h.node.rotateOnWorldAxis(h.up, 0);
          h.node.rotateOnWorldAxis(_n.lengthSq() > 0.1 ? _n : _up, dir * dt * 1.9);
          break;
        }
        case 'fireball': {
          h.node.rotation.y += dt * 3.2;
          h.node.rotation.x += dt * 1.7;
          const pulse = 0.85 + Math.sin(elapsed * 11 + h.phase) * 0.15;
          h.node.scale.setScalar(pulse);
          if (h.partA) h.partA.scale.setScalar(3.0 * pulse + Math.sin(elapsed * 17) * 0.25);
          break;
        }
        case 'slider':
          _q.setFromUnitVectors(_up, h.up);
          h.node.quaternion.copy(_q);
          h.node.rotateY(Math.sin(elapsed * 0.7 + h.phase) * 0.06);
          break;
        case 'snapper': {
          const cycle = (h.t * h.speed * 0.55 + h.phase / 6.28) % 1;
          const open = Math.pow(Math.max(0, Math.sin(cycle * Math.PI * 2)), 3);
          // Snap shut fast, gape open slow — that's what makes it read as a bite.
          const gape = smoothstep(clamp01(open * 1.4)) * 0.62;
          if (h.partA) h.partA.rotation.x = -gape;
          if (h.partB) h.partB.rotation.x = gape * 0.55;
          _q.setFromUnitVectors(_up, h.up);
          h.node.quaternion.copy(_q);
          h.node.rotateY(Math.sin(elapsed * 1.3 + h.phase) * 0.25);
          break;
        }
        case 'traffic': {
          if (this.sample(h.dist)) {
            _a.copy(_sTan).normalize();
            // Karts face -Z, so aim -Z down the tangent.
            _b.copy(_a).multiplyScalar(-1);
            const yaw = Math.atan2(-_b.x, -_b.z);
            h.node.rotation.set(0, yaw, 0);
            // A little body roll through corners.
            h.node.rotateZ(Math.sin(elapsed * 1.1 + h.phase) * 0.02);
          }
          break;
        }
      }
    }
  }

  get count(): number { return this.list.length; }
  countOf(kind: HazardKind): number {
    let n = 0;
    for (const h of this.list) if (h.kind === kind) n++;
    return n;
  }
  /** World position of hazard `i` — used by AI avoidance. */
  positionOf(i: number): THREE.Vector3 | null { return this.list[i]?.pos ?? null; }
  kindOf(i: number): HazardKind | null { return this.list[i]?.kind ?? null; }
  radiusOf(i: number): number { return this.list[i]?.radius ?? 0; }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.group.visible = v;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.clear();
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    this.geoms.length = 0;
    this.mats.length = 0;
    this.texs.length = 0;
    this.list.length = 0;
  }
}
