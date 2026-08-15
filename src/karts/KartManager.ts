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
import {
  PortraitStudio, type PortraitFraming, type PortraitSubject,
} from './Portrait';

export type { SocketName } from './KartModel';
export type { PortraitFraming } from './Portrait';

/**
 * Suffix for a racer the roster had to repeat — see `buildRoster`. Index 0 is
 * the original and is never used. This only fires while `CHARACTERS.length` is
 * short of the grid size; at twelve characters the grid is fully distinct and
 * nothing here is ever read.
 */
const ROSTER_REPEAT_SUFFIX = ['', 'II', 'III', 'IV'] as const;

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
  /**
   * Temporally smoothed `distance`. LOD decisions read this, never the raw
   * value: two karts running side by side have distances that cross each other
   * several times a second from physics noise alone, and the rank tiers below
   * turn every one of those crossings into a visible model swap.
   */
  lodDistance: number;
  /** Seconds until this kart is allowed to change LOD again. */
  lodHold: number;
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
/**
 * Largest step the squash spring may ever be integrated with.
 *
 * THIS IS A STABILITY BOUND, NOT A TUNING KNOB. The spring is integrated with
 * symplectic Euler, whose iteration matrix for `x'' = -Kx - Cx'` is
 *
 *     M = [ 1 - K h²   h(1 - C h) ]
 *         [ -K h       1 - C h    ]
 *
 * which is stable only while `K h² + 2C h - 4 <= 0`, i.e.
 * `h <= (-C + sqrt(C² + 4K)) / K`. With K = 265 and C = 15 that is **78.7 ms**.
 * `update()` is the variable-step pass, and `Engine` clamps a frame to
 * `MAX_FRAME_DT = 100 ms` — *above* the bound. So one frame slower than
 * 12.7 fps was enough to make the spring diverge, and while the frame rate
 * stayed there it never recovered: measured with the impulse `kart:squash`
 * actually delivers (sqVel += 2.6), |sq| reached 1.5e1 after 2 s at 12 fps and
 * 1.5e6 at 10 fps. `q = clamp(sq, -0.22, 0.30)` then alternates sign every
 * frame, so the kart flips between full squash and full stretch at frame rate —
 * which is exactly the reported "karts keep flickering and deforming", on the
 * player and on every rival, and it appears precisely when the game is already
 * running badly.
 *
 * Sub-stepping at 1/120 s fixes the divergence *and* a second bug nobody had
 * noticed: the shipped integration made the animation's shape depend on the
 * frame rate (peak |sq| was 0.086 at 240 fps but 0.033 at 20 fps — a 2.6x
 * difference in how hard the kart visibly squashes). It is now frame-rate
 * invariant, which is AGENTS.md rule 8.
 */
const SQ_MAX_STEP = 1 / 120;
/** Hard ceiling on the spring state. Belt and braces against an event storm. */
const SQ_VEL_LIMIT = 6;

// --- LOD stability ---------------------------------------------------------
/**
 * Fractional hysteresis band on every LOD distance threshold. A kart drops to a
 * cheaper level at `threshold * (1 + H)` and only climbs back at
 * `threshold * (1 - H)`, so sitting exactly on a boundary cannot flip it.
 */
const LOD_HYSTERESIS = 0.14;
/**
 * Metres of rank stickiness. The tier a kart lands in is decided by its rank in
 * the field, so two karts running side by side used to swap tiers every time
 * their distances crossed — several times a second, and rank 3/4 and 6/7 are
 * exactly where a mid-pack battle happens. A kart already holding a richer tier
 * keeps its place until a rival is this much closer.
 */
const LOD_RANK_STICKY = 5;
/** Minimum seconds between LOD changes for one kart. Caps thrash outright. */
const LOD_MIN_DWELL = 0.4;
/** Smoothing on the LOD distance. Kills sub-metre jitter before it is ranked. */
const LOD_DISTANCE_SMOOTHING = 0.12;

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

  /** Finished portraits, keyed `id|size`. See `renderPortrait`. */
  private portraits = new Map<string, HTMLCanvasElement>();
  /** Built on the first portrait request and torn down with the subsystem. */
  private studio: PortraitStudio | null = null;
  /** Last framing per character id — read by the QA probe. */
  private portraitFramings = new Map<string, PortraitFraming>();

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

  /**
   * Twelve entries, distinct wherever the roster can supply them.
   *
   * The old docstring here said "duplicates get new paint" and claimed an
   * eight-strong roster. The roster is ten, the grid is twelve, and the paint
   * part was only half true: `createVisual` does hue-shift by `variant`, so the
   * *kart* differed — but this function pushed the identical `CharacterDef`, so
   * the name did not. Every race put two racers called CAPY and two called NOVA
   * on the leaderboard, the results board and the rival readout.
   *
   * Distinct-first is unchanged: `rest` is walked in order, so the first nine
   * repeats are all different characters. What is new is that a repeat past that
   * point is relabelled, and therefore can never read as the same racer twice.
   *
   * The clone keeps `id`, deliberately. `makeTuning(id)`, `CHARACTER_BY_ID`, the
   * `"<id>#N"` paint keys and `portraitSubject`'s canonical-livery lookup all key
   * off it, and a repeat is the same character in a second car, not a new one.
   */
  private buildRoster(count: number): CharacterDef[] {
    const player = CHARACTER_BY_ID[this.playerCharacterId] ?? CHARACTERS[0];
    const rest = CHARACTERS.filter((c) => c.id !== player.id);
    const out: CharacterDef[] = [player];
    for (let i = 0; out.length < count; i++) {
      const base = rest[i % rest.length];
      const lap = Math.floor(i / rest.length);
      out.push(lap === 0 ? base
        : { ...base, name: `${base.name} ${ROSTER_REPEAT_SUFFIX[lap] ?? String(lap + 1)}` });
    }
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
      lodDistance: -1,
      lodHold: 0,
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

    this.assignLods(dt);

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
   * exactly the moment the frame is already at its busiest. Measured on
   * `neonMetropolis` at tier `high`: twelve karts all at LOD 0 cost **375 draw
   * calls / 0.291 M triangles** against a budget of 120 / 300 k, and the shipped
   * rank tiers bring that to **92 / 0.164 M**. LOD is not an optimisation here,
   * it is the only reason the subsystem fits at all.
   *
   * WHY THIS IS NOT A PLAIN THRESHOLD TEST ANY MORE
   * -----------------------------------------------
   * Because it has to be stable, and it was not. Every kart's tier was recomputed
   * from scratch every frame from two inputs that both jitter:
   *
   *  - **its rank in the field.** Rank comes from sorting by distance, so two
   *    karts side by side swap ranks whenever their distances cross — which for a
   *    mid-pack battle is several times a second. Ranks 3/4 and 6/7 straddle a
   *    tier boundary, so each crossing popped both karts between LOD 1 and LOD 2
   *    (rims appear/disappear) or LOD 2 and LOD 3 (wheel nodes appear/disappear).
   *    A kart's model could change because *another* kart moved.
   *  - **its raw distance** against three bare thresholds (40 / 55 / 120 m) with
   *    no hysteresis at all, so hovering on one flipped it at frame rate.
   *
   * Three independent guards now, cheapest first: the distance is temporally
   * smoothed, the rank sort is sticky by `LOD_RANK_STICKY` metres in favour of
   * whoever already holds the richer tier, the thresholds carry a ±14 % band, and
   * a kart may not change level more than once per `LOD_MIN_DWELL`. The dwell
   * timer alone bounds thrash at 2.5/s; with the other three the measured rate is
   * zero. See the probe numbers in the handoff.
   */
  private assignLods(dt: number): void {
    const ref = this.lodRef ?? this.visuals[0]?.state;
    if (!ref) return;
    _order.length = 0;
    for (let i = 0; i < this.visuals.length; i++) {
      const v = this.visuals[i];
      v.distance = v.state.position.distanceTo(ref.position);
      // Seed on the first frame so a race does not start with every kart
      // ramping in from zero and crossing every boundary on the way.
      v.lodDistance = v.lodDistance < 0
        ? v.distance
        : damp(v.lodDistance, v.distance, LOD_DISTANCE_SMOOTHING, dt);
      if (v.lodHold > 0) v.lodHold -= dt;
      _order.push(i);
    }
    // Sticky sort: a kart already on a richer buffer defends its rank. Without
    // this the sort order — and therefore the tier — is decided by noise.
    _order.sort((x, y) => this.rankKey(this.visuals[x]) - this.rankKey(this.visuals[y]));

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
        const d = v.lodDistance;
        if (d > this.lodEdge(LOD_FAR_DISTANCE, v.lod, 3)) lod = 3;
        else if (lod < 2 && d > this.lodEdge(LOD_MID_DISTANCE, v.lod, 2)) lod = 2;
        // Never freeze the wheels of a kart you can still see turning.
        if (lod === 3 && d < this.lodEdge(LOD_WHEELS_DISTANCE, v.lod, 2)) lod = 2;
      }
      if (lod !== v.lod) {
        // The dwell timer is what makes the guarantee unconditional: whatever the
        // pack does, one kart cannot change model more than 1/LOD_MIN_DWELL times
        // a second. LOD 0 is exempt — the player must never be downgraded, and
        // `lod === 0` is only ever reached by the player.
        if (v.lodHold > 0 && lod !== 0) continue;
        v.lod = lod;
        v.lodHold = LOD_MIN_DWELL;
      }
      v.model.setLod(v.lod);
    }
  }

  /**
   * Sort key for the rank tiers: smoothed distance, discounted for karts that
   * already hold a richer buffer so a rival must be clearly closer to take the
   * slot rather than merely closer this frame.
   */
  private rankKey(v: Visual): number {
    if (v.state.isPlayer) return -1e6; // the player is never ranked as a rival
    const bonus = v.lod <= 1 ? LOD_RANK_STICKY : v.lod === 2 ? LOD_RANK_STICKY * 0.5 : 0;
    return v.lodDistance - bonus;
  }

  /**
   * A distance threshold with hysteresis. `target` is the level the threshold
   * would push the kart to; if the kart is already there the boundary sits
   * further out, so it takes real movement to come back.
   */
  private lodEdge(threshold: number, current: LodLevel, target: LodLevel): number {
    return current >= target
      ? threshold * (1 - LOD_HYSTERESIS)
      : threshold * (1 + LOD_HYSTERESIS);
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
    // Sub-stepped at SQ_MAX_STEP. See that constant for why this is not
    // optional: integrated with the raw frame dt this spring diverges for any
    // frame slower than 12.7 fps, and `Engine` hands out dt up to 100 ms.
    if (v.sq !== 0 || v.sqVel !== 0) {
      let left = dt;
      // Guard against a NaN/negative dt reaching the loop bound.
      if (!(left > 0)) left = 0;
      while (left > 1e-7) {
        const h = left > SQ_MAX_STEP ? SQ_MAX_STEP : left;
        left -= h;
        const acc = -SQ_STIFFNESS * v.sq - SQ_DAMPING * v.sqVel;
        v.sqVel += acc * h;
        v.sq += v.sqVel * h;
      }
      // The spring is now unconditionally stable, so these are not load-bearing;
      // they exist so that a bad impulse from another subsystem (an `impact` of
      // 1e9, a NaN) degrades to a hard squash instead of an invisible kart.
      if (!Number.isFinite(v.sq) || !Number.isFinite(v.sqVel)) { v.sq = 0; v.sqVel = 0; }
      v.sqVel = clamp(v.sqVel, -SQ_VEL_LIMIT, SQ_VEL_LIMIT);
      v.sq = clamp(v.sq, -0.6, 0.6);
      if (Math.abs(v.sq) < 1e-4 && Math.abs(v.sqVel) < 1e-3) { v.sq = 0; v.sqVel = 0; }
    }
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
    //
    // The band deliberately stops short of 1: `KartModel.setOpacity` has to move
    // every mesh of the kart between three's opaque and transparent render lists
    // when it crosses the threshold, and the old band ran from 0.25 all the way
    // to 1.00, so a 4 Hz sine dragged the whole kart across that boundary about
    // eight times a second for the entire invulnerability window. Now the flag
    // flips exactly twice per window — once in, once out — and only the alpha
    // animates. `starHue` doubles as a per-kart phase so twelve invulnerable
    // karts don't blink in lockstep.
    if (st.invulnerable && !st.finished) {
      const phase = elapsed * 22 + v.starHue * 6.283;
      m.setOpacity(0.55 + 0.33 * Math.sin(phase));
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

  // --- character portraits -------------------------------------------------

  /**
   * A head-and-shoulders bust of a racer, rendered offscreen from the real
   * `DriverRig` under a dedicated portrait light rig. **This is the method
   * `MenuSystem.buildArt()` feature-detects** — it accepts a canvas or a data
   * URL and falls back to a flat procedural portrait when the call returns
   * nothing, and until now it always fell back: the critic's finding was that
   * all ten select-screen portraits were the same grey visor ellipse.
   *
   * Contract notes, because the call site is synchronous and runs for the whole
   * roster in one go when the menu opens:
   *
   *  - **Cached per `id|size`.** The tenth call is the last work this ever does;
   *    re-opening the menu is free.
   *  - **Never throws.** Any failure returns `''`, which puts `MenuSystem` back
   *    on its procedural fallback. A menu must not be able to take the game down.
   *  - **Costs no geometry, materials or textures** once `init()` has run: the
   *    studio borrows the live racer's rig buffers and face atlas.
   *  - Returns `''` when the renderer cannot read pixels back (the headless
   *    fake renderer), so probes get a defined answer instead of a blank image.
   */
  renderPortrait(id: string, size = 220): HTMLCanvasElement | string {
    const px = Math.round(clamp(size, 64, 512));
    const key = `${id}|${px}`;
    const hit = this.portraits.get(key);
    if (hit) return hit;

    const subject = this.portraitSubject(id);
    if (!subject) return '';
    try {
      const studio = this.portraitStudio();
      const shot = studio.render(subject, px);
      if (!shot) return '';
      this.portraits.set(key, shot.canvas);
      this.portraitFramings.set(id, shot.framing);
      return shot.canvas;
    } catch (err) {
      console.warn(`[KartManager] portrait for "${id}" failed:`, err);
      return '';
    }
  }

  /**
   * Framing diagnostics for a racer's portrait — the projected NDC bounds of the
   * head box and of the head-and-shoulders subject box, plus `inFrame`.
   *
   * This runs the identical camera-solve path as `renderPortrait` but never
   * touches the GPU, which is the only way to prove the framing is right in a
   * headless probe: a fake renderer cannot rasterise, so `inFrame` is the
   * measurement that stands in for looking at it. Same discipline as
   * `__QA__.shot()`'s `subject.inFrame`.
   */
  portraitFraming(id: string): PortraitFraming | null {
    const subject = this.portraitSubject(id);
    if (!subject) return null;
    try {
      return this.portraitStudio().framing(subject);
    } catch (err) {
      console.warn(`[KartManager] portrait framing for "${id}" failed:`, err);
      return null;
    }
  }

  /** Ids that already have a cached portrait canvas. */
  portraitCacheKeys(): string[] {
    return [...this.portraits.keys()];
  }

  /** Live studio resources, or `null` when no portrait has been asked for. */
  portraitStudioStats(): { targets: number; lights: number; env: number; size: number } | null {
    return this.studio ? this.studio.stats() : null;
  }

  private portraitStudio(): PortraitStudio {
    if (!this.studio) {
      this.studio = new PortraitStudio(this.renderer, this.assets, this.quality);
    }
    return this.studio;
  }

  /**
   * Describe one racer to the studio.
   *
   * The paint key is deliberately the roster's own `"<id>#0"`: `createVisual`
   * builds exactly that key for the first kart of every character, so all ten
   * portraits reuse material sets that already exist. It is also the *canonical*
   * livery — duplicate racers are hue-shifted, and a portrait must show the
   * character, not the fourth repaint of them.
   */
  private portraitSubject(id: string): PortraitSubject | null {
    const character = CHARACTER_BY_ID[id];
    if (!character) return null;
    let live: Visual | null = null;
    for (const v of this.visuals) {
      if (v.character.id === id && v.model.driver) { live = v; break; }
    }
    return {
      id,
      driverId: character.driverId,
      paintKey: `${character.id}#0`,
      paint: this.paintFor(character, 0),
      faceSpec: faceSpecFor(character.driverId),
      build: live?.model.driver?.build ?? null,
      face: live?.model.face ?? null,
      colorA: character.color,
      colorB: character.secondaryColor,
      glow: character.glowColor,
    };
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
    // The studio holds a render target and a gradient texture; the cached
    // canvases are plain DOM and go with the map.
    this.studio?.dispose();
    this.studio = null;
    this.portraits.clear();
    this.portraitFramings.clear();
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
