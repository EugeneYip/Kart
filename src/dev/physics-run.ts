/**
 * Headless entry point for the physics assertion battery.
 *
 *     node src/dev/node-run.mjs src/dev/physics-run.ts
 *
 * Exits non-zero when any assertion fails, so it can gate a commit.
 */

// `node:process` is imported EXPLICITLY rather than using the `process` global.
//
// `tsconfig.compilerOptions.types` is `["vite/client"]`, which deliberately
// restricts AMBIENT global typings to the browser surface — so `process` is not
// a global here even with `@types/node` installed, and it should not be: this is
// a browser game and gameplay code has no business seeing Node globals.
//
// An explicit `node:*` import is a different mechanism. It resolves through
// normal module resolution against `@types/node`, independent of the `types`
// array, so it type-checks without widening the global surface for the other 100
// files. `vite.config.ts`'s `node:url` import works the same way, which is why
// installing the typings was enough for it and this file needed one more line.
//
// This is what broke the first clean CI build: `@types/node` was never declared
// in `package.json`, so `npm ci` on a clean runner produced "Cannot find name
// 'process'" here and "Cannot find name 'node:url'" in `vite.config.ts`, while a
// local `node_modules` that had drifted ahead of the lockfile compiled fine.
import { exit } from 'node:process';
import { reportText, runAll } from './physics-tests';

const report = reportText();
// eslint-disable-next-line no-console
console.log(report);

// `reportText` already ran the battery; re-derive the counts from the text so we
// do not pay for a second 60 s fuzz pass just to learn the exit code.
const m = /(\d+) passed \/ (\d+) failed/.exec(report);
const failed = m ? Number(m[2]) : 1;
void runAll;
exit(failed === 0 ? 0 : 1);
