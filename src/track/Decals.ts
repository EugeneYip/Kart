/**
 * ============================================================================
 *  Decals — everything painted on the road
 * ============================================================================
 *
 *  Two complementary layers, because one resolution cannot serve both jobs:
 *
 *  1. **Track-space stain atlas.** A single canvas whose U axis is "across the
 *     road, 0..1" and whose V axis is "along the lap, 0..1". It is sampled by
 *     the road shader through the second UV set, so it never tiles and never
 *     slides. It carries the *soft, continuous* story of the surface: braking
 *     skid patches before every corner (found from the spline's own
 *     curvature), rubber laid through the apexes, tar seams, slab repairs and
 *     puddles. Soft features survive low resolution, so 512 x 4096 is plenty.
 *
 *  2. **Crisp decal quads.** Paint has hard edges, and hard edges need pixels.
 *     The start/finish grid, lane arrows, hairpin chevrons and tarmac sponsor
 *     logos are real (tiny) quads laid on the road surface — they follow the
 *     crown camber and banking exactly, because their vertices come from the
 *     same cross-section function the road itself is built from. All of them
 *     share one merged geometry, one 2048 atlas and one draw call.
 * ============================================================================
 */

import * as THREE from 'three';
import * as TX from '@/render/TextureFactory';
import { clamp01, Rng } from '@/core/MathUtils';
import type { QualitySettings } from '@/core/Types';
import { TF, makeSample } from './TrackSpline';
import type { TrackSpline } from './TrackSpline';
import { roadSurfacePoint, CROSS } from './TrackBuilder';
import type { TrackDef } from './TrackDefs';

// ---------------------------------------------------------------------------
// Atlas layout — 4 x 4 cells of 512 px
// ---------------------------------------------------------------------------

export const CELL = {
  gridBand: 0,
  laneArrow: 1,
  chevronL: 2,
  chevronR: 3,
  logoApex: 4,
  logoNitro: 5,
  logoTorque: 6,
  dash: 7,
  hazardStripe: 8,
  manhole: 9,
  startNumbers: 10,
  boostArrows: 11,
  crackPatch: 12,
  scrubArc: 13,
  finishText: 14,
  sectorBand: 15,
} as const;

const ATLAS_COLS = 4;

/** One crisp decal quad, authored in track space. */
export interface DecalQuad {
  cell: number;
  /** Normalised lap position of the quad centre. */
  t: number;
  /** Lateral offset of the quad centre, metres. */
  lat: number;
  /** Width across the road, metres. */
  w: number;
  /** Length along the road, metres. */
  l: number;
  /** 0..1 fade. */
  opacity?: number;
  /** Flip U so a chevron cell can serve both hands. */
  flipU?: boolean;
}

// ---------------------------------------------------------------------------
// Canvas painting
// ---------------------------------------------------------------------------

function paintAtlas(size: number): THREE.CanvasTexture {
  const cs = size / ATLAS_COLS;
  return TX.canvasTexture(size, size, (ctx) => {
    ctx.clearRect(0, 0, size, size);
    const at = (idx: number) => {
      ctx.save();
      ctx.translate((idx % ATLAS_COLS) * cs, Math.floor(idx / ATLAS_COLS) * cs);
      ctx.beginPath();
      ctx.rect(0, 0, cs, cs);
      ctx.clip();
      return cs;
    };
    const end = () => ctx.restore();

    // --- 0: start/finish chequer band ------------------------------------
    {
      const s = at(CELL.gridBand);
      const n = 16;
      const q = s / n;
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < n; x++) {
          ctx.fillStyle = (x + y) % 2 === 0 ? '#f4f2ec' : '#191919';
          ctx.fillRect(x * q, s * 0.5 - q + y * q, q + 0.6, q + 0.6);
        }
      }
      // worn edges
      ctx.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 260; i++) {
        ctx.globalAlpha = 0.05 + Math.random() * 0.35;
        ctx.beginPath();
        ctx.arc(Math.random() * s, s * 0.5 - q + Math.random() * q * 2, 1 + Math.random() * 6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      end();
    }

    // --- 1: lane arrow (double chevron, points -V i.e. forward) ------------
    {
      const s = at(CELL.laneArrow);
      ctx.fillStyle = '#f2efe4';
      const arrow = (yc: number, h: number) => {
        ctx.beginPath();
        ctx.moveTo(s * 0.5, yc - h * 0.5);
        ctx.lineTo(s * 0.92, yc + h * 0.18);
        ctx.lineTo(s * 0.72, yc + h * 0.18);
        ctx.lineTo(s * 0.72, yc + h * 0.5);
        ctx.lineTo(s * 0.28, yc + h * 0.5);
        ctx.lineTo(s * 0.28, yc + h * 0.18);
        ctx.lineTo(s * 0.08, yc + h * 0.18);
        ctx.closePath();
        ctx.fill();
      };
      arrow(s * 0.3, s * 0.38);
      arrow(s * 0.72, s * 0.38);
      wear(ctx, s, 0.3);
      end();
    }

    // --- 2 / 3: warning chevrons -----------------------------------------
    for (const [idx, dir] of [[CELL.chevronL, -1], [CELL.chevronR, 1]] as const) {
      const s = at(idx);
      for (let i = 0; i < 3; i++) {
        const y = s * (0.16 + i * 0.3);
        ctx.fillStyle = i === 1 ? '#ffd23c' : '#f4f2ec';
        ctx.beginPath();
        const w = s * 0.42;
        const cx = s * 0.5 - dir * s * 0.05;
        ctx.moveTo(cx - w, y);
        ctx.lineTo(cx, y + s * 0.14 * dir);
        ctx.lineTo(cx + w, y);
        ctx.lineTo(cx + w, y + s * 0.09);
        ctx.lineTo(cx, y + s * 0.23 * dir);
        ctx.lineTo(cx - w, y + s * 0.09);
        ctx.closePath();
        ctx.fill();
      }
      wear(ctx, s, 0.35);
      end();
    }

    // --- 4/5/6: tarmac sponsor logos -------------------------------------
    logo(ctx, at(CELL.logoApex), 'APEX', '#e8452f', '#f7f3e8');
    end();
    logo(ctx, at(CELL.logoNitro), 'NITRO', '#2f7de8', '#eaf3ff');
    end();
    logo(ctx, at(CELL.logoTorque), 'TORQUE', '#22b07a', '#effff7');
    end();

    // --- 7: dashed lane divider ------------------------------------------
    {
      const s = at(CELL.dash);
      ctx.fillStyle = '#eae7dc';
      ctx.fillRect(s * 0.4, s * 0.05, s * 0.2, s * 0.55);
      wear(ctx, s, 0.4);
      end();
    }

    // --- 8: hazard stripes ------------------------------------------------
    {
      const s = at(CELL.hazardStripe);
      ctx.fillStyle = '#f2c400';
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = '#161616';
      ctx.save();
      ctx.translate(-s, 0);
      for (let i = 0; i < 20; i++) {
        ctx.beginPath();
        ctx.moveTo(i * s * 0.2, 0);
        ctx.lineTo(i * s * 0.2 + s * 0.1, 0);
        ctx.lineTo(i * s * 0.2 + s * 0.1 + s, s);
        ctx.lineTo(i * s * 0.2 + s, s);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      wear(ctx, s, 0.45);
      end();
    }

    // --- 9: inspection cover ---------------------------------------------
    {
      const s = at(CELL.manhole);
      const g = ctx.createRadialGradient(s * 0.5, s * 0.5, s * 0.1, s * 0.5, s * 0.5, s * 0.46);
      g.addColorStop(0, '#4a4642');
      g.addColorStop(0.86, '#3a3733');
      g.addColorStop(1, '#2a2724');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.5, s * 0.44, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,18,16,0.75)';
      ctx.lineWidth = s * 0.02;
      for (let i = 1; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(s * 0.5, s * 0.5, s * 0.44 * (i / 5), 0, Math.PI * 2);
        ctx.stroke();
      }
      end();
    }

    // --- 10: grid slot numbers -------------------------------------------
    {
      const s = at(CELL.startNumbers);
      ctx.strokeStyle = '#f0ede2';
      ctx.lineWidth = s * 0.035;
      ctx.strokeRect(s * 0.12, s * 0.1, s * 0.76, s * 0.8);
      ctx.fillStyle = '#f0ede2';
      ctx.font = `bold ${Math.round(s * 0.52)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', s * 0.5, s * 0.52);
      wear(ctx, s, 0.4);
      end();
    }

    // --- 11: boost arrows -------------------------------------------------
    {
      const s = at(CELL.boostArrows);
      for (let i = 0; i < 4; i++) {
        const y = s * (0.12 + i * 0.24);
        const a = 0.35 + i * 0.2;
        ctx.fillStyle = `rgba(120,225,255,${a})`;
        ctx.beginPath();
        ctx.moveTo(s * 0.5, y);
        ctx.lineTo(s * 0.9, y + s * 0.14);
        ctx.lineTo(s * 0.5, y + s * 0.07);
        ctx.lineTo(s * 0.1, y + s * 0.14);
        ctx.closePath();
        ctx.fill();
      }
      end();
    }

    // --- 12: crack / patch overlay ---------------------------------------
    {
      const s = at(CELL.crackPatch);
      ctx.strokeStyle = 'rgba(24,22,20,0.6)';
      const rng = new Rng(77);
      for (let i = 0; i < 14; i++) {
        ctx.lineWidth = 1 + rng.next() * 3;
        ctx.beginPath();
        let x = rng.next() * s;
        let y = rng.next() * s;
        ctx.moveTo(x, y);
        for (let k = 0; k < 6; k++) {
          x += (rng.next() - 0.5) * s * 0.3;
          y += (rng.next() - 0.5) * s * 0.3;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      end();
    }

    // --- 13: tyre scrub arc ----------------------------------------------
    {
      const s = at(CELL.scrubArc);
      for (let i = 0; i < 3; i++) {
        ctx.strokeStyle = `rgba(18,16,15,${0.34 - i * 0.08})`;
        ctx.lineWidth = s * (0.1 - i * 0.02);
        ctx.beginPath();
        ctx.arc(s * (1.3 + i * 0.1), s * 0.5, s * (1.0 + i * 0.06), Math.PI * 0.78, Math.PI * 1.22);
        ctx.stroke();
      }
      end();
    }

    // --- 14: FINISH lettering --------------------------------------------
    {
      const s = at(CELL.finishText);
      ctx.fillStyle = '#f4f1e6';
      ctx.font = `bold ${Math.round(s * 0.3)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.translate(s * 0.5, s * 0.5);
      ctx.scale(1, 1.9);
      ctx.fillText('FINISH', 0, 0);
      ctx.restore();
      wear(ctx, s, 0.35);
      end();
    }

    // --- 15: sector timing band ------------------------------------------
    {
      const s = at(CELL.sectorBand);
      ctx.fillStyle = 'rgba(240,238,228,0.9)';
      ctx.fillRect(0, s * 0.42, s, s * 0.16);
      wear(ctx, s, 0.4);
      end();
    }
  }, { srgb: true, repeat: 1 });
}

/** Knock holes in whatever was just drawn so paint reads as worn. */
function wear(ctx: CanvasRenderingContext2D, s: number, amount: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const n = Math.round(300 * amount);
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = 0.05 + Math.random() * 0.5 * amount;
    ctx.beginPath();
    ctx.arc(Math.random() * s, Math.random() * s, 1 + Math.random() * 7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function logo(
  ctx: CanvasRenderingContext2D,
  s: number,
  text: string,
  bg: string,
  fg: string,
): void {
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = bg;
  ctx.beginPath();
  const r = s * 0.06;
  const x = s * 0.04;
  const y = s * 0.3;
  const w = s * 0.92;
  const h = s * 0.4;
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = fg;
  ctx.font = `bold ${Math.round(s * 0.22)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, s * 0.5, y + h * 0.52);
  ctx.restore();
  wear(ctx, s, 0.5);
}

// ---------------------------------------------------------------------------
// Track-space stain layer
// ---------------------------------------------------------------------------

const _sample = makeSample();

function paintStains(
  spline: TrackSpline,
  def: TrackDef,
  w: number,
  h: number,
): THREE.CanvasTexture {
  const L = spline.length;
  const rng = new Rng(def.terrainSeed ^ 0x5f3a);

  // Curvature profile: 1 sample per 3 m, so braking zones can be located.
  const N = Math.max(64, Math.ceil(L / 3));
  const curv = new Float32Array(N);
  for (let i = 0; i < N; i++) curv[i] = spline.curvatureAtDistance((i / N) * L);
  // smooth once
  const sm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    sm[i] = (curv[(i - 1 + N) % N] + 2 * curv[i] + curv[(i + 1) % N]) * 0.25;
  }

  return TX.canvasTexture(w, h, (ctx) => {
    ctx.clearRect(0, 0, w, h);
    const vOf = (d: number) => (d / L) * h;
    const uOf = (lat: number, hw: number) => (0.5 + lat / (hw * 2)) * w;

    // --- tar seams: lateral joins every ~28 m, plus one long centre seam ---
    ctx.strokeStyle = 'rgba(28,26,25,0.5)';
    for (let d = 0; d < L; d += 24 + rng.next() * 14) {
      const y = vOf(d);
      ctx.lineWidth = 1.2 + rng.next() * 2.4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(w * 0.3, y + (rng.next() - 0.5) * 4, w * 0.7, y + (rng.next() - 0.5) * 4, w, y + (rng.next() - 0.5) * 3);
      ctx.stroke();
    }
    // longitudinal construction seam, wanders across the road
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(30,28,26,0.42)';
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const x = w * (0.34 + Math.sin(i * 0.7) * 0.05 + Math.sin(i * 0.19) * 0.06);
      const y = (i / 60) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // --- slab repairs -------------------------------------------------------
    for (let i = 0; i < 26; i++) {
      const d = rng.next() * L;
      const y = vOf(d);
      const bh = (6 + rng.next() * 22) / L * h;
      const bx = rng.next() * w * 0.7;
      const bw = w * (0.16 + rng.next() * 0.4);
      ctx.fillStyle = `rgba(${34 + rng.next() * 22 | 0},${32 + rng.next() * 20 | 0},${31 + rng.next() * 18 | 0},${0.16 + rng.next() * 0.2})`;
      ctx.fillRect(bx, y, bw, bh);
      ctx.strokeStyle = 'rgba(20,19,18,0.45)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, y, bw, bh);
    }

    // --- braking + apex rubber ---------------------------------------------
    // Braking zones: |curvature| about to rise sharply. Apex: local max.
    for (let i = 0; i < N; i++) {
      const k = Math.abs(sm[i]);
      const ahead = Math.abs(sm[(i + 6) % N]);
      const d = (i / N) * L;
      spline.sampleAtDistance(d, _sample);
      const hw = _sample.halfWidth;

      // 1/R above 1/140 m counts as a corner
      if (k > 0.007) {
        // rubber through the apex, biased to the inside
        const side = Math.sign(sm[i]) || 1;
        const lat = -side * hw * (0.1 + Math.min(0.42, k * 22));
        const y = vOf(d);
        const rw = w * (0.18 + Math.min(0.3, k * 14));
        const g = ctx.createLinearGradient(uOf(lat, hw) - rw, 0, uOf(lat, hw) + rw, 0);
        g.addColorStop(0, 'rgba(20,18,17,0)');
        g.addColorStop(0.5, `rgba(20,18,17,${Math.min(0.4, 0.1 + k * 16)})`);
        g.addColorStop(1, 'rgba(20,18,17,0)');
        ctx.fillStyle = g;
        ctx.fillRect(uOf(lat, hw) - rw, y - 1, rw * 2, (3 / L) * h + 2);
      }

      // Braking marks: straight now, hard corner soon.
      if (k < 0.004 && ahead > 0.011) {
        const y = vOf(d);
        const len = (26 / L) * h;
        for (let s2 = 0; s2 < 6; s2++) {
          const lat = (rng.next() - 0.5) * hw * 1.5;
          const x = uOf(lat, hw);
          const a = 0.05 + rng.next() * 0.16;
          const g = ctx.createLinearGradient(0, y, 0, y + len);
          g.addColorStop(0, `rgba(22,20,19,0)`);
          g.addColorStop(0.7, `rgba(22,20,19,${a})`);
          g.addColorStop(1, `rgba(22,20,19,0)`);
          ctx.fillStyle = g;
          ctx.fillRect(x - w * 0.012, y, w * 0.024, len);
        }
      }
    }

    // --- standing water on wet segments ------------------------------------
    for (let d = 0; d < L; d += 6) {
      if ((spline.flagsAtDistance(d) & TF.Wet) === 0) continue;
      spline.sampleAtDistance(d, _sample);
      const hw = _sample.halfWidth;
      for (let i = 0; i < 2; i++) {
        const lat = (rng.next() - 0.5) * hw * 1.7;
        const x = uOf(lat, hw);
        const y = vOf(d + rng.next() * 6);
        const rx = w * (0.03 + rng.next() * 0.09);
        const ry = ((3 + rng.next() * 9) / L) * h;
        const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
        g.addColorStop(0, 'rgba(16,20,26,0.42)');
        g.addColorStop(1, 'rgba(16,20,26,0)');
        ctx.fillStyle = g;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, Math.max(0.2, ry / Math.max(1e-3, rx)));
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // --- dirt washed in from the verges ------------------------------------
    for (const side of [0, 1]) {
      const g = ctx.createLinearGradient(side === 0 ? 0 : w, 0, side === 0 ? w * 0.16 : w * 0.84, 0);
      g.addColorStop(0, 'rgba(96,82,58,0.34)');
      g.addColorStop(1, 'rgba(96,82,58,0)');
      ctx.fillStyle = g;
      ctx.fillRect(side === 0 ? 0 : w * 0.84, 0, w * 0.16, h);
    }
  }, { srgb: true, repeat: 1 });
}

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _pc = new THREE.Vector3();
const _pd = new THREE.Vector3();

export class Decals {
  /** Sampled by the road shader through the second UV set. */
  readonly stainTexture: THREE.CanvasTexture;
  /** Crisp paint, one draw call. */
  readonly mesh: THREE.Mesh;
  private atlas: THREE.CanvasTexture;
  private material: THREE.MeshStandardMaterial;
  private geometry: THREE.BufferGeometry;

  constructor(spline: TrackSpline, def: TrackDef, quality: QualitySettings) {
    const low = quality.tier === 'low';
    const stainW = low ? 256 : 512;
    const stainH = low ? 2048 : 4096;
    this.stainTexture = paintStains(spline, def, stainW, stainH);
    this.stainTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.stainTexture.wrapT = THREE.RepeatWrapping;
    TX.setAnisotropy(this.stainTexture, quality.anisotropy);

    this.atlas = paintAtlas(low ? 1024 : 2048);
    TX.setAnisotropy(this.atlas, quality.anisotropy);

    const quads = this.authorQuads(spline, def);
    this.geometry = this.buildGeometry(spline, quads);
    this.material = new THREE.MeshStandardMaterial({
      name: 'apx-decals',
      map: this.atlas,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      roughness: 0.62,
      metalness: 0,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
      side: THREE.FrontSide,
      dithering: true,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'trackDecals';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 20;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /**
   * Where each crisp decal goes. Grid + finish text at the line; arrows down
   * the straights; chevrons wherever curvature says "slow down NOW"; sponsor
   * logos in the runoff-facing halves of fast corners.
   */
  private authorQuads(spline: TrackSpline, def: TrackDef): DecalQuad[] {
    const out: DecalQuad[] = [];
    const L = spline.length;
    const tOf = (d: number) => ((d % L) + L) / L % 1;

    // --- start / finish ----------------------------------------------------
    spline.sampleAtDistance(0.0001, _sample);
    const hw0 = _sample.halfWidth;
    out.push({ cell: CELL.gridBand, t: tOf(1.2), lat: 0, w: hw0 * 2 - 1.2, l: 2.6 });
    out.push({ cell: CELL.finishText, t: tOf(9), lat: 0, w: hw0 * 1.05, l: 7 });
    // twelve grid boxes behind the line
    for (let i = 0; i < 12; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      out.push({
        cell: CELL.startNumbers,
        t: tOf(L - 8 - row * 8.4),
        lat: side * hw0 * 0.42,
        w: 3.0,
        l: 5.2,
        opacity: 0.8,
      });
    }
    out.push({ cell: CELL.sectorBand, t: tOf(L / 3), lat: 0, w: hw0 * 2 - 2, l: 1.4, opacity: 0.75 });
    out.push({ cell: CELL.sectorBand, t: tOf((L * 2) / 3), lat: 0, w: hw0 * 2 - 2, l: 1.4, opacity: 0.75 });

    // --- curvature-driven furniture ---------------------------------------
    const step = 4;
    const logos = [CELL.logoApex, CELL.logoNitro, CELL.logoTorque];
    let logoIdx = 0;
    let lastChevron = -1e9;
    let lastArrow = -1e9;
    let lastLogo = -1e9;
    let lastManhole = -1e9;
    const rng = new Rng(def.terrainSeed ^ 0x2b17);

    for (let d = 0; d < L; d += step) {
      const flags = spline.flagsAtDistance(d);
      if (flags & TF.Gap) continue;
      spline.sampleAtDistance(d, _sample);
      const hw = _sample.halfWidth;
      const k = spline.curvatureAtDistance(d);
      const kAhead = spline.curvatureAtDistance(d + 34);
      const ak = Math.abs(k);
      const akAhead = Math.abs(kAhead);

      // Chevrons on the approach to anything tighter than R 70 m.
      if (ak < 0.007 && akAhead > 0.0143 && d - lastChevron > 60) {
        lastChevron = d;
        const dir = Math.sign(kAhead) || 1;
        for (let i = 0; i < 3; i++) {
          out.push({
            cell: dir > 0 ? CELL.chevronR : CELL.chevronL,
            t: tOf(d + i * 9),
            lat: dir * hw * 0.6,
            w: hw * 0.62,
            l: 7,
            opacity: 0.85,
          });
        }
      }

      // Lane arrows on genuine straights.
      if (ak < 0.0035 && akAhead < 0.006 && d - lastArrow > 46 && !(flags & (TF.Ramp | TF.Grid))) {
        lastArrow = d;
        out.push({ cell: CELL.laneArrow, t: tOf(d), lat: -hw * 0.45, w: 2.6, l: 6.5, opacity: 0.7 });
        out.push({ cell: CELL.laneArrow, t: tOf(d), lat: hw * 0.45, w: 2.6, l: 6.5, opacity: 0.7 });
      }

      // Sponsor logos in the wide half of a fast corner.
      if (ak > 0.004 && ak < 0.012 && d - lastLogo > 95) {
        lastLogo = d;
        const dir = Math.sign(k) || 1;
        out.push({
          cell: logos[logoIdx++ % logos.length],
          t: tOf(d),
          lat: -dir * hw * 0.58,
          w: hw * 0.7,
          l: 9,
          opacity: 0.9,
        });
      }

      // Street furniture in the city.
      if (def.theme === 'city' && d - lastManhole > 70 && rng.next() > 0.4) {
        lastManhole = d;
        out.push({ cell: CELL.manhole, t: tOf(d), lat: (rng.next() - 0.5) * hw * 1.3, w: 1.5, l: 1.5, opacity: 1 });
      }

      // Cracked patches anywhere off the ideal line.
      if (rng.next() > 0.93) {
        out.push({
          cell: CELL.crackPatch,
          t: tOf(d),
          lat: (rng.next() - 0.5) * hw * 1.8,
          w: 3 + rng.next() * 5,
          l: 3 + rng.next() * 6,
          opacity: 0.5,
        });
      }
    }

    // --- boost pad arrows -------------------------------------------------
    for (const pad of def.boostPads) {
      out.push({ cell: CELL.boostArrows, t: pad.t, lat: pad.lat, w: pad.width * 0.9, l: pad.length * 0.95, opacity: 0.9 });
    }

    // --- hazard stripes at gap lips ---------------------------------------
    for (let d = 0; d < L; d += 2) {
      if (!(spline.flagsAtDistance(d) & TF.Gap)) continue;
      spline.sampleAtDistance(d, _sample);
      out.push({ cell: CELL.hazardStripe, t: tOf(d - 3), lat: 0, w: _sample.halfWidth * 2 - 0.8, l: 1.6 });
      // skip to the end of this gap
      while (d < L && spline.flagsAtDistance(d) & TF.Gap) d += 2;
      spline.sampleAtDistance(d, _sample);
      out.push({ cell: CELL.hazardStripe, t: tOf(d + 2), lat: 0, w: _sample.halfWidth * 2 - 0.8, l: 1.6 });
    }

    return out;
  }

  /** One quad per decal, welded to the real road surface. */
  private buildGeometry(spline: TrackSpline, quads: DecalQuad[]): THREE.BufferGeometry {
    const n = quads.length;
    const pos = new Float32Array(n * 4 * 3);
    const nrm = new Float32Array(n * 4 * 3);
    const uv = new Float32Array(n * 4 * 2);
    const col = new Float32Array(n * 4 * 3);
    const idx = new Uint32Array(n * 6);
    const L = spline.length;
    const cw = 1 / ATLAS_COLS;
    // Nudge decals a whisker off the road so polygonOffset has an easy job.
    const LIFT = 0.012;

    for (let i = 0; i < n; i++) {
      const q = quads[i];
      const d = q.t * L;
      const halfL = q.l * 0.5;
      const halfW = q.w * 0.5;
      const o = q.opacity ?? 1;

      roadSurfacePoint(spline, d - halfL, q.lat - halfW, _pa, _n);
      _pa.addScaledVector(_n, LIFT);
      roadSurfacePoint(spline, d - halfL, q.lat + halfW, _pb, _n);
      _pb.addScaledVector(_n, LIFT);
      roadSurfacePoint(spline, d + halfL, q.lat + halfW, _pc, _n);
      _pc.addScaledVector(_n, LIFT);
      roadSurfacePoint(spline, d + halfL, q.lat - halfW, _pd, _n);
      _pd.addScaledVector(_n, LIFT);
      // one shared normal is fine at this size
      roadSurfacePoint(spline, d, q.lat, _p, _n);

      const cellX = (q.cell % ATLAS_COLS) * cw;
      const cellY = Math.floor(q.cell / ATLAS_COLS) * cw;
      const u0 = q.flipU ? cellX + cw : cellX;
      const u1 = q.flipU ? cellX : cellX + cw;
      // Canvas rows run +V downward while the track runs +V forward, so the
      // cell is flipped in V to keep arrows pointing the way you drive.
      const v0 = 1 - (cellY + cw);
      const v1 = 1 - cellY;

      const b = i * 4;
      const verts = [_pa, _pb, _pc, _pd];
      const uvs = [u0, v0, u1, v0, u1, v1, u0, v1];
      for (let k = 0; k < 4; k++) {
        pos[(b + k) * 3 + 0] = verts[k].x;
        pos[(b + k) * 3 + 1] = verts[k].y;
        pos[(b + k) * 3 + 2] = verts[k].z;
        nrm[(b + k) * 3 + 0] = _n.x;
        nrm[(b + k) * 3 + 1] = _n.y;
        nrm[(b + k) * 3 + 2] = _n.z;
        uv[(b + k) * 2 + 0] = uvs[k * 2];
        uv[(b + k) * 2 + 1] = uvs[k * 2 + 1];
        col[(b + k) * 3 + 0] = o;
        col[(b + k) * 3 + 1] = o;
        col[(b + k) * 3 + 2] = o;
      }
      const io = i * 6;
      idx[io + 0] = b + 0;
      idx[io + 1] = b + 1;
      idx[io + 2] = b + 2;
      idx[io + 3] = b + 0;
      idx[io + 4] = b + 2;
      idx[io + 5] = b + 3;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  get quadCount(): number {
    const i = this.geometry.getIndex();
    return i ? i.count / 6 : 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
    this.stainTexture.dispose();
  }
}

/** Re-exported so Track can size the road's UV1 against the same constant. */
export { CROSS };
