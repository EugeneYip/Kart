/**
 * ============================================================================
 *  APEX KART — ITEM ROULETTE
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
 * ============================================================================
 */

import { ItemType } from '@/core/Types';
import { clamp, clamp01, lerp, smoothstep } from '@/core/MathUtils';

export const ITEM_COUNT = 16;
/** Table is authored for a full 12-kart grid. */
export const TABLE_SLOTS = 12;

// ---------------------------------------------------------------------------
// Authored weights
// ---------------------------------------------------------------------------

type Row = ReadonlyArray<readonly [ItemType, number]>;

/**
 * Weights per grid position (index 0 = 1st place ... index 11 = 12th).
 * Values are relative; they get normalised at build time.
 *
 * Reading this table top to bottom you should see:
 *   coins/bananas/green shells fade out, mushrooms peak mid-pack,
 *   red shells peak around 4th-7th, and star/bullet/lightning only appear
 *   deep in the field.
 */
const ROWS: readonly Row[] = [
  // 1st — pure defence.
  [[ItemType.Coin, 40], [ItemType.Banana, 26], [ItemType.GreenShell, 20],
   [ItemType.TripleBanana, 7], [ItemType.TripleGreenShell, 5], [ItemType.Boost, 2]],
  // 2nd
  [[ItemType.Coin, 30], [ItemType.Banana, 22], [ItemType.GreenShell, 21],
   [ItemType.TripleBanana, 8], [ItemType.TripleGreenShell, 7], [ItemType.Boost, 7],
   [ItemType.RedShell, 5]],
  // 3rd
  [[ItemType.Coin, 20], [ItemType.Banana, 17], [ItemType.GreenShell, 17],
   [ItemType.RedShell, 14], [ItemType.Boost, 12], [ItemType.TripleBanana, 8],
   [ItemType.TripleGreenShell, 7], [ItemType.Bomb, 5]],
  // 4th — blue shell unlocks here.
  [[ItemType.Coin, 12], [ItemType.Banana, 13], [ItemType.GreenShell, 13],
   [ItemType.RedShell, 18], [ItemType.Boost, 14], [ItemType.TripleGreenShell, 8],
   [ItemType.TripleBanana, 6], [ItemType.Bomb, 7], [ItemType.Squid, 4],
   [ItemType.Ghost, 3], [ItemType.BlueShell, 2]],
  // 5th
  [[ItemType.Coin, 8], [ItemType.Banana, 10], [ItemType.GreenShell, 10],
   [ItemType.RedShell, 18], [ItemType.Boost, 15], [ItemType.TripleBoost, 5],
   [ItemType.TripleRedShell, 4], [ItemType.TripleGreenShell, 6], [ItemType.Bomb, 8],
   [ItemType.Squid, 6], [ItemType.Ghost, 4], [ItemType.BlueShell, 4]],
  // 6th — star + bullet unlock here.
  [[ItemType.Coin, 5], [ItemType.Banana, 7], [ItemType.GreenShell, 7],
   [ItemType.RedShell, 16], [ItemType.Boost, 15], [ItemType.TripleBoost, 7],
   [ItemType.TripleRedShell, 6], [ItemType.TripleGreenShell, 5], [ItemType.Bomb, 8],
   [ItemType.Squid, 7], [ItemType.Ghost, 5], [ItemType.BlueShell, 5],
   [ItemType.Star, 5], [ItemType.Bullet, 2]],
  // 7th
  [[ItemType.Coin, 3], [ItemType.Banana, 5], [ItemType.GreenShell, 5],
   [ItemType.RedShell, 13], [ItemType.Boost, 14], [ItemType.TripleBoost, 10],
   [ItemType.TripleRedShell, 7], [ItemType.TripleGreenShell, 4], [ItemType.Bomb, 7],
   [ItemType.Squid, 7], [ItemType.Ghost, 6], [ItemType.BlueShell, 6],
   [ItemType.Star, 8], [ItemType.Bullet, 3], [ItemType.Lightning, 2]],
  // 8th
  [[ItemType.Banana, 3], [ItemType.GreenShell, 3], [ItemType.RedShell, 10],
   [ItemType.Boost, 13], [ItemType.TripleBoost, 12], [ItemType.TripleRedShell, 8],
   [ItemType.Bomb, 6], [ItemType.Squid, 6], [ItemType.Ghost, 7],
   [ItemType.BlueShell, 6], [ItemType.Star, 11], [ItemType.Bullet, 6],
   [ItemType.Lightning, 5]],
  // 9th
  [[ItemType.Banana, 2], [ItemType.GreenShell, 2], [ItemType.RedShell, 8],
   [ItemType.Boost, 12], [ItemType.TripleBoost, 14], [ItemType.TripleRedShell, 9],
   [ItemType.Bomb, 5], [ItemType.Squid, 5], [ItemType.Ghost, 7],
   [ItemType.BlueShell, 5], [ItemType.Star, 13], [ItemType.Bullet, 10],
   [ItemType.Lightning, 8]],
  // 10th
  [[ItemType.RedShell, 6], [ItemType.Boost, 11], [ItemType.TripleBoost, 16],
   [ItemType.TripleRedShell, 9], [ItemType.Bomb, 4], [ItemType.Squid, 4],
   [ItemType.Ghost, 6], [ItemType.BlueShell, 4], [ItemType.Star, 15],
   [ItemType.Bullet, 14], [ItemType.Lightning, 11]],
  // 11th
  [[ItemType.RedShell, 4], [ItemType.Boost, 10], [ItemType.TripleBoost, 17],
   [ItemType.TripleRedShell, 8], [ItemType.Bomb, 3], [ItemType.Squid, 3],
   [ItemType.Ghost, 6], [ItemType.BlueShell, 3], [ItemType.Star, 17],
   [ItemType.Bullet, 17], [ItemType.Lightning, 12]],
  // 12th — desperation.
  [[ItemType.RedShell, 3], [ItemType.Boost, 9], [ItemType.TripleBoost, 18],
   [ItemType.TripleRedShell, 7], [ItemType.Bomb, 2], [ItemType.Squid, 2],
   [ItemType.Ghost, 5], [ItemType.BlueShell, 2], [ItemType.Star, 18],
   [ItemType.Bullet, 21], [ItemType.Lightning, 13]],
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

/** Earliest position (1-based, projected onto a 12-kart field) per item. */
const MIN_SLOT: Partial<Record<ItemType, number>> = {
  [ItemType.BlueShell]: 4,
  [ItemType.Star]: 6,
  [ItemType.Bullet]: 6,
  [ItemType.Lightning]: 7,
};

/** Latest position an item may appear at — keeps the leader honest. */
const MAX_SLOT: Partial<Record<ItemType, number>> = {
  [ItemType.Coin]: 8,
};

export const LIGHTNING_COOLDOWN = 22.0;
export const BLUE_SHELL_COOLDOWN = 9.0;

export interface RollContext {
  /** 1-based race position. */
  position: number;
  totalKarts: number;
  /** 0 = final lap. Used to suppress bullets on the run to the line. */
  lapsRemaining: number;
  /** False while the global lightning cooldown is ticking. */
  lightningReady: boolean;
  blueShellReady: boolean;
  /** Only one bullet / blue shell may exist at a time. */
  bulletInPlay: boolean;
  blueShellInPlay: boolean;
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

/** Draw one item. Never returns null — falls back to a banana. */
export function rollItem(ctx: RollContext): ItemType {
  weightsFor(ctx.position, ctx.totalKarts, scratchW);
  const vs = virtualSlot(ctx.position, ctx.totalKarts);

  for (let i = 0; i < ITEM_COUNT; i++) {
    if (scratchW[i] <= 0) continue;
    const item = i as ItemType;
    const min = MIN_SLOT[item];
    if (min !== undefined && vs < min - 0.001) { scratchW[i] = 0; continue; }
    const max = MAX_SLOT[item];
    if (max !== undefined && vs > max + 0.001) { scratchW[i] = 0; continue; }
    if (item === ItemType.Lightning && !ctx.lightningReady) { scratchW[i] = 0; continue; }
    if (item === ItemType.BlueShell && (!ctx.blueShellReady || ctx.blueShellInPlay)) { scratchW[i] = 0; continue; }
    if (item === ItemType.Bullet && ctx.bulletInPlay) { scratchW[i] = 0; continue; }
    // A bullet on the final straight is a guaranteed win — tone it down.
    if (item === ItemType.Bullet && ctx.lapsRemaining <= 0) scratchW[i] *= 0.35;
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

/** How many uses a granted item is worth. */
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

/** Order the slot cycles through — deliberately mixed so it reads as random. */
const SPIN_ORDER: readonly ItemType[] = [
  ItemType.Banana, ItemType.GreenShell, ItemType.Boost, ItemType.RedShell,
  ItemType.Bomb, ItemType.TripleBanana, ItemType.Star, ItemType.Coin,
  ItemType.TripleGreenShell, ItemType.Squid, ItemType.Lightning, ItemType.TripleBoost,
  ItemType.Ghost, ItemType.TripleRedShell, ItemType.Bullet, ItemType.BlueShell,
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
