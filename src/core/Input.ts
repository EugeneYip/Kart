import type { InputState, ISubsystem, FrameContext } from './Types';
import { clamp, damp, moveTowards } from './MathUtils';

/**
 * Unified keyboard + gamepad + touch input.
 *
 * Steering is deliberately *not* raw: keyboard steer ramps in over ~120 ms and
 * releases in ~80 ms, which is what makes digital input feel analog. Gamepad
 * sticks pass through a radial dead-zone and a mild expo curve.
 */

const KEY_MAP: Record<string, keyof RawState> = {
  ArrowUp: 'accel', KeyW: 'accel',
  ArrowDown: 'brake', KeyS: 'brake',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'drift', ShiftLeft: 'drift', ShiftRight: 'drift',
  KeyE: 'item', ControlLeft: 'item', KeyF: 'item',
  KeyQ: 'lookBack',
  Enter: 'start', Escape: 'start',
};

interface RawState {
  accel: boolean; brake: boolean; left: boolean; right: boolean;
  drift: boolean; item: boolean; lookBack: boolean; start: boolean;
}

export class Input implements ISubsystem {
  readonly state: InputState = {
    steer: 0, accel: 0, brake: 0,
    drift: false, driftPressed: false,
    item: false, itemPressed: false,
    lookBack: false, startPressed: false,
    usingGamepad: false,
  };

  private raw: RawState = {
    accel: false, brake: false, left: false, right: false,
    drift: false, item: false, lookBack: false, start: false,
  };
  private prevDrift = false;
  private prevItem = false;
  private prevStart = false;

  private padIndex: number | null = null;
  private lastPadActivity = -999;

  /** Touch: analog steer from a virtual stick, 0 when unused. */
  private touchSteer = 0;
  private touchAccel = 0;
  private touchActive = false;

  private el: HTMLElement;
  private bound = false;

  constructor(el: HTMLElement) { this.el = el; }

  init(): void {
    if (this.bound) return;
    this.bound = true;
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.onGamepad);
    window.addEventListener('gamepaddisconnected', this.onGamepadOut);
    this.el.addEventListener('pointerdown', this.onPointerDown);
    this.el.addEventListener('pointermove', this.onPointerMove);
    this.el.addEventListener('pointerup', this.onPointerUp);
    this.el.addEventListener('pointercancel', this.onPointerUp);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const k = KEY_MAP[e.code];
    if (k) { this.raw[k] = true; this.state.usingGamepad = false; e.preventDefault(); }
  };
  private onKeyUp = (e: KeyboardEvent) => {
    const k = KEY_MAP[e.code];
    if (k) { this.raw[k] = false; e.preventDefault(); }
  };
  private onBlur = () => {
    for (const k of Object.keys(this.raw) as (keyof RawState)[]) this.raw[k] = false;
    this.touchActive = false; this.touchSteer = 0; this.touchAccel = 0;
  };
  private onGamepad = (e: GamepadEvent) => { this.padIndex = e.gamepad.index; };
  private onGamepadOut = () => { this.padIndex = null; };

  // --- touch: left half = steering pad, right half = accel/drift ---
  private touchOrigin = { x: 0, y: 0, id: -1 };
  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    if (e.clientX < window.innerWidth * 0.5) {
      this.touchOrigin = { x: e.clientX, y: e.clientY, id: e.pointerId };
      this.touchActive = true;
    } else {
      this.touchAccel = 1;
      if (e.clientY > window.innerHeight * 0.6) this.raw.drift = true;
    }
  };
  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== this.touchOrigin.id || !this.touchActive) return;
    const dx = e.clientX - this.touchOrigin.x;
    this.touchSteer = clamp(dx / 70, -1, 1);
  };
  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === this.touchOrigin.id) {
      this.touchActive = false; this.touchSteer = 0; this.touchOrigin.id = -1;
    } else {
      this.touchAccel = 0; this.raw.drift = false;
    }
  };

  /** Radial dead-zone + expo — the standard console feel. */
  private static curve(v: number, dead = 0.14, expo = 0.35): number {
    const a = Math.abs(v);
    if (a < dead) return 0;
    const n = (a - dead) / (1 - dead);
    const shaped = n * (1 - expo) + n * n * n * expo;
    return Math.sign(v) * clamp(shaped, 0, 1);
  }

  update(ctx: FrameContext): void {
    const s = this.state;

    // --- gamepad poll ---
    let padSteer = 0, padAccel = 0, padBrake = 0;
    let padDrift = false, padItem = false, padLook = false, padStart = false;
    const pads = navigator.getGamepads?.() ?? [];
    const pad = this.padIndex !== null ? pads[this.padIndex] : pads.find((p) => p) ?? null;
    if (pad) {
      padSteer = Input.curve(pad.axes[0] ?? 0);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      padAccel = Math.max(rt, pad.buttons[0]?.pressed ? 1 : 0);
      padBrake = Math.max(lt, pad.buttons[1]?.pressed ? 1 : 0);
      padDrift = !!(pad.buttons[5]?.pressed || pad.buttons[4]?.pressed);
      padItem = !!(pad.buttons[2]?.pressed || pad.buttons[3]?.pressed);
      padLook = !!pad.buttons[11]?.pressed;
      padStart = !!pad.buttons[9]?.pressed;
      const active = Math.abs(padSteer) > 0.02 || padAccel > 0.02 || padDrift || padItem;
      if (active) { this.lastPadActivity = ctx.elapsed; s.usingGamepad = true; }
    }
    if (ctx.elapsed - this.lastPadActivity > 2) s.usingGamepad = s.usingGamepad && !!pad && false;

    // --- steering: blend the three sources, then smooth ---
    const keyTarget = (this.raw.right ? 1 : 0) - (this.raw.left ? 1 : 0);
    let target = keyTarget;
    if (Math.abs(padSteer) > Math.abs(target)) target = padSteer;
    if (Math.abs(this.touchSteer) > Math.abs(target)) target = this.touchSteer;

    // Ramping in feels heavier than snapping back — that asymmetry reads as weight.
    //
    // These are deliberately FAST, because they are no longer the authority on
    // steering feel: `KartPhysics` owns a rate limiter on the fixed 120 Hz step.
    // This loop runs at *display* rate, so a slow ramp here was quantised four
    // times more coarsely at 30 fps than at 120 fps, and it double-filtered
    // already-analog gamepad input. Keeping it light makes it an anti-step
    // smoother and leaves the deterministic physics limiter as the single
    // authority at any frame rate.
    const towardZero = Math.abs(target) < Math.abs(s.steer);
    const rate = towardZero ? 20.0 : 14.0;
    s.steer = moveTowards(s.steer, target, rate * ctx.dt);
    if (Math.abs(s.steer) < 0.002) s.steer = 0;

    // --- pedals ---
    const accelTarget = Math.max(this.raw.accel ? 1 : 0, padAccel, this.touchAccel);
    const brakeTarget = Math.max(this.raw.brake ? 1 : 0, padBrake);
    s.accel = damp(s.accel, accelTarget, 0.022, ctx.dt);
    s.brake = damp(s.brake, brakeTarget, 0.018, ctx.dt);
    if (s.accel > 0.995) s.accel = 1;
    if (s.accel < 0.005) s.accel = 0;

    // --- buttons + rising edges ---
    const drift = this.raw.drift || padDrift;
    const item = this.raw.item || padItem;
    const start = this.raw.start || padStart;

    s.driftPressed = drift && !this.prevDrift;
    s.itemPressed = item && !this.prevItem;
    s.startPressed = start && !this.prevStart;
    s.drift = drift;
    s.item = item;
    s.lookBack = this.raw.lookBack || padLook;

    this.prevDrift = drift;
    this.prevItem = item;
    this.prevStart = start;
  }

  /** Consume the edge flags — call after all readers have run. */
  endFrame(): void {
    this.state.driftPressed = false;
    this.state.itemPressed = false;
    this.state.startPressed = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.onGamepad);
    window.removeEventListener('gamepaddisconnected', this.onGamepadOut);
    this.bound = false;
  }
}
