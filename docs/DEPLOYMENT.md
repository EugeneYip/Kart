# Foxy Kart — deployment

**How a commit becomes the live site.**

Everything in §1–§4 is read from `vite.config.ts`, `package.json`,
`.github/workflows/deploy.yml`, `index.html` and `public/`, and is verifiable
from a clone. §6 is not — it lives in GitHub and DNS.

No credentials, tokens, or secrets are in this repository, and none should be
added. The workflow uses GitHub's own OIDC token; there is nothing to store.

See also: [`../PROJECT_STATE.md`](../PROJECT_STATE.md) ·
[`DECISIONS.md`](DECISIONS.md) · [`QA.md`](QA.md)

---

## 1. The short version

| | |
|---|---|
| Production URL | <https://kart.eugeneyip.com/> |
| Repository | <https://github.com/EugeneYip/Kart> |
| Production branch | **`main`** — every push deploys |
| Trigger | `push` to `main`, or manual `workflow_dispatch` |
| Runner | `ubuntu-latest`, Node **22**, `npm ci` |
| Build | `npm run build` = `tsc --noEmit && vite build` |
| Artifact | `dist/` (Vite's default `outDir`, not overridden) |
| Host | GitHub Pages, published by GitHub Actions |

**There is no staging environment and no manual publish step.** A push to `main`
is a production deploy. Branch first if you are not ready for that.

---

## 2. The workflow

`.github/workflows/deploy.yml`. Two jobs.

**`build`** — `actions/checkout@v4` → `actions/setup-node@v4` (`node-version:
'22'`, `cache: npm`) → `npm ci` → `npm run build` → `actions/configure-pages@v5`
→ `actions/upload-pages-artifact@v3` with `path: dist`.

**`deploy`** — `needs: build`, environment `github-pages`, `actions/deploy-pages@v4`.

Permissions are the minimum the Pages action needs: `contents: read`,
`pages: write`, `id-token: write` (the OIDC token it exchanges for the upload
credential).

Concurrency is `group: pages` with **`cancel-in-progress: false`**, so two
deploys never race and an in-flight publish finishes rather than leaving the
site half-swapped.

### Why Actions, and not a `gh-pages` branch

Recorded in the workflow's own header. The build is a typecheck gate in front of
a bundler over 106 TypeScript modules (92 build inputs; the 14 under `src/dev/` are not). Committing `dist/` to a branch would
mean the published site is whatever someone last built on their laptop, with
their Node, their `node_modules`, and the typecheck possibly skipped — and
`dist/` is in `.gitignore`, so it would have to come back out and be re-committed
on every change, producing a diff of minified bundles on every push.

Actions keeps the artifact reproducible from the commit, keeps the typecheck
non-optional, and keeps generated output out of history entirely.

### Why Node 22, and why `npm ci`

Vite 8 requires `^20.19 || >=22.12`, so 20 would work but only on its newest
patches. 22 is the current LTS, matches what this was built and smoke-tested
against locally (v22.15.1), and leaves headroom. `@types/node@22` is pinned to
match.

`npm ci`, never `npm install`: it installs exactly `package-lock.json`, so the
published bundle is a function of the commit and nothing else. `setup-node`'s
`cache: npm` keys off the committed lockfile, so the cache needs no manual key.

> **`npm run build`, never a bare `vite build`.** The typecheck is part of the
> build **by design** — a type error must fail the deploy instead of shipping.
> This is the single most important line in the workflow. Do not "speed up CI"
> by removing it.

### There is no asset-copy step, and none is needed

`public/` is copied into `dist/` by Vite unaided. Nothing is fetched at runtime,
so there are no images, fonts, audio files, or models to stage.

---

## 3. `base: './'` — why, and what not to do

The single most consequential line in `vite.config.ts`.

### The failure it prevents

Vite's default `base: '/'` emits `<script src="/assets/index-*.js">`. A browser
resolves that against the **origin**, not the page's directory. On a Pages
*project* site — `https://<user>.github.io/<repo>/` — every bundle is fetched
from `https://<user>.github.io/assets/…` and **every one 404s**.

This was verified concretely, not reasoned about: `33651d1` records that the
pre-change `dist/index.html` contained exactly `src="/assets/index-B-eEl4-J.js"`,
and that a local subpath rehearsal returned 404 for that exact path.

### Why relative, and not `'/<repo>/'`

Because nothing in this app resolves anything against an absolute root at
runtime. That was **audited before the choice was made**, not assumed:

- no `fetch`, `XMLHttpRequest`, `new Audio`, three.js `Loader`, `new Worker`, or
  service worker anywhere in `src/`;
- no router, no `history.pushState`, no `location.pathname` read in shipped code
  — only `src/dev/*` harnesses, which are not build inputs — so there is no deep
  link for Pages' 404 handler to mishandle;
- no `new URL(…, import.meta.url)` asset references and no `import.meta.env.BASE_URL`
  consumer.

Hardcoding the repository name would then break on a rename, on a move to a
user/org site, and under a local subdirectory smoke test — for no benefit.

Relative base also means `dist/` works at any subdirectory depth, which is what
makes the local subpath rehearsal meaningful in the first place.

> **Do not change `base`.** Not to `'/'`, not to `'/Kart/'`. If you think you
> need to, you are probably about to introduce a runtime fetch, which
> [`../AGENTS.md`](../AGENTS.md) rule 3 forbids anyway.

---

## 4. Two URL styles in `index.html`, both deliberate

This looks like an inconsistency and is not. **Do not "fix" either one to match
the other** — a comment in `index.html` says so, because the instinct to
normalise them is strong.

| Kind | Style | Why |
|---|---|---|
| Icons, manifest — `./favicon.ico`, `./site.webmanifest`, `./apple-touch-icon.png` | **Relative** | They are fetched by the browser *in the page's context*, so they must survive `base: './'` at any subpath, including the project-URL fallback |
| `<link rel="canonical">`, `og:url`, `og:image`, `twitter:image`, `sitemap.xml` | **Absolute** (`https://kart.eugeneyip.com/…`) | A crawler resolves them **out of context** — from an index, a scrape, or a social card renderer that never saw the page's directory. A relative URL there is useless |

The same split applies inside `public/`: `site.webmanifest` uses relative
`start_url`, `scope` and icon paths; `robots.txt` and `sitemap.xml` carry
absolute URLs.

### The origin-root favicon history

Worth knowing, because the current arrangement looks like it contradicts an
older comment. It does not — the situation changed.

**Browsers probe for an icon at the ORIGIN ROOT, never at the page's own
directory.** While the site was served from a Pages project subpath, that probe
went to `https://<user>.github.io/favicon.ico` — outside this project's
published subtree, unreachable by `base`, and answerable only by a separate
user-site repository. So the 404 genuinely was **structurally unfixable from
here**, and the then-current fix (an inline SVG data-URI favicon) only *reduced*
the probe rather than removing it: measured over three forced reloads, two made
no request and one still did.

Production now serves from a **custom-domain root**, so the origin root is
inside this artifact and `https://kart.eugeneyip.com/favicon.ico` is ours to
serve. Real icon files also provide what a data URI cannot — an Apple touch icon
and the 192/512 manifest pair.

**Consequence to remember:** if the site ever falls back to a Pages project
subpath, the origin-root favicon 404 returns, and it is harmless. It is a
browser convenience request for a decoration, never read by the game.

### `public/` and rule 3

`public/` holds only page-level presentation and discovery assets — favicons,
app icons, the social card, `site.webmanifest`, `robots.txt`, `sitemap.xml`,
plus masters under `brand/` and `og/`. They are fetched by browser chrome and by
crawlers, **never by the game**.

This is a narrow, explicitly bounded exception to the zero-runtime-network rule.
Do not delete these files as rule-3 violations, and do not read them as licence
to load a texture, model, font, or sound from a file. See
[`DECISIONS.md`](DECISIONS.md).

Two asset facts the filenames do not tell you: the social card is **1731×909**
(not 1200×630) and declares exactly those dimensions — declaring dimensions that
disagree with the file makes crawlers letterbox or reject the card. The icon
master is **1254×1254** despite being named `…-1024.png`.

---

## 5. Other build settings

**`sourcemap: false`.** An artifact-size decision, not a performance one — a
browser only fetches a map when devtools is open. Measured on the pre-change
build: 11 MB of `dist`, of which 8.9 MB (81 %) was three `.js.map` files, more
than four times the thing being shipped. The debuggability is nearly free to get
back: this repo is the public source of the deployed site, so the deployed
commit *is* the source commit and a mapped build is one flag away. Flip it to
`true` when you need to read a production stack trace; nothing else depends on
it.

**`manualChunks`.** `three` and `postprocessing` are split into their own
long-lived chunks so a gameplay-code change does not invalidate ~1.5 MB of
vendor bundle for returning players. The function form is used because Rollup 4
types the object form ambiguously against `ManualChunksFunction`.

**`build.target: 'es2022'`.** Drives esbuild's transform target too; a separate
top-level `esbuild.target` is no longer valid in Vite 8.

**`vite-plugin-glsl`.** Currently a no-op — every shader in the project is an
inline template string and no `.glsl`/`.vert`/`.frag` files exist. It costs
nothing and keeps the door open.

**Expected build warning.** Vite reports chunks larger than 500 kB. Accepted:
this is a single-page game that needs its whole engine before the first frame.

---

## 6. What is not in the repository

**A clone builds and runs. It does not reproduce the live site.** Everything
below lives in GitHub settings or DNS and can only be confirmed by someone with
access.

| Thing | Where |
|---|---|
| Pages source set to **GitHub Actions** (not "Deploy from a branch") | Repo → Settings → Pages |
| Custom domain `kart.eugeneyip.com` | Repo → Settings → Pages → Custom domain |
| `github-pages` environment | Repo → Settings → Environments |
| DNS `CNAME` for `kart` → GitHub Pages | The owner's DNS provider for `eugeneyip.com` |
| TLS certificate | Provisioned automatically by GitHub Pages |
| Account access | Owner: Eugene Yip |

> `Directly verified:` **there is no `CNAME` file in `public/` or anywhere in
> the repository.** With the Actions-based flow the custom domain is stored in
> repository settings, not in the artifact.

Consequences:

- A fork, or a deploy to a different account, gets **no custom domain** and will
  serve from a Pages project subpath. `base: './'` is what makes that still
  work, and the origin-root favicon 404 returns (harmless — see §4).
- If the domain setting is ever cleared, adding `public/CNAME` is the
  alternative mechanism. **Do not add one speculatively** while the setting is
  in use — the two can conflict.

`Not re-verified in this continuity pass:` every row of that table. All of it is
outside the repository and none of it was inspected. The Pages source setting,
the domain binding, and the DNS record are *inferred* from the workflow, the
canonical URL in `index.html`, and the fact that the site is live. Confirm with
the owner before relying on any of it.

---

## 7. Verifying a deploy

Locally reproducible checks — and the full list, including the subpath
rehearsal — are in [`QA.md` §8](QA.md).

The essentials:

```bash
rm -rf node_modules && npm ci && npm run build
npm run preview     # serves the real dist/ at http://localhost:4173
```

Then inspect the **built** `dist/index.html`, not the source: app asset URLs
relative, crawler URLs absolute, `public/` files present, `__QA__`/`__POST__`
absent from the bundles, zero console errors, zero 404s.

Requires GitHub or production access, and must not be claimed without it: that
the workflow succeeded, that Pages published, that the live URL serves the new
commit, and that the domain and certificate are healthy.

---

## 8. Rollback

There is no deployment history to roll back through — the site is whatever
`main` last built. To revert, revert the commit on `main` and let the workflow
republish:

```bash
git revert <sha>
git push origin main
```

`workflow_dispatch` re-runs a deploy without a push, which is what to use after
changing a Pages setting.
