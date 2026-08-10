/**
 * ============================================================================
 *  CINEMATIC CAMERA — intro flyby, finish beauty pass, replay, menu idle
 * ============================================================================
 *  These cameras do not use the chase springs: they follow authored paths and
 *  write the pose straight into the shared `CameraRig`, estimating spring
 *  velocity by finite difference so that handing control back to the chase
 *  camera is continuous — no jerk on the frame the countdown starts.
 *
 *  Everything is procedural: Catmull-Rom paths derived from the actual track
 *  basis at the grid, so any track gets a competent intro for free.
 * ============================================================================
 */

import * as THREE from 'three';
import type { ITrackService, KartState, TrackSample } from '@/core/Types';
import { clamp, clamp01, damp, lerp, smootherstep, smoothstep } from '@/core/MathUtils';
import { CameraRig, type IKartRoster } from './CameraRig';

export type CinematicKind = 'none' | 'intro' | 'finish' | 'results' | 'menu' | 'replay';

/** The pose the chase camera would be holding right now. */
export interface ChasePose {
  readonly position: THREE.Vector3;
  readonly look: THREE.Vector3;
  readonly up: THREE.Vector3;
  fov: number;
}

export type ChasePoseProvider = (out: ChasePose) => void;

export const CINEMATIC_TUNING = {
  /** Total intro length in seconds; the last 7 % holds the final chase pose. */
  introSeconds: 6.2,
  introHoldFraction: 0.93,
  introFovKeys: [42, 37, 31, 48, 65] as const,
  finishOrbitSeconds: 2.8,
  finishHeroSeconds: 3.2,
  replayCameraCount: 10,
  replayLateralOffset: 9.0,
  replayHeight: 5.2,
  /** Metres of subject height the tracking zoom tries to keep framed. */
  replayFramedHeight: 6.4,
  replaySwitchDistance: 68,
  replayPassedDistance: 26,
  menuOrbitRate: 0.085,
} as const;

// module-level scratch
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _pose: ChasePose = {
  position: new THREE.Vector3(),
  look: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  fov: 65,
};

function fovAt(keys: readonly number[], u: number): number {
  const n = keys.length - 1;
  const x = clamp01(u) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return lerp(keys[i], keys[i + 1], smoothstep(x - i));
}

export class CinematicCamera {
  private camera: THREE.PerspectiveCamera;
  private karts: IKartRoster;
  private track: ITrackService;
  private rig: CameraRig;

  private kindValue: CinematicKind = 'none';
  private time = 0;
  private duration = 0;
  private subjectId = 0;
  private resolve: (() => void) | null = null;

  private poseProvider: ChasePoseProvider | null = null;
  private vfx: object | null = null;

  // --- authored paths ---
  private readonly pathPoints: THREE.Vector3[] = [];
  private readonly lookPoints: THREE.Vector3[] = [];
  private pathCurve: THREE.CatmullRomCurve3;
  private lookCurve: THREE.CatmullRomCurve3;

  // --- per-frame pose ---
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private fov = 65;
  private roll = 0;
  private hasPrev = false;

  // --- replay state ---
  private replayCams: THREE.Vector3[] = [];
  private replayLook = new THREE.Vector3();
  private replayIndex = -1;
  private replayHold = 0;
  private replayFov = 45;

  // --- menu / finish orbit state ---
  private orbitAngle = 0;
  private orbitRadius = 10;

  private trackOk = true;

  constructor(
    camera: THREE.PerspectiveCamera,
    karts: IKartRoster,
    track: ITrackService,
    rig: CameraRig,
  ) {
    this.camera = camera;
    this.karts = karts;
    this.track = track;
    this.rig = rig;

    for (let i = 0; i < 5; i++) {
      this.pathPoints.push(new THREE.Vector3());
      this.lookPoints.push(new THREE.Vector3());
    }
    this.pathCurve = new THREE.CatmullRomCurve3(this.pathPoints, false, 'centripetal', 0.5);
    this.lookCurve = new THREE.CatmullRomCurve3(this.lookPoints, false, 'centripetal', 0.5);
    this.trackOk = typeof track?.sampleAt === 'function' && typeof track?.project === 'function';
  }

  // -------------------------------------------------------------------------
  // wiring
  // -------------------------------------------------------------------------

  setPoseProvider(fn: ChasePoseProvider): void { this.poseProvider = fn; }
  setVfx(vfx: object | null): void { this.vfx = vfx; }

  get kind(): CinematicKind { return this.kindValue; }
  get active(): boolean { return this.kindValue !== 'none'; }
  get progress(): number { return this.duration > 0 ? clamp01(this.time / this.duration) : 0; }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private kartById(id: number): KartState | null {
    const list = this.karts?.karts;
    if (!list || list.length === 0) return null;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return list[0] ?? null;
  }

  private sampleFor(position: THREE.Vector3): TrackSample | null {
    if (!this.trackOk) return null;
    try {
      return this.track.project(position);
    } catch {
      this.trackOk = false;
      return null;
    }
  }

  /** Optional depth-of-field focus, if the VFX/post chain happens to expose it. */
  private focus(distance: number): void {
    const v = this.vfx as Record<string, unknown> | null;
    if (!v) return;
    const fn = v['setDofFocus'] ?? v['setFocusDistance'] ?? v['setFocus'];
    if (typeof fn === 'function') {
      try { (fn as (d: number) => void).call(v, distance); } catch { /* optional */ }
    }
  }

  private fillPose(): ChasePose {
    if (this.poseProvider) {
      try { this.poseProvider(_pose); } catch { /* fall through to defaults */ }
    }
    return _pose;
  }

  // -------------------------------------------------------------------------
  // INTRO — the player's first impression
  // -------------------------------------------------------------------------

  /**
   * Wide establishing shot → sweep to the grid → slow dolly past the karts on
   * the line → settle exactly into the chase pose as the countdown starts.
   */
  playIntro(kartId: number, seconds = CINEMATIC_TUNING.introSeconds): Promise<void> {
    this.finishPending();
    this.subjectId = kartId;
    this.kindValue = 'intro';
    this.time = 0;
    this.duration = Math.max(1.5, seconds);
    this.hasPrev = false;

    const kart = this.kartById(kartId);
    const anchor = _v0;
    if (kart) anchor.copy(kart.position);
    else anchor.set(0, 0, 0);

    // Prefer the pole slot for framing the grid; fall back to the subject.
    let grid = anchor;
    if (typeof this.track?.getStartPosition === 'function') {
      try {
        const s = this.track.getStartPosition(0);
        if (s?.position && isFinite(s.position.x)) grid = _v1.copy(s.position);
      } catch { /* optional */ }
    }

    const sample = this.sampleFor(grid);
    const tan = _v2.copy(sample ? sample.tangent : _fwd.set(0, 0, -1));
    const nrm = new THREE.Vector3(0, 1, 0);
    if (sample) nrm.copy(sample.normal);
    const bin = new THREE.Vector3().crossVectors(tan, nrm).normalize();
    if (bin.lengthSq() < 1e-5) bin.set(1, 0, 0);

    const pose = this.fillPose();
    const p = this.pathPoints;
    const l = this.lookPoints;

    // 1. Wide establishing — high, ahead and off to one side.
    p[0].copy(grid).addScaledVector(tan, 78).addScaledVector(nrm, 44).addScaledVector(bin, 30);
    // 2. Sweeping down toward the start line.
    p[1].copy(grid).addScaledVector(tan, 40).addScaledVector(nrm, 15).addScaledVector(bin, 16);
    // 3. Low, tight dolly across the front of the grid.
    p[2].copy(grid).addScaledVector(tan, 8.5).addScaledVector(nrm, 1.35).addScaledVector(bin, -9.5);
    // 4. Rising behind the field.
    p[3].copy(grid).addScaledVector(tan, -6.0).addScaledVector(nrm, 3.1).addScaledVector(bin, -5.0);
    // 5. Exactly the chase pose.
    p[4].copy(pose.position);

    l[0].copy(grid).addScaledVector(nrm, 1.4);
    l[1].copy(grid).addScaledVector(tan, 5).addScaledVector(nrm, 1.2);
    l[2].copy(grid).addScaledVector(tan, -1.5).addScaledVector(nrm, 0.85);
    l[3].copy(anchor).addScaledVector(nrm, 1.15);
    l[4].copy(pose.look);

    this.pathCurve.updateArcLengths();
    this.lookCurve.updateArcLengths();

    this.up.copy(nrm);
    this.fov = CINEMATIC_TUNING.introFovKeys[0];
    this.roll = 0;

    return new Promise<void>((res) => { this.resolve = res; });
  }

  private updateIntro(dt: number): void {
    const x = clamp01(this.time / this.duration);
    // Hold the last 7 % on the final pose so the countdown starts settled.
    const held = clamp01(x / CINEMATIC_TUNING.introHoldFraction);
    const u = smootherstep(held);

    this.pathCurve.getPointAt(u, this.pos);
    this.lookCurve.getPointAt(u, this.look);

    // A slow banked roll on the wide shots, unwinding to level by the handoff.
    const bank = Math.sin(u * Math.PI) * 0.05 * (1 - smoothstep((u - 0.6) / 0.4));
    this.roll = bank;

    this.fov = fovAt(CINEMATIC_TUNING.introFovKeys, u);

    // Rack focus: pull focus from the far grid onto the subject on the dolly.
    this.focus(this.pos.distanceTo(this.look));

    if (this.poseProvider) {
      // Track the live chase pose over the last third so a moving grid (or a
      // late camera-target change) still lands perfectly.
      const blend = smoothstep((u - 0.62) / 0.38);
      if (blend > 0) {
        const pose = this.fillPose();
        this.pos.lerp(pose.position, blend);
        this.look.lerp(pose.look, blend);
        this.up.lerp(pose.up, blend);
        this.fov = lerp(this.fov, pose.fov, blend);
        this.roll *= 1 - blend;
      }
    }
    void dt;
  }

  // -------------------------------------------------------------------------
  // FINISH — swing around the winner, then a hero shot
  // -------------------------------------------------------------------------

  playFinish(kartId: number): void {
    this.finishPending();
    this.subjectId = kartId;
    this.kindValue = 'finish';
    this.time = 0;
    this.duration = CINEMATIC_TUNING.finishOrbitSeconds + CINEMATIC_TUNING.finishHeroSeconds;
    this.hasPrev = false;

    const kart = this.kartById(kartId);
    if (kart) {
      _fwd.set(0, 0, -1).applyQuaternion(kart.quaternion);
      this.orbitAngle = Math.atan2(_fwd.x, _fwd.z) + Math.PI * 0.65;
      this.look.copy(kart.position);
    }
    this.orbitRadius = 7.6;
    this.fov = 52;
  }

  private updateFinish(dt: number): void {
    const kart = this.kartById(this.subjectId);
    const t = this.time;
    const orbitLen = CINEMATIC_TUNING.finishOrbitSeconds;

    const centre = _v0;
    if (kart) centre.copy(kart.position);
    else centre.copy(this.look);

    const sample = this.sampleFor(centre);
    const nrm = _v1.copy(sample ? sample.normal : this.up).normalize();

    if (t < orbitLen) {
      // Phase A: sweep around the nose as it crosses the line. Slow-motion is
      // sold by a wide, slow arc rather than by touching the clock.
      const k = t / orbitLen;
      this.orbitAngle += (0.95 - 0.45 * k) * dt;
      this.orbitRadius = lerp(7.6, 10.4, smoothstep(k));
      const height = lerp(2.0, 3.9, smoothstep(k));
      _v2.set(Math.sin(this.orbitAngle), 0, Math.cos(this.orbitAngle));
      this.pos.copy(centre).addScaledVector(_v2, this.orbitRadius).addScaledVector(nrm, height);
      this.fov = lerp(52, 42, smoothstep(k));
      this.roll = 0.03 * Math.sin(k * Math.PI);
    } else {
      // Phase B: low three-quarter hero shot, slow push in.
      const k = clamp01((t - orbitLen) / CINEMATIC_TUNING.finishHeroSeconds);
      if (kart) {
        _fwd.set(0, 0, -1).applyQuaternion(kart.quaternion);
      } else {
        _fwd.set(0, 0, -1);
      }
      const heroAngle = Math.atan2(_fwd.x, _fwd.z) + 0.55;
      _v2.set(Math.sin(heroAngle), 0, Math.cos(heroAngle));
      const dist = lerp(8.2, 5.4, smootherstep(k));
      this.pos.copy(centre).addScaledVector(_v2, dist).addScaledVector(nrm, lerp(2.3, 1.35, k));
      this.fov = lerp(42, 36, smootherstep(k));
      this.roll = damp(this.roll, 0, 0.25, dt);
    }

    // Framing sits slightly above the roofline, tracked with a touch of lag.
    _v2.copy(centre).addScaledVector(nrm, 1.15);
    this.look.lerp(_v2, 1 - Math.pow(2, -dt / 0.09));
    this.up.copy(nrm);
    this.focus(this.pos.distanceTo(this.look));
  }

  // -------------------------------------------------------------------------
  // RESULTS / MENU — slow idle orbit for a title background
  // -------------------------------------------------------------------------

  playResults(kartId: number): void {
    this.finishPending();
    this.subjectId = kartId;
    this.kindValue = 'results';
    this.time = 0;
    this.duration = Infinity;
    this.hasPrev = false;
    this.orbitRadius = 8.5;
    this.fov = 44;
  }

  startMenuIdle(kartId = 0): void {
    this.finishPending();
    this.subjectId = kartId;
    this.kindValue = 'menu';
    this.time = 0;
    this.duration = Infinity;
    this.hasPrev = false;
    this.orbitRadius = 11.5;
    this.fov = 40;
  }

  private updateOrbit(dt: number, menu: boolean): void {
    const kart = this.kartById(this.subjectId);
    const centre = _v0;
    if (kart) centre.copy(kart.position);
    else centre.set(0, 0, 0);

    const sample = this.sampleFor(centre);
    const nrm = _v1.copy(sample ? sample.normal : this.up).normalize();

    this.orbitAngle += CINEMATIC_TUNING.menuOrbitRate * (menu ? 1 : 1.25) * dt;
    // A slow "breath" on radius and height keeps a static grid alive.
    const breathe = Math.sin(this.time * 0.31);
    const radius = (menu ? 11.5 : 8.6) + breathe * (menu ? 1.6 : 0.9);
    const height = (menu ? 3.1 : 2.5) + Math.sin(this.time * 0.23 + 1.1) * 0.45;

    _v2.set(Math.sin(this.orbitAngle), 0, Math.cos(this.orbitAngle));
    this.pos.copy(centre).addScaledVector(_v2, radius).addScaledVector(nrm, height);
    _v2.copy(centre).addScaledVector(nrm, menu ? 1.0 : 1.15);
    this.look.lerp(_v2, 1 - Math.pow(2, -dt / 0.14));
    this.up.copy(nrm);
    this.fov = damp(this.fov, menu ? 40 : 44, 0.4, dt);
    this.roll = damp(this.roll, breathe * 0.012, 0.6, dt);
    this.focus(this.pos.distanceTo(this.look));
  }

  // -------------------------------------------------------------------------
  // REPLAY — trackside broadcast cameras handing off to each other
  // -------------------------------------------------------------------------

  startReplay(kartId: number): void {
    this.finishPending();
    this.subjectId = kartId;
    this.kindValue = 'replay';
    this.time = 0;
    this.duration = Infinity;
    this.hasPrev = false;
    this.replayIndex = -1;
    this.replayHold = 0;
    this.buildReplayCameras();
  }

  private buildReplayCameras(): void {
    if (this.replayCams.length > 0 || !this.trackOk) return;
    const n = CINEMATIC_TUNING.replayCameraCount;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      let s: TrackSample | null = null;
      try { s = this.track.sampleAt(t); } catch { this.trackOk = false; }
      const p = new THREE.Vector3();
      if (s) {
        // Alternate sides; sit just outside the barrier, raised like a TV tower.
        const side = i % 2 === 0 ? 1 : -1;
        const lateral = (s.halfWidth || 11) + CINEMATIC_TUNING.replayLateralOffset;
        p.copy(s.position)
          .addScaledVector(s.binormal, lateral * side)
          .addScaledVector(s.normal, CINEMATIC_TUNING.replayHeight + (i % 3) * 1.1);
      }
      this.replayCams.push(p);
    }
  }

  private updateReplay(dt: number): void {
    const kart = this.kartById(this.subjectId);
    if (!kart || this.replayCams.length === 0) { this.updateOrbit(dt, false); return; }

    const kp = kart.position;
    _fwd.set(0, 0, -1).applyQuaternion(kart.quaternion);

    // Keep the current camera until the subject has clearly gone past it, then
    // cut to the one it is approaching. Broadcast cameras never chase.
    this.replayHold += dt;
    let needSwitch = this.replayIndex < 0;
    if (!needSwitch) {
      const cur = this.replayCams[this.replayIndex];
      _v0.copy(kp).sub(cur);
      const dist = _v0.length();
      const passed = _v0.dot(_fwd) > 0 && dist > CINEMATIC_TUNING.replayPassedDistance;
      if (dist > CINEMATIC_TUNING.replaySwitchDistance || (passed && this.replayHold > 1.1)) {
        needSwitch = true;
      }
    }

    if (needSwitch) {
      let best = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < this.replayCams.length; i++) {
        if (i === this.replayIndex) continue;
        _v0.copy(this.replayCams[i]).sub(kp);
        const dist = _v0.length();
        if (dist < 8 || dist > 110) continue;
        _v0.normalize();
        // Prefer cameras the kart is driving toward, at a filmable distance.
        const approach = _v0.dot(_fwd);
        const score = approach * 2.2 - Math.abs(dist - 34) * 0.035;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0) {
        this.replayIndex = best;
        this.replayHold = 0;
        this.replayLook.copy(kp);
        this.pos.copy(this.replayCams[best]);
        this.hasPrev = false;
      } else if (this.replayIndex < 0) {
        this.replayIndex = 0;
        this.pos.copy(this.replayCams[0]);
      }
    }

    const cam = this.replayCams[this.replayIndex];
    this.pos.copy(cam);

    // Tracking lag: the operator is always a beat behind the car.
    this.replayLook.lerp(kp, 1 - Math.pow(2, -dt / 0.075));
    this.look.copy(this.replayLook);
    this.look.y += 0.9;

    // Tracking zoom — keep the kart roughly the same size in frame.
    const dist = Math.max(6, cam.distanceTo(kp));
    const wanted = 2 * Math.atan(CINEMATIC_TUNING.replayFramedHeight / dist) * (180 / Math.PI);
    this.replayFov = damp(this.replayFov, clamp(wanted, 20, 58), 0.16, dt);
    this.fov = this.replayFov;

    const sample = this.sampleFor(kp);
    if (sample) this.up.lerp(sample.normal, 1 - Math.pow(2, -dt / 0.3)).normalize();
    this.roll = damp(this.roll, 0, 0.3, dt);
    this.focus(dist);
  }

  // -------------------------------------------------------------------------
  // driving the rig
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (this.kindValue === 'none') return;
    const h = clamp(dt, 0, 1 / 15);
    this.time += h;

    _prev.copy(this.pos);

    switch (this.kindValue) {
      case 'intro': this.updateIntro(h); break;
      case 'finish': this.updateFinish(h); break;
      case 'results': this.updateOrbit(h, false); break;
      case 'menu': this.updateOrbit(h, true); break;
      case 'replay': this.updateReplay(h); break;
      default: break;
    }

    if (!isFinite(this.pos.x) || !isFinite(this.pos.y) || !isFinite(this.pos.z)) {
      this.pos.copy(_prev);
    }

    // Write straight into the rig, with finite-difference velocity so the
    // chase springs pick up exactly where the cinematic left off.
    const rig = this.rig;
    if (this.hasPrev && h > 1e-5) {
      rig.pos.velocity.copy(this.pos).sub(_prev).multiplyScalar(1 / h);
      if (rig.pos.velocity.lengthSq() > 40000) rig.pos.velocity.set(0, 0, 0);
    } else {
      rig.pos.velocity.set(0, 0, 0);
    }
    this.hasPrev = true;

    rig.pos.value.copy(this.pos);
    rig.look.value.copy(this.look);
    rig.look.velocity.set(0, 0, 0);
    rig.fov.snap(this.fov);
    rig.roll.snap(this.roll);
    rig.up.copy(this.up).normalize();
    rig.shake.update(h);
    rig.applyTo(this.camera);

    if (this.time >= this.duration) this.stop();
  }

  /** End the current cinematic (resolving any pending intro promise). */
  stop(): void {
    this.kindValue = 'none';
    this.duration = 0;
    this.time = 0;
    this.hasPrev = false;
    this.finishPending();
  }

  /** Alias used when a phase change cuts a cinematic short. */
  abort(): void { this.stop(); }

  private finishPending(): void {
    const r = this.resolve;
    this.resolve = null;
    if (r) r();
  }

  dispose(): void {
    this.finishPending();
    this.replayCams.length = 0;
  }
}
