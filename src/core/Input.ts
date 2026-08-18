import type { InputState, ISubsystem, FrameContext } from './Types';
import { clamp, damp, moveTowards } from './MathUtils';

/**
 * Unified keyboard + gamepad + on-screen (touch) input.
 *
 * Steering is deliberately *not* raw: keyboard steer ramps in over ~120 ms and
 * releases in ~80 ms, which is what makes digital input feel analog. Gamepad
 * sticks pass through a radial dead-zone and a mild expo curve.
 */

// ===========================================================================
// The virtual (on-screen) controller — third device, same contract
// ===========================================================================
//
// WHY THIS IS A MODULE-LEVEL OBJECT AND NOT A METHOD ON `Input`
// The other two devices are already global: the keyboard is read off `window`
// and the pad off `navigator`. `Input` itself is constructed inside `Game`
// (`new Input(engine.canvas)`) and is never handed to the UI, so a UI module
// that wants to *be* a device has nowhere to plug in. Publishing the device
// state here — written by `src/ui/TouchControls`, read by `update()` below the
// same way the pad is polled — keeps the wiring at zero and keeps this file the
// single input surface it claims to be.
//
// Everything here is an ABSOLUTE request in the same units as `InputState`, so
// the blend in `update()` is "loudest source wins". A device that is not in use
// is all-zero/false and therefore cannot subtract from one that is — which is
// exactly why adding it leaves keyboard and gamepad behaviour bit-identical.
//
// NOTE ON `accel`: on touch this is normally held at 1 by the control layer
// (auto-accelerate — see the header of `TouchControls`). The physics only
// reverses when `accel < 0.15` (`KartPhysics`, "Reverse out of a wall"), so the
// brake control MUST drop `accel` to 0 as well as raising `brake`. That rule
// lives with the control layer because it is a control-scheme decision, not a
// physics one; it is called out here because this object is where the two meet.
export interface VirtualController {
  /** -1 (full left) .. +1 (full right). Already analog; smoothed with the rest. */
  steer: number;
  /** 0..1 throttle. */
  accel: number;
  /** 0..1 brake — becomes reverse at a standstill, but only while accel is low. */
  brake: number;
  drift: boolean;
  item: boolean;
  lookBack: boolean;
  /** Menu confirm / start. Edge-detected exactly like the keyboard's. */
  start: boolean;
}

export const virtualController: VirtualController = {
  steer: 0, accel: 0, brake: 0,
  drift: false, item: false, lookBack: false, start: false,
};

/**
 * Zero every virtual axis and button.
 *
 * Called on window blur and by the control layer whenever it hides itself, so a
 * button that was held at the moment the layer went away cannot leave the kart
 * driving itself. Anything that stops showing a control must call this.
 */
export function resetVirtualController(): void {
  const v = virtualController;
  v.steer = 0; v.accel = 0; v.brake = 0;
  v.drift = false; v.item = false; v.lookBack = false; v.start = false;
}

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
    // Long-press on the canvas must not raise the OS text/callout menu mid-race.
    this.el.addEventListener('contextmenu', this.onContextMenu);
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
    resetVirtualController();
  };
  private onGamepad = (e: GamepadEvent) => { this.padIndex = e.gamepad.index; };
  private onGamepadOut = () => { this.padIndex = null; };
  private onContextMenu = (e: Event) => { e.preventDefault(); };

  // --- REMOVED: the invisible half-screen touch scheme ---------------------
  // This file used to drive the kart from bare `pointerdown`/`move`/`up` on the
  // canvas: left half = steer from wherever you first touched, right half =
  // full throttle, and below 60 % of the screen height on the right = drift.
  // It is gone rather than kept as a fallback, for two reasons.
  //
  //  1. It was UNDISCOVERABLE. Nothing was drawn, so a player on a phone saw a
  //     game with no controls — which is the report that opened this task.
  //  2. It actively FIGHTS the on-screen controls. Those sit in an overlay
  //     above the canvas, so presses on them never reach these handlers — but
  //     every *other* touch still did. A thumb resting on bare scenery on the
  //     right of the screen meant permanent full throttle and, low enough,
  //     permanent drift, with no on-screen indication of either.
  //
  // Touch driving now arrives through `virtualController` above, written by
  // `src/ui/TouchControls`, which draws what it is doing.

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
    const vc = virtualController;

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
    if (Math.abs(vc.steer) > Math.abs(target)) target = vc.steer;

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
    const accelTarget = Math.max(this.raw.accel ? 1 : 0, padAccel, vc.accel);
    const brakeTarget = Math.max(this.raw.brake ? 1 : 0, padBrake, vc.brake);
    s.accel = damp(s.accel, accelTarget, 0.022, ctx.dt);
    s.brake = damp(s.brake, brakeTarget, 0.018, ctx.dt);
    if (s.accel > 0.995) s.accel = 1;
    if (s.accel < 0.005) s.accel = 0;

    // --- buttons + rising edges ---
    const drift = this.raw.drift || padDrift || vc.drift;
    const item = this.raw.item || padItem || vc.item;
    const start = this.raw.start || padStart || vc.start;

    s.driftPressed = drift && !this.prevDrift;
    s.itemPressed = item && !this.prevItem;
    s.startPressed = start && !this.prevStart;
    s.drift = drift;
    s.item = item;
    s.lookBack = this.raw.lookBack || padLook || vc.lookBack;

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
    this.el.removeEventListener('contextmenu', this.onContextMenu);
    resetVirtualController();
    this.bound = false;
  }
}
