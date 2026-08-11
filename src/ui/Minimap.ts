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
  /** False when the ribbon is in a space kart positions can't be mapped into. */
  private dotsPlaceable = true;
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

  /**
   * Centreline loop. `space` declares which coordinate system the points are in:
   *
   *  - `'world'` — metres, the same space as `kart.position` (x, z). Racer dots
   *    can be placed, because the same world→map transform applies to both.
   *  - `'unit'` — bounding-box normalised to 0..1, which is what
   *    `Track.getMinimapPath()` returns. The ribbon draws, but kart positions
   *    cannot be mapped into it (the world bounds are not recoverable), so dots
   *    are suppressed rather than drawn thousands of pixels off-canvas.
   *
   * That mismatch is the reason the map showed no racer dots at all: the fit was
   * computed over a span of ~1 while karts were being plotted at ±200 m.
   */
  setPath(points: readonly Pt[] | null | undefined, space: 'world' | 'unit' = 'world'): void {
    if (!points || points.length < 3) { this.path = []; this.layerDirty = true; return; }
    this.path = points.map((p) => ({ x: p.x, y: p.y }));
    this.dotsPlaceable = space === 'world';
    this.dots.clear();
    // Markers belong to the outgoing coordinate space; keeping them would paint
    // world-metre item boxes into a 0..1 ribbon.
    this.boxes.length = 0;
    this.layerDirty = true;
  }

  /** True when the ribbon and the karts share a coordinate space. */
  get canPlaceDots(): boolean { return this.dotsPlaceable; }

  /** World-space (x, z) item-box markers. Ignored while the ribbon is unit-space. */
  setItemBoxes(points: readonly Pt[] | null | undefined): void {
    this.boxes = points && this.dotsPlaceable ? points.map((p) => ({ x: p.x, y: p.y })) : [];
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
    this.sprites.clear();          // every glyph is sized off `px`
    this.layerDirty = true;
  }

  // =======================================================================
  // Sprite bakery
  //
  // Drawing the racers straight onto the canvas cost a `createRadialGradient`
  // per AI dot per frame — 11 gradient objects and 11 shadowed path fills every
  // frame, which measured as ~90 % of the whole HUD's frame cost. Each glyph is
  // now rasterised once per (size, colour) and blitted, so the per-frame work is
  // 12 `drawImage` calls and no allocation at all. Invalidated on `resize()`.
  // =======================================================================

  private sprites = new Map<string, HTMLCanvasElement>();

  /** Blit a centred sprite at (x, y) in canvas space. */
  private blit(c: CanvasRenderingContext2D, sp: HTMLCanvasElement, x: number, y: number): void {
    c.drawImage(sp, x - sp.width * 0.5, y - sp.height * 0.5);
  }

  private sprite(key: string, size: number, paint: (c: CanvasRenderingContext2D, mid: number) => void): HTMLCanvasElement {
    const k = `${key}|${this.px}`;
    const hit = this.sprites.get(k);
    if (hit) return hit;
    const px = Math.max(2, Math.ceil(size));
    const cv = makeCanvas(px, px);
    const c = ctx2d(cv);
    if (c) paint(c, px * 0.5);
    this.sprites.set(k, cv);
    return cv;
  }

  private dotSprite(color: string): HTMLCanvasElement {
    const S = this.px;
    const r = S * 0.039;
    return this.sprite(`dot${color}`, r * 2 + S * 0.04, (c, mid) => {
      // Contact shadow, then a lit bead with a dark keyline.
      c.beginPath();
      c.arc(mid, mid + S * 0.006, r, 0, Math.PI * 2);
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.fill();
      const dg = c.createRadialGradient(mid - r * 0.4, mid - r * 0.5, r * 0.1, mid, mid, r * 1.3);
      dg.addColorStop(0, 'rgba(255,255,255,0.9)');
      dg.addColorStop(0.45, color);
      dg.addColorStop(1, 'rgba(0,0,0,0.35)');
      c.beginPath();
      c.arc(mid, mid, r, 0, Math.PI * 2);
      c.fillStyle = dg;
      c.fill();
      c.lineWidth = S * 0.009;
      c.strokeStyle = 'rgba(6,10,22,0.9)';
      c.stroke();
    });
  }

  private arrowSprite(): HTMLCanvasElement {
    const S = this.px;
    const r = S * 0.068;
    return this.sprite('arrow', r * 2 + S * 0.09, (c, mid) => {
      c.translate(mid, mid);
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
    });
  }

  private crownSprite(): HTMLCanvasElement {
    const S = this.px;
    return this.sprite('crown', S * 0.06, (c, mid) => {
      c.translate(mid, mid);
      c.beginPath();
      c.moveTo(-S * 0.021, S * 0.014);
      c.lineTo(-S * 0.021, -S * 0.012);
      c.lineTo(-S * 0.008, S * 0.001);
      c.lineTo(0, -S * 0.016);
      c.lineTo(S * 0.008, S * 0.001);
      c.lineTo(S * 0.021, -S * 0.012);
      c.lineTo(S * 0.021, S * 0.014);
      c.closePath();
      c.fillStyle = '#ffd447';
      c.strokeStyle = 'rgba(6,10,22,0.9)';
      c.lineWidth = S * 0.007;
      c.fill();
      c.stroke();
    });
  }

  private starSprite(): HTMLCanvasElement {
    const S = this.px;
    const r = S * 0.075;
    return this.sprite('star', r * 2, (c, mid) => {
      const gl = c.createRadialGradient(mid, mid, 0, mid, mid, r);
      gl.addColorStop(0, 'rgba(255,240,140,0.9)');
      gl.addColorStop(1, 'rgba(255,210,60,0)');
      c.fillStyle = gl;
      c.beginPath();
      c.arc(mid, mid, r, 0, Math.PI * 2);
      c.fill();
    });
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
      const x = X(b), y = Y(b), r = S * 0.024;
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

    if (this.path.length < 3 || karts.length === 0 || !this.dotsPlaceable) return;

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

        if (k.starTime > 0) this.blit(c, this.starSprite(), rx, ry);

        if (isPlayer) {
          // Big oriented arrow. Baked flat and rotated as an image: the shadow
          // blur and the three fills used to be re-rasterised every frame.
          const sp = this.arrowSprite();
          c.save();
          c.translate(rx, ry);
          c.rotate(d.a + rot);
          c.drawImage(sp, -sp.width * 0.5, -sp.height * 0.5);
          c.restore();
        } else {
          this.blit(c, this.dotSprite(color), rx, ry);
        }

        if (k.id === leaderId) {
          this.blit(c, this.crownSprite(), rx, ry - S * (isPlayer ? 0.082 : 0.056));
        }
      }
    }
  }

  dispose(): void {
    this.dots.clear();
    this.sprites.clear();
    this.path.length = 0;
    this.boxes.length = 0;
    this.canvas.width = this.canvas.height = 0;
    this.layer.width = this.layer.height = 0;
    this.el.remove();
  }
}
