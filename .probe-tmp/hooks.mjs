import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
const SRC = '/Users/eugene/Desktop/kart/src';
registerHooks({
  resolve(spec, ctx, next) {
    let base = null;
    if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
    else if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:')) {
      base = path.resolve(path.dirname(fileURLToPath(ctx.parentURL)), spec);
    }
    if (base) {
      const cands = [base, base + '.ts', base + '/index.ts', base.endsWith('.js') ? base.slice(0,-3)+'.ts' : null].filter(Boolean);
      for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return { url: pathToFileURL(c).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
