/**
 * ============================================================================
 *  APEX KART — FOLIAGE
 * ============================================================================
 *  Grass  : three camera-following InstancedMesh rings (near/mid/far). Every
 *           blade reads its own ground height and validity from the terrain
 *           field in the vertex shader, so the carpet is effectively infinite
 *           at three draw calls with zero per-frame CPU work. Two-frequency
 *           sway plus travelling gusts, per-instance colour/height variation,
 *           and a radial push-away from the player.
 *  Trees  : six procedural species (tapered tube trunks with branch stubs and
 *           stylised faceted canopies — MK8 reads better and costs less than
 *           leaf cards). Two draw calls per species, GPU distance culling, and
 *           a cross-faded billboard imposter atlas rendered once at init.
 *  Shrubs : bushes, ferns, flowers, cattails and palms, all instanced and
 *           density-scaled by `quality.foliageDensity`.
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings } from '@/core/Types';
import { RENDER_ORDER } from '@/core/Config';
import { Rng, clamp01 } from '@/core/MathUtils';
import { SHADOW_LAYER } from './Lighting';
import {
  GLSL_FIELD, GLSL_FIELD_SHADOW_LOW, GLSL_NOISE,
  InstanceChunks, fieldUniforms, insideAuthoredWater, makeBark, roadVerge,
  type RoadVerge, type TerrainField, type WorldContext, type WorldTheme,
  worldFogUniforms,
} from './WorldTextures';

// ---------------------------------------------------------------------------
// ROAD CLEARANCE — the P0h fix
// ---------------------------------------------------------------------------
//
// Third report of the same defect: "when players drive close to the left or
// right edges, the visuals are similarly affected by off-track decorations or
// terrain". Measured from the real chase pose with the eye hard against the
// drivable edge (`.probe-tmp/edgeview.ts`), geometry inside 30 m filled 10x to
// 90x more of the LOWER THIRD of frame at the edge than on the centreline —
// 0.2 % centre vs 18.3 % left edge on Boston. The defect is invisible from the
// middle of the road, which is why two earlier rounds of probes missed it.
//
// The placement bug on this side of it: every scatter here rejected against
// `field.roadDistanceAt(x,z) < minDist * 0.85`. That is distance to the
// CENTRELINE with no `halfWidth` term at all, so on a 12.5 m half-width station
// the flower scatter (`minDist` 12) admitted anything past 10.2 m — 2.3 m INSIDE
// the drivable road. Measured intruders before the fix: Flowers 3.73 m inside on
// coastal, Fern 2.30 m, Cattails 1.72 m, Bush 1.13 m, tree0 1.14 m.
//
// And the trunk point was the only thing tested, never the CANOPY. A birch
// canopy is up to 11 m across, so a trunk admitted at the edge overhangs the
// tarmac by metres — `Foliage/tree2#57` reached 0.20 m inside at 6.5 m up on
// Boston. Exactly the grandstand bug `standClearsRoad` was written for: testing
// the anchor while the recipe builds something much wider than its anchor.

/** Metres of clear verge every piece of foliage GEOMETRY must leave past the kerb. */
const FOLIAGE_VERGE = 1.2;
/** Kerb width outside the asphalt edge (`CROSS.kerbW`). */
const KERB_W = 1.55;
/**
 * How far outboard a spot may be walked to earn its clearance before it is
 * dropped instead. Moving is strongly preferred to deleting: the owner's
 * constraint on this fix was "optimized with strict caution, while also
 * maintaining aesthetic appeal", and a circuit that loses its planting is a
 * worse outcome than one with a bush slightly further from the kerb.
 */
const PUSH_LIMIT = 14;

// ---------------------------------------------------------------------------
// Shared wind GLSL
// ---------------------------------------------------------------------------

const GLSL_WIND = /* glsl */ `
uniform float uTime;
uniform vec2  uWindDir;
uniform float uWindStrength;
uniform vec3  uPlayerPos;

/** Two frequencies + a travelling gust front. bendable = 0 root, 1 tip. */
vec3 windOffset(vec3 wp, float phase, float bendable){
  float t = uTime;
  vec2 d = uWindDir;
  float wave = dot(wp.xz, d) * 0.11;
  float a = sin(t * 1.9 + wave + phase) * 0.55
          + sin(t * 4.7 + wave * 2.3 + phase * 1.7) * 0.22;
  // Gust front sweeping downwind, ~26 m wavelength.
  float gust = smoothstep(0.35, 1.0, sin(t * 0.55 + dot(wp.xz, d) * 0.038 + phase * 0.2));
  a *= 1.0 + gust * 1.55;
  float amt = a * uWindStrength * bendable;
  return vec3(d.x * amt, -abs(amt) * 0.22, d.y * amt);
}

/** Push blades away from a nearby kart. */
vec3 pushAway(vec3 wp, float bendable){
  vec3 delta = wp - uPlayerPos;
  delta.y = 0.0;
  float dist = length(delta);
  float f = 1.0 - smoothstep(0.6, 3.4, dist);
  if (f <= 0.0) return vec3(0.0);
  vec3 dir = dist > 1e-3 ? delta / dist : vec3(1.0, 0.0, 0.0);
  return dir * f * bendable * 0.62 - vec3(0.0, f * bendable * 0.28, 0.0);
}
`;

// ---------------------------------------------------------------------------

interface GrassRing {
  mesh: THREE.InstancedMesh;
  radius: number;
  /** cell size the mesh snaps to, metres */
  snap: number;
  chunks: RingChunks;
}

/**
 * Radial band boundaries as a fraction of the ring radius, and how many azimuth
 * sectors each band is cut into. Only the innermost band is left whole: it is the
 * one that wraps the camera, and any bucket containing the camera position is
 * inside every frustum by definition, so splitting it would buy nothing. It is
 * deliberately tiny — 8 % of the radius is 0.6 % of the area.
 *
 * Pushed much finer than the Terrain/Water sector counts on purpose, because the
 * economics are the opposite way round: a ring repacks its instance buffer, so it
 * is ONE draw call at every setting and the only cost of another bucket is one
 * box-vs-frustum test. `.probe-tmp/g5.ts` measured, over 24 poses round the lap
 * (19 000 blades on neon):
 *
 *      buckets   submitted blades
 *            2       19 000  100 %   <- two uncullable rings, today
 *           50       12 156   64 %
 *           74       11 092   58 %
 *          154       10 206   54 %   <- this config
 *          218        9 882   52 %
 *
 * It flattens out at ~52 %, which is roughly the fraction of a 360° ring a 97°
 * horizontal frustum plus the slack in an axis-aligned box can ever reach.
 */
const RING_BANDS: readonly number[] = [0, 0.08, 0.22, 0.42, 0.68, 1.0];
const RING_SECTORS: readonly number[] = [1, 16, 20, 20, 20];

interface TreeSpecies {
  name: string;
  trunk: THREE.InstancedMesh;
  canopy: THREE.InstancedMesh;
  imposter: THREE.InstancedMesh | null;
  count: number;
}

type ScatterKind = 'tree' | 'bush' | 'fern' | 'flower' | 'cattail' | 'palm' | 'deadtree' | 'cactus';

interface ThemeFoliage {
  grassDensity: number;
  grassHeight: number;
  grassColorA: number;
  grassColorB: number;
  /** species mix — indices into the built species list, with weights */
  treeMix: Array<[ScatterKind, number]>;
  treeDensity: number;
  bushDensity: number;
  flowerDensity: number;
}

const THEME_FOLIAGE: Record<WorldTheme, ThemeFoliage> = {
  meadow: {
    grassDensity: 1.0, grassHeight: 1.0, grassColorA: 0x4e7a2c, grassColorB: 0x8fae4a,
    treeMix: [['tree', 1]], treeDensity: 1.0, bushDensity: 1.0, flowerDensity: 1.0,
  },
  coastal: {
    grassDensity: 0.72, grassHeight: 0.85, grassColorA: 0x5c7f3a, grassColorB: 0x9cb45c,
    treeMix: [['palm', 0.62], ['tree', 0.38]], treeDensity: 0.7, bushDensity: 0.8, flowerDensity: 0.5,
  },
  city: {
    grassDensity: 0.5, grassHeight: 0.7, grassColorA: 0x3f6b30, grassColorB: 0x7ea04a,
    treeMix: [['tree', 1]], treeDensity: 0.55, bushDensity: 0.9, flowerDensity: 0.45,
  },
  volcano: {
    grassDensity: 0.14, grassHeight: 0.7, grassColorA: 0x4a3f26, grassColorB: 0x6d5b34,
    treeMix: [['deadtree', 1]], treeDensity: 0.42, bushDensity: 0.25, flowerDensity: 0.05,
  },
  desert: {
    grassDensity: 0.22, grassHeight: 0.8, grassColorA: 0x7d7440, grassColorB: 0xb3a457,
    treeMix: [['cactus', 0.7], ['deadtree', 0.3]], treeDensity: 0.35, bushDensity: 0.4, flowerDensity: 0.15,
  },
  snow: {
    grassDensity: 0.2, grassHeight: 0.6, grassColorA: 0x6a7a5c, grassColorB: 0x93a37c,
    treeMix: [['tree', 1]], treeDensity: 0.75, bushDensity: 0.35, flowerDensity: 0.05,
  },
};

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _nrm = new THREE.Vector3();
const _col = new THREE.Color();

/** Trees are the tallest thing in the scenery — they stay visible a long way. */
const TREE_CULL = 420;

/** Wind sway + the kart's push-away can move a blade this far off its anchor. */
const BLADE_SLACK = 2;

const _ringFrustum = new THREE.Frustum();
const _ringProj = new THREE.Matrix4();
const _ringBox = new THREE.Box3();

/**
 * Per-frame visible-set culling for one camera-relative instanced grass ring.
 *
 * `InstanceChunks` (WorldTextures) cannot do this job, which is why this exists
 * rather than reusing it: that class buckets instances by the translation in
 * their `instanceMatrix`, and a grass ring's instance matrices are ALL identity —
 * every blade's offset lives in the `aBlade` attribute, in a frame that slides
 * with the camera every frame. So the buckets have to be camera-relative and the
 * repack has to carry `aBlade`, not the matrices.
 *
 * The mechanism is deliberately the same shape as `InstanceChunks`: source arrays
 * pre-sorted into bucket order at build time, one pre-made view per bucket so the
 * per-frame repack allocates nothing, a hash of the live set to skip the repack
 * and the upload when nothing crossed a boundary. Two mechanisms that behave
 * alike are easier to reason about than two that differ.
 *
 * ⚠️ Same gotcha as `InstanceChunks`: after this runs, `mesh.count` is "instances
 * submitted this frame", NOT "instances in the ring". Use `total` for that.
 *
 * Buckets are tested as boxes, not spheres, and their Y span is the terrain
 * field's whole height range. That is on purpose: a blade's world Y comes from
 * `fieldHeight()` in the vertex shader, so the CPU does not know it without
 * re-sampling the field under a footprint that moves every frame. Over-tall
 * bounds only ever keep a bucket that could have been dropped; too-short bounds
 * would erase grass the player is looking at. The azimuth is what does the
 * culling anyway — a sector behind you is behind you at every height.
 */
class RingChunks {
  readonly total: number;

  private mesh: THREE.InstancedMesh;
  private blade: THREE.InstancedBufferAttribute;
  private colour: THREE.InstancedBufferAttribute | null;
  private srcBlade: Float32Array;
  private srcColour: Float32Array | null;
  private viewBlade: Float32Array[] = [];
  private viewColour: Float32Array[] = [];
  private counts: Int32Array;
  private x0: Float32Array;
  private x1: Float32Array;
  private z0: Float32Array;
  private z1: Float32Array;
  private live: Int32Array;
  private buckets: number;
  private yMin: number;
  private yMax: number;
  private signature = -1;
  private drawn: number;

  constructor(
    mesh: THREE.InstancedMesh,
    blade: THREE.InstancedBufferAttribute,
    radius: number,
    yMin: number,
    yMax: number,
  ) {
    this.mesh = mesh;
    this.blade = blade;
    this.colour = mesh.instanceColor ?? null;
    this.yMin = yMin;
    this.yMax = yMax;

    const n = mesh.count;
    this.total = n;
    this.drawn = n;

    const bandBase: number[] = [];
    let buckets = 0;
    for (let b = 0; b < RING_SECTORS.length; b++) {
      bandBase.push(buckets);
      buckets += Math.max(1, RING_SECTORS[b]);
    }
    this.buckets = buckets;
    this.counts = new Int32Array(buckets);
    this.live = new Int32Array(buckets);
    this.x0 = new Float32Array(buckets).fill(Infinity);
    this.x1 = new Float32Array(buckets).fill(-Infinity);
    this.z0 = new Float32Array(buckets).fill(Infinity);
    this.z1 = new Float32Array(buckets).fill(-Infinity);

    // --- assign every blade to a bucket, and grow that bucket's footprint -----
    const src = blade.array as Float32Array;
    const owner = new Int32Array(n);
    const TAU = Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const x = src[i * 4];
      const z = src[i * 4 + 1];
      const r = Math.sqrt(x * x + z * z) / Math.max(1e-3, radius);
      let band = RING_SECTORS.length - 1;
      for (let b = 0; b < RING_SECTORS.length; b++) {
        if (r < (RING_BANDS[b + 1] ?? Infinity)) { band = b; break; }
      }
      const s = Math.max(1, RING_SECTORS[band]);
      let sec = 0;
      if (s > 1) {
        sec = Math.floor(((Math.atan2(z, x) + Math.PI) / TAU) * s);
        if (sec < 0) sec = 0; else if (sec >= s) sec = s - 1;
      }
      const id = bandBase[band] + sec;
      owner[i] = id;
      this.counts[id]++;
      if (x < this.x0[id]) this.x0[id] = x;
      if (x > this.x1[id]) this.x1[id] = x;
      if (z < this.z0[id]) this.z0[id] = z;
      if (z > this.z1[id]) this.z1[id] = z;
    }
    for (let c = 0; c < buckets; c++) {
      if (!this.counts[c]) { this.x0[c] = this.x1[c] = this.z0[c] = this.z1[c] = 0; continue; }
      this.x0[c] -= BLADE_SLACK; this.x1[c] += BLADE_SLACK;
      this.z0[c] -= BLADE_SLACK; this.z1[c] += BLADE_SLACK;
    }

    // --- sort the source arrays into bucket order ----------------------------
    const starts = new Int32Array(buckets);
    let acc = 0;
    for (let c = 0; c < buckets; c++) { starts[c] = acc; acc += this.counts[c]; }
    this.srcBlade = new Float32Array(n * 4);
    const rawColour = this.colour ? this.colour.array as Float32Array : null;
    this.srcColour = rawColour ? new Float32Array(n * 3) : null;
    const cursor = new Int32Array(buckets);
    for (let i = 0; i < n; i++) {
      const c = owner[i];
      const slot = starts[c] + cursor[c]++;
      for (let k = 0; k < 4; k++) this.srcBlade[slot * 4 + k] = src[i * 4 + k];
      if (rawColour && this.srcColour) {
        for (let k = 0; k < 3; k++) this.srcColour[slot * 3 + k] = rawColour[i * 3 + k];
      }
    }
    for (let c = 0; c < buckets; c++) {
      const s = starts[c], e = s + this.counts[c];
      this.viewBlade.push(this.srcBlade.subarray(s * 4, e * 4));
      this.viewColour.push(
        this.srcColour ? this.srcColour.subarray(s * 3, e * 3) : new Float32Array(0),
      );
    }

    // Start with the whole ring live, so a ring whose camera never arrives still
    // draws every blade rather than none.
    src.set(this.srcBlade);
    blade.needsUpdate = true;
    if (rawColour && this.srcColour) {
      rawColour.set(this.srcColour);
      if (this.colour) this.colour.needsUpdate = true;
    }
    mesh.count = n;
  }

  get drawnInstances(): number { return this.drawn; }
  get bucketCount(): number { return this.buckets; }

  /**
   * Repack against `frustum`, with the ring's mesh sitting at (px, pz). Call once
   * per frame from `update()` — never from a draw callback, which fires after
   * three has already decided what to cull.
   */
  cullTo(frustum: THREE.Frustum, px: number, pz: number): void {
    let sig = 17;
    let live = 0;
    for (let c = 0; c < this.buckets; c++) {
      if (!this.counts[c]) continue;
      _ringBox.min.set(this.x0[c] + px, this.yMin, this.z0[c] + pz);
      _ringBox.max.set(this.x1[c] + px, this.yMax, this.z1[c] + pz);
      if (!frustum.intersectsBox(_ringBox)) continue;
      this.live[live++] = c;
      sig = (sig * 31 + c + 1) | 0;
    }
    if (sig === this.signature) return;
    this.signature = sig;

    const bd = this.blade.array as Float32Array;
    const cl = this.colour ? this.colour.array as Float32Array : null;
    let w = 0;
    for (let i = 0; i < live; i++) {
      const c = this.live[i];
      bd.set(this.viewBlade[c], w * 4);
      if (cl) cl.set(this.viewColour[c], w * 3);
      w += this.counts[c];
    }
    this.drawn = w;
    this.mesh.count = w;
    if (w > 0) {
      this.blade.needsUpdate = true;
      if (this.colour) this.colour.needsUpdate = true;
    }
  }
}

export class Foliage implements ISubsystem {
  readonly group = new THREE.Group();
  /** Written by Environment each frame so grass can bend away from the kart. */
  readonly playerPosition = new THREE.Vector3(0, -999, 0);

  private scene: THREE.Scene;
  private ctx: WorldContext;
  private quality: QualitySettings;
  private field: TerrainField;
  private theme: ThemeFoliage;

  private rings: GrassRing[] = [];
  private species: TreeSpecies[] = [];
  private scatterMeshes: THREE.InstancedMesh[] = [];
  /** Per-chunk visible-set culling for everything that isn't camera-relative. */
  private chunked: InstanceChunks[] = [];
  /**
   * Ring culling is armed by the first `update()`, never at build time. Three
   * culls in `projectObject`, before any `onBeforeRender`, so a ring is tested
   * against wherever it was last placed. If culling were live from frame zero and
   * `update()` never ran, an unplaced ring at the world origin would be culled,
   * its draw callback would never fire to move it, and the grass would be
   * permanently invisible. Latching means the worst case is exactly today's
   * behaviour: uncullable but correct.
   */
  private culling = false;

  private uTime = { value: 0 };
  private uWindDir = { value: new THREE.Vector2(0.82, 0.57) };
  private uWindStrength = { value: 0.22 };
  private uPlayerPos = { value: this.playerPosition };

  private disposables: Array<{ dispose(): void }> = [];
  private bark: { map: THREE.DataTexture; normalMap: THREE.DataTexture } | null = null;
  camera: THREE.PerspectiveCamera | null = null;

  constructor(
    scene: THREE.Scene,
    _renderer: THREE.WebGLRenderer,
    ctx: WorldContext,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.ctx = ctx;
    this.quality = quality;
    this.field = ctx.field;
    this.theme = THEME_FOLIAGE[ctx.theme] ?? THEME_FOLIAGE.meadow;
  }

  async init(): Promise<void> {
    this.group.name = 'Foliage';
    this.scene.add(this.group);
    this.bark = makeBark(this.quality.tier === 'low' ? 128 : 256);
    this.disposables.push(this.bark.map, this.bark.normalMap);

    this.buildGrass();
    this.buildTrees();
    this.buildScatter();
  }

  // =========================================================================
  // GRASS
  // =========================================================================

  private bladeGeometry(segments: number): THREE.BufferGeometry {
    // A tapered strip: 2 verts per row, last row a single tip.
    const rows = segments;
    const verts: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const halfW = 0.5 * (1 - t * t * 0.92);
      if (r === rows - 1) {
        verts.push(0, t, 0);
        uvs.push(0.5, t);
      } else {
        verts.push(-halfW, t, 0, halfW, t, 0);
        uvs.push(0, t, 1, t);
      }
    }
    for (let r = 0; r < rows - 2; r++) {
      const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const lastPair = (rows - 2) * 2;
    idx.push(lastPair, lastPair + 2, lastPair + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  private grassMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0,
      side: THREE.DoubleSide,
      // MUST STAY FALSE. Blade colour arrives per *instance* via
      // `mesh.instanceColor` (see `buildGrass`), never per vertex —
      // `bladeGeometry()` sets only position/uv/index and has no `color`
      // attribute. `vertexColors: true` made three define USE_COLOR in the
      // vertex prefix, which emits `attribute vec3 color; … vColor.rgb *= color;`
      // against an attribute nothing is bound to, so the generic-attribute
      // default (0,0,0,1) zeroed vColor before instanceColor could multiply it
      // and all 27 360 blades rendered pure black. (MeshStandardMaterial has no
      // `defaultAttributeValues`, unlike ShaderMaterial, so there is no white
      // fallback to save it.)
      //
      // Per-instance colour is unaffected: three derives USE_INSTANCING_COLOR
      // from `object.instanceColor !== null` alone (WebGLPrograms.js), and the
      // *fragment* prefix defines USE_COLOR from `vertexColors || instancingColor`
      // — so `vColor` is still declared and `diffuseColor *= vColor` still runs.
      // Verified against three@0.185.1.
      vertexColors: false,
      fog: true,
      dithering: true,
    });
    mat.name = 'GrassBlade';
    mat.customProgramCacheKey = () => 'apex-grass';

    const fu = fieldUniforms(this.field);
    const u: Record<string, THREE.IUniform> = {
      uFieldHeight: fu.uFieldHeight,
      uFieldData: fu.uFieldData,
      uFieldXform: fu.uFieldXform,
      uSunDirection: worldFogUniforms.uSunDirection,
      uTime: this.uTime,
      uWindDir: this.uWindDir,
      uWindStrength: this.uWindStrength,
      uPlayerPos: this.uPlayerPos,
      // Per-ring; `buildGrass` overwrites this with the ring's own fade band.
      // It used to be left at 60→90 for every ring, which is why grass was still
      // being drawn at a third of full height 150 m out.
      uFade: { value: new THREE.Vector2(60, 90) },
      uHeightScale: { value: this.theme.grassHeight },
      uDensityCut: { value: 0.0 },
      uWaterLevel: { value: this.ctx.waterLevel },
    };
    (mat.userData as { fade?: THREE.IUniform }).fade = u.uFade;

    mat.onBeforeCompile = (shader) => {
      for (const k in u) shader.uniforms[k] = u[k];
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
#include <common>
${GLSL_FIELD}
${GLSL_NOISE}
${GLSL_WIND}
uniform vec2 uFade;
uniform float uHeightScale;
uniform float uDensityCut;
uniform float uWaterLevel;
attribute vec4 aBlade;   // x,z local offset · y rotation · w random
varying vec3 vGrassWorld;
varying float vTip;
varying float vDry;
`)
        .replace('#include <begin_vertex>', /* glsl */ `
#include <begin_vertex>
vec3 anchor = ( modelMatrix * vec4( aBlade.x, 0.0, aBlade.y, 1.0 ) ).xyz;
float gh = fieldHeight( anchor.xz );
anchor.y = gh;
vec4 fd = fieldData( anchor.xz );

float rnd = aBlade.w;
float rnd2 = fract( rnd * 37.13 );
// Density: no grass on the road, less on rock, more where it is damp.
float density = ( 1.0 - fd.r ) * ( 1.0 - fd.a * 0.85 ) * ( 0.25 + fd.b * 1.15 );
// Slope from two forward differences reusing gh, rather than fieldNormal's four
// extra taps. This runs on every blade vertex; two texture fetches saved here is
// half a million fetches a frame.
float e = uFieldXform.w;
float sx = fieldHeight( anchor.xz + vec2( e, 0.0 ) ) - gh;
float sz = fieldHeight( anchor.xz + vec2( 0.0, e ) ) - gh;
float slope = 1.0 - e / sqrt( sx * sx + sz * sz + e * e );
density *= 1.0 - smoothstep( 0.18, 0.42, slope );
density *= step( uWaterLevel + 0.15, gh );
float alive = step( uDensityCut + rnd * 0.92, density );

float camDist = length( anchor - cameraPosition );
// Hard fade to nothing at the ring edge. The old form bottomed out at 0.35 of
// full height, so every ring kept drawing full-triangle blades all the way to
// its scatter radius no matter how far away that was.
float fade = 1.0 - smoothstep( uFade.x, uFade.y, camDist );
float h = ( 0.20 + rnd * 0.30 ) * uHeightScale * alive * fade;
float w = ( 0.020 + rnd2 * 0.020 ) * ( 1.0 + ( 1.0 - fade ) * 2.2 );

float ca = cos( aBlade.z ), sa = sin( aBlade.z );
vec3 local = vec3( position.x * w, position.y * h, position.z * w );
local = vec3( local.x * ca - local.z * sa, local.y, local.x * sa + local.z * ca );

float bend = position.y * position.y;
vec3 wp = anchor + local;
wp += windOffset( anchor, rnd * 6.28, bend * h * 3.4 );
wp += pushAway( anchor, bend );
// A permanent lean so the field never looks like a bed of nails.
wp.x += ( rnd - 0.5 ) * bend * h * 0.5;
wp.z += ( rnd2 - 0.5 ) * bend * h * 0.5;

// The ring's model matrix is a pure translation (it only ever tracks the camera
// on XZ), so the inverse is a subtraction. This line used to call inverse() on
// the mat4 for every grass vertex — a quarter of a million inversions a frame.
transformed = wp - vec3( modelMatrix[ 3 ][ 0 ], modelMatrix[ 3 ][ 1 ], modelMatrix[ 3 ][ 2 ] );
vGrassWorld = wp;
vTip = position.y;
vDry = fd.b;
`)
        .replace('#include <beginnormal_vertex>', /* glsl */ `
#include <beginnormal_vertex>
objectNormal = normalize( vec3( objectNormal.x, 0.55, objectNormal.z ) );
`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `
#include <common>
${GLSL_FIELD}
${GLSL_FIELD_SHADOW_LOW}
uniform vec3 uSunDirection;
varying vec3 vGrassWorld;
varying float vTip;
varying float vDry;
`)
        .replace('#include <map_fragment>', /* glsl */ `
// Ambient occlusion down the blade: roots dark, tips bright and translucent.
float ao = 0.30 + 0.70 * vTip * vTip;
diffuseColor.rgb *= ao;
diffuseColor.rgb *= mix( vec3( 1.02, 0.94, 0.80 ), vec3( 0.92, 1.04, 0.90 ), vDry );
`)
        .replace('#include <lights_fragment_begin>', /* glsl */ `
float terrainSun = fieldShadow( vGrassWorld + vec3( 0.0, 0.25, 0.0 ), uSunDirection );
// lights_pars_begin already gave this a 1.0 fallback; take it over.
#undef CSM_EXTRA_SHADOW
#define CSM_EXTRA_SHADOW terrainSun
#include <lights_fragment_begin>
`)
        // Cheap translucency: light coming through the blade from behind.
        .replace('#include <lights_fragment_end>', /* glsl */ `
#include <lights_fragment_end>
float trans = pow( clamp( dot( normalize( vGrassWorld - cameraPosition ), uSunDirection ), 0.0, 1.0 ), 3.0 );
reflectedLight.indirectDiffuse += diffuseColor.rgb * trans * vTip * 0.85 * terrainSun;
`);
    };
    return mat;
  }

  private buildGrass(): void {
    const dens = this.quality.foliageDensity * this.theme.grassDensity;
    if (dens <= 0.02) return;

    // Two rings, and nothing past ~58 m. The old third ring scattered 15 000
    // blades over a 150 m disc — 0.2 blades/m², which is invisible as grass but
    // costs 45 000 triangles and a full vertex shader (six texture fetches each)
    // every frame. Ground colour past the second ring is the terrain splat's job.
    const specs: Array<{ radius: number; count: number; seg: number; fade: [number, number] }> = [
      { radius: 25, count: Math.round(20000 * dens), seg: 5, fade: [18, 25] },
      { radius: 58, count: Math.round(18000 * dens), seg: 3, fade: [45, 58] },
    ];

    const rng = new Rng((this.ctx.hints.terrainSeed ^ 0x671a55) >>> 0 || 91771);
    let inner = 0;
    for (let s = 0; s < specs.length; s++) {
      const spec = specs[s];
      if (spec.count < 32) continue;
      const geo = this.bladeGeometry(spec.seg);
      const mat = this.grassMaterial();
      const mesh = new THREE.InstancedMesh(geo, mat, spec.count);
      mesh.name = `GrassRing${s}`;
      // Armed by `update()` once the ring has been positioned; see `culling`.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Declares intent for Lighting's cascade masks: if grass shadows are ever
      // switched on they belong in the near cascade and nowhere else.
      mesh.layers.enable(SHADOW_LAYER.NEAR_ONLY);
      mesh.renderOrder = RENDER_ORDER.PROPS - 2;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      // Instance transform is identity — the blade shader builds its own world
      // position from aBlade, which keeps the whole ring one static buffer.
      _m4.identity();
      for (let i = 0; i < spec.count; i++) mesh.setMatrixAt(i, _m4);

      // Poisson-ish annulus scatter: sqrt distribution for even area density.
      const data = new Float32Array(spec.count * 4);
      const colA = new THREE.Color(this.theme.grassColorA);
      const colB = new THREE.Color(this.theme.grassColorB);
      const colors = new Float32Array(spec.count * 3);
      for (let i = 0; i < spec.count; i++) {
        const a = rng.next() * Math.PI * 2;
        const r = Math.sqrt(inner * inner / (spec.radius * spec.radius) + rng.next() *
          (1 - inner * inner / (spec.radius * spec.radius))) * spec.radius;
        data[i * 4] = Math.cos(a) * r;
        data[i * 4 + 1] = Math.sin(a) * r;
        data[i * 4 + 2] = rng.next() * Math.PI;
        data[i * 4 + 3] = rng.next();
        _col.copy(colA).lerp(colB, rng.next() * rng.next());
        _col.offsetHSL((rng.next() - 0.5) * 0.045, (rng.next() - 0.5) * 0.16, (rng.next() - 0.5) * 0.09);
        colors[i * 3] = _col.r; colors[i * 3 + 1] = _col.g; colors[i * 3 + 2] = _col.b;
      }
      const bladeAttr = new THREE.InstancedBufferAttribute(data, 4);
      geo.setAttribute('aBlade', bladeAttr);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      mesh.instanceColor.needsUpdate = true;

      // Correct bounds for the ring as a whole, so `frustumCulled` can be true
      // instead of switched off. Three would otherwise derive the sphere from the
      // instance matrices, which are all identity — a 0.7 m sphere at the mesh
      // origin for a 58 m carpet — and the grass would vanish the moment the
      // camera looked away from that point. Y spans the field's whole height range
      // because that is where `fieldHeight()` can put a blade. Centred on the
      // camera as it is, this sphere always intersects; the saving comes from the
      // per-bucket instance cull below, and this just stops the mesh lying about
      // where it is.
      mesh.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(0, (this.field.minHeight + this.field.maxHeight) * 0.5, 0),
        Math.hypot(
          spec.radius + BLADE_SLACK,
          (this.field.maxHeight - this.field.minHeight) * 0.5 + BLADE_SLACK,
        ),
      );

      // Wire the ring's own fade band. (Previously computed and thrown away.)
      const fadeU = (mat.userData as { fade?: THREE.IUniform<THREE.Vector2> }).fade;
      if (fadeU) fadeU.value.set(spec.fade[0], spec.fade[1]);

      // Backstop only. `update()` places the ring ahead of every pass, because
      // three frustum-tests in `projectObject` — before any draw callback — so a
      // ring that only positions itself from here is culled against, and repacked
      // for, wherever the camera was last pass.
      mesh.onBeforeRender = (_r, _s, cam) => {
        const pc = cam as THREE.PerspectiveCamera;
        if (!pc.isPerspectiveCamera) return;
        if (!pc.userData.apxReflectionCam) this.camera = pc;
        this.placeRing(mesh, pc.position.x, pc.position.z);
      };

      this.group.add(mesh);
      this.rings.push({
        mesh,
        radius: spec.radius,
        snap: 1,
        chunks: new RingChunks(
          mesh, bladeAttr, spec.radius,
          this.field.minHeight - 1, this.field.maxHeight + BLADE_SLACK,
        ),
      });
      inner = spec.radius * 0.92;
    }
  }

  /** Snap a ring under the camera. One place, so cull and draw always agree. */
  private placeRing(mesh: THREE.InstancedMesh, camX: number, camZ: number): void {
    const x = Math.round(camX);
    const z = Math.round(camZ);
    if (mesh.position.x === x && mesh.position.z === z) return;
    mesh.position.set(x, 0, z);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
  }

  // =========================================================================
  // TREES
  // =========================================================================

  /** Tapered tube trunk with a slight sway curve and a few branch stubs. */
  private trunkGeometry(
    height: number, baseR: number, topR: number, lean: number, rng: Rng, branches: number,
  ): THREE.BufferGeometry {
    const segs = 8;
    const rings = 6;
    const parts: THREE.BufferGeometry[] = [];
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const curve = rng.range(-0.14, 0.14);
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const y = t * height;
      const rad = baseR + (topR - baseR) * Math.pow(t, 0.72);
      const ox = Math.sin(t * 1.8) * curve * height * 0.14 + lean * t * t * height * 0.1;
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const flute = 1 + Math.sin(a * 3 + t * 2) * 0.07;
        pos.push(ox + ca * rad * flute, y, sa * rad * flute);
        nor.push(ca, 0.12, sa);
        uv.push(s / segs * 2, t * height * 0.42);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const a = r * (segs + 1) + s;
        const b = a + 1;
        const c = a + segs + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const trunk = new THREE.BufferGeometry();
    trunk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    trunk.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    trunk.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    trunk.setIndex(idx);
    trunk.computeVertexNormals();
    parts.push(trunk);

    for (let b = 0; b < branches; b++) {
      const t = rng.range(0.45, 0.9);
      const len = height * rng.range(0.14, 0.3);
      const br = new THREE.CylinderGeometry(topR * 0.30, topR * 0.55, len, 5, 1, false);
      br.translate(0, len * 0.5, 0);
      const yaw = rng.range(0, Math.PI * 2);
      const pitch = rng.range(0.55, 1.15);
      br.rotateX(pitch);
      br.rotateY(yaw);
      br.translate(0, t * height, 0);
      parts.push(br);
    }
    const merged = mergeGeometries(parts);
    for (const p of parts) if (p !== merged) p.dispose();
    return merged;
  }

  /**
   * Faceted low-poly canopy: several overlapping irregular icospheres.
   * Vertex colour bakes light-from-above plus AO, which is most of why MK8
   * trees read so cleanly at speed.
   */
  private canopyGeometry(
    blobs: number, radius: number, height: number, spread: number,
    colTop: number, colBot: number, rng: Rng, squash = 0.85, detail = 1,
  ): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < blobs; i++) {
      const r = radius * rng.range(0.62, 1.0);
      const g = new THREE.IcosahedronGeometry(r, detail);
      // Irregularise so the silhouette isn't a row of balls.
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < p.count; v++) {
        const k = 1 + (rng.next() - 0.5) * 0.34;
        p.setXYZ(v, p.getX(v) * k, p.getY(v) * k * squash, p.getZ(v) * k);
      }
      const a = (i / Math.max(1, blobs)) * Math.PI * 2 + rng.range(-0.5, 0.5);
      const rr = i === 0 ? 0 : spread * rng.range(0.35, 1.0);
      g.translate(
        Math.cos(a) * rr,
        height + (i === 0 ? radius * 0.25 : rng.range(-0.35, 0.55) * radius),
        Math.sin(a) * rr,
      );
      parts.push(g);
    }
    const merged = mergeGeometries(parts);
    for (const p of parts) if (p !== merged) p.dispose();
    merged.computeVertexNormals();

    // Bake vertical gradient + normal-facing light into vertex colour.
    const p = merged.attributes.position as THREE.BufferAttribute;
    const n = merged.attributes.normal as THREE.BufferAttribute;
    const colors = new Float32Array(p.count * 3);
    let lo = Infinity, hi = -Infinity;
    for (let v = 0; v < p.count; v++) {
      const y = p.getY(v);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    const top = new THREE.Color(colTop);
    const bot = new THREE.Color(colBot);
    for (let v = 0; v < p.count; v++) {
      const t = (p.getY(v) - lo) / Math.max(0.001, hi - lo);
      const up = clamp01(n.getY(v) * 0.5 + 0.5);
      _col.copy(bot).lerp(top, Math.pow(t, 0.85) * 0.75 + up * 0.35);
      _col.offsetHSL(0, 0, (Math.random() - 0.5) * 0.05);
      colors[v * 3] = _col.r; colors[v * 3 + 1] = _col.g; colors[v * 3 + 2] = _col.b;
    }
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return merged;
  }

  private palmGeometry(rng: Rng): { trunk: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
    const h = rng.range(6.5, 11);
    const trunk = this.trunkGeometry(h, 0.20, 0.13, rng.range(0.2, 0.7), rng, 0);
    const fronds: THREE.BufferGeometry[] = [];
    const count = 9;
    for (let i = 0; i < count; i++) {
      const len = rng.range(2.2, 3.4);
      const segs = 5;
      const pos: number[] = [];
      const idx: number[] = [];
      const colr: number[] = [];
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const droop = -t * t * len * 0.72;
        const w = 0.34 * (1 - t * 0.85) * (t < 0.12 ? t / 0.12 : 1);
        pos.push(-w, droop, t * len, w, droop, t * len);
        const shade = 0.6 + 0.4 * (1 - t);
        colr.push(0.24 * shade, 0.46 * shade, 0.17 * shade);
        colr.push(0.3 * shade, 0.55 * shade, 0.2 * shade);
      }
      for (let s = 0; s < segs; s++) {
        const a = s * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.rotateX(rng.range(-0.42, -0.05));
      g.rotateY((i / count) * Math.PI * 2 + rng.range(-0.2, 0.2));
      g.translate(0, h - 0.15, 0);
      fronds.push(g);
    }
    const canopy = mergeGeometries(fronds);
    for (const f of fronds) if (f !== canopy) f.dispose();
    return { trunk, canopy };
  }

  private cactusGeometry(rng: Rng): { trunk: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
    const parts: THREE.BufferGeometry[] = [];
    const h = rng.range(2.6, 4.6);
    const body = new THREE.CapsuleGeometry(0.42, h, 6, 10);
    body.translate(0, h * 0.5 + 0.42, 0);
    parts.push(body);
    const arms = rng.int(1, 3);
    for (let a = 0; a < arms; a++) {
      const al = rng.range(0.9, 1.7);
      const arm = new THREE.CapsuleGeometry(0.24, al, 5, 8);
      arm.translate(0, al * 0.5, 0);
      const g2 = arm.clone();
      arm.dispose();
      g2.rotateZ(rng.range(0.9, 1.35) * (a % 2 === 0 ? 1 : -1));
      g2.translate(0, rng.range(0.45, 0.72) * h, 0);
      parts.push(g2);
    }
    const merged = mergeGeometries(parts);
    for (const p of parts) if (p !== merged) p.dispose();
    merged.computeVertexNormals();
    const p = merged.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(p.count * 3);
    for (let v = 0; v < p.count; v++) {
      _col.setHex(0x4e7a45).offsetHSL(0, 0, (Math.random() - 0.5) * 0.08);
      colors[v * 3] = _col.r; colors[v * 3 + 1] = _col.g; colors[v * 3 + 2] = _col.b;
    }
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return { trunk: new THREE.BufferGeometry(), canopy: merged };
  }

  private trunkMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      map: this.bark ? this.bark.map : null,
      normalMap: this.bark ? this.bark.normalMap : null,
      normalScale: new THREE.Vector2(1.5, 1.5),
      roughness: 0.93,
      metalness: 0,
      fog: true,
    });
    mat.name = 'Bark';
    return mat;
  }

  private canopyMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0,
      fog: true,
      dithering: true,
      side: THREE.FrontSide,
    });
    mat.name = 'Canopy';
    mat.customProgramCacheKey = () => 'apex-canopy';
    const u: Record<string, THREE.IUniform> = {
      uTime: this.uTime,
      uWindDir: this.uWindDir,
      uWindStrength: this.uWindStrength,
      uPlayerPos: this.uPlayerPos,
      uSunDirection: worldFogUniforms.uSunDirection,
    };
    mat.onBeforeCompile = (shader) => {
      for (const k in u) shader.uniforms[k] = u[k];
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
#include <common>
${GLSL_WIND}
varying float vCanopyUp;
`)
        .replace('#include <begin_vertex>', /* glsl */ `
#include <begin_vertex>
vec3 cw = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
float amt = clamp( position.y / 8.0, 0.0, 1.0 );
vec3 off = windOffset( cw, cw.x * 0.31 + cw.z * 0.17, amt * 0.55 );
// Instance matrices here are compose(position, yaw, uniformScale) and the group
// is never rotated, so the basis is orthogonal-times-s: its inverse is the
// transpose over s². That replaces a per-vertex mat3 inversion on every leaf.
mat3 cInst = mat3( instanceMatrix );
float cS2 = max( dot( cInst[ 0 ], cInst[ 0 ] ), 1e-6 );
transformed += ( transpose( cInst ) * off ) / cS2;
vCanopyUp = normalize( objectNormal ).y;
`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vCanopyUp;\nuniform vec3 uSunDirection;`)
        .replace('#include <map_fragment>', /* glsl */ `
// Fake thickness: undersides darken, sun-facing tops warm up.
diffuseColor.rgb *= mix( 0.62, 1.06, clamp( vCanopyUp * 0.5 + 0.5, 0.0, 1.0 ) );
`);
    };
    return mat;
  }

  private buildTrees(): void {
    const density = this.quality.foliageDensity * this.theme.treeDensity;
    if (density <= 0.02) return;
    const rng = new Rng(this.ctx.hints.terrainSeed ^ 0x7ee);
    // 5 m of verge at the near end, i.e. ~16 m from the centreline on an 11 m
    // half-width road — the old first argument, now expressed as clearance so a
    // wide station cannot spend it. The CANOPY is enforced separately, per
    // species, in `buildTreeSpecies`: this only sites the trunk.
    const spots = this.scatterSpots(
      Math.round(560 * density), 5, 330, rng, 0.55,
    );
    if (!spots.length) return;

    const mix = this.theme.treeMix;
    const totalW = mix.reduce((a, b) => a + b[1], 0);
    // Split spots between species by weight.
    let cursor = 0;
    for (let s = 0; s < mix.length; s++) {
      const [kind, w] = mix[s];
      const n = s === mix.length - 1 ? spots.length - cursor
        : Math.round((w / totalW) * spots.length);
      const slice = spots.slice(cursor, cursor + n);
      cursor += n;
      if (!slice.length) continue;
      // Two or three visual variants per kind so a forest isn't clones.
      const variants = kind === 'tree' ? 3 : kind === 'deadtree' ? 2 : 2;
      for (let v = 0; v < variants; v++) {
        const sub = slice.filter((_, i) => i % variants === v);
        if (!sub.length) continue;
        this.buildTreeSpecies(kind, v, sub, rng);
      }
    }
  }

  private buildTreeSpecies(
    kind: ScatterKind, variant: number,
    spotsIn: Array<{ x: number; z: number; y: number; s: number; r: number }>,
    rng: Rng,
  ): void {
    let spots = spotsIn;
    let trunkGeo: THREE.BufferGeometry;
    let canopyGeo: THREE.BufferGeometry;

    if (kind === 'palm') {
      const g = this.palmGeometry(rng);
      trunkGeo = g.trunk; canopyGeo = g.canopy;
    } else if (kind === 'cactus') {
      const g = this.cactusGeometry(rng);
      trunkGeo = g.trunk; canopyGeo = g.canopy;
    } else if (kind === 'deadtree') {
      const h = rng.range(5, 9);
      trunkGeo = this.trunkGeometry(h, 0.34, 0.09, rng.range(-0.5, 0.5), rng, 5 + variant);
      canopyGeo = new THREE.BufferGeometry();
    } else if (variant === 0) {
      // conifer: tall, narrow, stacked cones
      const h = rng.range(9, 15);
      trunkGeo = this.trunkGeometry(h * 0.55, 0.28, 0.12, 0, rng, 0);
      const cones: THREE.BufferGeometry[] = [];
      const tiers = 5;
      for (let i = 0; i < tiers; i++) {
        const t = i / (tiers - 1);
        const r = (1 - t) * h * 0.24 + 0.5;
        const cone = new THREE.ConeGeometry(r, h * 0.34, 8, 1, false);
        cone.translate(0, h * 0.28 + t * h * 0.62, 0);
        cones.push(cone);
      }
      canopyGeo = mergeGeometries(cones);
      for (const c of cones) if (c !== canopyGeo) c.dispose();
      canopyGeo.computeVertexNormals();
      tintGeometry(canopyGeo, 0x2f5b34, 0x16321e);
    } else if (variant === 1) {
      // broad round
      const h = rng.range(6.5, 10.5);
      trunkGeo = this.trunkGeometry(h * 0.52, 0.32, 0.18, rng.range(-0.3, 0.3), rng, 3);
      canopyGeo = this.canopyGeometry(4, h * 0.36, h * 0.55, h * 0.22, 0x74ad4c, 0x2c4c28, rng, 0.82);
    } else {
      // tall birch-ish with a high crown
      const h = rng.range(11, 16);
      trunkGeo = this.trunkGeometry(h * 0.7, 0.24, 0.11, rng.range(-0.2, 0.2), rng, 4);
      canopyGeo = this.canopyGeometry(3, h * 0.26, h * 0.7, h * 0.14, 0x8fc258, 0x39602e, rng, 1.05);
    }

    // THE CANOPY, NOT THE TRUNK, DECIDES WHERE A TREE CAN STAND. A birch here is
    // `canopyGeometry(3, h*0.26, h*0.7, h*0.14, …)` at h up to 16 m, so its crown
    // is metres wider than the point the scatter tested. Measured before this:
    // `tree2#57` overhung Boston's asphalt by 0.20 m at 6.5 m up and `tree0#44`
    // by 1.14 m on coastal. Both geometries exist by now, so the real reach is
    // available — take the wider of trunk and canopy and move the tree out.
    const treeReach = Math.max(Foliage.reachOf(trunkGeo), Foliage.reachOf(canopyGeo));
    spots = this.clearReach(`${kind}${variant}`, treeReach, spots);
    if (!spots.length) {
      trunkGeo.dispose();
      canopyGeo.dispose();
      return;
    }
    const count = spots.length;
    const trunkMat = this.trunkMaterial();
    const canopyMat = this.canopyMaterial();
    const hasTrunk = (trunkGeo.attributes.position?.count ?? 0) > 0;
    const hasCanopy = (canopyGeo.attributes.position?.count ?? 0) > 0;

    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, hasTrunk ? count : 0);
    const canopyMesh = new THREE.InstancedMesh(canopyGeo, canopyMat, hasCanopy ? count : 0);
    for (const m of [trunkMesh, canopyMesh]) {
      m.name = `${kind}${variant}`;
      m.receiveShadow = true;
      m.renderOrder = RENDER_ORDER.PROPS;
    }
    // Canopies cast; trunks do not. A trunk's shadow lands inside its own
    // canopy's shadow in every sun position that isn't grazing the horizon, so
    // the second submission of 400 instanced trunks into every cascade buys
    // nothing. Halves the tree contribution to the shadow draw set.
    canopyMesh.castShadow = true;
    trunkMesh.castShadow = false;

    for (let i = 0; i < count; i++) {
      const sp = spots[i];
      _pos.set(sp.x, sp.y, sp.z);
      _q.setFromAxisAngle(_up, sp.r);
      _scale.setScalar(sp.s);
      _m4.compose(_pos, _q, _scale);
      if (hasTrunk) trunkMesh.setMatrixAt(i, _m4);
      if (hasCanopy) canopyMesh.setMatrixAt(i, _m4);
    }
    // Trunks get frustum + distance chunk culling; canopies get distance only,
    // because they are the shadow casters and a canopy just off the left edge of
    // the screen still throws a shadow across the road.
    if (hasTrunk) {
      trunkMesh.instanceMatrix.needsUpdate = true;
      sealInstanceBounds(trunkMesh);
      this.group.add(trunkMesh);
      this.chunked.push(new InstanceChunks(trunkMesh, spots, TREE_CULL, 96, true));
    } else { trunkGeo.dispose(); trunkMat.dispose(); }
    if (hasCanopy) {
      canopyMesh.instanceMatrix.needsUpdate = true;
      sealInstanceBounds(canopyMesh);
      this.group.add(canopyMesh);
      this.chunked.push(new InstanceChunks(canopyMesh, spots, TREE_CULL, 96, false));
    } else { canopyGeo.dispose(); canopyMat.dispose(); }

    this.species.push({
      name: `${kind}${variant}`, trunk: trunkMesh, canopy: canopyMesh, imposter: null, count,
    });
  }

  // =========================================================================
  // SHRUB LAYER
  // =========================================================================

  private buildScatter(): void {
    const d = this.quality.foliageDensity;
    const rng = new Rng((this.ctx.hints.terrainSeed ^ 0xbb5) >>> 0);

    // Scatter budgets and per-clump triangle counts are both way down. Every one
    // of these is a sub-metre object: a bush at 200 m is two pixels, so it got a
    // detail-0 icosahedron (20 tris a blob instead of 80) and a hard cull radius
    // rather than a 220 m scatter band nothing could resolve.
    // Band arguments are now VERGE metres past the asphalt edge, not distance
    // from the centreline. The values below keep each layer visually where it
    // was on an ~11 m half-width road (13 → 2.5 + kerb ≈ 15 m out at the near
    // end) while making a 12.5 m section push its planting out instead of
    // letting the extra road width eat the whole margin.
    const bushCount = Math.round(760 * d * this.theme.bushDensity);
    if (bushCount > 8) {
      const spots = this.scatterSpots(bushCount, 2.5, 140, rng, 0.75);
      const geo = this.canopyGeometry(3, 0.85, 0.35, 0.55, 0x5f8f3c, 0x25401f, rng, 0.62, 0);
      this.addScatterMesh('Bush', geo, this.clearReach('Bush', Foliage.reachOf(geo), spots), true, 150);
    }

    const fernCount = Math.round(620 * d * this.theme.bushDensity);
    if (fernCount > 8 && (this.ctx.theme === 'meadow' || this.ctx.theme === 'coastal')) {
      const spots = this.scatterSpots(fernCount, 2.0, 100, rng, 0.9);
      const geo = this.fernGeometry(rng);
      this.addScatterMesh('Fern', geo, this.clearReach('Fern', Foliage.reachOf(geo), spots), true, 110);
    }

    const flowerCount = Math.round(1100 * d * this.theme.flowerDensity);
    if (flowerCount > 8) {
      const spots = this.scatterSpots(flowerCount, 2.0, 70, rng, 1.0);
      const geo = this.flowerGeometry(rng);
      this.addScatterMesh('Flowers', geo, this.clearReach('Flowers', Foliage.reachOf(geo), spots), true, 80);
    }

    if (this.ctx.theme === 'coastal' || this.ctx.theme === 'meadow') {
      const n = Math.round(420 * d);
      const spots = this.shoreSpots(n, rng);
      if (spots.length > 8) {
        const geo = this.cattailGeometry(rng);
        this.addScatterMesh('Cattails', geo, this.clearReach('Cattails', Foliage.reachOf(geo), spots), true, 120);
      }
    }

    if (this.ctx.theme === 'volcano') {
      const n = Math.round(520 * d);
      const spots = this.scatterSpots(n, 3, 170, rng, 0.4);
      const geo = this.canopyGeometry(2, 0.7, 0.2, 0.4, 0x3a2b22, 0x1a1310, rng, 0.5, 0);
      this.addScatterMesh(
        'ScorchedScrub', geo, this.clearReach('ScorchedScrub', Foliage.reachOf(geo), spots), true, 180,
      );
    }
    if (this.clearLog.length) {
      console.info(`[Foliage] road-edge clearance: ${this.clearLog.join('; ')}`);
      this.clearLog.length = 0;
    }
  }

  /**
   * One InstancedMesh per shrub type, spatially bucketed so the visible set can
   * be repacked per frame. `cull` is the distance past which the type stops being
   * submitted at all.
   */
  private addScatterMesh(
    name: string, geo: THREE.BufferGeometry,
    spots: Array<{ x: number; z: number; y: number; s: number; r: number }>,
    wind: boolean,
    cull: number,
  ): void {
    if (!spots.length) { geo.dispose(); return; }
    const mat = wind ? this.canopyMaterial() : this.trunkMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
    mesh.name = name;
    // Shrubs cast into the near cascade only. Now that Lighting masks the far
    // cascades this is one extra draw in one 0–14 m slice, and a bush with no
    // shadow at all is the classic "pasted on" tell.
    mesh.castShadow = name === 'Bush' || name === 'ScorchedScrub';
    mesh.receiveShadow = true;
    mesh.layers.enable(SHADOW_LAYER.NEAR_ONLY);
    mesh.renderOrder = RENDER_ORDER.PROPS - 1;
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      _pos.set(sp.x, sp.y, sp.z);
      _q.setFromAxisAngle(_up, sp.r);
      _scale.setScalar(sp.s);
      _m4.compose(_pos, _q, _scale);
      mesh.setMatrixAt(i, _m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    sealInstanceBounds(mesh);
    this.group.add(mesh);
    this.scatterMeshes.push(mesh);
    this.chunked.push(new InstanceChunks(mesh, spots, cull, 48, true));
  }

  private fernGeometry(rng: Rng): THREE.BufferGeometry {
    const blades: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 7; i++) {
      const len = rng.range(0.5, 1.0);
      const pos: number[] = [];
      const idx: number[] = [];
      const colr: number[] = [];
      const segs = 4;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const w = 0.10 * (1 - t * 0.9);
        pos.push(-w, t * len, -t * t * len * 0.4, w, t * len, -t * t * len * 0.4);
        const sh = 0.55 + 0.45 * t;
        colr.push(0.16 * sh, 0.38 * sh, 0.14 * sh, 0.2 * sh, 0.46 * sh, 0.17 * sh);
      }
      for (let s = 0; s < segs; s++) {
        const a = s * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.rotateY((i / 7) * Math.PI * 2 + rng.range(-0.3, 0.3));
      blades.push(g);
    }
    const m = mergeGeometries(blades);
    for (const b of blades) if (b !== m) b.dispose();
    return m;
  }

  private flowerGeometry(rng: Rng): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const palette = [0xffe14d, 0xff6f8a, 0xffffff, 0xa07dff, 0xff9b3d];
    // Three blooms a clump, not five. A clump is 30 cm across; the extra two
    // were 64 triangles each of overlap nobody has ever resolved.
    for (let i = 0; i < 3; i++) {
      const h = rng.range(0.18, 0.34);
      const stem = new THREE.CylinderGeometry(0.008, 0.012, h, 3);
      stem.translate(0, h * 0.5, 0);
      tintGeometry(stem, 0x4d7a2e, 0x2f4d1c);
      const head = new THREE.IcosahedronGeometry(rng.range(0.035, 0.06), 0);
      head.translate(0, h, 0);
      tintGeometry(head, palette[i % palette.length], palette[(i + 2) % palette.length]);
      const off = new THREE.Matrix4().makeTranslation(rng.range(-0.2, 0.2), 0, rng.range(-0.2, 0.2));
      stem.applyMatrix4(off);
      head.applyMatrix4(off);
      parts.push(stem, head);
    }
    const m = mergeGeometries(parts);
    for (const p of parts) if (p !== m) p.dispose();
    return m;
  }

  private cattailGeometry(rng: Rng): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const h = rng.range(0.9, 1.6);
      const blade = new THREE.CylinderGeometry(0.012, 0.024, h, 3, 1, true);
      blade.translate(0, h * 0.5, 0);
      blade.rotateZ(rng.range(-0.2, 0.2));
      blade.rotateY(rng.range(0, 6.28));
      blade.translate(rng.range(-0.18, 0.18), 0, rng.range(-0.18, 0.18));
      tintGeometry(blade, 0x6a8a3c, 0x3c5622);
      parts.push(blade);
      if (i < 2) {
        const head = new THREE.CapsuleGeometry(0.035, 0.16, 2, 5);
        head.translate(0, h + 0.08, 0);
        tintGeometry(head, 0x6b4b2a, 0x3d2a17);
        parts.push(head);
      }
    }
    const m = mergeGeometries(parts);
    for (const p of parts) if (p !== m) p.dispose();
    return m;
  }

  // =========================================================================
  // SCATTERING
  // =========================================================================

  /** Metres of clear ground between a point and the nearest asphalt edge. */
  private verge(x: number, z: number): RoadVerge {
    return roadVerge(this.ctx.stations, x, z, this._verge);
  }
  private readonly _verge: RoadVerge = { verge: 0, halfWidth: 11, outX: 1, outZ: 0 };

  /**
   * Walk a spot directly away from the road until its geometry — `reach` metres
   * of horizontal half-extent — clears the kerb by `FOLIAGE_VERGE`.
   *
   * Returns false only when even `PUSH_LIMIT` metres outboard cannot buy the
   * clearance, or when the new ground is water or too steep to plant on. Moving
   * is the first choice on the owner's own priority order; dropping is the last.
   */
  private pushClear(
    sp: { x: number; z: number; y: number; s: number; r: number }, reach: number,
  ): boolean {
    const need = KERB_W + FOLIAGE_VERGE + reach * sp.s;
    let v = this.verge(sp.x, sp.z);
    if (v.verge >= need) return true;
    // One step is exact for a straight road; a couple of refinements settle the
    // curved case, where walking outward also changes which station is nearest.
    let x = sp.x, z = sp.z;
    for (let it = 0; it < 4; it++) {
      const short = need - v.verge;
      if (short <= 0) break;
      if (short > PUSH_LIMIT) return false;
      x += v.outX * short;
      z += v.outZ * short;
      v = this.verge(x, z);
    }
    if (v.verge < need) return false;
    if (Math.hypot(x - sp.x, z - sp.z) > PUSH_LIMIT) return false;
    const y = this.field.heightAt(x, z);
    if (y < this.ctx.waterLevel + 0.35) return false;
    // The push has to respect the harbour too, or `scatterSpots`' rejection is
    // undone one call later by a plant walked outboard into the water.
    if (insideAuthoredWater(this.field.waterBasins, x, z, 4)) return false;
    if (this.field.slopeAt(x, z) > 0.66) return false;
    // Keep the original vertical bedding offset, which differs per recipe.
    sp.y += y - this.field.heightAt(sp.x, sp.z);
    sp.x = x;
    sp.z = z;
    return true;
  }

  /**
   * Blue-noise-ish scatter in a band measured OUTWARD FROM THE ASPHALT EDGE,
   * rejecting steep ground, water and the road corridor.
   *
   * `minVerge`/`maxVerge` are metres of clear verge past the drivable edge, NOT
   * distance from the centreline — that change is the fix. The old signature took
   * centreline distances and then tested them against a bare constant, so the
   * whole `halfWidth` of the road (7.5–12.5 m here, and it varies station by
   * station) was silently spent as if it were verge.
   */
  private scatterSpots(
    target: number, minVerge: number, maxVerge: number, rng: Rng, moistureBias: number,
  ): Array<{ x: number; z: number; y: number; s: number; r: number }> {
    const out: Array<{ x: number; z: number; y: number; s: number; r: number }> = [];
    if (target <= 0 || !this.ctx.stations.length) return out;
    const stations = this.ctx.stations;
    const field = this.field;
    const tries = target * 8;
    for (let i = 0; i < tries && out.length < target; i++) {
      const st = stations[(rng.next() * stations.length) | 0];
      const side = rng.next() < 0.5 ? -1 : 1;
      // Band offsets now start at the station's OWN edge, so a wide section of
      // road pushes its planting out with it instead of eating into the band.
      const d = st.halfWidth + KERB_W + minVerge
        + Math.pow(rng.next(), 0.7) * (maxVerge - minVerge);
      const x = st.px + st.bx * d * side + rng.range(-8, 8);
      const z = st.pz + st.bz * d * side + rng.range(-8, 8);
      // The accurate, tier-independent test: the jitter above and the curvature
      // of the road can both undo the band offset, and this is what catches it.
      // `reach` is applied later, per recipe, once the geometry is known.
      if (this.verge(x, z).verge < KERB_W + FOLIAGE_VERGE) continue;
      const y = field.heightAt(x, z);
      if (y < this.ctx.waterLevel + 0.35) continue;
      // ---- AND NOT IN AN AUTHORED HARBOUR ----------------------------------
      // The line above cannot answer this. On a `city` circuit `waterLevel` is
      // the -9 m sentinel that keeps `Water` from building a disc, so every
      // authored basin floor is metres above it and the wet test passes over
      // open water. Measured before this: 51 bushes, 32 trees and 18 flowers
      // standing in Boston's harbour, and the same again on the other three.
      // `insideAuthoredWater` is the single footprint `Props` rejects against
      // too — see `WaterBasin` in WorldTextures.ts. Grass blades are placed on
      // the GPU and cannot be filtered here; they are killed by the same
      // footprint in the terrain bake's `data.r` mask instead.
      if (insideAuthoredWater(field.waterBasins, x, z, 4)) continue;
      if (field.slopeAt(x, z) > 0.66) continue;
      const moist = field.moistureAt(x, z);
      if (rng.next() > 0.16 + moist * moistureBias * 1.5) continue;
      if (rng.next() < field.rockAt(x, z) * 0.8) continue;
      out.push({ x, z, y: y - 0.06, s: rng.range(0.72, 1.32), r: rng.next() * Math.PI * 2 });
    }
    return out;
  }

  /** Reeds hug the waterline. */
  private shoreSpots(
    target: number, rng: Rng,
  ): Array<{ x: number; z: number; y: number; s: number; r: number }> {
    const out: Array<{ x: number; z: number; y: number; s: number; r: number }> = [];
    const field = this.field;
    const wl = this.ctx.waterLevel;
    const tries = target * 20;
    const half = field.extent * 0.48;
    for (let i = 0; i < tries && out.length < target; i++) {
      const x = field.centreX + rng.range(-half, half);
      const z = field.centreZ + rng.range(-half, half);
      const y = field.heightAt(x, z);
      if (y < wl - 0.35 || y > wl + 1.0) continue;
      // Was `roadDistanceAt(x, z) < 11`: a bare constant against a CENTRELINE
      // distance, so on a 12.5 m half-width station reeds were licensed 1.5 m
      // inside the asphalt. Measured: `Cattails` 1.72 m inside on coastal.
      if (this.verge(x, z).verge < KERB_W + FOLIAGE_VERGE) continue;
      out.push({ x, z, y: y - 0.1, s: rng.range(0.8, 1.4), r: rng.next() * Math.PI * 2 });
    }
    return out;
  }

  /**
   * Horizontal half-extent of a built geometry, metres. This is the number the
   * anchor test has to respect: a recipe that builds an 11 m canopy around a
   * point cannot be sited by testing the point alone.
   */
  private static reachOf(geo: THREE.BufferGeometry): number {
    // An empty geometry (a dead tree has no canopy) has no bounding box, or one
    // left at ±Infinity — either way it must contribute 0 reach, not NaN.
    if ((geo.getAttribute('position')?.count ?? 0) === 0) return 0;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb || !Number.isFinite(bb.min.x) || !Number.isFinite(bb.max.x)) return 0;
    return Math.max(
      Math.abs(bb.min.x), Math.abs(bb.max.x),
      Math.abs(bb.min.z), Math.abs(bb.max.z),
    );
  }

  /**
   * Enforce the verge with the REAL geometry reach, moving spots outboard and
   * only dropping the ones that cannot be saved. Returns the surviving spots and
   * logs the cost, so a density regression is visible rather than silent.
   */
  private clearReach(
    name: string, reach: number,
    spots: Array<{ x: number; z: number; y: number; s: number; r: number }>,
  ): Array<{ x: number; z: number; y: number; s: number; r: number }> {
    const kept: Array<{ x: number; z: number; y: number; s: number; r: number }> = [];
    let moved = 0;
    for (const sp of spots) {
      const x0 = sp.x, z0 = sp.z;
      if (!this.pushClear(sp, reach)) continue;
      if (sp.x !== x0 || sp.z !== z0) moved++;
      kept.push(sp);
    }
    const dropped = spots.length - kept.length;
    if (dropped || moved) {
      this.clearLog.push(
        `${name} reach ${reach.toFixed(1)} m: moved ${moved}, dropped ${dropped}`
        + ` of ${spots.length}`,
      );
    }
    return kept;
  }

  private clearLog: string[] = [];

  // =========================================================================

  setCamera(camera: THREE.PerspectiveCamera): void { this.camera = camera; }

  setWind(strength: number, dirRadians?: number): void {
    this.uWindStrength.value = strength;
    if (dirRadians !== undefined) {
      this.uWindDir.value.set(Math.cos(dirRadians), Math.sin(dirRadians)).normalize();
    }
  }

  update(ctx: FrameContext): void {
    this.uTime.value = ctx.elapsed;
    this.uPlayerPos.value.copy(this.playerPosition);
    const cam = this.camera;
    if (!cam) return;
    for (let i = 0; i < this.chunked.length; i++) this.chunked[i].cullTo(cam);
    // Position each ring and repack its live buckets, in that order, once per
    // frame ahead of every pass. One frustum for both rings.
    if (this.rings.length) {
      _ringProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _ringFrustum.setFromProjectionMatrix(_ringProj);
      for (let i = 0; i < this.rings.length; i++) {
        const ring = this.rings[i];
        this.placeRing(ring.mesh, cam.position.x, cam.position.z);
        ring.chunks.cullTo(_ringFrustum, ring.mesh.position.x, ring.mesh.position.z);
      }
    }
    if (!this.culling) {
      this.culling = true;
      for (let i = 0; i < this.rings.length; i++) this.rings[i].mesh.frustumCulled = true;
    }
  }

  /**
   * Draw calls this module contributes, for the perf readout. Counts what is
   * actually submitted: a chunked mesh whose visible set is empty has had its
   * `count` driven to 0 and three skips it entirely.
   */
  get drawCalls(): number {
    let n = 0;
    for (const r of this.rings) if (r.mesh.count > 0) n++;
    for (const m of this.scatterMeshes) if (m.count > 0) n++;
    for (const s of this.species) {
      if (s.trunk.count > 0) n++;
      if (s.canopy.count > 0) n++;
    }
    return n;
  }

  /** Instances actually submitted this frame, across every chunked mesh. */
  get liveInstances(): number {
    let n = 0;
    for (const c of this.chunked) n += c.drawnInstances;
    for (const r of this.rings) n += r.chunks.drawnInstances;
    return n;
  }

  /** Blades in every ring, culled or not — `mesh.count` is not this. */
  get grassInstances(): number {
    let n = 0;
    for (const r of this.rings) n += r.chunks.total;
    return n;
  }

  dispose(): void {
    const kill = (m: THREE.InstancedMesh): void => {
      m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat.dispose();
      m.dispose();
    };
    for (const r of this.rings) kill(r.mesh);
    for (const s of this.species) { kill(s.trunk); kill(s.canopy); }
    for (const m of this.scatterMeshes) kill(m);
    for (const d of this.disposables) d.dispose();
    this.rings.length = 0;
    this.species.length = 0;
    this.scatterMeshes.length = 0;
    this.chunked.length = 0;
    this.group.clear();
    this.scene.remove(this.group);
  }
}

// ---------------------------------------------------------------------------
// Local geometry utilities (no BufferGeometryUtils import — keeps this module
// dependency-free and lets us guarantee attribute layout).
// ---------------------------------------------------------------------------

/**
 * Freeze an `InstancedMesh`'s bounds over its FULL instance set and turn frustum
 * culling back on.
 *
 * This is the correct answer to the bug `frustumCulled = false` was papering
 * over. Three tests `object.boundingSphere` and, if it is null, computes it from
 * `geometry.boundingSphere` unioned over the first `count` instance matrices —
 * so once `InstanceChunks` starts rewriting `count` and repacking the matrices
 * each frame, an on-demand sphere would describe only the currently visible
 * subset, and would shrink and grow under the culler that is reading it.
 * Computing it once here, while `count` is still the total, gives three a sphere
 * that provably encloses every instance the mesh can ever submit: the repack is a
 * permutation of a subset, so nothing can leave it.
 *
 * That sphere is circuit-wide, so it rarely culls the mesh outright — the real
 * saving is `InstanceChunks` driving `count` down. What it buys is honesty: the
 * bounds now describe the instances, so the flag no longer has to lie, and a pose
 * that genuinely cannot see any of the circuit (camera pitched into the sky) does
 * drop the whole draw.
 */
function sealInstanceBounds(mesh: THREE.InstancedMesh): void {
  mesh.computeBoundingSphere();
  // Both foliage shaders sway vertices in world space; ~0.25 m for a canopy, less
  // for a shrub. Cheap insurance against culling a tree by its own wind.
  if (mesh.boundingSphere) mesh.boundingSphere.radius += 1;
  mesh.frustumCulled = true;
}

/** Merge indexed/non-indexed geometries that share position/normal/uv/color. */
export function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const usable = list.filter((g) => (g.attributes.position?.count ?? 0) > 0);
  if (!usable.length) return new THREE.BufferGeometry();
  if (usable.length === 1) return usable[0];

  const wantColor = usable.some((g) => !!g.attributes.color);
  const wantUv = usable.some((g) => !!g.attributes.uv);
  let vTotal = 0;
  let iTotal = 0;
  for (const g of usable) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const uv = wantUv ? new Float32Array(vTotal * 2) : null;
  const col = wantColor ? new Float32Array(vTotal * 3) : null;
  const idx = new Uint32Array(iTotal);
  let vo = 0, io = 0;
  for (const g of usable) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const n = g.attributes.normal as THREE.BufferAttribute | undefined;
    const t = g.attributes.uv as THREE.BufferAttribute | undefined;
    const c = g.attributes.color as THREE.BufferAttribute | undefined;
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i);
      pos[(vo + i) * 3 + 1] = p.getY(i);
      pos[(vo + i) * 3 + 2] = p.getZ(i);
      if (n) {
        nor[(vo + i) * 3] = n.getX(i);
        nor[(vo + i) * 3 + 1] = n.getY(i);
        nor[(vo + i) * 3 + 2] = n.getZ(i);
      }
      if (uv) {
        uv[(vo + i) * 2] = t ? t.getX(i) : 0;
        uv[(vo + i) * 2 + 1] = t ? t.getY(i) : 0;
      }
      if (col) {
        col[(vo + i) * 3] = c ? c.getX(i) : 1;
        col[(vo + i) * 3 + 1] = c ? c.getY(i) : 1;
        col[(vo + i) * 3 + 2] = c ? c.getZ(i) : 1;
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Bake a vertical two-colour gradient into vertex colours. */
export function tintGeometry(geo: THREE.BufferGeometry, top: number, bottom: number): void {
  const p = geo.attributes.position as THREE.BufferAttribute;
  if (!p) return;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const a = new THREE.Color(bottom);
  const b = new THREE.Color(top);
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - lo) / Math.max(1e-4, hi - lo);
    _col.copy(a).lerp(b, Math.pow(t, 0.8));
    c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
}

/** Set a flat vertex colour, so a merged mesh can use one vertex-colour material. */
export function paintGeometry(geo: THREE.BufferGeometry, hex: number, jitter = 0.03): void {
  const p = geo.attributes.position as THREE.BufferAttribute;
  if (!p) return;
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    _col.setHex(hex);
    if (jitter > 0) _col.offsetHSL(0, 0, (Math.random() - 0.5) * jitter);
    c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
}

void _nrm;
