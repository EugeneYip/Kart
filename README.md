# Foxy Kart

A Mario Kart–style 3-D kart racing game that runs entirely in a browser tab.
Eight circuits, ten racers, twelve karts on the grid, and **not one downloaded
asset** — every texture, mesh, and sound is generated in code at startup.

- **Play:** <https://kart.eugeneyip.com/>
- **Source:** <https://github.com/EugeneYip/Kart>
- **Production branch:** `main` (every push deploys)

---

## AI / maintainer bootstrap

**If you are picking this project up with no conversation history — human or
model — do these seven things in order, before you change anything.**

1. **Read [`PROJECT_STATE.md`](PROJECT_STATE.md).** This is what is true *now*:
   the baseline commit, which systems are closed and why, what is actually open.
2. **Read [`AGENTS.md`](AGENTS.md).** The engineering contract. It is normative,
   not advisory — allocation discipline, disposal, `QualitySettings`, the
   zero-runtime-network rule, and the performance budget are all enforced there.
3. **Read [`HANDOFF.md`](HANDOFF.md).** The live working note. Short by design.
4. **Inspect the repository yourself** and confirm the baseline before trusting
   any document, including this one:

   ```bash
   git status                 # see note below if not clean
   git rev-parse --abbrev-ref HEAD   # expect: main
   git rev-parse HEAD                # compare against PROJECT_STATE.md
   git rev-parse origin/main         # expect: identical to HEAD
   ```

5. **Confirm the baseline matches.** If `HEAD` differs from the SHA recorded in
   `PROJECT_STATE.md`, that document is stale — trust the code, then say so.
   The authority order is in [Source of truth](#source-of-truth) below.
6. **Build it before you touch it**, so you know the tree was green when you
   arrived and any breakage afterwards is yours:

   ```bash
   npm ci
   npm run build      # tsc --noEmit && vite build
   ```

7. **Report your understanding before changing anything.** State the baseline
   you verified, what you believe is open, and what you intend to change. This
   project has repeatedly lost time to work started from a stale assumption.

---

## Tech stack

| Piece | Choice |
|---|---|
| Language | TypeScript, `strict`, no `any` |
| Renderer | three.js `^0.185` (WebGL2) |
| Post FX | `postprocessing` `^6.39` |
| Also | `three-mesh-bvh`, `simplex-noise` |
| Build | Vite `^8.2`, `base: './'` |
| Runtime | Node 22 for tooling (local: v22.15.1) |
| Hosting | GitHub Pages via GitHub Actions, custom domain |

No framework, no router, no state library, no test runner. 106 TypeScript modules (92 build inputs; the 14 under `src/dev/` are not), ~114 k lines under `src/`.

## Commands

```bash
npm ci            # install exactly the lockfile
npm run dev       # Vite dev server (127.0.0.1:5173)
npm run build     # typecheck + production build to dist/
npm run typecheck # tsc --noEmit alone
npm run preview   # serve the built dist/ on :4173
```

**There is no `npm test`.** Verification is a set of headless probes and browser
harnesses instead — see [`docs/QA.md`](docs/QA.md). Do not invent a test script;
document and use what exists.

> **Before you change anything:** [`PROJECT_STATE.md` §7](PROJECT_STATE.md#7-what-needs-the-owners-approval)
> lists what needs the owner's approval. `main` is production — a push deploys.

## Documentation map

| Document | What it answers |
|---|---|
| [`PROJECT_STATE.md`](PROJECT_STATE.md) | What is true right now — baseline, closed systems, open work |
| [`AGENTS.md`](AGENTS.md) | The engineering contract every change must satisfy |
| [`HANDOFF.md`](HANDOFF.md) | The live working note between sessions |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Where the code lives — "if I need to change X, where do I look?" |
| [`docs/QA.md`](docs/QA.md) | How to verify a change, and what counts as evidence |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | How a commit becomes the live site |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why things are the way they are — do not undo these blindly |
| [`docs/archive/HANDOFF-legacy.md`](docs/archive/HANDOFF-legacy.md) | **Historical.** Superseded. See the warning below. |

## Source of truth

When two documents disagree, believe them in this order:

1. **The current code, plus a measurement you can reproduce**
2. `PROJECT_STATE.md`
3. `AGENTS.md`
4. the current `HANDOFF.md`
5. `git log` commit bodies (this project writes substantial ones — they are the
   best account of why a change was made)
6. archived and legacy notes

## ⚠️ About the archived handoff

[`docs/archive/HANDOFF-legacy.md`](docs/archive/HANDOFF-legacy.md) is a 1054-line
record of playtest rounds through 2026-08-18, preserved byte-for-byte because it
explains a great deal of *why* the code looks the way it does.

**It is not a to-do list, and much of it is now wrong.** It predates the touch
control layer, the shadow warm-up fix, and the entire deployment of the site — it
still describes GitHub Pages as a future goal and states that no `public/`
directory exists. Both are obsolete.

> **A legacy document is evidence of what was believed then, not proof that an
> item is open now.** Never reopen a bug, TODO, or QA concern because it appears
> in that file. Reproduce it against current `main` first, or leave it closed.
