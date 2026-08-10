/**
 * Fast integer-hash value noise + fBm for procedural sprite generation.
 * Deliberately dependency-free and allocation-free so a 1024² atlas builds
 * in a few tens of milliseconds at init.
 */

export function ihash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const quintic = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function valueNoise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = quintic(xf);
  const v = quintic(yf);
  const a = ihash2(xi, yi, seed);
  const b = ihash2(xi + 1, yi, seed);
  const c = ihash2(xi, yi + 1, seed);
  const d = ihash2(xi + 1, yi + 1, seed);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Standard fractional Brownian motion, output normalised to ~[0,1]. */
export function fbm2(
  x: number,
  y: number,
  seed: number,
  octaves = 5,
  lacunarity = 2.03,
  gain = 0.5,
): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged fBm — sharper filaments, great for wispy smoke edges. */
export function ridged2(x: number, y: number, seed: number, octaves = 4): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq, seed + i * 977) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.52;
    freq *= 2.11;
  }
  return sum / norm;
}

/**
 * Two-level domain-warped fBm. This is what turns "grey blob" into
 * "genuinely wispy smoke" — the warp shears the noise into tendrils.
 */
export function warpedFbm2(
  x: number,
  y: number,
  seed: number,
  warp = 1.35,
  octaves = 5,
): number {
  const q1 = fbm2(x, y, seed + 17, 3);
  const q2 = fbm2(x + 5.2, y + 1.3, seed + 91, 3);
  const r1 = fbm2(x + warp * q1 * 2 + 1.7, y + warp * q2 * 2 + 9.2, seed + 233, 3);
  const r2 = fbm2(x + warp * q1 * 2 + 8.3, y + warp * q2 * 2 + 2.8, seed + 401, 3);
  return fbm2(x + warp * r1 * 2, y + warp * r2 * 2, seed, octaves);
}
