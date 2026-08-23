# Foxy Kart — handoff

**The live working note between sessions.** One page. If it grows past two, the
content belongs somewhere else — see [Where things go](#where-things-go).

Baseline: `627401c24ad7e4ea114f25e828234a286c171277`, committed **2026-08-18**.
Nothing has landed since, so that commit date is also the age of this state.

---

## Read these first

New here with no conversation history? Follow the bootstrap list in
[`README.md`](README.md), then read [`PROJECT_STATE.md`](PROJECT_STATE.md) and
[`AGENTS.md`](AGENTS.md). This file assumes you have.

---

## State at handoff

`Directly verified:` re-checked at this baseline on 2026-08-23, five days after
the commit, with no intervening work —

- `main` and `origin/main` at the baseline SHA above.
- The tree was clean at the baseline commit. It will NOT look clean while a
  session is in progress — judge the baseline by `git rev-parse HEAD`, never by
  the absence of local edits.
- `rm -rf node_modules && npm ci && npm run build` → **exit 0**.
- Production is live at <https://kart.eugeneyip.com/> and `main` deploys on push.

## In flight

**Nothing.** There is no active implementation task and no half-finished branch
on `main`. You are starting from a green baseline.

The two remote branches `agent/web-identity-seo` and `web-identity-seo` sit one
commit behind `main` and are fully superseded. Ignore them.

## Known, not urgent

Full detail with measurements is in [`PROJECT_STATE.md` §4](PROJECT_STATE.md).
In one line each:

- The headless physics battery reports **34 passed / 8 failed**. Four failures
  read `Infinity %`, which may indicate a broken probe rather than broken
  physics. Diagnose the denominator before touching `src/physics/`, and do not
  widen a tolerance to make anything pass.
- `tsconfig.render-check.json` reports one error that the root `tsconfig.json`
  does not, over the same file. Affects only the optional scoped gate; CI and
  the shipped artifact are unaffected.
- A handful of cosmetic inconsistencies: an unused `scratch` export, an empty
  portrait media query, two overlapping texture libraries, one stale comment.

## If you are about to change something

1. Confirm the baseline first (`git status`, `git rev-parse HEAD`). If it does
   not match this file, **this file is stale** — trust the code and say so.
2. Read the relevant section of [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
   so you change the right file rather than the first plausible one.
3. Check [`docs/DECISIONS.md`](docs/DECISIONS.md) before undoing anything that
   looks odd. Several things that look like bugs are measured, deliberate
   choices with a recorded reason.
4. Verify per [`docs/QA.md`](docs/QA.md), and label your evidence honestly. If
   you could not verify something — no browser, no device — **say it is
   unverified and delegate it.** Do not report it as passing.
5. Never `git add -A`. Stage named paths. This repository has lost work to
   sweep-staging more than once.

## Where things go

Keep this file small by putting things where they belong:

| Content | Destination |
|---|---|
| A system you closed, with evidence | [`PROJECT_STATE.md`](PROJECT_STATE.md) §3 |
| Something genuinely open now | [`PROJECT_STATE.md`](PROJECT_STATE.md) §4 |
| A durable "why", or a do-not-undo | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| Where code lives, how it fits | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| How to verify a change | [`docs/QA.md`](docs/QA.md) |
| How a commit becomes the live site | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| The full reasoning behind a change | **The commit body.** This project writes substantial ones, and they are the best evidence available. Keep doing it. |

## ⚠️ The archived handoff is not a backlog

[`docs/archive/HANDOFF-legacy.md`](docs/archive/HANDOFF-legacy.md) is the
previous 1054-line handoff, preserved byte-for-byte. It is a valuable record of
*why* the code looks the way it does, and it is **out of date**: it predates the
touch layer, the shadow warm-up fix, and the deployment of the site, and it
still describes GitHub Pages as a future goal.

> A legacy document is evidence of what was believed then, not that an item is
> open now. **Reproduce anything from it against current `main` before treating
> it as work.** At least two items on its front page are already fixed.
