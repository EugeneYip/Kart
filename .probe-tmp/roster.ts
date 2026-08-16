/**
 * Does a 12-kart grid contain twelve distinguishable racers?
 *
 * `KartManager.buildRoster` is private and the class needs a renderer, physics and
 * a track to construct, so this reimplements nothing: it imports the real
 * `CHARACTERS` table and calls the real function through a structural clone of
 * only the two fields `buildRoster` touches. If the roster table changes size,
 * this probe moves with it.
 *
 * The check that matters is NAME collision, not id collision. The kart paint is
 * already hue-shifted per repeat inside `createVisual` (`variant` counts earlier
 * karts with the same character id), so a repeat is a differently-painted kart —
 * but the leaderboard, the results board and the rival readout all print
 * `character.name`, and that was not touched.
 *
 * RED CHECK at the bottom: the probe is re-run against a deliberately duplicated
 * roster and must fail. A probe that has never been seen to fail is worth nothing,
 * and this project has shipped at least nine of those.
 */
import { CHARACTERS, CHARACTER_BY_ID, type CharacterDef } from '@/karts/Characters';
import { buildRosterFrom as buildRoster } from '@/karts/KartManager';
import { CHARACTER_STATS } from '@/physics/Tuning';

const GRID = 12;

// ---- THIS PROBE USED TO GRADE A COPY OF THE CODE IT GUARDS ------------------
// The header above once said "this reimplements nothing… calls the real function
// through a structural clone", and twenty lines later hand-transcribed
// `KartManager.buildRoster`. It never imported `KartManager` at all. The
// transcription was faithful on the day it was written, so the verdict it gave
// was correct — but it could not see the file it guards change, which is the
// entire job. An adversarial critic pass caught it.
//
// `buildRoster` was private, so the fix was to lift the rule out of the class as
// `buildRosterFrom` and have the method delegate to it. This now imports the
// shipping function. If that loop changes, this probe changes with it.

let fail = 0;
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label.padEnd(48)} ${detail}`);
};

function grade(
  table: readonly CharacterDef[],
  byId: Readonly<Record<string, CharacterDef>>,
  label: string,
): number {
  let bad = 0;
  const localCheck = (ok: boolean, l: string, d: string): void => {
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${l.padEnd(48)} ${d}`);
  };
  console.log(`\n${label}  (roster ${table.length}, grid ${GRID})`);

  // Every character gets a turn as the player: the player is spliced out of
  // `rest`, so a collision can depend on who is driving.
  for (const p of table) {
    const roster = buildRoster(table, byId, p.id, GRID);
    const names = roster.map((c) => c.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0) {
      localCheck(false, `player=${p.id}: distinct names on the grid`,
        `${dupes.length} repeated: ${[...new Set(dupes)].join(', ')}`);
    }
  }
  if (bad === 0) localCheck(true, `distinct names, all ${table.length} player choices`, `${GRID} racers each`);

  // A relabelled repeat must keep its id, or `makeTuning(id)` returns the wrong
  // chassis and `CHARACTER_BY_ID` lookups (portraits, paint keys) miss.
  const roster = buildRoster(table, byId, table[0].id, GRID);
  const orphan = roster.filter((c) => byId[c.id] === undefined);
  localCheck(orphan.length === 0, 'every entry id resolves in CHARACTER_BY_ID',
    orphan.length ? orphan.map((c) => c.id).join(', ') : 'all 12');

  const untuned = roster.filter((c) => CHARACTER_STATS[c.id] === undefined);
  localCheck(untuned.length === 0, 'every entry id has a physics tuning',
    untuned.length ? untuned.map((c) => c.id).join(', ') : 'all 12');

  // The grid is only fully distinct when supply meets demand.
  localCheck(table.length >= GRID, `roster supplies ${GRID} distinct characters`,
    table.length >= GRID ? `${table.length} available`
      : `only ${table.length} — ${GRID - table.length} racer(s) must be a relabelled repeat`);

  return bad;
}

fail += grade(CHARACTERS, CHARACTER_BY_ID, 'SHIPPING ROSTER');

// --- RED CHECK -------------------------------------------------------------
// RE-ANCHORED. This used to replay the old loop over the SHIPPING roster, which
// worked only while the roster was short of the grid. The roster is twelve now,
// so that version produced no repeats to detect and the check quietly stopped
// testing anything — it reported "probe is vacuous" against itself, which is the
// correct complaint but not a useful one.
//
// The subject is the RELABELLING, not the roster size, so the red check now runs
// against a synthetic ten-entry roster: the condition the relabelling exists for,
// held fixed regardless of how many characters ship. Two arms, because one alone
// cannot separate "the relabel works" from "there was nothing to relabel".
console.log('\nRED CHECK  — synthetic 10-entry roster, the case the relabel exists for');
{
  const short = CHARACTERS.slice(0, 10);
  const shortById = Object.fromEntries(short.map((c) => [c.id, c]));

  // (a) the OLD code path must still produce colliding names on this roster.
  const player = short[0];
  const rest = short.filter((c) => c.id !== player.id);
  const old: CharacterDef[] = [player];
  for (let i = 0; old.length < GRID; i++) old.push(rest[i % rest.length]);
  const oldNames = old.map((c) => c.name);
  const dupes = [...new Set(oldNames.filter((n, i) => oldNames.indexOf(n) !== i))];
  check(dupes.length > 0, 'old path still collides on a 10-roster',
    dupes.length ? `repeated: ${dupes.join(', ')}` : 'NO DUPES — this check is vacuous');

  // (b) the SHIPPING path must not, on the same roster.
  const now = buildRoster(short, shortById, player.id, GRID);
  const nowNames = now.map((c) => c.name);
  const still = [...new Set(nowNames.filter((n, i) => nowNames.indexOf(n) !== i))];
  check(still.length === 0, 'shipping path relabels them apart',
    still.length ? `STILL repeated: ${still.join(', ')}` : `${GRID} distinct, e.g. "${now[GRID - 1].name}"`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
