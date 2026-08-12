/**
 * ============================================================================
 *  APEX KART — KART MODEL ASSEMBLY
 * ============================================================================
 *  One `KartModel` = one racer's complete visual rig: chassis (3 LODs), four
 *  wheels, a driver, named sockets, and a contact-shadow decal.
 *
 *  NODE HIERARCHY — each level exists because something different writes to it:
 *
 *      root            world position (render-interpolated)
 *       ├── ground     groundQuaternion — keeps the shadow flat on the road
 *       │    └── shadow
 *       └── body       full physics bodyQuaternion (already has lean + spin)
 *            └── tilt  EXTRA visual roll / pitch / drift yaw from KartManager
 *                 ├── scaled    squash & stretch + lightning shrink
 *                 │    ├── chassis LOD 0/1/2
 *                 │    ├── steering wheel
 *                 │    ├── driver rig
 *                 │    └── body sockets
 *                 └── wheel roots ×4  (outside `scaled`: MK8 squashes the
 *                                      shell, never the contact patch)
 *
 *  Geometry is shared. `KartAssets` builds each chassis / tyre / driver exactly
 *  once and every model instances meshes over those buffers, so twelve racers
 *  cost twelve sets of `Object3D`s and nothing more.
 * ============================================================================
 */

import * as THREE from 'three';
import type { KartTuning, QualitySettings } from '@/core/Types';
import { LAYERS, RENDER_ORDER } from '@/core/Config';
import { clamp, clamp01, lerp } from '@/core/MathUtils';
import {
  BODY_TYRE, buildKartBody, consolidateParts, frameFromTuning, setSegmentScale,
  type BodyBuildResult, type ConsolidatePart, type KartBodyId, type KartFrame,
} from './KartBodies';
import {
  buildWheel, createWheelObject, disposeWheelBuild, mirrorWheelBuild,
  type TyreId, type WheelBuild,
} from './Wheels';
import type {
  FaceMaterial, FaceSpec, KartMaterialSet, MaterialSlot, PaintSpec,
} from './KartMaterials';
import { EMISSIVE_SLOTS, KartMaterialLibrary } from './KartMaterials';
import {
  DriverRig, buildDriver, disposeDriverBuild, driverRestParts,
  type DriverBuild, type DriverId, type DriverPose,
} from './Driver';

export const SOCKET_NAMES = [
  'exhaustL', 'exhaustR', 'wheelFL', 'wheelFR', 'wheelRL', 'wheelRR',
  'itemMount', 'driverHead', 'rearCentre',
] as const;
export type SocketName = (typeof SOCKET_NAMES)[number];

/**
 * 0 = hero: per-slot materials, posed driver, calipers, steering wheel.
 * 1 = near rival: one consolidated chassis buffer, tyres + rims still turn.
 * 2 = mid rival: consolidated reduced chassis, tyres only.
 * 3 = far: the entire kart — driver and wheels included — as one buffer.
 *
 * Draw calls per kart, in order: ~33 / 10 / 6 / 2.
 */
export type LodLevel = 0 | 1 | 2 | 3;

export const LOD_MID_DISTANCE = 40;
export const LOD_FAR_DISTANCE = 120;
/**
 * Closer than this a kart keeps its own wheel nodes however far down the pack it
 * is — a kart whose wheels have stopped turning is the most obvious LOD tell
 * there is, and on the starting grid the whole field is inside twenty metres.
 */
export const LOD_WHEELS_DISTANCE = 55;
/**
 * Only the player gets hero detail — nothing else is ever close enough or still
 * enough in frame to earn 30 draw calls.
 */
export const HERO_COUNT = 1;
/** Rivals ranked below this (by camera distance) drop to LOD 2 or worse. */
export const NEAR_RIVAL_COUNT = 3;
/** Rivals ranked below this drop to the single-buffer LOD 3. */
export const MID_RIVAL_COUNT = 6;

// ---------------------------------------------------------------------------
// Shared asset cache
// ---------------------------------------------------------------------------

interface BodyAsset { build: BodyBuildResult; frame: KartFrame }
interface WheelAsset { right: WheelBuild; left: WheelBuild }

/**
 * Builds and owns every buffer the kart models share.
 *
 * Chassis are cached per `KartBodyId` using the frame of the first tuning that
 * asks for them; a model whose own frame differs is uniformly scaled to match,
 * which keeps heavy karts visibly bigger without paying for six more AO bakes.
 */
export class KartAssets {
  readonly quality: QualitySettings;
  readonly lib: KartMaterialLibrary;

  private bodies = new Map<KartBodyId, BodyAsset>();
  private wheels = new Map<string, WheelAsset>();
  private drivers = new Map<string, DriverBuild>();
  private mergedGeos = new Map<string, THREE.BufferGeometry>();
  private shadowGeo: THREE.PlaneGeometry;
  /** Build cost in ms, per category — surfaced by `stats()`. */
  readonly timings = { bodies: 0, wheels: 0, drivers: 0 };

  constructor(quality: QualitySettings, lib?: KartMaterialLibrary) {
    this.quality = quality;
    this.lib = lib ?? new KartMaterialLibrary(quality);
    // One dial re-tessellates every hand-authored part to the tier's budget.
    setSegmentScale(
      quality.tier === 'ultra' ? 0.78
        : quality.tier === 'high' ? 0.70
          : quality.tier === 'medium' ? 0.58
            : 0.42,
    );
    this.shadowGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.shadowGeo.rotateX(-Math.PI / 2);
  }

  bodyFor(id: KartBodyId, tuning: KartTuning): BodyAsset {
    const hit = this.bodies.get(id);
    if (hit) return hit;
    const t0 = performance.now();
    const frame = frameFromTuning(tuning);
    const asset: BodyAsset = { build: buildKartBody(id, frame, this.quality), frame };
    this.bodies.set(id, asset);
    this.timings.bodies += performance.now() - t0;
    return asset;
  }

  wheelFor(tyre: TyreId, radius: number, width: number): WheelAsset {
    const key = `${tyre}|${radius.toFixed(3)}|${width.toFixed(3)}`;
    const hit = this.wheels.get(key);
    if (hit) return hit;
    const t0 = performance.now();
    const right = buildWheel(tyre, radius, width, this.quality);
    const asset: WheelAsset = { right, left: mirrorWheelBuild(right) };
    this.wheels.set(key, asset);
    this.timings.wheels += performance.now() - t0;
    return asset;
  }

  driverFor(
    id: DriverId, wheelTarget: THREE.Vector3, wheelRadius: number,
    gripSpread: number, scale: number,
  ): DriverBuild {
    // Quantise the hand target so near-identical chassis share one driver mesh.
    const key = `${id}|${wheelTarget.x.toFixed(2)},${wheelTarget.y.toFixed(2)},${wheelTarget.z.toFixed(2)}|${wheelRadius.toFixed(2)}|${gripSpread.toFixed(2)}|${scale.toFixed(2)}`;
    const hit = this.drivers.get(key);
    if (hit) return hit;
    const t0 = performance.now();
    const build = buildDriver(id, {
      quality: this.quality, wheelTarget, wheelRadius, gripSpread, scale,
    });
    this.drivers.set(key, build);
    this.timings.drivers += performance.now() - t0;
    return build;
  }

  /**
   * Memoised consolidated LOD buffers. The atlas UVs are global and the merge
   * happens under the model's `scaled` node, so one buffer serves every racer
   * that shares the same chassis / driver / tyre combination — twelve karts pay
   * for at most a handful of these.
   */
  mergedGeometry(key: string, build: () => THREE.BufferGeometry | null): THREE.BufferGeometry | null {
    const hit = this.mergedGeos.get(key);
    if (hit) return hit;
    const g = build();
    if (g) this.mergedGeos.set(key, g);
    return g;
  }

  get shadowGeometry(): THREE.PlaneGeometry { return this.shadowGeo; }

  /** Total triangles held in the cache — reported by KartManager. */
  stats(): {
    bodies: number; wheels: number; drivers: number; tris: number;
    ms: { bodies: number; wheels: number; drivers: number };
  } {
    let tris = 0;
    for (const b of this.bodies.values()) tris += b.build.tris;
    for (const w of this.wheels.values()) tris += w.right.tris;
    for (const d of this.drivers.values()) tris += d.tris;
    return {
      bodies: this.bodies.size, wheels: this.wheels.size, drivers: this.drivers.size, tris,
      ms: {
        bodies: Math.round(this.timings.bodies),
        wheels: Math.round(this.timings.wheels),
        drivers: Math.round(this.timings.drivers),
      },
    };
  }

  dispose(): void {
    for (const a of this.bodies.values()) {
      for (const list of [a.build.near, a.build.mid, a.build.far]) {
        for (const g of list) g.geometry.dispose();
      }
      a.build.steering?.rim.dispose();
      a.build.steering?.core.dispose();
    }
    this.bodies.clear();
    for (const w of this.wheels.values()) {
      disposeWheelBuild(w.right);
      disposeWheelBuild(w.left);
    }
    this.wheels.clear();
    for (const d of this.drivers.values()) disposeDriverBuild(d);
    this.drivers.clear();
    for (const g of this.mergedGeos.values()) g.dispose();
    this.mergedGeos.clear();
    this.shadowGeo.dispose();
    this.lib.dispose();
  }
}

// ---------------------------------------------------------------------------

export interface WheelVisual {
  root: THREE.Object3D;
  spinner: THREE.Object3D;
  /** Contact-patch socket, child of `root`. */
  socket: THREE.Object3D;
  /** Upright-mounted parts (caliper, hub carrier) — hidden at far LOD. */
  fixed: THREE.Mesh[];
  /** Rim / spoke / brake meshes — hidden at far LOD, tyre stays. */
  rim: THREE.Mesh[];
  /**
   * The tyre carcass, or `null` for wheels that have none (the hover pods). A
   * pod with no tyre must keep its rim at every LOD or the kart loses its wheels.
   */
  tyre: THREE.Mesh | null;
  radius: number;
  /** Rest position in `tilt` space. */
  restX: number;
  restZ: number;
  /** Spring anchor Y and travel, in `tilt` space. */
  hubY: number;
  restLen: number;
  travel: number;
  front: boolean;
  hidden: boolean;
}

export interface KartModelSpec {
  bodyId: KartBodyId;
  tyreId?: TyreId;
  driverId: DriverId;
  tuning: KartTuning;
  /** Stable cache key for the material set (one per racer). */
  paintKey: string;
  paint: PaintSpec;
  /** Face atlas description for this racer's driver. */
  faceSpec: FaceSpec;
  name: string;
}

/**
 * The visual rig for one kart. `KartManager` owns the animation; this class
 * owns structure, materials, LOD and disposal.
 */
export class KartModel {
  readonly root: THREE.Group;
  readonly ground: THREE.Object3D;
  readonly body: THREE.Object3D;
  readonly tilt: THREE.Object3D;
  readonly scaled: THREE.Object3D;
  readonly shadow: THREE.Mesh;
  readonly steering: THREE.Object3D | null;
  readonly driver: DriverRig | null;
  readonly wheels: WheelVisual[] = [];
  readonly sockets: Record<SocketName, THREE.Object3D>;
  readonly frame: KartFrame;
  readonly mats: KartMaterialSet;
  readonly tris: number;
  /** Uniform scale applied to the chassis so it matches this kart's tuning. */
  readonly modelScale: number;
  /**
   * What this model was actually built from. Recorded because a model that
   * cannot say which chassis it is makes a whole class of bug invisible: kart
   * selection was silently dropped for a long time (`RaceDirector` called a
   * `setPlayerKart` that nobody had implemented) and there was no way to assert
   * from outside that the selection had taken effect. `tyreId` is the RESOLVED
   * tyre, after the `spec.tyreId ?? BODY_TYRE[bodyId]` fallback.
   */
  readonly bodyId: KartBodyId;
  readonly tyreId: TyreId;

  /** Rich per-slot chassis at LOD 0, then one consolidated mesh per cheap LOD. */
  private lodNodes: [THREE.Group, THREE.Object3D | null, THREE.Object3D | null, THREE.Object3D | null];
  private lod: LodLevel = 0;
  private meshes: THREE.Mesh[] = [];
  private mergedMat: THREE.MeshPhysicalMaterial;
  private driverBuild: DriverBuild | null = null;
  private driverRootMatrix: THREE.Matrix4 | null = null;
  private opacity = 1;
  /** Latched opaque/transparent decision — see `setOpacity` for why it latches. */
  private isTransparent = false;
  private lightRear: THREE.MeshStandardMaterial | null = null;
  private lightFront: THREE.MeshStandardMaterial | null = null;
  private glowMat: THREE.MeshStandardMaterial | null = null;
  private paintMats: THREE.MeshPhysicalMaterial[] = [];
  private paintBase: THREE.Color[] = [];
  private faceMat: FaceMaterial | null;
  private shadowMat: THREE.MeshBasicMaterial;
  private shadowW: number;
  private shadowL: number;

  constructor(assets: KartAssets, spec: KartModelSpec) {
    const lib = assets.lib;
    const bodyAsset = assets.bodyFor(spec.bodyId, spec.tuning);
    const build = bodyAsset.build;
    const builtFrame = bodyAsset.frame;
    const myFrame = frameFromTuning(spec.tuning);
    this.frame = builtFrame;

    // Match the built chassis to this kart's real track width.
    this.modelScale = clamp(myFrame.trackHalfRear / builtFrame.trackHalfRear, 0.82, 1.22);

    // --- materials ---------------------------------------------------------
    this.mats = lib.getSet(spec.paintKey, spec.paint);
    this.faceMat = lib.createFace(spec.faceSpec);
    for (const slot of ['paint', 'paint2'] as MaterialSlot[]) {
      const m = this.mats[slot];
      if (m instanceof THREE.MeshPhysicalMaterial) {
        this.paintMats.push(m);
        this.paintBase.push(m.color.clone());
      }
    }
    const lr = this.mats.lightRear;
    if (lr instanceof THREE.MeshStandardMaterial) this.lightRear = lr;
    const lf = this.mats.lightFront;
    if (lf instanceof THREE.MeshStandardMaterial) this.lightFront = lf;
    const gl = this.mats.glow;
    if (gl instanceof THREE.MeshStandardMaterial) this.glowMat = gl;

    // --- node chain --------------------------------------------------------
    this.root = new THREE.Group();
    this.root.name = spec.name;
    this.root.matrixAutoUpdate = true;

    this.ground = new THREE.Object3D();
    this.ground.name = `${spec.name}:ground`;
    this.root.add(this.ground);

    this.body = new THREE.Object3D();
    this.body.name = `${spec.name}:body`;
    this.root.add(this.body);

    this.tilt = new THREE.Object3D();
    this.tilt.name = `${spec.name}:tilt`;
    this.body.add(this.tilt);

    this.scaled = new THREE.Object3D();
    this.scaled.name = `${spec.name}:scaled`;
    this.scaled.scale.setScalar(this.modelScale);
    this.tilt.add(this.scaled);

    // --- the merged atlas material every cheap path draws with -------------
    this.mergedMat = lib.mergedFor(spec.paintKey, spec.paint);

    // --- chassis LOD 0: one mesh per material slot -------------------------
    const lod0 = new THREE.Group();
    lod0.name = `${spec.name}:lod0`;
    for (const item of build.near) {
      const mesh = new THREE.Mesh(item.geometry, this.mats[item.slot]);
      mesh.name = `${spec.name}:lod0:${item.slot}`;
      mesh.castShadow = !EMISSIVE_SLOTS.includes(item.slot);
      mesh.receiveShadow = item.slot !== 'glass';
      mesh.renderOrder = RENDER_ORDER.KART + (item.slot === 'glass' ? 2 : 0);
      if (EMISSIVE_SLOTS.includes(item.slot)) mesh.layers.enable(LAYERS.BLOOM);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      lod0.add(mesh);
      this.meshes.push(mesh);
    }
    this.scaled.add(lod0);

    // --- steering wheel (LOD 0 only) ---------------------------------------
    // Rim and hub consolidate into a single buffer: the brushed normal on chrome
    // was at 0.08 scale, so nothing readable is lost.
    if (build.steering) {
      const s = new THREE.Object3D();
      s.name = `${spec.name}:steer`;
      s.position.copy(build.steering.pos);
      s.rotation.x = build.steering.tilt * (Math.PI / 180);
      const geo = assets.mergedGeometry(`${spec.bodyId}|steer`, () => consolidateParts([
        { slot: 'chrome', geometry: build.steering!.rim },
        { slot: 'plastic', geometry: build.steering!.core },
      ]));
      if (geo) {
        const wheelMesh = new THREE.Mesh(geo, this.mergedMat);
        wheelMesh.name = `${spec.name}:steer:wheel`;
        wheelMesh.castShadow = true;
        s.add(wheelMesh);
        this.meshes.push(wheelMesh);
      }
      this.scaled.add(s);
      this.steering = s;
    } else {
      this.steering = null;
    }

    // --- driver ------------------------------------------------------------
    const dpos = build.driver.pos;
    const leanRad = -build.driver.leanDeg * (Math.PI / 180);
    let driverRig: DriverRig | null = null;
    {
      // Hand target expressed in the driver rig's own space.
      const target = new THREE.Vector3();
      let radius = 0.11;
      let spread = 1;
      if (build.steering) {
        target.copy(build.steering.pos).sub(dpos);
        radius = build.steering.radius;
        // Undo the driver's forward lean so the arms are authored upright.
        target.applyAxisAngle(new THREE.Vector3(1, 0, 0), -leanRad);
      } else {
        // Bike / no wheel: reach for handlebars, wider and lower.
        target.set(0, 0.16, -0.36);
        radius = 0.15;
        spread = 1.9;
      }
      const dbuild = assets.driverFor(
        spec.driverId, target, radius, spread, build.driver.scale,
      );
      driverRig = new DriverRig(
        dbuild, this.mats, this.faceMat, `${spec.name}:driver`, this.mergedMat,
      );
      driverRig.root.position.copy(dpos);
      driverRig.root.rotation.x = leanRad;
      this.scaled.add(driverRig.root);
      this.driverBuild = dbuild;
      this.driverRootMatrix = new THREE.Matrix4().compose(
        dpos.clone(),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), leanRad),
        new THREE.Vector3(1, 1, 1),
      );
    }
    this.driver = driverRig;

    // --- wheels ------------------------------------------------------------
    const tyre: TyreId = spec.tyreId ?? BODY_TYRE[spec.bodyId];
    this.bodyId = spec.bodyId;
    this.tyreId = tyre;
    const wheelAsset = assets.wheelFor(
      tyre, builtFrame.wheelRadius, builtFrame.wheelWidth,
    );
    const tyreMat = this.mats.rubber;
    const names: SocketName[] = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'];
    const offsets = spec.tuning.wheelOffsets;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const build2 = i % 2 === 0 ? wheelAsset.left : wheelAsset.right;
      const w = createWheelObject(
        build2, this.mats, tyreMat, `${spec.name}:${names[i]}`, this.mergedMat,
      );
      const scaleMul = build.wheelScale[i];
      const singleFront = build.singleFront && front;
      const restX = singleFront ? 0 : offsets[i].x;
      const socket = new THREE.Object3D();
      socket.name = `${spec.name}:${names[i]}:contact`;
      socket.position.y = -builtFrame.wheelRadius * scaleMul;
      w.root.add(socket);
      const fixed: THREE.Mesh[] = [];
      for (const child of w.root.children) {
        if (child instanceof THREE.Mesh) fixed.push(child);
      }
      const rimMeshes: THREE.Mesh[] = [];
      let tyreMesh: THREE.Mesh | null = null;
      for (const child of w.spinner.children) {
        if (child instanceof THREE.Mesh) {
          child.renderOrder = RENDER_ORDER.KART;
          this.meshes.push(child);
          if (child.material !== tyreMat) rimMeshes.push(child);
          else tyreMesh = child;
        }
      }
      for (const m of fixed) this.meshes.push(m);
      // Wheels spin about local X, so X is the tyre width and Y/Z the diameter.
      const widthMul = build.wheelWidthScale[i];
      if (scaleMul !== 1 || widthMul !== 1) {
        w.spinner.scale.set(scaleMul * widthMul, scaleMul, scaleMul);
      }
      w.root.position.set(restX, 0, offsets[i].z);
      const hidden = build.singleFront && i === 1;
      w.root.visible = !hidden;
      this.tilt.add(w.root);
      this.wheels.push({
        root: w.root, spinner: w.spinner, socket, fixed, rim: rimMeshes, tyre: tyreMesh,
        radius: builtFrame.wheelRadius * scaleMul,
        restX, restZ: offsets[i].z,
        hubY: offsets[i].y,
        restLen: spec.tuning.suspensionRest,
        travel: spec.tuning.suspensionTravel,
        front, hidden,
      });
    }

    // --- consolidated cheap LODs -------------------------------------------
    // One buffer, one draw. LOD 1 keeps the turning wheels, LOD 2 keeps the
    // tyres, LOD 3 bakes the whole kart — driver and wheels — into the chassis.
    const wheelParts = (): ConsolidatePart[] => {
      const out: ConsolidatePart[] = [];
      for (let i = 0; i < this.wheels.length; i++) {
        const w = this.wheels[i];
        if (w.hidden) continue;
        const wb = i % 2 === 0 ? wheelAsset.left : wheelAsset.right;
        const mul = build.wheelScale[i];
        const wmul = build.wheelWidthScale[i];
        // Seeded suspension rest is 0.3 of travel — see KartManager.makeState.
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(w.restX, w.hubY - w.restLen + 0.3 * w.travel, w.restZ),
          new THREE.Quaternion(),
          new THREE.Vector3(mul * wmul, mul, mul),
        );
        // Tyre only: past 55 m a rim is a couple of pixels and the spokes cost
        // more triangles than the rest of the kart put together. Wheels with no
        // tyre at all (the hover pods) keep everything or they vanish.
        const tyreOnly = wb.tyreIndex >= 0;
        for (const g of wb.spin) {
          if (tyreOnly && g.slot !== 'rubber') continue;
          out.push({ slot: g.slot, geometry: g.geometry, matrix: m });
        }
      }
      return out;
    };
    const dkey = `${spec.bodyId}|${spec.driverId}|${tyre}`;
    const driverParts = (level: 'near' | 'mid'): ConsolidatePart[] => {
      if (!this.driverBuild || !this.driverRootMatrix) return [];
      const root = this.driverRootMatrix;
      return driverRestParts(this.driverBuild, level).map((p) => ({
        slot: p.slot,
        geometry: p.geometry,
        matrix: p.matrix ? root.clone().multiply(p.matrix) : root.clone(),
      }));
    };
    const steerParts = (): ConsolidatePart[] => {
      if (!build.steering) return [];
      const m = new THREE.Matrix4().compose(
        build.steering.pos.clone(),
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0), build.steering.tilt * (Math.PI / 180),
        ),
        new THREE.Vector3(1, 1, 1),
      );
      return [
        { slot: 'chrome' as MaterialSlot, geometry: build.steering.rim, matrix: m },
        { slot: 'plastic' as MaterialSlot, geometry: build.steering.core, matrix: m },
      ];
    };

    const mkMerged = (key: string, parts: () => ConsolidatePart[], tag: string): THREE.Mesh | null => {
      const geo = assets.mergedGeometry(key, () => consolidateParts(parts()));
      if (!geo) return null;
      const mesh = new THREE.Mesh(geo, this.mergedMat);
      mesh.name = `${spec.name}:${tag}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.renderOrder = RENDER_ORDER.KART;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scaled.add(mesh);
      this.meshes.push(mesh);
      return mesh;
    };

    const lod1 = mkMerged(`${dkey}|L1`, () => [
      ...build.mid.map((g) => ({ slot: g.slot, geometry: g.geometry })),
      ...steerParts(), ...driverParts('mid'),
    ], 'lod1');
    const lod2 = mkMerged(`${dkey}|L2`, () => [
      ...build.far.map((g) => ({ slot: g.slot, geometry: g.geometry })),
      ...driverParts('mid'),
    ], 'lod2');
    // Wheel placement is per-character, not per-chassis, so it goes in the key.
    let wsig = `${spec.tuning.suspensionRest.toFixed(3)}|${spec.tuning.suspensionTravel.toFixed(3)}`;
    for (const o of offsets) wsig += `|${o.x.toFixed(3)},${o.y.toFixed(3)},${o.z.toFixed(3)}`;
    const lod3 = mkMerged(`${dkey}|L3|${wsig}`, () => [
      ...build.far.map((g) => ({ slot: g.slot, geometry: g.geometry })),
      ...driverParts('mid'), ...wheelParts(),
    ], 'lod3');
    this.lodNodes = [lod0, lod1, lod2, lod3];

    // --- sockets -----------------------------------------------------------
    const sockets = {} as Record<SocketName, THREE.Object3D>;
    for (let i = 0; i < 4; i++) sockets[names[i]] = this.wheels[i].socket;
    const addSocket = (n: SocketName, v: THREE.Vector3 | undefined, fx: number, fy: number, fz: number) => {
      const o = new THREE.Object3D();
      o.name = `${spec.name}:${n}`;
      if (v) o.position.copy(v); else o.position.set(fx, fy, fz);
      this.scaled.add(o);
      sockets[n] = o;
    };
    const gy = builtFrame.groundY;
    addSocket('exhaustL', build.sockets.exhaustL, -0.22, gy + 0.34, builtFrame.rearZ + 0.28);
    addSocket('exhaustR', build.sockets.exhaustR, 0.22, gy + 0.34, builtFrame.rearZ + 0.28);
    addSocket('itemMount', build.sockets.itemMount, 0, gy + 0.62, builtFrame.rearZ + 0.10);
    addSocket('rearCentre', build.sockets.rearCentre, 0, gy + 0.30, builtFrame.rearZ + 0.24);
    if (driverRig) {
      sockets.driverHead = driverRig.headSocket;
    } else {
      addSocket('driverHead', undefined, 0, gy + 0.95, 0);
    }
    this.sockets = sockets;

    // --- contact shadow ----------------------------------------------------
    this.shadowMat = lib.createContactShadowMaterial();
    this.shadow = new THREE.Mesh(assets.shadowGeometry, this.shadowMat);
    this.shadow.name = `${spec.name}:contactShadow`;
    this.shadowW = (myFrame.trackHalfRear + builtFrame.wheelWidth * 0.75) * 2.55;
    this.shadowL = (Math.abs(myFrame.frontZ) + myFrame.rearZ + builtFrame.wheelRadius * 2) * 1.42;
    this.shadow.scale.set(this.shadowW, 1, this.shadowL);
    this.shadow.position.y = builtFrame.groundY * this.modelScale + 0.012;
    this.shadow.renderOrder = RENDER_ORDER.DECAL;
    this.shadow.castShadow = false;
    this.shadow.receiveShadow = false;
    this.shadow.matrixAutoUpdate = true;
    this.shadow.layers.enable(LAYERS.NO_REFLECT);
    this.ground.add(this.shadow);

    // --- triangle budget ---------------------------------------------------
    let tris = build.tris;
    tris += wheelAsset.right.tris * (build.singleFront ? 3 : 4);
    if (driverRig) tris += driverRig.build.tris;
    this.tris = tris;
  }

  // -------------------------------------------------------------------------
  //  Per-frame writes (called by KartManager)
  // -------------------------------------------------------------------------

  setLod(level: LodLevel): void {
    if (level === this.lod) return;
    // Fall back to the cheapest buffer this model actually built.
    let use = level;
    while (use > 0 && !this.lodNodes[use]) use--;
    this.lod = use;

    for (let i = 0; i < 4; i++) {
      const node = this.lodNodes[i];
      if (node) node.visible = i === use;
    }
    // The rig only exists at LOD 0; every cheaper buffer has the driver baked in.
    this.driver?.setLod(use === 0 ? 0 : 2);
    if (this.steering) this.steering.visible = use === 0;

    // LOD 0 keeps the calipers, LOD 1 keeps the rims, LOD 2 is tyres only, and
    // LOD 3 has the wheels baked into the chassis buffer so the nodes go away.
    const showWheels = use < 3;
    const showRim = use < 2;
    const showFixed = use === 0;
    for (const w of this.wheels) {
      w.root.visible = !w.hidden && showWheels;
      for (const m of w.fixed) m.visible = showFixed || !w.tyre;
      for (const m of w.rim) m.visible = showRim || !w.tyre;
    }
  }

  get lodLevel(): LodLevel { return this.lod; }

  /**
   * Suspension rise + steer + spin + load squash for one wheel.
   * `lift` raises the wheel above its spring position (inside-wheel drift lift).
   */
  writeWheel(
    i: number, compression: number, spin: number, steer: number,
    squash: number, lift: number,
  ): void {
    const w = this.wheels[i];
    if (w.hidden) return;
    w.root.position.y = w.hubY - w.restLen + compression * w.travel + lift;
    // `steerAngle > 0` means steering RIGHT; a positive rotation about +Y turns
    // a -Z-facing object left, so the sign flips here.
    w.root.rotation.y = w.front ? -steer : 0;
    w.spinner.rotation.x = -spin;
    // Tyres bulge and flatten under load — small, but the eye reads it.
    const sy = 1 - squash * 0.085;
    const sxz = 1 + squash * 0.055;
    w.root.scale.set(sxz, sy, sxz);
    w.socket.position.y = -w.radius * sy;
  }

  /** Non-uniform body scale for squash & stretch. Multiplies the model scale. */
  writeScale(x: number, y: number, z: number): void {
    const s = this.modelScale;
    this.scaled.scale.set(s * x, s * y, s * z);
  }

  /** Steering-wheel spin, radians of `steerAngle`. */
  writeSteering(steerAngle: number): void {
    if (this.steering) this.steering.rotation.z = -steerAngle * 2.6;
  }

  setBrakeLight(amount: number): void {
    if (this.lightRear) this.lightRear.emissiveIntensity = lerp(1.1, 6.0, clamp01(amount));
  }

  setHeadlight(amount: number): void {
    if (this.lightFront) this.lightFront.emissiveIntensity = lerp(1.6, 3.4, clamp01(amount));
  }

  /** Drift-charge / boost glow on the accent emissive. */
  setGlow(amount: number, color?: THREE.Color): void {
    if (!this.glowMat) return;
    this.glowMat.emissiveIntensity = lerp(1.5, 7.0, clamp01(amount));
    if (color) this.glowMat.emissive.copy(color);
  }

  /** Star power: rainbow emissive over the paint. `amount` 0..1. */
  setStar(amount: number, hue: number): void {
    for (let i = 0; i < this.paintMats.length; i++) {
      const m = this.paintMats[i];
      if (amount <= 0.001) {
        if (m.emissiveIntensity !== 0) {
          m.emissiveIntensity = 0;
          m.emissive.setRGB(0, 0, 0);
          m.color.copy(this.paintBase[i]);
        }
        continue;
      }
      m.emissive.setHSL((hue + i * 0.12) % 1, 0.95, 0.55);
      m.emissiveIntensity = amount * 1.7;
      m.color.copy(this.paintBase[i]).lerp(m.emissive, amount * 0.45);
    }
  }

  /**
   * Fade the whole kart (ghost item, respawn blink).
   *
   * `transparent` is not a cosmetic flag: it decides which of three's two render
   * lists every mesh of this kart lands in, and the transparent list is
   * depth-sorted per object and (with `depthWrite` off) draws without occluding
   * itself. The previous version derived `transparent` and `depthWrite` directly
   * from the instantaneous alpha, so the respawn/invulnerability blink — a 4 Hz
   * sine through the 0.995 and 0.6 thresholds — reshuffled the kart's own panels
   * roughly eight times a second and let the driver, seat and far bodywork show
   * through the near bodywork on alternate frames. That is half of the reported
   * "karts keep flickering and deforming", and it hits rivals as readily as the
   * player because every hazard hit grants invulnerability.
   *
   * So: the opaque/transparent decision carries hysteresis, `depthWrite` follows
   * that decision rather than the alpha, and `needsUpdate` is set only on a real
   * transition. The last part matters for correctness too — three bakes
   * `#define OPAQUE` (which forces output alpha to 1) into the program from
   * `material.transparent` at compile time and does not revisit it unless the
   * material version moves, so the old code's flag flips were silently ignored by
   * the shader half the time and the fade did not actually fade.
   */
  setOpacity(v: number): void {
    const next = clamp01(v);
    if (Math.abs(next - this.opacity) < 1e-3) return;
    this.opacity = next;
    // Enter transparency well below opaque, leave it only when essentially solid.
    const transparent = this.isTransparent ? next < 0.995 : next < 0.96;
    this.isTransparent = transparent;
    for (const m of this.meshes) {
      const mat = m.material;
      if (Array.isArray(mat)) continue;
      const glass = mat.name.startsWith('glass');
      const want = transparent || glass;
      if (mat.transparent !== want) {
        mat.transparent = want;
        // Required: `OPAQUE` is a compile-time define derived from this flag.
        mat.needsUpdate = true;
      }
      mat.opacity = glass ? Math.min(0.55, next) : next;
      // Depth-write stays ON for the bodywork at every alpha. A blinking kart is
      // a fading *solid*, not a ghost: with depth-write off its own panels stop
      // occluding each other and the seat and far bodywork punch through the
      // near bodywork, which is what read as the kart "deforming".
      const depthWrite = !glass;
      if (mat.depthWrite !== depthWrite) mat.depthWrite = depthWrite;
    }
  }

  /**
   * Place the shadow. `height` = distance from the kart origin down to the
   * ground; the blob grows and fades as the kart leaves the road.
   */
  writeShadow(height: number, strength: number): void {
    const h = Math.max(0, height);
    const spread = 1 + clamp01(h * 0.34) * 0.75;
    this.shadow.position.y = -h + 0.014;
    this.shadow.scale.set(this.shadowW * spread, 1, this.shadowL * spread);
    const fade = 1 / (1 + h * h * 0.55);
    this.shadowMat.opacity = 0.62 * fade * clamp01(strength);
    this.shadow.visible = this.shadowMat.opacity > 0.01;
  }

  setDriverPose(dt: number, pose: DriverPose): void {
    this.driver?.update(dt, pose);
  }

  /** Local-space Y of the ground plane when parked. */
  get restGroundY(): number { return this.frame.groundY * this.modelScale; }

  /**
   * This racer's face material, or `null` for a chassis with no driver rig.
   *
   * Exposed for the portrait studio, which borrows it for one offscreen frame
   * rather than building a second 1248×416 face atlas per portrait, and restores
   * its expression + blink row afterwards (`FaceMaterial.atlasState`).
   */
  get face(): FaceMaterial | null { return this.faceMat; }

  dispose(): void {
    this.driver?.dispose();
    this.root.removeFromParent();
    this.root.clear();
    this.meshes.length = 0;
    // Geometry + materials live in KartAssets / KartMaterialLibrary.
  }
}
