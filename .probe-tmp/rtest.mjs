import { rolldown } from 'rolldown';
import { fileURLToPath } from 'node:url';
const t0 = Date.now();
const bundle = await rolldown({
  input: '/Users/eugene/Desktop/kart/src/core/Config.ts',
  resolve: { alias: { '@': '/Users/eugene/Desktop/kart/src' } },
  platform: 'node',
  external: ['three', 'three-mesh-bvh', 'simplex-noise'],
  logLevel: 'silent',
});
const out = await bundle.generate({ format: 'esm' });
console.log('ok', Date.now()-t0, 'ms; chunks', out.output.length, out.output[0].code.length);
await bundle.close();
