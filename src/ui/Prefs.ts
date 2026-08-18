/**
 * ============================================================================
 *  FOXY KART — PERSISTED UI PREFERENCES
 * ============================================================================
 *  One small, generic, UI-only store. Nothing in `src/game`, `src/physics` or
 *  `src/core` reads it; gameplay code is handed values by the UI exactly as it
 *  was before this file existed.
 *
 *  WHY IT IS A `readChoice` / `writeChoice` PAIR AND NOT A TYPED `UiPrefs` BLOB
 *  A blob has to be validated field by field anyway, and the failure it has to
 *  survive is not "the shape changed" — it is "the value on disk is not one of
 *  the values this build knows about". A player who used a build where the
 *  control style could be `wheel`, or who edited `localStorage` by hand, must
 *  land on the default and not on a mode with no code behind it. So the allowed
 *  set is passed in at every read and the fallback is mandatory: an unrecognised
 *  string cannot reach the app, and adding a setting is one line at the call
 *  site with no schema to migrate.
 *
 *  WHY EVERY ACCESS IS WRAPPED
 *  `localStorage` is not merely empty in a hostile environment, it THROWS:
 *  Safari in Lockdown/private mode throws `SecurityError` on the property
 *  access itself, and a full quota throws on `setItem`. Both would be an
 *  uncaught exception during `MenuSystem`'s constructor, i.e. a black screen
 *  before the title card, in exchange for remembering a menu row. Every path
 *  here degrades to "this build just doesn't remember", which is precisely the
 *  behaviour the game had before.
 *
 *  Keys are namespaced and versioned (`fk.v1.*`) so a future incompatible
 *  meaning for the same setting can be introduced by bumping `NS` rather than
 *  by writing migration code for a two-line store.
 * ============================================================================
 */

const NS = 'fk.v1.';

/** `localStorage`, or null if this environment refuses to give us one. */
function store(): Storage | null {
  try {
    // The property access itself is what throws in Lockdown mode, so it has to
    // be inside the try — a `typeof` guard outside would not help.
    const s = window.localStorage;
    // A stubbed-out storage that accepts writes and drops them is fine; one that
    // is missing methods is not, and would throw later instead of here.
    return s && typeof s.getItem === 'function' && typeof s.setItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

/**
 * Read a persisted enum-ish setting.
 *
 * @param key      short name, namespaced internally
 * @param allowed  every value this build understands
 * @param fallback returned when nothing is stored, storage is unavailable, or
 *                 the stored string is not in `allowed`
 */
export function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const s = store();
  if (!s) return fallback;
  let raw: string | null = null;
  try { raw = s.getItem(NS + key); } catch { return fallback; }
  if (raw === null) return fallback;
  // The cast is safe only because of the `includes` test — that test is the
  // whole point of this function.
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Persist a setting. Silently does nothing where storage is unavailable. */
export function writeChoice(key: string, value: string): void {
  const s = store();
  if (!s) return;
  try { s.setItem(NS + key, value); } catch { /* full, or refused — not fatal */ }
}

/** Forget a setting. Used by QA to prove a default is a default. */
export function clearChoice(key: string): void {
  const s = store();
  if (!s) return;
  try { s.removeItem(NS + key); } catch { /* nothing we can do or need to do */ }
}

/** Setting names, in one place so a typo cannot silently create a second key. */
export const PREF_KEYS = {
  controlStyle: 'touch.controlStyle',
  touchLayout: 'touch.layout',
  steerSensitivity: 'touch.steerSensitivity',
} as const;
