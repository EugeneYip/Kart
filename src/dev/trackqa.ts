/**
 * TEMPORARY diagnostic helpers for the track agent. Imported from the browser
 * console of the real game (`await import('/src/dev/trackqa.ts')`), never from
 * the shipping bundle. Delete this file when the track defects are closed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { roadSurfacePoint } from '@/track/TrackBuilder';
type Any = any;

const G = () => (window as Any).__GAME__ as Any;
const QA = () => (window as Any).__QA__ as Any;

export async function waitReady(ms = 90000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (QA() && G() && G().track && G().track.ready) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function boot(): Promise<string> {
  if (!(await waitReady())) return 'not ready';
  const g = G();
  if (!g.karts.player) {
    g.startRace({});
    g.race.skipIntro();
    await new Promise((r) => setTimeout(r, 1200));
  }
  return 'ready';
}

/** Grab the composited frame as an ImageData-backed 2d canvas. */
function grab(): Promise<HTMLCanvasElement> {
  const e = G().engine;
  return new Promise((res, rej) => {
    const orig = e.renderCallback;
    e.renderCallback = function (this: Any, ...a: Any[]) {
      const r = orig.apply(this, a);
      try {
        const cv = e.canvas as HTMLCanvasElement;
        const oc = document.createElement('canvas');
        oc.width = cv.width;
        oc.height = cv.height;
        oc.getContext('2d')!.drawImage(cv, 0, 0);
        e.renderCallback = orig;
        res(oc);
      } catch (err) {
        e.renderCallback = orig;
        rej(err);
      }
      return r;
    };
  });
}

export interface Patch { n: string; avg: number[]; sat: number; hue: number; rb: number; cont: number }

/** rects: [fx, fy, fw, fh, name] in 0..1 frame space. */
export async function pix(rects: Array<[number, number, number, number, string]>): Promise<Patch[]> {
  const oc = await grab();
  const c2 = oc.getContext('2d')!;
  return rects.map((q) => {
    const x = Math.round(q[0] * oc.width);
    const y = Math.round(q[1] * oc.height);
    const w = Math.max(2, Math.round(q[2] * oc.width));
    const h = Math.max(2, Math.round(q[3] * oc.height));
    const d = c2.getImageData(x, y, w, h).data;
    const s = [0, 0, 0];
    const lum: number[] = [];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2];
      lum.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      n++;
    }
    const avg = s.map((v) => Math.round(v / n));
    lum.sort((a, b) => a - b);
    const mx = Math.max(...avg), mn = Math.min(...avg), dd = mx - mn;
    const [R, Gc, B] = avg;
    let hue = 0;
    if (dd > 0) {
      if (mx === R) hue = 60 * (((Gc - B) / dd) % 6);
      else if (mx === Gc) hue = 60 * ((B - R) / dd + 2);
      else hue = 60 * ((R - Gc) / dd + 4);
    }
    if (hue < 0) hue += 360;
    return {
      n: q[4], avg, sat: mx > 0 ? Math.round((100 * dd) / mx) : 0, hue: Math.round(hue),
      rb: +(R / Math.max(1, B)).toFixed(2),
      cont: Math.round(lum[Math.floor(lum.length * 0.9)] - lum[Math.floor(lum.length * 0.1)]),
    };
  });
}

const _sp = new THREE.Vector3();
const _sn = new THREE.Vector3();
const _rc = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

/**
 * Lateral scan of the road `ahead` metres in front of the player. Sample points
 * come from `roadSurfacePoint`, i.e. exactly the surface the mesh was built
 * from (crown + banking + kerb profile), and each one is verified with a
 * raycast so we know which material the pixel actually belongs to.
 */
export async function scanRoad(ahead = 12, extra = 0, spread = 0.9): Promise<Any> {
  const g = G();
  const T = g.track;
  const p = g.karts.player;
  const d0 = T.projectDistance(p.position) + extra;
  const s = T.sampleAtDistance(d0 + ahead);
  const hw = s.halfWidth ?? 11;
  const cam = g.engine.camera;
  const rects: Array<[number, number, number, number, string]> = [];
  const ident: string[] = [];
  for (let i = -5; i <= 5; i++) {
    const lat = (i / 5) * hw * spread;
    roadSurfacePoint(T.spline, d0 + ahead, lat, _sp, _sn);
    _sp.addScaledVector(_sn, 0.02);
    const world = _sp.clone();
    _sp.project(cam);
    const fx = _sp.x * 0.5 + 0.5;
    const fy = 1 - (_sp.y * 0.5 + 0.5);
    _ndc.set(_sp.x, _sp.y);
    _rc.setFromCamera(_ndc, cam);
    const hits = _rc.intersectObjects(T.roadGroup.children, true).filter((h: Any) => h.object.visible);
    const h0 = hits[0];
    const want = cam.position.distanceTo(world);
    ident.push(
      `${lat.toFixed(1)} ${h0 ? ((h0.object as Any).material?.name || h0.object.name || '?') : 'none'}` +
      ` d${h0 ? h0.distance.toFixed(1) : '-'}/${want.toFixed(1)}`,
    );
    rects.push([
      Math.max(0, Math.min(0.975, fx - 0.008)),
      Math.max(0, Math.min(0.988, fy - 0.005)),
      0.016, 0.01, `lat${lat.toFixed(1)}`,
    ]);
  }
  const px = await pix(rects);
  return {
    d0: Math.round(d0), hw,
    rows: px.map((q, i) => `${ident[i]} | ${q.avg.join('/')} s${q.sat} h${q.hue} rb${q.rb} c${q.cont}`),
  };
}

/** Blow up a region of the live frame over the whole window so the pane can screenshot it. */
export async function zoom(fx: number, fy: number, fw: number, label = ''): Promise<string> {
  const oc = await grab();
  const sw = Math.round(fw * oc.width);
  const sh = Math.round((sw * window.innerHeight) / window.innerWidth);
  const sx = Math.round(fx * oc.width - sw / 2);
  const sy = Math.round(fy * oc.height - sh / 2);
  let ov = document.getElementById('apxZoom') as HTMLCanvasElement | null;
  if (!ov) {
    ov = document.createElement('canvas');
    ov.id = 'apxZoom';
    ov.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:99999;background:#000';
    document.body.appendChild(ov);
  }
  ov.width = window.innerWidth * 2;
  ov.height = window.innerHeight * 2;
  const c2 = ov.getContext('2d')!;
  c2.imageSmoothingEnabled = true;
  c2.fillStyle = '#000';
  c2.fillRect(0, 0, ov.width, ov.height);
  c2.drawImage(oc, sx, sy, sw, sh, 0, 0, ov.width, ov.height);
  if (label) {
    c2.font = 'bold 28px ui-monospace, monospace';
    c2.fillStyle = '#0f0';
    c2.fillText(label, 16, 40);
  }
  return `zoom ${sw}x${sh} -> ${ov.width}x${ov.height}`;
}

export function unzoom(): string {
  document.getElementById('apxZoom')?.remove();
  return 'ok';
}

/** Camera looking at a lap distance from `back` metres before it. */
export async function lookAtDist(d: number, back = 17, up = 3.2, fov = 38, lat = 0): Promise<string> {
  const T = G().track;
  const h = QA().harness;
  const c = T.sampleAtDistance(d);
  const e = T.sampleAtDistance(d - back);
  h.takeCameraControl();
  h.lookAt(
    { x: e.position.x + e.binormal.x * lat, y: e.position.y + up, z: e.position.z + e.binormal.z * lat },
    { x: c.position.x, y: c.position.y, z: c.position.z },
    fov,
  );
  await h.settle(0.35);
  return `cam@${d - back} -> ${d}`;
}

/** Road material / geometry fingerprint. */
export function roadInfo(): Any {
  const g = G();
  let mesh: Any = null;
  g.engine.scene.traverse((o: Any) => { if (o.isMesh && o.material && o.material.name === 'apx-road') mesh = o; });
  if (!mesh) return 'no road mesh';
  const m = mesh.material;
  const st = (t: Any) => {
    if (!t || !t.image || !t.image.data) return null;
    const d = t.image.data as Uint8Array;
    const s = [0, 0, 0]; const mn = [255, 255, 255]; const mx = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        s[k] += d[i + k];
        if (d[i + k] < mn[k]) mn[k] = d[i + k];
        if (d[i + k] > mx[k]) mx[k] = d[i + k];
      }
      n++;
    }
    return { avg: s.map((v) => Math.round(v / n)), min: mn, max: mx };
  };
  return {
    color: '#' + m.color.getHexString(),
    colorLin: [+m.color.r.toFixed(3), +m.color.g.toFixed(3), +m.color.b.toFixed(3)],
    map: st(m.map),
    orm: st(m.roughnessMap),
    metalness: m.metalness,
    roughness: m.roughness,
    env: m.envMapIntensity,
    repeat: [m.map.repeat.x, m.map.repeat.y],
  };
}

/** Read the uv/apxUv2 of the road vertices nearest a world point. */
export function uvAt(x: number, y: number, z: number, k = 4): Any {
  const g = G();
  let mesh: Any = null;
  g.engine.scene.traverse((o: Any) => { if (o.isMesh && o.material && o.material.name === 'apx-road') mesh = o; });
  const pos = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  const uv2 = mesh.geometry.getAttribute('apxUv2');
  const col = mesh.geometry.getAttribute('color');
  const found: Any[] = [];
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - x, dy = pos.getY(i) - y, dz = pos.getZ(i) - z;
    found.push({ i, d2: dx * dx + dy * dy + dz * dz });
  }
  found.sort((a, b) => a.d2 - b.d2);
  return found.slice(0, k).map((f) => ({
    dist: +Math.sqrt(f.d2).toFixed(2),
    p: [+pos.getX(f.i).toFixed(2), +pos.getY(f.i).toFixed(2), +pos.getZ(f.i).toFixed(2)],
    uv: [+uv.getX(f.i).toFixed(3), +uv.getY(f.i).toFixed(3)],
    uv2: [+uv2.getX(f.i).toFixed(4), +uv2.getY(f.i).toFixed(4)],
    col: [+col.getX(f.i).toFixed(3), +col.getY(f.i).toFixed(3), +col.getZ(f.i).toFixed(3)],
  }));
}

/** Dump the decal quad geometry for the quads whose centre is near lap distance d. */
export function decalQuadsNear(d: number, radius = 12): Any {
  const g = G();
  const mesh = g.track.decals.mesh;
  const pos = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  const T = g.track;
  const out: Any[] = [];
  const tmp = g.karts.player.position.clone();
  for (let q = 0; q < pos.count / 4; q++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 4; k++) { cx += pos.getX(q * 4 + k); cy += pos.getY(q * 4 + k); cz += pos.getZ(q * 4 + k); }
    cx /= 4; cy /= 4; cz /= 4;
    tmp.set(cx, cy, cz);
    const dd = T.projectDistance(tmp);
    let delta = Math.abs(dd - d);
    if (delta > T.lapLength / 2) delta = T.lapLength - delta;
    if (delta > radius) continue;
    const verts = [];
    for (let k = 0; k < 4; k++) {
      const i = q * 4 + k;
      verts.push({
        p: [+pos.getX(i).toFixed(2), +pos.getY(i).toFixed(2), +pos.getZ(i).toFixed(2)],
        uv: [+uv.getX(i).toFixed(4), +uv.getY(i).toFixed(4)],
      });
    }
    out.push({ quad: q, d: Math.round(dd), centre: [+cx.toFixed(1), +cy.toFixed(1), +cz.toFixed(1)], verts });
  }
  return out;
}

/** Which atlas cell a uv pair lands in, and the pixel the canvas actually holds there. */
export function atlasProbe(u: number, v: number): Any {
  const g = G();
  const tex = (g.track.decals as Any).atlas as THREEAny;
  const img = tex.image as HTMLCanvasElement;
  const flip = tex.flipY;
  const px = Math.round(u * img.width);
  const py = Math.round((flip ? 1 - v : v) * img.height);
  const d = img.getContext('2d')!.getImageData(Math.max(0, Math.min(img.width - 1, px)), Math.max(0, Math.min(img.height - 1, py)), 1, 1).data;
  return { flipY: flip, size: [img.width, img.height], canvasPx: [px, py], cell: [Math.floor(u * 4), Math.floor((flip ? 1 - v : v) * 4)], rgba: [d[0], d[1], d[2], d[3]] };
}
type THREEAny = Any;

/** Render an atlas cell (or the whole atlas) full-screen so it can be screenshotted. */
export async function showAtlas(cell = -1): Promise<string> {
  const g = G();
  const tex = (g.track.decals as Any).atlas as Any;
  const img = tex.image as HTMLCanvasElement;
  let ov = document.getElementById('apxZoom') as HTMLCanvasElement | null;
  if (!ov) {
    ov = document.createElement('canvas');
    ov.id = 'apxZoom';
    ov.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:99999;background:#204060';
    document.body.appendChild(ov);
  }
  ov.width = window.innerWidth * 2;
  ov.height = window.innerHeight * 2;
  const c2 = ov.getContext('2d')!;
  c2.fillStyle = '#204060';
  c2.fillRect(0, 0, ov.width, ov.height);
  const cs = img.width / 4;
  if (cell < 0) {
    c2.drawImage(img, 0, 0, img.width, img.height, 0, 0, ov.height, ov.height);
  } else {
    c2.drawImage(img, (cell % 4) * cs, Math.floor(cell / 4) * cs, cs, cs, 0, 0, ov.height, ov.height);
  }
  return `atlas ${img.width} cell ${cell}`;
}

/** Show the stain texture (the road shader's track-space layer). */
export async function showStain(): Promise<string> {
  const g = G();
  const tex = (g.track.decals as Any).stainTexture as Any;
  const img = tex.image as HTMLCanvasElement;
  let ov = document.getElementById('apxZoom') as HTMLCanvasElement | null;
  if (!ov) {
    ov = document.createElement('canvas');
    ov.id = 'apxZoom';
    ov.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:99999;background:#204060';
    document.body.appendChild(ov);
  }
  ov.width = window.innerWidth * 2;
  ov.height = window.innerHeight * 2;
  const c2 = ov.getContext('2d')!;
  c2.fillStyle = '#808080';
  c2.fillRect(0, 0, ov.width, ov.height);
  // stretch the 512x4096 strip into a wide ribbon: 8 columns of L/8
  const cols = 8;
  const ch = Math.floor(img.height / cols);
  const cw = Math.floor(ov.width / cols);
  for (let i = 0; i < cols; i++) {
    c2.drawImage(img, 0, i * ch, img.width, ch, i * cw, 0, cw, ov.height);
  }
  return `stain ${img.width}x${img.height} flipY=${tex.flipY}`;
}

/** 10k raycastGround calls, warm cache, along the racing line. */
export function benchGround(n = 10000): Any {
  const g = G();
  const T = g.track;
  if (typeof T.benchmarkGround === 'function') {
    try { return { builtin: T.benchmarkGround(n) }; } catch { /* fall through */ }
  }
  return null;
}
