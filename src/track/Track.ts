/**
 * ============================================================================
 *  Track — the circuit, and the only thing the rest of the game may talk to
 * ============================================================================
 *
 *  Physics, AI, items, camera, HUD and the world dresser all depend on
 *  `ITrackService`, never on a mesh. That is what lets the track be rebuilt
 *  (or swapped for another circuit) without anyone else noticing.
 *
 *  PERFORMANCE NOTE — `raycastGround` and `collideWalls` are the hottest
 *  queries in the game: four wheels x twelve karts x 120 Hz = 5760 ground
 *  probes a second, plus wall probes, plus item shells. Neither of them
 *  raycasts a mesh in the common case. Instead:
 *
 *    1. project the query point onto the centreline (O(1): bucket grid seed,
 *       or a *seeded* Newton when the previous query was nearby, which is the
 *       case for every wheel after the first),
 *    2. evaluate the analytic cross-section at that arc length and lateral
 *       offset — the same `surfaceHeight()` the mesh was built from,
 *    3. intersect the ray with that local tangent plane.
 *
 *  Zero allocations, and no triangle ever touched. The BVH on
 *  `collisionMesh` is still there for the awkward cases (arbitrary rays,
 *  other subsystems) and is exposed for anyone who needs it.
 * ============================================================================
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { SurfaceType } from '@/core/Types';
import type {
  FrameContext,
  GroundHit,
  ISubsystem,
  ITrackService,
  KartState,
  QualitySettings,
  TrackSample,
  WallHit,
} from '@/core/Types';
import { RENDER_ORDER } from '@/core/Config';
import { clamp, clamp01, wrap } from '@/core/MathUtils';
import {
  TF,
  TrackSpline,
  makeAttribs,
  makeSample,
  resolveNodes,
} from './TrackSpline';
import type { SplineAttribs, WallStyle } from './TrackSpline';
import { DEFAULT_TRACK, TRACKS, TRACK_ORDER, getTrackDef } from './TrackDefs';
import type { PropSpec, TrackDef } from './TrackDefs';
import { createRoadMaterials } from './RoadMaterial';
import type { RoadMaterials } from './RoadMaterial';
import {
  CROSS,
  buildTrack,
  kerbSuppressed,
  lateralZone,
  roadSurfacePoint,
  surfaceHeight,
  wallHeight,
} from './TrackBuilder';
import type { BuiltTrack } from './TrackBuilder';
import { Decals } from './Decals';
import { Checkpoints } from './Checkpoints';

// ---------------------------------------------------------------------------
// Scratch — nothing in the query path allocates
// ---------------------------------------------------------------------------

/** A small ring of samples: callers routinely hold one result across a call. */
const RING = 12;
const _ring: TrackSample[] = [];
for (let i = 0; i < RING; i++) _ring.push(makeSample());
let _ringNext = 0;
const nextSample = (): TrackSample => {
  const s = _ring[_ringNext];
  _ringNext = (_ringNext + 1) % RING;
  return s;
};

const VRING = 8;
const _vring: THREE.Vector3[] = [];
for (let i = 0; i < VRING; i++) _vring.push(new THREE.Vector3());
let _vringNext = 0;
const nextVec = (): THREE.Vector3 => {
  const v = _vring[_vringNext];
  _vringNext = (_vringNext + 1) % VRING;
  return v;
};

const _work = makeSample();
const _at = makeAttribs();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _lastSeedPos = new THREE.Vector3(1e9, 1e9, 1e9);
const _m4 = new THREE.Matrix4();
const _euler = new THREE.Euler();

interface BoostZone {
  d0: number;
  d1: number;
  lat0: number;
  lat1: number;
}

export interface DecorationHints {
  theme: string;
  skyPreset: string;
  props: Array<{ type: string; position: THREE.Vector3; rotation: number; scale: number }>;
  terrainSeed: number;
  waterLevel: number | null;
}

/**
 * ============================ PROP ORIENTATION ============================
 *
 * There are exactly **two** prop local-space conventions in this project, and
 * mixing them up is what put the start gantry lengthwise down the middle of the
 * road and drove the grandstand terraces across the racing surface.
 *
 * 1. **FACES the road** — the default, and what `Props.roadside()` /
 *    `Props.planStands()` / `PropBuilder.plate()` all assume:
 *      local **+Z points at the road**, local **±X runs along** it.
 *    Boards, signs, stands, sea walls, traffic lights, anything with a front.
 *    yaw = atan2(-binormal.x * side, -binormal.z * side), where `side` is the
 *    sign of the prop's lateral offset.
 *
 * 2. **SPANS the road** — gates: a form built along local ±X that has to arch
 *    *across* the carriageway:
 *      local **±X follows the binormal**, local **+Z follows the tangent**.
 *    yaw = atan2(tangent.x, tangent.z).
 *
 * A rotation of `yaw` about +Y sends local +Z to (sin yaw, 0, cos yaw) and
 * local +X to (cos yaw, 0, -sin yaw); with `binormal = tangent x normal`, that
 * makes convention 2's +X exactly **-binormal**. The old code used the single
 * convention-2 formula for every authored prop, so every stand and board came
 * out 90 degrees out — which is also why a 22 m crowd stand at lat +21 had its
 * near end sitting 9 m from the centreline, on the asphalt.
 *
 * Keep this list in sync with `Props.normaliseType()`. Anything not named here
 * gets convention 1; rotationally symmetric props (palms, rocks, pylons) don't
 * care either way.
 */
const SPANS_THE_ROAD = new Set([
  'startgantry', 'gantry', 'startline', 'finishgantry',
  'balloonarch', 'balloons', 'balloongate',
  'arch', 'gate', 'gateway',
  'tunnelportal', 'portal', 'tunnel',
  'hoload', 'hologram', 'holo',
  'overheadsign', 'gantrybanner',
]);

function spansTheRoad(type: string): boolean {
  return SPANS_THE_ROAD.has(type.toLowerCase().replace(/[^a-z]/g, ''));
}

// ---------------------------------------------------------------------------

export class Track implements ITrackService, ISubsystem {
  readonly scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private quality: QualitySettings;

  /** Populated by `loadTrack`. */
  def!: TrackDef;
  spline!: TrackSpline;
  built!: BuiltTrack;
  materials!: RoadMaterials;
  decals!: Decals;
  checkpoints!: Checkpoints;

  roadGroup: THREE.Group = new THREE.Group();
  collisionMesh!: THREE.Mesh;
  bvh!: MeshBVH;

  private boostZones: BoostZone[] = [];
  private hitG: GroundHit = {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    surface: SurfaceType.Road,
  };
  private hitW: WallHit = {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(1, 0, 0),
    depth: 0,
  };
  /** Rolling seed for the seeded centreline projection. */
  private seedD = -1;
  private elapsed = 0;
  private ready = false;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, quality: QualitySettings) {
    this.scene = scene;
    this.renderer = renderer;
    this.quality = quality;
    this.roadGroup.name = 'trackRoot';
    this.scene.add(this.roadGroup);
  }

  // =========================================================================
  //  Lifecycle
  // =========================================================================

  async init(): Promise<void> {
    await this.loadTrack(DEFAULT_TRACK);
  }

  /** Build (or rebuild) a circuit by id. Safe to call more than once. */
  async loadTrack(id: string): Promise<void> {
    const def = getTrackDef(id);
    this.teardown();

    this.def = def;
    this.spline = new TrackSpline(resolveNodes(def.nodes, def.defaults), true);
    this.materials = createRoadMaterials(def, this.quality);
    this.decals = new Decals(this.spline, def, this.quality);
    this.materials.setDecalTexture(this.decals.stainTexture);
    this.built = buildTrack(this.spline, def, this.materials, this.quality, this.decals.stainTexture);
    this.checkpoints = new Checkpoints(this.spline, def.laps, 40);

    this.roadGroup.add(this.built.roadGroup);
    this.roadGroup.add(this.decals.mesh);
    this.roadGroup.add(this.checkpoints.debugMesh());
    this.roadGroup.add(this.built.collisionMesh);
    this.built.roadGroup.renderOrder = RENDER_ORDER.ROAD;

    this.collisionMesh = this.built.collisionMesh;
    this.bvh = this.built.bvh;

    this.boostZones = def.boostPads.map((p) => ({
      d0: wrap(p.t * this.spline.length - p.length * 0.5, this.spline.length),
      d1: wrap(p.t * this.spline.length + p.length * 0.5, this.spline.length),
      lat0: p.lat - p.width * 0.5,
      lat1: p.lat + p.width * 0.5,
    }));

    this.seedD = -1;
    _lastSeedPos.set(1e9, 1e9, 1e9);
    this.ready = true;

    // Yield once so the loading bar can paint between circuits.
    await Promise.resolve();
    console.info(
      `[Track] ${def.name}: ${this.spline.length.toFixed(0)} m, ` +
      `${this.built.stats.rings} rings, ${this.built.stats.triangles | 0} tris, ` +
      `${this.built.stats.drawCalls} draw calls, ${this.decals.quadCount} decals, ` +
      `${this.built.stats.ms.toFixed(1)} ms`,
    );
  }

  private teardown(): void {
    if (!this.ready) return;
    this.roadGroup.clear();
    this.built?.dispose();
    this.decals?.dispose();
    this.checkpoints?.dispose();
    this.materials?.dispose();
    this.ready = false;
  }

  update(ctx: FrameContext): void {
    this.elapsed = ctx.elapsed;
    if (!this.ready) return;
    // Boost pads and energy rails breathe so they read as powered.
    const pulse = 0.72 + 0.28 * Math.sin(ctx.elapsed * 5.1);
    this.materials.boost.emissiveIntensity = 1.7 + pulse * 1.6;
    this.materials.energy.emissiveIntensity = 2.6 + pulse * 1.1;
  }

  dispose(): void {
    this.teardown();
    this.scene.remove(this.roadGroup);
  }

  // =========================================================================
  //  ITrackService — metadata
  // =========================================================================

  get lapLength(): number {
    return this.spline ? this.spline.length : 1;
  }

  get lapCount(): number {
    return this.def ? this.def.laps : 3;
  }

  get trackId(): string {
    return this.def ? this.def.id : DEFAULT_TRACK;
  }

  get trackName(): string {
    return this.def ? this.def.name : '';
  }

  /** Ids of every circuit, for the menu. */
  static listTracks(): Array<{ id: string; name: string; subtitle: string; theme: string }> {
    return TRACK_ORDER.map((id) => ({
      id,
      name: TRACKS[id].name,
      subtitle: TRACKS[id].subtitle,
      theme: TRACKS[id].theme,
    }));
  }

  /** Number of lap-validation checkpoints, for anti-skip logic elsewhere. */
  get checkpointCount(): number {
    return this.checkpoints ? this.checkpoints.count : 40;
  }

  // =========================================================================
  //  ITrackService — sampling
  // =========================================================================

  sampleAt(t: number): TrackSample {
    return this.spline.sampleAt(wrap(t, 1), nextSample());
  }

  sampleAtDistance(d: number): TrackSample {
    return this.spline.sampleAtDistance(d, nextSample());
  }

  project(position: THREE.Vector3): TrackSample {
    const d = this.projectDistance(position);
    return this.spline.sampleAtDistance(d, nextSample());
  }

  /**
   * Arc length of the nearest centreline point. Uses the previous answer as a
   * Newton seed whenever the query has barely moved, which is the case for the
   * three wheels that follow the first one.
   */
  private projectDistance(position: THREE.Vector3): number {
    const seed = position.distanceToSquared(_lastSeedPos) < 9 ? this.seedD : -1;
    const d = this.spline.nearestDistance(position, seed);
    this.seedD = d;
    _lastSeedPos.copy(position);
    return d;
  }

  // =========================================================================
  //  ITrackService — ground
  // =========================================================================

  /**
   * Analytic downward probe. `up` is the kart's own up axis, so this works
   * unchanged on the 84-degree wall-ride and inside the anti-gravity sections.
   */
  raycastGround(origin: THREE.Vector3, up: THREE.Vector3, maxDist: number): GroundHit {
    const hit = this.hitG;
    hit.hit = false;
    hit.distance = maxDist;
    hit.surface = SurfaceType.Void;
    if (!this.ready) return hit;

    const d = this.projectDistance(origin);
    const s = this.spline.sampleAtDistance(d, _work);
    this.spline.attribsAtDistance(s.distance, _at);

    // lateral / vertical offset of the query point in the road's own frame
    _v0.copy(origin).sub(s.position);
    const lat = _v0.dot(s.binormal);
    const sh = lat < 0 ? _at.shoulderL : _at.shoulderR;
    const noKerb = kerbSuppressed(_at.flags, lat < 0 ? -1 : 1);

    if (_at.flags & TF.Gap) return hit;

    const corridor = _at.halfWidth + (noKerb ? 0 : CROSS.kerbW) + sh;
    if (Math.abs(lat) > corridor + 0.4) return hit;

    const h = surfaceHeight(lat, _at.halfWidth, sh, s.distance, noKerb);
    // surface point + local tangent-plane normal
    _v1.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, h);
    const e = 0.06;
    const dl =
      (surfaceHeight(lat + e, _at.halfWidth, sh, s.distance, noKerb) -
        surfaceHeight(lat - e, _at.halfWidth, sh, s.distance, noKerb)) / (2 * e);
    _nrm.copy(s.normal).addScaledVector(s.binormal, -dl);
    if (!noKerb && Math.abs(lat) > _at.halfWidth && Math.abs(lat) <= _at.halfWidth + CROSS.kerbW) {
      const dz =
        (surfaceHeight(lat, _at.halfWidth, sh, s.distance + 0.08, noKerb) -
          surfaceHeight(lat, _at.halfWidth, sh, s.distance - 0.08, noKerb)) / 0.16;
      _nrm.addScaledVector(s.tangent, -dz);
    }
    _nrm.normalize();

    // ray: origin + (-up) * t, plane through _v1 with normal _nrm
    const denom = up.dot(_nrm);
    if (denom <= 1e-4) return hit;
    _v2.copy(origin).sub(_v1);
    const t = _v2.dot(_nrm) / denom;
    if (t < -0.35 || t > maxDist) return hit;

    hit.hit = true;
    hit.distance = t;
    hit.point.copy(origin).addScaledVector(up, -t);
    hit.normal.copy(_nrm);
    hit.surface = this.classify(lat, _at, s.distance);
    return hit;
  }

  /** Surface family at a lateral offset. Boost pads win over everything. */
  private classify(lat: number, at: SplineAttribs, d: number): SurfaceType {
    const noKerb = kerbSuppressed(at.flags, lat < 0 ? -1 : 1);
    const sh = lat < 0 ? at.shoulderL : at.shoulderR;
    const zone = lateralZone(lat, at.halfWidth, sh, noKerb);
    if (zone === 'off') return SurfaceType.Void;
    if (zone === 'shoulder') return at.shoulderSurface;
    if (at.flags & TF.AntiGravity) return SurfaceType.AntiGravity;
    if (at.flags & TF.Boost) return SurfaceType.Boost;
    if (this.inBoostZone(d, lat)) return SurfaceType.Boost;
    return at.surface;
  }

  private inBoostZone(d: number, lat: number): boolean {
    const L = this.spline.length;
    for (let i = 0; i < this.boostZones.length; i++) {
      const z = this.boostZones[i];
      if (lat < z.lat0 || lat > z.lat1) continue;
      if (z.d0 <= z.d1) {
        if (d >= z.d0 && d <= z.d1) return true;
      } else if (d >= z.d0 || d <= z.d1) {
        return true;
      }
      void L;
    }
    return false;
  }

  surfaceAt(position: THREE.Vector3): SurfaceType {
    if (!this.ready) return SurfaceType.Void;
    const d = this.projectDistance(position);
    const s = this.spline.sampleAtDistance(d, _work);
    this.spline.attribsAtDistance(s.distance, _at);
    if (_at.flags & TF.Gap) {
      // A gap flagged `Glider` is a glider volume, not nothing. KartPhysics only
      // ever latches `gliding` from a *point* query (`surfaceAt`) while airborne,
      // and this branch used to answer `Void` for both — which is why no kart has
      // ever deployed a glider on any of the three circuits: every authored
      // glider volume sits on a `TF.Gap` segment, so `TF.Glider` was unreachable.
      return (_at.flags & TF.Glider) ? SurfaceType.Glider : SurfaceType.Void;
    }
    _v0.copy(position).sub(s.position);
    const lat = _v0.dot(s.binormal);
    return this.classify(lat, _at, s.distance);
  }

  // =========================================================================
  //  ITrackService — walls
  // =========================================================================

  /**
   * Swept sphere against the barriers. The wall lives at a known lateral
   * offset, so this is a plane test in the road's own frame — no mesh needed.
   */
  collideWalls(position: THREE.Vector3, radius: number): WallHit {
    const hit = this.hitW;
    hit.hit = false;
    hit.depth = 0;
    if (!this.ready) return hit;

    const d = this.projectDistance(position);
    const s = this.spline.sampleAtDistance(d, _work);
    this.spline.attribsAtDistance(s.distance, _at);
    if (_at.flags & TF.Gap) return hit;

    _v0.copy(position).sub(s.position);
    const lat = _v0.dot(s.binormal);
    const vert = _v0.dot(s.normal);

    let bestDepth = 0;
    let bestSide: -1 | 1 = 1;
    let bestGap = 0;

    for (const side of [-1, 1] as const) {
      const style: WallStyle = side < 0 ? _at.wallL : _at.wallR;
      if (style === 'none') continue;
      const sh = side < 0 ? _at.shoulderL : _at.shoulderR;
      const kw = kerbSuppressed(_at.flags, side) ? 0 : CROSS.kerbW;
      const wallLat = _at.halfWidth + kw + sh + 0.12;
      // signed clearance from the wall face; negative means already through it
      const clearance = wallLat - side * lat;
      if (clearance > radius) continue;
      const base = surfaceHeight(side * wallLat, _at.halfWidth, sh, s.distance, kw === 0);
      const top = base + wallHeight(style);
      if (vert < base - 0.55 || vert > top + 0.7) continue;
      const depth = radius - clearance;
      if (depth > bestDepth) {
        bestDepth = depth;
        bestSide = side;
        bestGap = clearance;
      }
    }

    if (bestDepth <= 0) return hit;
    hit.hit = true;
    hit.depth = bestDepth;
    // contact point sits on the wall face, at the query's own height
    hit.point
      .copy(s.position)
      .addScaledVector(s.binormal, lat + bestSide * bestGap)
      .addScaledVector(s.normal, vert);
    hit.normal.copy(s.binormal).multiplyScalar(-bestSide);
    return hit;
  }

  // =========================================================================
  //  ITrackService — bounds, line, grid
  // =========================================================================

  isOutOfBounds(position: THREE.Vector3): boolean {
    if (!this.ready) return false;
    const d = this.projectDistance(position);
    const s = this.spline.sampleAtDistance(d, _work);
    this.spline.attribsAtDistance(s.distance, _at);
    _v0.copy(position).sub(s.position);
    const lat = _v0.dot(s.binormal);
    const vert = _v0.dot(s.normal);
    const sh = Math.max(_at.shoulderL, _at.shoulderR);
    const corridor = _at.halfWidth + CROSS.kerbW + sh;
    if (Math.abs(lat) > corridor + 9) return true;
    if (vert < -11) return true;
    if (_at.flags & TF.Gap && vert < -7) return true;
    return false;
  }

  /**
   * A point on the ideal line, `lookahead` metres past `t`. The line is baked
   * from the spline's own curvature and smoothed over ~30 m, so it genuinely
   * cuts corners instead of tracing the centreline.
   */
  racingLineAt(t: number, lookahead: number): THREE.Vector3 {
    const out = nextVec();
    if (!this.ready) return out.set(0, 0, 0);
    const L = this.spline.length;
    const d = wrap(t * L + lookahead, L);
    const lat = this.lineOffsetAt(d);
    roadSurfacePoint(this.spline, d, lat, out);
    return out;
  }

  /** Lateral offset of the ideal line at an arc length, metres. */
  lineOffsetAt(d: number): number {
    const rl = this.built.racingLine;
    const step = this.built.rlStep;
    const f = wrap(d, this.spline.length) / step;
    const i = Math.floor(f);
    const a = rl[Math.min(rl.length - 1, i)];
    const b = rl[Math.min(rl.length - 1, i + 1)];
    return a + (b - a) * (f - i);
  }

  getStartPosition(index: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    if (!this.ready) {
      return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    }
    return this.checkpoints.getStartPosition(index);
  }

  getRespawn(t: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    if (!this.ready) {
      return { position: new THREE.Vector3(0, 2, 0), quaternion: new THREE.Quaternion() };
    }
    return this.checkpoints.getRespawn(t);
  }

  /**
   * Fold a kart into the lap record. NOT called from `update()` — Track has no
   * roster. Whoever owns the karts calls this (RaceDirector or PhysicsWorld);
   * if RaceDirector runs its own LapTracker instead, nothing here fires and
   * the two never fight.
   */
  updateProgress(kart: KartState): boolean {
    if (!this.ready) return false;
    return this.checkpoints.updateProgress(kart);
  }

  /** 0..1 — how much of the current lap has been validated. */
  lapValidity(kartId: number): number {
    return this.ready ? this.checkpoints.lapValidity(kartId) : 0;
  }

  // =========================================================================
  //  Published extras
  // =========================================================================

  getBoostPads(): Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; width: number }> {
    return this.ready ? this.built.boostPads : [];
  }

  getItemBoxSpawns(): Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion }> {
    return this.ready ? this.built.itemBoxSpawns : [];
  }

  /** Normalised top-down outline for the minimap, 0..1 in both axes. */
  getMinimapPath(): THREE.Vector2[] {
    return this.ready ? this.built.minimapPath : [];
  }

  getHazardHints(): Array<{
    kind: 'oil' | 'boulder' | 'fireball' | 'slider' | 'snapper' | 'traffic';
    distance: number;
    lateral?: number;
    span?: number;
    speed?: number;
  }> {
    if (!this.ready) return [];
    const L = this.spline.length;
    return this.def.hazards.map((h) => ({
      kind: h.kind,
      distance: wrap(h.t * L, L),
      lateral: h.lat ?? 0,
      span: h.span,
      speed: h.speed,
    }));
  }

  /**
   * Everything the world dresser needs. Props are authored in track space
   * (lap fraction + lateral offset) and resolved to world transforms here, so
   * a prop can never drift off its corner.
   */
  getDecorationHints(): DecorationHints {
    const props: DecorationHints['props'] = [];
    if (!this.ready) {
      return {
        theme: 'coastal',
        skyPreset: 'sunset',
        props,
        terrainSeed: 1,
        waterLevel: null,
      };
    }
    const L = this.spline.length;

    const place = (spec: PropSpec, t: number, lat: number) => {
      const d = wrap(t * L, L);
      const s = this.spline.sampleAtDistance(d, _work);
      this.spline.attribsAtDistance(s.distance, _at);
      const sh = lat < 0 ? _at.shoulderL : _at.shoulderR;
      // Props outside the corridor sit on the shoulder plane extended outward.
      const clampedLat = clamp(lat, -(_at.halfWidth + CROSS.kerbW + sh), _at.halfWidth + CROSS.kerbW + sh);
      const h = surfaceHeight(clampedLat, _at.halfWidth, sh, s.distance, false);
      const pos = new THREE.Vector3()
        .copy(s.position)
        .addScaledVector(s.binormal, lat)
        .addScaledVector(s.normal, h + (spec.up ?? 0));
      // See the PROP ORIENTATION block above: gates span the road (local +X
      // along the binormal), everything else faces it (local +Z at the road).
      // A "gate" type authored *outside* the asphalt is not straddling anything —
      // e.g. neon's `holoAd` appears both at lat 0 (over the road) and at
      // lat -20 (a trackside hologram) — so the span convention is gated on the
      // prop actually being over the carriageway.
      let yaw: number;
      if (Math.abs(lat) < 1e-3 || (spansTheRoad(spec.type) && Math.abs(lat) < _at.halfWidth)) {
        _v0.copy(s.tangent);
        yaw = Math.atan2(_v0.x, _v0.z);
      } else {
        const side = lat < 0 ? -1 : 1;
        _v0.copy(s.binormal).multiplyScalar(-side);
        yaw = Math.atan2(_v0.x, _v0.z);
      }
      yaw += spec.yaw ?? 0;
      props.push({ type: spec.type, position: pos, rotation: yaw, scale: spec.scale ?? 1 });
    };

    for (const spec of this.def.props) {
      const step = spec.step;
      const end = spec.end;
      if (step && end !== undefined && step > 1e-5) {
        // `end` may wrap past 1
        const span = end >= spec.t ? end - spec.t : end + 1 - spec.t;
        const n = Math.min(400, Math.floor(span / step) + 1);
        for (let i = 0; i < n; i++) {
          const t = wrap(spec.t + i * step, 1);
          place(spec, t, spec.lat);
          if (spec.mirror) place(spec, t, -spec.lat);
        }
      } else {
        place(spec, wrap(spec.t, 1), spec.lat);
        if (spec.mirror) place(spec, wrap(spec.t, 1), -spec.lat);
      }
    }

    return {
      theme: this.def.theme,
      skyPreset: this.def.skyPreset,
      props,
      terrainSeed: this.def.terrainSeed,
      waterLevel: this.def.waterLevel,
    };
  }

  /** Fog colour / density the sky and environment should match. */
  getAtmosphere(): { color: number; density: number } {
    return this.ready
      ? { color: this.def.fogColor, density: this.def.fogDensity }
      : { color: 0x99b8dd, density: 0.002 };
  }

  // =========================================================================
  //  Dev / QA helpers (used by src/dev/track.ts and the critic harness)
  // =========================================================================

  setDebugVisible(opts: { checkpoints?: boolean; collision?: boolean; wireframe?: boolean }): void {
    if (!this.ready) return;
    if (opts.checkpoints !== undefined) {
      this.checkpoints.debugMesh().visible = opts.checkpoints;
    }
    if (opts.collision !== undefined) {
      this.built.collisionMesh.visible = opts.collision;
      (this.built.collisionMesh.material as THREE.MeshBasicMaterial).visible = opts.collision;
    }
    if (opts.wireframe !== undefined) {
      this.built.roadGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material as THREE.Material & { wireframe?: boolean };
        if ('wireframe' in m) m.wireframe = opts.wireframe === true;
      });
    }
  }

  get stats(): BuiltTrack['stats'] & { length: number; decals: number } {
    return {
      ...this.built.stats,
      length: this.spline.length,
      decals: this.decals.quadCount,
    };
  }

  /** Timing harness for the hot query. Reported in the dev page. */
  benchmarkGround(samples = 10000): { ms: number; perCall: number; hits: number } {
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const L = this.spline.length;
    // Walk the lap the way twelve karts do: clusters of four nearby probes.
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < samples; i++) {
      const cluster = Math.floor(i / 4);
      const d = ((cluster * 7.31) % L);
      const s = this.spline.sampleAtDistance(d, _work);
      const lat = ((i % 4) - 1.5) * 0.8 + Math.sin(cluster * 0.7) * s.halfWidth * 0.6;
      p.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, 0.55);
      up.copy(s.normal);
      if (this.raycastGround(p, up, 3).hit) hits++;
    }
    const ms = performance.now() - t0;
    return { ms, perCall: (ms / samples) * 1000, hits };
  }

  /** Cross-check the analytic probe against the BVH. Used by the harness. */
  verifyAgainstBvh(samples = 400): { max: number; mean: number; misses: number } {
    const ray = new THREE.Ray();
    const L = this.spline.length;
    let max = 0;
    let sum = 0;
    let n = 0;
    let misses = 0;
    for (let i = 0; i < samples; i++) {
      const d = (i / samples) * L;
      const s = this.spline.sampleAtDistance(d, _work);
      this.spline.attribsAtDistance(s.distance, _at);
      if (_at.flags & TF.Gap) continue;
      const lat = (((i * 37) % 11) / 10 - 0.5) * _at.halfWidth * 1.6;
      _v0.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, 2.2);
      const g = this.raycastGround(_v0, s.normal, 6);
      ray.origin.copy(_v0);
      ray.direction.copy(s.normal).negate();
      const bhit = this.bvh.raycastFirst(ray, THREE.DoubleSide, 0, 6);
      if (!g.hit || !bhit) { misses++; continue; }
      const err = Math.abs(g.distance - bhit.distance);
      max = Math.max(max, err);
      sum += err;
      n++;
    }
    return { max, mean: n ? sum / n : 0, misses };
  }

  /** Only used by the dev harness's flythrough. */
  cameraFrameAt(d: number, out: { position: THREE.Vector3; quaternion: THREE.Quaternion }): void {
    const s = this.spline.sampleAtDistance(d, _work);
    this.spline.attribsAtDistance(s.distance, _at);
    const lat = this.lineOffsetAt(s.distance);
    roadSurfacePoint(this.spline, s.distance, lat, out.position, _nrm);
    out.position.addScaledVector(_nrm, 1.35);
    const ahead = this.spline.sampleAtDistance(s.distance + 14, makeSample());
    _v1.copy(ahead.position).sub(out.position).normalize().negate();
    _v2.copy(_nrm);
    _v0.crossVectors(_v2, _v1).normalize();
    _v2.crossVectors(_v1, _v0).normalize();
    _m4.makeBasis(_v0, _v2, _v1);
    out.quaternion.setFromRotationMatrix(_m4);
    void _euler;
    void clamp01;
  }

  /** Elapsed seconds since the track was built — used by the harness HUD. */
  get age(): number {
    return this.elapsed;
  }

  get rendererRef(): THREE.WebGLRenderer {
    return this.renderer;
  }
}

export default Track;
