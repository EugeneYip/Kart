/**
 * Headless entry point for the physics assertion battery.
 *
 *     node src/dev/node-run.mjs src/dev/physics-run.ts
 *
 * Exits non-zero when any assertion fails, so it can gate a commit.
 */

import { reportText, runAll } from './physics-tests';

const report = reportText();
// eslint-disable-next-line no-console
console.log(report);

// `reportText` already ran the battery; re-derive the counts from the text so we
// do not pay for a second 60 s fuzz pass just to learn the exit code.
const m = /(\d+) passed \/ (\d+) failed/.exec(report);
const failed = m ? Number(m[2]) : 1;
void runAll;
process.exit(failed === 0 ? 0 : 1);
