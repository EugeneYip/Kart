/**
 * TEMPORARY numeric diagnostics for the placement / track-geometry pass.
 * Runs headless in Node via vite's SSR loader — no canvas, no WebGL.
 * Delete this file when the placement defects are closed.
 */
import * as THREE from 'three';
import { TF, TrackSpline, makeAttribs, makeSample, resolveNodes } from '@/track/TrackSpline';
import { TRACKS, TRACK_ORDER } from '@/track/TrackDefs';
import type { TrackDef } from '@/track/TrackDefs';
import { CROSS, kerbSuppressed, surfaceHeight, roadSurfacePoint } from '@/track/TrackBuilder';

const _s = makeSample();
const _at = makeAttribs();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _nrm = new THREE.Vector3();

/** Verbatim copy of Track.raycastGround's analytic body (no BVH involved). */
function raycastGround(
  spline: TrackSpline,
  origin: THREE.Vector3,
  up: THREE.Vector3,
  maxDist: number,
): { hit: boolean; distance: number; y: number } {
  const d = spline.nearestDistance(origin, -1);
  const s = spline.sampleAtDistance(d, _s);
  spline.attribsAtDistance(s.distance, _at);
  _v0.copy(origin).sub(s.position);
  const lat = _v0.dot(s.binormal);
  const sh = lat < 0 ? _at.shoulderL : _at.shoulderR;
  const noKerb = kerbSuppressed(_at.flags, lat < 0 ? -1 : 1);
  if (_at.flags & TF.Gap) return { hit: false, distance: maxDist, y: NaN };
  const corridor = _at.halfWidth + (noKerb ? 0 : CROSS.kerbW) + sh;
  if (Math.abs(lat) > corridor + 0.4) return { hit: false, distance: maxDist, y: NaN };
  const h = surfaceHeight(lat, _at.halfWidth, sh, s.distance, noKerb);
  _v1.copy(s.position).addScaledVector(s.binormal, lat).addScaledVector(s.normal, h);
  const e = 0.06;
  const dl =
    (surfaceHeight(lat + e, _at.halfWidth, sh, s.distance, noKerb) -
      surfaceHeight(lat - e, _at.halfWidth, sh, s.distance, noKerb)) / (2 * e);
  _nrm.copy(s.normal).addScaledVector(s.binormal, -dl);
  _nrm.normalize();
  const denom = up.dot(_nrm);
  if (denom <= 1e-4) return { hit: false, distance: maxDist, y: NaN };
  _v2.copy(origin).sub(_v1);
  const t = _v2.dot(_nrm) / denom;
  if (t < -0.35 || t > maxDist) return { hit: false, distance: maxDist, y: NaN };
  return { hit: true, distance: t, y: _v1.y };
}

interface Range { a: number; b: number; kind: string; extra?: string }

function mergeRanges(rs: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && last.kind === r.kind && r.a - last.b < 1.51) { last.b = r.b; continue; }
    out.push({ ...r });
  }
  return out;
}

/** Walk the lap in 0.5 m steps at several lateral offsets. */
function continuity(spline: TrackSpline, label: string): void {
  const L = spline.length;
  const STEP = 0.5;
  const lats = [0, -0.5, 0.5, -0.85, 0.85];
  const up = new THREE.Vector3();
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const lf of lats) {
    const misses: Range[] = [];
    const jumps: Range[] = [];
    let prevY = NaN;
    let prevD = -1;
    for (let d = 0; d < L; d += STEP) {
      spline.sampleAtDistance(d, _s);
      spline.attribsAtDistance(_s.distance, _at);
      const lat = lf * _at.halfWidth;
      roadSurfacePoint(spline, d, lat, p, n);
      up.copy(n);
      p.addScaledVector(n, 0.6);
      const g = raycastGround(spline, p, up, 3);
      if (!g.hit) {
        misses.push({ a: d, b: d, kind: 'miss' });
        prevY = NaN;
      } else {
        if (!Number.isNaN(prevY) && d - prevD < STEP * 1.5) {
          const dy = Math.abs(g.y - prevY);
          // 0.5 m over 0.5 m of road = a 45 deg step: nothing authored is that steep
          if (dy > 0.5) jumps.push({ a: prevD, b: d, kind: 'jump', extra: `${dy.toFixed(2)} m` });
        }
        prevY = g.y;
      }
      prevD = d;
    }
    const m = mergeRanges(misses);
    const j = mergeRanges(jumps);
    console.log(
      `  ${label} lat=${(lf * 100).toFixed(0)}%hw: ${m.length} miss range(s), ${j.length} height jump(s)`,
    );
    for (const r of m) {
      console.log(`     NO GROUND  d=${r.a.toFixed(1)}..${r.b.toFixed(1)} m  (${(r.b - r.a + STEP).toFixed(1)} m long, t=${(r.a / L).toFixed(4)}..${(r.b / L).toFixed(4)})`);
    }
    for (const r of j) {
      console.log(`     HEIGHT JUMP d=${r.a.toFixed(1)}..${r.b.toFixed(1)} ${r.extra}`);
    }
  }
}

function nodeTable(def: TrackDef, spline: TrackSpline): void {
  const L = spline.length;
  console.log(`  nodes: ${def.nodes.length}, length ${L.toFixed(1)} m`);
  for (let i = 0; i < def.nodes.length; i++) {
    const nd = def.nodes[i];
    const d = spline.distanceOfNode(i);
    const f = nd.flags ?? 0;
    if (!f && !nd.tag) continue;
    const names: string[] = [];
    for (const [k, v] of Object.entries(TF)) if (v && (f & (v as number))) names.push(k);
    console.log(
      `    [${String(i).padStart(2)}] d=${d.toFixed(1).padStart(7)} t=${(d / L).toFixed(4)} ` +
      `y=${(nd.p[1] as number).toFixed(2).padStart(6)} hw=${nd.hw ?? '-'} ` +
      `${names.join('|') || '-'}  ${nd.tag ?? ''}`,
    );
  }
}

function boostAndJumpReport(def: TrackDef, spline: TrackSpline): void {
  const L = spline.length;
  console.log('  boost pads:');
  for (const p of def.boostPads) {
    const d = p.t * L;
    spline.sampleAtDistance(d, _s);
    spline.attribsAtDistance(_s.distance, _at);
    console.log(
      `    t=${p.t} d=${d.toFixed(1)} lat=${p.lat} w=${p.width} len=${p.length} ` +
      `hw=${_at.halfWidth.toFixed(1)} flags=${_at.flags} ` +
      `${_at.flags & TF.Gap ? 'ON A GAP!' : ''}${_at.flags & TF.Ramp ? 'on ramp' : ''}`,
    );
  }
  // Every gap: measure the launch state and the ballistic reach.
  const gaps: Array<{ a: number; b: number }> = [];
  let inGap = false;
  let a = 0;
  for (let d = 0; d < L; d += 0.25) {
    spline.attribsAtDistance(d, _at);
    const g = (_at.flags & TF.Gap) !== 0;
    if (g && !inGap) { a = d; inGap = true; }
    if (!g && inGap) { gaps.push({ a, b: d }); inGap = false; }
  }
  if (inGap) gaps.push({ a, b: L });
  for (const g of gaps) {
    const lipD = g.a - 0.5;
    const landD = g.b + 0.5;
    const lip = new THREE.Vector3();
    const land = new THREE.Vector3();
    roadSurfacePoint(spline, lipD, 0, lip);
    roadSurfacePoint(spline, landD, 0, land);
    spline.sampleAtDistance(lipD, _s);
    const tan = _s.tangent.clone();
    const pitch = Math.asin(THREE.MathUtils.clamp(tan.y, -1, 1));
    const straight = lip.distanceTo(land);
    const dy = land.y - lip.y;
    console.log(
      `  GAP d=${g.a.toFixed(1)}..${g.b.toFixed(1)} (${(g.b - g.a).toFixed(1)} m of flagged gap) ` +
      `chord ${straight.toFixed(1)} m, landing ${dy >= 0 ? '+' : ''}${dy.toFixed(2)} m ` +
      `vs lip, launch pitch ${(pitch * 180 / Math.PI).toFixed(1)} deg`,
    );
    for (const v of [28, 34, 40]) {
      const vy = v * Math.sin(pitch);
      const vh = v * Math.cos(pitch);
      // horizontal reach at the moment it falls back to the landing height
      const gg = 9.81 * 2.35; // Config.PHYSICS gravity multiplier, see report
      const disc = vy * vy + 2 * gg * -dy;
      if (disc < 0) { console.log(`    v=${v} m/s: NEVER reaches landing height (+${dy.toFixed(2)} m)`); continue; }
      const t = (vy + Math.sqrt(disc)) / gg;
      console.log(`    v=${v} m/s: airborne ${t.toFixed(2)} s, reach ${(vh * t).toFixed(1)} m (needs ${straight.toFixed(1)} m)`);
    }
  }
}

function itemBoxReport(def: TrackDef, spline: TrackSpline): void {
  const L = spline.length;
  console.log('  item box spawns:');
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const row of def.itemRows) {
    const d0 = row.t * L;
    spline.sampleAtDistance(d0, _s);
    spline.attribsAtDistance(_s.distance, _at);
    const spread = row.spread ?? Math.max(6, _s.halfWidth * 2 - 6);
    const lats: number[] = [];
    for (let k = 0; k < row.count; k++) {
      lats.push(row.count === 1 ? 0 : ((k / (row.count - 1)) - 0.5) * spread);
    }
    roadSurfacePoint(spline, d0, 0, p, n);
    const gridA = L - 8.5 - 5 * 7 * 1.55 - 3;
    const inGrid = d0 >= gridA - 4 && d0 <= L - 4;
    console.log(
      `    t=${row.t} d=${d0.toFixed(1)} count=${row.count} spread=${spread.toFixed(1)} ` +
      `hw=${_at.halfWidth.toFixed(1)} lats=[${lats.map((x) => x.toFixed(1)).join(', ')}] ` +
      `centre y=${p.y.toFixed(2)} (+1.5 => ${(p.y + 1.5).toFixed(2)}) ` +
      `${inGrid ? 'INSIDE GRID AREA' : ''}` +
      `${lats.some((x) => Math.abs(x) > _at.halfWidth) ? ' LAT OFF ROAD' : ''}`,
    );
  }
  console.log(`    grid occupies d=${(L - 8.5 - 5 * 7 * 1.55 - 3).toFixed(1)}..${(L - 8.5).toFixed(1)} (t=${((L - 8.5 - 5 * 7 * 1.55 - 3) / L).toFixed(4)}..${((L - 8.5) / L).toFixed(4)})`);
}

// ---------------------------------------------------------------------------
// Prop placement
// ---------------------------------------------------------------------------

/**
 * Local footprint of each authored prop, read off `Props.authoredSpec`.
 * halfX / halfZ in metres; `spans` = the form is built to arch ACROSS the road
 * (its long axis must follow the binormal); otherwise the form FACES the road
 * (+Z toward the road, long axis along the tangent).
 */
const FOOTPRINT: Record<string, { hx: number; hz: number; spans: boolean }> = {
  startGantry: { hx: 14.3, hz: 1.5, spans: true },
  balloonArch: { hx: 11.6, hz: 0.9, spans: true },
  tunnelPortal: { hx: 14.5, hz: 1.3, spans: true },
  holoAd: { hx: 9, hz: 0.6, spans: true },
  grandstand: { hx: 17, hz: 7, spans: false },
  crowdStand: { hx: 11, hz: 5, spans: false },
  sponsorBoard: { hx: 3.2, hz: 0.6, spans: false },
  brakeBoard: { hx: 1.6, hz: 0.3, spans: false },
  signChevron: { hx: 0.62, hz: 0.3, spans: false },
  billboard: { hx: 6, hz: 0.6, spans: false },
  neonSign: { hx: 3, hz: 0.6, spans: false },
  seaWall: { hx: 6, hz: 1.2, spans: false },
  trafficLight: { hx: 1.2, hz: 0.5, spans: false },
};

function propReport(def: TrackDef, spline: TrackSpline): { violations: number; total: number } {
  const L = spline.length;
  let violations = 0;
  let total = 0;
  const corner = new THREE.Vector3();
  const worst = new Map<string, { lat: number; hw: number; t: number }>();
  const angles: Array<{ type: string; t: number; deg: number }> = [];

  const place = (type: string, t: number, lat: number): void => {
    const fp = FOOTPRINT[type];
    if (!fp) return;
    const d = ((t % 1) + 1) % 1 * L;
    spline.sampleAtDistance(d, _s);
    spline.attribsAtDistance(_s.distance, _at);
    const sh = lat < 0 ? _at.shoulderL : _at.shoulderR;
    const h = surfaceHeight(
      Math.max(-(_at.halfWidth + CROSS.kerbW + sh), Math.min(_at.halfWidth + CROSS.kerbW + sh, lat)),
      _at.halfWidth, sh, _s.distance, false,
    );
    const pos = _s.position.clone()
      .addScaledVector(_s.binormal, lat)
      .addScaledVector(_s.normal, h);
    // CURRENT derivation in Track.getDecorationHints()
    const yaw = Math.atan2(_s.tangent.x, _s.tangent.z);
    const ax = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)); // local +X
    const az = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));  // local +Z
    // angle of the prop's long axis (local X) to the local binormal
    const bin = new THREE.Vector3(_s.binormal.x, 0, _s.binormal.z).normalize();
    const deg = Math.acos(Math.min(1, Math.abs(ax.dot(bin)))) * 180 / Math.PI;
    if (fp.spans) angles.push({ type, t, deg });
    total++;
    let bad = false;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corner.copy(pos).addScaledVector(ax, sx * fp.hx).addScaledVector(az, sz * fp.hz);
        const cd = spline.nearestDistance(corner, -1);
        const cs = spline.sampleAtDistance(cd, makeSample());
        spline.attribsAtDistance(cd, _at);
        const clat = corner.clone().sub(cs.position).dot(cs.binormal);
        if (Math.abs(clat) < _at.halfWidth) {
          bad = true;
          const cur = worst.get(type);
          if (!cur || Math.abs(clat) < Math.abs(cur.lat)) {
            worst.set(type, { lat: clat, hw: _at.halfWidth, t });
          }
        }
      }
    }
    if (bad) violations++;
  };

  for (const spec of def.props) {
    const step = spec.step;
    const end = spec.end;
    if (step && end !== undefined && step > 1e-5) {
      const span = end >= spec.t ? end - spec.t : end + 1 - spec.t;
      const n = Math.min(400, Math.floor(span / step) + 1);
      for (let i = 0; i < n; i++) {
        place(spec.type, spec.t + i * step, spec.lat);
        if (spec.mirror) place(spec.type, spec.t + i * step, -spec.lat);
      }
    } else {
      place(spec.type, spec.t, spec.lat);
      if (spec.mirror) place(spec.type, spec.t, -spec.lat);
    }
  }
  console.log(`  authored props with a footprint: ${total}, ON-ROAD violations: ${violations}`);
  for (const [k, v] of worst) {
    console.log(`     ${k}: nearest corner lat ${v.lat.toFixed(2)} m (halfWidth ${v.hw.toFixed(1)}) at t=${v.t.toFixed(3)}`);
  }
  for (const a of angles) {
    console.log(`     gate ${a.type} t=${a.t.toFixed(3)}: long axis is ${a.deg.toFixed(1)} deg off the binormal (0 = spans the road)`);
  }
  return { violations, total };
}

export async function main(): Promise<void> {
  for (const id of TRACK_ORDER) {
    const def = TRACKS[id];
    const spline = new TrackSpline(resolveNodes(def.nodes, def.defaults), true);
    console.log(`\n================ ${def.name} (${id}) ================`);
    nodeTable(def, spline);
    boostAndJumpReport(def, spline);
    itemBoxReport(def, spline);
    propReport(def, spline);
    continuity(spline, id);
  }
}
