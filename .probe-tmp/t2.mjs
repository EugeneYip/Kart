import './hooks.mjs';
const m = await import('/Users/eugene/Desktop/kart/src/core/Types.ts');
console.log('SurfaceType.AntiGravity =', m.SurfaceType.AntiGravity, 'names', m.SurfaceType[11]);
const c = await import('/Users/eugene/Desktop/kart/src/core/Config.ts');
console.log('FIXED_DT', c.FIXED_DT, 'grav', c.WORLD.gravity);
