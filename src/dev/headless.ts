/**
 * ============================================================================
 *  FOXY KART — HEADLESS TRACK + PHYSICS BOOTSTRAP
 * ============================================================================
 *  Shared helpers for probes that run under `src/dev/node-run.mjs`. Nothing in
 *  here renders; everything returns the REAL subsystem so a measurement means
 *  something.
 *
 *  Import this from a probe. Never import `node-run.mjs` from a probe — it
 *  holds a pending top-level await and will deadlock the module graph.
 *
 *  QUALITY TIER: `low`. Only texture *resolution* follows the tier — the
 *  spline, the ring plan, the racing line, the boost pads, the item-box spawns
 *  and every `ITrackService` query are bit-identical across tiers (verified:
 *  1349 rings on `coastal` at both `low` and `medium`). `low` is used purely
 *  because procedural texture generation without a GPU-backed canvas costs
 *  ~57 s per circuit at `medium` and ~3.7 s at `low`.
 * ============================================================================
 */

import * as THREE from 'three';
import { Track } from '@/track/Track';
import { QUALITY_PRESETS } from '@/core/Config';
import { PhysicsWorld } from '@/physics/PhysicsWorld';
import { makeTuning, type CCClass } from '@/physics/Tuning';
import { DriftStage, SurfaceType, type FrameContext, type KartState } from '@/core/Types';

/**
 * Every circuit id, in menu order. These must match `TRACK_ORDER` in
 * `TrackDefs.ts` exactly: `getTrackDef()` silently falls back to the default
 * circuit for an unknown id, so a typo here does not throw — it quietly probes
 * Sunset Coastline three times and reports three identical, meaningless rows.
 */
export const TRACK_IDS = ['sunsetCoastline', 'neonMetropolis', 'volcanoRush'] as const;
export type TrackId = (typeof TRACK_IDS)[number];

// ---------------------------------------------------------------------------
//  Fake renderer — Track's constructor wants one; nothing draws
// ---------------------------------------------------------------------------

interface CanvasFactory {
  (w?: number, h?: number): unknown;
}

export function fakeRenderer(): THREE.WebGLRenderer {
  const mk = (globalThis as unknown as { __AK_MAKE_CANVAS__?: CanvasFactory }).__AK_MAKE_CANVAS__;
  const canvas = mk ? mk(1280, 720) : { width: 1280, height: 720 };
  const r = {
    capabilities: {
      getMaxAnisotropy: () => 16,
      isWebGL2: true,
      maxTextureSize: 8192,
      maxTextures: 16,
      precision: 'highp',
    },
    extensions: { get: () => null, has: () => false },
    domElement: canvas,
    outputColorSpace: 'srgb',
    toneMapping: 0,
    toneMappingExposure: 1,
    shadowMap: { enabled: false, type: 0 },
    info: { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } },
    getPixelRatio: () => 1,
    setPixelRatio: () => {},
    getSize: (v?: THREE.Vector2) => (v ? v.set(1280, 720) : { width: 1280, height: 720 }),
    setSize: () => {},
    setRenderTarget: () => {},
    render: () => {},
    clear: () => {},
    compile: () => {},
    initTexture: () => {},
    dispose: () => {},
  };
  return r as unknown as THREE.WebGLRenderer;
}

// ---------------------------------------------------------------------------
//  Track
// ---------------------------------------------------------------------------

let sharedScene: THREE.Scene | null = null;
let sharedTrack: Track | null = null;

/**
 * The real `Track` for a circuit id. One instance is reused and reloaded across
 * calls, exactly as the game does when you pick a different course.
 */
export async function loadTrack(id: TrackId | string): Promise<Track> {
  if (!sharedTrack) {
    sharedScene = new THREE.Scene();
    sharedTrack = new Track(sharedScene, fakeRenderer(), QUALITY_PRESETS.low);
  }
  await sharedTrack.loadTrack(id);
  return sharedTrack;
}

// ---------------------------------------------------------------------------
//  Karts
// ---------------------------------------------------------------------------

/** A blank `KartState`, matching what KartManager publishes. */
export function makeKartState(id: number, isPlayer = false): KartState {
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
    suspension: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    wheelGrounded: [false, false, false, false],
    grounded: false,
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

export interface Field {
  physics: PhysicsWorld;
  karts: KartState[];
}

/** `n` karts wired into a real `PhysicsWorld` on the given track. */
export function makeField(track: Track, n: number, cc: CCClass = 150, tuningId = 'nova'): Field {
  const physics = new PhysicsWorld(track);
  physics.setCC(cc);
  const karts: KartState[] = [];
  for (let i = 0; i < n; i++) karts.push(makeKartState(i, i === 0));
  physics.setKarts(karts);
  for (let i = 0; i < n; i++) physics.setTuning(i, makeTuning(tuningId, cc));
  physics.init();
  return { physics, karts };
}

// ---------------------------------------------------------------------------
//  Fixed-step driver
// ---------------------------------------------------------------------------

/** A mutable `FrameContext` for headless stepping. */
export function makeCtx(fixedDt: number): FrameContext & { elapsed: number; frame: number } {
  return { dt: fixedDt, fixedDt, elapsed: 0, frame: 0, alpha: 1 } as FrameContext & {
    elapsed: number;
    frame: number;
  };
}

/** Place a kart on the road at an arc length + lateral offset, facing forwards. */
export function placeOnTrack(
  physics: PhysicsWorld,
  track: Track,
  kartId: number,
  distance: number,
  lateral = 0,
  speed = 0,
  lift = 0.55,
): void {
  const s = track.sampleAtDistance(distance);
  const pos = new THREE.Vector3()
    .copy(s.position)
    .addScaledVector(s.binormal, lateral)
    .addScaledVector(s.normal, lift);
  const back = new THREE.Vector3().copy(s.tangent).multiplyScalar(-1);
  const q = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(s.binormal, s.normal, back),
  );
  physics.place(kartId, pos, q);
  if (speed !== 0) {
    const b = physics.getBody(kartId);
    if (b) {
      b.velocity.copy(b.forward).multiplyScalar(speed);
      b.forwardSpeed = speed;
    }
  }
}
