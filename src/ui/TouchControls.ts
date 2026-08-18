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
 *  THREE STEERING STYLES — the player picks one, the rest of the layer is shared
 * ---------------------------------------------------------------------------
 *  A hardware test with a second player said the virtual stick is still easy to
 *  oversteer and hard for a first-timer, *after* travel had already gone 47 -> 76
 *  px with a softened curve. Another sensitivity tweak was explicitly not what
 *  was wanted, so this is an architecture choice instead. `CONTROL STYLE` in
 *  OPTIONS selects one of:
 *
 *   SWIPE (default). There is NO steering control drawn and none to find. A
 *     steering gesture may begin anywhere on the play surface that is not an
 *     action control, and THAT touchdown point becomes the gesture's own origin;
 *     steering is horizontal displacement from it, so the next gesture may start
 *     somewhere else entirely and behave identically. Nothing is ever mapped
 *     from an absolute screen position — that would steer differently in
 *     portrait than in landscape and differently for a high grip than a low one.
 *     Released or cancelled, it is exactly 0. See `SWIPE_STEER`.
 *
 *   JOYSTICK. The floating stick described below, unchanged and still measurable
 *     against its published curve. See `TOUCH_STEER`.
 *
 *   D-PAD. Two arrows, for players who find any analog steering hard. A hold
 *     RAMPS toward full lock instead of snapping to it. See `DPAD_STEER` for the
 *     three rates and why a digital control needs its own ramp rather than
 *     leaning on `Input`'s.
 *
 *  All three write nothing but `virtualController.steer`, all three share the
 *  same DRIFT / ITEM / BRAKE cluster, the same pointer-ownership rules and the
 *  same phase logic, and none of them touches `KartPhysics`, the keyboard or the
 *  gamepad.
 *
 *  SWIPE STILL DRAWS SOMETHING. `Input.ts` records why the *previous* invisible
 *  touch scheme was deleted: "It was UNDISCOVERABLE. Nothing was drawn, so a
 *  player on a phone saw a game with no controls." Swipe would walk straight back
 *  into that, so it draws two things that are emphatically not a joystick: a slim
 *  steering GAUGE pinned to the bottom edge (a readout of the steer the game is
 *  receiving — it is nowhere near your thumb and cannot be grabbed), and a
 *  one-per-race hint naming the gesture. Neither is a control and neither implies
 *  a place you have to touch.
 *
 * ---------------------------------------------------------------------------
 *  THE STICK FLOATS  (JOYSTICK style)
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
import { clamp, moveTowards } from '@/core/MathUtils';
import { el, setClass, setText, svgEl } from './Widgets';

/** Race phases this layer distinguishes. Anything else is treated as "not live". */
type Phase = 'intro' | 'countdown' | 'racing' | 'finished' | 'paused' | 'idle' | 'results';

export type TouchLayout = 'stick-right' | 'stick-left';
export const TOUCH_LAYOUTS: readonly TouchLayout[] = ['stick-right', 'stick-left'];

/** Which steering control the player chose. See the header. */
export type TouchControlStyle = 'swipe' | 'joystick' | 'dpad';
export const TOUCH_CONTROL_STYLES: readonly TouchControlStyle[] = ['swipe', 'joystick', 'dpad'];

export type SteerSensitivity = 'low' | 'normal' | 'high';
export const STEER_SENSITIVITIES: readonly SteerSensitivity[] = ['low', 'normal', 'high'];

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

/**
 * ===========================================================================
 *  TOUCH STEERING FEEL — the only knobs you should need after a hardware test
 * ===========================================================================
 *  Every value that decides how the virtual stick FEELS lives here, named, so a
 *  real-thumb test can be answered by editing four numbers rather than by
 *  rewriting `updateStick`. This layer maps thumb displacement to
 *  `InputState.steer` and nothing else: `KartPhysics` is untouched, and the
 *  keyboard and gamepad paths never read any of this.
 *
 *  ---- WHY THESE VALUES CHANGED ------------------------------------------
 *  The first version was `travelFrac 0.36` (~47 px to full lock) with a linear
 *  response and a 0.06 dead zone. On real hardware the owner's verdict was that
 *  small thumb movements produced too much steering. Both halves of that were
 *  true and they compound:
 *
 *    * 47 px is roughly one thumb-width of total throw, so there was almost no
 *      room to hold a partial lock — the useful range was a few millimetres.
 *    * a LINEAR map spends as much steering per pixel at dead centre as it does
 *      at full lock, which is precisely the wrong distribution: the centre is
 *      where precision matters and the edge is where you want it immediate.
 *
 *  So travel roughly doubles AND the response is curved. Note that fixing only
 *  one would have been unsatisfying: doubling travel alone still steers hard for
 *  the first millimetre, and curving alone leaves too little physical room to
 *  sit inside the soft region.
 *
 *  ---- WHAT IS DELIBERATELY *NOT* HERE ----------------------------------
 *  No smoothing, no lerp, no rate limit. `updateStick` maps the CURRENT pointer
 *  position on the event that reports it, so a counter-steer lands on the frame
 *  the thumb moves. Smoothing would have been the easy way to make the centre
 *  feel calmer and it would have made counter-steering feel late, which is worse
 *  than the problem it solves.
 */
const TOUCH_STEER = {
  /**
   * Thumb travel to full lock, as a fraction of the drawn base width.
   * 0.36 -> 0.58 takes full lock from ~47 px to ~76 px at phone scale. Not
   * further: 0.68 was tried and puts full lock at ~89 px, which is past
   * comfortable thumb reach on a phone — a hairpin should not require a stretch.
   * THIS IS THE FIRST NUMBER TO TUNE.
   */
  travelFrac: 0.58,
  /** Floor for tiny bases, so the curve never collapses onto a few pixels. */
  minTravelPx: 40,
  /**
   * Dead zone, as a fraction of travel. Absorbs thumb wobble at rest without
   * eating a perceptible amount of the throw. Rescaled below so full lock is
   * still exactly reachable at the edge.
   */
  deadZone: 0.07,
  /**
   * Response exponent. 1 = linear; higher softens the centre while leaving the
   * outer range intact, because `pow(1, n) === 1` for any n — full +-1 is still
   * reached at the edge of travel, it just takes a deliberate push to get there.
   *
   * Measured against the old linear map, as thumb travel needed to REACH a given
   * steer value at phone scale (base 131 px):
   *
   *     steer        0.15   0.30   0.50   0.80   1.00
   *     old, linear   9.5   16.5   25.0   38.5   47.5 px
   *     this curve   25.5   37.0   50.0   66.5   76.0 px
   *
   * and at the first 10 px of travel — the wobble region — 0.017 against the old
   * 0.162, so dead centre is about 9.5x calmer. 1.9 was tried and is calmer still
   * (0.003) but needs 50 px just to reach 0.30, which reads as a dead stick.
   */
  curve: 1.5,
} as const;

/**
 * ===========================================================================
 *  SWIPE STEERING FEEL — the default style's own knobs
 * ===========================================================================
 *  Deliberately a SEPARATE block from `TOUCH_STEER`, not a set of multipliers on
 *  it. The two controls are shaped by different constraints and sharing numbers
 *  would silently couple them: the stick's travel is bounded by the drawn base
 *  and by how far a thumb reaches from a fixed pivot, while a swipe starts
 *  wherever the thumb already is and can therefore afford a longer throw. Tuning
 *  one must never move the other, and the joystick's published curve has to stay
 *  reproducible.
 *
 *  ---- WHY THESE ARE ABSOLUTE PIXELS ------------------------------------
 *  `travelPx` is NOT a fraction of anything on screen, and that is the single
 *  most important decision in this block. A viewport-relative travel (`vw`,
 *  `vh`, `--ak-tu`, half the short edge, ...) makes the same thumb movement mean
 *  different steering in portrait and landscape, which is the failure this style
 *  exists to avoid — the whole point of a relative gesture is that it does not
 *  care where or how the device is held. A thumb is also the same size on a
 *  tablet as on a phone, so there is nothing to scale it BY. One number, in CSS
 *  px, identical in both orientations and on both device classes.
 *
 *  ---- WHY 110 px --------------------------------------------------------
 *  The joystick reaches full lock in 76 px and the report is that this still
 *  oversteers for a first-timer, so swipe gets ~1.45x the throw. It is affordable
 *  precisely because the gesture has no fixed origin: 110 px of drag from
 *  wherever the thumb landed is a comfortable movement, whereas 110 px measured
 *  out from a base pinned in the corner of the glass is a stretch (which is why
 *  `TOUCH_STEER.travelFrac` was capped at 0.58 -> ~76 px).
 */
const SWIPE_STEER = {
  /**
   * Horizontal displacement from the gesture's own origin to FULL lock, in CSS
   * px. At exactly this displacement `steer` is exactly +-1.
   * THIS IS THE FIRST NUMBER TO TUNE.
   */
  travelPx: 110,
  /**
   * Dead zone around the origin, in px — absolute, for the same reason as
   * `travelPx`, and because thumb wobble is a physical distance rather than a
   * proportion of anything. 8 px absorbs the jitter of a thumb that is resting on
   * the glass to hold the gesture open without eating a perceptible part of a
   * 110 px throw (7.3 % of it). Rescaled below so full lock still lands exactly
   * at `travelPx`, never `travelPx + deadZonePx`.
   */
  deadZonePx: 8,
  /**
   * Response exponent, same mechanism as `TOUCH_STEER.curve`: `pow` fixes both
   * ends (0 -> 0, 1 -> 1) and only redistributes the middle, so the soft centre
   * costs nothing at the edge. Higher than the stick's 1.5 because the extra
   * travel gives the soft region somewhere to live — at 1.7 the first 20 px past
   * the dead zone yields 0.037 of steer, against the stick's 0.095 at the same
   * 20 px. Not higher still: 2.2 needs 60 px to reach 0.25, which reads as a
   * gesture that is not working.
   */
  curve: 1.7,
} as const;

/**
 * ===========================================================================
 *  D-PAD STEERING FEEL
 * ===========================================================================
 *  A digital control has no displacement to map, so its analog value has to come
 *  from TIME: how long the arrow has been held. That ramp is the control's whole
 *  design, and it has to be defined here rather than inherited.
 *
 *  ---- WHY THIS RAMP IS NOT `Input`'s -----------------------------------
 *  `Input.update()` already ramps a digital source: the keyboard writes a bare
 *  +-1 and `moveTowards(..., 14/s)` carries `state.steer` to full lock in ~71 ms.
 *  Feeding the D-Pad through that alone is exactly the "snaps to full lock and
 *  oscillates" behaviour this style exists to avoid — 71 ms is one long blink,
 *  and a player who taps an arrow to nudge the kart gets a full-lock swerve. So
 *  the D-Pad ramps its OWN value in `virtualController.steer`, which is an
 *  ordinary analog source; `Input`'s smoothing then sees an already-moving
 *  target and adds nothing perceptible. Nothing in `Input` is changed, and the
 *  keyboard is not touched: 14/s is still the keyboard's number.
 *
 *  ---- THE THREE RATES ARE THREE DIFFERENT JOBS -------------------------
 *  They are separate constants because making them one would force a choice
 *  between a controllable press and a safe release.
 */
const DPAD_STEER = {
  /**
   * Steer units per second while an arrow is held: 2.2 -> full lock in ~455 ms.
   * Slow enough that a short press is genuinely a small correction (a 100 ms tap
   * is 0.22 of lock, where the keyboard's 14/s would already be at 1.0), and fast
   * enough that a hairpin does not need a second of anticipation.
   * THIS IS THE FIRST NUMBER TO TUNE. It is also the only one sensitivity scales.
   */
  pressPerSec: 2.2,
  /**
   * Return to centre on release: 6.0 -> ~167 ms from full lock. Much faster than
   * the press on purpose, and the asymmetry is the same one `Input` uses for the
   * keyboard (20 back, 14 out): letting go must straighten the kart NOW, because
   * that is what a player does when a corner is going wrong. Not instant, because
   * a step to 0 from full lock is the snap this style is here to remove.
   */
  releasePerSec: 6.0,
  /**
   * Crossing the centre when the OTHER arrow is pressed. Applies only while the
   * current steer and the new target have opposite signs, so it is spent getting
   * out of the old lock and `pressPerSec` takes over the moment zero is crossed.
   * A counter-steer that inherited the 2.2 press rate would take 455 ms just to
   * reach neutral, which is a control that ignores you.
   */
  reversePerSec: 6.0,
  /**
   * Steer a fully-held arrow reaches. 1.0, not less: a hairpin needs full lock,
   * and clipping it here would put a ceiling on the kart's turn radius that the
   * player cannot see and cannot work around. The ramp — not a cap — is what
   * makes it controllable.
   */
  maxSteer: 1,
} as const;

/**
 * ===========================================================================
 *  STEERING SENSITIVITY — one multiplier, three mapped values
 * ===========================================================================
 *  The number is a multiplier on TRAVEL (px to full lock), which is the one
 *  quantity that means "sensitivity" in both displacement styles: more travel for
 *  the same steer is a less sensitive control. Dead zones and curve exponents are
 *  deliberately NOT touched, so the response SHAPE is identical at all three
 *  levels and only its scale changes — a player who has learned the feel of the
 *  centre does not have to relearn it to get a bit more or less bite.
 *
 *  On the D-Pad there is no travel, so the same multiplier divides
 *  `DPAD_STEER.pressPerSec` instead: less sensitive = a longer hold to reach the
 *  same steer, which is the identical statement in the units that style has.
 *  Release and reverse rates are untouched — those are responsiveness, not
 *  sensitivity, and nobody wants a "safe" setting that is slow to straighten.
 *
 *  Every level below therefore resolves to real, nameable values (measure them,
 *  don't trust this comment):
 *
 *    level    swipe travel   joystick travel   d-pad press rate
 *    LOW       143.0 px        98.8 px          1.692 /s  (591 ms to lock)
 *    NORMAL    110.0 px        76.0 px          2.200 /s  (455 ms)
 *    HIGH       85.8 px        59.3 px          2.821 /s  (355 ms)
 *
 *  1.30 / 0.78 rather than a wider spread because both ends have to stay
 *  defensible: LOW must not become a control that cannot reach lock in a corner,
 *  and HIGH must not walk all the way back to the 47 px that started this.
 */
const SENSITIVITY: Record<SteerSensitivity, number> = {
  low: 1.30,
  normal: 1.0,
  high: 0.78,
};

export class TouchControls {
  private root: HTMLDivElement;
  /** Hit area for steering — much larger than the drawn stick. JOYSTICK style. */
  private stickPad: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  /**
   * SWIPE style's steering surface: the whole viewport, drawing nothing.
   *
   * It is the FIRST child of the root so that paint order — and therefore hit
   * order — puts every drawn control above it. See `makeSwipeSurface`.
   */
  private swipeSurface: HTMLDivElement;
  /** Steering readout for the styles with no knob to watch. Never interactive. */
  private gauge: HTMLDivElement;
  private gaugeFill: HTMLDivElement;
  /** "Swipe anywhere to steer" — shown once per race in SWIPE style. */
  private hint: HTMLDivElement;
  /** D-PAD style's two arrows. */
  private dpadEl: HTMLDivElement;
  private dLeft!: Btn;
  private dRight!: Btn;
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
  private style: TouchControlStyle = 'swipe';
  private sensitivity: SteerSensitivity = 'normal';
  private phase: Phase = 'idle';

  private stickId = -1;
  /** Pad-relative centre the current drag is measured from. */
  private originX = 0;
  private originY = 0;
  /** SWIPE: the pointer that owns the gesture, and the origin IT chose. */
  private swipeId = -1;
  private swipeOriginX = 0;
  /** SWIPE: has a gesture happened since this race began? Drives the hint only. */
  private swiped = false;
  /**
   * D-PAD: the arrow pressed most recently that is still held, so pressing the
   * opposite arrow before releasing the first one reverses rather than cancels.
   */
  private dLast = 0;
  private steer = 0;
  /**
   * MEASURED thumb travel to full lock for the JOYSTICK, in px, BEFORE the
   * sensitivity multiplier. Recomputed from the RENDERED base width in
   * `measure()`; this initial value is only in force before the first measure.
   *
   * It used to be a bare `48`, which was a hand-copied duplicate of the old
   * `131 * 0.36` result — so raising `TOUCH_STEER.travelFrac` moved the measured
   * value and left this one behind, and the stick kept the OLD sensitivity on
   * every frame before `measure()` had run. Caught by measuring the settled
   * response curve and finding it implied ~48 px of travel where 76 was
   * configured. Derived from the constants now, so there is one source of truth.
   *
   * The sensitivity multiplier is applied by the `stickTravelPx` GETTER and is
   * not folded in here, for exactly the same reason: a stored product would go
   * stale the moment either factor changed on its own.
   */
  private measuredStickTravel: number = TOUCH_STEER.minTravelPx;

  private lastClearL = -1;
  private lastClearR = -1;
  private lastClearT = -1;
  private disposed = false;

  // =======================================================================
  // Derived feel numbers — GETTERS, never stored
  // =======================================================================
  //
  // The one defect this file has already shipped was a derived number kept in a
  // field: `travel = 48` outlived the constant it was copied from. Everything
  // below is computed at the moment it is used, from the constant block plus the
  // current setting, so there is no copy that can be left behind when a constant
  // or a setting moves. They are all trivial arithmetic on values already in
  // registers; the joystick's `offsetWidth` read is the only thing here expensive
  // enough to be worth caching, and it is cached as the RAW measurement.

  /** Travel multiplier for the current STEERING SENSITIVITY. */
  private get sensMul(): number { return SENSITIVITY[this.sensitivity]; }
  /** JOYSTICK: px of thumb travel to full lock, at the current sensitivity. */
  private get stickTravelPx(): number { return this.measuredStickTravel * this.sensMul; }
  /** SWIPE: px of gesture displacement to full lock, at the current sensitivity. */
  private get swipeTravelPx(): number { return SWIPE_STEER.travelPx * this.sensMul; }
  /** D-PAD: steer units per second while held, at the current sensitivity. */
  private get dpadPressPerSec(): number { return DPAD_STEER.pressPerSec / this.sensMul; }

  constructor(container: HTMLElement, opts: TouchControlsOpts = {}) {
    this.opts = opts;

    const root = el('div', 'ak-touch', container);
    this.root = root;
    root.setAttribute('aria-hidden', 'true');

    // --- SWIPE surface, FIRST so everything else paints (and hit-tests) above it
    this.swipeSurface = this.makeSwipeSurface(root);

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
    // If capture goes away for any reason the browser sees fit — and it does not
    // always send `pointercancel` first — the stick must let go. Otherwise
    // `stickId` stays claimed, `onStickDown` refuses the next thumb, and the
    // player is left steering at whatever lock the lost pointer died at.
    this.stickPad.addEventListener('lostpointercapture', this.onStickUp);

    // --- D-PAD ------------------------------------------------------------
    // Same corner as the stick and mirrored by the same rule, so a player who
    // switches style finds the steering control in the place they already know.
    this.dpadEl = el('div', 'ak-touch__dpad', root);
    this.dLeft = this.makeDirButton('left');
    this.dRight = this.makeDirButton('right');

    // --- action cluster ---------------------------------------------------
    this.actsEl = el('div', 'ak-touch__acts', root);
    this.drift = this.makeButton('drift', 'DRIFT');
    this.item = this.makeButton('item', 'ITEM');
    this.brake = this.makeButton('brake', 'BRAKE');

    // --- steering readout + swipe hint ------------------------------------
    // Last, so they draw over everything, and both are `pointer-events: none`
    // so being on top costs no hit area.
    this.gauge = el('div', 'ak-touch__gauge', root);
    el('div', 'ak-touch__gauge-tick', this.gauge);
    this.gaugeFill = el('div', 'ak-touch__gauge-fill', this.gauge);
    this.hint = el('div', 'ak-touch__hint', root, 'SWIPE ANYWHERE TO STEER');

    this.applyLayout();
    this.applyStyle();
    this.setTouchMode(touchIsPrimary());

    // Hybrids: whichever device the player last actually used wins. Capture
    // phase so a press consumed by a control still counts as evidence.
    window.addEventListener('pointerdown', this.onAnyPointer, true);
    window.addEventListener('keydown', this.onAnyKey, true);
    this.pointerQuery = window.matchMedia?.('(pointer: coarse)') ?? null;
    this.pointerQuery?.addEventListener?.('change', this.onPointerCapabilityChange);
    // Taking a call, switching apps or pulling down the notification shade all
    // steal the touch without necessarily sending a `pointercancel`. Whatever was
    // held must not still be held when the player comes back.
    window.addEventListener('blur', this.onInterrupt);
    document.addEventListener('visibilitychange', this.onInterrupt);
  }

  private onInterrupt = (): void => {
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    this.releaseAll();
  };

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

  /**
   * The SWIPE style's steering surface.
   *
   * WHY IT IS A SIBLING OF THE BUTTONS AND NOT AN ANCESTOR OF THEM
   * This is the main correctness risk of the style: steering now covers most of
   * the screen, and a thumb reaching for DRIFT lands *inside* that region. If the
   * surface were a wrapper the button sat in, a press on the button would bubble
   * through the surface's `pointerdown`, open a steering gesture the player never
   * asked for, and — worse — that gesture's origin would be under the button, so
   * the next slide of the *acting* thumb would steer. Making them siblings means
   * a press on a button is never in the surface's event path at all: the path is
   * button -> cluster -> root, and the surface is not on it. No filtering, no
   * `closest()` test, no ordering assumption that could rot.
   *
   * The surface is the root's FIRST child so that paint order (these are all
   * `position: absolute` with no `z-index`, so paint order is DOM order) puts
   * every drawn control above it, and hit-testing follows paint order. It draws
   * nothing at all, so being underneath costs it nothing.
   *
   * The action cluster is excluded a second way as well: `.ak-touch__acts` keeps
   * `pointer-events: auto` across its whole box, so the GAPS between the three
   * buttons swallow a press instead of steering. A near-miss on DRIFT mid-corner
   * should do nothing, not swerve.
   */
  private makeSwipeSurface(root: HTMLElement): HTMLDivElement {
    const s = el('div', 'ak-touch__swipe', root);
    s.addEventListener('pointerdown', this.onSwipeDown);
    s.addEventListener('pointermove', this.onSwipeMove);
    s.addEventListener('pointerup', this.onSwipeUp);
    s.addEventListener('pointercancel', this.onSwipeUp);
    // Same reason as the stick's: capture can vanish without a `pointercancel`,
    // and a lost gesture must release rather than freeze at whatever lock it died
    // at. Without this the surface would stay claimed and refuse the next thumb.
    s.addEventListener('lostpointercapture', this.onSwipeUp);
    return s;
  }

  /**
   * One D-Pad arrow.
   *
   * Shares the `Btn` record and therefore the pointer-ownership rules — its own
   * `pointerId`, its own capture — but NOT the deferred release the action
   * buttons use. That defer exists so a sub-frame TAP still produces one rising
   * edge for `driftPressed`/`itemPressed`; a direction is a continuous state with
   * no edge to miss, and holding it an extra frame would just add steering the
   * player did not ask for.
   */
  private makeDirButton(dir: 'left' | 'right'): Btn {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `ak-touch__dbtn ak-touch__dbtn--${dir}`;
    node.setAttribute('aria-label', dir === 'left' ? 'Steer left' : 'Steer right');
    const glyph = el('span', 'ak-touch__dglyph', node);
    const svg = svgEl('svg', { viewBox: '0 0 24 24' }, glyph);
    // One path, mirrored by CSS for the right arrow, so the two arrows cannot
    // drift into being different shapes.
    svgEl('path', { d: 'M15.5 3.5 L6 12 L15.5 20.5 Z', fill: 'currentColor' }, svg);
    this.dpadEl.appendChild(node);
    const btn: Btn = { el: node, label: glyph, id: -1, down: false, releasePending: false };
    node.addEventListener('pointerdown', (e) => this.onDirDown(btn, dir, e));
    node.addEventListener('pointerup', (e) => this.onDirUp(btn, e));
    node.addEventListener('pointercancel', (e) => this.onDirUp(btn, e));
    node.addEventListener('lostpointercapture', (e) => this.onDirUp(btn, e));
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

  /**
   * Is any control being held right now?
   *
   * Every style's steering pointer has to be in here, not just the stick's. This
   * guards the demote-to-mouse path: browsers synthesise compatibility mouse
   * events during a touch drag, and a demote mid-gesture hides the layer and
   * calls `releaseAll()` — i.e. it would pull the steering out from under the
   * thumb at whatever lock it was at. A missing entry here shows up as "steering
   * randomly cuts out", which is why the list is explicit rather than a scan.
   */
  private anyControlHeld(): boolean {
    return this.stickId !== -1 || this.swipeId !== -1
      || this.dLeft.down || this.dRight.down
      || this.drift.down || this.item.down || this.brake.down;
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
  // Control style / sensitivity
  // =======================================================================

  /**
   * Switch steering style.
   *
   * Anything held is released FIRST. Switching style mid-hold is only reachable
   * from the pause menu (which hides the layer and releases anyway), but a style
   * change that left `swipeId` or an arrow claimed would leave a steer value with
   * no control still attached to it — the exact shape of the stuck-at-full-lock
   * bug that `lostpointercapture` exists to prevent.
   */
  setControlStyle(style: TouchControlStyle): void {
    if (this.style === style || this.disposed) return;
    this.releaseAll();
    this.style = style;
    this.applyStyle();
    this.measure();
  }

  get controlStyle(): TouchControlStyle { return this.style; }

  setSensitivity(s: SteerSensitivity): void {
    if (this.sensitivity === s || this.disposed) return;
    this.sensitivity = s;
    // Nothing to recompute: every travel and rate is a getter over this field
    // (see "Derived feel numbers"). `measure()` is still called because the
    // JOYSTICK's RAW base measurement is the one cached value, and a style or
    // layout change can have invalidated it.
    this.measure();
  }

  get steerSensitivity(): SteerSensitivity { return this.sensitivity; }

  /**
   * Show the chosen style's controls and, crucially, take the others out of the
   * hit test.
   *
   * The CSS uses `display: none`, not `opacity: 0`. An invisible-but-laid-out
   * stick pad is still 300x230 units of live `pointer-events: auto` in the corner
   * of the SWIPE surface, and would silently eat every gesture that started
   * there — a bug that looks like "swipe stops working near the bottom right".
   */
  private applyStyle(): void {
    setClass(this.root, 'ak-touch--swipe', this.style === 'swipe');
    setClass(this.root, 'ak-touch--joystick', this.style === 'joystick');
    setClass(this.root, 'ak-touch--dpad', this.style === 'dpad');
    this.refreshHint();
    this.drawGauge();
  }

  // =======================================================================
  // Per-frame sync — called from MenuSystem.update()
  // =======================================================================

  /**
   * @param phase     the race director's phase, or undefined if it has none yet
   * @param menuOpen  a menu screen, the pause screen or the results board is up
   * @param dt        seconds since the previous call, from the engine's own frame
   *                  context. REQUIRED, not optional-with-a-fallback: the D-Pad's
   *                  ramp is integrated over it, and a locally-invented dt would
   *                  be a second source of truth for frame timing that could
   *                  disagree with the one the physics uses.
   */
  sync(phase: string | undefined, menuOpen: boolean, dt: number): void {
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
    if (phaseChanged) {
      this.refreshLaunchLabel();
      // A new race earns the swipe hint back. `intro`/`countdown` is the only
      // moment it can be shown without covering something that matters.
      if (p === 'intro' || p === 'countdown') { this.swiped = false; this.refreshHint(); }
    }

    // Deferred releases: one full frame of held state per tap, no more.
    this.settle(this.drift);
    this.settle(this.item);
    this.settle(this.brake);

    // The D-Pad is the one style whose steer changes without a pointer event.
    if (this.style === 'dpad') this.tickDpad(dt);

    this.write();
  }

  /**
   * Integrate the D-Pad's ramp. See `DPAD_STEER` for what the three rates are
   * for; this is only the arithmetic.
   *
   * `dt` is clamped rather than trusted. A tab that was backgrounded, a shader
   * compile or a first frame can hand us a large delta, and `maxDelta = 6 * 0.5`
   * would step straight past every intermediate value — a ramp that skips its own
   * ramp. 50 ms is three frames at 60 Hz and one at 20 Hz, so the clamp only ever
   * bites on a hitch, where slowing the ramp is the safe direction to be wrong.
   */
  private tickDpad(dt: number): void {
    const step = clamp(dt, 0, 0.05);
    const dir = this.dpadDir();
    const target = dir * DPAD_STEER.maxSteer;
    let rate: number;
    if (target === 0) rate = DPAD_STEER.releasePerSec;
    // Opposite signs — spend the fast rate getting out of the old lock only. Once
    // zero is crossed `Math.sign(this.steer)` matches (or is 0) and the press rate
    // takes over on the very next call, so the outbound half is never rushed.
    else if (this.steer !== 0 && Math.sign(this.steer) !== Math.sign(target)) {
      rate = DPAD_STEER.reversePerSec;
    } else rate = this.dpadPressPerSec;

    const next = moveTowards(this.steer, target, rate * step);
    if (next === this.steer) return;
    this.steer = next;
    this.drawGauge();
  }

  /**
   * Which way the D-Pad is asking to steer: -1, 0 or +1.
   *
   * With both arrows held the LAST ONE PRESSED wins, rather than the two
   * cancelling to 0. A touchscreen has no mechanical interlock, so "I pressed
   * right while my left thumb was still down" is a normal thing to do, and the
   * intent of that press is unambiguous: go right. Cancelling to centre would
   * punish exactly the hurried counter-steer this style is for. Releasing the
   * newer arrow falls back to the older one, which is still held and still means
   * what it meant.
   */
  private dpadDir(): number {
    const l = this.dLeft.down, r = this.dRight.down;
    if (l && r) return this.dLast;
    if (l) return -1;
    if (r) return 1;
    return 0;
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
    this.refreshHint();
  }

  // =======================================================================
  // Steering readout (SWIPE + D-PAD) and the swipe hint
  // =======================================================================

  /**
   * Draw the steer the GAME is receiving onto the bottom-edge gauge.
   *
   * It plots `steer`, not thumb displacement, deliberately — the opposite of the
   * joystick knob, which follows the thumb so it cannot read as input lag. Here
   * there is no thumb to be out of register with, and what a player needs to see
   * is how much of the soft centre they are actually inside.
   *
   * One `transform`, so it is compositor-only and costs nothing per move:
   * `scaleX(|v|/2)` on a full-width bar with a centred origin gives a segment
   * |v|/2 as wide as the gauge, and `translateX(25% * v)` — percentages resolve
   * against the element's own UNSCALED width — slides it so one end sits exactly
   * on the centre tick and the other reaches the correct edge.
   */
  private drawGauge(): void {
    const v = clamp(this.steer, -1, 1);
    this.gaugeFill.style.transform =
      `translateX(${(v * 25).toFixed(2)}%) scaleX(${(Math.abs(v) * 0.5).toFixed(4)})`;
    setClass(this.gauge, 'ak-touch__gauge--live', v !== 0);
  }

  /**
   * The one-per-race "swipe anywhere" cue.
   *
   * Only in SWIPE style, only while the controls are up, and only until the first
   * gesture of the race. `Input.ts` records that the previous invisible touch
   * scheme was deleted for being undiscoverable, and a style whose steering
   * control is "the screen" has no affordance of its own to be discovered — so it
   * says so once, in words, and then gets out of the way for good.
   */
  private refreshHint(): void {
    const show = this.style === 'swipe' && this.touchMode && this.live && !this.swiped;
    setClass(this.hint, 'ak-touch__hint--on', show);
  }

  // =======================================================================
  // SWIPE — steering as displacement from wherever the thumb landed
  // =======================================================================

  private onSwipeDown = (e: PointerEvent): void => {
    if (this.swipeId !== -1) return;              // one gesture at a time
    this.swipeId = e.pointerId;
    // THE ORIGIN IS THE TOUCHDOWN POINT, in raw viewport coordinates.
    //
    // No `getBoundingClientRect`, no element-relative coordinate, no screen
    // fraction: origin and current position are both `clientX`, so only their
    // DIFFERENCE ever reaches the steering maths. That is what makes the style
    // identical in portrait and landscape, at the top of the screen and the
    // bottom, and for a player who holds the phone low — there is no absolute
    // position anywhere in the mapping to be interpreted differently.
    this.swipeOriginX = e.clientX;
    if (!this.swiped) { this.swiped = true; this.refreshHint(); }
    try { this.swipeSurface.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
    // Deliberately maps immediately, which for zero displacement is steer 0. The
    // gesture must not inherit whatever the previous one ended on.
    this.updateSwipe(e.clientX);
    e.preventDefault();
  };

  private onSwipeMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.swipeId) return;
    this.updateSwipe(e.clientX);
    e.preventDefault();
  };

  private onSwipeUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.swipeId) return;
    this.swipeId = -1;
    // Exactly 0, not "decays to 0". There is no sticky steering in this style:
    // the origin dies with the gesture and the next one starts from nothing.
    this.steer = 0;
    virtualController.steer = 0;
    this.drawGauge();
  };

  /**
   * Map gesture displacement to steer.
   *
   * The dead zone is subtracted and the REMAINDER is rescaled over
   * `travel - deadZone`, so full lock lands at exactly `travel` px of
   * displacement rather than at `travel + deadZone` — the dead zone costs
   * resolution, never reach. Then the curve, which `pow` pins at both ends, so the
   * soft centre cannot move where full lock is.
   */
  private updateSwipe(x: number): void {
    const dx = x - this.swipeOriginX;
    const travel = Math.max(SWIPE_STEER.deadZonePx + 1, this.swipeTravelPx);
    const dead = SWIPE_STEER.deadZonePx;
    const a = Math.abs(dx);
    const past = a <= dead ? 0 : clamp((a - dead) / (travel - dead), 0, 1);
    this.steer = past === 0 ? 0 : Math.sign(dx) * Math.pow(past, SWIPE_STEER.curve);
    virtualController.steer = this.steer;
    this.drawGauge();
  }

  // =======================================================================
  // D-PAD — direction buttons
  // =======================================================================

  private onDirDown(b: Btn, dir: 'left' | 'right', e: PointerEvent): void {
    if (b.id !== -1) return;
    b.id = e.pointerId;
    b.down = true;
    this.dLast = dir === 'left' ? -1 : 1;
    setClass(b.el, 'ak-touch__dbtn--on', true);
    try { b.el.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
    e.preventDefault();
    // Stops the press reaching anything below. The arrows sit above the SWIPE
    // surface, which is inert in this style anyway, but the guarantee should not
    // depend on which style happens to be selected.
    e.stopPropagation();
  }

  private onDirUp(b: Btn, e: PointerEvent): void {
    if (b.id !== e.pointerId) return;
    b.id = -1;
    // Cleared immediately — see `makeDirButton` for why this does NOT use the
    // action buttons' deferred release.
    b.down = false;
    setClass(b.el, 'ak-touch__dbtn--on', false);
  }

  // =======================================================================
  // Stick (JOYSTICK style)
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
    // `stickTravelPx` folds STEERING SENSITIVITY into the measured base width at
    // the moment of use. It is a getter, not a field, so there is no stored
    // product to go stale — see "Derived feel numbers" and the history of the
    // `travel = 48` duplicate.
    const t = Math.max(8, this.stickTravelPx);
    const raw = clamp(dx / t, -1, 1);
    // Dead zone, then rescale so full lock is still reachable at the edge of the
    // travel (without the rescale the last `deadZone` of the throw is lost), then
    // the response curve. Order matters: curving BEFORE the rescale would move
    // where full lock lands, and the whole point is that the edge is untouched.
    const dead = TOUCH_STEER.deadZone;
    const a = Math.abs(raw);
    const past = a < dead ? 0 : (a - dead) / (1 - dead);
    // `pow` leaves 0 at 0 and 1 at 1, so this softens the middle and nothing else.
    this.steer = past === 0 ? 0 : Math.sign(raw) * Math.pow(past, TOUCH_STEER.curve);
    // The knob follows the THUMB (`raw`), not the curved steering value. Drawing
    // it at `steer * t` would make the knob lag the finger through the soft
    // centre region and read as input lag that is not there.
    this.stickKnob.style.transform = `translate(calc(-50% + ${(raw * t).toFixed(1)}px), -50%)`;
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
    for (const b of [this.dLeft, this.dRight]) {
      b.id = -1; b.down = false; b.releasePending = false;
      setClass(b.el, 'ak-touch__dbtn--on', false);
    }
    this.dLast = 0;
    this.stickId = -1;
    this.swipeId = -1;
    this.steer = 0;
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
    this.stickBase.style.left = '';
    this.stickBase.style.top = '';
    setClass(this.stickPad, 'ak-touch__pad--held', false);
    this.drawGauge();
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
    if (!this.touchMode) return;
    // Travel comes from `TOUCH_STEER`; see that block for why it grew. This is the
    // RAW measurement — `stickTravelPx` applies sensitivity on top of it.
    //
    // Computed BEFORE the `live` check, deliberately. The stick responds to a
    // thumb whenever the layer is mounted, not only once a race is running, so
    // gating this on `live` left the pre-race stick on the initial field value —
    // which is how the old hard-coded 48 survived a change to `travelFrac`.
    //
    // The base is `display: none` in the other two styles, so `offsetWidth` is 0
    // there and this would collapse to `minTravelPx`. That is why it reads the
    // base only in the style that draws one: switching to SWIPE and back must not
    // leave the stick on the 40 px floor. Nothing else here needs a style test —
    // the clearances below are measured from whatever is actually on screen.
    if (this.style === 'joystick') {
      this.measuredStickTravel = Math.max(
        TOUCH_STEER.minTravelPx,
        this.stickBase.offsetWidth * TOUCH_STEER.travelFrac,
      );
    }
    if (!this.live) return;
    // While a thumb is on it the base has floated away from its rest position,
    // so measuring now would publish a clearance for a transient.
    if (this.stickId !== -1) return;

    const h = window.innerHeight;
    // The pad is a generous hit area; the HUD only has to clear what is DRAWN,
    // which is the steering control at rest in the pad's outer corner — the base
    // circle in JOYSTICK, the arrows in D-PAD, and nothing at all in SWIPE. Read
    // off whichever element the style actually shows, so a style with a smaller
    // (or absent) steering control hands the HUD its space back instead of
    // reserving a footprint for a control that is not there.
    const steerEl = this.style === 'joystick' ? this.stickBase
      : this.style === 'dpad' ? this.dpadEl
        : null;
    const acts = this.actsEl.getBoundingClientRect();
    const pause = this.pauseBtn.getBoundingClientRect();

    const steerClear = steerEl ? Math.max(0, h - steerEl.getBoundingClientRect().top) : 0;
    const actsClear = Math.max(0, h - acts.top);
    const steerOnLeft = this.layout === 'stick-left';
    const left = steerOnLeft ? steerClear : actsClear;
    const right = steerOnLeft ? actsClear : steerClear;
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
    window.removeEventListener('blur', this.onInterrupt);
    document.removeEventListener('visibilitychange', this.onInterrupt);
    this.pointerQuery?.removeEventListener?.('change', this.onPointerCapabilityChange);
    this.releaseAll();
    this.clearClearances();
    document.documentElement.classList.remove('ak-touch-mode');
    this.root.remove();
  }
}
