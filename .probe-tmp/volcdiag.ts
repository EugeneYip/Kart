/**
 * VOLCANO DIAGNOSTIC — why is volcanoRush 3x worse than anything else?
 *
 * Runs the real 12-kart race and, on the RISING EDGE of every barrier contact,
 * snapshots the complete driver state that produced it: where on the lap, which
 * side of the road, how far off the racing line, how fast against the target the
 * speed controller had asked for, what the band was pushing, what mode the
 * recovery machine was in, whether it was drifting/boosting/airborne.
 *
 * Everything is a distribution. A mean over 11 karts hid four zeros and a 75
 * once already.
 *
 * usage: node src/dev/node-run.mjs .probe-tmp/volcdiag.ts <seconds> <track> <label> [band] [seeds]
 */

import * as THREE from 'three';
import { loadTrack, makeField, makeCtx } from '@/dev/headless';
import { AIManager } from '@/ai/AIManager';
import { AIDriver, type DriverWorld } from '@/ai/AIDriver';
import { personalityById, personalityForKart } from '@/ai/AIPersonality';
import { createBandOutput, type CCClass } from '@/ai/Rubberband';
import { FIXED_DT } from '@/core/Config';
import { makeTuning } from '@/physics/Tuning';
import { SurfaceType } from '@/core/Types';
import type { Track } from '@/track/Track';
import { CHARACTERS } from '@/karts/Characters';

/**
 * Read from `CHARACTERS`, exactly as `wallgrind.ts` does. The literal that used
 * to be here entered capy and nova twice — the pre-b30350b field the game no
 * longer builds — so two of twelve karts got the wrong `makeTuning`.
 */
const GAME_ROSTER = CHARACTERS.slice(0, 12).map((c) => c.id);
const FIELD = 12;
const BUCKET = 20;

interface Contact {
  t: number;
  kart: number;
  pers: string;
  arc: number;
  /** +1 = wall on the kart's right, -1 = on its left. */
  side: number;
  speed: number;
  target: number;
  /** speed - target, m/s. Positive = arrived too fast for what it asked for. */
  over: number;
  lat: number;
  latC: number;
  halfWidth: number;
  mode: string;
  variant: string;
  drifting: boolean;
  boosting: boolean;
  grounded: boolean;
  airTime: number;
  risk: number;
  speedMul: number;
  composure: number;
  wallBias: number;
  avoidBias: number;
  surface: number;
  /** Distance to the nearest other kart, metres. */
  nearKart: number;
  /** Metres since this kart's previous contact (0 if first). */
  sincePrev: number;
}

interface Result {
  track: string;
  seed: number;
  band: boolean;
  contacts: Contact[];
  perKart: Array<{
    id: number; pers: string; char: string; laps: number; contacts: number;
    meanLap: number; offTrack: number; recovery: number; stuck: number;
    airSeconds: number; form: number;
  }>;
  lapLength: number;
  /** bucket -> [visits, sum speed, sum target, sum |lat|, contacts] */
  buckets: Float64Array[];
}

const _probe = new THREE.Vector3();
const _r = new THREE.Vector3();

async function run(
  trackId: string, seconds: number, seed: number, band: boolean,
): Promise<Result> {
  const cc: CCClass = 150;
  const track: Track = await loadTrack(trackId);
  const { physics, karts } = makeField(track, FIELD, cc);
  for (let i = 0; i < FIELD; i++) physics.setTuning(i, makeTuning(GAME_ROSTER[i], cc));

  for (let i = 0; i < FIELD; i++) {
    const st = track.getStartPosition(i);
    physics.place(i, st.position, st.quaternion);
  }

  const ai = new AIManager(track, { states: karts }, undefined, {});
  ai.init();
  ai.setPhysics(physics);
  ai.setDifficulty(cc);
  ai.setRaceStarted(true);
  ai.newFieldSeed(seed);
  if (!band) ai.rubberband.setEnabled(false);
  const line = ai.racingLine;
  if (!line) throw new Error('no racing line');

  const pPers = personalityById('clean') ?? personalityForKart(2);
  const player = new AIDriver(0, pPers, ai.rubberband.profile());
  player.setState(karts[0]);
  player.setForm({ pace: 0.97, mistake: 1, error: 1, drift: 1 });
  const neutral = createBandOutput();
  const pWorld: DriverWorld = {
    line, walls: track, karts, hazards: [], hazardCount: 0, elapsed: 0,
    raceStarted: true, countdown: 0, playerProgress: 0, playerId: 0,
    lapLength: line.lapLength, fieldSize: FIELD, cc: ai.rubberband.profile(),
  };

  const L = track.lapLength;
  const nB = Math.max(1, Math.ceil(L / BUCKET));
  const buckets: Float64Array[] = [];
  for (let b = 0; b < nB; b++) buckets.push(new Float64Array(5));

  const contacts: Contact[] = [];
  const touching = new Array<boolean>(FIELD).fill(false);
  const wallRadius = new Array<number>(FIELD).fill(1);
  const probeZ = new Array<number>(FIELD).fill(1);
  for (let i = 0; i < FIELD; i++) {
    const tn = physics.tuningOf(i);
    wallRadius[i] = (tn?.halfExtents.x ?? 0.72) * 1.04;
    probeZ[i] = (tn?.halfExtents.z ?? 0.97) * 0.58;
  }
  const lastArc = new Array<number>(FIELD).fill(-1);
  const laps = new Array<number>(FIELD).fill(0);
  const lastCross = new Array<number>(FIELD).fill(-1);
  const lapSum = new Array<number>(FIELD).fill(0);
  const airSeconds = new Array<number>(FIELD).fill(0);
  const contactN = new Array<number>(FIELD).fill(0);

  const ctx = makeCtx(FIXED_DT);
  const steps = Math.round(seconds / FIXED_DT);
  const order = new Array<number>(FIELD);
  for (let i = 0; i < FIELD; i++) order[i] = i;
  const rankNow = (): void => {
    order.sort((a, b) => karts[b].progress - karts[a].progress);
    for (let i = 0; i < FIELD; i++) karts[order[i]].racePosition = i + 1;
  };
  rankNow();

  for (let s = 0; s < steps; s++) {
    const tNow = s * FIXED_DT;
    pWorld.elapsed = tNow;
    pWorld.playerProgress = karts[0].progress;
    physics.setControl(0, player.step(FIXED_DT, pWorld, neutral));

    ai.fixedUpdate(ctx);
    physics.fixedUpdate(ctx);
    (ctx as { elapsed: number }).elapsed += FIXED_DT;
    (ctx as { frame: number }).frame++;

    for (let i = 0; i < FIELD; i++) {
      if (track.updateProgress(karts[i])) {
        if (lastCross[i] >= 0) { laps[i]++; lapSum[i] += tNow - lastCross[i]; }
        lastCross[i] = tNow;
      }
      if (!karts[i].grounded) airSeconds[i] += FIXED_DT;
    }
    rankNow();

    // --- occupancy, for "is this corner just slow" ------------------------
    if (s % 4 === 0) {
      for (let i = 1; i < FIELD; i++) {
        const d = ai.getDriver(i);
        if (!d) continue;
        const arc = (karts[i].progress - Math.floor(karts[i].progress)) * L;
        const b = Math.min(nB - 1, Math.max(0, Math.floor(arc / BUCKET)));
        buckets[b][0]++;
        buckets[b][1] += Math.abs(karts[i].speed);
        buckets[b][2] += d.debug.targetSpeed;
        buckets[b][3] += Math.abs(d.lateralError);
      }
    }

    // --- contacts ----------------------------------------------------------
    for (let i = 1; i < FIELD; i++) {
      const b = physics.getBody(i);
      if (!b) continue;
      let hit = false;
      let side = 0;
      for (let p = 0; p < 2 && !hit; p++) {
        const sgn = p === 0 ? 1 : -1;
        _probe.copy(b.position).addScaledVector(b.forward, sgn * probeZ[i]);
        const h = track.collideWalls(_probe, wallRadius[i]);
        if (h.hit && h.depth > 1e-4) {
          hit = true;
          // normal points OUT of the wall; right = forward x up
          _r.copy(b.forward).cross(b.up).normalize();
          side = h.normal.dot(_r) < 0 ? 1 : -1;
        }
      }
      if (hit && !touching[i]) {
        touching[i] = true;
        const d = ai.getDriver(i);
        if (d) {
          const st = karts[i];
          const arc = (st.progress - Math.floor(st.progress)) * L;
          const bk = Math.min(nB - 1, Math.max(0, Math.floor(arc / BUCKET)));
          buckets[bk][4]++;
          contactN[i]++;
          let nearest = 999;
          for (let j = 0; j < FIELD; j++) {
            if (j === i) continue;
            const dd = st.position.distanceTo(karts[j].position);
            if (dd < nearest) nearest = dd;
          }
          contacts.push({
            t: tNow, kart: i, pers: d.personality.id, arc, side,
            speed: Math.abs(st.speed), target: d.debug.targetSpeed,
            over: Math.abs(st.speed) - d.debug.targetSpeed,
            lat: d.lateralError, latC: 0, halfWidth: 0,
            mode: d.currentMode, variant: d.debug.variant,
            drifting: st.drifting, boosting: st.boostTime > 0,
            grounded: st.grounded, airTime: st.airTime,
            risk: d.debug.risk, speedMul: d.debug.speedMul, composure: d.composure,
            wallBias: d.debug.wallBias, avoidBias: d.debug.avoidBias,
            surface: st.surface, nearKart: nearest,
            sincePrev: lastArc[i] < 0 ? 0 : arc - lastArc[i],
          });
          lastArc[i] = arc;
        }
      } else if (!hit) touching[i] = false;
    }
  }

  const perKart = [];
  for (let i = 0; i < FIELD; i++) {
    const d = i === 0 ? player : ai.getDriver(i);
    perKart.push({
      id: i, pers: d?.personality.id ?? '?', char: GAME_ROSTER[i],
      laps: laps[i], contacts: contactN[i],
      meanLap: laps[i] > 0 ? lapSum[i] / laps[i] : 0,
      offTrack: d?.offTrackSeconds ?? 0, recovery: d?.recoveryLifetime ?? 0,
      stuck: d?.stuckEpisodeCount ?? 0, airSeconds: airSeconds[i],
      form: d?.debug.form ?? 1,
    });
  }

  ai.dispose();
  physics.dispose();
  return { track: trackId, seed, band, contacts, perKart, lapLength: L, buckets };
}

// ---------------------------------------------------------------------------

function pct(v: number[], f: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
}

function report(r: Result): void {
  const label = `${r.track} seed=${r.seed} band=${r.band ? 'ON' : 'OFF'}`;
  console.log(`\n########## ${label} — lap ${r.lapLength.toFixed(0)} m, ${r.contacts.length} contacts`);

  console.log('\nid char     pers        laps meanLap  cont  offT   rec stuck   air  form');
  for (const k of r.perKart) {
    console.log(
      `${String(k.id).padStart(2)} ${k.char.padEnd(8)} ${k.pers.padEnd(11)} ` +
        `${String(k.laps).padStart(4)} ${k.meanLap.toFixed(2).padStart(7)} ` +
        `${String(k.contacts).padStart(5)} ${k.offTrack.toFixed(1).padStart(5)} ` +
        `${k.recovery.toFixed(1).padStart(5)} ${String(k.stuck).padStart(5)} ` +
        `${k.airSeconds.toFixed(1).padStart(5)} ${k.form.toFixed(3)}` +
        (k.id === 0 ? '  <- player' : ''),
    );
  }
  const perLap = r.perKart.filter((k) => k.id > 0)
    .map((k) => (k.laps > 0 ? k.contacts / k.laps : k.contacts));
  console.log(
    `contacts/lap: min ${pct(perLap, 0).toFixed(1)} p25 ${pct(perLap, 0.25).toFixed(1)} ` +
      `med ${pct(perLap, 0.5).toFixed(1)} p75 ${pct(perLap, 0.75).toFixed(1)} ` +
      `max ${Math.max(...perLap).toFixed(1)}`,
  );

  // --- by personality -------------------------------------------------------
  const byPers = new Map<string, number>();
  for (const c of r.contacts) byPers.set(c.pers, (byPers.get(c.pers) ?? 0) + 1);
  console.log('\nby personality: ' +
    [...byPers.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));

  // --- hotspots -------------------------------------------------------------
  const nB = r.buckets.length;
  const rows: Array<{ b: number; n: number; v: number; tg: number; lat: number; c: number }> = [];
  for (let b = 0; b < nB; b++) {
    const q = r.buckets[b];
    if (q[4] === 0) continue;
    rows.push({
      b, n: q[0], v: q[0] ? q[1] / q[0] : 0, tg: q[0] ? q[2] / q[0] : 0,
      lat: q[0] ? q[3] / q[0] : 0, c: q[4],
    });
  }
  rows.sort((a, b) => b.c - a.c);
  console.log('\nHOTSPOTS (arc m -> contacts | mean speed / mean target / mean |lat err| there)');
  console.log('   arc     t   cont  visits  vAvg  tgtAvg  latAvg   over');
  for (const q of rows.slice(0, 14)) {
    console.log(
      `${String(q.b * BUCKET).padStart(6)} ${((q.b * BUCKET) / r.lapLength).toFixed(3)} ` +
        `${String(q.c).padStart(6)} ${String(q.n).padStart(7)} ${q.v.toFixed(1).padStart(5)} ` +
        `${q.tg.toFixed(1).padStart(7)} ${q.lat.toFixed(2).padStart(7)} ${(q.v - q.tg).toFixed(1).padStart(6)}`,
    );
  }

  // --- contact context ------------------------------------------------------
  const cs = r.contacts;
  if (!cs.length) return;
  const f = (sel: (c: Contact) => number): string => {
    const v = cs.map(sel);
    return `min ${pct(v, 0).toFixed(2)} p25 ${pct(v, 0.25).toFixed(2)} med ${pct(v, 0.5).toFixed(2)} ` +
      `p75 ${pct(v, 0.75).toFixed(2)} p95 ${pct(v, 0.95).toFixed(2)} max ${Math.max(...v).toFixed(2)}`;
  };
  console.log('\nCONTACT CONTEXT (distributions over every contact)');
  console.log(`  |lateral err| m : ${f((c) => Math.abs(c.lat))}`);
  console.log(`  speed-target m/s: ${f((c) => c.over)}`);
  console.log(`  speed       m/s : ${f((c) => c.speed)}`);
  console.log(`  risk            : ${f((c) => c.risk)}`);
  console.log(`  composure       : ${f((c) => c.composure)}`);
  console.log(`  nearest kart m  : ${f((c) => c.nearKart)}`);
  console.log(`  wallBias m      : ${f((c) => c.wallBias)}`);
  const share = (name: string, p: (c: Contact) => boolean): void => {
    const n = cs.filter(p).length;
    console.log(`  ${name.padEnd(24)} ${String(n).padStart(4)} / ${cs.length}  ${((100 * n) / cs.length).toFixed(0)}%`);
  };
  console.log('\nCONTACT FLAGS');
  share('drifting', (c) => c.drifting);
  share('boosting', (c) => c.boosting);
  share('airborne', (c) => !c.grounded);
  share('in recovery mode', (c) => c.mode !== 'race');
  share('off-road surface', (c) => c.surface !== SurfaceType.Road &&
    c.surface !== SurfaceType.Boost && c.surface !== SurfaceType.Metal);
  share('another kart < 4 m', (c) => c.nearKart < 4);
  share('|lat| < 2 m (ON line)', (c) => Math.abs(c.lat) < 2);
  share('|lat| > 4 m', (c) => Math.abs(c.lat) > 4);
  share('speed > target+2', (c) => c.over > 2);
  share('wall on the RIGHT', (c) => c.side > 0);
  share('risk > 0.5', (c) => c.risk > 0.5);
  share('variant != optimal', (c) => c.variant !== 'optimal');

  // --- top clusters: the same kart hitting the same place ------------------
  const cluster = new Map<string, number>();
  for (const c of cs) {
    const key = `${c.kart}@${Math.floor(c.arc / 40) * 40}`;
    cluster.set(key, (cluster.get(key) ?? 0) + 1);
  }
  console.log('\nWORST kart@40m-window repeats: ' +
    [...cluster.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, v]) => `${k}:${v}`).join('  '));

  // --- raw dump of the worst window ----------------------------------------
  const worstB = rows[0];
  if (worstB) {
    const lo = worstB.b * BUCKET - 20;
    const hi = worstB.b * BUCKET + 40;
    const sel = cs.filter((c) => c.arc >= lo && c.arc < hi);
    console.log(`\nRAW contacts in ${lo}..${hi} m (${sel.length}):`);
    console.log('    t  kart pers        arc side  speed  tgt   over    lat  mode     var      dr bo gr  risk  comp  wBias near');
    for (const c of sel.slice(0, 40)) {
      console.log(
        `${c.t.toFixed(1).padStart(6)} ${String(c.kart).padStart(3)} ${c.pers.padEnd(11)} ` +
          `${c.arc.toFixed(0).padStart(5)} ${String(c.side).padStart(3)} ` +
          `${c.speed.toFixed(1).padStart(6)} ${c.target.toFixed(1).padStart(5)} ` +
          `${c.over.toFixed(1).padStart(6)} ${c.lat.toFixed(1).padStart(6)} ` +
          `${c.mode.padEnd(8)} ${c.variant.padEnd(8)} ` +
          `${c.drifting ? 'D' : '.'}  ${c.boosting ? 'B' : '.'}  ${c.grounded ? 'G' : '.'} ` +
          `${c.risk.toFixed(2).padStart(5)} ${c.composure.toFixed(2).padStart(5)} ` +
          `${c.wallBias.toFixed(1).padStart(6)} ${c.nearKart.toFixed(1).padStart(4)}`,
      );
    }
  }
}

const SECONDS = Number(process.argv[3] ?? 260);
const tracks = (process.argv[4] ?? 'volcanoRush').split(',');
const bandArg = (process.argv[5] ?? 'on').split(',');
const seeds = (process.argv[6] ?? '12345').split(',').map(Number);

for (const trackId of tracks) {
  for (const bs of bandArg) {
    for (const seed of seeds) {
      report(await run(trackId, SECONDS, seed, bs !== 'off'));
    }
  }
}
