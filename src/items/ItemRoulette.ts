/**
 * ============================================================================
 *  FOXY KART — ITEM ROULETTE
 * ============================================================================
 *  Two things live here:
 *
 *   1. The position-weighted probability table. MK8's whole rubber-band design
 *      is in this table: the leader gets defensive junk, the tail gets the
 *      race-changing stuff. The table is authored per grid slot for a 12-kart
 *      field and re-projected for smaller fields.
 *
 *   2. The roulette *animation* — the slot machine that spins for ~1.1 s after
 *      you touch a box, decelerating into a lock + flash. The HUD reads
 *      `getDisplay()` every frame; gameplay reads `getResult()` once locked.
 *
 *  Zero allocation after construction.
 *
 *  ---------------------------------------------------------------------------
 *  P0d-D5 — THE ITEM SET IS FIVE ITEMS, DELIBERATELY.
 *
 *  The set was sixteen `ItemType` values across seven families with a ×1 and a
 *  ×3 tier for three of them. It is now five, one tier each:
 *
 *      ROCKET          homes on the kart ahead      (ItemType.RedShell)
 *      PLASTIC BOTTLE  small obstacle               (ItemType.Banana)
 *      BATTERY         speed boost                  (ItemType.Boost)
 *      NINJA           steals an item               (ItemType.Ghost)
 *      STAR            immune to everything         (ItemType.Star)
 *
 *  The `ItemType` enum lives in `src/core/Types.ts`, which this agent may not
 *  edit, so the five survivors are addressed by their existing enum members
 *  (given in brackets above). Every other member — the triples, green shell,
 *  bob-omb, blue shell, coin, bullet, ink and lightning — has a weight of zero
 *  in every row and is therefore unreachable through a box. `grantItem()` can
 *  still hand one over for the dev harness and cheats, and `ItemSystem.use()`
 *  still knows what to do with it; nothing in a race will ever produce one.
 *
 *  Ink and Lightning are gone as *design*, not merely down-weighted: see the
 *  note on orphaned VFX/audio in ItemSystem.
 * ============================================================================
 */

import { ItemType } from '@/core/Types';
import { clamp, clamp01, lerp, smoothstep } from '@/core/MathUtils';

export const ITEM_COUNT = 16;
/** Table is authored for a full 12-kart grid. */
export const TABLE_SLOTS = 12;

/**
 * The live set, in HUD/roulette reading order. Anything not in here has weight
 * zero everywhere. Exported so tooling can assert the set rather than guess it.
 */
export const LIVE_ITEMS: readonly ItemType[] = [
  ItemType.Banana,   // Plastic Bottle
  ItemType.Boost,    // Battery
  ItemType.RedShell, // Rocket
  ItemType.Ghost,    // Ninja
  ItemType.Star,     // Star
];

// ---------------------------------------------------------------------------
// Authored weights
// ---------------------------------------------------------------------------

type Row = ReadonlyArray<readonly [ItemType, number]>;

/**
 * Weights per grid position (index 0 = 1st place ... index 11 = 12th).
 * Values are relative; they get normalised at build time. Every row here is
 * authored to sum to 100 so it can be read as a percentage at a glance.
 *
 * Reading the table top to bottom you should see the classic shape, now with a
 * much shorter cast: the bottle (junk you drop behind you) collapses from 62 %
 * to 2 %, the battery is a steady mid-tier everywhere, the rocket peaks around
 * 5th–7th where there is someone in range to shoot, and the ninja and star only
 * turn up once you are genuinely behind.
 *
 * With five items the leader must NOT be able to draw a rocket often: at 8 % it
 * is a rare treat, not a tool. That single number is what stops the front of the
 * field snowballing.
 */
const ROWS: readonly Row[] = [
  // 1st — defence only. Bottle to guard your back, battery to hold the gap.
  [[ItemType.Banana, 62], [ItemType.Boost, 30], [ItemType.RedShell, 8]],
  // 2nd
  [[ItemType.Banana, 54], [ItemType.Boost, 33], [ItemType.RedShell, 13]],
  // 3rd — ninja unlocks here.
  [[ItemType.Banana, 44], [ItemType.Boost, 34], [ItemType.RedShell, 20],
   [ItemType.Ghost, 2]],
  // 4th
  [[ItemType.Banana, 34], [ItemType.Boost, 34], [ItemType.RedShell, 26],
   [ItemType.Ghost, 6]],
  // 5th
  [[ItemType.Banana, 26], [ItemType.Boost, 33], [ItemType.RedShell, 30],
   [ItemType.Ghost, 11]],
  // 6th — star unlocks here.
  [[ItemType.Banana, 19], [ItemType.Boost, 31], [ItemType.RedShell, 31],
   [ItemType.Ghost, 13], [ItemType.Star, 6]],
  // 7th
  [[ItemType.Banana, 14], [ItemType.Boost, 29], [ItemType.RedShell, 30],
   [ItemType.Ghost, 15], [ItemType.Star, 12]],
  // 8th
  [[ItemType.Banana, 10], [ItemType.Boost, 27], [ItemType.RedShell, 28],
   [ItemType.Ghost, 17], [ItemType.Star, 18]],
  // 9th
  [[ItemType.Banana, 7], [ItemType.Boost, 25], [ItemType.RedShell, 25],
   [ItemType.Ghost, 19], [ItemType.Star, 24]],
  // 10th
  [[ItemType.Banana, 5], [ItemType.Boost, 23], [ItemType.RedShell, 22],
   [ItemType.Ghost, 20], [ItemType.Star, 30]],
  // 11th
  [[ItemType.Banana, 3], [ItemType.Boost, 21], [ItemType.RedShell, 19],
   [ItemType.Ghost, 21], [ItemType.Star, 36]],
  // 12th — desperation.
  [[ItemType.Banana, 2], [ItemType.Boost, 19], [ItemType.RedShell, 16],
   [ItemType.Ghost, 21], [ItemType.Star, 42]],
];

/** Row-major [slot * ITEM_COUNT + item], each row normalised to sum 1. */
const TABLE = new Float64Array(TABLE_SLOTS * ITEM_COUNT);
for (let s = 0; s < TABLE_SLOTS; s++) {
  let sum = 0;
  for (const [item, w] of ROWS[s]) { TABLE[s * ITEM_COUNT + (item as number)] = w; sum += w; }
  if (sum > 0) for (let i = 0; i < ITEM_COUNT; i++) TABLE[s * ITEM_COUNT + i] /= sum;
}

/** Read-only view of the normalised distribution, for dev tooling / tests. */
export function tableRow(slot: number): Float64Array {
  const s = clamp(Math.round(slot) - 1, 0, TABLE_SLOTS - 1);
  return TABLE.subarray(s * ITEM_COUNT, s * ITEM_COUNT + ITEM_COUNT);
}

// ---------------------------------------------------------------------------
// Availability rules layered on top of the table
// ---------------------------------------------------------------------------

/**
 * Earliest position (1-based, projected onto a 12-kart field) per item.
 *
 * A hard floor on top of the weights, so interpolating between rows for a
 * short field can never leak a star to 5th on an 8-kart grid.
 */
const MIN_SLOT: Partial<Record<ItemType, number>> = {
  [ItemType.Ghost]: 3,
  [ItemType.Star]: 6,
};

/**
 * Global cooldown on the blue shell, seconds.
 *
 * Kept because `ItemSystem.use()` still services a blue shell handed over by
 * `grantItem()` (dev harness / cheats). The roulette can no longer produce one.
 */
export const BLUE_SHELL_COOLDOWN = 9.0;

export interface RollContext {
  /** 1-based race position. */
  position: number;
  totalKarts: number;
  /** Uniform [0,1). */
  rand: () => number;
}

// Module-level scratch — roll() must not allocate.
const scratchW = new Float64Array(ITEM_COUNT);

/**
 * Project a real position onto the 12-slot table and blend the two
 * neighbouring rows, so an 8-kart race still spans the full spread.
 */
export function weightsFor(position: number, totalKarts: number, out: Float64Array): void {
  const total = Math.max(2, totalKarts);
  const p = clamp(position, 1, total);
  const virtual = 1 + ((p - 1) * (TABLE_SLOTS - 1)) / (total - 1);
  const lo = Math.floor(virtual);
  const hi = Math.min(TABLE_SLOTS, lo + 1);
  const f = virtual - lo;
  const a = (lo - 1) * ITEM_COUNT;
  const b = (hi - 1) * ITEM_COUNT;
  for (let i = 0; i < ITEM_COUNT; i++) out[i] = lerp(TABLE[a + i], TABLE[b + i], f);
}

/** Position on the 12-slot scale, used by the min/max rules. */
export function virtualSlot(position: number, totalKarts: number): number {
  const total = Math.max(2, totalKarts);
  const p = clamp(position, 1, total);
  return 1 + ((p - 1) * (TABLE_SLOTS - 1)) / (total - 1);
}

/** Draw one item. Never returns null — falls back to the Plastic Bottle. */
export function rollItem(ctx: RollContext): ItemType {
  weightsFor(ctx.position, ctx.totalKarts, scratchW);
  const vs = virtualSlot(ctx.position, ctx.totalKarts);

  for (let i = 0; i < ITEM_COUNT; i++) {
    if (scratchW[i] <= 0) continue;
    const min = MIN_SLOT[i as ItemType];
    if (min !== undefined && vs < min - 0.001) scratchW[i] = 0;
  }

  let sum = 0;
  for (let i = 0; i < ITEM_COUNT; i++) sum += scratchW[i];
  if (sum <= 0) return ItemType.Banana;

  let r = ctx.rand() * sum;
  for (let i = 0; i < ITEM_COUNT; i++) {
    r -= scratchW[i];
    if (r <= 0) return i as ItemType;
  }
  return ItemType.Banana;
}

/**
 * How many uses a granted item is worth.
 *
 * Always 1 now: there are no tiered items. The function stays because the triple
 * `ItemType` members still exist in the enum and `grantItem()` can be handed one
 * — a triple granted by hand still behaves like a triple.
 */
export function itemUses(item: ItemType): number {
  switch (item) {
    case ItemType.TripleBoost:
    case ItemType.TripleGreenShell:
    case ItemType.TripleRedShell:
    case ItemType.TripleBanana:
      return 3;
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// The spinning slot
// ---------------------------------------------------------------------------

export const ROULETTE_DURATION = 1.1;
/** Hurrying still leaves enough spin to read the deceleration. */
export const ROULETTE_MIN_REMAINING = 0.24;

/**
 * Order the slot cycles through — deliberately mixed so it reads as random.
 *
 * Only the five live items appear: a slot that flashes a lightning bolt you can
 * never win is a lie to the player. Eight entries over five items so the cycle
 * is not obviously short at the slow end of the ratchet.
 */
const SPIN_ORDER: readonly ItemType[] = [
  ItemType.Banana, ItemType.Boost, ItemType.RedShell, ItemType.Star,
  ItemType.Ghost, ItemType.Boost, ItemType.Banana, ItemType.RedShell,
];

interface Slot {
  active: boolean;
  result: ItemType;
  display: ItemType;
  t: number;
  duration: number;
  phase: number;
  /** 1 -> 0 flash envelope after the lock. */
  flash: number;
  locked: boolean;
}

/**
 * One slot per kart. `begin` is called when a box is collected; `advance` is
 * driven from fixedUpdate; the HUD polls `getDisplay`/`getFlash`.
 */
export class ItemRoulette {
  private slots: Slot[] = [];

  constructor(maxKarts = 12) {
    for (let i = 0; i < maxKarts; i++) {
      this.slots.push({
        active: false, result: ItemType.Banana, display: ItemType.Banana,
        t: 0, duration: ROULETTE_DURATION, phase: 0, flash: 0, locked: false,
      });
    }
  }

  private slot(kartId: number): Slot | null {
    return this.slots[kartId] ?? null;
  }

  isSpinning(kartId: number): boolean {
    const s = this.slot(kartId);
    return !!s && s.active && !s.locked;
  }

  /** Start a spin that will land on `result`. */
  begin(kartId: number, result: ItemType, fast = false): void {
    const s = this.slot(kartId);
    if (!s) return;
    s.active = true;
    s.locked = false;
    s.result = result;
    s.t = 0;
    s.duration = fast ? 0.42 : ROULETTE_DURATION;
    s.phase = Math.random() * SPIN_ORDER.length;
    s.flash = 0;
    s.display = SPIN_ORDER[Math.floor(s.phase) % SPIN_ORDER.length];
  }

  /** Player mashed the item button — cut the spin short. */
  hurry(kartId: number): boolean {
    const s = this.slot(kartId);
    if (!s || !s.active || s.locked) return false;
    s.duration = Math.min(s.duration, s.t + ROULETTE_MIN_REMAINING);
    return true;
  }

  /**
   * @returns the item if the spin locked this step, otherwise null.
   */
  advance(kartId: number, dt: number): ItemType | null {
    const s = this.slot(kartId);
    if (!s) return null;
    if (s.flash > 0) s.flash = Math.max(0, s.flash - dt * 2.6);
    if (!s.active || s.locked) return null;

    s.t += dt;
    const k = clamp01(s.t / s.duration);

    // Cycle interval ramps 38 ms -> 210 ms: fast blur, then a visible ratchet.
    const interval = lerp(0.038, 0.21, smoothstep(k) * k);
    s.phase += dt / interval;

    if (k >= 1) {
      s.locked = true;
      s.active = false;
      s.display = s.result;
      s.flash = 1;
      return s.result;
    }
    // Last beat before the lock parks on the winning face so it doesn't jump.
    if (k > 0.9) s.display = s.result;
    else s.display = SPIN_ORDER[Math.floor(s.phase) % SPIN_ORDER.length];
    return null;
  }

  /** What the HUD should draw right now, or null if the slot is empty. */
  getDisplay(kartId: number): ItemType | null {
    const s = this.slot(kartId);
    if (!s) return null;
    if (s.active || s.flash > 0) return s.display;
    return null;
  }

  /** 0..1 lock-flash envelope, for the HUD's white pop. */
  getFlash(kartId: number): number {
    return this.slot(kartId)?.flash ?? 0;
  }

  /** 0..1 spin progress; 0 when idle. */
  getProgress(kartId: number): number {
    const s = this.slot(kartId);
    if (!s || !s.active) return 0;
    return clamp01(s.t / s.duration);
  }

  cancel(kartId: number): void {
    const s = this.slot(kartId);
    if (!s) return;
    s.active = false;
    s.locked = false;
    s.flash = 0;
  }

  reset(): void {
    for (const s of this.slots) {
      s.active = false; s.locked = false; s.flash = 0; s.t = 0; s.phase = 0;
    }
  }
}
