import { createServer } from 'vite';
const s = await createServer({ configFile: '/Users/eugene/Desktop/kart/vite.config.ts', root: '/Users/eugene/Desktop/kart', server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
console.log('ssrLoadModule?', typeof s.ssrLoadModule);
try {
  const m = await s.ssrLoadModule('/src/core/Config.ts');
  console.log('FIXED_DT', m.FIXED_DT);
} catch (e) { console.log('ERR', e.message); }
await s.close();
