/**
 * ============================================================================
 *  APEX KART — KART MANAGER
 * ============================================================================
 *  Owns the twelve racers: their `KartState` objects (the authoritative record
 *  every other subsystem reads), their visual rigs, and the animation layer
 *  that turns physics numbers into something with weight.
 *
 *  STRICT DIVISION OF LABOUR
 *  -------------------------
 *  `fixedUpdate` runs immediately after `PhysicsWorld.fixedUpdate` and does one
 *  thing: snapshot each kart's transform so `update` can interpolate between the
 *  last two physics ticks with `ctx.alpha`. Nothing else.
 *
 *  `update` is **visual only**. It reads `KartState` and writes meshes. It never
 *  writes a physics field — if you see an assignment to `state.something` in
 *  `update`, that is a bug.
 *
 *  THE ANIMATION, IN ORDER OF HOW MUCH IT MATTERS
 *  ----------------------------------------------
 *   1. **Contact shadow.** A kart without one floats. Ours is a decal on a
 *      ground-aligned node, exact height from the suspension when grounded and
 *      a real ground raycast when airborne, growing and fading with altitude.
 *   2. **Squash & stretch on a spring.** Landings are a damped harmonic
 *      oscillator with ζ≈0.47, so the kart compresses, overshoots into a
 *      stretch, and settles. A lerp cannot do this and it shows.
 *   3. **Body roll and pitch** layered on top of the physics attitude: up to 9°
 *      into a corner, 4° under throttle or brakes, both damped.
 *   4. **Drift**: extra chassis yaw out of the corner, a hard lean in, and the
 *      inside wheels lifted off the road.
 *   5. **Driver poses.** Torso leans, head tracks the apex, arms follow the
 *      steering, everything braces mid-drift and celebrates at the flag.
 *   6. Wheels: spin, steer, suspension rise, and a load-dependent squash.
 * ============================================================================
 */

import * as THREE from 'three';
import type {
  FrameContext, GroundHit, ISubsystem, KartState, KartTuning, QualitySettings,
} from '@/core/Types';
import { DriftStage, SurfaceType } from '@/core/Types';
import { RACE } from '@/core/Config';
import { bus } from '@/core/EventBus';
import { clamp, clamp01, damp, lerp } from '@/core/MathUtils';
import { makeTuning } from '@/physics/Tuning';
import {
  CHARACTERS, CHARACTER_BY_ID, DEFAULT_CHARACTER_ID, type CharacterDef,
} from './Characters';
import { KartMaterialLibrary, type FaceExpression, type PaintSpec } from './KartMaterials';
import { BODY_TYRE, KART_BODY_IDS, type KartBodyId } from './KartBodies';
import type { TyreId } from './Wheels';
import {
  KartAssets, KartModel, LOD_FAR_DISTANCE, LOD_MID_DISTANCE, LOD_WHEELS_DISTANCE,
  MID_RIVAL_COUNT, NEAR_RIVAL_COUNT, SOCKET_NAMES,
  type LodLevel, type SocketName,
} from './KartModel';
import { DRIVERS, NEUTRAL_POSE, faceSpecFor, type DriverPose } from './Driver';

export type { SocketName } from './KartModel';

// ---------------------------------------------------------------------------
// Loose dependency shapes — these subsystems are authored in parallel, so we
// depend on the *shape* of what we need and feature-detect everything.
// ---------------------------------------------------------------------------

export interface TrackLike {
  getStartPosition?(index: number): { position: THREE.Vector3; quaternion: THREE.Quaternion };
  raycastGround?(origin: THREE.Vector3, up: THREE.Vector3, maxDist: number): GroundHit;
}

export interface PhysicsLike {
  setTuning?(kartId: number, tuning: KartTuning): void;
  visualScaleOf?(kartId: number): number;
  visualShrinkOf?(kartId: number): number;
  slipAngleOf?(kartId: number): number;
  getBody?(kartId: number): { ctrlBrake?: number; ctrlAccel?: number } | undefined;
}

/** Anything with a world position; used only for LOD distance. */
interface HasPosition { position: THREE.Vector3 }

// ---------------------------------------------------------------------------
// Per-kart visual record
// ---------------------------------------------------------------------------

interface Visual {
  state: KartState;
  model: KartModel;
  character: CharacterDef;
  tuning: KartTuning;

  // --- render interpolation (written in fixedUpdate) ---
  prevPos: THREE.Vector3;
  curPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  curQuat: THREE.Quaternion;
  prevGround: THREE.Quaternion;
  curGround: THREE.Quaternion;
  prevSusp: [number, number, number, number];
  curSusp: [number, number, number, number];
  prevSpin: [number, number, number, number];
  curSpin: [number, number, number, number];
  prevSteer: number;
  curSteer: number;
  seeded: boolean;

  // --- damped visual extras ---
  roll: number;
  pitch: number;
  yaw: number;
  driftAmt: number;
  boostAmt: number;
  brake: number;
  glow: number;
  starHue: number;

  // --- squash & stretch spring ---
  sq: number;
  sqVel: number;

  // --- misc animation state ---
  lastSpeed: number;
  accelProxy: number;
  hopPrev: boolean;
  hitTimer: number;
  /** Seconds parked. Drives the driver's idle face once it passes the threshold. */
  idleTimer: number;
  pose: DriverPose;
  shadowHeight: number;
  lod: LodLevel;
  distance: number;
}

// Module-level scratch — nothing in the hot loop allocates.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _col = new THREE.Color();
const _order: number[] = [];

/** Landing spring: ω² and 2ζω. ζ ≈ 0.47 → one clean overshoot. */
const SQ_STIFFNESS = 265;
const SQ_DAMPING = 15.0;

const MAX_EXTRA_ROLL = 9 * (Math.PI / 180);
const MAX_EXTRA_PITCH = 4 * (Math.PI / 180);
const MAX_DRIFT_YAW = 8 * (Math.PI / 180);

// ---------------------------------------------------------------------------

export class KartManager implements ISubsystem {
  /** Authoritative racer list. Index 0 is always the player. */
  readonly karts: KartState[] = [];

  readonly assets: KartAssets;
  readonly materials: KartMaterialLibrary;

  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private track: TrackLike;
  private physics: PhysicsLike;
  private quality: QualitySettings;

  private visuals: Visual[] = [];
  private byId = new Map<number, Visual>();
  private group: THREE.Group;
  private ready = false;

  private vfx: object | null = null;
  private audio: object | null = null;
  /** LOD reference. Falls back to the player kart when no camera is wired. */
  private lodRef: HasPosition | null = null;

  private playerCharacterId = DEFAULT_CHARACTER_ID;
  /**
   * Chassis override for the player, from the kart-select screen. `null` means
   * "whatever chassis the chosen character rides", which is the roster default.
   */
  private playerBodyId: KartBodyId | null = null;
  private offs: Array<() => void> = [];

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    track: TrackLike,
    physics: PhysicsLike,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.track = track;
    this.physics = physics;
    this.quality = quality;

    this.materials = new KartMaterialLibrary(quality);
    this.assets = new KartAssets(quality, this.materials);

    this.group = new THREE.Group();
    this.group.name = 'karts';
    this.scene.add(this.group);
  }

  // -------------------------------------------------------------------------
  //  Lifecycle
  // -------------------------------------------------------------------------

  /** Idempotent — Game awaits this, then `Engine.initAll()` may call it again. */
  async init(): Promise<void> {
    if (this.ready) return;

    const count = Math.max(1, RACE ? 12 : 12);
    const roster = this.buildRoster(count);

    for (let i = 0; i < count; i++) {
      const character = roster[i];
      const state = this.makeState(i, i === 0);
      this.karts.push(state);
      const v = this.createVisual(state, character, i);
      this.visuals.push(v);
      this.byId.set(i, v);
      // Yield occasionally so the loading bar can paint between AO bakes.
      // `setTimeout` rather than rAF: rAF never fires in a background tab and
      // init must never be able to hang.
      if (i % 3 === 2) await new Promise<void>((r) => setTimeout(r, 0));
    }

    this.placeOnGrid();
    this.hookEvents();
    this.ready = true;
  }

  /** Twelve entries from the eight-strong roster; duplicates get new paint. */
  private buildRoster(count: number): CharacterDef[] {
    const player = CHARACTER_BY_ID[this.playerCharacterId] ?? CHARACTERS[0];
    const rest = CHARACTERS.filter((c) => c.id !== player.id);
    const out: CharacterDef[] = [player];
    for (let i = 0; out.length < count; i++) out.push(rest[i % rest.length]);
    return out;
  }

  private makeState(id: number, isPlayer: boolean): KartState {
    return {
      id,
      isPlayer,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      groundQuaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      speed: 0,
      speedRatio: 0,
      angularVelocity: 0,
      steerAngle: 0,
      suspension: [0.3, 0.3, 0.3, 0.3],
      wheelSpin: [0, 0, 0, 0],
      wheelGrounded: [true, true, true, true],
      grounded: true,
      airTime: 0,
      surface: SurfaceType.Road,
      drifting: false,
      driftStage: DriftStage.None,
      driftDirection: 0,
      driftCharge: 0,
      boostTime: 0,
      boostStrength: 0,
      hopping: false,
      stunned: false,
      stunTime: 0,
      invulnerable: false,
      starTime: 0,
      gliding: false,
      antiGravity: false,
      lap: 0,
      progress: 0,
      racePosition: id + 1,
      finished: false,
      finishTime: 0,
      lapTimes: [],
      rpm: 0,
      heldItem: null,
      itemCount: 0,
    };
  }

  /** Paint spec for a racer, hue-shifted for duplicate characters. */
  private paintFor(character: CharacterDef, variant: number): PaintSpec {
    const primary = _col.set(character.color);
    if (variant > 0) {
      const hsl = { h: 0, s: 0, l: 0 };
      primary.getHSL(hsl);
      primary.setHSL((hsl.h + variant * 0.13) % 1, clamp01(hsl.s * 0.94), clamp01(hsl.l * 1.02));
    }
    const driver = DRIVERS[character.driverId];
    return {
      color: primary.getHex(),
      secondary: character.secondaryColor,
      glow: character.glowColor,
      // The suit is the DRIVER's, not the kart's. Sharing them makes the racer
      // dissolve into their own bodywork at any distance.
      cloth: driver.suit,
      clothAlt: driver.suitAlt,
      skin: driver.skinColor,
      flake: character.flake,
      matte: character.matte,
      // Pelt tones for the animal drivers. Deliberately NOT hue-shifted for
      // duplicate racers: repainting a kart is a livery, repainting a fox is a
      // different animal. Only `color` varies between variants.
      fur: driver.fur ?? driver.skinColor,
      furAlt: driver.furAlt,
      furDark: driver.furDark,
      knit: driver.knitwear === true,
    };
  }

  private createVisual(state: KartState, character: CharacterDef, index: number): Visual {
    const tuning = makeTuning(character.id);
    this.physics.setTuning?.(state.id, tuning);

    // How many earlier karts already used this character — drives the repaint.
    let variant = 0;
    for (const v of this.visuals) if (v.character.id === character.id) variant++;

    const paint = this.paintFor(character, variant);
    const face = faceSpecFor(character.driverId);
    // Index 0 is the player, and only the player can override the chassis.
    const chassis = index === 0 ? this.playerChassis(character) : {
      bodyId: character.bodyId, tyreId: character.tyreId,
    };
    const spec = {
      bodyId: chassis.bodyId,
      tyreId: chassis.tyreId,
      driverId: character.driverId,
      tuning,
      paintKey: `${character.id}#${variant}`,
      paint,
      faceSpec: face,
      name: `kart${index}:${character.id}`,
    };
    const model = new KartModel(this.assets, spec);
    this.group.add(model.root);

    return {
      state, model, character, tuning,
      prevPos: new THREE.Vector3(),
      curPos: new THREE.Vector3(),
      prevQuat: new THREE.Quaternion(),
      curQuat: new THREE.Quaternion(),
      prevGround: new THREE.Quaternion(),
      curGround: new THREE.Quaternion(),
      prevSusp: [0.3, 0.3, 0.3, 0.3],
      curSusp: [0.3, 0.3, 0.3, 0.3],
      prevSpin: [0, 0, 0, 0],
      curSpin: [0, 0, 0, 0],
      prevSteer: 0,
      curSteer: 0,
      seeded: false,
      roll: 0, pitch: 0, yaw: 0,
      driftAmt: 0, boostAmt: 0, brake: 0, glow: 0,
      starHue: (index * 0.137) % 1,
      sq: 0, sqVel: 0,
      lastSpeed: 0, accelProxy: 0,
      hopPrev: false, hitTimer: 0, idleTimer: 0,
      pose: { ...NEUTRAL_POSE },
      shadowHeight: -model.restGroundY,
      lod: 0,
      distance: 0,
    };
  }

  /** Grid placement. Uses the track's grid when it publishes one. */
  private placeOnGrid(): void {
    const get = this.track?.getStartPosition;
    for (let i = 0; i < this.visuals.length; i++) {
      const v = this.visuals[i];
      let placed = false;
      if (typeof get === 'function') {
        try {
          const p = get.call(this.track, i);
          if (p && p.position) {
            v.state.position.copy(p.position);
            if (p.quaternion) {
              v.state.quaternion.copy(p.quaternion);
              v.state.groundQuaternion.copy(p.quaternion);
            }
            placed = true;
          }
        } catch {
          placed = false;
        }
      }
      if (!placed) {
        // Fallback: two staggered columns marching backwards along +Z.
        const col = i % 2 === 0 ? -1 : 1;
        const row = Math.floor(i / 2);
        v.state.position.set(
          col * RACE.gridStagger,
          -this.visuals[i].model.restGroundY,
          row * RACE.gridSpacing,
        );
        v.state.quaternion.identity();
        v.state.groundQuaternion.identity();
      }
      v.prevPos.copy(v.state.position);
      v.curPos.copy(v.state.position);
      v.prevQuat.copy(v.state.quaternion);
      v.curQuat.copy(v.state.quaternion);
      v.prevGround.copy(v.state.groundQuaternion);
      v.curGround.copy(v.state.groundQuaternion);
      v.seeded = true;
      v.model.root.position.copy(v.state.position);
      v.model.body.quaternion.copy(v.state.quaternion);
      v.model.ground.quaternion.copy(v.state.groundQuaternion);
    }
  }

  // -------------------------------------------------------------------------
  //  Event hooks — one-shot animation triggers
  // -------------------------------------------------------------------------

  private hookEvents(): void {
    this.offs.push(bus.on('kart:land', (e) => {
      const v = this.byId.get(e.kartId);
      if (!v) return;
      // Compress proportional to closing speed; the spring does the rest.
      v.sqVel += clamp(e.impact * 0.055, 0, 1.4);
    }));
    this.offs.push(bus.on('kart:hop', (e) => {
      const v = this.byId.get(e.kartId);
      if (!v) return;
      // Anticipation crouch, then the spring pops it into a stretch.
      v.sqVel += 0.85;
    }));
    this.offs.push(bus.on('kart:boost', (e) => {
      const v = this.byId.get(e.kartId);
      if (!v) return;
      v.sqVel -= 0.55;
    }));
    this.offs.push(bus.on('kart:squash', (e) => {
      const v = this.byId.get(e.kartId);
      if (!v) return;
      v.sqVel += 2.6;
      v.hitTimer = 1.5;
    }));
    this.offs.push(bus.on('kart:spinout', (e) => {
      const v = this.byId.get(e.kartId);
      if (v) v.hitTimer = 1.5;
    }));
    this.offs.push(bus.on('kart:wallHit', (e) => {
      const v = this.byId.get(e.kartId);
      if (!v) return;
      v.sqVel += clamp(e.impact * 0.03, 0, 0.7);
      if (e.impact > 8) v.hitTimer = Math.max(v.hitTimer, 0.7);
    }));
    this.offs.push(bus.on('item:hit', (e) => {
      const v = this.byId.get(e.targetId);
      if (v) v.hitTimer = 1.6;
    }));
    this.offs.push(bus.on('kart:respawn', (e) => {
      const v = this.byId.get(e.kartId);
      if (!v) return;
      v.sq = 0; v.sqVel = 0; v.hitTimer = 0;
      v.roll = 0; v.pitch = 0; v.yaw = 0;
    }));
  }

  // -------------------------------------------------------------------------
  //  Fixed step — snapshot only
  // -------------------------------------------------------------------------

  fixedUpdate(_ctx: FrameContext): void {
    for (let i = 0; i < this.visuals.length; i++) {
      const v = this.visuals[i];
      const st = v.state;
      v.prevPos.copy(v.curPos);
      v.curPos.copy(st.position);
      v.prevQuat.copy(v.curQuat);
      v.curQuat.copy(st.quaternion);
      v.prevGround.copy(v.curGround);
      v.curGround.copy(st.groundQuaternion);
      v.prevSteer = v.curSteer;
      v.curSteer = st.steerAngle;
      for (let w = 0; w < 4; w++) {
        v.prevSusp[w] = v.curSusp[w];
        v.curSusp[w] = st.suspension[w];
        v.prevSpin[w] = v.curSpin[w];
        v.curSpin[w] = st.wheelSpin[w];
      }
    }
  }

  // -------------------------------------------------------------------------
  //  Variable step — everything visual
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    if (!this.ready) return;
    const dt = ctx.dt;
    const a = clamp01(ctx.alpha);

    this.assignLods();

    for (let i = 0; i < this.visuals.length; i++) {
      this.animate(this.visuals[i], dt, a, ctx.elapsed);
    }
  }

  /**
   * The player is the only kart that earns the hero model. Rivals are ranked by
   * camera distance and get progressively cheaper buffers, and distance can only
   * ever make a kart *cheaper* than its rank allows.
   *
   * The cap is deliberately rank-based rather than purely distance-based: on the
   * starting grid all twelve karts are within thirty metres of each other, and a
   * pure distance rule would put every one of them on the expensive path at
   * exactly the moment the frame is already at its busiest. With this rule the
   * subsystem's worst case is ~91 draw calls no matter how the pack bunches.
   */
  private assignLods(): void {
    const ref = this.lodRef ?? this.visuals[0]?.state;
    if (!ref) return;
    _order.length = 0;
    for (let i = 0; i < this.visuals.length; i++) {
      const v = this.visuals[i];
      v.distance = v.state.position.distanceTo(ref.position);
      _order.push(i);
    }
    _order.sort((x, y) => this.visuals[x].distance - this.visuals[y].distance);

    let rivalRank = 0;
    for (let i = 0; i < _order.length; i++) {
      const v = this.visuals[_order[i]];
      let lod: LodLevel;
      if (v.state.isPlayer) {
        lod = 0;
      } else {
        rivalRank++;
        lod = rivalRank <= NEAR_RIVAL_COUNT ? 1
          : rivalRank <= MID_RIVAL_COUNT ? 2 : 3;
        if (v.distance > LOD_FAR_DISTANCE) lod = 3;
        else if (v.distance > LOD_MID_DISTANCE && lod < 2) lod = 2;
        // Never freeze the wheels of a kart you can still see turning.
        if (lod === 3 && v.distance < LOD_WHEELS_DISTANCE) lod = 2;
      }
      v.lod = lod;
      v.model.setLod(lod);
    }
  }

  private animate(v: Visual, dt: number, a: number, elapsed: number): void {
    const st = v.state;
    const m = v.model;

    // --- 1. render-interpolated transform ---------------------------------
    m.root.position.lerpVectors(v.prevPos, v.curPos, a);
    m.body.quaternion.slerpQuaternions(v.prevQuat, v.curQuat, a);
    m.ground.quaternion.slerpQuaternions(v.prevGround, v.curGround, a);

    // --- 2. smoothed drivers ----------------------------------------------
    const driftTarget = st.drifting ? 1 : 0;
    v.driftAmt = damp(v.driftAmt, driftTarget, 0.075, dt);
    const boostTarget = st.boostTime > 0 ? 1 : 0;
    v.boostAmt = damp(v.boostAmt, boostTarget, 0.085, dt);

    // Acceleration proxy from the change in forward speed.
    if (dt > 1e-5) {
      const raw = (st.speed - v.lastSpeed) / dt;
      v.accelProxy = damp(v.accelProxy, clamp(raw, -60, 60), 0.10, dt);
    }
    v.lastSpeed = st.speed;

    // --- 3. body roll / pitch / drift yaw ---------------------------------
    // angularVelocity is + for LEFT, so a right-hand corner gives a positive
    // lateral term and therefore a lean to the right — into the corner.
    const lateral = -st.angularVelocity * st.speed;
    let rollTarget = clamp(lateral * 0.0063, -MAX_EXTRA_ROLL, MAX_EXTRA_ROLL);
    rollTarget += st.driftDirection * v.driftAmt * (5 * Math.PI / 180);
    if (!st.grounded) rollTarget *= 0.45;
    v.roll = damp(v.roll, rollTarget, 0.09, dt);

    const pitchTarget = clamp(v.accelProxy * 0.0028, -MAX_EXTRA_PITCH, MAX_EXTRA_PITCH);
    v.pitch = damp(v.pitch, pitchTarget, 0.11, dt);

    const yawTarget = -st.driftDirection * v.driftAmt * MAX_DRIFT_YAW;
    v.yaw = damp(v.yaw, yawTarget, 0.10, dt);

    // rotation.z is + = lean LEFT, so the roll sign flips here.
    m.tilt.rotation.set(v.pitch, v.yaw, -v.roll);

    // --- 4. squash & stretch (damped spring, never a lerp) ----------------
    const acc = -SQ_STIFFNESS * v.sq - SQ_DAMPING * v.sqVel;
    v.sqVel += acc * dt;
    v.sq += v.sqVel * dt;
    if (Math.abs(v.sq) < 1e-4 && Math.abs(v.sqVel) < 1e-3) { v.sq = 0; v.sqVel = 0; }
    const q = clamp(v.sq, -0.22, 0.30);

    const stretch = v.boostAmt;
    const shrink = this.physics.visualShrinkOf?.(st.id) ?? 1;
    const flatten = this.physics.visualScaleOf?.(st.id) ?? 1;
    m.writeScale(
      (1 + q * 0.50) * (1 - stretch * 0.030) * shrink,
      (1 - q) * (1 - stretch * 0.030) * shrink * flatten,
      (1 + q * 0.42) * (1 + stretch * 0.060) * shrink,
    );

    // --- 5. wheels ---------------------------------------------------------
    const steer = lerp(v.prevSteer, v.curSteer, a);
    const insideLift = v.driftAmt * 0.030;
    for (let w = 0; w < 4; w++) {
      const comp = lerp(v.prevSusp[w], v.curSusp[w], a);
      let spin = lerp(v.prevSpin[w], v.curSpin[w], a);
      spin = spin % (Math.PI * 2);
      const load = clamp01((comp - 0.28) * 1.55);
      const wv = m.wheels[w];
      const inside = st.driftDirection !== 0 && Math.sign(wv.restX) === st.driftDirection;
      m.writeWheel(w, comp, spin, steer, load, inside ? insideLift : 0);
    }
    m.writeSteering(steer);

    // --- 6. lights + emissive ---------------------------------------------
    const body = this.physics.getBody?.(st.id);
    const brakeInput = body && typeof body.ctrlBrake === 'number'
      ? body.ctrlBrake
      : (v.accelProxy < -8 ? 1 : 0);
    v.brake = damp(v.brake, clamp01(brakeInput), 0.045, dt);
    m.setBrakeLight(v.brake);
    m.setHeadlight(0.4 + v.boostAmt * 0.6);

    const glowTarget = Math.max(
      st.drifting ? 0.25 + st.driftCharge * 0.75 : 0,
      v.boostAmt,
      st.driftStage >= DriftStage.Blue ? 0.8 : 0,
    );
    v.glow = damp(v.glow, glowTarget, 0.05, dt);
    if (st.drifting && st.driftStage >= DriftStage.Blue) {
      const stage = st.driftStage;
      _col.setHex(stage === DriftStage.Blue ? 0x4fc3ff
        : stage === DriftStage.Orange ? 0xffa032 : 0xc45cff);
      m.setGlow(v.glow, _col);
    } else {
      m.setGlow(v.glow, _col.set(v.character.glowColor));
    }

    // Star power: rainbow sweep over the paint.
    const star = clamp01(st.starTime > 0 ? Math.min(1, st.starTime * 4) : 0);
    if (star > 0.001 || v.starHue !== -1) {
      v.starHue = (v.starHue + dt * 1.6) % 1;
      m.setStar(star, v.starHue);
    }

    // --- 7. driver pose ----------------------------------------------------
    // Only the hero model has a rig to pose; every cheaper LOD has the driver
    // baked into its chassis buffer in the rest pose.
    if (v.lod === 0) {
      v.hitTimer = Math.max(0, v.hitTimer - dt);
      const p = v.pose;
      p.steer = clamp(steer / 0.5, -1, 1);
      p.lean = clamp(lateral * 0.055, -1, 1) + st.driftDirection * v.driftAmt * 0.45;
      p.pitch = clamp(v.accelProxy * 0.035, -1, 1);
      p.brace = v.driftAmt;
      p.cheer = st.finished ? 1 : 0;
      p.slump = st.stunned || v.hitTimer > 0.6 ? 1 : 0;
      p.look = clamp(steer * 1.9 + st.driftDirection * v.driftAmt * 0.5, -0.9, 0.9);
      p.air = st.grounded ? 0 : clamp01(st.airTime * 2.4);
      p.bob = clamp01(0.25 + st.rpm * 0.55 - clamp01(st.speedRatio) * 0.35);
      m.setDriverPose(dt, p);

      // Parked long enough to look bored. This is what `thoughtful` / `sleepy`
      // exist for: a fox that stares into space on the grid and a capybara that
      // dozes off is most of what sells them as characters, and it costs one
      // timer plus a UV offset.
      const still = Math.abs(st.speed) < 0.5 && !st.stunned && st.boostTime <= 0;
      v.idleTimer = still ? v.idleTimer + dt : 0;

      let expr: FaceExpression = 'neutral';
      if (st.finished) expr = 'happy';
      else if (v.hitTimer > 0) expr = 'hit';
      else if (st.drifting || st.boostTime > 0 || st.speedRatio > 0.82) expr = 'determined';
      else if (v.idleTimer > 1.6) expr = DRIVERS[v.character.driverId].face.idle ?? 'neutral';
      m.driver?.setExpression(expr);
    }

    // --- 8. contact shadow -------------------------------------------------
    let height: number;
    if (st.grounded) {
      // Exact: the lowest wheel point is the ground.
      const wv = m.wheels[0];
      const comp = (st.suspension[0] + st.suspension[1] + st.suspension[2] + st.suspension[3]) * 0.25;
      height = -(wv.hubY - wv.restLen + comp * wv.travel - wv.radius) * m.modelScale;
      v.shadowHeight = damp(v.shadowHeight, height, 0.03, dt);
    } else if (v.lod < 2 && typeof this.track?.raycastGround === 'function') {
      _up.set(0, 1, 0).applyQuaternion(m.ground.quaternion);
      _v1.copy(m.root.position).addScaledVector(_up, 0.4);
      let hit: GroundHit | null = null;
      try {
        hit = this.track.raycastGround(_v1, _up, 40);
      } catch {
        hit = null;
      }
      height = hit && hit.hit ? hit.distance - 0.4 : v.shadowHeight + Math.abs(st.speed) * 0 + 0.6;
      v.shadowHeight = damp(v.shadowHeight, Math.max(0, height), 0.05, dt);
    } else {
      v.shadowHeight = damp(v.shadowHeight, v.shadowHeight + 0.4, 0.2, dt);
    }
    m.writeShadow(v.shadowHeight, st.grounded ? 1 : 0.85);

    // Respawn / invulnerability blink.
    if (st.invulnerable && !st.finished) {
      const blink = 0.55 + 0.45 * Math.sin(elapsed * 26);
      m.setOpacity(clamp(blink, 0.25, 1));
    } else {
      // `setOpacity` short-circuits when nothing changed, so this is free.
      m.setOpacity(1);
    }
  }

  // -------------------------------------------------------------------------
  //  Public API
  // -------------------------------------------------------------------------

  get player(): KartState {
    return this.karts[0];
  }

  getModel(kartId: number): THREE.Object3D {
    const v = this.byId.get(kartId);
    return v ? v.model.root : this.group;
  }

  /** The `KartModel` behind a racer — for the dev harness and integration. */
  modelOf(kartId: number): KartModel | null {
    return this.byId.get(kartId)?.model ?? null;
  }

  getSocket(kartId: number, name: SocketName): THREE.Object3D {
    const v = this.byId.get(kartId);
    if (!v) return this.group;
    return v.model.sockets[name] ?? v.model.root;
  }

  /** Display name, used by the HUD position board. */
  getName(kartId: number): string {
    return this.byId.get(kartId)?.character.name ?? `Racer ${kartId + 1}`;
  }

  /** CSS colour for HUD swatches and minimap dots. */
  getColorHex(kartId: number): string {
    const v = this.byId.get(kartId);
    if (!v) return '#ffffff';
    return `#${_col.set(v.model.mats.paint instanceof THREE.MeshPhysicalMaterial
      ? v.model.mats.paint.color
      : v.character.color).getHexString()}`;
  }

  characterOf(kartId: number): CharacterDef | null {
    return this.byId.get(kartId)?.character ?? null;
  }

  tuningOf(kartId: number): KartTuning | null {
    return this.byId.get(kartId)?.tuning ?? null;
  }

  /** Total near-LOD triangles for one racer — reported by the debug HUD. */
  trianglesOf(kartId: number): number {
    return this.byId.get(kartId)?.model.tris ?? 0;
  }

  /**
   * The chassis the player actually races: the kart-select override when one has
   * been chosen, otherwise the character's own. An overridden chassis brings its
   * natural tyre family with it (`BODY_TYRE`) — a cruiser on slicks reads as a
   * bug, and the roster pairs body and tyre deliberately.
   */
  private playerChassis(character: CharacterDef): { bodyId: KartBodyId; tyreId: TyreId } {
    const bodyId = this.playerBodyId ?? (character.bodyId as KartBodyId);
    if (this.playerBodyId === null) {
      return { bodyId, tyreId: character.tyreId as TyreId };
    }
    return { bodyId, tyreId: BODY_TYRE[bodyId] as TyreId };
  }

  /** Swap the player's character. Safe to call mid-session. */
  setPlayerCharacter(id: string): void {
    const character = CHARACTER_BY_ID[id];
    if (!character) return;
    const changed = this.playerCharacterId !== id;
    this.playerCharacterId = id;
    if (!this.ready || !changed) return;
    this.rebuildPlayer();
  }

  /**
   * Swap the player's chassis, from the kart-select screen.
   *
   * `RaceDirector` has always called this (`callOpt(this.roster,
   * 'setPlayerKart', opts.kartId)`) but **nothing implemented it**, so every
   * kart-body selection was silently dropped by `callOpt` and the player always
   * raced their character's default chassis. Same family as the three mechanics
   * that shipped dead — see HANDOFF.md.
   *
   * Passing an unknown id is a no-op rather than a throw, matching
   * `setPlayerCharacter`: this arrives from a menu and must never take the race
   * down. Pass `null` to go back to the character's own chassis.
   */
  setPlayerKart(id: string | null): void {
    const next = id === null ? null
      : (KART_BODY_IDS as readonly string[]).includes(id) ? (id as KartBodyId)
        : undefined;
    if (next === undefined) return; // unknown chassis — leave the current one alone
    const changed = this.playerBodyId !== next;
    this.playerBodyId = next;
    if (!this.ready || !changed) return;
    this.rebuildPlayer();
  }

  /**
   * Rebuild kart 0's model in place. Shared by `setPlayerCharacter` and
   * `setPlayerKart` so the two cannot drift apart — the chassis, the tyres, the
   * driver and the paint all have to be resolved together, and doing that twice
   * is how you end up with a fox on a cruiser wearing the wrong livery.
   */
  private rebuildPlayer(): void {
    const character = CHARACTER_BY_ID[this.playerCharacterId] ?? CHARACTERS[0];
    const v = this.visuals[0];
    if (!v) return;

    const old = v.model;
    const tuning = makeTuning(character.id);
    this.physics.setTuning?.(v.state.id, tuning);
    const paint = this.paintFor(character, 0);
    const face = faceSpecFor(character.driverId);
    const chassis = this.playerChassis(character);
    const model = new KartModel(this.assets, {
      bodyId: chassis.bodyId,
      tyreId: chassis.tyreId,
      driverId: character.driverId,
      tuning,
      paintKey: `${character.id}#p`,
      paint,
      faceSpec: face,
      name: `kart0:${character.id}`,
    });
    this.group.add(model.root);
    old.dispose();
    v.character = character;
    v.tuning = tuning;
    (v as { model: KartModel }).model = model;
    model.root.position.copy(v.state.position);
    model.body.quaternion.copy(v.state.quaternion);
    model.ground.quaternion.copy(v.state.groundQuaternion);
  }

  // --- late wiring ---------------------------------------------------------

  setVfx(vfx: object): void { this.vfx = vfx; }
  setAudio(audio: object): void { this.audio = audio; }
  /** Optional: gives LOD a real camera instead of the player's kart. */
  setCamera(camera: HasPosition): void { this.lodRef = camera; }

  get vfxRef(): object | null { return this.vfx; }
  get audioRef(): object | null { return this.audio; }

  /** Cache statistics for the debug overlay. */
  stats(): { karts: number; tris: number; assets: ReturnType<KartAssets['stats']> } {
    let tris = 0;
    for (const v of this.visuals) tris += v.model.tris;
    return { karts: this.visuals.length, tris, assets: this.assets.stats() };
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const v of this.visuals) v.model.dispose();
    this.visuals.length = 0;
    this.byId.clear();
    this.karts.length = 0;
    this.group.removeFromParent();
    this.assets.dispose();
    this.ready = false;
    void this.renderer;
  }
}
