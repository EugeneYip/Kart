/**
 * ============================================================================
 *  FOXY KART — UI / HUD DEV HARNESS
 * ============================================================================
 *  Measurement-first. The HUD is mounted inside a `#stage` div whose
 *  `transform` makes it the containing block for `position: fixed`, so the HUD
 *  lays out against the stage rather than the window. That means every target
 *  viewport (800x450 … 1920x1080) can be measured at 1:1 without touching the
 *  browser window — which matters because the shared preview pane only renders
 *  1:1 at 800x450.
 *
 *  `window.__UIQA__` is the whole API:
 *    setSize(w, h)          resize the stage + drive HUD.resize (production path)
 *    setPos(n)              force race position n (1..12)
 *    setState(s)            'countdown' | 'racing' | 'finished'
 *    finalLap() / blue() / countdown(n) / results()
 *    frame(dt)              one HUD update tick
 *    audit()                overflow + containment + overlap + plate-% report
 *    sweep()                audit() across all 4 sizes x positions 1..12
 *    table()                the sweep as a printable text table
 *    bench(n)               measured HUD cost per frame
 *
 *  Delete this file once the HUD work is signed off.
 * ============================================================================
 */

import * as THREE from 'three';
import { DriftStage, ItemType, SurfaceType } from '@/core/Types';
import type { FrameContext, KartState, QualitySettings } from '@/core/Types';
import { HUD } from '@/ui/HUD';
import { Results } from '@/ui/Results';
import type { ResultRow } from '@/ui/Results';
import { uiScale } from '@/ui/Widgets';

// ===========================================================================
// Stubs
// ===========================================================================

const RACER_NAMES = [
  'NOVA', 'PIP', 'BRAWN', 'ZINNIA', 'KOJI', 'MARLOW',
  'TALLY', 'RUFUS', 'ODESSA', 'BLINK', 'GRIT', 'WREN',
];

function makeKart(id: number, isPlayer: boolean): KartState {
  return {
    id, isPlayer,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    groundQuaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    speed: 0, speedRatio: 0, angularVelocity: 0,
    steerAngle: 0,
    suspension: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    wheelGrounded: [true, true, true, true],
    grounded: true, airTime: 0, surface: SurfaceType.Road,
    drifting: false, driftStage: DriftStage.None, driftDirection: 0, driftCharge: 0,
    boostTime: 0, boostStrength: 0,
    hopping: false, stunned: false, stunTime: 0, invulnerable: false, starTime: 0,
    gliding: false, antiGravity: false,
    lap: 1, progress: 0, racePosition: id + 1, finished: false, finishTime: 0, lapTimes: [],
    rpm: 0, heldItem: null, itemCount: 0,
  };
}

const KARTS: KartState[] = [];
for (let i = 0; i < 12; i++) KARTS.push(makeKart(i, i === 0));

/** A closed racetrack loop in WORLD metres — same space kart positions live in. */
function worldLoop(points = 220): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const r = 210 + 58 * Math.sin(a * 2 + 0.7) + 26 * Math.cos(a * 3);
    out.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r * 0.72));
  }
  return out;
}

const LOOP = worldLoop();

/** Bounding-box-normalised copy — mimics what Track.getMinimapPath() returns. */
function unitLoop(): THREE.Vector2[] {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of LOOP) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const s = 1 / Math.max(maxX - minX, maxY - minY);
  return LOOP.map((p) => new THREE.Vector2((p.x - minX) * s, (p.y - minY) * s));
}

/** Which flavour of path the fake track hands out. `unit` is what ships today. */
let pathSpace: 'unit' | 'world' | 'none' = 'unit';

const track = {
  lapLength: 1420,
  lapCount: 3,
  ready: true,
  getMinimapPath(): readonly { x: number; y: number }[] {
    if (pathSpace === 'none') return [];
    return pathSpace === 'unit' ? unitLoop() : LOOP;
  },
  /** World-space sampler, mirroring Track.sampleAtDistance(). */
  sampleAtDistance(d: number): { position: THREE.Vector3 } {
    const L = 1420;
    const t = ((d % L) + L) % L / L;
    const i = t * LOOP.length;
    const a = LOOP[Math.floor(i) % LOOP.length];
    const b = LOOP[(Math.floor(i) + 1) % LOOP.length];
    const f = i - Math.floor(i);
    return { position: new THREE.Vector3(a.x + (b.x - a.x) * f, 0, a.y + (b.y - a.y) * f) };
  },
  getItemBoxSpawns(): Array<{ position: THREE.Vector3 }> {
    const out: Array<{ position: THREE.Vector3 }> = [];
    for (let i = 0; i < 8; i++) out.push(track.sampleAtDistance((i / 8) * 1420));
    return out;
  },
};

const race = {
  state: 'racing' as string,
  countdown: 0,
  raceTime: 74.312,
  totalLaps: 3,
  getPosition: (id: number): number => KARTS[id]?.racePosition ?? 1,
  getLap: (id: number): number => KARTS[id]?.lap ?? 1,
};

const karts = {
  get karts(): readonly KartState[] { return KARTS; },
  get player(): KartState | null { return KARTS[0]; },
  getName: (id: number): string => (id === 0 ? 'YOU' : RACER_NAMES[id % RACER_NAMES.length]),
};

const stage = document.getElementById('stage') as HTMLDivElement;
const out = document.getElementById('out') as HTMLDivElement;
const bar = document.getElementById('bar') as HTMLDivElement;

const camera = new THREE.PerspectiveCamera(58, 800 / 450, 0.1, 2000);
const quality: QualitySettings = {
  tier: 'high', renderScale: 1, shadowMapSize: 2048, cascadeCount: 2,
  ssao: false, ssr: false, motionBlur: false, bloom: true, dof: false,
  particleBudget: 2000, anisotropy: 4, foliageDensity: 1, reflectionProbes: false,
};

const engine = {
  camera,
  renderer: { info: { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } } },
  quality,
  fpsAverage: 60,
  getSize: (): { width: number; height: number } => ({ width: stage.clientWidth, height: stage.clientHeight }),
};

const hud = new HUD(stage, karts, race, track, engine);
const results = new Results(stage);

/** The post-race board shares `--u` and the same clip-vs-outline hazard. */
function showResults(playerPos = 12): void {
  const rows: ResultRow[] = [];
  for (let i = 0; i < 12; i++) {
    rows.push({
      kartId: i,
      position: i + 1,
      name: i + 1 === playerPos ? 'YOU' : RACER_NAMES[i % RACER_NAMES.length],
      time: 214.3 + i * 1.87,
      bestLap: 41.882 + i * 0.31,
      points: Math.max(0, 15 - i),
      isPlayer: i + 1 === playerPos,
      color: undefined,
    });
  }
  results.show(rows, { title: 'RESULTS' });
}

// ===========================================================================
// Scene posing — puts karts on screen so nameplates actually render
// ===========================================================================

/** Lay the pack out ahead of the camera, deliberately clustered so nameplates fight. */
function poseKarts(): void {
  for (let i = 0; i < KARTS.length; i++) {
    const k = KARTS[i];
    // Tight diamond cluster: several karts land within a few px of each other
    // on screen, which is exactly the nameplate de-collision case.
    const row = Math.floor(i / 3);
    const col = i % 3;
    k.position.set(-3.4 + col * 3.2 + (row % 2) * 1.1, 0.4, -14 - row * 7.5);
    k.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + i * 0.04);
    k.speed = 26 - i * 0.4;
    // Player deliberately mid-field so BOTH rival rows (ahead + behind) render —
    // otherwise the audit silently never measures one of them.
    k.progress = i === 0 ? 2.34 : 2.4 - i * 0.012;
    k.racePosition = i + 1;
    k.lap = 3;
    k.rpm = 0.8;
  }
  camera.position.set(0, 3.1, 6);
  camera.lookAt(0, 1.2, -18);
  camera.updateMatrixWorld(true);
}

/** Player state that shows the busiest possible HUD. */
function poseBusy(): void {
  const p = KARTS[0];
  p.speed = 38.4;
  p.boostTime = 1.2;
  p.drifting = true;
  p.driftStage = DriftStage.Orange;
  p.driftCharge = 0.62;
  p.heldItem = ItemType.TripleRedShell;
  p.itemCount = 3;
  p.lapTimes = [41.882, 40.117];
}

// ===========================================================================
// Measurement
// ===========================================================================

interface Rect { l: number; t: number; r: number; b: number; w: number; h: number }

function rectOf(e: Element): Rect {
  const r = e.getBoundingClientRect();
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
}

function contentBox(e: Element): Rect {
  const r = e.getBoundingClientRect();
  const s = getComputedStyle(e);
  const num = (v: string) => parseFloat(v) || 0;
  const l = r.left + num(s.borderLeftWidth) + num(s.paddingLeft);
  const t = r.top + num(s.borderTopWidth) + num(s.paddingTop);
  const rr = r.right - num(s.borderRightWidth) - num(s.paddingRight);
  const b = r.bottom - num(s.borderBottomWidth) - num(s.paddingBottom);
  return { l, t, r: rr, b, w: rr - l, h: b - t };
}

function visible(e: Element): boolean {
  const s = getComputedStyle(e);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  if (parseFloat(s.opacity) < 0.02) return false;
  const r = e.getBoundingClientRect();
  if (r.width < 0.5 || r.height < 0.5) return false;
  // Anything inside a faded-out ancestor doesn't count either.
  let p: Element | null = e.parentElement;
  while (p && p !== document.body) {
    const ps = getComputedStyle(p);
    if (ps.display === 'none' || ps.visibility === 'hidden' || parseFloat(ps.opacity) < 0.02) return false;
    p = p.parentElement;
  }
  return true;
}

/** Elements whose own text must not overflow their own box. */
const TEXT_SEL = [
  '.ak-lap', '.ak-coins', '.ak-timer', '.ak-timer__row', '.ak-item__count',
  '.ak-pos__plate', '.ak-pos__cell', '.ak-pos__toast', '.ak-speed__readout',
  '.ak-rival', '.ak-rival__name', '.ak-drift', '.ak-plate3d',
  '.ak-warn__blue-text', '.ak-banner', '.ak-message', '.ak-countdown',
] as const;

/**
 * How far the painted ink of a text element escapes its own layout box.
 * `-webkit-text-stroke` is centred on the glyph outline and layered
 * `text-shadow` extends further still — neither is in `getBoundingClientRect`,
 * and both get sliced by `overflow: hidden`. Budgeting for them is the whole
 * point of the exercise, so measure them.
 */
function inkMargin(e: Element): { l: number; r: number; t: number; b: number } {
  const s = getComputedStyle(e);
  const stroke = (parseFloat(s.webkitTextStrokeWidth) || 0) * 0.5;
  let l = stroke, r = stroke, t = stroke, b = stroke;
  const ts = s.textShadow;
  if (ts && ts !== 'none') {
    // "rgba(..) 0px 3px 0px, rgba(..) 0px 6px 12px" — split on commas outside parens.
    const parts = ts.split(/,(?![^(]*\))/);
    for (const part of parts) {
      const nums = part.match(/-?[\d.]+px/g);
      if (!nums || nums.length < 2) continue;
      const ox = parseFloat(nums[0]);
      const oy = parseFloat(nums[1]);
      const blur = nums.length > 2 ? parseFloat(nums[2]) : 0;
      l = Math.max(l, blur - ox);
      r = Math.max(r, blur + ox);
      t = Math.max(t, blur - oy);
      b = Math.max(b, blur + oy);
    }
  }
  return { l, r, t, b };
}

/**
 * The position reel keeps two cells: one showing, one parked off the plate.
 * Only the showing cell is a real measurement subject — and identifying it
 * geometrically (rather than by reading HUD internals) also makes the audit
 * immune to whatever point of the roll animation we happened to catch.
 */
function parkedCells(): Set<Element> {
  const cells = Array.from(stage.querySelectorAll('.ak-pos__cell'));
  const plate = stage.querySelector('.ak-pos__plate');
  const out = new Set<Element>(cells);
  if (!plate || cells.length === 0) return new Set();
  const pc = plate.getBoundingClientRect();
  const mid = pc.top + pc.height * 0.5;
  let best = cells[0];
  let bestD = Infinity;
  for (const c of cells) {
    const r = c.getBoundingClientRect();
    const d = Math.abs(r.top + r.height * 0.5 - mid);
    if (d < bestD) { bestD = d; best = c; }
  }
  out.delete(best);
  return out;
}

function inParkedCell(e: Element, parked: Set<Element>): boolean {
  for (const p of parked) if (p === e || p.contains(e)) return true;
  return false;
}

/** Nearest ancestor (within the stage) that clips its overflow. */
function clipper(e: Element): Element | null {
  let p = e.parentElement;
  while (p && p !== stage) {
    const o = getComputedStyle(p).overflow;
    if (o !== 'visible') return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * The rectangle `overflow: hidden` actually clips to: the PADDING box, not the
 * content box. Padding is therefore usable ink budget, which is the whole point
 * of "budget padding for the outline".
 */
function paddingBox(e: Element): Rect {
  const r = e.getBoundingClientRect();
  const s = getComputedStyle(e);
  const num = (v: string) => parseFloat(v) || 0;
  const l = r.left + num(s.borderLeftWidth);
  const t = r.top + num(s.borderTopWidth);
  const rr = r.right - num(s.borderRightWidth);
  const b = r.bottom - num(s.borderBottomWidth);
  return { l, t, r: rr, b, w: rr - l, h: b - t };
}

export interface ClipRow {
  el: string;
  clip: string;
  /** How far the ink is sliced off, per side, CSS px. Zero means intact. */
  cut: { l: number; r: number; t: number; b: number };
}

/**
 * The real bug detector: every text layer that is PARTIALLY clipped by an
 * ancestor. A layer entirely outside its clipper is intentionally masked (the
 * parked cell of the position reel), so it is excluded — partial clipping is
 * what the eye reads as "the plate is cutting into its own text".
 */
function clipCuts(): ClipRow[] {
  const rows: ClipRow[] = [];
  const parked = parkedCells();
  const layers = stage.querySelectorAll(
    '.ak-num__fill, .ak-num__stroke, .ak-timer__v, .ak-timer__k, .ak-rival__name, .ak-rival__gap, '
    + '.ak-lap__label, .ak-lap__tot, .ak-item__count, .ak-speed__unit, .ak-plate3d__name, '
    + '.ak-plate3d__pos, .ak-map__label, .ak-drift__label, .ak-warn__blue-text, .ak-warn__blue-sub, '
    + '.ak-rrow__name, .ak-rrow__time, .ak-rrow__best, .ak-rrow__pts, .ak-podium__name');
  for (const e of Array.from(layers)) {
    if (!visible(e) || inParkedCell(e, parked)) continue;
    const cl = clipper(e);
    if (!cl) continue;
    const box = paddingBox(cl);
    const r = e.getBoundingClientRect();
    const m = inkMargin(e);
    const il = r.left - m.l, ir = r.right + m.r, it = r.top - m.t, ib = r.bottom + m.b;
    // Fully outside the clip box => intentionally masked, not a defect.
    if (ir <= box.l || il >= box.r || ib <= box.t || it >= box.b) continue;
    const cut = {
      l: +Math.max(0, box.l - il).toFixed(2),
      r: +Math.max(0, ir - box.r).toFixed(2),
      t: +Math.max(0, box.t - it).toFixed(2),
      b: +Math.max(0, ib - box.b).toFixed(2),
    };
    if (cut.l + cut.r + cut.t + cut.b <= 0.5) continue;
    rows.push({
      el: (e.className || '').split(' ').filter((c) => c.startsWith('ak-')).pop() ?? e.tagName,
      clip: (cl.className || '').split(' ').filter((c) => c.startsWith('ak-')).pop() ?? cl.tagName,
      cut,
    });
  }
  return rows;
}

/** Persistent corner widgets — these must never overlap each other. */
const BLOCK_SEL = [
  '.ak-lap', '.ak-coins', '.ak-drift', '.ak-item', '.ak-timer',
  '.ak-map', '.ak-rival', '.ak-pos__plate', '.ak-speed',
] as const;

export interface OverflowRow {
  sel: string;
  /** scrollWidth - clientWidth (integer, right/bottom only). */
  sx: number;
  sy: number;
  /** Precise child-ink overflow past the content box, per side, CSS px. */
  ink: { l: number; r: number; t: number; b: number };
  ok: boolean;
}

/**
 * Precise overflow: how far any child's painted box escapes the element's
 * content box. `scrollWidth` under-reports centred overflow (it only counts the
 * right/bottom side), which is exactly the position-plate case, so this is the
 * measurement that matters.
 */
function inkOverflow(e: Element): { l: number; r: number; t: number; b: number } {
  const box = contentBox(e);
  const parked = parkedCells();
  let l = 0, r = 0, t = 0, b = 0;
  const walk = (node: Element): void => {
    for (const c of Array.from(node.children)) {
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.02) continue;
      if (parked.has(c)) continue;
      // Decorative full-bleed layers are meant to fill the box; skip them.
      if (/__flash|__glow|__ring|__frame|__bg|__vignette/.test(c.className || '')) continue;
      const cr = c.getBoundingClientRect();
      const outside = cr.right <= box.l || cr.left >= box.r
        || cr.bottom <= box.t || cr.top >= box.b;
      if (cr.width > 0.5 && cr.height > 0.5 && !outside) {
        l = Math.max(l, box.l - cr.left);
        r = Math.max(r, cr.right - box.r);
        t = Math.max(t, box.t - cr.top);
        b = Math.max(b, cr.bottom - box.b);
      }
      walk(c);
    }
  };
  walk(e);
  return { l: +l.toFixed(2), r: +r.toFixed(2), t: +t.toFixed(2), b: +b.toFixed(2) };
}

export interface Audit {
  size: string;
  pos: number;
  scale: number;
  u: number;
  /** Position plate outer width as a fraction of viewport width. */
  platePct: number;
  plateW: number;
  overflow: OverflowRow[];
  clips: ClipRow[];
  outside: Array<{ sel: string; by: string }>;
  overlaps: Array<{ a: string; b: string; area: number }>;
  worstInk: number;
  worstCut: number;
  pass: boolean;
}

/** `--u` is an unresolved token in getComputedStyle, so measure it instead. */
function measureU(): number {
  const hudRoot = stage.querySelector('.ak-hud') as HTMLElement;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;height:1px;width:calc(1000 * var(--u));';
  hudRoot.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 1000;
  probe.remove();
  return w;
}

/**
 * Jump every finite animation to its end and park the looping ones, so a
 * measurement is of the RESTING layout. `punch()` runs on wall-clock via WAAPI,
 * so without this the numbers depend on how fast the harness happened to run.
 */
function freezeAnims(): void {
  for (const a of document.getAnimations()) {
    try {
      const t = a.effect?.getComputedTiming();
      if (t && t.iterations === Infinity) { a.currentTime = 0; a.pause(); } else { a.finish(); }
    } catch { /* already finished, or not finishable — either is fine */ }
  }
}

function audit(): Audit {
  freezeAnims();
  const vp = rectOf(stage);
  const u = measureU();
  const scale = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--ak-scale'),
  ) || 1;

  // --- overflow ---------------------------------------------------------
  const parked = parkedCells();
  const overflow: OverflowRow[] = [];
  let worstInk = 0;
  for (const sel of TEXT_SEL) {
    for (const e of Array.from(stage.querySelectorAll(sel))) {
      if (!visible(e) || inParkedCell(e, parked)) continue;
      const sx = e.scrollWidth - e.clientWidth;
      const sy = e.scrollHeight - e.clientHeight;
      const ink = inkOverflow(e);
      const worst = Math.max(ink.l, ink.r, ink.t, ink.b);
      worstInk = Math.max(worstInk, worst);
      const ok = sx <= 0 && sy <= 0 && worst <= 0.5;
      overflow.push({ sel, sx, sy, ink, ok });
      break;                              // first visible instance is enough
    }
  }

  const clips = clipCuts();
  const worstCut = clips.reduce(
    (m, c) => Math.max(m, c.cut.l, c.cut.r, c.cut.t, c.cut.b), 0,
  );

  // --- viewport containment --------------------------------------------
  const outside: Array<{ sel: string; by: string }> = [];
  for (const sel of [...TEXT_SEL, ...BLOCK_SEL]) {
    for (const e of Array.from(stage.querySelectorAll(sel))) {
      if (!visible(e) || inParkedCell(e, parked)) continue;
      // A layer parked entirely outside its clipper is masked by design.
      const cl = clipper(e);
      if (cl) {
        const cb = paddingBox(cl);
        const er = e.getBoundingClientRect();
        if (er.right <= cb.l || er.left >= cb.r || er.bottom <= cb.t || er.top >= cb.b) continue;
      }
      const r = rectOf(e);
      const dl = vp.l - r.l, dt = vp.t - r.t, dr = r.r - vp.r, db = r.b - vp.b;
      const worst = Math.max(dl, dt, dr, db);
      if (worst > 0.5) {
        outside.push({
          sel,
          by: `l${dl > 0.5 ? dl.toFixed(1) : 0} t${dt > 0.5 ? dt.toFixed(1) : 0} ` +
              `r${dr > 0.5 ? dr.toFixed(1) : 0} b${db > 0.5 ? db.toFixed(1) : 0}`,
        });
      }
      break;
    }
  }

  // --- pairwise overlap of persistent widgets ---------------------------
  const blocks: Array<{ sel: string; r: Rect }> = [];
  for (const sel of BLOCK_SEL) {
    for (const e of Array.from(stage.querySelectorAll(sel))) {
      if (!visible(e) || inParkedCell(e, parked)) continue;
      blocks.push({ sel: `${sel}${blocks.filter((x) => x.sel.startsWith(sel)).length || ''}`, r: rectOf(e) });
    }
  }
  const overlaps: Array<{ a: string; b: string; area: number }> = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i].r, b = blocks[j].r;
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (ox > 1 && oy > 1) {
        overlaps.push({ a: blocks[i].sel, b: blocks[j].sel, area: Math.round(ox * oy) });
      }
    }
  }

  const plate = stage.querySelector('.ak-pos__plate') as HTMLElement | null;
  const plateW = plate ? plate.getBoundingClientRect().width : 0;
  const platePct = vp.w > 0 ? plateW / vp.w : 0;

  const pass = overflow.every((o) => o.ok) && outside.length === 0
    && overlaps.length === 0 && platePct < 0.12 && worstCut <= 0.5;

  return {
    size: `${Math.round(vp.w)}x${Math.round(vp.h)}`,
    pos: KARTS[0].racePosition,
    scale: +scale.toFixed(4),
    u: +u.toFixed(4),
    platePct: +(platePct * 100).toFixed(2),
    plateW: +plateW.toFixed(1),
    overflow, clips, outside, overlaps,
    worstInk: +worstInk.toFixed(2),
    worstCut: +worstCut.toFixed(2),
    pass,
  };
}

// ===========================================================================
// Driving
// ===========================================================================

const SIZES: Array<[number, number]> = [[800, 450], [960, 540], [1280, 720], [1920, 1080]];

function setSize(w: number, h: number): void {
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  hud.resize(w, h);
  frame(0.0166);
}

let frameNo = 0;
function frame(dt = 0.0166): void {
  const ctx: FrameContext = {
    dt, fixedDt: 1 / 120, elapsed: race.raceTime, frame: frameNo++, alpha: 1,
  };
  hud.update(ctx);
}

/** Settle transitions/animations so measurements are of the resting layout. */
function settle(n = 4): void {
  for (let i = 0; i < n; i++) frame(0.2);
}

function setPos(n: number): void {
  KARTS[0].racePosition = n;
  // Keep the rest of the field consistent so rivals/plates make sense.
  let next = 1;
  for (const k of KARTS) {
    if (k.isPlayer) continue;
    if (next === n) next++;
    k.racePosition = next++;
  }
  race.getPosition = (id: number): number => KARTS[id]?.racePosition ?? 1;
  frame(0.0166);
  settle(2);
}

function sweep(positions: number[] = [1, 2, 3, 9, 10, 11, 12]): Audit[] {
  const rows: Audit[] = [];
  for (const [w, h] of SIZES) {
    setSize(w, h);
    settle();
    for (const p of positions) {
      setPos(p);
      settle(2);
      rows.push(audit());
    }
  }
  return rows;
}

function table(rows?: Audit[]): string {
  const data = rows ?? sweep();
  const head = 'size       pos  --u     plateW  plate%  clipped-ink                       scrollOver        outside  overlap  pass';
  const lines = [head, '-'.repeat(head.length)];
  for (const r of data) {
    const scrollOver = r.overflow.filter((o) => o.sx > 0 || o.sy > 0)
      .map((o) => `${o.sel.replace('.ak-', '')}(${o.sx},${o.sy})`).join(' ') || '-';
    const cut = r.clips.map((c) => `${c.el.replace('ak-', '')}<${c.clip.replace('ak-', '')} ` +
      `${c.cut.l}/${c.cut.r}/${c.cut.t}/${c.cut.b}`).join('  ') || '-';
    lines.push(
      `${r.size.padEnd(10)} ${String(r.pos).padEnd(4)} ${String(r.u).padEnd(7)} ` +
      `${String(r.plateW).padEnd(7)} ${String(r.platePct).padEnd(7)} ` +
      `${cut.padEnd(33)} ${scrollOver.padEnd(17)} ` +
      `${String(r.outside.length).padEnd(8)} ${String(r.overlaps.length).padEnd(8)} ${r.pass ? 'PASS' : 'FAIL'}`,
    );
  }
  return lines.join('\n');
}

/** Compact summary: one line per viewport, worst case across all 12 positions. */
function summary(): string {
  const rows = sweep([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const bySize = new Map<string, Audit[]>();
  for (const r of rows) {
    const list = bySize.get(r.size) ?? [];
    list.push(r);
    bySize.set(r.size, list);
  }
  const head = 'viewport    --u    plate px  plate %  worst clipped ink        scrollW>clientW     outside vp   overlaps   verdict';
  const lines = [head, '-'.repeat(head.length)];
  for (const [size, list] of bySize) {
    const worst = list.reduce((a, b) => (b.worstCut > a.worstCut ? b : a));
    const scrollBad = new Set<string>();
    const outside = new Set<string>();
    const overlaps = new Set<string>();
    for (const r of list) {
      for (const o of r.overflow) if (o.sx > 0 || o.sy > 0) scrollBad.add(`${o.sel}(${o.sx},${o.sy})`);
      for (const o of r.outside) outside.add(o.sel);
      for (const o of r.overlaps) overlaps.add(`${o.a}/${o.b}`);
    }
    const wc = worst.clips.reduce(
      (m, c) => (Math.max(c.cut.l, c.cut.r, c.cut.t, c.cut.b) > Math.max(m.cut.l, m.cut.r, m.cut.t, m.cut.b) ? c : m),
      worst.clips[0] ?? { el: '-', clip: '-', cut: { l: 0, r: 0, t: 0, b: 0 } },
    );
    const allPass = list.every((r) => r.pass);
    lines.push(
      `${size.padEnd(11)} ${String(worst.u).padEnd(6)} ${String(worst.plateW).padEnd(9)} ` +
      `${String(worst.platePct).padEnd(8)} ` +
      `${(worst.worstCut > 0.5 ? `${worst.worstCut}px ${wc.el.replace('ak-', '')}@${worst.pos}` : 'none').padEnd(24)} ` +
      `${(scrollBad.size ? [...scrollBad].join(',') : 'none').padEnd(19)} ` +
      `${(outside.size ? [...outside].join(',') : 'none').padEnd(12)} ` +
      `${(overlaps.size ? [...overlaps].join(',') : 'none').padEnd(10)} ${allPass ? 'PASS' : 'FAIL'}`,
    );
  }
  return lines.join('\n');
}

/** Detail dump for one configuration — every measured element. */
function detail(): string {
  const a = audit();
  const lines = [
    `size ${a.size}  pos ${a.pos}  scale ${a.scale}  --u ${a.u}px  plate ${a.plateW}px (${a.platePct}%)`,
    'element                    scrollW-clientW  scrollH-clientH   ink L/R/T/B',
  ];
  for (const o of a.overflow) {
    lines.push(
      `${o.sel.padEnd(26)} ${String(o.sx).padStart(9)} ${String(o.sy).padStart(16)}   ` +
      `${o.ink.l}/${o.ink.r}/${o.ink.t}/${o.ink.b}${o.ok ? '' : '   <-- OVERFLOW'}`,
    );
  }
  if (a.clips.length) {
    lines.push('CLIPPED INK (ancestor overflow slices the glyph/outline):');
    for (const c of a.clips) {
      lines.push(`  ${c.el} inside ${c.clip}  cut L${c.cut.l} R${c.cut.r} T${c.cut.t} B${c.cut.b}`);
    }
  }
  if (a.outside.length) {
    lines.push('outside viewport:');
    for (const o of a.outside) lines.push(`  ${o.sel}  ${o.by}`);
  }
  if (a.overlaps.length) {
    lines.push('overlaps:');
    for (const o of a.overlaps) lines.push(`  ${o.a} x ${o.b}  ${o.area}px2`);
  }
  return lines.join('\n');
}

function bench(n = 400): { avgMs: number; p95Ms: number; reported: number } {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    KARTS[0].speed = 20 + 12 * Math.sin(i * 0.11);
    KARTS[0].driftCharge = (i % 60) / 60;
    for (const k of KARTS) k.position.x += 0.02;
    const t0 = performance.now();
    frame(0.0166);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    avgMs: +avg.toFixed(4),
    p95Ms: +samples[Math.floor(samples.length * 0.95)].toFixed(4),
    reported: +hud.costMs.toFixed(4),
  };
}

/**
 * With no JS-written scale at all, does `--u` still resolve sensibly? This is the
 * regression guard for the original defect: the stylesheet's fallback used to be
 * `1`, i.e. full 1080p sizing whatever the viewport.
 *
 * The CSS fallback is viewport-derived, so it is compared against the real
 * window (the stage can't drive `vh`/`vw`).
 */
function noJsScale(): { u: number; expectedForWindow: number; plateW: number; platePctOfWindow: number } {
  const root = document.documentElement.style;
  const prevU = root.getPropertyValue('--ak-u');
  const prevS = root.getPropertyValue('--ak-scale');
  root.removeProperty('--ak-u');
  root.removeProperty('--ak-scale');
  const u = measureU();
  const plate = stage.querySelector('.ak-pos__plate') as HTMLElement | null;
  const plateW = plate ? plate.getBoundingClientRect().width : 0;
  if (prevU) root.setProperty('--ak-u', prevU);
  if (prevS) root.setProperty('--ak-scale', prevS);
  return {
    u: +u.toFixed(4),
    expectedForWindow: +uiScale(window.innerWidth, window.innerHeight).toFixed(4),
    plateW: +plateW.toFixed(1),
    platePctOfWindow: +(plateW / window.innerWidth * 100).toFixed(2),
  };
}

// ===========================================================================
// Boot
// ===========================================================================

interface UiQa {
  hud: HUD;
  karts: KartState[];
  setSize(w: number, h: number): void;
  setPos(n: number): void;
  setState(s: string): void;
  setPath(space: 'unit' | 'world' | 'none'): void;
  reset(): void;
  results(playerPos?: number): void;
  hideResults(): void;
  frame(dt?: number): void;
  settle(n?: number): void;
  countdown(n: number): void;
  finalLap(): void;
  blue(): void;
  audit(): Audit;
  sweep(positions?: number[]): Audit[];
  table(rows?: Audit[]): string;
  summary(): string;
  detail(): string;
  bench(n?: number): { avgMs: number; p95Ms: number; reported: number };
  noJsScale(): { u: number; expectedForWindow: number; plateW: number; platePctOfWindow: number };
  mapPixels(): { canvasPx: number; dotPixels: number; placeable: boolean };
  plateSpread(): { shown: number; minGapY: number; collisions: number };
}

/**
 * Nameplate de-collision check: the smallest vertical gap between any two
 * visible nameplates whose columns overlap. Anything below the plate height is a
 * collision — two labels sitting on top of each other.
 */
function plateSpread(): { shown: number; minGapY: number; collisions: number } {
  const els = Array.from(stage.querySelectorAll('.ak-plate3d'))
    .filter((e) => getComputedStyle(e).visibility !== 'hidden')
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 1);
  let minGap = Infinity;
  let collisions = 0;
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (ox <= 1) continue;                      // columns don't overlap
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (oy > 1) collisions++;
      const gap = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);
      minGap = Math.min(minGap, gap);
    }
  }
  return {
    shown: els.length,
    minGapY: Number.isFinite(minGap) ? +minGap.toFixed(2) : -1,
    collisions,
  };
}

/**
 * How many minimap pixels the racer dots actually paint, measured differentially:
 * snapshot the canvas, teleport every kart a thousand kilometres away, snapshot
 * again, count changed pixels. Colour heuristics can't do this honestly — the
 * ribbon's own blue-grey gradient is saturated enough to be mistaken for a dot.
 *
 * Zero here is the "minimap shows no racer dots at all" defect.
 */
function mapPixels(): { canvasPx: number; dotPixels: number; placeable: boolean } {
  const cv = stage.querySelector('.ak-map__canvas') as HTMLCanvasElement | null;
  const c = cv?.getContext('2d');
  if (!cv || !c) return { canvasPx: 0, dotPixels: 0, placeable: false };
  const snap = (): Uint8ClampedArray => c.getImageData(0, 0, cv.width, cv.height).data.slice();

  const keep = KARTS.map((k) => ({ x: k.position.x, z: k.position.z }));
  settle(4);
  const withKarts = snap();
  for (const k of KARTS) { k.position.x += 1e6; k.position.z += 1e6; }
  settle(4);
  const without = snap();
  KARTS.forEach((k, i) => { k.position.x = keep[i].x; k.position.z = keep[i].z; });
  settle(4);

  let n = 0;
  for (let i = 0; i < withKarts.length; i += 4) {
    const d = Math.abs(withKarts[i] - without[i]) + Math.abs(withKarts[i + 1] - without[i + 1])
      + Math.abs(withKarts[i + 2] - without[i + 2]) + Math.abs(withKarts[i + 3] - without[i + 3]);
    if (d > 24) n++;
  }
  return { canvasPx: cv.width * cv.height, dotPixels: n, placeable: hud.minimapCanPlaceDots };
}

function button(label: string, fn: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = fn;
  bar.appendChild(b);
}

async function boot(): Promise<void> {
  await hud.init();
  hud.setVisible(true);
  poseKarts();
  poseBusy();
  setSize(800, 450);
  settle();

  for (const [w, h] of SIZES) button(`${w}x${h}`, () => { setSize(w, h); settle(); out.textContent = detail(); });
  for (const p of [1, 2, 3, 11, 12]) button(`pos ${p}`, () => { setPos(p); out.textContent = detail(); });
  button('countdown', () => { hud.showCountdown(3); out.textContent = detail(); });
  button('final lap', () => { hud.showBanner('FINAL LAP!', 'gold'); out.textContent = detail(); });
  button('blue shell', () => { hud.warn('blue', Math.PI, 6); settle(1); out.textContent = detail(); });
  button('audit', () => { out.textContent = detail(); });
  button('SUMMARY', () => { out.textContent = summary(); });
  button('TABLE', () => { out.textContent = table(); });
  button('bench', () => { out.textContent = JSON.stringify(bench(), null, 2); });
  button('map dots', () => { out.textContent = JSON.stringify(mapPixels(), null, 2); });
  button('nameplates', () => { out.textContent = JSON.stringify(plateSpread(), null, 2); });

  const api: UiQa = {
    hud, karts: KARTS,
    setSize, setPos,
    setState: (s: string) => { race.state = s; frame(); },
    setPath: (space) => { pathSpace = space; hud.refreshTrackPath(); frame(); },
    reset: () => { poseKarts(); poseBusy(); settle(4); },
    results: (playerPos = 12) => showResults(playerPos),
    hideResults: () => results.hide(),
    frame, settle,
    countdown: (n: number) => hud.showCountdown(n),
    finalLap: () => hud.showBanner('FINAL LAP!', 'gold'),
    blue: () => hud.warn('blue', Math.PI, 6),
    audit, sweep, table, summary, detail, bench, noJsScale, mapPixels, plateSpread,
  };
  (window as unknown as { __UIQA__: UiQa }).__UIQA__ = api;

  out.textContent = detail();

  // Keep the HUD alive so animations/canvases look right when eyeballed.
  let last = performance.now();
  const loop = (): void => {
    const now = performance.now();
    frame(Math.min(0.05, (now - last) / 1000));
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void boot();
