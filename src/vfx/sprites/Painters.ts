/**
 * Procedural particle sprite painters.
 *
 * EVERY sprite is authored as **white RGB with all detail in the alpha
 * channel**. Colour comes from the per-emitter gradient LUT multiplied by a
 * per-particle HDR tint, which means one atlas serves every effect and there is
 * never a colour-space surprise.
 *
 * ALPHA MUST NEVER REACH THE SPRITE BOUNDARY AT FULL OPACITY.
 * -----------------------------------------------------------
 * This file used to say the alpha channel should be "rich, high-contrast and
 * free of blurry blob softness", and the painters that took that literally —
 * `paintStar`, `paintChip`, `paintLeaf` — filled a canvas path with
 * `rgba(255,255,255,1)` and stopped. The compositing around them is fine
 * (ParticleSystem blends premultiplied, with a per-particle additive weight),
 * so a sprite whose alpha steps 1 -> 0 across one texel composites as exactly
 * what it is: opaque clip-art with a cut edge. That single authoring rule is
 * what produced the whole of the critic's particle list — the 5-point stars,
 * the mud-clod dirt, the torn-paper item shards.
 *
 * "High contrast" is still right; what was wrong is where the contrast sits. A
 * sprite wants a bright, structured INTERIOR and a falloff of several texels at
 * the silhouette, plus a vignette so nothing is ever clipped by the cell border.
 * Shapes that need a crisp read (star points, debris facets) get that from a
 * signed-distance edge a few texels wide, not from a hard fill.
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

/**
 * Signed distance to a closed polygon, negative inside. Lets a shape keep an
 * exact silhouette (a star has to read as a star) while the alpha ramp across
 * that silhouette stays as wide and soft as we like — which a canvas `fill()`
 * cannot do at any price.
 *
 * `verts` is a flat [x0,y0,x1,y1,...] list in the same -1..1 space `perPixel`
 * callers use.
 */
function polySdf(px: number, py: number, verts: readonly number[]): number {
  const n = verts.length / 2;
  let d = Infinity;
  let sign = 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = verts[i * 2], yi = verts[i * 2 + 1];
    const xj = verts[j * 2], yj = verts[j * 2 + 1];
    const ex = xj - xi, ey = yj - yi;
    const wx = px - xi, wy = py - yi;
    const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey || 1e-9));
    const bx = wx - ex * t, by = wy - ey * t;
    const dd = bx * bx + by * by;
    if (dd < d) d = dd;
    // Crossing-number inside test (iq's formulation).
    const c1 = py >= yi, c2 = py < yj, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sign = -sign;
  }
  return Math.sqrt(d) * sign;
}

/** A 5-point star as a flat vertex list in -1..1 space. */
function starVerts(outer: number, inner: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? outer : inner;
    v.push(Math.cos(ang) * rad, Math.sin(ang) * rad);
  }
  return v;
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
/**
 * Was a hard `fill('rgba(255,255,255,1)')` over a 10-vertex path with a 7 %
 * shadow blur — an opaque yellow decal with a cut edge, and at the sizes
 * `slip()` emits it that decal is 60-90 px across and lands on top of the
 * player's own kart. Now: the same silhouette from an SDF, but the alpha ramps
 * over ~8 % of the sprite at the edge, peaks at 0.86 rather than 1.0, carries a
 * hot core so the interior is not flat, and sits inside a vignette so the
 * points always dissolve before the cell border.
 */
export const paintStar: Painter = (ctx, s) => {
  const V = starVerts(0.72, 0.30);
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const d = polySdf(x, y, V);
    const edge = 0.085;
    const body = sstep(edge, -edge, d);
    // Interior structure: bright at the heart, falling toward the points.
    const core = Math.exp(-r * r * 3.2);
    // Outward halo, so the star sheds light instead of stopping dead.
    const out = Math.max(d, 0);
    const halo = Math.exp(-(out * out) / (2 * 0.14 * 0.14)) * 0.30;
    const vign = sstep(1.0, 0.70, r);
    return clamp01((body * (0.56 + 0.44 * core) * 0.86 + halo) * vign);
  });
};

// ---------------------------------------------------------------------------
// 7 — shockwave ring
// ---------------------------------------------------------------------------
/**
 * Shockwave / dust ring.
 *
 * The band used to be a gaussian of sigma 0.055 about r = 0.74 — a bright
 * annulus about a tenth of the sprite wide, peaking at alpha 1.0, laid flat on
 * the road by `PFLAG.PLANE`. That is the drift dust "hard-edged brown torus
 * that reads as a stain painted on the tarmac". Sigma is now 2.8x wider, the
 * peak is 0.70, and a broad inner haze fills the middle, so it reads as a puff
 * of displaced dust with a leading edge rather than as a drawn-on ring. The
 * angular wobble is kept — it is what stops it looking machined — and the outer
 * vignette starts much earlier so the disc never meets the cell border.
 */
export const paintRing: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const th = Math.atan2(y, x);
    const wob = 0.82 + 0.18 * Math.sin(th * 22 + 1.3) * Math.sin(th * 7);
    // Break the perfect circle: real dust does not expand as a machined torus.
    const rag = 1 + 0.06 * (fbm2(Math.cos(th) * 2.4 + 5, Math.sin(th) * 2.4 + 5, 617, 3) - 0.5);
    const d = r - 0.66 * rag;
    const band = Math.exp(-(d * d) / (2 * 0.155 * 0.155));
    const inner = Math.exp(-(d * d) / (2 * 0.40 * 0.40)) * 0.30;
    const edge = sstep(1.0, 0.72, r);
    return clamp01((band * wob * 0.70 + inner) * edge);
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
/**
 * Leaf, as the intersection of two offset discs (a lens with two points), so
 * the silhouette is analytic and the edge can be soft. Was a solid alpha-1.0
 * bezier fill.
 */
export const paintLeaf: Painter = (ctx, s) => {
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    // Lens = intersection of two circles offset along x.
    const d1 = Math.hypot(x - 0.62, y * 0.92) - 1.02;
    const d2 = Math.hypot(x + 0.62, y * 0.92) - 1.02;
    const d = Math.max(d1, d2);
    const body = sstep(0.075, -0.075, d);
    // Central vein, carved rather than stroked.
    const vein = Math.exp(-(x * x) / (2 * 0.035 * 0.035)) * 0.42;
    // Blade is thinner toward the tips and the outer margin.
    const thick = sstep(0.0, 0.28, -d);
    const grain = 0.82 + 0.30 * fbm2(u * 5.0, v * 5.0, 733, 3);
    return clamp01(body * (0.34 + 0.60 * thick) * grain * (1 - vein)
      * sstep(1.0, 0.82, r));
  });
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
/**
 * Was a 7-gon filled at alpha 1.0 with literally zero falloff — the "hard-edged
 * opaque brown lumps, like flying mud clods" on the dirt emitters, and the
 * "irregular yellow-green polygons resembling torn paper" on the item-box
 * shatter, which is the same sprite under a different ramp. Same silhouette,
 * but the edge now ramps over ~14 % of the sprite, the interior falls off
 * toward the rim instead of being a slab, and a grain field breaks it up so it
 * reads as a clod of material rather than a cut-out.
 */
export const paintChip: Painter = (ctx, s) => {
  const n = 7;
  const V: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + ihash2(i, 3, 4409) * 0.5;
    const rad = 0.44 + ihash2(i, 7, 8821) * 0.40;
    V.push(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  perPixel(ctx, s, (u, v) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const r = Math.sqrt(x * x + y * y);
    if (r >= 1) return 0;
    const grain = fbm2(u * 6.5, v * 6.5, 4409, 4);
    const d = polySdf(x, y, V);
    const edge = 0.13 + grain * 0.09;
    const body = sstep(edge, -edge * 0.45, d);
    // Depth: solid through the middle, thinning out at the rim.
    const thick = sstep(0.0, 0.40, -d);
    const a = body * (0.26 + 0.66 * thick) * (0.74 + 0.40 * grain);
    return clamp01(a * sstep(1.0, 0.80, r));
  });
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
    const fall = sstep(1.0, 0.72, r);
    const core = Math.exp(-r * r * 110) * 1.05;
    // The arms were sigma 0.028 — about 3 px on a 128 px cell, which is a drawn
    // cross, not a glint. Nearly doubled, and the broad glow behind them raised,
    // so the sparkle has a halo to sit in instead of four hard spokes.
    const h = Math.exp(-y * y * 200) * Math.exp(-Math.abs(x) * 2.6);
    const w = Math.exp(-x * x * 200) * Math.exp(-Math.abs(y) * 2.6);
    const d1x = (x + y) * 0.7071;
    const d1y = (x - y) * 0.7071;
    const d1 = Math.exp(-d1y * d1y * 320) * Math.exp(-Math.abs(d1x) * 5.5);
    const d2 = Math.exp(-d1x * d1x * 320) * Math.exp(-Math.abs(d1y) * 5.5);
    const glow = Math.exp(-r * r * 8) * 0.40;
    const ring = Math.exp(-((r - 0.30) * (r - 0.30)) / (2 * 0.075 * 0.075)) * 0.12;
    return clamp01((core + (h + w) * 0.80 + (d1 + d2) * 0.30 + glow + ring) * fall);
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
    // Was sstep(1.02, 0.90) — a 12 % ramp, i.e. a rectangle with a cut edge.
    const body = sstep(1.04, 0.68, d);
    // A soft "fold" band so it doesn't read as a flat rectangle.
    const fold = 0.72 + 0.28 * Math.abs(Math.sin((v - 0.5) * 9.0));
    return clamp01(body * fold * 0.9);
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
    let a = sstep(lobes + 0.10, lobes - 0.16, r);
    // Detached satellite droplets. Their falloff used to be rad*0.65 wide,
    // which for the smallest droplet is under two texels at 128 px — five hard
    // little discs around an otherwise soft splat. Widened and given a halo.
    for (let i = 0; i < 5; i++) {
      const ang = ihash2(i, 1, 3931) * Math.PI * 2;
      const dist = 0.62 + ihash2(i, 2, 5813) * 0.28;
      const rad = 0.055 + ihash2(i, 3, 7717) * 0.07;
      const dx = x - Math.cos(ang) * dist;
      const dy = y - Math.sin(ang) * dist;
      const dr = Math.sqrt(dx * dx + dy * dy);
      a = Math.max(a, sstep(rad * 2.1, rad * 0.35, dr) * 0.92);
    }
    const grain = 0.88 + 0.12 * fbm2(u * 9, v * 9, 271, 3);
    return clamp01(a * grain * sstep(1.0, 0.9, r));
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
