import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // ---------------------------------------------------------------------------
  // DEPLOYMENT BASE — relative, not '/' and not '/<repo>/'
  // ---------------------------------------------------------------------------
  // GitHub Pages serves a project site from a SUBPATH:
  //   https://<user>.github.io/<repo>/
  // The default base of '/' emits `<script src="/assets/index-*.js">`, which the
  // browser resolves against the ORIGIN — https://<user>.github.io/assets/... —
  // and every bundle 404s. That is the one guaranteed failure of this build on
  // Pages, and it was verified: the pre-change `dist/index.html` contained
  // exactly `src="/assets/index-B-eEl4-J.js"`.
  //
  // './' rather than '/<repo>/' because nothing in this app resolves anything
  // against an absolute root at runtime, so there is no reason to hardcode the
  // repository name (which would then break on a rename, on a user/org site, or
  // under a local `served/` smoke test). Audited before choosing it:
  //   * no `fetch`, `XMLHttpRequest`, `new Audio`, `three` Loader, `new Worker`
  //     or service worker anywhere in `src/` — AGENTS.md rule 3 holds, every
  //     texture is canvas-2D/DataTexture/noise and every model is TS geometry;
  //   * `public/` now exists, but it holds only PAGE-LEVEL assets — favicons,
  //     app icons, the social card, manifest, robots.txt, sitemap.xml. Their
  //     hrefs in `index.html` are relative (`./favicon.ico`) precisely so a
  //     relative base can rewrite them; the absolute URLs in the OG/canonical
  //     tags are crawler-facing metadata, not fetched assets, so `base` is
  //     irrelevant to them. No gameplay code reads any of it;
  //   * no router, no `history.pushState`, no `location.pathname` read in
  //     shipped code (only `src/dev/*` harnesses, which are not build inputs),
  //     so there is no deep link for Pages' 404 handler to mishandle;
  //   * no `new URL(..., import.meta.url)` asset references and no
  //     `import.meta.env.BASE_URL` consumer.
  // With relative base, `dist/` is also openable from any subdirectory depth,
  // which is what makes the `served/kart/` subpath rehearsal meaningful.
  base: './',

  // vite-plugin-glsl v1.6 dropped the `compress` option; minification now
  // follows the build mode, so there is nothing to configure here.
  // (No `.glsl`/`.vert`/`.frag` files exist yet — every shader in the project is
  // an inline template string — so the plugin is currently a no-op that costs
  // nothing and keeps the door open.)
  plugins: [glsl()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  build: {
    // `build.target` drives esbuild's transform target too — a separate
    // top-level `esbuild.target` is no longer a valid option in Vite 8.
    target: 'es2022',

    // ---------------------------------------------------------------------------
    // SOURCEMAPS OFF FOR THE PUBLISHED ARTIFACT
    // ---------------------------------------------------------------------------
    // Measured on the pre-change build: 11 MB of `dist`, of which 8.9 MB (81 %)
    // was three `.js.map` files. They cost a player nothing at load time — a
    // browser only fetches a map when devtools is open — so this is not a
    // performance argument, it is an artifact-size one: every Pages deploy
    // uploads and stores those 8.9 MB, and on a 1.9 MB build the maps are more
    // than four times the thing being shipped.
    //
    // The debuggability they buy is also nearly free to get back: this repo is
    // the public source of the deployed site, so anyone (including the owner)
    // can reproduce a mapped build locally with one flag. Nothing about the
    // deployed site is impossible to diagnose without maps that would be
    // possible with them, because the deployed commit is the source commit.
    //
    // Flip to `true` when you need to read a production stack trace; it is a
    // one-word change and no other setting depends on it.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Rollup 4 types the object form as Record<string, string[]>, but the
        // union with ManualChunksFunction makes the bare literal ambiguous.
        // The function form is unambiguous and gives finer control: keep three
        // and the post-processing stack in their own long-lived chunks so a
        // gameplay-code change doesn't invalidate ~1.5 MB of vendor bundle.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/postprocessing')) return 'post';
          return undefined;
        },
      },
    },
  },
});
