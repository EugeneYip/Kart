import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // vite-plugin-glsl v1.6 dropped the `compress` option; minification now
  // follows the build mode, so there is nothing to configure here.
  plugins: [glsl()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  build: {
    // `build.target` drives esbuild's transform target too — a separate
    // top-level `esbuild.target` is no longer a valid option in Vite 8.
    target: 'es2022',
    sourcemap: true,
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
