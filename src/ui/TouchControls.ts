/**
 * ============================================================================
 *  FOXY KART — ON-SCREEN (TOUCH) CONTROLS
 * ============================================================================
 *  A DOM overlay that turns a phone or tablet into a controller. It writes the
 *  `virtualController` device object exported by `@/core/Input`; nothing here
 *  knows anything about karts, physics or the driving model. `InputState` was
 *  already analog (`steer` -1..1, `accel`/`brake` 0..1, `drift`/`item` with
 *  rising edges), so a stick maps straight onto it and the driving model is
 *  untouched.
 *
 * ---------------------------------------------------------------------------
 *  THE CONTROL SCHEME, AND WHY
 * ---------------------------------------------------------------------------
 *  One thumb steers, the other acts. Default placement is the owner's sketch:
 *  stick under the RIGHT thumb, action buttons under the LEFT. `setLayout()`
 *  mirrors it for players who expect the console convention (left stick steers,
 *  right hand acts) or who are left-handed; the mirror is one class and two
 *  CSS custom properties, so neither side is a special case.
 *
 *  ACCELERATION IS AUTOMATIC WHILE RACING. This is a decision, not an
 *  oversight, and it has three legs:
 *
 *   1. There are two thumbs and the steering one is fully committed. A held
 *      throttle would have to share the acting thumb with drift and item, and
 *      drift is *also* held — through the whole corner, which is exactly when
 *      you need to fire an item.
 *   2. Nothing in this game wants a part-throttle. Coasting has no mechanic
 *      attached to it; every corner is taken on the drift button.
 *   3. It is what every mobile kart racer does, so it needs no teaching.
 *
 *  But auto-accelerate on its own would be a trap, twice over, and both traps
 *  are handled here:
 *
 *   * REVERSE. `KartPhysics` only reverses out of a wall while `accel < 0.15`
 *     ("Reverse out of a wall"). With the throttle pinned at 1 the kart would
 *     grind against the wall forever. So BRAKE zeroes `accel` as well as
 *     raising `brake`: hold it and you brake, keep holding at a standstill and
 *     you reverse. That is also why brake is a real control and not a
 *     "release throttle" gesture.
 *   * THE ROCKET START. `RaceDirector` grants a rocket start for a throttle
 *     hold that *begins* inside the last 0.35 s of the countdown, and a
 *     BURNOUT penalty for one that begins before `burnoutThreshold`. An
 *     always-on throttle would therefore hand every touch player a burnout at
 *     the start of every race. So auto-accelerate engages only once the phase
 *     is `racing`, and during the countdown the drift button becomes the launch
 *     control — relabelled, pulsing, and writing `accel` instead of `drift`
 *     (writing `drift` there would leave the flag held into the green light and
 *     hop the kart off the line). Touch players get the same rocket start, on
 *     the same timing, as the keyboard.
 *
 *  The trade-off: no part-throttle on touch, and no look-behind. Both are
 *  reachable from a keyboard or gamepad, neither is worth a fourth button under
 *  a thumb that is already holding drift.
 *
 * ---------------------------------------------------------------------------
 *  THE STICK FLOATS
 * ---------------------------------------------------------------------------
 *  The pad is much larger than the drawn stick and the stick RE-CENTRES to
 *  wherever the thumb lands inside it. A fixed centre fails in the exact
 *  situation this control exists for: mid-drift, thumb dragged to full lock,
 *  eyes on the corner and not on the thumb. Two more rules protect the same
 *  moment:
 *
 *   * `setPointerCapture` on touchdown, so dragging outside the pad — off the
 *     bottom of the screen, over the HUD, over the other cluster — keeps
 *     steering instead of silently releasing at full lock.
 *   * Every control tracks its OWN `pointerId`. Steering with one thumb while
 *     the other taps item and holds drift is three simultaneous pointers, and
 *     none of them may cancel another.
 *
 * ---------------------------------------------------------------------------
 *  TAPS SHORTER THAN A FRAME
 * ---------------------------------------------------------------------------
 *  `driftPressed` / `itemPressed` are rising edges computed in `Input.update()`.
 *  A press and release that both land between two frames would set and clear
 *  the flag without any frame ever seeing it. So a release is deferred: the
 *  button stays held until the next `sync()`, which the menu system calls once
 *  per frame *after* `Input.update()` in the subsystem order. Every tap is
 *  therefore worth exactly one frame of held state, and exactly one edge.
 *
 * ---------------------------------------------------------------------------
 *  WHEN THE CONTROLS APPEAR — see `touchIsPrimary()` below
 * ---------------------------------------------------------------------------
 * ============================================================================
 */

import { resetVirtualController, virtualController } from '@/core/Input';
import { clamp } from '@/core/MathUtils';
import { el, setClass, setText, svgEl } from './Widgets';

/** Race phases this layer distinguishes. Anything else is treated as "not live". */
type Phase = 'intro' | 'countdown' | 'racing' | 'finished' | 'paused' | 'idle' | 'results';

export type TouchLayout = 'stick-right' | 'stick-left';

/**
 * Is touch the PRIMARY way this device is driven?
 *
 * `(pointer: coarse)` and `(hover: none)` describe the primary pointer, which is
 * a far better signal than width: a 1024-wide tablet and a 1024-wide browser
 * window are the same number and completely different devices, and a phone
 * rotated to portrait is the same device at half the width.
 *
 *   phone / tablet          coarse + no hover   -> true,  controls at load
 *   desktop                 fine + hover        -> false, nothing changes
 *   touchscreen laptop      fine + hover        -> false at load (the primary
 *                                                  pointer really is the
 *                                                  trackpad) but the first real
 *                                                  touch turns them on
 *   iPad with a trackpad    reported either way -> whichever it reports, the
 *                                                  first touch or the first key
 *                                                  press corrects it
 *
 * The hybrids are the reason this is not the whole answer. `TouchControls`
 * additionally watches for a genuine `pointerdown` of type `touch` (turn on)
 * and for a keyboard press or a mouse press (turn off). That is reversible and
 * needs no persistence, no setting and no guess: whichever device you last
 * actually used is the one the screen is dressed for.
 */
export function touchIsPrimary(): boolean {
  const mm = window.matchMedia;
  if (typeof mm !== 'function') return (navigator.maxTouchPoints ?? 0) > 0;
  return mm.call(window, '(pointer: coarse)').matches
    && mm.call(window, '(hover: none)').matches;
}

/** Keys that mean "this player has a keyboard and is using it". */
const DRIVING_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyF', 'KeyP',
  'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'Enter', 'Escape',
]);

interface Btn {
  el: HTMLElement;
  label: HTMLElement;
  /** Pointer currently holding this button, or -1. */
  id: number;
  /** Held right now. */
  down: boolean;
  /** Released, but owed one more frame so the rising edge cannot be missed. */
  releasePending: boolean;
}

export interface TouchControlsOpts {
  /** Invoked by the on-screen pause button. */
  onPause?: () => void;
}

export class TouchControls {
  private root: HTMLDivElement;
  /** Hit area for steering — much larger than the drawn stick. */
  private stickPad: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  /** The button cluster. Which physical side it lands on is `layout`'s job. */
  private actsEl: HTMLDivElement;
  private drift!: Btn;
  private item!: Btn;
  private brake!: Btn;
  private pauseBtn: HTMLButtonElement;
  private pointerQuery: MediaQueryList | null = null;

  private opts: TouchControlsOpts;

  /** Device/preference gate — has the player shown us they are on touch? */
  private touchMode = false;
  /** Layout gate — should the driving controls be on screen right now? */
  private live = false;
  private layout: TouchLayout = 'stick-right';
  private phase: Phase = 'idle';

  private stickId = -1;
  /** Pad-relative centre the current drag is measured from. */
  private originX = 0;
  private originY = 0;
  private steer = 0;
  /** Half-travel of the stick in px, recomputed on resize. */
  private travel = 48;

  private lastClearL = -1;
  private lastClearR = -1;
  private lastClearT = -1;
  private disposed = false;

  constructor(container: HTMLElement, opts: TouchControlsOpts = {}) {
    this.opts = opts;

    const root = el('div', 'ak-touch', container);
    this.root = root;
    root.setAttribute('aria-hidden', 'true');

    // --- pause, top corner ------------------------------------------------
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.className = 'ak-touch__pause';
    pause.setAttribute('aria-label', 'Pause');
    const psvg = svgEl('svg', { viewBox: '0 0 24 24' }, pause);
    svgEl('rect', { x: '7', y: '5', width: '4', height: '14', rx: '1.4', fill: 'currentColor' }, psvg);
    svgEl('rect', { x: '13', y: '5', width: '4', height: '14', rx: '1.4', fill: 'currentColor' }, psvg);
    root.appendChild(pause);
    this.pauseBtn = pause;
    pause.addEventListener('pointerdown', this.onPausePress);

    // --- steering pad -----------------------------------------------------
    // The pad is the whole hit area; the base is only what is drawn.
    this.stickPad = el('div', 'ak-touch__pad', root);
    this.stickBase = el('div', 'ak-touch__base', this.stickPad);
    el('div', 'ak-touch__axis', this.stickBase);
    this.stickKnob = el('div', 'ak-touch__knob', this.stickBase);
    this.stickPad.addEventListener('pointerdown', this.onStickDown);
    this.stickPad.addEventListener('pointermove', this.onStickMove);
    this.stickPad.addEventListener('pointerup', this.onStickUp);
    this.stickPad.addEventListener('pointercancel', this.onStickUp);

    // --- action cluster ---------------------------------------------------
    this.actsEl = el('div', 'ak-touch__acts', root);
    this.drift = this.makeButton('drift', 'DRIFT');
    this.item = this.makeButton('item', 'ITEM');
    this.brake = this.makeButton('brake', 'BRAKE');

    this.applyLayout();
    this.setTouchMode(touchIsPrimary());

    // Hybrids: whichever device the player last actually used wins. Capture
    // phase so a press consumed by a control still counts as evidence.
    window.addEventListener('pointerdown', this.onAnyPointer, true);
    window.addEventListener('keydown', this.onAnyKey, true);
    this.pointerQuery = window.matchMedia?.('(pointer: coarse)') ?? null;
    this.pointerQuery?.addEventListener?.('change', this.onPointerCapabilityChange);
  }

  private makeButton(id: 'drift' | 'item' | 'brake', label: string): Btn {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `ak-touch__btn ak-touch__btn--${id}`;
    const glyph = el('span', 'ak-touch__glyph', node);
    glyph.textContent = label;
    this.actsEl.appendChild(node);
    const btn: Btn = { el: node, label: glyph, id: -1, down: false, releasePending: false };
    node.addEventListener('pointerdown', (e) => this.onBtnDown(btn, e));
    node.addEventListener('pointerup', (e) => this.onBtnUp(btn, e));
    node.addEventListener('pointercancel', (e) => this.onBtnUp(btn, e));
    // A thumb that slides off the face of a button has not let go of it — the
    // capture below keeps the press alive, and this is the matching release.
    node.addEventListener('lostpointercapture', (e) => this.onBtnUp(btn, e));
    return btn;
  }

  // =======================================================================
  // Device gate
  // =======================================================================

  private onAnyPointer = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') this.setTouchMode(true);
    // A real mouse press means a real mouse. Never demote while a control is
    // actually being held — a synthesised compatibility mouse event during a
    // drag would otherwise pull the stick out from under the thumb.
    else if (e.pointerType === 'mouse' && !this.anyControlHeld()) this.setTouchMode(false);
  };

  private onAnyKey = (e: KeyboardEvent): void => {
    if (!this.touchMode || this.anyControlHeld()) return;
    if (DRIVING_KEYS.has(e.code)) this.setTouchMode(false);
  };

  private onPointerCapabilityChange = (): void => {
    // A device that changes its primary pointer (a tablet docking or undocking)
    // re-asserts the load-time answer; a later touch or key press still wins.
    this.setTouchMode(touchIsPrimary());
  };

  private anyControlHeld(): boolean {
    return this.stickId !== -1 || this.drift.down || this.item.down || this.brake.down;
  }

  private setTouchMode(on: boolean): void {
    if (this.touchMode === on || this.disposed) return;
    this.touchMode = on;
    // The class goes on <html> so `ui.css` can adapt the HUD and the menus with
    // it — tap targets, edge clearances, keyboard-only hints. It is a device
    // capability, not a viewport size, so it is not a breakpoint.
    document.documentElement.classList.toggle('ak-touch-mode', on);
    if (!on) this.releaseAll();
    this.apply();
  }

  /** True when the on-screen controls are the active input scheme. */
  get active(): boolean { return this.touchMode; }

  // =======================================================================
  // Layout
  // =======================================================================

  setLayout(layout: TouchLayout): void {
    if (this.layout === layout) return;
    this.layout = layout;
    this.applyLayout();
    this.measure();
  }

  get currentLayout(): TouchLayout { return this.layout; }

  private applyLayout(): void {
    setClass(this.root, 'ak-touch--mirrored', this.layout === 'stick-left');
  }

  // =======================================================================
  // Per-frame sync — called from MenuSystem.update()
  // =======================================================================

  /**
   * @param phase     the race director's phase, or undefined if it has none yet
   * @param menuOpen  a menu screen, the pause screen or the results board is up
   */
  sync(phase: string | undefined, menuOpen: boolean): void {
    if (this.disposed) return;
    const p = (phase ?? 'idle') as Phase;
    const phaseChanged = p !== this.phase;
    this.phase = p;

    const driving = !menuOpen
      && (p === 'intro' || p === 'countdown' || p === 'racing' || p === 'finished');
    if (driving !== this.live) {
      this.live = driving;
      if (!driving) this.releaseAll();
      this.apply();
    }
    if (phaseChanged) this.refreshLaunchLabel();

    // Deferred releases: one full frame of held state per tap, no more.
    this.settle(this.drift);
    this.settle(this.item);
    this.settle(this.brake);

    this.write();
  }

  private settle(b: Btn): void {
    if (!b.releasePending) return;
    b.releasePending = false;
    b.down = false;
    setClass(b.el, 'ak-touch__btn--on', false);
  }

  /** Push the current control state onto the shared virtual device. */
  private write(): void {
    const v = virtualController;
    if (!this.touchMode || !this.live) return;

    v.steer = this.steer;

    // Throttle. Auto only once the lights are out; during the countdown the
    // drift button IS the throttle, so a touch player can earn the rocket start
    // (and can just as legitimately jump it and burn out).
    const launching = this.phase === 'countdown' || this.phase === 'intro';
    const auto = this.phase === 'racing' || this.phase === 'finished';
    let accel = launching ? (this.drift.down ? 1 : 0) : (auto ? 1 : 0);

    // Brake owns the throttle while held: without this the kart cannot reverse
    // (see the header) and part-braking would fight a pinned throttle.
    let brake = 0;
    if (this.brake.down) { brake = 1; accel = 0; }

    v.accel = accel;
    v.brake = brake;
    v.drift = launching ? false : this.drift.down;
    v.item = this.item.down;
  }

  private refreshLaunchLabel(): void {
    const launching = this.phase === 'countdown' || this.phase === 'intro';
    setClass(this.drift.el, 'ak-touch__btn--launch', launching);
    setText(this.drift.label, launching ? 'HOLD' : 'DRIFT');
  }

  private apply(): void {
    const show = this.touchMode && this.live;
    setClass(this.root, 'ak-touch--on', show);
    this.root.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) this.measure();
    else this.clearClearances();
  }

  // =======================================================================
  // Stick
  // =======================================================================

  private onStickDown = (e: PointerEvent): void => {
    if (this.stickId !== -1) return;                 // one thumb owns the stick
    this.stickId = e.pointerId;
    const r = this.stickPad.getBoundingClientRect();
    // Float the stick to the thumb, but keep the drawn base inside the pad so
    // it never hangs off the edge of the screen.
    const half = this.stickBase.offsetWidth * 0.5;
    this.originX = clamp(e.clientX - r.left, half, Math.max(half, r.width - half));
    this.originY = clamp(e.clientY - r.top, half, Math.max(half, r.height - half));
    this.stickBase.style.left = `${this.originX}px`;
    this.stickBase.style.top = `${this.originY}px`;
    setClass(this.stickPad, 'ak-touch__pad--held', true);
    try { this.stickPad.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
    this.updateStick(e.clientX - r.left);
    e.preventDefault();
  };

  private onStickMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    const r = this.stickPad.getBoundingClientRect();
    this.updateStick(e.clientX - r.left);
    e.preventDefault();
  };

  private onStickUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    this.stickId = -1;
    this.steer = 0;
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
    this.stickBase.style.left = '';
    this.stickBase.style.top = '';
    setClass(this.stickPad, 'ak-touch__pad--held', false);
    virtualController.steer = 0;
  };

  private updateStick(x: number): void {
    const dx = x - this.originX;
    const t = Math.max(8, this.travel);
    const raw = clamp(dx / t, -1, 1);
    // A small dead-zone, rescaled so full lock is still reachable at the edge
    // of the travel. Without the rescale the last 6 % of the throw is lost.
    const dead = 0.06;
    const a = Math.abs(raw);
    this.steer = a < dead ? 0 : Math.sign(raw) * ((a - dead) / (1 - dead));
    this.stickKnob.style.transform = `translate(calc(-50% + ${(this.steer * t).toFixed(1)}px), -50%)`;
    virtualController.steer = this.steer;
  }

  // =======================================================================
  // Buttons
  // =======================================================================

  private onBtnDown(b: Btn, e: PointerEvent): void {
    if (b.id !== -1) return;
    b.id = e.pointerId;
    b.down = true;
    b.releasePending = false;
    setClass(b.el, 'ak-touch__btn--on', true);
    try { b.el.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
    e.preventDefault();
    e.stopPropagation();
    this.write();
  }

  private onBtnUp(b: Btn, e: PointerEvent): void {
    if (b.id !== e.pointerId) return;
    b.id = -1;
    // Do NOT clear `down` here — `sync()` does, one frame later, so a tap that
    // begins and ends between two frames still produces exactly one edge.
    b.releasePending = true;
  }

  private onPausePress = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.releaseAll();
    this.opts.onPause?.();
  };

  private releaseAll(): void {
    for (const b of [this.drift, this.item, this.brake]) {
      b.id = -1; b.down = false; b.releasePending = false;
      setClass(b.el, 'ak-touch__btn--on', false);
    }
    this.stickId = -1;
    this.steer = 0;
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
    this.stickBase.style.left = '';
    this.stickBase.style.top = '';
    setClass(this.stickPad, 'ak-touch__pad--held', false);
    resetVirtualController();
  }

  // =======================================================================
  // Measurement
  // =======================================================================

  resize(): void {
    if (!this.disposed) this.measure();
  }

  /**
   * Publish how much of each screen corner the controls occupy, so the HUD can
   * step out of the way.
   *
   * MEASURED, not recomputed from the same numbers the CSS uses. A second copy
   * of the button geometry would be a check that cannot fail: change a size in
   * `ui.css` and the clearance would keep reporting the old footprint while the
   * position plate quietly sat under the drift button again.
   */
  private measure(): void {
    if (!this.touchMode || !this.live) return;
    // Thumb travel to full lock, as a fraction of the drawn base. 0.36 puts full
    // lock ~47 px out at phone scale, so the knob just clears the ring: enough
    // throw to hold a mid-lock line, short enough to snap to full lock in a
    // hairpin. THIS IS THE FIRST NUMBER TO TUNE on real hardware — it was chosen
    // against an emulated pointer, which has no thumb width and no wobble.
    this.travel = Math.max(24, this.stickBase.offsetWidth * 0.36);
    // While a thumb is on it the base has floated away from its rest position,
    // so measuring now would publish a clearance for a transient.
    if (this.stickId !== -1) return;

    const h = window.innerHeight;
    // The pad is a generous hit area; the HUD only has to clear what is DRAWN,
    // which is the base circle at rest in the pad's outer corner.
    const drawn = this.stickBase.getBoundingClientRect();
    const acts = this.actsEl.getBoundingClientRect();
    const pause = this.pauseBtn.getBoundingClientRect();

    const stickClear = Math.max(0, h - drawn.top);
    const actsClear = Math.max(0, h - acts.top);
    const stickOnLeft = this.layout === 'stick-left';
    const left = stickOnLeft ? stickClear : actsClear;
    const right = stickOnLeft ? actsClear : stickClear;
    this.setVar('--ak-touch-clear-bl', left, 'lastClearL');
    this.setVar('--ak-touch-clear-br', right, 'lastClearR');
    this.setVar('--ak-touch-clear-tl', Math.max(0, pause.right), 'lastClearT');
  }

  private setVar(name: string, px: number, cache: 'lastClearL' | 'lastClearR' | 'lastClearT'): void {
    const v = Math.round(px);
    if (this[cache] === v) return;
    this[cache] = v;
    document.documentElement.style.setProperty(name, `${v}px`);
  }

  private clearClearances(): void {
    const s = document.documentElement.style;
    for (const n of ['--ak-touch-clear-bl', '--ak-touch-clear-br', '--ak-touch-clear-tl']) {
      s.removeProperty(n);
    }
    this.lastClearL = this.lastClearR = this.lastClearT = -1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('pointerdown', this.onAnyPointer, true);
    window.removeEventListener('keydown', this.onAnyKey, true);
    this.pointerQuery?.removeEventListener?.('change', this.onPointerCapabilityChange);
    this.releaseAll();
    this.clearClearances();
    document.documentElement.classList.remove('ak-touch-mode');
    this.root.remove();
  }
}
