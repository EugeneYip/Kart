/**
 * Procedural particle sprite painters.
 *
 * EVERY sprite is authored as **white RGB with all detail in the alpha
 * channel**. Colour comes from the per-emitter gradient LUT multiplied by a
 * per-particle HDR tint, which means one atlas serves every effect and there is
 * never a colour-space surprise. The only thing that matters here is that the
 * alpha channel is rich, high-contrast and free of "blurry blob" softness.
 */

import { fbm2, ridged2, warpedFbm2, ihash2 } from './Noise';

export type Painter = (ctx: CanvasRenderingContext2D, size: number) => void;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

/** Write a per-pixel alpha field (u,v in 0..1, v=0 at the TOP of the sprite). */
function perPixel(
  ctx: CanvasRenderingContext2D,
  size: number,
  fn: (u: number, v: number) => number,
): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const a = clamp01(fn(u, v));
      const i = (y * size + x) << 2;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = (a * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// 0 — soft radial glow (the workhorse: cores, halos, bloom seeds)
// ---------------------------------------------------------------------------
export const paintGlow: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const k = 1 - r;
    // Wide soft halo + tight hot core. Three lobes read far better than one.
    return clamp01(k * k * 0.42 + Math.pow(k, 5) * 0.5 + Math.pow(k, 22) * 0.85);
  });
};

// ---------------------------------------------------------------------------
// 1 — sharp spark streak (velocity-stretched drift sparks)
// ---------------------------------------------------------------------------
export const paintSpark: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const ay = Math.abs(y);
    if (ay >= 1) return 0;
    // Width tapers to a point at both ends, fat in the middle-front.
    const taper = Math.pow(1 - ay, 0.55);
    const w = 0.20 * taper;
    const d = Math.abs(x) / Math.max(1e-4, w);
    const body = Math.exp(-d * d * 2.1);
    const core = Math.exp(-d * d * 13.0);
    const head = Math.exp(-((y + 0.55) * (y + 0.55)) * 9.0) * 0.5;
    return clamp01((body * 0.72 + core * 0.95 + head * body) * taper);
  });
};

// ---------------------------------------------------------------------------
// 2 — wispy smoke puff (domain-warped multi-octave, eroded edges)
// ---------------------------------------------------------------------------
function smokeField(seed: number, contrast: number, wisp: number): (u: number, v: number) => number {
  return (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const px = u * 3.1;
    const py = v * 3.1;
    const n = warpedFbm2(px, py, seed, 1.5, 5);
    const fine = ridged2(px * 3.7, py * 3.7, seed + 55, 4);
    // Radial mask whose edge is itself chewed up by noise → no circle silhouette.
    const edgeNoise = fbm2(px * 1.9 + 11, py * 1.9 - 4, seed + 700, 3);
    const mask = sstep(0.98 + edgeNoise * 0.28, 0.06, r);
    let a = (n * contrast - (contrast - 1) * 0.52) * mask;
    a *= 0.62 + 0.38 * sstep(0.18, 0.72, fine * (0.55 + 0.45 * (1 - r)));
    // Wispy filaments trailing outward.
    a += wisp * mask * Math.pow(clamp01(fine * 1.35 - 0.42), 1.6) * (1 - r * 0.55);
    return clamp01(Math.pow(clamp01(a), 1.18));
  };
}

export const paintSmoke: Painter = (ctx, s) => {
  perPixel(ctx, s, smokeField(9137, 1.85, 0.32));
};

export const paintSmokeDense: Painter = (ctx, s) => {
  perPixel(ctx, s, smokeField(2213, 2.35, 0.18));
};

// ---------------------------------------------------------------------------
// 3 — dust cloud (rounder, softer, lower contrast than smoke)
// ---------------------------------------------------------------------------
export const paintDust: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const n = warpedFbm2(u * 2.4, v * 2.4, 4471, 0.95, 4);
    const edgeNoise = fbm2(u * 3.4 + 3, v * 3.4 + 8, 881, 3) - 0.5;
    const mask = sstep(0.95 + edgeNoise * 0.22, 0.0, r);
    const a = mask * (0.42 + n * 0.92) * (0.55 + 0.45 * (1 - r * r));
    return clamp01(Math.pow(clamp01(a), 1.25));
  });
};

// ---------------------------------------------------------------------------
// 4 — water droplet (teardrop with a bright rim)
// ---------------------------------------------------------------------------
export const paintDroplet: Painter = (ctx, s) => {
  const cy = 0.66;
  const cr = 0.27;
  const tipY = 0.08;
  perPixel(ctx, s, (u, v) => {
    let rr: number;
    if (v >= cy) {
      const dy = v - cy;
      rr = Math.sqrt(Math.max(0, cr * cr - dy * dy));
    } else {
      rr = cr * Math.pow(clamp01((v - tipY) / (cy - tipY)), 0.62);
    }
    if (rr <= 1e-4) return 0;
    const q = Math.abs(u - 0.5) / rr;
    const body = sstep(1.02, 0.82, q);
    // Rim light + a small specular bead.
    const rim = Math.pow(clamp01(q), 3) * 0.75;
    const dx = u - 0.44;
    const dy2 = v - 0.60;
    const spec = Math.exp(-(dx * dx + dy2 * dy2) * 420) * 0.9;
    return clamp01(body * (0.34 + rim) + body * spec);
  });
};

// ---------------------------------------------------------------------------
// 5 — flame lick (tapered tongue with flickery eroded edges)
// ---------------------------------------------------------------------------
export const paintFlame: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    // f = 0 at the base (bottom, v=1), 1 at the tip (top, v=0)
    const f = 1 - v;
    if (f < 0 || f > 1) return 0;
    const w = 0.40 * Math.pow(1 - f, 0.62) * Math.pow(clamp01(f * 4.5), 0.42);
    if (w <= 1e-4) return 0;
    const q = Math.abs(u - 0.5) / w;
    const n = fbm2(u * 5.5, v * 2.6 - 1.4, 3313, 4);
    const erode = 0.72 + n * 0.55;
    const body = sstep(1.06 * erode, 0.45 * erode, q);
    const core = Math.exp(-q * q * 3.4) * (1 - f * 0.55);
    const baseHot = Math.exp(-f * f * 7.0);
    return clamp01(body * (0.55 + baseHot * 0.5) + core * 0.75 * baseHot);
  });
};

// ---------------------------------------------------------------------------
// 6 — 5-point star
// ---------------------------------------------------------------------------
export const paintStar: Painter = (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);

  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.beginPath();
  const R = s * 0.44;
  const r = s * 0.175;
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : r;
    const x = Math.cos(ang) * rad;
    const y = Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.shadowColor = 'rgba(255,255,255,0.85)';
  ctx.shadowBlur = s * 0.07;
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
};

// ---------------------------------------------------------------------------
// 7 — shockwave ring
// ---------------------------------------------------------------------------
export const paintRing: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const th = Math.atan2(y, x);
    const wob = 0.86 + 0.14 * Math.sin(th * 22 + 1.3) * Math.sin(th * 7);
    const d = r - 0.74;
    const band = Math.exp(-(d * d) / (2 * 0.055 * 0.055));
    const inner = Math.exp(-(d * d) / (2 * 0.26 * 0.26)) * 0.17;
    const edge = sstep(1.0, 0.9, r);
    return clamp01((band * wob + inner) * edge);
  });
};

// ---------------------------------------------------------------------------
// 8 — lightning bolt (vertical, with branches)
// ---------------------------------------------------------------------------
export const paintBolt: Painter = (ctx, s) => {
  const pts: Array<[number, number]> = [];
  const segs = 13;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const jitter = (ihash2(i * 7, 3, 5501) - 0.5) * s * 0.30 * Math.sin(Math.PI * t);
    pts.push([s * 0.5 + jitter, s * (0.03 + 0.94 * t)]);
  }

  const stroke = (w: number, alpha: number, blur: number) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineWidth = w;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = blur;
    ctx.stroke();
    ctx.shadowBlur = 0;
  };

  stroke(s * 0.16, 0.14, s * 0.10);
  stroke(s * 0.075, 0.30, s * 0.05);

  // Branches
  ctx.lineCap = 'round';
  for (let b = 0; b < 4; b++) {
    const i = 2 + ((b * 3 + 1) % (segs - 3));
    const [bx, by] = pts[i];
    const dir = ihash2(b, 11, 771) > 0.5 ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    let cx = bx;
    let cy = by;
    const n = 3;
    for (let k = 0; k < n; k++) {
      cx += dir * s * (0.05 + ihash2(b * 13 + k, 5, 991) * 0.07);
      cy += s * (0.03 + ihash2(b * 17 + k, 9, 313) * 0.05);
      ctx.lineTo(cx, cy);
    }
    ctx.lineWidth = s * 0.026;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.stroke();
  }

  stroke(s * 0.028, 1.0, s * 0.03);
};

// ---------------------------------------------------------------------------
// 9 — leaf / grass clipping
// ---------------------------------------------------------------------------
export const paintLeaf: Painter = (ctx, s) => {
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.44);
  ctx.bezierCurveTo(s * 0.30, -s * 0.20, s * 0.26, s * 0.24, 0, s * 0.44);
  ctx.bezierCurveTo(-s * 0.24, s * 0.22, -s * 0.30, -s * 0.18, 0, -s * 0.44);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fill();
  // Carve the central vein out of the alpha so it reads as a real leaf.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.40);
  ctx.quadraticCurveTo(s * 0.02, 0, 0, s * 0.40);
  ctx.lineWidth = s * 0.02;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
};

// ---------------------------------------------------------------------------
// 10 — ember (tiny hot speck with a ragged halo)
// ---------------------------------------------------------------------------
export const paintEmber: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const th = Math.atan2(y, x);
    const rag = 0.78 + 0.22 * fbm2(Math.cos(th) * 2 + 4, Math.sin(th) * 2 + 4, 61, 3);
    const core = Math.exp(-r * r * 46);
    const halo = Math.exp(-r * r * 7.5) * 0.34 * rag;
    return clamp01(core + halo);
  });
};

// ---------------------------------------------------------------------------
// 11 — debris chip (irregular hard-edged shard)
// ---------------------------------------------------------------------------
export const paintChip: Painter = (ctx, s) => {
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.beginPath();
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + ihash2(i, 3, 4409) * 0.5;
    const rad = s * (0.22 + ihash2(i, 7, 8821) * 0.20);
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fill();
  ctx.restore();
};

// ---------------------------------------------------------------------------
// 12 — sparkle flare (4-point star streaks + core + faint ring)
// ---------------------------------------------------------------------------
export const paintFlare: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const fall = sstep(1.0, 0.75, r);
    const core = Math.exp(-r * r * 130) * 1.15;
    const h = Math.exp(-y * y * 620) * Math.exp(-Math.abs(x) * 2.6);
    const w = Math.exp(-x * x * 620) * Math.exp(-Math.abs(y) * 2.6);
    const d1x = (x + y) * 0.7071;
    const d1y = (x - y) * 0.7071;
    const d1 = Math.exp(-d1y * d1y * 900) * Math.exp(-Math.abs(d1x) * 5.5);
    const d2 = Math.exp(-d1x * d1x * 900) * Math.exp(-Math.abs(d1y) * 5.5);
    const glow = Math.exp(-r * r * 11) * 0.28;
    const ring = Math.exp(-((r - 0.30) * (r - 0.30)) / (2 * 0.035 * 0.035)) * 0.16;
    return clamp01((core + (h + w) * 0.95 + (d1 + d2) * 0.34 + glow + ring) * fall);
  });
};

// ---------------------------------------------------------------------------
// 13 — confetti strip
// ---------------------------------------------------------------------------
export const paintConfetti: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = Math.abs(u - 0.5) / 0.34;
    const y = Math.abs(v - 0.5) / 0.20;
    const d = Math.max(x, y);
    const body = sstep(1.02, 0.90, d);
    // A soft "fold" band so it doesn't read as a flat rectangle.
    const fold = 0.72 + 0.28 * Math.abs(Math.sin((v - 0.5) * 9.0));
    return clamp01(body * fold);
  });
};

// ---------------------------------------------------------------------------
// 14 — ink / scorch splat with drips
// ---------------------------------------------------------------------------
export const paintSplat: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const th = Math.atan2(y, x);
    // Lobed silhouette.
    const lobes =
      0.58 +
      0.16 * Math.sin(th * 3 + 0.7) +
      0.10 * Math.sin(th * 7 - 1.9) +
      0.08 * Math.sin(th * 13 + 2.4);
    let a = sstep(lobes + 0.06, lobes - 0.10, r);
    // Detached satellite droplets.
    for (let i = 0; i < 5; i++) {
      const ang = ihash2(i, 1, 3931) * Math.PI * 2;
      const dist = 0.62 + ihash2(i, 2, 5813) * 0.28;
      const rad = 0.045 + ihash2(i, 3, 7717) * 0.06;
      const dx = x - Math.cos(ang) * dist;
      const dy = y - Math.sin(ang) * dist;
      a = Math.max(a, sstep(rad * 1.25, rad * 0.6, Math.sqrt(dx * dx + dy * dy)));
    }
    const grain = 0.88 + 0.12 * fbm2(u * 9, v * 9, 271, 3);
    return clamp01(a * grain);
  });
};

// ---------------------------------------------------------------------------
// 15 — soft mist / spray cloud (fine, low-contrast, big)
// ---------------------------------------------------------------------------
export const paintMist: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const n = fbm2(u * 4.2, v * 4.2, 1777, 5);
    const speck = ridged2(u * 12, v * 12, 991, 3);
    const mask = Math.pow(clamp01(1 - r), 1.5);
    return clamp01(mask * (0.30 + n * 0.75) * (0.75 + speck * 0.5) * 0.85);
  });
};
