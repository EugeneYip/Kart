/**
 * ============================================================================
 *  APEX KART — MINIMAP
 * ============================================================================
 *  Canvas-2D. The track ribbon, start/finish and item-box markers are baked
 *  once into an offscreen layer; each frame only blits that layer and paints
 *  the racers. North-up by default (as MK8 does on the TV) with an optional
 *  heading-locked rotate mode.
 *
 *  Dot motion is smoothed independently of the physics tick so karts glide even
 *  when the HUD samples a stale state.
 * ============================================================================
 */

import type { KartState } from '@/core/Types';
import { damp } from '@/core/MathUtils';
import { ctx2d, el, kartColor, makeCanvas } from './Widgets';

interface Pt { x: number; y: number }

interface Dot {
  x: number;
  y: number;
  /** Smoothed heading, radians, in map space. */
  a: number;
  init: boolean;
}

/** Third column of a quaternion's rotation matrix → the kart's forward (−Z). */
function forwardXZ(q: { x: number; y: number; z: number; w: number }, out: Pt): Pt {
  out.x = -2 * (q.x * q.z + q.w * q.y);
  out.y = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return out;
}

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const tmpFwd: Pt = { x: 0, y: 0 };

export class Minimap {
  /** `.ak-map` wrapper — append this anywhere in the HUD. */
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;

  private c: CanvasRenderingContext2D | null;
  private layer: HTMLCanvasElement;
  private layerDirty = true;

  private path: Pt[] = [];
  private boxes: Pt[] = [];
  /** World→layer transform. */
  private sx = 1;
  private ox = 0;
  private oy = 0;

  private px = 0;          // device pixel size (square)
  private dpr = 1;
  private rotate = false;
  private rotation = 0;    // smoothed map rotation, radians

  private dots = new Map<number, Dot>();
  private label: HTMLDivElement;

  constructor(label = 'MAP') {
    this.el = el('div', 'ak-map');
    this.canvas = makeCanvas(2, 2);
    this.canvas.className = 'ak-map__canvas';
    this.el.appendChild(this.canvas);
    this.label = el('div', 'ak-map__label', this.el, label);
    this.c = ctx2d(this.canvas);
    this.layer = makeCanvas(2, 2);
  }

  setLabel(text: string): void {
    if (this.label.textContent !== text) this.label.textContent = text;
  }

  /** Accepts THREE.Vector2[] (x = world X, y = world Z) or any {x,y} list. */
  setPath(points: readonly Pt[] | null | undefined): void {
    if (!points || points.length < 3) { this.path = []; this.layerDirty = true; return; }
    this.path = points.map((p) => ({ x: p.x, y: p.y }));
    this.layerDirty = true;
  }

  setItemBoxes(points: readonly Pt[] | null | undefined): void {
    this.boxes = points ? points.map((p) => ({ x: p.x, y: p.y })) : [];
    this.layerDirty = true;
  }

  setRotate(on: boolean): void {
    if (this.rotate === on) return;
    this.rotate = on;
    this.setLabel(on ? 'MAP · TRACK-UP' : 'MAP');
  }

  get rotating(): boolean { return this.rotate; }

  /** CSS pixel size of the (square) map. */
  resize(cssSize: number, dpr: number): void {
    const px = Math.max(16, Math.round(cssSize * dpr));
    if (px === this.px && dpr === this.dpr) return;
    this.px = px;
    this.dpr = dpr;
    this.canvas.width = px;
    this.canvas.height = px;
    this.layer.width = px;
    this.layer.height = px;
    this.layerDirty = true;
  }

  // -----------------------------------------------------------------------

  private fit(): void {
    if (this.path.length < 3 || this.px <= 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of this.path) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    // Rotate mode needs slack so the loop never clips as it spins.
    const pad = this.px * (this.rotate ? 0.2 : 0.11);
    const span = Math.max(maxX - minX, maxY - minY, 1e-3);
    const usable = this.px - pad * 2;
    this.sx = (this.rotate ? usable / (span * 1.35) : usable / span);
    this.ox = this.px * 0.5 - ((minX + maxX) * 0.5) * this.sx;
    this.oy = this.px * 0.5 - ((minY + maxY) * 0.5) * this.sx;
  }

  private bakeLayer(): void {
    const c = ctx2d(this.layer);
    if (!c || this.px <= 0) return;
    this.fit();
    const S = this.px;
    c.clearRect(0, 0, S, S);
    if (this.path.length < 3) {
      c.fillStyle = 'rgba(180,210,250,0.35)';
      c.font = `800 ${Math.round(S * 0.07)}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.fillText('NO TRACK DATA', S * 0.5, S * 0.52);
      this.layerDirty = false;
      return;
    }

    const X = (p: Pt) => p.x * this.sx + this.ox;
    const Y = (p: Pt) => p.y * this.sx + this.oy;

    // Ribbon: dark casing, bright road, dashed centre line.
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(X(this.path[0]), Y(this.path[0]));
    for (let i = 1; i < this.path.length; i++) c.lineTo(X(this.path[i]), Y(this.path[i]));
    c.closePath();

    c.strokeStyle = 'rgba(2,5,12,0.92)';
    c.lineWidth = S * 0.075;
    c.stroke();

    const g = c.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, '#dfeaff');
    g.addColorStop(0.5, '#9fc0ea');
    g.addColorStop(1, '#c9dcf7');
    c.strokeStyle = g;
    c.lineWidth = S * 0.048;
    c.stroke();

    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.lineWidth = S * 0.008;
    c.setLineDash([S * 0.022, S * 0.03]);
    c.stroke();
    c.setLineDash([]);

    // Item boxes.
    for (const b of this.boxes) {
      const x = X(b), y = Y(b), r = S * 0.021;
      c.save();
      c.translate(x, y);
      c.rotate(Math.PI * 0.25);
      c.fillStyle = 'rgba(255,220,90,0.95)';
      c.strokeStyle = 'rgba(6,10,22,0.9)';
      c.lineWidth = S * 0.008;
      c.beginPath();
      c.rect(-r, -r, r * 2, r * 2);
      c.fill();
      c.stroke();
      c.restore();
    }

    // Start / finish: checker bar perpendicular to the tangent at index 0.
    const p0 = this.path[0];
    const p1 = this.path[Math.min(3, this.path.length - 1)];
    const ang = Math.atan2(Y(p1) - Y(p0), X(p1) - X(p0));
    c.save();
    c.translate(X(p0), Y(p0));
    c.rotate(ang);
    const hw = S * 0.032;
    const hh = S * 0.012;
    for (let i = -2; i < 2; i++) {
      c.fillStyle = i % 2 === 0 ? '#ffffff' : '#121826';
      c.fillRect(-hh * 1.5, i * hw * 0.5, hh * 3, hw * 0.5);
    }
    c.strokeStyle = 'rgba(6,10,22,0.9)';
    c.lineWidth = S * 0.006;
    c.strokeRect(-hh * 1.5, -hw, hh * 3, hw * 2);
    c.restore();

    this.layerDirty = false;
  }

  // -----------------------------------------------------------------------

  update(karts: readonly KartState[], player: KartState | null | undefined, dt: number): void {
    const c = this.c;
    if (!c || this.px <= 0) return;
    if (this.layerDirty) this.bakeLayer();

    const S = this.px;
    c.clearRect(0, 0, S, S);

    // Rotate mode: spin the whole scene so the player's heading points up.
    let rot = 0;
    if (this.rotate && player) {
      forwardXZ(player.quaternion, tmpFwd);
      const target = -Math.PI * 0.5 - Math.atan2(tmpFwd.y, tmpFwd.x);
      this.rotation += shortestAngle(this.rotation, target) * (1 - Math.pow(2, -dt / 0.09));
      rot = this.rotation;
    }

    if (rot !== 0) {
      c.save();
      c.translate(S * 0.5, S * 0.5);
      c.rotate(rot);
      c.translate(-S * 0.5, -S * 0.5);
    }
    c.drawImage(this.layer, 0, 0);
    if (rot !== 0) c.restore();

    if (this.path.length < 3 || karts.length === 0) return;

    // Leader gets a crown pip.
    let leaderId = -1;
    let bestPos = Infinity;
    for (const k of karts) {
      const p = k.racePosition > 0 ? k.racePosition : Infinity;
      if (p < bestPos) { bestPos = p; leaderId = k.id; }
    }

    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const half = S * 0.5;

    // AI first so the player's arrow always sits on top.
    for (let pass = 0; pass < 2; pass++) {
      for (const k of karts) {
        const isPlayer = k === player || k.isPlayer;
        if ((pass === 0) === isPlayer) continue;

        let d = this.dots.get(k.id);
        if (!d) { d = { x: 0, y: 0, a: 0, init: false }; this.dots.set(k.id, d); }

        const tx = k.position.x * this.sx + this.ox;
        const ty = k.position.z * this.sx + this.oy;
        forwardXZ(k.quaternion, tmpFwd);
        const ta = Math.atan2(tmpFwd.y, tmpFwd.x);
        if (!d.init) {
          d.x = tx; d.y = ty; d.a = ta; d.init = true;
        } else {
          d.x = damp(d.x, tx, 0.045, dt);
          d.y = damp(d.y, ty, 0.045, dt);
          d.a += shortestAngle(d.a, ta) * (1 - Math.pow(2, -dt / 0.05));
        }

        // Apply the map rotation manually so dot glyphs stay upright-ish.
        const rx = (d.x - half) * cos - (d.y - half) * sin + half;
        const ry = (d.x - half) * sin + (d.y - half) * cos + half;

        const color = isPlayer ? '#ffffff' : kartColor(k.id);
        const star = k.starTime > 0;

        if (star) {
          const gl = c.createRadialGradient(rx, ry, 0, rx, ry, S * 0.075);
          gl.addColorStop(0, 'rgba(255,240,140,0.9)');
          gl.addColorStop(1, 'rgba(255,210,60,0)');
          c.fillStyle = gl;
          c.beginPath();
          c.arc(rx, ry, S * 0.075, 0, Math.PI * 2);
          c.fill();
        }

        if (isPlayer) {
          // Big oriented arrow.
          const r = S * 0.055;
          c.save();
          c.translate(rx, ry);
          c.rotate(d.a + rot);
          c.beginPath();
          c.moveTo(r, 0);
          c.lineTo(-r * 0.72, -r * 0.78);
          c.lineTo(-r * 0.34, 0);
          c.lineTo(-r * 0.72, r * 0.78);
          c.closePath();
          c.fillStyle = '#ffffff';
          c.shadowColor = 'rgba(0,0,0,0.85)';
          c.shadowBlur = S * 0.035;
          c.fill();
          c.shadowBlur = 0;
          c.lineWidth = S * 0.013;
          c.strokeStyle = '#0b1222';
          c.stroke();
          // Inner tint so it never looks flat.
          c.beginPath();
          c.moveTo(r * 0.5, 0);
          c.lineTo(-r * 0.35, -r * 0.38);
          c.lineTo(-r * 0.35, r * 0.38);
          c.closePath();
          c.fillStyle = '#4ec8ff';
          c.fill();
          c.restore();
        } else {
          const r = S * 0.031;
          c.beginPath();
          c.arc(rx, ry + S * 0.006, r, 0, Math.PI * 2);
          c.fillStyle = 'rgba(0,0,0,0.55)';
          c.fill();
          c.beginPath();
          c.arc(rx, ry, r, 0, Math.PI * 2);
          const dg = c.createRadialGradient(rx - r * 0.4, ry - r * 0.5, r * 0.1, rx, ry, r * 1.3);
          dg.addColorStop(0, 'rgba(255,255,255,0.9)');
          dg.addColorStop(0.45, color);
          dg.addColorStop(1, 'rgba(0,0,0,0.35)');
          c.fillStyle = dg;
          c.fill();
          c.lineWidth = S * 0.009;
          c.strokeStyle = 'rgba(6,10,22,0.9)';
          c.stroke();
        }

        if (k.id === leaderId) {
          // Crown pip.
          const cy = ry - S * (isPlayer ? 0.078 : 0.052);
          c.beginPath();
          c.moveTo(rx - S * 0.021, cy + S * 0.014);
          c.lineTo(rx - S * 0.021, cy - S * 0.012);
          c.lineTo(rx - S * 0.008, cy + S * 0.001);
          c.lineTo(rx, cy - S * 0.016);
          c.lineTo(rx + S * 0.008, cy + S * 0.001);
          c.lineTo(rx + S * 0.021, cy - S * 0.012);
          c.lineTo(rx + S * 0.021, cy + S * 0.014);
          c.closePath();
          c.fillStyle = '#ffd447';
          c.strokeStyle = 'rgba(6,10,22,0.9)';
          c.lineWidth = S * 0.007;
          c.fill();
          c.stroke();
        }
      }
    }
  }

  dispose(): void {
    this.dots.clear();
    this.path.length = 0;
    this.boxes.length = 0;
    this.el.remove();
  }
}
