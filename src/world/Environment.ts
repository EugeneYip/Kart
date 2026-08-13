/**
 * ============================================================================
 *  APEX KART — ENVIRONMENT (facade)
 * ============================================================================
 *  The one object Game builds for "everything that isn't road, kart or UI".
 *  It owns and sequences:
 *
 *      TerrainField  (the shared heightfield every module samples)
 *        -> Terrain   ground + distant relief
 *        -> Water     ocean / lake / lava
 *        -> Foliage   grass, trees, shrubs
 *        -> Props     race dressing + per-theme set decoration
 *        -> Crowd     instanced spectators
 *        -> Weather   rain / snow / ash / leaves / heat shimmer
 *
 *  Track is consumed *defensively*. Every method we want is feature-detected
 *  with `typeof` and every value is range-checked, because Track is authored by
 *  a different agent on a different clock. If the track can't tell us where the
 *  road is, Environment invents a plausible closed circuit (and, only in that
 *  case, a placeholder road ribbon) so the world is still a world.
 *
 *  Environment never throws out of `init()`. A broken decoration layer degrades
 *  to "missing" — it must never take the race down with it.
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings } from '@/core/Types';
import { RENDER_ORDER } from '@/core/Config';
import { Rng, clamp, clamp01, damp } from '@/core/MathUtils';
import {
  TerrainField, worldRegistry,
  type DecorationHints, type DecorationProp, type PathStation,
  type PropSurfaceHint, type WorldContext, type WorldTheme,
} from './WorldTextures';
import { Terrain } from './Terrain';
import { Foliage } from './Foliage';
import { Water, type WaterPresetName } from './Water';
import { Props, planStands, type StandSpec } from './Props';
import { Crowd } from './Crowd';
import { Weather, type WeatherName } from './Weather';

// ---------------------------------------------------------------------------
// The (deliberately loose) shape we hope Track has
// ---------------------------------------------------------------------------

interface SampleLike {
  position?: THREE.Vector3;
  tangent?: THREE.Vector3;
  normal?: THREE.Vector3;
  binormal?: THREE.Vector3;
  halfWidth?: number;
  bank?: number;
  distance?: number;
  t?: number;
}

interface TrackRef {
  lapLength?: number;
  /** `ITrackService.trackId` — how we notice the circuit has been swapped. */
  trackId?: string;
  def?: { id?: string; weather?: string };
  roadGroup?: THREE.Object3D;
  group?: THREE.Object3D;
  getDecorationHints?: () => unknown;
  sampleAt?: (t: number) => unknown;
  sampleAtDistance?: (d: number) => unknown;
  project?: (p: THREE.Vector3) => unknown;
}

const THEMES: readonly WorldTheme[] = ['coastal', 'city', 'volcano', 'meadow', 'desert', 'snow'];
const SKY_NAMES = ['day', 'sunset', 'night', 'storm', 'volcanic'] as const;
type SkyName = (typeof SKY_NAMES)[number];

/** Sensible sky per theme when the track doesn't name one. */
const THEME_SKY: Record<WorldTheme, SkyName> = {
  coastal: 'sunset',
  city: 'night',
  volcano: 'volcanic',
  meadow: 'day',
  desert: 'day',
  snow: 'storm',
};

const THEME_WATER: Record<WorldTheme, WaterPresetName> = {
  coastal: 'ocean',
  city: 'lake',
  volcano: 'lava',
  meadow: 'lake',
  desert: 'none',
  snow: 'lake',
};

/**
 * DEFAULT weather per theme, not the final word. A theme says what a place is
 * built of, not what its sky is doing, and keying weather off it alone meant
 * every `theme: 'city'` circuit raced in rain — including `bostonHarbor`, a
 * `skyPreset: 'day'` harbour, which ran at midday under a downpour with
 * `applyWetRoad(true)` cutting road roughness to 0.28x and putting droplets on
 * the lens. `TrackDef.weather` overrides this per circuit; see `resolveWeather`.
 */
const THEME_WEATHER: Record<WorldTheme, WeatherName> = {
  coastal: 'leaves',
  city: 'rain',
  volcano: 'ash',
  meadow: 'leaves',
  desert: 'clear',
  snow: 'snow',
};

const WEATHER_NAMES: readonly WeatherName[] = [
  'clear', 'rain', 'storm', 'snow', 'ash', 'leaves', 'shimmer',
];

/** Baseline wind: strength, direction (radians in XZ). */
const THEME_WIND: Record<WorldTheme, [number, number]> = {
  coastal: [0.34, 0.7],
  city: [0.18, 2.1],
  volcano: [0.26, 4.0],
  meadow: [0.24, 0.9],
  desert: [0.30, 5.2],
  snow: [0.40, 3.3],
};

/** Metres between resampled centreline stations. */
const STATION_SPACING = 7;
/** Field texel size targets — the road corridor must be crisp. */
const MPT_FOR_TIER: Record<string, number> = { low: 5.0, medium: 3.8, high: 2.9, ultra: 2.4 };
const MAX_FIELD_RES = 800;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _box = new THREE.Box3();

// ---------------------------------------------------------------------------

export class Environment implements ISubsystem {
  readonly group = new THREE.Group();

  terrain: Terrain | null = null;
  water: Water | null = null;
  foliage: Foliage | null = null;
  props: Props | null = null;
  crowd: Crowd | null = null;
  weather: Weather | null = null;

  /** Built once in `init()`; the single source of truth for the whole world. */
  field: TerrainField | null = null;
  ctx: WorldContext | null = null;
  theme: WorldTheme = 'meadow';
  skyPreset: SkyName = 'day';

  /** Set by Game/ChaseCamera; falls back to whatever camera renders us. */
  camera: THREE.PerspectiveCamera | null = null;

  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private track: TrackRef | null;
  private quality: QualitySettings;

  private sky: { presetName: string; setPreset(n: string): void } | null = null;
  private lighting: { presetName: string; setPreset(n: string): void } | null = null;
  /** True once the authored preset has been OBSERVED to survive a live frame. */
  private presetPushed = false;
  private presetTries = 0;

  /** The circuit id this world was built for. Empty until `init()` runs. */
  private builtTrackId = '';
  /** True while a circuit rebuild is in flight. */
  private rebuilding = false;

  private stands: StandSpec[] = [];
  private placeholderRoad: THREE.Group | null = null;
  private ownsRoad = false;

  /** Wind animation state — a slow gust envelope shared by foliage and cloth. */
  private windBase = 0.24;
  private windDir = 0.9;
  private wind = 0.24;
  private windPhase = 0;

  private playerPos = new THREE.Vector3(0, -999, 0);
  private hasPlayer = false;
  private ready = false;
  private built = false;
  private lastLap = 0;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    track: unknown,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.track = (track && typeof track === 'object') ? (track as TrackRef) : null;
    this.quality = quality;
  }

  // =========================================================================
  // LATE WIRING (all optional — Game may or may not call these)
  // =========================================================================

  setCamera(camera: THREE.PerspectiveCamera): void {
    if (!camera || !camera.isPerspectiveCamera) return;
    this.camera = camera;
    this.terrain?.setCamera(camera);
    this.foliage?.setCamera(camera);
    this.water?.setCamera(camera);
    this.props?.setCamera(camera);
    this.crowd?.setCamera(camera);
    this.weather?.setCamera(camera);
  }

  setSky(sky: unknown): void {
    if (sky && typeof (sky as { setPreset?: unknown }).setPreset === 'function') {
      this.sky = sky as { presetName: string; setPreset(n: string): void };
      this.pushPreset(false);
    }
  }

  setLighting(lighting: unknown): void {
    if (lighting && typeof (lighting as { setPreset?: unknown }).setPreset === 'function') {
      this.lighting = lighting as { presetName: string; setPreset(n: string): void };
      this.pushPreset(false);
    }
  }

  /** Karts tell us where the player is so grass bends and the crowd looks alive. */
  setPlayerPosition(p: THREE.Vector3): void {
    if (!p) return;
    this.playerPos.copy(p);
    this.hasPlayer = true;
  }

  // =========================================================================
  // INIT
  // =========================================================================

  async init(): Promise<void> {
    // IDEMPOTENT ON PURPOSE. `Game.init()` builds every subsystem by hand and
    // then registers them with the Engine, whose `initAll()` calls `init()` on
    // each one a second time. Building the world twice does not just waste
    // memory — the orphaned first copy stays parented under `this.group`, so
    // every terrain grid, grass ring, prop and spectator is submitted twice, and
    // the two live Water instances trigger a *cascade* of planar-reflection
    // passes (each one re-rendering the scene, which contains the other's water
    // mesh, which starts another pass...). Measured: 6 full-scene passes and
    // 2.8 M triangles of Environment where there should be 1 and 1.4 M.
    if (this.built) return;
    this.built = true;
    // Claim the circuit BEFORE building it. A build that throws must not leave
    // `syncToTrack` believing the world is stale, or it would rebuild forever.
    this.builtTrackId = this.currentTrackId();

    this.group.name = 'Environment';
    this.scene.add(this.group);

    const hints = this.readHints();
    this.theme = hints.theme;
    this.skyPreset = hints.skyPreset as SkyName;

    // --- centreline -----------------------------------------------------------
    const stations = this.buildStations(hints);
    const lapLength = stations.length ? stations[stations.length - 1].s + STATION_SPACING : 1200;
    let maxHalfWidth = 11;
    for (const s of stations) if (s.halfWidth > maxHalfWidth) maxHalfWidth = s.halfWidth;

    // --- the heightfield everything shares -----------------------------------
    this.field = this.bakeField(stations, hints);
    await yieldFrame();

    this.ctx = {
      field: this.field,
      stations,
      hints,
      lapLength,
      theme: this.theme,
      waterLevel: hints.waterLevel,
      maxHalfWidth,
    };

    const [wStrength, wDir] = THEME_WIND[this.theme] ?? THEME_WIND.meadow;
    this.windBase = wStrength;
    this.windDir = wDir;
    this.wind = wStrength;

    // Push the mood before anything builds, so per-preset colours are right.
    // Deliberately un-latched: see `pushPreset`.
    this.resolveSkyLighting();
    this.pushPreset(false);

    // --- placeholder road (only when the real Track has none) -----------------
    if (!this.findRoadGroup()) {
      this.ownsRoad = true;
      this.buildPlaceholderRoad(stations);
    }

    // --- layers, in dependency order -----------------------------------------
    await this.stage('Terrain', async () => {
      this.terrain = new Terrain(this.scene, this.field as TerrainField, this.theme, this.quality);
      await this.terrain.init();
      reparent(this.terrain.group, this.group);
    });

    await this.stage('Water', async () => {
      this.water = new Water(this.scene, this.renderer, this.ctx as WorldContext, this.quality);
      await this.water.init();
      this.water.setPreset(THEME_WATER[this.theme] ?? 'lake');
      reparent(this.water.group, this.group);
    });

    await this.stage('Foliage', async () => {
      this.foliage = new Foliage(this.scene, this.renderer, this.ctx as WorldContext, this.quality);
      await this.foliage.init();
      this.foliage.setWind(this.windBase, this.windDir);
      // Grass in a planar reflection is invisible at any distance you'd see the
      // reflection from, and it is by far the heaviest thing in the scene.
      this.foliage.group.userData.noReflect = true;
      reparent(this.foliage.group, this.group);
    });

    this.stands = safe(() => planStands(this.ctx as WorldContext), [] as StandSpec[]);

    await this.stage('Props', async () => {
      this.props = new Props(
        this.scene, this.renderer, this.ctx as WorldContext, this.quality, this.stands,
      );
      await this.props.init();
      // Set dressing is small, numerous and *behind* the camera as often as not.
      // At the 512px the reflection now runs at, none of it survives a single
      // texel — and it is ~24 of the reflection pass's draw calls.
      this.props.group.userData.noReflect = true;
      reparent(this.props.group, this.group);
    });

    await this.stage('Crowd', async () => {
      this.crowd = new Crowd(this.scene, this.ctx as WorldContext, this.quality, this.stands);
      await this.crowd.init();
      this.crowd.group.userData.noReflect = true;
      reparent(this.crowd.group, this.group);
    });

    await this.stage('Weather', async () => {
      this.weather = new Weather(this.scene, this.renderer, this.ctx as WorldContext, this.quality);
      await this.weather.init();
      this.weather.setRoadGroup(this.findRoadGroup());
      this.weather.setPreset(this.resolveWeather());
      this.weather.group.userData.noReflect = true;
      reparent(this.weather.group, this.group);
    });

    if (this.camera) this.setCamera(this.camera);
    this.ready = true;
  }

  /** Run one build stage, isolate its failure, and give the browser a frame. */
  private async stage(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.error(`[Environment] ${name} failed to build:`, err);
    }
    await yieldFrame();
  }

  // =========================================================================
  // TRACK INTERROGATION
  // =========================================================================

  /**
   * The circuit's authored weather, or the theme default.
   *
   * Read off `track.def` rather than through `DecorationHints`, deliberately:
   * `DecorationHints` is declared in `WorldTextures.ts` and is the contract
   * `Props`/`Terrain`/`Crowd` all consume, so widening it to carry a forecast
   * would touch three subsystems that have no use for one. `TrackRef.def`
   * already existed for the circuit-swap check.
   *
   * Validated against `WEATHER_NAMES` because the def field is a plain string
   * union with no runtime guard: an unknown name falls back to the theme rather
   * than reaching `Weather.setPreset`, where `normalise()` would silently turn
   * it into `'clear'` and hide the typo.
   */
  private resolveWeather(): WeatherName {
    const authored = this.track?.def?.weather;
    if (typeof authored === 'string'
      && (WEATHER_NAMES as readonly string[]).includes(authored)) {
      return authored as WeatherName;
    }
    return THEME_WEATHER[this.theme] ?? 'clear';
  }

  private readHints(): DecorationHints {
    const raw = safe(() => {
      const t = this.track;
      return t && typeof t.getDecorationHints === 'function' ? t.getDecorationHints() : null;
    }, null);

    const h = (raw && typeof raw === 'object' ? raw : {}) as Partial<DecorationHints>;

    const theme: WorldTheme = THEMES.includes(h.theme as WorldTheme)
      ? (h.theme as WorldTheme) : 'coastal';

    const skyPreset = (SKY_NAMES as readonly string[]).includes(h.skyPreset as string)
      ? (h.skyPreset as SkyName) : THEME_SKY[theme];

    const props: DecorationProp[] = [];
    if (Array.isArray(h.props)) {
      for (const p of h.props) {
        if (!p || typeof p !== 'object') continue;
        const pos = (p as DecorationProp).position;
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) continue;
        const type = typeof (p as DecorationProp).type === 'string' ? (p as DecorationProp).type : '';
        if (!type) continue;
        props.push({
          type,
          position: _v.copy(pos).clone(),
          rotation: (p as DecorationProp).rotation,
          scale: (p as DecorationProp).scale,
          surface: readSurfaceHint((p as DecorationProp).surface),
        });
      }
    }

    const seed = Number.isFinite(h.terrainSeed) ? (h.terrainSeed as number) | 0 : 20260810;
    const water = Number.isFinite(h.waterLevel) ? (h.waterLevel as number) : defaultWaterLevel(theme);

    return { theme, skyPreset, props, terrainSeed: seed || 1, waterLevel: water };
  }

  /**
   * Resample the centreline into evenly spaced stations. Tries `sampleAt`,
   * then `sampleAtDistance`, then falls back to an invented circuit.
   */
  private buildStations(hints: DecorationHints): PathStation[] {
    const t = this.track;
    const byT = t && typeof t.sampleAt === 'function' ? t.sampleAt.bind(t) : null;
    const byD = t && typeof t.sampleAtDistance === 'function' ? t.sampleAtDistance.bind(t) : null;

    let lapLength = Number.isFinite(t?.lapLength) ? (t as { lapLength: number }).lapLength : 0;
    if (!(lapLength > 60) || lapLength > 40000) lapLength = 0;

    if (byT || byD) {
      // Establish a lap length if the track didn't publish a usable one.
      if (!lapLength && byT) {
        const probe = readSample(safe(() => byT(0), null));
        const probeHalf = readSample(safe(() => byT(0.5), null));
        if (probe && probeHalf) lapLength = probe.position.distanceTo(probeHalf.position) * 2.6;
      }
      if (!lapLength) lapLength = 1400;

      const count = clamp(Math.round(lapLength / STATION_SPACING), 48, 900);
      const out: PathStation[] = [];
      let ok = 0;
      for (let i = 0; i < count; i++) {
        const frac = i / count;
        const raw = byT ? safe(() => byT(frac), null) : safe(() => byD!(frac * lapLength), null);
        const s = readSample(raw);
        if (!s) continue;
        out.push(stationFrom(s, (i / count) * lapLength));
        ok++;
      }
      // Only trust the track if it answered nearly every probe.
      if (ok > count * 0.85 && out.length > 40 && spanOf(out) > 80) {
        resampleArcLength(out);
        return out;
      }
      console.warn('[Environment] track centreline unusable — using the demo circuit');
    }

    return demoCircuit(hints.terrainSeed);
  }

  // =========================================================================
  // FIELD
  // =========================================================================

  private bakeField(stations: PathStation[], hints: DecorationHints): TerrainField {
    _box.makeEmpty();
    for (const s of stations) _box.expandByPoint(_v.set(s.px, s.py, s.pz));
    if (stations.length === 0) _box.expandByPoint(_v.set(0, 0, 0));
    _box.getCenter(_v2);

    const span = Math.max(_box.max.x - _box.min.x, _box.max.z - _box.min.z);
    // Room for grandstands, tree lines and city blocks outside the circuit.
    const extent = clamp(span + 520, 1250, 1800);

    const targetMpt = MPT_FOR_TIER[this.quality.tier] ?? 3.0;
    const res = clamp(Math.round(extent / targetMpt / 8) * 8 + 1, 129, MAX_FIELD_RES + 1);

    // Rolling-hill amplitude: gentle where the road is, big at the rim.
    const amplitude = this.theme === 'city' ? 5.5
      : this.theme === 'desert' ? 9
      : this.theme === 'snow' ? 11
      : this.theme === 'volcano' ? 10 : 8;

    return new TerrainField({
      seed: hints.terrainSeed,
      extent,
      res,
      centreX: _v2.x,
      centreZ: _v2.z,
      stations,
      theme: this.theme,
      waterLevel: hints.waterLevel,
      amplitude,
    }, this.renderer);
  }

  // =========================================================================
  // SKY / LIGHTING MOOD
  // =========================================================================

  private resolveSkyLighting(): void {
    if (!this.sky && worldRegistry.sky) this.sky = worldRegistry.sky;
    if (!this.lighting && worldRegistry.lighting) this.lighting = worldRegistry.lighting;
  }

  /**
   * Publish the track's mood. Lighting is authoritative (it forwards to Sky and
   * owns the fog/sun uniform block), so prefer it and only touch Sky directly
   * when there is no Lighting.
   *
   * `latch` is the whole subtlety. The old guard was `if (this.presetPushed)
   * return;` set the moment a push was *attempted*, on the reasoning that
   * anything which moved the preset afterwards had made a deliberate decision we
   * shouldn't fight. But the thing that moved it afterwards was not a decision:
   * `Game.init()` wires `lighting.setSky(sky)` AFTER building Environment, and
   * that used to overwrite our push with Sky's untouched boot default. So the
   * flag said "done" while the value said 'day' on every circuit.
   *
   * So: attempts made during `init()` and late wiring never latch, and `update()`
   * re-asserts on live frames until the value is *observed* to have stuck. Once
   * it has, we stop touching it for good — `__QA__.setSky()` and anything else
   * that deliberately moves the mood on is then left alone, which is what the
   * old comment was actually reaching for.
   */
  private pushPreset(latch: boolean): void {
    if (this.presetPushed) return;
    this.resolveSkyLighting();
    const lighting = this.lighting;
    const sky = this.sky;
    if (!lighting && !sky) return;
    const want = this.skyPreset;
    // Lighting first: it is authoritative and forwards to Sky, so when the two
    // are joined up this is the only call that does any work.
    if (lighting && lighting.presetName !== want) safe(() => lighting.setPreset(want), undefined);
    // But Lighting only forwards once it has been *given* a Sky, and `Game.ts`
    // wires that after we are built (a harness may never wire it at all). Until
    // then the forward is silently skipped and the dome sits on its boot default
    // while the lights are correct, so close that gap here rather than assume.
    // Both `setPreset`s are idempotent, so a redundant call costs nothing.
    if (sky && sky.presetName !== want) safe(() => sky.setPreset(want), undefined);
    if (!latch) return;
    this.presetTries++;
    // Latch only when BOTH ends are observed to hold the authored value — or,
    // rather than warn on every frame forever if Sky/Lighting are broken enough
    // to refuse it, give up after a few seconds.
    const landed = (!lighting || lighting.presetName === want)
      && (!sky || sky.presetName === want);
    this.presetPushed = landed || this.presetTries > 240;
  }

  // =========================================================================
  // CIRCUIT CHANGES
  // =========================================================================

  /** `ITrackService.trackId`, or '' when the track can't tell us. Allocation-free. */
  private currentTrackId(): string {
    const t = this.track;
    if (!t) return '';
    try {
      const id = t.trackId;
      if (typeof id === 'string' && id.length > 0) return id;
      const d = t.def;
      if (d && typeof d.id === 'string' && d.id.length > 0) return d.id;
    } catch {
      // A track service mid-teardown is allowed to throw out of its getter.
    }
    return '';
  }

  /**
   * Re-read the track and, if this is a *different* circuit from the one the
   * world was built for, throw the world away and build the new one.
   *
   * This is what makes Neon Metropolis and Volcano Rush exist. `Track.loadTrack`
   * swaps the road spline and nothing else; before this, both of them rendered
   * their own road inside the Sunset Coastline world — blue daytime sky, coastal
   * mountains, sand shoulders, palm trees — because `Environment.init()` ran
   * exactly once, at boot, and is (correctly) idempotent thereafter.
   *
   * Environment does this itself, from the track it already holds, rather than
   * waiting to be told: it is the only object that knows what it built the world
   * from, and it needs no wiring that `Game.ts` would have to add. `update()`
   * calls this every frame — one string compare — so *every* path that changes
   * the circuit is covered, not just the menu's.
   *
   * Synchronous and fire-and-forget on purpose. `beginRace()` is sync and must
   * not be held up: nothing else in the race depends on Environment, `ready` is
   * false for the duration so `update()` no-ops cleanly, and the pre-race flyby
   * covers the build. Re-entrancy is handled by the tail re-checking the id, so
   * changing circuit twice mid-build settles on the last one asked for.
   */
  syncToTrack(): void {
    if (this.rebuilding) return;
    const id = this.currentTrackId();
    if (!id || id === this.builtTrackId) return;
    // Claim the slot BEFORE `rebuildWorld()` is called: it is async, so its
    // synchronous prefix (`dispose()`, and `init()` up to its first `await`)
    // runs before any assignment of the returned promise would land. A flag set
    // here cannot be raced by a re-entrant call from inside that prefix.
    this.rebuilding = true;
    void this.rebuildWorld()
      .catch((err) => { console.error('[Environment] circuit rebuild failed:', err); })
      .then(() => {
        this.rebuilding = false;
        // The circuit may have changed again while we were building.
        this.syncToTrack();
      });
  }

  /**
   * Exactly `dispose(); await init();` — no more. `dispose()` already resets
   * `built` (and now the preset latch), and `init()` re-reads the track's hints,
   * so the new circuit's theme, sky preset, terrain seed, water, weather, wind
   * and props all follow from the one call. Building without disposing first is
   * the cascade the comment in `init()` documents, so the order matters.
   */
  private async rebuildWorld(): Promise<void> {
    this.dispose();
    await this.init();
  }

  // =========================================================================
  // PLACEHOLDER ROAD (demo only)
  // =========================================================================

  private findRoadGroup(): THREE.Object3D | null {
    const t = this.track;
    if (!t) return null;
    const g = t.roadGroup ?? t.group;
    if (g && (g as THREE.Object3D).isObject3D && (g as THREE.Object3D).children.length > 0) {
      return g as THREE.Object3D;
    }
    return null;
  }

  /**
   * A ribbon of asphalt with painted edges, generated from the same stations the
   * terrain was carved with. Exists purely so the world can be reviewed before
   * the Track module lands; `ownsRoad` is false the moment a real road appears.
   */
  private buildPlaceholderRoad(stations: PathStation[]): void {
    if (stations.length < 8) return;
    const n = stations.length;
    const kerb = 0.9;
    const verts = n * 4;
    const pos = new Float32Array(verts * 3);
    const nrm = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const col = new Float32Array(verts * 3);

    const asphaltA = new THREE.Color(0x2e3134);
    const asphaltB = new THREE.Color(0x3b3f43);
    const line = new THREE.Color(0xe8e6de);
    const c = new THREE.Color();

    for (let i = 0; i < n; i++) {
      const s = stations[i];
      const hw = s.halfWidth;
      const lanes: Array<[number, THREE.Color]> = [
        [-hw, line], [-hw + kerb, asphaltA], [hw - kerb, asphaltB], [hw, line],
      ];
      for (let k = 0; k < 4; k++) {
        const [off, colour] = lanes[k];
        const i3 = (i * 4 + k) * 3;
        pos[i3] = s.px + s.bx * off;
        pos[i3 + 1] = s.py + off * s.tanBank + 0.035;
        pos[i3 + 2] = s.pz + s.bz * off;
        nrm[i3] = 0; nrm[i3 + 1] = 1; nrm[i3 + 2] = 0;
        const i2 = (i * 4 + k) * 2;
        uv[i2] = (off + hw) / (hw * 2) * 3.2;
        uv[i2 + 1] = s.s / 8;
        c.copy(colour);
        if (k === 1 || k === 2) c.multiplyScalar(0.94 + ((i * 7919) % 13) / 90);
        col[i3] = c.r; col[i3 + 1] = c.g; col[i3 + 2] = c.b;
      }
    }

    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = i * 4;
      const b = ((i + 1) % n) * 4;
      for (let k = 0; k < 3; k++) {
        idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      name: 'placeholder-road',
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'PlaceholderRoad';
    mesh.receiveShadow = true;
    mesh.renderOrder = RENDER_ORDER.ROAD;

    const g = new THREE.Group();
    g.name = 'PlaceholderRoadGroup';
    g.add(mesh);
    this.group.add(g);
    this.placeholderRoad = g;
  }

  // =========================================================================
  // FRAME
  // =========================================================================

  update(ctx: FrameContext): void {
    // Both of these have to run even while the world is not `ready`: the sky and
    // the lighting are not ours to build, and a circuit change arrives while a
    // previous rebuild may still be in flight.
    this.syncToTrack();
    if (!this.presetPushed) this.pushPreset(true);

    if (!this.ready) return;

    // Terrain, grass and water latch whichever camera drew them last. Crowd and
    // Props have no such hook, and their per-chunk culling is useless without a
    // camera — so if nobody called `setCamera`, adopt the one that is already
    // rendering us. Costs one null check a frame once wired.
    if (!this.camera) {
      const found = this.terrain?.camera ?? this.water?.camera ?? this.foliage?.camera ?? null;
      if (found) this.setCamera(found);
    }

    // --- wind: slow multi-octave gusting, shared by grass, cloth and weather --
    this.windPhase += ctx.dt;
    const gust = 0.5 + 0.5 * Math.sin(this.windPhase * 0.21)
      + 0.28 * Math.sin(this.windPhase * 0.63 + 1.7)
      + 0.14 * Math.sin(this.windPhase * 1.37 + 4.1);
    const target = this.windBase * clamp(gust * 0.72, 0.35, 1.75);
    this.wind = damp(this.wind, target, 0.55, ctx.dt);
    const dir = this.windDir + Math.sin(this.windPhase * 0.13) * 0.22;

    if (this.foliage) {
      this.foliage.setWind(this.wind, dir);
      if (this.hasPlayer) this.foliage.playerPosition.copy(this.playerPos);
      this.foliage.update(ctx);
    }
    this.terrain?.update(ctx);
    this.water?.update(ctx);
    if (this.props) {
      this.props.setWind(this.wind, dir);
      this.props.update(ctx);
    }
    this.crowd?.update(ctx);
    if (this.weather) {
      this.weather.setWind(this.wind, dir);
      this.weather.update(ctx);
    }
  }

  resize(): void { /* nothing resolution-dependent outside Water's RT */ }

  /** Kick a Mexican wave through the crowd — call on a lap or an overtake. */
  celebrate(): void {
    this.lastLap++;
    this.crowd?.triggerWave();
  }

  // =========================================================================

  /** Draw calls this whole subsystem contributes, for the perf readout. */
  get drawCalls(): number {
    return (this.terrain ? 2 : 0)
      + (this.water?.drawCalls ?? 0)
      + (this.foliage?.drawCalls ?? 0)
      + (this.props?.drawCalls ?? 0)
      + (this.crowd?.drawCalls ?? 0)
      + (this.weather?.drawCalls ?? 0)
      + (this.placeholderRoad ? 1 : 0);
  }

  dispose(): void {
    this.weather?.dispose();
    this.crowd?.dispose();
    this.props?.dispose();
    this.foliage?.dispose();
    this.water?.dispose();
    this.terrain?.dispose();
    this.field?.dispose();
    if (this.placeholderRoad) {
      this.placeholderRoad.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      this.placeholderRoad = null;
    }
    this.terrain = null; this.water = null; this.foliage = null;
    this.props = null; this.crowd = null; this.weather = null;
    this.field = null; this.ctx = null;
    this.stands = [];
    this.scene.remove(this.group);
    this.group.clear();
    this.ready = false;
    this.built = false;
    this.ownsRoad = false;
    // A rebuild is for a new circuit with a new authored mood, so the mood has to
    // be pushed again — and re-latched against the *new* value.
    this.presetPushed = false;
    this.presetTries = 0;
    this.builtTrackId = '';
    // `sky`, `lighting` and `camera` are deliberately kept: they are not ours to
    // build, they outlive any one circuit, and `init()` re-wires the camera.
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

/** Run `fn`, swallow anything it throws, and return `fallback` instead. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.warn('[Environment] guarded call failed:', err);
    return fallback;
  }
}

/**
 * Let the browser paint between heavy build stages.
 *
 * Races the frame callback against a timer: `requestAnimationFrame` never fires
 * in a background tab, and a load that stalls forever because the player
 * switched tabs is not an acceptable failure mode.
 */
function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    setTimeout(finish, 24);
  });
}

/** Move a subsystem's group under Environment without losing world transform. */
function reparent(child: THREE.Object3D | undefined, parent: THREE.Object3D): void {
  if (!child || child.parent === parent) return;
  child.parent?.remove(child);
  parent.add(child);
}

function defaultWaterLevel(theme: WorldTheme): number {
  switch (theme) {
    case 'coastal': return -3.5;
    case 'volcano': return -14;
    case 'desert': return -400;
    case 'city': return -9;
    default: return -7;
  }
}

/**
 * Validate a `PropSurfaceHint`-ish object. Optional the whole way down: a track
 * that publishes nothing gets `undefined`, and `Props` then takes the authored
 * position exactly as given (the pre-existing behaviour). A track that publishes
 * a partial or nonsense hint must not be able to teleport a prop, so every field
 * has to arrive finite before any of it is trusted.
 */
function readSurfaceHint(raw: unknown): PropSurfaceHint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Partial<PropSurfaceHint>;
  if (!Number.isFinite(s.up) || !Number.isFinite(s.lat) || !Number.isFinite(s.corridor)) {
    return undefined;
  }
  return {
    up: clamp(s.up as number, -400, 400),
    lat: s.lat as number,
    corridor: Math.max(0, s.corridor as number),
    elevated: s.elevated === true,
  };
}

/** Validate a TrackSample-ish object into something we can trust. */
function readSample(raw: unknown): {
  position: THREE.Vector3; tangent: THREE.Vector3; normal: THREE.Vector3;
  binormal: THREE.Vector3; halfWidth: number; bank: number;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as SampleLike;
  const p = s.position;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;

  const tan = (s.tangent && Number.isFinite(s.tangent.x)) ? s.tangent : null;
  const nrm = (s.normal && Number.isFinite(s.normal.x)) ? s.normal : null;
  const bin = (s.binormal && Number.isFinite(s.binormal.x)) ? s.binormal : null;

  const tangent = tan ? tan.clone() : new THREE.Vector3(0, 0, -1);
  if (tangent.lengthSq() < 1e-6) tangent.set(0, 0, -1);
  tangent.normalize();

  const normal = nrm ? nrm.clone() : new THREE.Vector3(0, 1, 0);
  if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0);
  normal.normalize();

  const binormal = bin ? bin.clone() : new THREE.Vector3().crossVectors(tangent, normal);
  if (binormal.lengthSq() < 1e-6) binormal.set(1, 0, 0);
  binormal.normalize();

  const halfWidth = Number.isFinite(s.halfWidth) ? clamp(s.halfWidth as number, 4, 40) : 11;
  const bank = Number.isFinite(s.bank) ? clamp(s.bank as number, -1.2, 1.2) : 0;

  return { position: p.clone(), tangent, normal, binormal, halfWidth, bank };
}

function stationFrom(
  s: { position: THREE.Vector3; tangent: THREE.Vector3; binormal: THREE.Vector3; halfWidth: number; bank: number },
  arc: number,
): PathStation {
  // Flatten tangent/binormal into XZ: the field is a heightfield, so all the
  // world needs is the horizontal frame plus the cross-slope as a gradient.
  let tx = s.tangent.x, tz = s.tangent.z;
  let tl = Math.hypot(tx, tz);
  if (tl < 1e-5) { tx = 0; tz = -1; tl = 1; }
  tx /= tl; tz /= tl;

  let bx = s.binormal.x, bz = s.binormal.z;
  let bl = Math.hypot(bx, bz);
  if (bl < 1e-5) { bx = -tz; bz = tx; bl = 1; }
  bx /= bl; bz /= bl;

  return {
    px: s.position.x, py: s.position.y, pz: s.position.z,
    tx, tz, bx, bz,
    halfWidth: s.halfWidth,
    // Cross-slope of the road surface, as dy per unit of HORIZONTAL lateral
    // offset — which is exactly what `TerrainField.bake()` multiplies `cross` by.
    //
    // This was `Math.tan(s.bank)`, which was wrong twice over:
    //
    //  1. WRONG SIGN. The road mesh and the physics both take their cross-slope
    //     from the spline binormal, whose `y` is the NEGATIVE of `tan(bank)`.
    //     So the terrain banked *opposite* to the road it is meant to blend
    //     into. Measured on coastal, 20 of 26 sampled stations disagreed in
    //     sign; the only agreements were where bank was exactly 0. Inside the
    //     corridor, where the residual must be ~0, mean |terrain − road| was
    //     1.08 / 2.27 / 4.15 m on coastal / neon / volcano, peaking at 47 m.
    //     Props seated on the terrain therefore sank under the shoulder on one
    //     side of every banked corner and floated on the other.
    //  2. IGNORED GRADE. `bank` describes roll only, so a station with bank 0 on
    //     a climbing, turning section reported a flat cross-slope when the real
    //     surface was already tilted (coastal t=0.039: tan(bank) 0.0000 vs a
    //     true 0.0069).
    //
    // `bl` is the binormal's XZ length, computed above and deliberately read
    // here BEFORE bx/bz are normalised by it. Clamped as before so a near-
    // vertical binormal cannot produce a stamped cliff.
    tanBank: clamp(s.binormal.y / bl, -0.9, 0.9),
    s: arc,
  };
}

function spanOf(stations: PathStation[]): number {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of stations) {
    if (s.px < minX) minX = s.px; if (s.px > maxX) maxX = s.px;
    if (s.pz < minZ) minZ = s.pz; if (s.pz > maxZ) maxZ = s.pz;
  }
  return Math.max(maxX - minX, maxZ - minZ);
}

/** Rewrite `s` as true accumulated arc length (tracks lie about it sometimes). */
function resampleArcLength(stations: PathStation[]): void {
  let acc = 0;
  for (let i = 0; i < stations.length; i++) {
    stations[i].s = acc;
    const a = stations[i];
    const b = stations[(i + 1) % stations.length];
    acc += Math.hypot(b.px - a.px, b.pz - a.pz);
  }
}

/**
 * A believable closed circuit from radial harmonics: two long straights, a
 * hairpin, a couple of sweepers, gentle elevation change and banking derived
 * from curvature. Used when Track can't answer — and by the dev harness.
 */
export function demoCircuit(seed = 20260810): PathStation[] {
  const rng = new Rng(seed || 1);
  const R = 380;
  const harm: Array<[number, number, number]> = [
    [2, 0.20 + rng.next() * 0.07, rng.next() * 6.28],
    [3, 0.11 + rng.next() * 0.05, rng.next() * 6.28],
    [5, 0.055 + rng.next() * 0.03, rng.next() * 6.28],
    [7, 0.026, rng.next() * 6.28],
  ];
  const hills: Array<[number, number, number]> = [
    [1, 12, rng.next() * 6.28],
    [2, 7, rng.next() * 6.28],
    [4, 3.2, rng.next() * 6.28],
  ];

  const radius = (a: number): number => {
    let r = 1;
    for (const [k, amp, ph] of harm) r += Math.sin(a * k + ph) * amp;
    return R * clamp(r, 0.42, 1.7);
  };
  const height = (a: number): number => {
    let y = 0;
    for (const [k, amp, ph] of hills) y += Math.sin(a * k + ph) * amp;
    return y;
  };

  // Dense angular pre-pass, then resample to fixed arc-length spacing.
  const N = 3000;
  const px: number[] = [], py: number[] = [], pz: number[] = [], cum: number[] = [0];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = radius(a);
    px.push(Math.cos(a) * r);
    pz.push(Math.sin(a) * r);
    py.push(height(a));
    if (i > 0) {
      cum.push(cum[i - 1] + Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1], py[i] - py[i - 1]));
    }
  }
  const total = cum[N - 1] + Math.hypot(px[0] - px[N - 1], pz[0] - pz[N - 1]);

  const count = Math.max(64, Math.round(total / STATION_SPACING));
  const out: PathStation[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const want = (i / count) * total;
    while (cursor < N - 2 && cum[cursor + 1] < want) cursor++;
    const seg = Math.max(1e-5, cum[cursor + 1] - cum[cursor]);
    const f = clamp01((want - cum[cursor]) / seg);
    const j = cursor, k = cursor + 1;
    const x = px[j] + (px[k] - px[j]) * f;
    const z = pz[j] + (pz[k] - pz[j]) * f;
    const y = py[j] + (py[k] - py[j]) * f;
    out.push({ px: x, py: y, pz: z, tx: 0, tz: -1, bx: 1, bz: 0, halfWidth: 11, tanBank: 0, s: want });
  }

  // Frames + curvature-driven width and banking.
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const a = out[(i - 1 + n) % n];
    const b = out[i];
    const c = out[(i + 1) % n];
    let tx = c.px - a.px, tz = c.pz - a.pz;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    b.tx = tx; b.tz = tz;
    // binormal = up x tangent → driver's right for -Z forward
    b.bx = -tz; b.bz = tx;

    // Signed curvature from the turn between the two segments.
    const ax = b.px - a.px, az = b.pz - a.pz;
    const cx = c.px - b.px, cz = c.pz - b.pz;
    const cross = ax * cz - az * cx;
    const lenA = Math.hypot(ax, az) || 1;
    const lenC = Math.hypot(cx, cz) || 1;
    const curv = cross / (lenA * lenC * ((lenA + lenC) * 0.5));
    b.tanBank = clamp(-curv * 260, -0.42, 0.42);
    b.halfWidth = 11 + clamp(Math.abs(curv) * 900, 0, 4.5);
  }
  return out;
}
