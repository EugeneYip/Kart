/**
 * ============================================================================
 *  FOXY KART — ITEMS DEV HARNESS
 * ============================================================================
 *  Standalone page for the ITEMS agent. Deliberately depends on NOTHING from
 *  the other agents: the track, karts, physics and vfx are all local stubs
 *  implemented in this file.
 *
 *   - `OvalTrack` is a real ITrackService: a stadium centreline with analytic
 *     projection, walls and a ground plane, so shell bounces and spline homing
 *     are exercised for real.
 *   - Four dummy karts drive round it.
 *   - Number/letter keys fire every item; G swaps to a turntable gallery of
 *     every model under studio lighting; Z runs the behaviour assertions.
 *
 *  Delete this file once the real game scene can host the item system.
 * ============================================================================
 */

import * as THREE from 'three';
import {
  DriftStage, SurfaceType, ItemType,
  type GroundHit, type ITrackService, type KartState, type TrackSample, type WallHit,
  type FrameContext,
} from '@/core/Types';
import { bus } from '@/core/EventBus';
import { FIXED_DT } from '@/core/Config';
import { clamp, clamp01, wrap } from '@/core/MathUtils';
import { ItemSystem } from '@/items/ItemSystem';
import { ITEM_NAMES, MODEL_FOR_ITEM, type ItemModelId } from '@/items/ItemModels';
import type { HazardHint } from '@/items/Hazards';

// ===========================================================================
//  OVAL TRACK SERVICE
// ===========================================================================

const STRAIGHT = 130;
const CAP_R = 62;
const HALF_WIDTH = 11.5;

class OvalTrack implements ITrackService {
  readonly lapCount = 3;
  readonly lapLength: number;

  private readonly sLen = STRAIGHT;
  private readonly arcLen = Math.PI * CAP_R;
  private readonly s1: number;
  private readonly s2: number;
  private readonly s3: number;

  /** Single reused sample — callers must copy what they keep. */
  private smp: TrackSample = {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: HALF_WIDTH,
    t: 0, distance: 0, curvature: 0, bank: 0,
  };
  private ground: GroundHit = {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: 0, surface: SurfaceType.Road,
  };
  private wall: WallHit = {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), depth: 0,
  };
  private tmp = new THREE.Vector3();

  constructor() {
    this.s1 = this.sLen;
    this.s2 = this.s1 + this.arcLen;
    this.s3 = this.s2 + this.sLen;
    this.lapLength = this.s3 + this.arcLen;
  }

  sampleAt(t: number): TrackSample {
    return this.sampleAtDistance(wrap(t, 1) * this.lapLength);
  }

  sampleAtDistance(dIn: number): TrackSample {
    const d = wrap(dIn, this.lapLength);
    const s = this.smp;
    const hx = this.sLen * 0.5;
    if (d < this.s1) {
      // Bottom straight, travelling +X at z = -CAP_R.
      s.position.set(-hx + d, 0, -CAP_R);
      s.tangent.set(1, 0, 0);
      s.curvature = 0;
    } else if (d < this.s2) {
      const th = (d - this.s1) / CAP_R;
      s.position.set(hx + Math.sin(th) * CAP_R, 0, -Math.cos(th) * CAP_R);
      s.tangent.set(Math.cos(th), 0, Math.sin(th));
      s.curvature = 1 / CAP_R;
    } else if (d < this.s3) {
      // Top straight, travelling -X at z = +CAP_R.
      s.position.set(hx - (d - this.s2), 0, CAP_R);
      s.tangent.set(-1, 0, 0);
      s.curvature = 0;
    } else {
      const th = (d - this.s3) / CAP_R;
      s.position.set(-hx - Math.sin(th) * CAP_R, 0, Math.cos(th) * CAP_R);
      s.tangent.set(-Math.cos(th), 0, -Math.sin(th));
      s.curvature = 1 / CAP_R;
    }
    s.normal.set(0, 1, 0);
    // binormal = tangent x normal -> driver's right.
    s.binormal.copy(s.tangent).cross(s.normal).normalize();
    s.halfWidth = HALF_WIDTH;
    s.distance = d;
    s.t = d / this.lapLength;
    s.bank = 0;
    return s;
  }

  /** Analytic nearest point on the stadium centreline. */
  project(position: THREE.Vector3): TrackSample {
    const hx = this.sLen * 0.5;
    const x = position.x, z = position.z;
    let d: number;
    if (x > hx) {
      const th = clamp(Math.atan2(x - hx, -z), 0, Math.PI);
      d = this.s1 + th * CAP_R;
    } else if (x < -hx) {
      const th = clamp(Math.atan2(-(x + hx), z), 0, Math.PI);
      d = this.s3 + th * CAP_R;
    } else if (z < 0) {
      d = clamp(x + hx, 0, this.sLen);
    } else {
      d = this.s2 + clamp(hx - x, 0, this.sLen);
    }
    return this.sampleAtDistance(d);
  }

  raycastGround(origin: THREE.Vector3, up: THREE.Vector3, maxDist: number): GroundHit {
    const g = this.ground;
    const dist = origin.y; // flat plane at y = 0, up is +Y
    g.hit = dist >= -0.5 && dist <= maxDist;
    g.point.set(origin.x, 0, origin.z);
    g.normal.set(0, 1, 0);
    g.distance = dist;
    g.surface = SurfaceType.Road;
    void up;
    return g;
  }

  collideWalls(position: THREE.Vector3, radius: number): WallHit {
    const w = this.wall;
    w.hit = false;
    w.depth = 0;
    if (position.y > 4.5) return w; // flying over the barrier
    const s = this.project(position);
    const lateral = this.tmp.copy(position).sub(s.position).dot(s.binormal);
    const limit = s.halfWidth;
    if (lateral + radius > limit) {
      w.hit = true;
      w.depth = lateral + radius - limit;
      w.normal.copy(s.binormal).negate();
    } else if (lateral - radius < -limit) {
      w.hit = true;
      w.depth = -limit - (lateral - radius);
      w.normal.copy(s.binormal);
    }
    if (w.hit) {
      w.point.copy(s.position).addScaledVector(s.binormal, Math.sign(lateral) * limit);
      w.point.y = position.y;
    }
    return w;
  }

  surfaceAt(position: THREE.Vector3): SurfaceType {
    const s = this.project(position);
    const lat = Math.abs(this.tmp.copy(position).sub(s.position).dot(s.binormal));
    return lat > s.halfWidth ? SurfaceType.Grass : SurfaceType.Road;
  }

  racingLineAt(t: number, lookahead: number): THREE.Vector3 {
    const s = this.sampleAtDistance(t * this.lapLength + lookahead);
    return s.position.clone();
  }

  getStartPosition(index: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const s = this.sampleAtDistance(index * 5);
    const lane = ((index % 2) * 2 - 1) * 3.2;
    return {
      position: s.position.clone().addScaledVector(s.binormal, lane).setY(0.4),
      quaternion: quatFromTangent(s.tangent),
    };
  }

  getRespawn(t: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const s = this.sampleAt(t);
    return { position: s.position.clone().setY(0.4), quaternion: quatFromTangent(s.tangent) };
  }

  isOutOfBounds(position: THREE.Vector3): boolean {
    return position.y < -20;
  }

  // --- extras the item system feature-detects -------------------------------

  getItemBoxSpawns(): Array<{ position: THREE.Vector3; normal: THREE.Vector3 }> {
    const out: Array<{ position: THREE.Vector3; normal: THREE.Vector3 }> = [];
    const rows = 6;
    for (let r = 0; r < rows; r++) {
      const s = this.sampleAtDistance(((r + 0.35) / rows) * this.lapLength);
      for (let i = 0; i < 5; i++) {
        out.push({
          position: s.position.clone()
            .addScaledVector(s.binormal, ((i - 2) / 2) * (HALF_WIDTH - 3))
            .setY(1.4),
          normal: new THREE.Vector3(0, 1, 0),
        });
      }
    }
    return out;
  }

  getHazardHints(): HazardHint[] {
    return [
      { kind: 'oil', distance: 70, lateral: -3.5 },
      { kind: 'oil', distance: 300, lateral: 4.0 },
      { kind: 'boulder', distance: 175, span: 16, speed: 1.1 },
      { kind: 'fireball', distance: 240, lateral: 0, speed: 1.3 },
      { kind: 'fireball', distance: 258, lateral: 5.5, speed: 0.9 },
      { kind: 'slider', distance: 400, span: 14, speed: 1.0 },
      { kind: 'snapper', distance: 108, lateral: 7.5, speed: 1.2 },
      { kind: 'snapper', distance: 470, lateral: -7.5, speed: 0.9 },
      // P0d-D1: the `traffic` kind is gone. Two hints that used to sit here
      // (distance 20 and 330) are deleted rather than re-kinded.
    ];
  }
}

function quatFromTangent(tangent: THREE.Vector3): THREE.Quaternion {
  // Karts face -Z, so aim -Z along the tangent.
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const fwd = tangent.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().copy(fwd).cross(up).normalize();
  m.makeBasis(right, up, fwd.clone().negate());
  q.setFromRotationMatrix(m);
  return q;
}

// ===========================================================================
//  DUMMY KARTS
// ===========================================================================

interface Dummy {
  state: KartState;
  dist: number;
  lane: number;
  laneTarget: number;
  baseSpeed: number;
  laps: number;
  node: THREE.Group;
  alpha: number;
  visScale: number;
  spin: number;
}

function makeKartState(id: number, isPlayer: boolean): KartState {
  return {
    id, isPlayer,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    groundQuaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    speed: 0, speedRatio: 0, angularVelocity: 0,
    steerAngle: 0,
    suspension: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    wheelGrounded: [true, true, true, true],
    grounded: true, airTime: 0, surface: SurfaceType.Road,
    drifting: false, driftStage: DriftStage.None, driftDirection: 0, driftCharge: 0,
    boostTime: 0, boostStrength: 0,
    hopping: false, stunned: false, stunTime: 0, invulnerable: false, starTime: 0,
    gliding: false, antiGravity: false,
    lap: 1, progress: 0, racePosition: id + 1, finished: false, finishTime: 0, lapTimes: [],
    rpm: 0, heldItem: null, itemCount: 0,
  };
}

const KART_COLORS = [0xff4d3d, 0x38b6ff, 0x4ade80, 0xffd23f];

function buildKartMesh(color: number): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color, roughness: 0.22, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06,
    envMapIntensity: 1.2,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.55, 2.0, 2, 2, 3), bodyMat);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 12), bodyMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0.55, -1.35);
  g.add(nose);
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.36, 20, 14),
    new THREE.MeshPhysicalMaterial({ color: 0xf5f7ff, roughness: 0.18, clearcoat: 1 }),
  );
  helmet.position.set(0, 1.06, 0.15);
  helmet.castShadow = true;
  g.add(helmet);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.85 });
  const tg = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 16);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const w = new THREE.Mesh(tg, tyre);
      w.rotation.z = Math.PI / 2;
      w.position.set(sx * 0.82, 0.36, sz * 0.78);
      w.castShadow = true;
      g.add(w);
    }
  }
  return g;
}

// ===========================================================================
//  STUB SERVICES
// ===========================================================================

class DummyKarts {
  karts: KartState[] = [];
  player: KartState | null = null;
  dummies: Dummy[] = [];

  setKartAlpha(kartId: number, alpha: number): void {
    const d = this.dummies[kartId];
    if (d) d.alpha = alpha;
  }
  setKartScale(kartId: number, scale: number): void {
    const d = this.dummies[kartId];
    if (d) d.visScale = scale;
  }
  getSocket(): THREE.Object3D | null { return null; }
}

class DummyPhysics {
  constructor(private karts: DummyKarts) {}
  boosts = 0;
  stuns = 0;
  impulses = 0;

  applyBoost(kartId: number, seconds: number, strength: number, _source: string): void {
    const k = this.karts.karts[kartId];
    if (!k) return;
    k.boostTime = Math.min(6, k.boostTime + seconds);
    k.boostStrength = Math.max(k.boostStrength, strength);
    this.boosts++;
  }
  applyStun(kartId: number, seconds: number, _kind: string): void {
    const k = this.karts.karts[kartId];
    if (!k || k.starTime > 0 || k.invulnerable) return;
    k.stunTime = Math.max(k.stunTime, seconds);
    k.stunned = true;
    k.boostTime = 0;
    this.stuns++;
  }
  applyImpulse(kartId: number, impulse: THREE.Vector3): void {
    const d = this.karts.dummies[kartId];
    if (!d) return;
    // Push the kart sideways in lane space, just enough to see it.
    d.laneTarget = clamp(d.laneTarget + impulse.x * 0.004, -HALF_WIDTH + 2, HALF_WIDTH - 2);
    this.impulses++;
  }
}

interface BurstRec { sprite: THREE.Sprite; life: number; max: number; scale: number }

class DummyVfx {
  private pool: BurstRec[] = [];
  private cursor = 0;
  shakes = 0;
  flashes = 0;
  lastBurst = '';

  constructor(private scene: THREE.Scene) {
    const tex = radialTexture();
    for (let i = 0; i < 48; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, blending: THREE.AdditiveBlending, transparent: true,
        depthWrite: false, opacity: 0,
      }));
      s.visible = false;
      scene.add(s);
      this.pool.push({ sprite: s, life: 0, max: 1, scale: 1 });
    }
  }

  burst(id: string, position: THREE.Vector3, _normal?: THREE.Vector3, scale = 1): void {
    this.lastBurst = id;
    const r = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    r.life = r.max = 0.42;
    r.scale = scale * 2.4;
    r.sprite.visible = true;
    r.sprite.position.copy(position);
    (r.sprite.material as THREE.SpriteMaterial).color.set(
      id === 'explosion' ? 0xffb04a : id === 'lightning' ? 0xfff090 : 0x9fe0ff,
    );
  }
  screenShake(_a: number, _s: number): void { this.shakes++; }
  setSpeedIntensity(_v: number): void {}
  flash(_c: THREE.ColorRepresentation, _a: number, _s: number): void { this.flashes++; }

  update(dt: number): void {
    for (const r of this.pool) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.sprite.visible = false; continue; }
      const k = 1 - r.life / r.max;
      r.sprite.scale.setScalar(r.scale * (0.4 + k * 1.9));
      (r.sprite.material as THREE.SpriteMaterial).opacity = (1 - k) * 0.9;
    }
  }
}

function radialTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ===========================================================================
//  HARNESS
// ===========================================================================

const KEY_ITEMS: Array<[string, ItemType]> = [
  ['Digit1', ItemType.Boost],
  ['Digit2', ItemType.TripleBoost],
  ['Digit3', ItemType.GreenShell],
  ['Digit4', ItemType.TripleGreenShell],
  ['Digit5', ItemType.RedShell],
  ['Digit6', ItemType.TripleRedShell],
  ['Digit7', ItemType.Banana],
  ['Digit8', ItemType.TripleBanana],
  ['KeyQ', ItemType.Bomb],
  ['KeyW', ItemType.Star],
  ['KeyE', ItemType.Lightning],
  ['KeyR', ItemType.Ghost],
  ['KeyT', ItemType.Bullet],
  ['KeyY', ItemType.BlueShell],
  ['KeyU', ItemType.Coin],
  ['KeyI', ItemType.Squid],
];

interface HitLog { targetId: number; sourceId: number; item: ItemType; t: number }

class Harness {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  gallery = new THREE.Scene();
  galleryCam: THREE.PerspectiveCamera;
  galleryRoot = new THREE.Group();

  track = new OvalTrack();
  karts = new DummyKarts();
  physics: DummyPhysics;
  vfx: DummyVfx;
  items!: ItemSystem;

  elapsed = 0;
  simTime = 0;
  paused = false;
  showGallery = false;
  camMode = 0;
  hits: HitLog[] = [];

  private ctx: FrameContext = { dt: 0, fixedDt: FIXED_DT, elapsed: 0, frame: 0, alpha: 0 };
  private frame = 0;
  private hudEl = document.getElementById('hud')!;
  private testEl = document.getElementById('tests')!;
  private keysEl = document.getElementById('keys')!;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.2, 900);
    this.galleryCam = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
    this.galleryCam.position.set(0, 2.2, 9.4);
    this.galleryCam.lookAt(0, 0.2, 0);

    this.physics = new DummyPhysics(this.karts);
    this.vfx = new DummyVfx(this.scene);

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    bus.on('item:hit', (p) => {
      this.hits.push({ targetId: p.targetId, sourceId: p.sourceId, item: p.item, t: this.simTime });
      if (this.hits.length > 400) this.hits.shift();
    });
  }

  async init(): Promise<void> {
    this.buildWorld();
    this.buildKarts();

    this.items = new ItemSystem(this.scene, this.track, this.karts, this.physics, this.vfx);
    await this.items.init();

    this.buildGallery();
    this.mountAtlas();
    this.renderKeyHelp();

    // Expose everything for the browser assertions.
    (window as unknown as Record<string, unknown>).__ITEMS__ = {
      harness: this,
      items: this.items,
      track: this.track,
      karts: this.karts,
      projectiles: this.items.projectiles,
      THREE,
      ItemType,
      step: (seconds: number) => this.step(seconds),
      give: (id: number, item: ItemType) => this.items.grantItem(id, item),
      fire: (id: number) => this.items.requestUse(id),
      reset: () => this.resetKarts(),
      hits: () => this.hits,
      clearHits: () => { this.hits.length = 0; },
      setPaused: (v: boolean) => { this.paused = v; },
      setKart: (id: number, dist: number, lane: number, speed: number) =>
        this.placeKart(id, dist, lane, speed),
      activeList: () => this.activeList(),
      probabilityRow: (slot: number) => Array.from(this.items.probabilityRow(slot)),
    };
  }

  // -----------------------------------------------------------------------

  private buildWorld(): void {
    this.scene.background = new THREE.Color(0x0a1020);
    this.scene.fog = new THREE.Fog(0x0a1020, 260, 640);

    const env = studioEnvironment(this.renderer);
    this.scene.environment = env;
    this.gallery.environment = env;

    const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x2a2f3d, 0.8);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2dd, 3.0);
    sun.position.set(70, 120, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -180; cam.right = 180; cam.top = 180; cam.bottom = -180;
    cam.near = 1; cam.far = 400;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.1);
    rim.position.set(-90, 40, -70);
    this.scene.add(rim);

    // Road ribbon, generated from the same service the items use.
    const lap = this.track.lapLength;
    const steps = 420;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const s = this.track.sampleAtDistance((i / steps) * lap);
      const l = s.position.clone().addScaledVector(s.binormal, -s.halfWidth);
      const r = s.position.clone().addScaledVector(s.binormal, s.halfWidth);
      pos.push(l.x, 0.01, l.z, r.x, 0.01, r.z);
      uv.push(0, (i / steps) * 40, 1, (i / steps) * 40);
    }
    for (let i = 0; i < steps; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const road = new THREE.BufferGeometry();
    road.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    road.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    road.setIndex(idx);
    road.computeVertexNormals();
    const roadMesh = new THREE.Mesh(road, new THREE.MeshStandardMaterial({
      map: roadTexture(), roughness: 0.85, metalness: 0.0,
    }));
    roadMesh.receiveShadow = true;
    this.scene.add(roadMesh);

    // Barriers at the road edge, so shell bounces are visible.
    for (const side of [-1, 1]) {
      const wp: number[] = [];
      const wi: number[] = [];
      for (let i = 0; i <= steps; i++) {
        const s = this.track.sampleAtDistance((i / steps) * lap);
        const b = s.position.clone().addScaledVector(s.binormal, side * s.halfWidth);
        wp.push(b.x, 0.0, b.z, b.x, 1.5, b.z);
      }
      for (let i = 0; i < steps; i++) {
        const a = i * 2;
        wi.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
      wg.setIndex(wi);
      wg.computeVertexNormals();
      const wall = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({
        color: side > 0 ? 0xd8dde8 : 0xc9d0dc, roughness: 0.5, metalness: 0.2,
        side: THREE.DoubleSide,
      }));
      this.scene.add(wall);
    }

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(900, 900),
      new THREE.MeshStandardMaterial({ color: 0x1e3a24, roughness: 0.95 }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.02;
    grass.receiveShadow = true;
    this.scene.add(grass);
  }

  private buildKarts(): void {
    for (let i = 0; i < 4; i++) {
      const state = makeKartState(i, i === 0);
      const node = buildKartMesh(KART_COLORS[i]);
      this.scene.add(node);
      const d: Dummy = {
        state, dist: i * 26, lane: (i - 1.5) * 3.4, laneTarget: (i - 1.5) * 3.4,
        baseSpeed: 24 - i * 1.6, laps: 0, node, alpha: 1, visScale: 1, spin: 0,
      };
      this.karts.dummies.push(d);
      this.karts.karts.push(state);
      if (i === 0) this.karts.player = state;
    }
    this.syncKarts(0);
  }

  private buildGallery(): void {
    this.gallery.background = new THREE.Color(0x0d1018);
    this.gallery.add(this.galleryRoot);

    const key = new THREE.DirectionalLight(0xfff4e6, 3.6);
    key.position.set(4, 6, 6);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 1.6);
    fill.position.set(-6, 1.5, 4);
    const rim = new THREE.DirectionalLight(0xffffff, 3.2);
    rim.position.set(-1.5, 3.5, -7);
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x33384a, 1.1);
    this.gallery.add(key, fill, rim, hemi);

    // P0d-D5: the live set first, then the prototypes that survive only because
    // Projectiles still pools them or `grantItem()` can force them.
    const ids: ItemModelId[] = [
      'rocket', 'bottle', 'battery', 'ninja',
      'star', 'greenShell', 'blueShell', 'bomb',
      'bullet', 'coin',
    ];
    const cols = 4;
    const sx = 2.35, sy = 2.5;
    const pedMat = new THREE.MeshPhysicalMaterial({
      color: 0x1b2130, roughness: 0.28, metalness: 0.5, clearcoat: 0.7,
    });
    const pedGeo = new THREE.CylinderGeometry(0.72, 0.85, 0.16, 40);

    ids.forEach((id, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = (col - (cols - 1) / 2) * sx;
      const y = ((Math.floor(ids.length / cols) - 1) / 2 - row) * sy;
      const turntable = new THREE.Group();
      turntable.position.set(x, y, 0);
      turntable.name = `tt_${id}`;
      const ped = new THREE.Mesh(pedGeo, pedMat);
      ped.position.y = -0.72;
      turntable.add(ped);
      const model = this.items.models.create(id);
      model.position.y = 0;
      turntable.add(model);
      const label = makeLabel(id);
      label.position.set(0, -1.02, 0.1);
      turntable.add(label);
      this.galleryRoot.add(turntable);
    });
  }

  private mountAtlas(): void {
    const holder = document.getElementById('atlas');
    if (!holder) return;
    const src = this.items.getIconCanvas();
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(0, 0, 256, 256);
      if (src) ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, 256, 256);
    }
    holder.appendChild(c);
  }

  private renderKeyHelp(): void {
    const rows = [
      'LIVE SET:  1 battery   5 rocket   7 bottle   R ninja   W star',
      'forced only: 3 green  Q bomb  T bullet  Y blue  U coin  E/I inert',
      'SPACE use held    B roll from box    X clear projectiles',
      'G gallery  C camera  P pause  H hazards  Z run tests',
      'arrows: player lane / speed',
    ];
    this.keysEl.textContent = rows.join('\n');
  }

  // -----------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    const hit = KEY_ITEMS.find(([code]) => code === e.code);
    if (hit) {
      this.items.grantItem(0, hit[1]);
      this.items.requestUse(0);
      return;
    }
    switch (e.code) {
      case 'Space': e.preventDefault(); this.items.requestUse(0); break;
      case 'KeyB': {
        // Simulate driving through a box: roll for the player's position.
        this.items.grantItem(0, ItemType.Coin);
        this.items.reset();
        this.forceRoll(0);
        break;
      }
      case 'KeyX': this.items.projectiles.clear(); break;
      case 'KeyG': this.showGallery = !this.showGallery; break;
      case 'KeyP': this.paused = !this.paused; break;
      case 'KeyC': this.camMode = (this.camMode + 1) % 3; break;
      case 'KeyH': this.hazards(); break;
      case 'KeyZ': void this.runTests(); break;
      case 'ArrowLeft': this.karts.dummies[0].laneTarget = clamp(this.karts.dummies[0].laneTarget - 2, -9, 9); break;
      case 'ArrowRight': this.karts.dummies[0].laneTarget = clamp(this.karts.dummies[0].laneTarget + 2, -9, 9); break;
      case 'ArrowUp': this.karts.dummies[0].baseSpeed = clamp(this.karts.dummies[0].baseSpeed + 2, 0, 40); break;
      case 'ArrowDown': this.karts.dummies[0].baseSpeed = clamp(this.karts.dummies[0].baseSpeed - 2, 0, 40); break;
    }
  }

  private hazardsOn = true;
  private hazards(): void {
    this.hazardsOn = !this.hazardsOn;
    this.items.hazards.setEnabled(this.hazardsOn);
  }

  /** Force the roulette to spin as if a box was collected. */
  private forceRoll(kartId: number): void {
    const total = this.karts.karts.length;
    const k = this.karts.karts[kartId];
    const item = this.items.probabilityRow(k.racePosition);
    void item;
    // Reuse the real pipeline: drop the nearest box then let physics collide.
    for (let i = 0; i < this.items.boxes.boxCount; i++) {
      const p = this.items.boxes.getBoxPosition(i);
      if (!p || !this.items.boxes.isAlive(i)) continue;
      if (p.distanceToSquared(k.position) < 3000) {
        this.karts.dummies[kartId].dist = this.track.project(p).distance - 1.0;
        this.karts.dummies[kartId].laneTarget =
          p.clone().sub(this.track.project(p).position).dot(this.track.project(p).binormal);
        break;
      }
    }
    void total;
  }

  // -----------------------------------------------------------------------

  placeKart(id: number, dist: number, lane: number, speed: number): void {
    const d = this.karts.dummies[id];
    if (!d) return;
    d.dist = wrap(dist, this.track.lapLength);
    d.lane = lane;
    d.laneTarget = lane;
    d.baseSpeed = speed;
    d.state.stunTime = 0;
    d.state.stunned = false;
    this.syncKarts(0);
  }

  resetKarts(): void {
    this.items.reset();
    this.items.projectiles.clear();
    for (let i = 0; i < this.karts.dummies.length; i++) {
      const d = this.karts.dummies[i];
      d.dist = i * 26;
      d.lane = d.laneTarget = (i - 1.5) * 3.4;
      d.baseSpeed = 24 - i * 1.6;
      d.laps = 0;
      d.state.stunTime = 0;
      d.state.stunned = false;
      d.state.boostTime = 0;
      d.state.starTime = 0;
    }
    this.hits.length = 0;
    this.syncKarts(0);
  }

  /** Advance the dummy karts, then the item system, by `dt`. */
  private syncKarts(dt: number): void {
    const lap = this.track.lapLength;
    for (const d of this.karts.dummies) {
      const st = d.state;
      if (st.stunTime > 0) {
        st.stunTime -= dt;
        st.stunned = st.stunTime > 0;
        d.spin += dt * 14;
      } else {
        st.stunned = false;
      }
      if (st.boostTime > 0) st.boostTime = Math.max(0, st.boostTime - dt);

      const boost = st.boostTime > 0 ? st.boostStrength : 1;
      const speed = st.stunned ? 0 : d.baseSpeed * boost;
      d.dist += speed * dt;
      if (d.dist >= lap) { d.dist -= lap; d.laps++; }
      d.lane += (d.laneTarget - d.lane) * Math.min(1, dt * 3);

      const s = this.track.sampleAtDistance(d.dist);
      st.position.copy(s.position).addScaledVector(s.binormal, d.lane);
      st.position.y = 0.0;
      st.quaternion.copy(quatFromTangent(s.tangent));
      if (st.stunned) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.spin);
        st.quaternion.multiply(q);
      }
      st.groundQuaternion.copy(quatFromTangent(s.tangent));
      st.velocity.copy(s.tangent).multiplyScalar(speed);
      st.speed = speed;
      st.speedRatio = clamp01(speed / 28);
      st.lap = d.laps + 1;
      st.progress = d.laps + s.t;
      st.surface = SurfaceType.Road;
    }
    // Positions 1..N by progress.
    const order = [...this.karts.karts].sort((a, b) => b.progress - a.progress);
    order.forEach((k, i) => { k.racePosition = i + 1; });
  }

  /** Deterministic fixed stepping — used by the tests. */
  step(seconds: number): void {
    const n = Math.max(1, Math.round(seconds / FIXED_DT));
    for (let i = 0; i < n; i++) {
      this.simTime += FIXED_DT;
      this.syncKarts(FIXED_DT);
      this.ctx = { dt: FIXED_DT, fixedDt: FIXED_DT, elapsed: this.simTime, frame: this.frame++, alpha: 0 };
      this.items.fixedUpdate(this.ctx);
    }
    this.items.update({ dt: seconds, fixedDt: FIXED_DT, elapsed: this.simTime, frame: this.frame, alpha: 0 });
  }

  // -----------------------------------------------------------------------

  private lastTime = performance.now();
  private accumulator = 0;

  frameLoop = (): void => {
    requestAnimationFrame(this.frameLoop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsed += dt;

    if (!this.paused) {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < 8) {
        this.accumulator -= FIXED_DT;
        this.simTime += FIXED_DT;
        this.syncKarts(FIXED_DT);
        this.ctx = {
          dt: FIXED_DT, fixedDt: FIXED_DT, elapsed: this.simTime,
          frame: this.frame++, alpha: 0,
        };
        this.items.fixedUpdate(this.ctx);
        steps++;
      }
      this.items.update({
        dt, fixedDt: FIXED_DT, elapsed: this.simTime, frame: this.frame, alpha: 0,
      });
      this.vfx.update(dt);
    }

    this.applyKartVisuals();
    this.updateCamera(dt);
    this.spinGallery(dt);
    this.renderHud();

    if (this.showGallery) this.renderer.render(this.gallery, this.galleryCam);
    else this.renderer.render(this.scene, this.camera);
  };

  private applyKartVisuals(): void {
    for (const d of this.karts.dummies) {
      d.node.position.copy(d.state.position);
      d.node.quaternion.copy(d.state.quaternion);
      const s = d.visScale * (1 + (this.items.getStarTime(d.state.id) > 0
        ? Math.sin(this.elapsed * 18) * 0.05 : 0));
      d.node.scale.setScalar(s);
      d.node.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.Material & { opacity: number; transparent: boolean };
        if (d.alpha < 0.99) { mat.transparent = true; mat.opacity = d.alpha; }
        else if (mat.transparent && mat.opacity < 1) { mat.opacity = 1; }
      });
    }
  }

  private updateCamera(dt: number): void {
    const p = this.karts.karts[0];
    if (this.camMode === 0) {
      // Chase the player.
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(p.quaternion);
      const want = p.position.clone().addScaledVector(fwd, -11).setY(5.2);
      this.camera.position.lerp(want, Math.min(1, dt * 4));
      this.camera.lookAt(p.position.x, p.position.y + 1.2, p.position.z);
    } else if (this.camMode === 1) {
      // Side-on, so bounces and homing arcs are legible.
      this.camera.position.set(p.position.x, 26, p.position.z + 44);
      this.camera.lookAt(p.position.x, 0, p.position.z);
    } else {
      // Whole track.
      this.camera.position.set(0, 210, 5);
      this.camera.lookAt(0, 0, 0);
    }
  }

  private spinGallery(dt: number): void {
    for (const c of this.galleryRoot.children) {
      c.rotation.y += dt * 0.55;
    }
  }

  private activeList(): Array<Record<string, number | string>> {
    const out: Array<Record<string, number | string>> = [];
    this.items.projectiles.forEachActive((p) => {
      out.push({
        id: p.id, kind: p.kind, state: p.state, target: p.target,
        speed: +p.vel.length().toFixed(1),
        x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1), z: +p.pos.z.toFixed(1),
        bounces: p.bounces, life: +p.life.toFixed(2), held: p.held ? 1 : 0,
      });
    });
    return out;
  }

  private renderHud(): void {
    const pr = this.items.projectiles;
    const lines: string[] = [];
    lines.push(`FOXY KART · ITEMS HARNESS      ${this.paused ? '[PAUSED]' : ''}`);
    lines.push(`view: ${this.showGallery ? 'GALLERY' : 'TRACK'}   cam ${this.camMode}   t=${this.simTime.toFixed(1)}s`);
    lines.push('');
    lines.push(`projectiles active: ${pr.activeCount}`);
    lines.push(`  green ${pr.countOf('green')}  red ${pr.countOf('red')}  blue ${pr.countOf('blue')}`);
    lines.push(`  banana ${pr.countOf('banana')}  bomb ${pr.countOf('bomb')}`);
    lines.push(`boxes alive: ${this.items.boxes.aliveCount}/${this.items.boxes.boxCount}   hazards: ${this.items.hazards.count}`);
    lines.push('');
    for (const k of this.karts.karts) {
      const held = this.items.getHeldItem(k.id);
      const roul = this.items.getRouletteDisplay(k.id);
      const threat = this.items.getIncomingThreat(k.id);
      lines.push(
        `#${k.id} P${k.racePosition} ${k.speed.toFixed(0).padStart(2)}m/s ` +
        `item=${held === null ? '—' : ITEM_NAMES[held]}${this.items.getItemCount(k.id) > 1 ? `x${this.items.getItemCount(k.id)}` : ''}` +
        `${this.items.isRouletteSpinning(k.id) && roul !== null ? ` [spin:${ITEM_NAMES[roul]}]` : ''}` +
        `${k.stunned ? ' STUN' : ''}${this.items.getStarTime(k.id) > 0 ? ' STAR' : ''}` +
        `${this.items.getBulletTime(k.id) > 0 ? ' BULLET' : ''}` +
        `${this.items.getGhostTime(k.id) > 0 ? ' BOO' : ''}` +
        `${this.items.getInkAmount(k.id) > 0 ? ` INK${this.items.getInkAmount(k.id).toFixed(1)}` : ''}` +
        `${this.items.getShrinkAmount(k.id) > 0 ? ' SMALL' : ''}` +
        `${threat ? ` <- ${ITEM_NAMES[threat.item]} ${threat.distance.toFixed(0)}m` : ''}`,
      );
    }
    lines.push('');
    lines.push(`stuns ${this.physics.stuns}  boosts ${this.physics.boosts}  impulses ${this.physics.impulses}`);
    lines.push(`hits logged: ${this.hits.length}`);
    this.hudEl.textContent = lines.join('\n');
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.galleryCam.aspect = w / h;
    this.galleryCam.updateProjectionMatrix();
  }

  // =======================================================================
  //  BEHAVIOUR ASSERTIONS
  // =======================================================================

  async runTests(): Promise<Record<string, unknown>> {
    const wasPaused = this.paused;
    this.paused = true;
    const results: Record<string, unknown> = {};

    results.redShell = this.testRedShell();
    results.greenBounce = this.testGreenBounce();
    results.blueShell = this.testBlueShell();
    results.banana = this.testBanana();
    results.bomb = this.testBomb();
    results.nan = this.testNaN();
    results.table = this.testTable();

    this.paused = wasPaused;
    this.printTests(results);
    (window as unknown as Record<string, unknown>).__ITEM_TESTS__ = results;
    return results;
  }

  /** Red shell fired at a kart 40 m ahead must connect inside 3 s. */
  private testRedShell(): Record<string, unknown> {
    this.resetKarts();
    // Player at 0, victim 40 m up the road doing race pace; others parked far away.
    this.placeKart(0, 0, 0, 20);
    this.placeKart(1, 40, 2.5, 24);
    this.placeKart(2, 600, -6, 0);
    this.placeKart(3, 700, 6, 0);
    this.syncKarts(0);
    const startGap = this.karts.karts[1].position.distanceTo(this.karts.karts[0].position);
    this.hits.length = 0;
    this.items.grantItem(0, ItemType.RedShell);
    const t0 = this.simTime;
    this.items.requestUse(0);
    let hitAt = -1;
    let maxOffRoad = 0;
    for (let i = 0; i < Math.round(4 / FIXED_DT); i++) {
      this.step(FIXED_DT);
      // Track how far the shell strays from the road while homing.
      this.items.projectiles.forEachActive((p) => {
        if (p.kind !== 'red') return;
        const s = this.track.project(p.pos);
        const lat = Math.abs(p.pos.clone().sub(s.position).dot(s.binormal));
        maxOffRoad = Math.max(maxOffRoad, lat);
      });
      const h = this.hits.find((x) => x.item === ItemType.RedShell && x.targetId === 1);
      if (h && hitAt < 0) { hitAt = h.t - t0; break; }
    }
    return {
      startGapM: +startGap.toFixed(1),
      hitTimeS: hitAt < 0 ? null : +hitAt.toFixed(2),
      pass: hitAt >= 0 && hitAt <= 3.0,
      maxLateralM: +maxOffRoad.toFixed(1),
      stayedOnRoad: maxOffRoad <= HALF_WIDTH + 1.5,
    };
  }

  /** Green shell must reflect off a wall and keep going. */
  private testGreenBounce(): Record<string, unknown> {
    this.resetKarts();
    this.placeKart(0, 20, -9.0, 0);
    for (let i = 1; i < 4; i++) this.placeKart(i, 600 + i * 20, 0, 0);
    this.syncKarts(0);
    this.items.projectiles.clear();
    // Aim the shell across the road so it must meet the outer barrier.
    const s = this.track.sampleAtDistance(20);
    const dir = s.tangent.clone().multiplyScalar(0.55)
      .addScaledVector(s.binormal, -0.85).normalize();
    const p = this.items.projectiles.spawn(
      'green', ItemType.GreenShell, 0,
      this.karts.karts[0].position.clone().setY(0.4), dir, null, false,
    );
    if (!p) return { pass: false, reason: 'pool empty' };
    const speed0 = p.vel.length();
    let bouncesSeen = 0;
    let speedAfter = 0;
    let aliveAfter = false;
    let travelled = 0;
    const start = p.pos.clone();
    for (let i = 0; i < Math.round(2.5 / FIXED_DT); i++) {
      this.step(FIXED_DT);
      if (!p.active) break;
      bouncesSeen = p.bounces;
      speedAfter = p.vel.length();
      travelled = p.pos.distanceTo(start);
      aliveAfter = true;
      if (bouncesSeen >= 2) break;
    }
    return {
      speedBefore: +speed0.toFixed(1),
      bounces: bouncesSeen,
      speedAfter: +speedAfter.toFixed(1),
      stillAlive: aliveAfter,
      travelledM: +travelled.toFixed(1),
      pass: bouncesSeen >= 1 && aliveAfter && speedAfter > 20,
    };
  }

  /** Blue shell must reach 1st place and explode there. */
  private testBlueShell(): Record<string, unknown> {
    this.resetKarts();
    // Player last, leader 260 m up the road.
    this.placeKart(0, 0, 0, 22);
    this.placeKart(1, 90, 3, 22);
    this.placeKart(2, 170, -3, 22);
    this.placeKart(3, 260, 0, 22);
    this.syncKarts(0);
    this.hits.length = 0;
    this.items.grantItem(0, ItemType.BlueShell);
    const t0 = this.simTime;
    this.items.requestUse(0);
    const leader = [...this.karts.karts].sort((a, b) => b.progress - a.progress)[0];
    let boomAt = -1;
    let maxAlt = 0;
    let phases = '';
    for (let i = 0; i < Math.round(8 / FIXED_DT); i++) {
      this.step(FIXED_DT);
      let seen = false;
      this.items.projectiles.forEachActive((p) => {
        if (p.kind !== 'blue') return;
        seen = true;
        maxAlt = Math.max(maxAlt, p.pos.y);
        const tag = p.state === 2 ? 'C' : p.state === 3 ? 'H' : 'S';
        if (phases[phases.length - 1] !== tag) phases += tag;
      });
      const h = this.hits.find((x) => x.item === ItemType.BlueShell);
      if (h) { boomAt = h.t - t0; break; }
      if (!seen && i > 4) break;
    }
    const victim = this.hits.find((x) => x.item === ItemType.BlueShell);
    return {
      leaderId: leader.id,
      explodedAtS: boomAt < 0 ? null : +boomAt.toFixed(2),
      hitLeader: !!victim && victim.targetId === leader.id,
      victims: this.hits.filter((x) => x.item === ItemType.BlueShell).length,
      maxAltitudeM: +maxAlt.toFixed(1),
      phases,
      pass: boomAt >= 2.0 && boomAt <= 7.0 && !!victim && victim.targetId === leader.id,
    };
  }

  /** Banana must settle on the ground and then spin whoever drives into it. */
  private testBanana(): Record<string, unknown> {
    this.resetKarts();
    this.placeKart(0, 100, 0, 0);
    this.placeKart(1, 60, 0, 26);
    for (let i = 2; i < 4; i++) this.placeKart(i, 600 + i * 20, 0, 0);
    this.syncKarts(0);
    this.items.projectiles.clear();
    this.hits.length = 0;
    this.items.grantItem(0, ItemType.Banana);
    this.items.requestUse(0);
    let settled = false;
    let settleY = 0;
    let bounced = 0;
    for (let i = 0; i < Math.round(1.5 / FIXED_DT); i++) {
      this.step(FIXED_DT);
      this.items.projectiles.forEachActive((p) => {
        if (p.kind !== 'banana') return;
        bounced = Math.max(bounced, p.bounces);
        if (p.state === 1) { settled = true; settleY = p.pos.y; }
      });
      if (settled) break;
    }
    // Now let kart 1 drive through it.
    let struck = false;
    for (let i = 0; i < Math.round(3 / FIXED_DT); i++) {
      this.step(FIXED_DT);
      if (this.hits.some((x) => x.item === ItemType.Banana && x.targetId === 1)) { struck = true; break; }
    }
    return {
      settled, bounces: bounced, restY: +settleY.toFixed(2), spunAVictim: struck,
      pass: settled && bounced >= 1 && struck,
    };
  }

  /** Bomb must detonate and catch more than one kart. */
  private testBomb(): Record<string, unknown> {
    this.resetKarts();
    this.placeKart(0, 100, 0, 0);
    this.placeKart(1, 118, 1.5, 0);
    this.placeKart(2, 121, -2.0, 0);
    this.placeKart(3, 600, 0, 0);
    this.syncKarts(0);
    this.items.projectiles.clear();
    this.hits.length = 0;
    this.items.grantItem(0, ItemType.Bomb);
    this.items.requestUse(0);
    for (let i = 0; i < Math.round(4 / FIXED_DT); i++) {
      this.step(FIXED_DT);
      if (this.hits.some((x) => x.item === ItemType.Bomb)) break;
    }
    const victims = new Set(this.hits.filter((x) => x.item === ItemType.Bomb).map((x) => x.targetId));
    return { victims: victims.size, ids: [...victims], pass: victims.size >= 2 };
  }

  /** Fire 200 projectiles and prove nothing ever goes non-finite. */
  private testNaN(): Record<string, unknown> {
    this.resetKarts();
    const kinds: ItemType[] = [
      ItemType.GreenShell, ItemType.RedShell, ItemType.Banana, ItemType.Bomb, ItemType.BlueShell,
    ];
    let fired = 0;
    let bad = 0;
    const badFields: string[] = [];
    for (let n = 0; n < 200; n++) {
      const owner = n % 4;
      this.items.grantItem(owner, kinds[n % kinds.length]);
      this.items.requestUse(owner);
      fired++;
      this.step(FIXED_DT * 6);
      this.items.projectiles.forEachSlot((p) => {
        const vals = [p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.lateral, p.life];
        for (let i = 0; i < vals.length; i++) {
          if (!Number.isFinite(vals[i])) {
            bad++;
            if (badFields.length < 5) badFields.push(`${p.kind}#${p.id}[${i}]=${vals[i]}`);
          }
        }
      });
    }
    // Let everything play out, then check again.
    this.step(15);
    this.items.projectiles.forEachSlot((p) => {
      const vals = [p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z];
      for (const v of vals) if (!Number.isFinite(v)) bad++;
    });
    this.resetKarts();
    return { fired, nonFinite: bad, samples: badFields, pass: bad === 0 };
  }

  /** The probability table must be normalised and correctly gated. */
  private testTable(): Record<string, unknown> {
    const sums: number[] = [];
    for (let slot = 1; slot <= 12; slot++) {
      const row = this.items.probabilityRow(slot);
      let s = 0;
      for (let i = 0; i < row.length; i++) s += row[i];
      sums.push(+s.toFixed(6));
    }
    const first = this.items.probabilityRow(1);
    const last = this.items.probabilityRow(12);
    // P0d-D5: five live items. The old assertions checked for a blue shell and a
    // bullet, neither of which exists in the set any more.
    const live = new Set<number>([
      ItemType.Banana, ItemType.Boost, ItemType.RedShell, ItemType.Ghost, ItemType.Star,
    ]);
    let deadWeight = 0;
    for (let slot = 1; slot <= 12; slot++) {
      const row = this.items.probabilityRow(slot);
      for (let i = 0; i < row.length; i++) if (!live.has(i)) deadWeight += row[i];
    }
    return {
      rowSums: sums,
      normalised: sums.every((s) => Math.abs(s - 1) < 1e-6),
      deadWeight: +deadWeight.toFixed(9),
      firstHasStar: first[ItemType.Star] > 0,
      firstBottle: +first[ItemType.Banana].toFixed(3),
      firstRocket: +first[ItemType.RedShell].toFixed(3),
      lastStar: +last[ItemType.Star].toFixed(3),
      lastNinja: +last[ItemType.Ghost].toFixed(3),
      pass: sums.every((s) => Math.abs(s - 1) < 1e-6)
        && deadWeight === 0
        && first[ItemType.Star] === 0 && first[ItemType.Ghost] === 0
        && last[ItemType.Star] > 0.2
        && first[ItemType.Banana] > last[ItemType.Banana],
    };
  }

  private printTests(r: Record<string, unknown>): void {
    const lines: string[] = ['BEHAVIOUR ASSERTIONS', ''];
    for (const [k, v] of Object.entries(r)) {
      const rec = v as Record<string, unknown>;
      const pass = rec.pass === true;
      lines.push(`${pass ? 'PASS' : 'FAIL'}  ${k}`);
      for (const [kk, vv] of Object.entries(rec)) {
        if (kk === 'pass') continue;
        lines.push(`        ${kk}: ${JSON.stringify(vv)}`);
      }
      lines.push('');
    }
    this.testEl.textContent = lines.join('\n');
    console.log('[items harness] assertions', r);
  }
}

// ===========================================================================
//  Assets
// ===========================================================================

function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(20, 12, 20),
    new THREE.MeshBasicMaterial({ color: 0x2b3346, side: THREE.BackSide }),
  );
  scene.add(room);
  const panel = (w: number, h: number, c: number, i: number) => new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i) }),
  );
  const top = panel(14, 14, 0xffffff, 4.5);
  top.position.y = 5.8; top.rotation.x = Math.PI / 2; scene.add(top);
  const l = panel(9, 7, 0xbfd8ff, 2.2);
  l.position.set(-9.7, 1, 0); l.rotation.y = Math.PI / 2; scene.add(l);
  const r = panel(9, 7, 0xffd9b0, 1.9);
  r.position.set(9.7, 1, 0); r.rotation.y = -Math.PI / 2; scene.add(r);
  const b = panel(14, 7, 0xffffff, 1.2);
  b.position.set(0, 0.5, -9.7); scene.add(b);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.05);
  pmrem.dispose();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose());
    }
  });
  return rt.texture;
}

function roadTexture(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2b2e35';
  ctx.fillRect(0, 0, S, S);
  // Aggregate speckle.
  for (let i = 0; i < 26000; i++) {
    const v = 30 + Math.random() * 70;
    ctx.fillStyle = `rgba(${v},${v + 3},${v + 8},${0.06 + Math.random() * 0.18})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 2, 2);
  }
  // Edge lines.
  ctx.fillStyle = '#e8ecf4';
  ctx.fillRect(0, 0, 14, S);
  ctx.fillRect(S - 14, 0, 14, S);
  // Centre dashes.
  ctx.fillStyle = 'rgba(240,244,250,0.75)';
  for (let y = 0; y < S; y += 96) ctx.fillRect(S / 2 - 5, y, 10, 54);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 512, 96);
  ctx.font = '600 52px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillText(text, 256, 52);
  ctx.fillStyle = '#cfe3ff';
  ctx.fillText(text, 256, 48);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.9, 0.36, 1);
  return s;
}

// ===========================================================================

const container = document.getElementById('app');
if (container) {
  const h = new Harness(container);
  h.init()
    .then(() => {
      h.frameLoop();
      console.log('[items harness] ready. window.__ITEMS__ exposed.');
    })
    .catch((err) => {
      console.error('[items harness] init failed', err);
      const el = document.getElementById('hud');
      if (el) el.textContent = `INIT FAILED\n${String(err)}\n${(err as Error)?.stack ?? ''}`;
    });
}

void MODEL_FOR_ITEM;
