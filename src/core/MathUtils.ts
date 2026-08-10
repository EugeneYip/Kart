import * as THREE from 'three';

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const remap = (v: number, a: number, b: number, c: number, d: number) =>
  lerp(c, d, clamp01(invLerp(a, b, v)));
export const smoothstep = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const smootherstep = (t: number) => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
export const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * Frame-rate independent exponential smoothing.
 * `halfLife` = seconds for the value to close half the remaining gap.
 */
export const damp = (current: number, target: number, halfLife: number, dt: number) => {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / halfLife);
};

export const dampVec3 = (
  current: THREE.Vector3,
  target: THREE.Vector3,
  halfLife: number,
  dt: number,
): THREE.Vector3 => {
  const f = halfLife <= 0 ? 0 : Math.pow(2, -dt / halfLife);
  current.x = target.x + (current.x - target.x) * f;
  current.y = target.y + (current.y - target.y) * f;
  current.z = target.z + (current.z - target.z) * f;
  return current;
};

export const dampQuat = (
  current: THREE.Quaternion,
  target: THREE.Quaternion,
  halfLife: number,
  dt: number,
): THREE.Quaternion => {
  const f = halfLife <= 0 ? 0 : Math.pow(2, -dt / halfLife);
  return current.slerp(target, 1 - f);
};

/** Move `current` toward `target` by at most `maxDelta`. */
export const moveTowards = (current: number, target: number, maxDelta: number) => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + sign(d) * maxDelta;
};

/** Shortest signed angular difference, radians, in (-PI, PI]. */
export const angleDelta = (from: number, to: number) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** Wrap a value into [0, range). */
export const wrap = (v: number, range: number) => ((v % range) + range) % range;

/** Deterministic 32-bit hash → [0,1). Good enough for scattering. */
export const hash11 = (n: number) => {
  let x = Math.sin(n * 127.1) * 43758.5453123;
  return x - Math.floor(x);
};
export const hash21 = (x: number, y: number) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
};

/** Seeded xorshift PRNG — same track layout every run. */
export class Rng {
  private s: number;
  constructor(seed = 1337) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a: number, b: number) { return a + this.next() * (b - a); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  /** Gaussian via Box–Muller. */
  gauss(mean = 0, sd = 1) {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Scratch objects — avoid allocating in hot loops. */
export const scratch = {
  v3a: new THREE.Vector3(),
  v3b: new THREE.Vector3(),
  v3c: new THREE.Vector3(),
  v3d: new THREE.Vector3(),
  qa: new THREE.Quaternion(),
  qb: new THREE.Quaternion(),
  m4a: new THREE.Matrix4(),
  m4b: new THREE.Matrix4(),
  e1: new THREE.Euler(),
};

export const UP = Object.freeze(new THREE.Vector3(0, 1, 0));
export const FORWARD = Object.freeze(new THREE.Vector3(0, 0, -1));
export const RIGHT = Object.freeze(new THREE.Vector3(1, 0, 0));
